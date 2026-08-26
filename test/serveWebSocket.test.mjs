// serveWebSocket 单元 + 集成测试（srv-2）
// 单元：handshake / parseFrame / buildTextFrame / buildPongFrame / buildCloseFrame / computeAcceptKey
// 集成：原生 WebSocket 连 /ws/snapshot，验证 hello + mtime 轮询 + 鉴权
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  computeAcceptKey,
  buildHandshakeResponse,
  parseFrame,
  buildTextFrame,
  buildPongFrame,
  buildCloseFrame,
} from '../src/cli/commands/serveWebSocket.js';

// =============================================================================
// 1. 单元
// =============================================================================

test('computeAcceptKey：符合 RFC 6455 示例', () => {
  // RFC 6455 §1.3 示例
  const clientKey = 'dGhlIHNhbXBsZSBub25jZQ==';
  const expected = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';
  assert.equal(computeAcceptKey(clientKey), expected);
});

test('buildHandshakeResponse：含 101 + Upgrade + Connection + Sec-WebSocket-Accept', () => {
  const resp = buildHandshakeResponse('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  assert.match(resp, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.match(resp, /Upgrade: websocket/);
  assert.match(resp, /Connection: Upgrade/);
  assert.match(resp, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
});

test('parseFrame：完整 text 帧（带 mask）', () => {
  // 构造客户端→服务端 text 帧：payload "hello" (5 bytes)，随机 mask
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const payload = Buffer.from('hello');
  const masked = Buffer.alloc(5);
  for (let i = 0; i < 5; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  const frame = Buffer.concat([
    Buffer.from([0x81, 0x80 | 5]),
    mask,
    masked,
  ]);
  const parsed = parseFrame(frame);
  assert.equal(parsed.opcode, 1); // text
  assert.equal(parsed.fin, true);
  assert.equal(parsed.payload.toString('utf-8'), 'hello');
  assert.equal(parsed.consumed, frame.length);
});

test('parseFrame：close 帧 + code/reason', () => {
  const reason = 'bye';
  const reasonBuf = Buffer.from(reason);
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(1000, 0);
  reasonBuf.copy(payload, 2);
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  const frame = Buffer.concat([Buffer.from([0x88, 0x80 | payload.length]), mask, masked]);
  const parsed = parseFrame(frame);
  assert.equal(parsed.opcode, 8);
  assert.equal(parsed.code, 1000);
  assert.equal(parsed.reason, 'bye');
});

test('parseFrame：扩展长度 16 位（payload 126-65535）', () => {
  const mask = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
  const payload = Buffer.alloc(200, 0x41); // 200 个 'A'
  const masked = Buffer.alloc(200);
  for (let i = 0; i < 200; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 0x80 | 126; // mask + 16-bit len
  header.writeUInt16BE(200, 2);
  const frame = Buffer.concat([header, mask, masked]);
  const parsed = parseFrame(frame);
  assert.equal(parsed.opcode, 1);
  assert.equal(parsed.payload.length, 200);
  assert.equal(parsed.payload.toString('utf-8'), 'A'.repeat(200));
  assert.equal(parsed.consumed, frame.length);
});

test('parseFrame：不完整数据返回 null', () => {
  const frame = Buffer.from([0x81, 0x85, 0, 0, 0, 0, 0x68]); // 缺 payload
  assert.equal(parseFrame(frame), null);
});

test('buildTextFrame + parseFrame 往返', () => {
  const text = JSON.stringify({ type: 'hello', ts: 12345 });
  const frame = buildTextFrame(text);
  // 服务端→客户端 无 mask
  assert.equal(frame[0], 0x81); // FIN + text
  assert.equal((frame[1] & 0x80), 0); // 无 mask
  // 直接读 payload（不做 mask 解码）
  const payload = frame.subarray(2);
  assert.equal(payload.toString('utf-8'), text);
});

test('buildTextFrame：长 payload 走 16-bit 长度', () => {
  const text = 'x'.repeat(500);
  const frame = buildTextFrame(text);
  assert.equal((frame[1] & 0x7f), 126); // 16-bit
  // payload 长度 500 应在 header[2..3] big-endian
  assert.equal(frame.readUInt16BE(2), 500);
});

test('buildPongFrame：默认空 payload（服务端→客户端无 mask）', () => {
  const pong = buildPongFrame();
  assert.equal(pong[0], 0x8a); // FIN + pong
  assert.equal(pong[1], 0x00); // len=0（无 mask）
  assert.equal(pong.length, 2);
});

test('buildCloseFrame：含 code + reason', () => {
  const f = buildCloseFrame(1000, 'normal');
  // close opcode
  assert.equal(f[0], 0x88);
  // 头 2 字节 + 2 字节 code + reason 长度
  const code = f.readUInt16BE(2);
  assert.equal(code, 1000);
  const reason = f.subarray(4).toString('utf-8');
  assert.equal(reason, 'normal');
});

// =============================================================================
// 2. 集成：原生 WebSocket 连 /ws/snapshot
// =============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');

const SNAP = {
  _meta: { generatedAt: '2026-08-22T00:00:00.000Z', cycles: [], orphanCandidates: [], objectCounts: { SourceFile: 1 } },
  Project: [{ id: 'proj:ws', name: 'ws-fixture', framework: 'react', branch: 'main' }],
  SourceFile: [{ id: 'file:src/a.ts' }],
};

function mkFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ws-'));
  fs.mkdirSync(path.join(dir, '.nice-aos', 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.nice-aos', 'data', 'snapshot.json'), JSON.stringify(SNAP));
  return dir;
}

function startServe(args, t, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'serve', '--port', '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
    t.after(() => { try { child.kill(); } catch { /* ignore */ } });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`serve 启动超时: ${out}`)), 20_000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }); }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`serve 提前退出(${code}): ${out}`)); });
  });
}

function openWs(port, path = '/ws/snapshot') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const messages = [];
    ws.addEventListener('open', () => resolve({ ws, messages }));
    ws.addEventListener('error', (e) => reject(new Error(`ws error: ${e.message || e}`)));
    ws.addEventListener('message', (e) => {
      try { messages.push(JSON.parse(e.data)); } catch { messages.push(e.data); }
    });
  });
}

// 等待 messages 含某类型（轮询，避免 flake）
async function waitFor(messages, type, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = messages.find((m) => m && m.type === type);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`未收到 type=${type}（已等待 ${timeoutMs}ms）`);
}

test('WebSocket /ws/snapshot：连接后立即收 hello + 包含 snapshot/blueprint 状态', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir, '--ws-interval', '500'], t);
  const { ws, messages } = await openWs(port);
  t.after(() => ws.close());
  const hello = await waitFor(messages, 'hello');
  assert.equal(hello.wsIntervalMs, 500);
  assert.equal(hello.snapshot.ready, true);
  assert.equal(typeof hello.snapshot.mtime, 'number');
});

test('WebSocket /ws/snapshot：snapshot.json mtime 变化时广播 snapshot:changed', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir, '--ws-interval', '300'], t);
  const { ws, messages } = await openWs(port);
  t.after(() => ws.close());
  await waitFor(messages, 'hello'); // 收 hello
  // 改 snapshot.json
  const newSnap = { ...SNAP, _meta: { ...SNAP._meta, objectCounts: { SourceFile: 2 } } };
  fs.writeFileSync(path.join(dir, '.nice-aos', 'data', 'snapshot.json'), JSON.stringify(newSnap));
  const evt = await waitFor(messages, 'snapshot:changed', 5000);
  assert.equal(evt.kind, 'code');
  assert.equal(typeof evt.mtime, 'number');
  assert.equal(typeof evt.size, 'number');
});

test('WebSocket /ws-snapshot：text 帧 ping → 应答 pong', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir, '--ws-interval', '2000'], t);
  const { ws, messages } = await openWs(port);
  t.after(() => ws.close());
  await waitFor(messages, 'hello');
  ws.send(JSON.stringify({ type: 'ping' }));
  const pong = await waitFor(messages, 'pong', 3000);
  assert.equal(typeof pong.ts, 'number');
});

test('WebSocket 鉴权：--token + 无 ?token → 401', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir, '--token', 'ws-secret'], t);
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/snapshot`);
    ws.addEventListener('open', () => reject(new Error('应升级失败')));
    ws.addEventListener('error', () => resolve());
  });
});

test('WebSocket 鉴权：--token + ?token= 正确 → 101 + hello', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir, '--token', 'ws-secret'], t);
  const { ws, messages } = await openWs(port, '/ws/snapshot?token=ws-secret');
  t.after(() => ws.close());
  const hello = await waitFor(messages, 'hello');
  assert.equal(hello.auth.enabled, true);
});

test('WebSocket 非 /ws/snapshot 路径 → 404 close', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir], t);
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);
    ws.addEventListener('open', () => reject(new Error('应升级失败')));
    ws.addEventListener('error', () => resolve());
  });
});

test('WebSocket 客户端计数：/api/status 返回当前 ws.clients', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir], t);
  const { ws, messages } = await openWs(port);
  t.after(() => ws.close());
  await waitFor(messages, 'hello');
  // 直接 fetch /api/status 看 ws.clients
  const res = await fetch(`http://127.0.0.1:${port}/api/status`);
  const j = await res.json();
  assert.equal(j.ws.enabled, true);
  assert.equal(j.ws.clients, 1);
  ws.close();
  // 等服务端清理（1s 足够）
  await new Promise((r) => setTimeout(r, 500));
  const res2 = await fetch(`http://127.0.0.1:${port}/api/status`);
  const j2 = await res2.json();
  assert.equal(j2.ws.clients, 0, '客户端断开后 ws.clients 应归零');
});

test('WebSocket --ws-interval 0 → 推送关闭（ws.enabled=false）', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir, '--ws-interval', '0'], t);
  const res = await fetch(`http://127.0.0.1:${port}/api/status`);
  const j = await res.json();
  assert.equal(j.ws.enabled, false);
});
