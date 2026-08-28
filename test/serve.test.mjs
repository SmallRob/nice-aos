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
  // v0.34.0：endpoints 清单改由 serveOpenApi.ENDPOINTS 派生（含新增端点）；v0.35.0 增加 POST /action（E-3）；v0.38 增加 /docs 与 /context/{path}（output docs 文档浏览）
  assert.deepEqual(st.json.endpoints, ['/', '/snapshot.json', '/blueprint.html', '/docs', '/context/{path}', '/openapi.json', '/api/status', '/api/stats', '/api/schema', '/api/objects/{type}', '/api/ask/context', '/api/rate-limit', '/api/ask', '/action', '/ws/snapshot']);
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

// 预镜像 fixture 到 SQLite（storage rebuild），返回 promise
function rebuildSqlite(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, '--snapshot-dir', dataDir, 'storage', 'rebuild', '--kind', 'code'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`storage rebuild 失败(${code}): ${out}`))));
    child.on('error', reject);
  });
}

test('serve SQL 端点（SQLite 路径）：/api/objects/:type + /api/ask/context', async (t) => {
  const dir = mkFixture(); // <dir>/.nice-aos/data/snapshot.json
  const dataDir = path.join(dir, '.nice-aos', 'data');
  await rebuildSqlite(dataDir); // 镜像到 <dataDir>/aos.sqlite

  const { port } = await startServe(['--root', dir], t);

  // limit 截断：2 个 SourceFile 只取 1
  const lim = await get(port, '/api/objects/SourceFile?limit=1');
  assert.equal(lim.status, 200);
  assert.equal(lim.json.ok, true);
  assert.equal(lim.json.source, 'sqlite');
  assert.equal(lim.json.total, 2);
  assert.equal(lim.json.count, 1);
  assert.equal(lim.json.truncated, true);
  assert.equal(lim.json.objects.length, 1);

  // limit=0 不限
  const all = await get(port, '/api/objects/SourceFile?limit=0');
  assert.equal(all.json.count, 2);
  assert.equal(all.json.count, all.json.total);
  assert.equal(all.json.truncated, false);

  // where 模糊（k~v 子串忽略大小写）
  const fuzzy = await get(port, '/api/objects/SourceFile?where=id~src/a');
  assert.equal(fuzzy.json.total, 1);
  assert.equal(fuzzy.json.objects[0].id, 'file:src/a.ts');

  // where 精确（k=v）
  const eq = await get(port, '/api/objects/Component?where=name=A');
  assert.equal(eq.json.total, 1);
  assert.equal(eq.json.objects[0].name, 'A');

  // 未知类型：400 + validTypes
  const bad = await get(port, '/api/objects/Nope');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.ok, false);
  assert.ok(Array.isArray(bad.json.validTypes));
  assert.ok(bad.json.validTypes.includes('SourceFile'));

  // ask 上下文：source=sqlite，含项目名
  const ctx = await get(port, '/api/ask/context?q=' + encodeURIComponent('架构?'));
  assert.equal(ctx.status, 200);
  assert.equal(ctx.json.ok, true);
  assert.equal(ctx.json.source, 'sqlite');
  assert.match(ctx.json.context, /名称: serve-fixture/);
  assert.match(ctx.json.context, /问题/);
  assert.match(ctx.json.context, /架构\?/);
});

test('serve SQL 端点（JSON 回退）：--sqlite off 时两个端点走 JSON', async (t) => {
  const dir = mkFixture();

  // 全局 --sqlite off：storage 层禁用 → loadType 返回 null → JSON 回退
  const { port } = await startServeSqliteOff(['--root', dir], t);

  const objs = await get(port, '/api/objects/SourceFile');
  assert.equal(objs.status, 200);
  assert.equal(objs.json.ok, true);
  assert.equal(objs.json.source, 'json');
  assert.equal(objs.json.total, 2);

  const fuzzy = await get(port, '/api/objects/SourceFile?where=id~src/b');
  assert.equal(fuzzy.json.total, 1);
  assert.equal(fuzzy.json.objects[0].id, 'file:src/b.ts');

  const ctx = await get(port, '/api/ask/context');
  assert.equal(ctx.status, 200);
  assert.equal(ctx.json.source, 'json');
  assert.match(ctx.json.context, /名称: serve-fixture/);
});

// 与 startServe 相同但注入全局 --sqlite off（模式切换后 storage 单例失效，serve 每请求重探）
function startServeSqliteOff(args, t) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, '--sqlite', 'off', 'serve', '--port', '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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

// =============================================================================
// v0.35.0（E-3）：POST /action —— 蓝图 UI 动作卡片提交端点
// =============================================================================

const postAction = async (port, body) => {
  const res = await fetch(`http://127.0.0.1:${port}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json };
};

test('POST /action：未知动作返回 400 + 可用动作提示（E-3）', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir], t);
  const r = await postAction(port, { actionName: 'nopeAction', params: {} });
  assert.equal(r.status, 400);
  assert.equal(r.json.ok, false);
  assert.match(r.json.message, /未知动作/);
});

test('POST /action：markReviewed 写快照落盘可回读 + addNote 累加（E-3）', async (t) => {
  const dir = mkFixture();
  const snapFile = path.join(dir, '.nice-aos', 'data', 'snapshot.json');
  const { port } = await startServe(['--root', dir], t);

  const reviewed = await postAction(port, { actionName: 'markReviewed', params: { objectId: 'comp:A' } });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.json.ok, true);
  assert.match(reviewed.json.message, /已标记 comp:A/);

  const note1 = await postAction(port, { actionName: 'addNote', params: { objectId: 'comp:A', note: '第一条' } });
  const note2 = await postAction(port, { actionName: 'addNote', params: { objectId: 'comp:A', note: '第二条' } });
  assert.equal(note1.json.ok, true);
  assert.equal(note2.json.ok, true);

  // 快照回读：写动作必须真实持久化
  const snapAfter = JSON.parse(fs.readFileSync(snapFile, 'utf-8'));
  const comp = snapAfter.Component.find((c) => c.id === 'comp:A');
  assert.equal(comp.reviewed, true);
  assert.ok(comp.reviewedAt, 'reviewedAt 已写入');
  assert.equal(comp.notes, '第一条\n第二条');

  // 守卫：对象不存在 → 400；缺参 → 400；快照缺失目录 → 404
  const missing = await postAction(port, { actionName: 'markReviewed', params: { objectId: 'comp:Nope' } });
  assert.equal(missing.status, 400);
  const noId = await postAction(port, { actionName: 'markReviewed', params: {} });
  assert.equal(noId.status, 400);
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-serve-empty-'));
  t.after(() => { try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch { /* */ } });
  const { port: port2 } = await startServe(['--root', emptyDir], t);
  const noSnap = await postAction(port2, { actionName: 'markReviewed', params: { objectId: 'comp:A' } });
  assert.equal(noSnap.status, 404);
});

test('POST /action：analyzeFile 只读分析单文件成功 + 缺参/坏路径 400（E-3）', async (t) => {
  const dir = mkFixture();
  const targetTs = path.join(dir, 'widget.tsx');
  fs.writeFileSync(targetTs, "export function Hello(){ return <p>hi</p>; }\n");
  const { port } = await startServe(['--root', dir], t);

  const okRes = await postAction(port, { actionName: 'analyzeFile', params: { file: targetTs } });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.json.ok, true);
  assert.match(okRes.json.message, /widget\.tsx/);
  assert.ok((okRes.json.stats?.SourceFile ?? 0) >= 1, '应至少产出 1 个 SourceFile');

  const noParam = await postAction(port, { actionName: 'analyzeFile', params: {} });
  assert.equal(noParam.status, 400);
  assert.match(noParam.json.message, /缺少参数 file/);
  const badPath = await postAction(port, { actionName: 'analyzeFile', params: { file: '/nonexistent/x.ts' } });
  assert.equal(badPath.status, 400);
  assert.match(badPath.json.message, /文件不存在/);
});
