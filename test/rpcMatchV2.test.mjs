// v0.47 RPC 匹配增强测试（借鉴 asdm-aos endpointSignature/matchEngine）：
//   1. 占位符归一：%s（iDRAC printf 形态）/ {param} / [id] / [...slug] / ${模板} 双侧统一
//   2. 环境变量模板前缀剥离（${API_BASE_URL}/users → /users，前缀差异交给人工规则）
//   3. next-api 纳入服务端候选池（7e 前移后 Next route.ts 可被前端 httpCall / Python 端点命中）
//   4. tier 回执：apiMatch.tier / frontendCalls[].tier（命中阶梯 1-4 可审计）
//   5. php 经 api-routes.json serverRouteTypes 显式开启
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOntologyData } from '../src/ontology/builder.js';
import { apiPathSegments, matchApiRouteEx } from '../src/ontology/rpcMatch.js';
import { loadApiRouteRules } from '../src/ontology/apiRouteRules.js';

function makeProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-rpcv2-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// ---- 单元：apiPathSegments 占位符归一 ----

test('v0.47 归一：%s printf 占位段 ↔ :id 参数段同形', () => {
  assert.deepEqual(apiPathSegments('/api/redfish/v1/Systems/%s'), ['api', 'redfish', 'v1', 'Systems', ':param']);
  // :id / {id} 保持原段名（匹配忽略参数名，isParamSeg 泛化）；%s / %1$s 无名 → 规范形 :param
  assert.deepEqual(apiPathSegments('/api/redfish/v1/Systems/:id'), ['api', 'redfish', 'v1', 'Systems', ':id']);
  assert.deepEqual(apiPathSegments('/api/redfish/v1/Systems/%1$s'), ['api', 'redfish', 'v1', 'Systems', ':param']);
});

test('v0.47 归一：{param} / [id] / [...slug] / <id> / 模板表达式统一', () => {
  assert.deepEqual(apiPathSegments('/api/users/{user_id}'), ['api', 'users', ':param']);
  assert.deepEqual(apiPathSegments('/docs/[...slug]'), ['docs', '*all']);
  assert.deepEqual(apiPathSegments('/docs/[[...slug]]'), ['docs', '*all']);
  assert.deepEqual(apiPathSegments('/api/<id>/detail'), ['api', ':param', 'detail']);
  // 段内模板表达式坍缩为占位段（`${encodeURIComponent(x)}` 整段 / `${x}` 段内混排）
  assert.deepEqual(apiPathSegments('/api/${encodeURIComponent(uid)}'), ['api', ':param']);
  assert.deepEqual(apiPathSegments('/api/${x}/users'), ['api', ':param', 'users']);
  // query / hash 剥离
  assert.deepEqual(apiPathSegments('/api/users?limit=10#x'), ['api', 'users']);
});

test('v0.47 归一：全大写环境变量模板前缀剥离，纯变量名仍不参与匹配', () => {
  assert.deepEqual(apiPathSegments('${API_BASE_URL}/v1/users'), ['v1', 'users']);
  assert.deepEqual(apiPathSegments('BASE_URL/v1/users'), null);
  // 非全大写（如 camelCase 变量）不视为环境变量：模板串带头时保持占位段语义
  assert.deepEqual(apiPathSegments('${baseUrl}/v1/users'), [':param', 'v1', 'users']);
});

test('v0.47 单元：尾段 :slug*（Next catch-all）可吞掉请求剩余段', () => {
  const routes = [{ r: { id: 'r1' }, segs: ['docs', ':slug*'] }];
  const hit = matchApiRouteEx(['docs', 'a', 'b', 'c'], routes, {});
  assert.equal(hit.route.id, 'r1');
  assert.equal(hit.tier, 4);
  // 前缀不一致不吞
  assert.equal(matchApiRouteEx(['api', 'a'], routes, {}), null);
});

// ---- 集成：iDRAC %s 场景（Python 客户端 ↔ Go gin 路由）----

const GO_MOD = ['module example.com/oneapi', '', 'go 1.21', '', 'require github.com/gin-gonic/gin v1.9.1'].join('\n');
const IDRAC_MAIN_GO = [
  'package main',
  '',
  'import (',
  '    "github.com/gin-gonic/gin"',
  '    "example.com/oneapi/controller"',
  ')',
  '',
  'func main() {',
  '    r := gin.New()',
  '    v1 := r.Group("/api/redfish/v1")',
  '    v1.GET("/Systems/:id", controller.GetSystem)',
  '    v1.GET("/Systems", controller.ListSystems)',
  '    r.Run()',
  '}',
].join('\n');

test('v0.47 集成：%s 占位 URL 命中 Go :id 路由（iDRAC 场景）', async () => {
  const dir = makeProject({
    'go.mod': GO_MOD,
    'main.go': IDRAC_MAIN_GO,
    'controller.go': 'package controller\n\nfunc GetSystem() {}\nfunc ListSystems() {}',
    'client.py': [
      'import urllib.request',
      '',
      'def get_system(base, sys_id):',
      '    urllib.request.urlopen(base + "/api/redfish/v1/Systems/%s" % sys_id)',
      '',
      'def list_systems(base):',
      '    urllib.request.urlopen(base + "/api/redfish/v1/Systems")',
    ].join('\n'),
  });
  const dm = await buildOntologyData(dir);
  const nets = dm.NetworkEndpoint ?? [];
  const withPlaceholder = nets.find((n) => n.url.includes('%s'));
  assert.ok(withPlaceholder, `应捕获 %s 端点，实际 ${JSON.stringify(nets.map((n) => n.url))}`);
  assert.ok(withPlaceholder.serverRouteId, `%s 端点应命中 :id 路由，实际 ${withPlaceholder.serverRouteId}`);
  assert.ok(withPlaceholder.serverRoutePath.includes(':id'));
  // 占位命中走通配阶梯（3/4），非字面量阶梯
  assert.ok([3, 4].includes(withPlaceholder.apiMatch.tier), JSON.stringify(withPlaceholder.apiMatch));
  // 无占位端点仍走字面量 + method 阶梯（tier 1）
  const literal = nets.find((n) => n.url.endsWith('/Systems') && !n.url.includes('%s'));
  assert.equal(literal.apiMatch.tier, 1);
});

// ---- 集成：next-api 纳入候选池 ----

test('v0.47 集成：前端 fetch 命中 next-api 路由（含动态段）', async () => {
  const dir = makeProject({
    'package.json': JSON.stringify({ name: 'next-rpc', dependencies: { next: '^16.0.0', react: '^19.0.0' } }),
    'app/layout.tsx': 'export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html> }',
    'app/users/page.tsx': [
      "'use client';",
      'export default function UsersPage() {',
      '  fetch("/api/users/5", { method: "GET" });',
      '  fetch("/api/users", { method: "POST" });',
      '  fetch("/api/unknown");',
      '  return <div />;',
      '}',
    ].join('\n'),
    'app/api/users/route.ts': 'export async function POST(request: Request) { return Response.json({}) }',
    'app/api/users/[id]/route.ts': 'export async function GET(request: Request) { return Response.json({}) }',
  });
  const dm = await buildOntologyData(dir);
  const byPath = new Map((dm.Route ?? []).map((r) => [r.routePath, r]));
  assert.ok(byPath.has('/api/users'), 'next-api 静态路由');
  assert.ok(byPath.has('/api/users/:id'), `next-api 动态路由，实际 ${[...byPath.keys()].join(',')}`);

  const dyn = byPath.get('/api/users/:id');
  assert.equal(dyn.routeType, 'next-api');
  assert.ok(Array.isArray(dyn.frontendCalls) && dyn.frontendCalls.length === 1, JSON.stringify(dyn.frontendCalls));
  assert.equal(dyn.frontendCalls[0].tier, 3, '字面量 5 vs :id → 通配+method 阶梯');

  const stat = byPath.get('/api/users');
  assert.equal(stat.routeType, 'next-api');
  assert.ok(stat.frontendCalls?.length === 1, 'POST /api/users 字面量命中');
  assert.equal(stat.frontendCalls[0].tier, 1, '字面量+method 阶梯');
  assert.equal(dm._meta.resolutionStats.matchedRouteCount, 2);
  assert.equal(dm._meta.resolutionStats.unmatchedFrontendCallsCount, 1);
});

// ---- 集成：tier 回执进 rpcChain 统计 ----

test('v0.47 集成：rpcChain.tierCounts 归因统计', async () => {
  const dir = makeProject({
    'server.py': [
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
    ].join('\n'),
    'client.py': [
      'import requests',
      '',
      'def fetch_user(uid):',
      '    requests.get("http://localhost:8000/api/users/{uid}")',
      '',
      'def create():',
      '    requests.post("http://localhost:8000/api/users", json={})',
    ].join('\n'),
  });
  const dm = await buildOntologyData(dir);
  const st = dm._meta.rpcChain;
  assert.equal(st.tierCounts[1], 1, 'POST 字面量+method');
  assert.equal(st.tierCounts[3], 1, 'GET {uid} 通配+method');
  const nets = dm.NetworkEndpoint ?? [];
  assert.equal(nets.find((n) => n.methods[0] === 'POST').apiMatch.tier, 1);
  assert.equal(nets.find((n) => n.methods[0] === 'GET').apiMatch.tier, 3);
});

// ---- 集成：php 显式开启 ----

function makePhpProject(rulesFile) {
  const files = {
    'module/user/control.php': [
      '<?php',
      'class user extends control',
      '{',
      '    public function login()',
      '    {',
      '        $this->display();',
      '    }',
      '}',
    ].join('\n'),
    'client.py': [
      'import requests',
      '',
      'def login():',
      '    requests.get("http://host/user-login")',
    ].join('\n'),
  };
  if (rulesFile) files[path.join('.nice-aos', 'api-routes.json')] = JSON.stringify(rulesFile);
  return makeProject(files);
}

test('v0.47 集成：php 默认排除，serverRouteTypes 显式开启后可命中', async () => {
  // 默认：php 不在候选池 → 不建链
  const off = await buildOntologyData(makePhpProject(null));
  const offEp = (off.NetworkEndpoint ?? [])[0];
  assert.ok(offEp, '端点应存在');
  assert.equal(offEp.serverRouteId, undefined, 'php 默认排除不建链');
  assert.ok((off.Route ?? []).some((r) => r.routeType === 'php' && r.routePath === '/user-login'), 'php 路由本身仍提取');

  // 显式开启：命中
  const on = await buildOntologyData(makePhpProject({ serverRouteTypes: ['php'] }));
  const onEp = (on.NetworkEndpoint ?? [])[0];
  assert.equal(onEp.serverRouteId, 'route:/user-login');
  assert.equal(onEp.apiMatch.tier, 1);
  assert.equal(on._meta.rpcChain.serverRouteCount, 1);
});

test('v0.47 规则：serverRouteTypes 非法值记 warning 不阻断', () => {
  const dir = makeProject({ [path.join('.nice-aos', 'api-routes.json')]: JSON.stringify({ serverRouteTypes: ['java', 'php'] }) });
  const { rules, warnings, extraServerRouteTypes } = loadApiRouteRules(dir);
  assert.deepEqual(extraServerRouteTypes, ['php']);
  assert.ok(rules.length === 0);
  assert.ok(warnings.some((w) => w.includes('java')), warnings.join(';'));
});
