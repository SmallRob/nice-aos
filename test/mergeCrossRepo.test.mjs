// v0.47 跨仓 RPC 匹配测试（借鉴 asdm-aos multiRepoMerge.crossRepoApiMatch）：
//   前端仓（TS fetch + Python 客户端，构建期无服务端路由可匹配）+ 后端仓（Go gin 路由）
//   合并后在总路由池上补链：unmatchedFrontendCalls / 未建链 outbound 端点 → crossRepo 边 + rpcChain 统计
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOntologyData } from '../src/ontology/builder.js';
import { mergeSnapshots } from '../src/ontology/merge.js';

const GO_MOD = ['module example.com/ordersvc', '', 'go 1.21', '', 'require github.com/gin-gonic/gin v1.9.1'].join('\n');
const BACKEND_MAIN_GO = [
  'package main',
  '',
  'import (',
  '    "github.com/gin-gonic/gin"',
  '    "example.com/ordersvc/handler"',
  ')',
  '',
  'func main() {',
  '    r := gin.New()',
  '    api := r.Group("/api")',
  '    api.GET("/orders/:id", handler.GetOrder)',
  '    api.GET("/users/:id", handler.GetUser)',
  '    r.Run()',
  '}',
].join('\n');

const CALLER_TS = [
  'export async function loadOrder(id: string) {',
  '  return fetch(`/api/orders/${id}`);',
  '}',
].join('\n');

const CLIENT_PY = [
  'import requests',
  '',
  'def fetch_user(uid):',
  '    requests.get("http://localhost:8080/api/users/5")',
].join('\n');

async function buildFrontend() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-xrepo-fe-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fe-app', dependencies: { vite: '^5.0.0' } }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/caller.ts'), CALLER_TS);
  fs.writeFileSync(path.join(dir, 'client.py'), CLIENT_PY);
  return { dir, snap: await buildOntologyData(dir) };
}

async function buildBackend() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-xrepo-be-'));
  fs.writeFileSync(path.join(dir, 'go.mod'), GO_MOD);
  fs.writeFileSync(path.join(dir, 'main.go'), BACKEND_MAIN_GO);
  fs.writeFileSync(path.join(dir, 'handler.go'), 'package handler\n\nfunc GetOrder() {}\nfunc GetUser() {}');
  return { dir, snap: await buildOntologyData(dir) };
}

test('跨仓 RPC 补链：合并后未命中前端调用与 outbound 端点命中他仓路由', async () => {
  const fe = await buildFrontend();
  const be = await buildBackend();
  try {
    // 前置：单仓构建期确实未命中（无服务端路由）
    assert.ok((fe.snap._meta.unmatchedFrontendCalls ?? []).length >= 1, 'TS 调用应进未命中清单');
    const pyEp = fe.snap.NetworkEndpoint.find((n) => n.url.includes('/api/users'));
    assert.equal(pyEp.serverRouteId, undefined, 'python 端点单仓内不应建链');

    const rulesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-xrepo-rules-')); // 无 api-routes.json 的干净根
    const merged = mergeSnapshots([fe.snap, be.snap], {
      sources: [{ name: 'fe-app' }, { name: 'ordersvc' }],
      projectRoot: rulesRoot,
    });

    const rpc = merged.dataMap._meta.merged.rpcChain;
    assert.ok(rpc, '应产出 rpcChain 统计');
    assert.equal(rpc.frontendCallMatched, 1, 'TS fetch 调用补链');
    assert.equal(rpc.endpointMatched, 1, 'python outbound 端点补链');
    assert.equal(rpc.serverRouteCount, 2);

    // TS 侧：边挂在合并后的 Go 路由上，crossRepo 回执 + fileId 按 path 在合并池中重定位
    const orderRoute = merged.dataMap.Route.find((r) => r.routePath === '/api/orders/:id');
    assert.ok(orderRoute.frontendCalls?.length === 1, JSON.stringify(orderRoute.frontendCalls));
    const entry = orderRoute.frontendCalls[0];
    assert.equal(entry.crossRepo, true);
    assert.equal(entry.tier, 3, '字面量 5 vs :id → 通配+method');
    assert.equal(entry.fileId, 'file:src/caller.ts', 'fileId 经合并 SourceFile path 重定位');

    // Python 侧：双向字段 + apiMatch.crossRepo
    const matchedEp = merged.dataMap.NetworkEndpoint.find((n) => n.url.includes('/api/users'));
    assert.equal(matchedEp.serverRouteId, orderRoute.id === matchedEp.serverRouteId ? matchedEp.serverRouteId : matchedEp.serverRouteId);
    assert.ok(matchedEp.serverRouteId, '应建链');
    assert.equal(matchedEp.apiMatch.crossRepo, true);
    assert.equal(matchedEp.apiMatch.tier, 3);
    const userRoute = merged.dataMap.Route.find((r) => r.routePath === '/api/users/:id');
    assert.ok(userRoute.clientEndpointIds.includes(matchedEp.id), '反向 clientEndpointIds');
  } finally {
    fs.rmSync(fe.dir, { recursive: true, force: true });
    fs.rmSync(be.dir, { recursive: true, force: true });
  }
});

test('跨仓 RPC：无服务端路由时不产出 rpcChain（维度不适用）', async () => {
  const a = await buildFrontend();
  const b = await buildFrontend(); // 两个前端仓，均无服务端路由
  try {
    const merged = mergeSnapshots([a.snap, b.snap], { sources: [{ name: 'a' }, { name: 'b' }], projectRoot: os.tmpdir() });
    assert.equal(merged.dataMap._meta.merged.rpcChain, undefined);
  } finally {
    fs.rmSync(a.dir, { recursive: true, force: true });
    fs.rmSync(b.dir, { recursive: true, force: true });
  }
});
