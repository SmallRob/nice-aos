// v0.42.0 前后端 RPC 双向链测试：
//   1. Python 客户端 outbound 端点 ↔ FastAPI 路由（路径参数名不同仍匹配）
//   2. method 软校验：路径命中即建链，method 不一致记在 apiMatch.methodMatches
//   3. 反向 clientEndpointIds + callsApi 边双向可查
//   4. 跨语言：Python 客户端 ↔ Go gin 路由
//   5. 无服务端路由时 rpcChain 为 null（该维度不适用）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOntologyData } from '../src/ontology/builder.js';
import { createBlueprintV2, LINK_TYPES } from '../src/ontology/blueprint.js';

// ---- Python 服务端 + Python 客户端 ----

const SERVER_PY = [
  'from fastapi import FastAPI',
  'app = FastAPI()',
  '',
  '@app.get("/api/users/{user_id}")',
  'def get_user(user_id: int):',
  '    return {"id": user_id}',
  '',
  '@app.post("/api/users")',
  'def create_user():',
  '    return {}',
  '',
  '@app.get("/api/orders")',
  'def list_orders():',
  '    return []',
].join('\n');

const CLIENT_PY = [
  'import requests',
  '',
  'def fetch_user(uid):',
  '    requests.get("http://localhost:8000/api/users/{uid}")',
  '',
  'def create():',
  '    requests.post("http://localhost:8000/api/users", json={})',
  '',
  'def wrong_method():',
  '    requests.delete("http://localhost:8000/api/orders")',
  '',
  'def not_found():',
  '    requests.get("http://localhost:8000/api/nope")',
].join('\n');

async function buildPyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-rpc-py-'));
  fs.writeFileSync(path.join(dir, 'server.py'), SERVER_PY);
  fs.writeFileSync(path.join(dir, 'client.py'), CLIENT_PY);
  return { dir, dataMap: await buildOntologyData(dir) };
}

test('RPC 链：Python 客户端端点匹配 FastAPI 路由（路径参数名不同仍命中）', async () => {
  const { dataMap } = await buildPyFixture();
  const nets = dataMap.NetworkEndpoint ?? [];
  assert.equal(nets.length, 4, JSON.stringify(nets.map((n) => n.url)));

  // 客户端用 {uid}、服务端声明 {user_id} —— 段级匹配应忽略参数名差异
  const get = nets.find((n) => n.url.includes('/api/users/{uid}'));
  assert.equal(get.serverRouteId, 'route:/api/users/{user_id}');
  assert.equal(get.serverRoutePath, '/api/users/{user_id}');
  assert.equal(get.apiMatch.methodMatches, true);
  assert.deepEqual(get.apiMatch.routeMethods, ['GET']);
  assert.equal(get.apiMatch.endpointMethod, 'GET');

  const post = nets.find((n) => n.url.endsWith('/api/users') && n.methods[0] === 'POST');
  assert.equal(post.serverRouteId, 'route:/api/users');
  assert.equal(post.apiMatch.methodMatches, true);
});

test('RPC 链：method 不一致仍建链，但 methodMatches=false', async () => {
  const { dataMap } = await buildPyFixture();
  const del = (dataMap.NetworkEndpoint ?? []).find((n) => n.methods[0] === 'DELETE');
  // 服务端 /api/orders 只声明 GET，客户端用 DELETE —— 路径命中即建链，method 差异如实记录
  assert.equal(del.serverRouteId, 'route:/api/orders');
  assert.equal(del.apiMatch.methodMatches, false);
  assert.deepEqual(del.apiMatch.routeMethods, ['GET']);
  assert.equal(del.apiMatch.endpointMethod, 'DELETE');
});

test('RPC 链：无对应路由的端点不建链', async () => {
  const { dataMap } = await buildPyFixture();
  const ghost = (dataMap.NetworkEndpoint ?? []).find((n) => n.url.endsWith('/api/nope'));
  assert.equal(ghost.serverRouteId, undefined);
  assert.equal(ghost.apiMatch, undefined);
});

test('RPC 链：反向 clientEndpointIds 挂在 Route 上', async () => {
  const { dataMap } = await buildPyFixture();
  const routes = dataMap.Route ?? [];
  const orders = routes.find((r) => r.routePath === '/api/orders');
  assert.deepEqual(orders.clientEndpointIds, ['net:out:delete:localhost:8000/api/orders']);
  // 未被引用的路由不应凭空出现该字段内容
  const nope = routes.find((r) => r.routePath === '/api/nope');
  assert.equal(nope, undefined);
});

test('RPC 链：_meta.rpcChain 覆盖度统计', async () => {
  const { dataMap } = await buildPyFixture();
  const st = dataMap._meta.rpcChain;
  assert.equal(st.serverRouteCount, 3);
  assert.equal(st.endpointCount, 4);
  assert.equal(st.matched, 3);
  assert.equal(st.methodMismatch, 1);
  assert.equal(st.unresolved, 1);
});

test('RPC 链：callsApi 边双向可查', async () => {
  const { dataMap } = await buildPyFixture();
  assert.ok(LINK_TYPES.includes('callsApi'));
  const engine = createBlueprintV2(dataMap);
  const hit = (dataMap.NetworkEndpoint ?? []).find((n) => n.serverRouteId);

  const fwd = engine.link('callsApi', hit.id);
  assert.equal(fwd.length, 1);
  assert.equal(fwd[0].id, hit.serverRouteId);

  const back = engine.link('callsApi', hit.serverRouteId);
  assert.equal(back.length, 1);
  assert.equal(back[0].id, hit.id);
});

test('RPC 链：无服务端路由时 rpcChain 为 null（维度不适用）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-rpc-none-'));
  fs.writeFileSync(path.join(dir, 'client.py'), [
    'import requests',
    'def main():',
    '    requests.get("https://api.example.com/v1/users")',
  ].join('\n'));
  const dm = await buildOntologyData(dir);
  assert.equal(dm._meta.rpcChain, null);
  const ep = dm.NetworkEndpoint[0];
  assert.equal(ep.serverRouteId, undefined);
});

// ---- 跨语言：Python 客户端 ↔ Go gin 路由 ----

const GO_MOD = ['module example.com/oneapi', '', 'go 1.21', '', 'require github.com/gin-gonic/gin v1.9.1'].join('\n');
const MAIN_GO = [
  'package main',
  '',
  'import (',
  '    "github.com/gin-gonic/gin"',
  '    "example.com/oneapi/controller"',
  ')',
  '',
  'func main() {',
  '    r := gin.New()',
  '    api := r.Group("/api")',
  '    user := api.Group("/user")',
  '    user.GET("/self", controller.GetSelf)',
  '    user.GET("/:id", controller.GetUser)',
  '    r.Run()',
  '}',
].join('\n');
const CONTROLLER_GO = ['package controller', '', 'func GetSelf() {}', 'func GetUser() {}'].join('\n');

test('RPC 链：跨语言 Python 客户端 ↔ Go gin 路由', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-rpc-go-'));
  fs.writeFileSync(path.join(dir, 'go.mod'), GO_MOD);
  fs.writeFileSync(path.join(dir, 'main.go'), MAIN_GO);
  fs.writeFileSync(path.join(dir, 'controller.go'), CONTROLLER_GO);
  fs.writeFileSync(path.join(dir, 'client.py'), [
    'import requests',
    '',
    'def load(uid):',
    '    requests.get(f"http://localhost:8080/api/user/{uid}")',
    '',
    'def load_self():',
    '    requests.get("http://localhost:8080/api/user/self")',
  ].join('\n'));

  const dm = await buildOntologyData(dir);
  const nets = dm.NetworkEndpoint ?? [];
  // Go 路由形如 /api/user/self 与 /api/user/:id
  const self = nets.find((n) => n.url.endsWith('/api/user/self'));
  assert.ok(self, JSON.stringify(nets.map((n) => n.url)));
  assert.ok(self.serverRouteId, `应命中 Go 路由，实际 ${self.serverRouteId}`);
  assert.ok(self.serverRoutePath.includes('/api/user/self'));

  const byId = nets.find((n) => n.url.endsWith('/api/user/{uid}'));
  assert.ok(byId.serverRouteId, 'Go 的 :id 参数段应通配客户端的 {uid}');
  assert.ok(byId.serverRoutePath.includes(':id'));

  assert.ok(dm._meta.rpcChain.matched >= 2, JSON.stringify(dm._meta.rpcChain));
});

// ---- v0.42.1: 路由声明顺序无关（字面量优先）----

// 故意把通配 :id 声明在字面量 self 之前，验证 matchApiRoute 的"字面量优先"兜底
const MAIN_GO_REVERSED = [
  'package main',
  '',
  'import (',
  '    "github.com/gin-gonic/gin"',
  '    "example.com/oneapi/controller"',
  ')',
  '',
  'func main() {',
  '    r := gin.New()',
  '    api := r.Group("/api")',
  '    user := api.Group("/user")',
  '    // 先声明通配，再声明字面量 —— 反 Gin 习惯，但 matchApiRoute 应当字面量优先',
  '    user.GET("/:id", controller.GetUser)',
  '    user.GET("/self", controller.GetSelf)',
  '    r.Run()',
  '}',
].join('\n');

test('RPC 链 v0.42.1：字面量路由在通配之后声明时，self 仍命中字面量（不是 :id）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-rpc-rev-'));
  fs.writeFileSync(path.join(dir, 'go.mod'), GO_MOD);
  fs.writeFileSync(path.join(dir, 'main.go'), MAIN_GO_REVERSED);
  fs.writeFileSync(path.join(dir, 'controller.go'), CONTROLLER_GO);
  fs.writeFileSync(path.join(dir, 'client.py'), [
    'import requests',
    '',
    'def load_self():',
    '    requests.get("http://localhost:8080/api/user/self")',
    '',
    'def load(uid):',
    '    requests.get(f"http://localhost:8080/api/user/{uid}")',
  ].join('\n'));

  const dm = await buildOntologyData(dir);
  const nets = dm.NetworkEndpoint ?? [];

  const self = nets.find((n) => n.url.endsWith('/api/user/self'));
  assert.ok(self, JSON.stringify(nets.map((n) => n.url)));
  // v0.42.1 修复：原实现在 :id 路由先声明时会错误命中 :id
  // routeId 格式：`route:METHOD path`（Go analyzer 把 method + space + path 作为 id）
  assert.equal(self.serverRouteId, 'route:GET /api/user/self',
    `应命中字面量 /api/user/self 而不是 :id，实际 ${self.serverRouteId}`);
  assert.equal(self.serverRoutePath, '/api/user/self');
  assert.equal(self.apiMatch.methodMatches, true);

  const byId = nets.find((n) => n.url.endsWith('/api/user/{uid}'));
  assert.equal(byId.serverRouteId, 'route:GET /api/user/:id',
    `通配路由 :id 应被 {uid} 命中，实际 ${byId.serverRouteId}`);

  // 路由侧反向 clientEndpointIds 仍正确
  const routes = dm.Route ?? [];
  const selfRoute = routes.find((r) => r.routePath === '/api/user/self');
  const idRoute = routes.find((r) => r.routePath === '/api/user/:id');
  assert.deepEqual(selfRoute.clientEndpointIds, [self.id]);
  assert.deepEqual(idRoute.clientEndpointIds, [byId.id]);
});

// ---- v0.42.1: 双向字段原子赋值（linkRouteToEndpoint helper）----

test('RPC 链 v0.42.1：linkRouteToEndpoint 双向字段一致（ep ↔ route 同时维护）', async () => {
  const { dataMap } = await buildPyFixture();
  const nets = dataMap.NetworkEndpoint ?? [];
  const routes = dataMap.Route ?? [];
  // 每个被匹配的端点，路由侧 clientEndpointIds 必含其 id；端点侧 serverRouteId
  // 必指向该路由的 id。任一方向不一致即 helper invariant 被破坏。
  for (const ep of nets) {
    if (!ep.serverRouteId) continue;
    const route = routes.find((r) => r.id === ep.serverRouteId);
    assert.ok(route, `端点 ${ep.id} 的 serverRouteId ${ep.serverRouteId} 应指向已存在的 Route`);
    assert.ok(
      (route.clientEndpointIds ?? []).includes(ep.id),
      `Route ${route.id} 的 clientEndpointIds 应含端点 ${ep.id}`,
    );
    // apiMatch 结构稳定
    assert.equal(typeof ep.apiMatch.methodMatches, 'boolean');
    assert.ok(Array.isArray(ep.apiMatch.routeMethods));
    assert.equal(typeof ep.apiMatch.endpointMethod, 'string');
  }
});

// ---- v0.44.0（ADR 0012 D3/D4）：method 消解 + 人工规则层 ----

// 同 path 不同 method 的多路由：POST 端点应命中 POST 路由（而非声明顺序在前的 GET）
const SERVER_PY_DUP_PATH = [
  'from fastapi import FastAPI',
  'app = FastAPI()',
  '',
  '@app.get("/api/users")',
  'def list_users():',
  '    return []',
  '',
  '@app.post("/api/users")',
  'def create_user():',
  '    return {}',
].join('\n');

const CLIENT_PY_DUP_PATH = [
  'import requests',
  '',
  'def load():',
  '    requests.get("http://localhost:8000/api/users")',
  '',
  'def save():',
  '    requests.post("http://localhost:8000/api/users")',
].join('\n');

test('RPC 链 v0.44.0：同路径多路由按 method 消解（POST 端点命中 POST 路由）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-rpc-method-'));
  fs.writeFileSync(path.join(dir, 'server.py'), SERVER_PY_DUP_PATH);
  fs.writeFileSync(path.join(dir, 'client.py'), CLIENT_PY_DUP_PATH);
  try {
    const dm = await buildOntologyData(dir);
    const nets = dm.NetworkEndpoint ?? [];
    const getEp = nets.find((n) => n.methods[0] === 'GET');
    const postEp = nets.find((n) => n.methods[0] === 'POST');
    const getRoute = (dm.Route ?? []).find((r) => r.routePath === '/api/users' && (r.apiMethods ?? []).includes('GET'));
    const postRoute = (dm.Route ?? []).find((r) => r.routePath === '/api/users' && (r.apiMethods ?? []).includes('POST'));

    assert.equal(getEp.serverRouteId, getRoute.id, `GET 端点应命中 GET 路由，实际 ${getEp.serverRouteId}`);
    assert.equal(postEp.serverRouteId, postRoute.id, `POST 端点应命中 POST 路由（而非声明顺序在前的 GET），实际 ${postEp.serverRouteId}`);
    assert.equal(postEp.apiMatch.methodMatches, true);
    assert.deepEqual(postEp.apiMatch.routeMethods, ['POST']);
    assert.equal(postEp.apiMatch.matchedVia, undefined, '自动命中无 matchedVia');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RPC 链 v0.44.0：无规则文件时 ruleMatched=0 且 rulesCount=0（行为与 v0.43 一致）', async () => {
  const { dataMap } = await buildPyFixture();
  const st = dataMap._meta.rpcChain;
  assert.equal(st.ruleMatched, 0);
  assert.equal(st.rulesCount, 0);
  assert.equal(st.rulesWarnings, undefined);
});

test('RPC 链 v0.44.0：人工规则命中（网关前缀改写）+ matchedVia 回执 + 统计', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-rpc-rule-'));
  fs.writeFileSync(path.join(dir, 'server.py'), [
    'from fastapi import FastAPI',
    'app = FastAPI()',
    '',
    '@app.get("/v2/api/users")',
    'def list_users():',
    '    return []',
  ].join('\n'));
  // 客户端经网关前缀 /gw-api 访问，自动匹配不命中 → 规则改写后命中
  fs.writeFileSync(path.join(dir, 'client.py'), [
    'import requests',
    '',
    'def load():',
    '    requests.get("http://gateway.internal/gw-api/users")',
  ].join('\n'));
  fs.mkdirSync(path.join(dir, '.nice-aos'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.nice-aos', 'api-routes.json'), JSON.stringify({
    rules: [{ from: '/gw-api', to: '/v2/api', comment: '网关前缀改写' }],
  }));
  try {
    const dm = await buildOntologyData(dir);
    const ep = (dm.NetworkEndpoint ?? []).find((n) => n.url.includes('/gw-api/users'));
    assert.ok(ep?.serverRouteId, `规则改写后应命中，实际 ${JSON.stringify(ep?.apiMatch)}`);
    assert.equal(ep.serverRoutePath, '/v2/api/users');
    assert.equal(ep.apiMatch.matchedVia, 'rule:/gw-api→/v2/api');
    const st = dm._meta.rpcChain;
    assert.equal(st.matched, 1);
    assert.equal(st.ruleMatched, 1);
    assert.equal(st.rulesCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RPC 链 v0.44.0：规则不劫持自动命中 + 非法规则条目记 warning 不阻断', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-rpc-rule2-'));
  fs.writeFileSync(path.join(dir, 'server.py'), [
    'from fastapi import FastAPI',
    'app = FastAPI()',
    '',
    '@app.get("/api/users")',
    'def list_users():',
    '    return []',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'client.py'), [
    'import requests',
    '',
    'def load():',
    '    requests.get("http://localhost:8000/api/users")',
  ].join('\n'));
  fs.mkdirSync(path.join(dir, '.nice-aos'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.nice-aos', 'api-routes.json'), JSON.stringify([
    { from: '/api', to: '/v2/api' },   // 若被前置劫持，会把 /api/users 错改写到 /v2/api/users
    { from: 'bad', to: '/x' },         // 非法条目：跳过并记 warning
  ]));
  try {
    const dm = await buildOntologyData(dir);
    const ep = (dm.NetworkEndpoint ?? []).find((n) => n.url.includes('/api/users'));
    assert.equal(ep.serverRouteId, 'route:/api/users');
    assert.equal(ep.apiMatch.matchedVia, undefined, '自动命中不应带 matchedVia');
    const st = dm._meta.rpcChain;
    assert.equal(st.ruleMatched, 0);
    assert.equal(st.rulesCount, 1);
    assert.equal(st.rulesWarnings?.length, 1, JSON.stringify(st.rulesWarnings));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
