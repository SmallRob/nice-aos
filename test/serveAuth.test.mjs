// serve 鉴权测试（srv-1）：Bearer token + /api/* 保护 + 静态端点豁免
// 覆盖：未启用鉴权向后兼容 / Bearer 头 / ?token= query / 401 含 WWW-Authenticate / 静态端点豁免 / env 覆盖
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');

const SNAP = {
  _meta: { generatedAt: '2026-08-22T00:00:00.000Z', cycles: [], orphanCandidates: [], objectCounts: { SourceFile: 1 } },
  Project: [{ id: 'proj:auth', name: 'auth-fixture', framework: 'react', branch: 'main' }],
  SourceFile: [{ id: 'file:src/a.ts' }],
};

function mkFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-serve-auth-'));
  fs.mkdirSync(path.join(dir, '.nice-aos', 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.nice-aos', 'data', 'snapshot.json'), JSON.stringify(SNAP));
  fs.writeFileSync(path.join(dir, 'blueprint.html'), '<!doctype html><title>auth-bp</title>');
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

async function get(port, p, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return {
    status: res.status,
    cors: res.headers.get('access-control-allow-origin'),
    wwwAuth: res.headers.get('www-authenticate'),
    text,
    json,
  };
}

const TOKEN = 's3cret-token-abc123';

// =============================================================================
// 1. 不启用鉴权：向后兼容（无 --token 时所有端点公开）
// =============================================================================

test('不传 --token：/api/* 端点公开访问（向后兼容）', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir], t);
  const r = await get(port, '/api/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.auth.enabled, false, '未启用鉴权时 auth.enabled 应为 false');
  // snapshot.json 也公开
  const s = await get(port, '/snapshot.json');
  assert.equal(s.status, 200);
  assert.equal(s.json.Project[0].name, 'auth-fixture');
});

// =============================================================================
// 2. 启用鉴权：/api/* 必须带 token
// =============================================================================

test('启用 --token：/api/* 无 token → 401 + WWW-Authenticate 头', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir, '--token', TOKEN], t);
  const r = await get(port, '/api/status');
  assert.equal(r.status, 401);
  assert.match(r.wwwAuth ?? '', /Bearer/, '应返回 WWW-Authenticate: Bearer');
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /Authorization/);
});

test('启用 --token：/api/* 错误 token → 401', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir, '--token', TOKEN], t);
  const r = await get(port, '/api/status', { Authorization: 'Bearer wrong-token' });
  assert.equal(r.status, 401);
  assert.equal(r.json.ok, false);
});

test('启用 --token：所有 /api/* 端点都被保护（stats / schema / objects / ask/context）', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir, '--token', TOKEN], t);
  for (const url of ['/api/status', '/api/stats', '/api/schema', '/api/objects/SourceFile', '/api/ask/context']) {
    const r = await get(port, url);
    assert.equal(r.status, 401, `${url} 应被保护`);
  }
});

test('启用 --token：Bearer 头带正确 token → 200', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir, '--token', TOKEN], t);
  const r = await get(port, '/api/status', { Authorization: `Bearer ${TOKEN}` });
  assert.equal(r.status, 200);
  assert.equal(r.json.auth.enabled, true);
  // v0.34.0：保护范围新增 /internal/broadcast；public 列表新增 /openapi.json
  assert.deepEqual(r.json.auth.protected, ['/api/*', '/internal/broadcast', '/ws/snapshot']);
  assert.deepEqual(r.json.auth.public, ['/', '/snapshot.json', '/blueprint.html', '/openapi.json']);
});

test('启用 --token：?token= query 也能通过', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir, '--token', TOKEN], t);
  const r = await get(port, `/api/status?token=${encodeURIComponent(TOKEN)}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.auth.enabled, true);
});

test('启用 --token：Authorization 头大小写不敏感', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir, '--token', TOKEN], t);
  const r = await get(port, '/api/status', { authorization: `bearer ${TOKEN}` });
  assert.equal(r.status, 200);
});

// =============================================================================
// 3. 静态端点豁免
// =============================================================================

test('启用 --token：静态端点 /snapshot.json 仍可公开访问', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir, '--token', TOKEN], t);
  const r = await get(port, '/snapshot.json');
  assert.equal(r.status, 200);
  assert.equal(r.json.Project[0].name, 'auth-fixture');
});

test('启用 --token：静态端点 /blueprint.html 仍可公开访问', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir, '--token', TOKEN], t);
  const r = await get(port, '/blueprint.html');
  assert.equal(r.status, 200);
  assert.match(r.text, /auth-bp/);
});

test('启用 --token：首页 / 仍可公开访问（含 auth 状态展示）', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir, '--token', TOKEN], t);
  const r = await get(port, '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /AOS/);
  // 首页是 HTML 不应要求 token
  assert.equal(r.wwwAuth, null);
});

// =============================================================================
// 4. NICE_AOS_SERVE_TOKEN 环境变量覆盖 --token
// =============================================================================

test('NICE_AOS_SERVE_TOKEN env 覆盖 --token', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir, '--token', 'old-token'], t, {
    NICE_AOS_SERVE_TOKEN: 'env-token',
  });
  // 用 env token 应通过
  const r1 = await get(port, '/api/status', { Authorization: 'Bearer env-token' });
  assert.equal(r1.status, 200, 'env token 应通过');
  // 用 --token 值（被 env 覆盖）应 401
  const r2 = await get(port, '/api/status', { Authorization: 'Bearer old-token' });
  assert.equal(r2.status, 401, '--token 值被 env 覆盖，应不通过');
});

test('NICE_AOS_SERVE_TOKEN 单独使用（无 --token）也能启用鉴权', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir], t, {
    NICE_AOS_SERVE_TOKEN: 'env-only-token',
  });
  const r1 = await get(port, '/api/status');
  assert.equal(r1.status, 401, 'env 启用鉴权后无 token 应 401');
  const r2 = await get(port, '/api/status', { Authorization: 'Bearer env-only-token' });
  assert.equal(r2.status, 200);
});

// =============================================================================
// 5. 启动 banner
// =============================================================================

test('启用鉴权时启动 banner 显示 auth 状态', async (t) => {
  const dir = mkFixture();
  const child = spawn(process.execPath, [CLI, 'serve', '--port', '0', '--root', dir, '--token', TOKEN], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { child.kill(); } catch { /* ignore */ } });
  const out = await new Promise((resolve) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      // 等 banner 完整（最后一行 "按 Ctrl+C 停止" 出现）
      if (buf.includes('按 Ctrl+C 停止')) resolve(buf);
    });
  });
  assert.match(out, /auth\s+Bearer 鉴权启用/);
  // v0.34.0：banner 改为角色分级展示（单 --token 默认 admin）
  assert.match(out, /角色分级 read\/write\/admin/);
  assert.match(out, /:admin/);
});
