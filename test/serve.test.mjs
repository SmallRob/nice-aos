// serve 命令测试：端点契约 + CORS + 目录解析链 + 快照后生成的实时可见性（回归：启动时一次性预检缺陷）
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');

const SNAP = {
  _meta: { generatedAt: '2026-08-22T00:00:00.000Z', cycles: [], orphanCandidates: [], objectCounts: { SourceFile: 2, Component: 1 } },
  Project: [{ id: 'proj:fixture', name: 'serve-fixture', framework: 'react', branch: 'main' }],
  SourceFile: [{ id: 'file:src/a.ts' }, { id: 'file:src/b.ts' }],
  Component: [{ id: 'comp:A', name: 'A' }],
};

function mkFixture(withSnapshot = true, withBlueprint = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-serve-'));
  if (withSnapshot) {
    fs.mkdirSync(path.join(dir, '.nice-aos', 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.nice-aos', 'data', 'snapshot.json'), JSON.stringify(SNAP));
  }
  if (withBlueprint) fs.writeFileSync(path.join(dir, 'blueprint.html'), '<!doctype html><title>bp-marker</title><p>bp-marker</p>');
  return dir;
}

// 启动 serve --port 0（自动分配端口），从横幅解析实际端口
function startServe(args, t) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'serve', '--port', '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    let out = '';
    const timer = setTimeout(() => reject(new Error(`serve 启动超时，输出: ${out}`)), 20_000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }); }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`serve 提前退出(${code})，输出: ${out}`)); });
  });
}

const get = async (port, p) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html/纯文本 */ }
  return { status: res.status, cors: res.headers.get('access-control-allow-origin'), text, json };
};

test('serve 端点契约：默认目录解析 + CORS + 各端点响应', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir], t);

  // /api/status：目录解析（默认 <root>/.nice-aos/data）+ 就绪状态 + CORS
  const st = await get(port, '/api/status');
  assert.equal(st.status, 200);
  assert.equal(st.cors, '*', 'CORS Access-Control-Allow-Origin: *');
  assert.equal(st.json.ok, true);
  assert.equal(st.json.snapshotDir, path.join(dir, '.nice-aos', 'data'));
  assert.equal(st.json.snapshot.ready, true);
  assert.equal(st.json.snapshot.state, 'ok');
  assert.equal(st.json.blueprint.ready, true);
  assert.deepEqual(st.json.endpoints, ['/snapshot.json', '/blueprint.html', '/api/status', '/api/stats', '/api/schema', '/']);
  assert.equal(st.json.root, dir);

  // /snapshot.json：完整快照可解析
  const snap = await get(port, '/snapshot.json');
  assert.equal(snap.status, 200);
  assert.equal(snap.cors, '*');
  assert.equal(snap.json.Project[0].name, 'serve-fixture');
  assert.equal(snap.json._meta.objectCounts.SourceFile, 2);

  // /blueprint.html：原样返回蓝图
  const bp = await get(port, '/blueprint.html');
  assert.equal(bp.status, 200);
  assert.match(bp.text, /bp-marker/);

  // /api/stats：统计摘要（name/framework/counts）
  const stats = await get(port, '/api/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.json.ok, true);
  assert.equal(stats.json.name, 'serve-fixture');
  assert.equal(stats.json.framework, 'react');
  assert.equal(stats.json.counts.SourceFile, 2);
  assert.deepEqual(stats.json.cycles, []);

  // /：状态首页
  const home = await get(port, '/');
  assert.equal(home.status, 200);
  assert.match(home.text, /AOS 数据源服务/);

  // OPTIONS 预检：CORS 预检放行
  const pre = await fetch(`http://127.0.0.1:${port}/snapshot.json`, { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');

  // 未知路径：404 + JSON 错误体
  const nf = await get(port, '/nope');
  assert.equal(nf.status, 404);
  assert.equal(nf.json.ok, false);
  assert.match(nf.json.error, /未支持路径/);
});

test('serve 快照后生成实时可见（回归：就绪状态不得在启动时一次性预检）', async (t) => {
  const dir = mkFixture(false, false); // 空项目：无快照无蓝图
  const { port } = await startServe(['--root', dir], t);
  const snapPath = path.join(dir, '.nice-aos', 'data', 'snapshot.json');

  // 启动时无快照：404
  const before = await get(port, '/snapshot.json');
  assert.equal(before.status, 404);
  assert.equal(before.json.ok, false);

  // 服务运行期间生成快照（模拟 refreshRepo）：无需重启即可读取
  fs.mkdirSync(path.dirname(snapPath), { recursive: true });
  fs.writeFileSync(snapPath, JSON.stringify(SNAP));
  const after = await get(port, '/snapshot.json');
  assert.equal(after.status, 200);
  assert.equal(after.json.Project[0].name, 'serve-fixture');

  // 快照损坏（非法 JSON）：500 且错误可辨识
  fs.writeFileSync(snapPath, '{broken json');
  const gone = await get(port, '/snapshot.json');
  assert.equal(gone.status, 500);
  assert.match(gone.json.error, /无法解析为合法 JSON/);
  const goneStats = await get(port, '/api/stats');
  assert.equal(goneStats.status, 500);
  assert.equal(goneStats.json.ok, false);

  // 蓝图同理：后生成即可见
  fs.writeFileSync(path.join(dir, 'blueprint.html'), '<p>late-bp</p>');
  const lateBp = await get(port, '/blueprint.html');
  assert.equal(lateBp.status, 200);
  assert.match(lateBp.text, /late-bp/);
});

test('serve --dir / --snapshot-dir 显式指定数据源目录', async (t) => {
  const dir = mkFixture(false, false);
  const custom = path.join(dir, 'custom-data');
  fs.mkdirSync(custom, { recursive: true });
  fs.writeFileSync(path.join(custom, 'snapshot.json'), JSON.stringify(SNAP));

  // --dir 指定
  const a = await startServe(['--root', dir, '--dir', custom], t);
  const sa = await get(a.port, '/api/status');
  assert.equal(sa.json.snapshotDir, custom);
  const snapA = await get(a.port, '/snapshot.json');
  assert.equal(snapA.status, 200);

  // --snapshot-dir 别名（与全局约定对齐）
  const b = await startServe(['--root', dir, '--snapshot-dir', custom], t);
  const sb = await get(b.port, '/api/status');
  assert.equal(sb.json.snapshotDir, custom);
  assert.equal(sb.json.snapshot.ready, true);

  // 未指定 --dir 且 <root>/.nice-aos/data 不存在时：快照缺失但服务可用（给出指引）
  const c = await startServe(['--root', dir, '--dir', path.join(dir, 'not-exist')], t);
  const sc = await get(c.port, '/snapshot.json');
  assert.equal(sc.status, 404);
  assert.match(sc.json.error, /refreshRepo/);
});
