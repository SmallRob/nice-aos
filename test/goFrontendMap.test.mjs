// 前后端逻辑映射测试：tsAnalyzer httpCalls 提取（API.x / axios.x / fetch / 模板串）、
// Go 路由路径匹配（:param 通配 / 尾斜杠归一 / 未匹配清单）、viewer 路由地图视图模型
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeFile } from '../src/analyzers/tsAnalyzer.js';
import { buildOntologyData } from '../src/ontology/builder.js';
import { buildViewerModel } from '../src/ontology/viewer.js';

// ---- 单元级：tsAnalyzer httpCalls 提取 ----

test('tsAnalyzer：httpCalls 提取（API.x / axios.x / fetch / 模板串 / method 选项）', () => {
  const content = [
    "import API from '../helpers/api';",
    "import axios from 'axios';",
    '',
    'export async function loadUser(id) {',
    "  const res = await API.get(`/api/user/${id}`);",
    "  const self = await API.get('/api/user/self');",
    "  await API.post('/api/user/', { name: 'x' });",
    "  await API.put('/api/user/self', inputs);",
    "  const g = await axios.get('/api/group/');",
    "  const r = await fetch('/api/status', { method: 'POST' });",
    "  const plain = await fetch('/api/plain');",
    "  params.get('q');",
    "  localHelper('/not-http');",
    '}',
  ].join('\n');
  const facts = analyzeFile('src/pages/User.js', content, process.cwd());
  const calls = facts.httpCalls;
  const find = (m, p) => calls.find((c) => c.method === m && c.path === p);
  assert.ok(find('GET', '/api/user/${id}'), JSON.stringify(calls));
  assert.ok(find('GET', '/api/user/self'));
  assert.ok(find('POST', '/api/user/'));
  assert.ok(find('PUT', '/api/user/self'));
  assert.ok(find('GET', '/api/group/'));
  assert.ok(find('POST', '/api/status')); // fetch + method 选项
  assert.ok(find('GET', '/api/plain')); // fetch 默认 GET
  // 非路径参数调用不采集
  assert.equal(calls.some((c) => c.path === 'q'), false);
  assert.equal(calls.some((c) => c.path === '/not-http'), false);
  // 行号正确性（模板串在第 5 行）
  assert.equal(find('GET', '/api/user/${id}').line, 5);
});

// ---- 端到端：Go 后端 + React 前端融合项目 ----

const GO_MOD = [
  'module example.com/oneapi',
  '',
  'go 1.21',
  '',
  'require github.com/gin-gonic/gin v1.9.1',
].join('\n');

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
  '    group := api.Group("/group")',
  '    group.GET("/", controller.ListGroups)',
  '    r.Run()',
  '}',
].join('\n');

const CONTROLLER_GO = [
  'package controller',
  '',
  'func GetSelf() {}',
  'func GetUser() {}',
  'func ListGroups() {}',
].join('\n');

const USER_JS = [
  "import API from '../helpers/api';",
  '',
  'export async function loadUser(id) {',
  "  const res = await API.get(`/api/user/${id}`);",
  "  const self = await API.get('/api/user/self');",
  "  await API.post('/api/user/', { name: 'x' });",
  "  const ghost = await API.get('/api/missing/endpoint');",
  '}',
].join('\n');

const GROUP_JS = [
  "import API from '../helpers/api';",
  '',
  'export async function loadGroups() {',
  "  return API.get('/api/group');",
  '}',
].join('\n');

async function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-gofe-'));
  fs.mkdirSync(path.join(dir, 'controller'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'web/src/pages'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'go.mod'), GO_MOD);
  fs.writeFileSync(path.join(dir, 'main.go'), MAIN_GO);
  fs.writeFileSync(path.join(dir, 'controller/controller.go'), CONTROLLER_GO);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'oneapi-demo',
    dependencies: { react: '^18.0.0' },
  }));
  fs.writeFileSync(path.join(dir, 'web/src/pages/User.js'), USER_JS);
  fs.writeFileSync(path.join(dir, 'web/src/pages/Group.js'), GROUP_JS);
  const dataMap = await buildOntologyData(dir);
  return { dir, dataMap };
}

test('端到端：前端调用匹配 Go 路由（:param 通配 / 尾斜杠归一 / 未匹配清单）', async () => {
  const { dataMap } = await buildFixture();
  const goRoutes = dataMap.Route.filter((r) => r.routeType === 'go');
  const find = (p) => goRoutes.find((r) => r.routePath === p);
  const self = find('/api/user/self');
  assert.ok(self);
  // '/api/user/self' 直配 + 尾斜杠变体 '/api/group/' ↔ '/api/group' 归一匹配
  assert.equal(self.frontendCalls.length, 1);
  assert.equal(self.frontendCalls[0].filePath, 'web/src/pages/User.js');
  assert.equal(self.frontendCalls[0].method, 'GET');
  // 模板串 `/api/user/${id}` 匹配动态路由 '/api/user/:id'
  const dyn = find('/api/user/:id');
  assert.equal(dyn.frontendCalls.length, 1);
  // 前端 '/api/user/' 匹配不到任何路由 → 进未匹配清单（后端无空路径注册）
  const groups = find('/api/group/');
  assert.equal(groups.frontendCalls.length, 1); // '/api/group' 去尾斜杠匹配
  const unmatched = dataMap._meta.unmatchedFrontendCalls;
  assert.ok(unmatched.some((c) => c.path === '/api/missing/endpoint' && c.filePath === 'web/src/pages/User.js'));
  assert.equal(unmatched.some((c) => c.path === '/api/user/'), true);
  // POST /api/user/ 未匹配（后端只注册了 GET）
  assert.equal(unmatched.some((c) => c.method === 'POST' && c.path === '/api/user/'), true);
});

test('端到端：viewer 路由地图视图模型（前端调用指标 / go 类型分布 / 命令树字段）', async () => {
  const { dataMap } = await buildFixture();
  const model = buildViewerModel(dataMap);
  const rm = model.routeMap;
  assert.ok(rm, '路由地图应存在');
  assert.equal(rm.goApiRouteCount, 3);
  assert.equal(rm.frontendCallTotal, 3); // self + 模板串动态 + group（POST /api/user/ 无后端承接）
  assert.ok(rm.unmatchedFrontendCalls.length >= 2);
  const byType = Object.fromEntries(rm.byType.map((t) => [t.key, t.count]));
  assert.equal(byType.go, 3);
  const self = rm.items.find((it) => it.path === '/api/user/self');
  assert.equal(self.frontendCallCount, 1);
  assert.equal(self.frontendCalls[0].filePath, 'web/src/pages/User.js');
  assert.deepEqual(self.middlewares, []);
  assert.equal(self.componentRef, 'controller.GetSelf');
  // 路径层级树含业务段
  const segNames = [];
  const walkTree = (n) => { segNames.push(n.seg); n.children.forEach(walkTree); };
  walkTree(rm.tree);
  assert.ok(segNames.includes('user'));
  assert.ok(segNames.includes('group'));
});

// ---- 端到端：gin-vue-admin 融合仓库（子目录 go.mod / zap.Any 误报 / handler 链 / axios 配置对象 / 深链调用） ----

const GVA_GO_MOD = [
  'module smartide-server',
  '',
  'go 1.18',
  '',
  'require (',
  '    github.com/gin-gonic/gin v1.6.3',
  '    go.uber.org/zap v1.24.0',
  ')',
].join('\n');

const GVA_MAIN_GO = [
  'package main',
  '',
  'import "github.com/gin-gonic/gin"',
  '',
  'func main() {',
  '    Router := gin.Default()',
  '    Router.Use(middleware())',
  '    Router.Run("")',
  '}',
].join('\n');

const GVA_ROUTER_GO = [
  'package router',
  '',
  'import (',
  '    "go.uber.org/zap"',
  '    "github.com/gin-gonic/gin"',
  '    v1 "smartide-server/api/v1"',
  '    "smartide-server/middleware"',
  ')',
  '',
  'func InitUserRouter(Router *gin.RouterGroup) {',
  '    baseApi := v1.ApiGroupApp.SystemApiGroup.BaseApi',
  '    userRouter := Router.Group("user")',
  '    userRouter.POST("register", baseApi.Register)',
  '}',
  '',
  'func InitBaseRouter(Router *gin.RouterGroup) {',
  '    PrivateGroup := Router.Group("").Use(middleware.JWTAuth())',
  '    PrivateGroup.GET("jwt", v1.ApiGroupApp.SystemApiGroup.BaseApi.Jwt)',
  '}',
  '',
  'func LogError(err error) {',
  '    zap.Any("error", err)',
  '}',
].join('\n');

const GVA_API_GO = [
  'package system',
  '',
  'import "smartide-server/service"',
  '',
  'type BaseApi struct{}',
  '',
  'func (b *BaseApi) Register() {',
  '    service.ServiceGroupApp.SystemServiceGroup.UserService.RegisterUser()',
  '}',
  '',
  'func (b *BaseApi) Jwt() {}',
].join('\n');

const GVA_SERVICE_GO = [
  'package system',
  '',
  'type UserService struct{}',
  '',
  'func (userService *UserService) RegisterUser() {}',
].join('\n');

const GVA_USER_JS = [
  "import service from '@/utils/request'",
  '',
  'export const register = (data) => service({',
  "    url: '/user/register',",
  "    method: 'post',",
  '    data,',
  '})',
  '',
  'export const getJwt = () => service({ url: "/jwt" })',
].join('\n');

async function buildGvaFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-gva-'));
  fs.mkdirSync(path.join(dir, 'server/api/v1/system'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'server/service/system'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'server/router'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'web/src/api'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server/go.mod'), GVA_GO_MOD);
  fs.writeFileSync(path.join(dir, 'server/main.go'), GVA_MAIN_GO);
  fs.writeFileSync(path.join(dir, 'server/router/router.go'), GVA_ROUTER_GO);
  fs.writeFileSync(path.join(dir, 'server/api/v1/system/sys_user.go'), GVA_API_GO);
  fs.writeFileSync(path.join(dir, 'server/service/system/sys_user.go'), GVA_SERVICE_GO);
  fs.writeFileSync(path.join(dir, 'web/package.json'), JSON.stringify({
    name: 'smartide-web',
    dependencies: { vue: '^3.2.0', 'element-plus': '^2.3.0', pinia: '^2.0.0' },
  }));
  fs.writeFileSync(path.join(dir, 'web/src/api/user.js'), GVA_USER_JS);
  const dataMap = await buildOntologyData(dir, { roots: ['server', 'web/src'] });
  return { dir, dataMap };
}

// ---- 端到端：用户定位 Go module 子目录（go.mod 在上级，import 路径折叠解析） ----

const SUB_ROUTER_GO = [
  'package v1',
  '',
  'import (',
  '    "github.com/gin-gonic/gin"',
  '    "smartide-server/api/v1/system"',
  ')',
  '',
  'func InitRouter(Router *gin.RouterGroup) {',
  '    Router.POST("register", system.Register)',
  '}',
  '',
  'func Setup() {',
  '    system.Register()',
  '}',
].join('\n');

const SUB_SYS_USER_GO = [
  'package system',
  '',
  'func Register() {}',
].join('\n');

test('端到端：定位 Go module 子目录（上级 go.mod 折叠 → handler 解析 / 跨包调用链 / import internal）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-gosub-'));
  fs.mkdirSync(path.join(dir, 'server/api/v1/system'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server/go.mod'), 'module smartide-server\n\ngo 1.18\n');
  fs.writeFileSync(path.join(dir, 'server/api/v1/router.go'), SUB_ROUTER_GO);
  fs.writeFileSync(path.join(dir, 'server/api/v1/system/sys_user.go'), SUB_SYS_USER_GO);
  // 用户定位 server/api（go.mod 在上级 server/）
  const dataMap = await buildOntologyData(path.join(dir, 'server', 'api'));
  const proj = dataMap.Project[0];
  assert.equal(proj.framework, 'go', JSON.stringify(proj.framework));
  assert.equal(proj.goModule.dir, '..');
  // 路由 handler：system.Register → import 解析（module 基准 '..' 折叠到扫描根内 v1/system）
  const reg = dataMap.Route.find((r) => r.routeType === 'go' && r.routePath === '/register');
  assert.ok(reg, JSON.stringify(dataMap.Route.map((r) => r.routePath)));
  assert.ok(reg.componentId, 'handler 应解析到 Method');
  const handler = dataMap.Method.find((m) => m.id === reg.componentId);
  assert.equal(handler.name, 'Register');
  assert.equal(handler.filePath, 'v1/system/sys_user.go');
  // 跨包调用链：Setup → system.Register（pkg 边经 import 折叠解析到扫描根内文件）
  const setup = dataMap.Method.find((m) => m.name === 'Setup' && m.filePath === 'v1/router.go');
  assert.ok(setup.callIds.includes(handler.id), JSON.stringify(setup.callIds));
  // import 边：router.go → sys_user.go（module 前缀命中，'..' 折叠到扫描根内相对路径）
  const routerFile = dataMap.SourceFile.find((f) => f.id === 'file:v1/router.go');
  assert.ok(routerFile.importIds.includes('file:v1/system/sys_user.go'), JSON.stringify(routerFile.importIds));
});

test('端到端：gin-vue-admin 融合仓库（子目录 go.mod 识别 / handler 链解析 / 前端 service 配置对象 / 深链调用链）', async () => {
  const { dataMap } = await buildGvaFixture();
  const proj = dataMap.Project[0];
  // #1 子目录 server/go.mod → framework=go + go 依赖并入 + goModule.dir
  assert.equal(proj.framework, 'go', JSON.stringify(proj.framework));
  const goDeps = dataMap.Dependency.filter((d) => d.source === 'go');
  assert.ok(goDeps.some((d) => d.name === 'github.com/gin-gonic/gin'));
  // npm 子项目依赖并入（vue/element-plus 来自 web/package.json）
  assert.ok(dataMap.Dependency.some((d) => d.name === 'vue' && d.source === 'npm'));
  assert.ok(dataMap.Dependency.some((d) => d.name === 'element-plus'));
  // 根识别：subProjects 报告（server=go、web=npm）
  assert.ok(proj.subProjects?.some((s) => s.path === 'server' && s.kind === 'go'), JSON.stringify(proj.subProjects));
  assert.ok(proj.subProjects?.some((s) => s.path === 'web' && s.kind === 'npm'));

  const goRoutes = dataMap.Route.filter((r) => r.routeType === 'go');
  const paths = goRoutes.map((r) => r.routePath);
  // #2 zap.Any("error") 不产 /error 路由
  assert.equal(paths.includes('/error'), false, JSON.stringify(paths));
  // 函数参数 router + 无前导斜杠 Group
  const reg = goRoutes.find((r) => r.routePath === '/user/register');
  assert.ok(reg, JSON.stringify(paths));
  assert.deepEqual(reg.apiMethods, ['POST']);
  assert.deepEqual(reg.middlewares, []);
  // #3 handler 链解析：baseApi.Register → server/api/v1/system 的 Register 方法
  assert.ok(reg.componentId, 'handler 应解析到 Method');
  const regMethod = dataMap.Method.find((m) => m.id === reg.componentId);
  assert.equal(regMethod.name, 'Register');
  assert.equal(regMethod.filePath, 'server/api/v1/system/sys_user.go');
  assert.equal(reg.componentFileId, 'file:server/api/v1/system/sys_user.go');
  // 链式 Use 中间件
  const jwt = goRoutes.find((r) => r.routePath === '/jwt');
  assert.ok(jwt, JSON.stringify(paths));
  assert.deepEqual(jwt.middlewares, ['JWTAuth']);
  // #4 前端 service({url, method}) 配置对象形态匹配
  assert.equal(jwt.frontendCalls?.length ?? 0, 1, JSON.stringify(jwt.frontendCalls));
  assert.equal(jwt.frontendCalls[0].filePath, 'web/src/api/user.js');
  assert.equal(jwt.frontendCalls[0].method, 'GET');
  assert.equal(reg.frontendCalls?.length ?? 0, 1);
  assert.equal(reg.frontendCalls[0].method, 'POST');
  // #5 深链调用链：Register → UserService.RegisterUser（ApiGroupApp 深链 pkgchain）
  const registerMethod = dataMap.Method.find((m) => m.name === 'Register' && m.filePath === 'server/api/v1/system/sys_user.go');
  const target = dataMap.Method.find((m) => m.name === 'RegisterUser');
  assert.ok(target, 'RegisterUser 应实体化');
  assert.ok(registerMethod.callIds.includes(target.id), JSON.stringify(registerMethod.callIds));
});
