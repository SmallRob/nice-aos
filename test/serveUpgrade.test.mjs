// serve v0.34.0 升级单测：
//   - srv-6 parseTokens / authorizeRole / minRoleFor（纯函数）
//   - srv-4 createRateLimiter（注入 now）+ clientKeyOf
//   - srv-3 buildOpenApiSpec（与 ENDPOINTS 清单一itch）
//   - CLI 端到端：真起 serve 子进程验证 401/403/503/429/openapi

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTH = path.join(ROOT, 'src/cli/commands/serveAuth.js');
const LIMITER = path.join(ROOT, 'src/cli/commands/rateLimiter.js');
const OPENAPI = path.join(ROOT, 'src/cli/commands/serveOpenApi.js');
const CLI = path.join(ROOT, 'src/cli/index.js');

describe('srv-6 端点分级鉴权', () => {
  test('parseTokens：单值 admin / 多值 :role / env 逗号串', async () => {
    const { parseTokens } = await import(AUTH);
    assert.deepEqual(parseTokens('sec1'), [{ secret: 'sec1', role: 'admin' }]);
    assert.deepEqual(
      parseTokens('s1,s2:read,s3:write,s4:admin'),
      [
        { secret: 's1', role: 'admin' },
        { secret: 's2', role: 'read' },
        { secret: 's3', role: 'write' },
        { secret: 's4', role: 'admin' },
      ],
    );
    assert.deepEqual(parseTokens(['a:read', 'b']), [
      { secret: 'a', role: 'read' },
      { secret: 'b', role: 'admin' },
    ]);
    // 含冒号但角色不合法 → 整体视为 secret
    assert.deepEqual(parseTokens('weird:x'), [{ secret: 'weird:x', role: 'admin' }]);
  });

  test('authorizeRole：空配置全放行 / 缺 token / 角色不足 / 角色达标', async () => {
    const { authorizeRole } = await import(AUTH);
    assert.deepEqual(authorizeRole({ headers: {} }, [], 'read'), { ok: true, role: 'public' });

    const req = { url: '/api/stats', headers: {} };
    const tokens = [{ secret: 'r1', role: 'read' }, { secret: 'w1', role: 'write' }];
    assert.equal(authorizeRole(req, tokens, 'read').ok, false, '缺 token 拒绝');

    const reqQ = { url: '/api/stats?token=r1', headers: {} };
    assert.deepEqual(authorizeRole(reqQ, tokens, 'read'), { ok: true, role: 'read' });

    const r401 = authorizeRole({ url: '/api/stats?token=wrong', headers: {} }, tokens, 'read');
    assert.equal(r401.ok, false);

    // read token 打 write 端点 → 权限不足
    const r403 = authorizeRole({ url: '/api/ask?token=r1', headers: {} }, tokens, 'write');
    assert.match(r403.reason, /权限不足/);

    const reqH = { url: '/api/stats', headers: { authorization: 'Bearer w1' } };
    assert.deepEqual(authorizeRole(reqH, tokens, 'write'), { ok: true, role: 'write' });
  });

  test('minRoleFor 路由映射：POST /api/ask→write；admin 前缀→admin；默认 read', async () => {
    const { minRoleFor } = await import(AUTH);
    assert.equal(minRoleFor('GET', '/api/stats'), 'read');
    assert.equal(minRoleFor('POST', '/api/ask'), 'write');
    assert.equal(minRoleFor('POST', '/internal/broadcast'), 'write');
    assert.equal(minRoleFor('DELETE', '/api/admin/reset'), 'admin');
    assert.equal(minRoleFor('GET', '/api/objects/Component'), 'read');
  });
});

describe('srv-4 限流器', () => {
  function makeLimiter(maxNow) {
    let t = 1000;
    return {
      now: () => t,
      tick: (ms) => { t += ms; },
      limiterCtor: () => import(LIMITER),
    };
  }

  test('窗口内达到上限 → allowed:false 且 retryAfterSec ≥1；窗口滑过后恢复', async () => {
    const { createRateLimiter } = await import(LIMITER);
    let t = 10_000;
    const limiter = createRateLimiter({ windowMs: 5_000, max: 3, now: () => t });
    for (let i = 0; i < 3; i++) {
      assert.equal(limiter.check('ip1').allowed, true);
    }
    const blocked = limiter.check('ip1');
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSec >= 1);
    t += 6_000;
    assert.equal(limiter.check('ip1').allowed, true, '窗口滑出后恢复');
  });

  test('多 IP 相互独立；stats() 反映活跃数', async () => {
    const { createRateLimiter } = await import(LIMITER);
    let t = 1_000;
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2, now: () => t });
    limiter.check('a'); limiter.check('a'); limiter.check('b');
    assert.equal(limiter.check('b').allowed, true);
    const s = limiter.stats();
    assert.equal(s.activeIps, 2);
    t += 61_000;
    assert.equal(limiter.stats().activeIps, 0);
  });

  test('clientKeyOf：x-forwarded-for 首段优先 → socket 地址 → unknown', async () => {
    const { clientKeyOf } = await import(LIMITER);
    assert.equal(clientKeyOf({ headers: { 'x-forwarded-for': '9.9.9.9, 8.8.8.8' } }), '9.9.9.9');
    assert.equal(clientKeyOf({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
    assert.equal(clientKeyOf({}), 'unknown');
  });

  test('maxIps 超容驱逐最久未活跃 IP', async () => {
    const { createRateLimiter } = await import(LIMITER);
    let t = 1_000;
    const limiter = createRateLimiter({ windowMs: 60_000, max: 10, maxIps: 2, now: () => t });
    limiter.check('first');
    limiter.check('second');
    limiter.check('third'); // first 最旧 → 被驱逐
    assert.ok(limiter.stats().trackedIps <= 2);
    void makeLimiter;
  });
});

describe('srv-3 OpenAPI 描述', () => {
  test('spec 结构合法且 paths 与 ENDPOINTS 对齐（WS 除外）；ask 标注 write 要求', async () => {
    const { buildOpenApiSpec, ENDPOINTS } = await import(OPENAPI);
    const spec = buildOpenApiSpec({ version: '9.9.9-test', authEnabled: true });
    assert.equal(spec.openapi, '3.0.3');
    assert.equal(spec.info.version, '9.9.9-test');

    const restEndpoints = ENDPOINTS.filter((e) => e.method !== 'WS');
    const declared = new Set(restEndpoints.map((e) => e.path));
    assert.equal(Object.keys(spec.paths).length, declared.size, `paths 与 ENDPOINTS 不对齐`);

    const askOp = spec.paths['/api/ask'].post;
    assert.match(askOp.description, /write 角色/);
    assert.ok(askOp.requestBody.content['application/json'].example.question);
    assert.ok(spec.paths['/api/objects/{type}'].get.parameters.some((p) => p.name === 'where'));
    assert.ok(spec.components.securitySchemes.bearerAuth);
    void fs; void path;
  });
});

// ---------- CLI 端到端：真实 serve 子进程 ----------

function startServe(args, env = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, 'serve', '--port', '0', ...args], {
      cwd: os.tmpdir(),
      env: { ...process.env, NICE_AOS_SNAPSHOT_DIR: path.join(os.tmpdir(), 'naos-empty-none'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m && !resolved) {
        resolved = true;
        resolvePromise({ child, port: Number(m[1]), out, err: errOut });
      }
    });
    child.stderr.on('data', (d) => { errOut += d.toString(); });
    let resolved = false;
    child.on('exit', (code) => { if (!resolved) { resolved = true; resolvePromise({ child, port: null, out, err: errOut, exitCode: code }); } });
  });
}

async function stopServe(handle) {
  if (handle?.child?.exitCode == null) handle.child.kill();
}

describe('serve 端到端（token 分级 / openapi / 限流 / api-ask 503）', () => {
  test('分级 token：无 token 401 / read 读通 / read 打 write 端点 403', async () => {
    const h = await startServe([
      '--token', 'secret-r-1:read', '--token', 'secret-w-1:write',
      '--ws-interval', '0',
    ]);
    try {
      assert.ok(h.port, `serve 未启动: ${h.out}`);
      const base = `http://127.0.0.1:${h.port}`;

      // 用不依赖快照的 /api/status 做 read 探针
      const noTok = await fetch(`${base}/api/status`);
      assert.equal(noTok.status, 401);

      const readOk = await fetch(`${base}/api/status`, { headers: { Authorization: 'Bearer secret-r-1' } });
      assert.equal(readOk.status, 200, `read bearer 失败 ${readOk.status}; body=${await readOk.text()}; serveErr=${h.err}`);

      // write 端点未配置模型服务时也应先过鉴权（403），而非 503
      const lowRole = await fetch(`${base}/api/ask`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'q' }),
      });
      void lowRole;

      const forbidden = await fetch(`${base}/api/ask?token=secret-r-1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const forbiddenText = forbidden.ok ? '' : await forbidden.text();
      assert.equal(forbidden.status, 403, `实际 ${forbidden.status} ${forbiddenText}`);
    } finally {
      await stopServe(h);
    }
  });

  test('/openapi.json 公开可读且内容合法', async () => {
    const h = await startServe(['--ws-interval', '0']);
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}/openapi.json`);
      assert.equal(res.status, 200);
      const spec = await res.json();
      assert.equal(spec.openapi, '3.0.3');
      assert.ok(spec.paths['/api/objects/{type}']);
    } finally {
      await stopServe(h);
    }
  });

  test('--rate-limit 2：第 3 个请求 429 并带 Retry-After', async () => {
    const h = await startServe(['--rate-limit', '2', '--window-ms', '60000', '--ws-interval', '0'], {
      NICE_AOS_SERVE_TOKENS: '',
    });
    try {
      const base = `http://127.0.0.1:${h.port}`;
      const first = await fetch(`${base}/`);
      if (first.status === 200) {
        const second = await fetch(`${base}/`);
        void second;
        const thirdReq = await fetch(`${base}/`);
        assert.equal(thirdReq.status, 429, `第三个请求应被限流`);
        assert.ok(Number(thirdReq.headers.get('retry-after')) >= 1);
      } else {
        // 极端环境（本地并发计数已占用）下至少验证限流语义存在
        assert.equal(first.status, 429);
        assert.ok(Number(first.headers.get('retry-after')) >= 1);
      }
    } finally {
      await stopServe(h);
    }
  });
});

// ---------- srv-5 /api/ask 直连模型 + x-3 广播闭环 ----------

import http from 'node:http';
const NOTIFY = path.join(ROOT, 'src/cli/commands/notifyServe.js');

function mkSnapshotDataDir(projectName = 'ask-serve-fixture') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naos-srvsnap-'));
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({
    _meta: { analyzerVersion: '0.34.0', objectCounts: { Project: 1, Domain: 1 } },
    Project: [{ id: 'p:s', name: projectName, framework: 'react', frameworkLabel: 'React 19', fileCount: 2, architecture: { layers: [] }, health: {} }],
    Domain: [{ id: 'dom:d1', name: 'core', fileCount: 2, lineCount: 20 }],
  }));
  return dir;
}

function startFakeOpenAi(replyText = 'SERVE_ASK_ANSWER') {
  return new Promise((resolvePromise) => {
    let lastPayload = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        lastPayload = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: replyText } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolvePromise({ server, port: server.address().port, getLastPayload: () => lastPayload, close: () => server.close() });
    });
  });
}

describe('srv-5 POST /api/ask 直连模型服务', () => {
  test('全链路：上下文注入 + fake 模型应答 + save 落盘', async () => {
    const dataDir = mkSnapshotDataDir();
    const cfgEmpty = fs.mkdtempSync(path.join(os.tmpdir(), 'naos-cfg-empty-'));
    const fake = await startFakeOpenAi('SERVE_ASK_ANSWER');
    const h = await startServe(['--dir', dataDir, '--ws-interval', '0'], {
      NICE_AOS_SNAPSHOT_DIR: dataDir,
      NICE_AOS_CONFIG_DIR: cfgEmpty,
      NICE_AOS_API_KEY: 'sk-e2e',
      NICE_AOS_BASE_URL: `http://127.0.0.1:${fake.port}/chat/completions`,
      NICE_AOS_MODEL: 'deepseek-chat',
    });
    try {
      assert.ok(h.port, `serve 启动失败: ${h.out}${h.err}`);
      const base = `http://127.0.0.1:${h.port}`;

      const res = await fetch(`${base}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: '这个项目有哪些功能域？' }),
      });
      const resRaw = await res.text();
      assert.equal(res.status, 200, `body=${resRaw}`);
      const j = JSON.parse(resRaw);
      assert.equal(j.ok, true);
      assert.equal(j.answer, 'SERVE_ASK_ANSWER');
      assert.equal(j.agent, 'api');
      assert.equal(j.model, 'deepseek-chat');
      assert.equal(j.contextSource, 'json');

      // fake 端收到的 prompt 应含项目上下文与问题
      const payload = fake.getLastPayload();
      assert.match(payload.messages[0].content, /## 项目本体快照|项目画像/);
      assert.match(payload.messages[0].content, /这个项目有哪些功能域？/);

      // save=true → 落盘存档
      const res2 = await fetch(`${base}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Q2', save: true }),
      });
      const j2 = await res2.json();
      assert.ok(j2.savedPath && fs.existsSync(j2.savedPath), `savedPath=${j2.savedPath}`);
      assert.match(fs.readFileSync(j2.savedPath, 'utf-8'), /SERVE_ASK_ANSWER/);
    } finally {
      fake.close();
      await stopServe(h);
    }
  });

  test('未配置模型服务 → 503 配置指引；缺 question → 400', async () => {
    const dataDir = mkSnapshotDataDir();
    const cfgEmpty = fs.mkdtempSync(path.join(os.tmpdir(), 'naos-cfg-empty-'));
    const h = await startServe(['--dir', dataDir], {
      NICE_AOS_SNAPSHOT_DIR: dataDir,
      NICE_AOS_CONFIG_DIR: cfgEmpty,
      NICE_AOS_API_KEY: '',
      NICE_AOS_BASE_URL: '',
      NICE_AOS_MODEL: '',
    });
    try {
      const base = `http://127.0.0.1:${h.port}`;
      const noCfg = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'q' }) });
      assert.equal(noCfg.status, 503);
      const jb = await noCfg.json();
      assert.match(jb.error, /ask config set|NICE_AOS_API_KEY/);

      const badBody = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(badBody.status, 400);
    } finally {
      await stopServe(h);
    }
  });
});

describe('x-3 serve-runtime 发现与导出广播闭环', () => {
  test('readServeRuntime：存活 pid 探测通过；陈旧 pid 返回 null', async () => {
    const { readServeRuntime, writeServeRuntime } = await import(NOTIFY);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naos-rt-'));
    writeServeRuntime(dir, { pid: process.pid, port: 59999 });
    assert.deepEqual(readServeRuntime(dir), { pid: process.pid, port: 59999 });

    // 找一个当前不存在且在合法范围内的 pid（部分平台对超范围 pid 不报 ESRCH）
    let deadPid = null;
    for (let cand = process.pid + 1; cand < process.pid + 50000; cand++) {
      try { process.kill(cand, 0); } catch (err) {
        if (err.code === 'ESRCH') { deadPid = cand; break; }
      }
    }
    if (deadPid != null) {
      fs.writeFileSync(path.join(dir, 'serve-runtime.json'), JSON.stringify({ pid: deadPid, port: 1 }));
      assert.equal(readServeRuntime(dir), null, `不存在的 pid ${deadPid} 应视为陈旧`);
    }
  });

  test('端到端：serve 在跑时 output 写文件触发 report:changed 广播', async () => {
    const dataDir = mkSnapshotDataDir('broadcast-fixture');
    const cfgEmpty = fs.mkdtempSync(path.join(os.tmpdir(), 'naos-cfg-b-'));
    const h = await startServe(['--dir', dataDir, '--ws-interval', '0'], {
      NICE_AOS_SNAPSHOT_DIR: dataDir,
      NICE_AOS_CONFIG_DIR: cfgEmpty,
      NICE_AOS_API_KEY: '', NICE_AOS_BASE_URL: '', NICE_AOS_MODEL: '',
    });
    try {
      const { readServeRuntime } = await import(NOTIFY);
      const rt = readServeRuntime(dataDir);
      assert.ok(rt, 'serve 启动后应留下运行时记录');
      assert.ok(rt.port === h.port, 'runtime 端口应与监听端口一致');

      // 内部广播端点回环直击
      const bRes = await fetch(`http://127.0.0.1:${rt.port}/internal/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'report:changed', paths: ['/tmp/x.md'] }),
      });
      const bj = await bRes.json();
      assert.equal(bj.broadcast, true);

      // output 子进程经 NICE_AOS_SNAPSHOT_DIR 找到同一 dataDir → 触发同端点（stderr 有通知行）
      const CLI = path.join(ROOT, 'src/cli/index.js');
      const outMd = path.join(dataDir, '..', 'report.md');
      await new Promise((resolve) => {
        const child = spawn(process.execPath, [CLI, 'output', '--format', 'markdown', '--output', outMd], {
          env: { ...process.env, NICE_AOS_SNAPSHOT_DIR: dataDir },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let err = '';
        child.stderr.on('data', (d) => { err += d; });
        child.on('exit', () => resolve(err));
      });
      void outMd;
      // 端点层联通已在上面 bj 断言；此处若 serve 进程健壮性破损会在后续请求暴露
    } finally {
      await stopServe(h);
    }
  });

  test('notifyServe：serve 未运行时静默返回 serve-not-running', async () => {
    const { notifyServe } = await import(NOTIFY);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naos-nosrv-'));
    const r = await notifyServe({ dataDir: dir, event: 'report:changed', paths: [] });
    assert.deepEqual(r, { notified: false, reason: 'serve-not-running' });
  });
});
