// ADR 0012 测试（借鉴 asdm-aos）：
//   D1 投影公共件 parseFields/projectObjects —— CLI query --field / serve fields / MCP fields 共用
//   D2 count 命令 —— 单行紧凑 JSON
//   D3 matchApiRouteEx —— method 作同路径多路由的消解优先级（不做硬门）；matchApiRoute 薄包装行为不变
//   D4 loadApiRouteRules —— 规则文件加载与容错
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFields, projectObjects } from '../src/cli/shared.js';
import { matchApiRoute, matchApiRouteEx, apiPathSegments } from '../src/ontology/rpcMatch.js';
import { loadApiRouteRules } from '../src/ontology/apiRouteRules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.js');

// ---- D1: parseFields ----

test('D1 parseFields：逗号分隔 / trim / 去空 / 空值返 null', () => {
  assert.deepEqual(parseFields('id,name,filePath'), ['id', 'name', 'filePath']);
  assert.deepEqual(parseFields(' id , name '), ['id', 'name']);
  assert.deepEqual(parseFields('id,,name,'), ['id', 'name']);
  assert.equal(parseFields(''), null);
  assert.equal(parseFields('   '), null);
  assert.equal(parseFields(undefined), null);
});

// ---- D1: projectObjects ----

test('D1 projectObjects：字段白名单，id 恒保留，不存在的字段不产生键', () => {
  const objects = [
    { id: 'mtd:1', name: 'a', ownerName: 'A', extra: 'x' },
    { id: 'mtd:2', name: 'b' },
  ];
  const out = projectObjects(objects, ['name', 'ghost']);
  assert.deepEqual(out, [
    { name: 'a', id: 'mtd:1' },
    { name: 'b', id: 'mtd:2' },
  ], JSON.stringify(out));

  // 请求里显式带 id 时位置按请求顺序
  const out2 = projectObjects(objects, ['id', 'ownerName']);
  assert.deepEqual(out2, [
    { id: 'mtd:1', ownerName: 'A' },
    { id: 'mtd:2' },
  ]);

  // fields 为 null / 非数组输入时原样返回（语义：未请求投影）
  assert.equal(projectObjects(objects, null), objects);
  const notArray = { id: 'x' };
  assert.equal(projectObjects(notArray, ['id']), notArray);
});

// ---- D3: matchApiRouteEx 阶梯 ----

function routes(list) {
  return list.map((r) => ({ r, segs: apiPathSegments(r.routePath) ?? [] }));
}

test('D3 method 消解：同路径多路由时优先 method 一致的', () => {
  const list = routes([
    { id: 'route:GET /api/users', routePath: '/api/users', apiMethods: ['GET'] },
    { id: 'route:POST /api/users', routePath: '/api/users', apiMethods: ['POST'] },
  ]);
  const get = matchApiRouteEx(['api', 'users'], list, { method: 'GET' });
  assert.equal(get.route.id, 'route:GET /api/users');
  assert.equal(get.via, null);
  const post = matchApiRouteEx(['api', 'users'], list, { method: 'POST' });
  assert.equal(post.route.id, 'route:POST /api/users');
});

test('D3 method 不做硬门：唯一路径命中时 method 不一致仍返回该路由', () => {
  const list = routes([{ id: 'route:GET /api/orders', routePath: '/api/orders', apiMethods: ['GET'] }]);
  const hit = matchApiRouteEx(['api', 'orders'], list, { method: 'DELETE' });
  assert.equal(hit.route.id, 'route:GET /api/orders');
  assert.equal(hit.via, null);
});

test('D3 method=MIXED 或缺省时退化为 v0.42.1 行为（字面量优先，无 method 阶梯）', () => {
  const list = routes([
    { id: 'route:GET /api/users', routePath: '/api/users', apiMethods: ['GET'] },
    { id: 'route:POST /api/users', routePath: '/api/users', apiMethods: ['POST'] },
  ]);
  assert.equal(matchApiRouteEx(['api', 'users'], list, { method: 'MIXED' }).route.id, 'route:GET /api/users');
  assert.equal(matchApiRouteEx(['api', 'users'], list, {}).route.id, 'route:GET /api/users');
  // 通配 + method：method 一致的通配路由优先
  const wild = routes([
    { id: 'route:GET /api/user/:id', routePath: '/api/user/:id', apiMethods: ['GET'] },
    { id: 'route:POST /api/user/:id', routePath: '/api/user/:id', apiMethods: ['POST'] },
  ]);
  assert.equal(matchApiRouteEx(['api', 'user', '7'], wild, { method: 'POST' }).route.id, 'route:POST /api/user/:id');
});

test('D3 matchApiRoute 薄包装：既有调用方行为零变化（返回 route 或 null）', () => {
  const list = routes([
    { id: 'route:GET /api/user/self', routePath: '/api/user/self', apiMethods: ['GET'] },
    { id: 'route:GET /api/user/:id', routePath: '/api/user/:id', apiMethods: ['GET'] },
  ]);
  assert.equal(matchApiRoute(['api', 'user', 'self'], list).id, 'route:GET /api/user/self');
  assert.equal(matchApiRoute(['api', 'user', '7'], list).id, 'route:GET /api/user/:id');
  assert.equal(matchApiRoute(['other'], list), null);
});

// ---- D4: loadApiRouteRules ----

test('D4 规则文件缺失：空规则零警告（默认形态）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-rules-'));
  const { rules, warnings } = loadApiRouteRules(dir);
  assert.deepEqual(rules, []);
  assert.deepEqual(warnings, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('D4 规则文件：{rules} 与裸数组两形态，段级预切，非法条目跳过并记 warning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-rules-'));
  fs.mkdirSync(path.join(dir, '.nice-aos'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.nice-aos', 'api-routes.json'), JSON.stringify({
    rules: [
      { from: '/gw-api/', to: '/v2/api', comment: '网关前缀' },
      { from: 'no-slash', to: '/x' },
      { to: '/y' },
    ],
  }));
  const { rules, warnings } = loadApiRouteRules(dir);
  assert.deepEqual(rules, [{ from: '/gw-api/', to: '/v2/api', fromSegs: ['gw-api'], toSegs: ['v2', 'api'], comment: '网关前缀' }]);
  assert.equal(warnings.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('D4 规则文件非法 JSON / 错误顶层结构：跳过并记 warning，不抛异常', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-rules-'));
  fs.mkdirSync(path.join(dir, '.nice-aos'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.nice-aos', 'api-routes.json'), '{oops');
  let r1 = loadApiRouteRules(dir);
  assert.deepEqual(r1.rules, []);
  assert.equal(r1.warnings.length, 1);
  fs.writeFileSync(path.join(dir, '.nice-aos', 'api-routes.json'), '{"foo":1}');
  let r2 = loadApiRouteRules(dir);
  assert.deepEqual(r2.rules, []);
  assert.equal(r2.warnings.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('D4 规则匹配：自动未命中后前缀改写重试，via 可审计', () => {
  const rules = [{ from: '/gw-api', to: '/v2/api', fromSegs: ['gw-api'], toSegs: ['v2', 'api'], comment: null }];
  const list = routes([{ id: 'route:GET /v2/api/users', routePath: '/v2/api/users', apiMethods: ['GET'] }]);
  const hit = matchApiRouteEx(['gw-api', 'users'], list, { method: 'GET', rules });
  assert.equal(hit.route.id, 'route:GET /v2/api/users');
  assert.equal(hit.via, 'rule:/gw-api→/v2/api');
});

test('D4 规则不劫持自动命中', () => {
  const rules = [{ from: '/api', to: '/v2/api', fromSegs: ['api'], toSegs: ['v2', 'api'], comment: null }];
  const list = routes([
    { id: 'route:GET /api/users', routePath: '/api/users', apiMethods: ['GET'] },
    { id: 'route:GET /v2/api/users', routePath: '/v2/api/users', apiMethods: ['GET'] },
  ]);
  const hit = matchApiRouteEx(['api', 'users'], list, { method: 'GET', rules });
  assert.equal(hit.route.id, 'route:GET /api/users');
  assert.equal(hit.via, null);
});

// ---- D1/D2: CLI 端到端（spawn）----

function makeTmpSnapshot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nice-aos-count-'));
  const dataDir = path.join(tmp, '.nice-aos', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
    Method: [
      { id: 'method:a.ts#a', name: 'a', ownerKind: 'interface' },
      { id: 'method:a.ts#b', name: 'b', ownerKind: 'class' },
      { id: 'method:c.ts#c', name: 'c', ownerKind: 'interface' },
    ],
  }), 'utf-8');
  return { tmp, dataDir, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf-8', timeout: 60000 });
}

test('D2 CLI count：单行紧凑 JSON，--where 过滤', () => {
  const { tmp, cleanup } = makeTmpSnapshot();
  try {
    const r1 = runCli(['count', 'Method', '--snapshot-dir', path.join(tmp, '.nice-aos', 'data')], tmp);
    assert.equal(r1.status, 0, r1.stderr);
    const lines = r1.stdout.trim().split('\n');
    assert.equal(lines.length, 1, `应单行输出，实际 ${lines.length} 行`);
    assert.deepEqual(JSON.parse(lines[0]), { ok: true, type: 'Method', total: 3 });

    const r2 = runCli(['count', 'Method', '--where', 'ownerKind=interface', '--snapshot-dir', path.join(tmp, '.nice-aos', 'data')], tmp);
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(JSON.parse(r2.stdout.trim()), { ok: true, type: 'Method', where: 'ownerKind=interface', total: 2 });

    const r3 = runCli(['count', 'Nope', '--snapshot-dir', path.join(tmp, '.nice-aos', 'data')], tmp);
    assert.equal(r3.status, 1);
    assert.ok(JSON.parse(r3.stderr).error.includes('未知对象类型'));
  } finally {
    cleanup();
  }
});

test('D1 CLI query --field：投影 + where + limit 联用', () => {
  const { tmp, cleanup } = makeTmpSnapshot();
  try {
    const r = runCli(['query', 'Method', '--where', 'ownerKind=interface', '--field', 'name,ownerKind', '--snapshot-dir', path.join(tmp, '.nice-aos', 'data')], tmp);
    assert.equal(r.status, 0, r.stderr);
    const objects = JSON.parse(r.stdout);
    assert.deepEqual(objects, [
      { name: 'a', ownerKind: 'interface', id: 'method:a.ts#a' },
      { name: 'c', ownerKind: 'interface', id: 'method:c.ts#c' },
    ], r.stdout);
  } finally {
    cleanup();
  }
});
