// 极简 WebSocket Server（RFC 6455），无第三方依赖
// 借鉴 code-graph-rag 范式 6 "MCP server 暴露工具" 的"受限事件协议"思想
// 仅实现：text frame send/recv、ping/pong 心跳、close handshake
// 不实现：binary frame（ask/output 只推 JSON 文本）、per-message-deflate、fragmentation
//
// frame 格式：
//   客户端→服务端：byte0=FIN+opcode, byte1=MASK+len7, [len16/len64], [mask4], payload
//   服务端→客户端：byte0=FIN+opcode, byte1=len7, [len16/len64], payload（无需 mask）

import fs from 'node:fs';
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODES = { CONTINUE: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 };

// 解 SHA-1 Sec-WebSocket-Key → Sec-WebSocket-Accept
export function computeAcceptKey(clientKey) {
  return crypto.createHash('sha1').update(clientKey + WS_GUID).digest('base64');
}

// 生成 HTTP 101 响应头（不含 \r\n\r\n，由调用方拼接）
export function buildHandshakeResponse(acceptKey) {
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '',
    '',
  ].join('\r\n');
}

// 解析 1 个完整客户端 frame（足够应对简单文本 ping/pong 与中等消息）
// 假设所有 data 已到齐（Node 内部 buffer 整合后一次调用；fragmentation 暂不支持）
// 返回 { opcode, fin, payload, consumed }；consumed 是该 frame 在 buf 中占的字节数
// 数据不完整时返回 null（调用方等下一 chunk）
export function parseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    // 用 BigInt 安全读 64 位
    const hi = BigInt(buf.readUInt32BE(offset));
    const lo = BigInt(buf.readUInt32BE(offset + 4));
    len = Number((hi << 32n) | lo);
    offset += 8;
  }
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null; // 不完整（fragmentation 暂不支持）
  let payload = buf.subarray(offset, offset + len);
  if (masked) {
    // 解 mask
    const unmasked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) {
      unmasked[i] = payload[i] ^ maskKey[i % 4];
    }
    payload = unmasked;
  }
  const consumed = offset + len;
  if (opcode === OPCODES.CLOSE) {
    const code = len >= 2 ? payload.readUInt16BE(0) : 1005;
    const reason = len > 2 ? payload.subarray(2).toString('utf-8') : '';
    return { opcode, fin, code, reason, consumed };
  }
  return { opcode, fin, payload, consumed };
}

// 构造服务端→客户端 text frame（无需 mask；RFC 6455 §5.1：服务器→客户端必须 NOT mask）
export function buildTextFrame(text) {
  const payload = Buffer.from(String(text), 'utf-8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// 构造服务端→客户端 pong frame（回应客户端 ping）
export function buildPongFrame(payload) {
  // pong 帧格式与 ping 一致（服务端→客户端无 mask）
  const p = payload ?? Buffer.alloc(0);
  const len = p.length;
  if (len < 126) return Buffer.from([0x8a, len, ...p]);
  return Buffer.from([0x8a, 0]);
}

// 构造 close frame
export function buildCloseFrame(code = 1000, reason = '') {
  const reasonBuf = Buffer.from(reason, 'utf-8');
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  reasonBuf.copy(payload, 2);
  const len = payload.length;
  if (len < 126) return Buffer.from([0x88, len, ...payload]);
  return Buffer.from([0x88, 126, (len >> 8) & 0xff, len & 0xff, ...payload]);
}

// ---------------------------------------------------------------------------
// attachWebSocketUpgrade(server, opts) —— 把 WS upgrade handler 整体封装。
// 让 serve.js 不必再关心 wsClients / 定时器 / 帧解析等内部状态。
//
// 支持多文件轮询（v0.45.0 起，overview.html / overview-snapshot.json 一起监听）：
//   opts.files: [{ path: string, event: 'snapshot:changed'|'blueprint:changed'|'overview:changed' }]
//   旧 opts.snapPath + opts.bpPath 仍兼容（自动转 files）
//
// @param {import('node:http').Server} server
// @param {{
//   files?: Array<{path: string, event: string}>,
//   snapPath?: string,             // 兼容旧接口（v0.45.0 前）
//   bpPath?: string,               // 兼容旧接口
//   intervalMs: number,            // 0 = 关闭轮询
//   authToken: string|null,        // null = 鉴权关闭
//   checkAuth: (req, token) => { ok: boolean, reason?: string },
// }} opts
// @returns {{
//   enabled: boolean,             // intervalMs > 0
//   intervalMs: number,
//   clients: Set,                 // 当前 WS 客户端集合（测试与 banner 用）
//   files: Array<{path, event}>,  // 当前监听的文件清单
// }}
//
// 设计：
//   - 仅 1 个共享 mtime 轮询定时器（与连接数无关）
//   - 每个文件独立指纹 + 独立事件类型（多文件支持）
//   - 客户端连接 / 断开 / 收 ping 都触发帧处理（parseFrame）
//   - 鉴权：query ?token= 或 Authorization header（用 serve.js 传入的 checkAuth）
//   - 帧格式 text/json；事件 type ∈ ['hello','snapshot:changed','blueprint:changed','overview:changed','pong']
export function attachWebSocketUpgrade(server, opts) {
  const { authToken, checkAuth } = opts;
  const wsIntervalMs = Math.max(0, opts.intervalMs | 0);

  // 规范化 files 数组：旧接口（snapPath + bpPath）→ 新 files；新接口直接用
  let files = Array.isArray(opts.files) ? opts.files.filter((f) => f && f.path && f.event) : [];
  if (files.length === 0 && (opts.snapPath || opts.bpPath)) {
    if (opts.snapPath) files.push({ path: opts.snapPath, event: 'snapshot:changed' });
    if (opts.bpPath) files.push({ path: opts.bpPath, event: 'blueprint:changed' });
  }
  files = files.map((f) => ({ path: f.path, event: String(f.event) }));

  const wsClients = new Set();

  // 计算文件指纹（mtime + size；空文件用 0）
  function fileFingerprint(p) {
    try {
      const s = fs.statSync(p);
      return { mtime: s.mtimeMs, size: s.size };
    } catch { return { mtime: 0, size: 0 }; }
  }

  // 每个文件一个指纹槽
  const fps = files.map((f) => {
    const fp = fileFingerprint(f.path);
    return { ...f, lastMtime: fp.mtime, lastSize: fp.size };
  });

  function broadcastWs(obj) {
    if (wsClients.size === 0) return;
    const frame = buildTextFrame(JSON.stringify(obj));
    for (const sock of wsClients) {
      try { sock.write(frame); } catch { /* write 失败的会在 close 事件里清理 */ }
    }
  }

  // 单定时器：所有客户端共享；多文件一并轮询
  if (wsIntervalMs > 0 && fps.length > 0) {
    const pollTimer = setInterval(() => {
      for (const slot of fps) {
        const fp = fileFingerprint(slot.path);
        if (fp.mtime !== slot.lastMtime || fp.size !== slot.lastSize) {
          slot.lastMtime = fp.mtime;
          slot.lastSize = fp.size;
          // broadcast payload: type + ts + path + mtime + size + (可选 kind: 'code' for snapshot)
          // kind 兼容 v0.33 旧 client：snapshot:changed 携带 kind='code' 表示本体快照
          const payload = { type: slot.event, ts: Date.now(), path: slot.path, mtime: fp.mtime, size: fp.size };
          if (slot.event === 'snapshot:changed') payload.kind = 'code';
          broadcastWs(payload);
        }
      }
    }, wsIntervalMs);
    pollTimer.unref?.(); // 不阻止进程退出
  }

  server.on('upgrade', (req, socket /*, head*/) => {
    // 路径只接 /ws/snapshot；其他路径不响应（自动 404）
    const u = new URL(req.url || '/', 'http://x');
    if (u.pathname !== '/ws/snapshot') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // 鉴权（同 /api/* 规则：query ?token= 或 header）
    if (authToken) {
      const auth = checkAuth(req, authToken);
      if (!auth.ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer realm="aos"\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    // 校验必要头
    if ((req.headers.upgrade || '').toLowerCase() !== 'websocket' || Number(req.headers['sec-websocket-version']) !== 13) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const acceptKey = computeAcceptKey(req.headers['sec-websocket-key']);
    if (!acceptKey) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // 101 响应
    socket.write(buildHandshakeResponse(acceptKey));

    wsClients.add(socket);
    // 构造 hello 帧：把所有文件的初始指纹一起下发给客户端（向前兼容老 client：snapshot/blueprint 字段保留）
    const helloFiles = {};
    for (const slot of fps) {
      helloFiles[slot.event.replace(':changed', '')] = {
        mtime: slot.lastMtime,
        size: slot.lastSize,
        ready: slot.lastMtime > 0,
        path: slot.path,
      };
    }
    try {
      socket.write(buildTextFrame(JSON.stringify({
        type: 'hello',
        ts: Date.now(),
        files: helloFiles,
        // 兼容老 client 字段名
        snapshot: helloFiles.snapshot,
        blueprint: helloFiles.blueprint,
        wsIntervalMs,
        auth: { enabled: !!authToken },
      })));
    } catch { /* ignore */ }

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const frame = parseFrame(buf);
        if (!frame) break; // 数据不完整，等下一 chunk
        buf = buf.subarray(frame.consumed);
        if (frame.opcode === 0x8) {
          wsClients.delete(socket);
          try { socket.end(); } catch { /* ignore */ }
          return;
        }
        if (frame.opcode === 0x9) {
          try { socket.write(buildPongFrame(frame.payload)); } catch { /* ignore */ }
        }
        if (frame.opcode === 0x1 && frame.payload) {
          try {
            const msg = JSON.parse(frame.payload.toString('utf-8'));
            if (msg && msg.type === 'ping') {
              socket.write(buildTextFrame(JSON.stringify({ type: 'pong', ts: Date.now() })));
            }
          } catch { /* ignore 非 JSON */ }
        }
      }
    });
    socket.on('close', () => { wsClients.delete(socket); });
    socket.on('error', () => { wsClients.delete(socket); });
  });

  return { enabled: wsIntervalMs > 0, intervalMs: wsIntervalMs, clients: wsClients, broadcast: broadcastWs, files: fps };
}
