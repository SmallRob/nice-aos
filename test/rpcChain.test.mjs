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
