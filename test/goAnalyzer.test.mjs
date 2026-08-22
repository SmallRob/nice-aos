// Go 解析器测试：goAnalyzer 事实提取（package/import/struct/interface/方法/cobra 命令/gin 路由/调用链）、
// 端到端实体入快照（Class/Interface/Method/Module/archLayer/Route/Dependency）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeGoFile } from '../src/analyzers/goAnalyzer.js';
import { scanProject } from '../src/analyzers/projectScanner.js';
import { buildOntologyData } from '../src/ontology/builder.js';
import { buildViewerModel, renderViewerHtml } from '../src/ontology/viewer.js';

// ---- 单元级：goAnalyzer 事实提取 ----

const MODEL_GO = [
  'package model',
  '',
  'import "time"',
  '',
  '// User 用户实体',
  'type User struct {',
  '    ID        uint      `json:"id"`',
  '    Name      string    `json:"name"`',
  '    Tags      []string',
  '    CreatedAt time.Time `json:"created_at"`',
  '    *Base',
  '}',
  '',
  'func (u *User) DisplayName() string {',
  '    return u.Name',
  '}',
  '',
  'type BaseService interface {',
  '    Find(id uint) (*User, error)',
  '}',
  '',
  'func NewUser(name string) *User {',
  '    u := &User{Name: name}',
  '    return u',
  '}',
].join('\n');

test('goAnalyzer：struct（json tag 字段/匿名内嵌/接收者方法）与 interface', () => {
  const facts = analyzeGoFile('model/user.go', MODEL_GO);
  assert.equal(facts.packageName, 'model');
  assert.equal(facts.language, 'go');
  const user = facts.classes.find((c) => c.name === 'User');
  assert.ok(user, 'User struct 应被提取');
  assert.equal(user.kind, 'struct');
  assert.equal(user.exported, true);
  assert.equal(user.language, 'go');
  assert.deepEqual(user.fields.map((f) => f.name), ['ID', 'Name', 'Tags', 'CreatedAt', 'Base']);
  assert.equal(user.fields[0].tag, 'json:"id"');
  assert.equal(user.fields[2].type, '[]string');
  assert.equal(user.fields[4].name, 'Base'); // 匿名内嵌 *Base → 名取末段
  assert.deepEqual(user.methods.map((m) => m.name), ['DisplayName']);
  const iface = facts.interfaces.find((i) => i.name === 'BaseService');
  assert.ok(iface);
  assert.deepEqual(iface.methods.map((m) => m.name), ['Find']);
  assert.equal(facts.exportNames.includes('User'), true);
  assert.equal(facts.exportNames.includes('NewUser'), true);
  // import：time 整包导入
  assert.equal(facts.importMap.get('time'), 'time');
  // 顶层函数 NewUser → moduleFunctions（含体内调用推断）
  assert.deepEqual(facts.moduleFunctions.map((f) => f.name), ['NewUser']);
});

test('goAnalyzer：调用链提取（pkg 跨包 / local 同包 / method 接收者）', () => {
  const content = [
    'package relay',
    '',
    'import (',
    '    "fmt",',
    '    myctrl "example.com/app/controller"',
    ')',
    '',
    'func Run() error {',
    '    svc := &Service{}',
    '    svc.Start()',
    '    fmt.Println("hi")',
    '    myctrl.Register()',
    '    helper()',
    '    return nil',
    '}',
    '',
    'type Service struct{}',
    '',
    'func (s *Service) Start() {}',
    'func helper() {}',
  ].join('\n');
  const facts = analyzeGoFile('relay/relay.go', content);
  assert.equal(facts.importMap.get('myctrl'), 'example.com/app/controller');
  const edge = facts.callEdges.find((e) => e.from === 'Run');
  assert.ok(edge);
  const kinds = Object.fromEntries(edge.to.map((c) => [c.kind, c]));
  assert.equal(kinds.method.receiverType, 'Service');
  assert.equal(kinds.method.to, 'Start');
  assert.equal(kinds.pkg.toPkg, 'example.com/app/controller');
  assert.equal(kinds.pkg.to, 'Register');
  assert.equal(kinds.local.to, 'helper');
});

test('goAnalyzer：cobra 命令树（Use/Short/flags/AddCommand 边）', () => {
  const content = [
    'package cmd',
    '',
    'import "github.com/spf13/cobra"',
    '',
    'var rootCmd = &cobra.Command{',
    '    Use:   "smartide",',
    '    Short: "Smart IDE assistant",',
    '}',
    '',
    'var newCmd = &cobra.Command{',
    '    Use:   "new [name]",',
    '    Short: "Create a new project",',
    '    Run: func(cmd *cobra.Command, args []string) {}',
    '}',
    '',
    'func init() {',
    '    rootCmd.AddCommand(newCmd)',
    '    newCmd.Flags().StringP("type", "T", "web", "project type")',
    '    newCmd.PersistentFlags().Bool("verbose", false, "verbose output")',
    '}',
  ].join('\n');
  const facts = analyzeGoFile('cmd/root.go', content);
  assert.equal(facts.goCommands.length, 2);
  const root = facts.goCommands.find((c) => c.varName === 'rootCmd');
  assert.equal(root.use, 'smartide');
  assert.equal(root.short, 'Smart IDE assistant');
  const newCmd = facts.goCommands.find((c) => c.varName === 'newCmd');
  assert.equal(newCmd.use, 'new'); // Use 取首词
  assert.deepEqual(newCmd.flags, [
    { name: 'type', shorthand: 'T' },
    { name: 'verbose', shorthand: null },
  ]);
  assert.deepEqual(facts.goCommandEdges, [{ parentVar: 'rootCmd', childVar: 'newCmd' }]);
});

test('goAnalyzer：gin 路由（Group 前缀累积/中间件/handler/动态段/标准库兜底）', () => {
  const content = [
    'package router',
    '',
    'import (',
    '    "github.com/gin-gonic/gin"',
    '    "example.com/app/controller"',
    '    "example.com/app/middleware"',
    ')',
    '',
    'func Setup() *gin.Engine {',
    '    r := gin.New()',
    '    api := r.Group("/api")',
    '    user := api.Group("/user")',
    '    user.Use(middleware.Auth())',
    '    user.GET("/self", controller.GetSelf)',
    '    user.GET("/:id", middleware.RateLimit(), controller.GetUser)',
    '    user.POST("", controller.CreateUser)',
    '    r.Any("/ping", controller.Ping)',
    '    return r',
    '}',
  ].join('\n');
  const facts = analyzeGoFile('router/router.go', content);
  const routes = facts.goRoutes;
  const find = (method, p) => routes.find((r) => r.method === method && r.path === p);
  assert.ok(find('GET', '/api/user/self'), JSON.stringify(routes));
  assert.deepEqual(find('GET', '/api/user/self').handlers, ['controller.GetSelf']);
  assert.deepEqual(find('GET', '/api/user/self').middlewares, ['Auth']); // 组级 Use 继承
  const dyn = find('GET', '/api/user/:id');
  assert.ok(dyn);
  assert.deepEqual(dyn.middlewares, ['Auth', 'RateLimit']); // 组级 + 内联
  assert.deepEqual(dyn.handlers, ['controller.GetUser']);
  assert.ok(find('POST', '/api/user/'));
  assert.ok(find('ANY', '/ping'));
});

test('goAnalyzer：gin-vue-admin 形态（函数参数 router / 链式 Use / handler 链展开 / zap.Any 不误报）', () => {
  const content = [
    'package router',
    '',
    'import (',
    '    "go.uber.org/zap"',
    '    "github.com/gin-gonic/gin"',
    '    v1 "example.com/app/api/v1"',
    '    "example.com/app/middleware"',
    ')',
    '',
    'func InitUserRouter(Router *gin.RouterGroup) {',
    '    baseApi := v1.ApiGroupApp.SystemApiGroup.BaseApi',
    '    userRouter := Router.Group("user")',
    '    userRouter.POST("register", baseApi.Register)',
    '}',
    '',
    'func InitBaseRouter(Router *gin.RouterGroup) {',
    '    PrivateGroup := Router.Group("").Use(middleware.JWTAuth()).Use(middleware.CasbinHandler())',
    '    PrivateGroup.GET("jwt", v1.ApiGroupApp.SystemApiGroup.BaseApi.Jwt)',
    '}',
    '',
    'func LogError(err error) {',
    '    zap.Any("error", err)',
    '}',
  ].join('\n');
  const facts = analyzeGoFile('router/sys_user.go', content);
  const routes = facts.goRoutes;
  // 函数参数 Router 为合法注册接收者；Group("user") 无前导斜杠拼接正确
  const reg = routes.find((r) => r.path === '/user/register');
  assert.ok(reg, JSON.stringify(routes.map((r) => r.path)));
  assert.equal(reg.method, 'POST');
  assert.deepEqual(reg.handlers, ['baseApi.Register']);
  // 字段链变量展开：baseApi → v1.ApiGroupApp.SystemApiGroup.BaseApi.Register
  assert.equal(reg.handlerChain, 'v1.ApiGroupApp.SystemApiGroup.BaseApi.Register');
  // 链式 Use 中间件归组
  const jwt = routes.find((r) => r.path === '/jwt');
  assert.ok(jwt, JSON.stringify(routes.map((r) => r.path)));
  assert.deepEqual(jwt.middlewares, ['JWTAuth', 'CasbinHandler']);
  // zap.Any("error", err) 日志调用不产路由（非 router 变量上的 .Any）
  assert.equal(routes.some((r) => r.path === '/error'), false, JSON.stringify(routes.map((r) => r.path)));
});

test('goAnalyzer：调用链深链 pkgchain（pkg.Var.Chain.Method / baseApi 变量链展开）', () => {
  const content = [
    'package api',
    '',
    'import (',
    '    "example.com/app/service"',
    '    v1 "example.com/app/api/v1"',
    ')',
    '',
    'type BaseApi struct{}',
    '',
    'func (b *BaseApi) Register() {',
    '    service.ServiceGroupApp.SystemServiceGroup.UserService.RegisterUser()',
    '}',
    '',
    'func (b *BaseApi) CallViaVar() {',
    '    baseApi := v1.ApiGroupApp.SystemApiGroup.BaseApi',
    '    baseApi.Reload()',
    '}',
  ].join('\n');
  const facts = analyzeGoFile('api/v1/sys_user.go', content);
  const edges = facts.callEdges;
  const regEdge = edges.find((e) => e.from === 'BaseApi.Register');
  assert.ok(regEdge, JSON.stringify(edges));
  // 深链 pkg.Var.Chain.Method → pkgchain（toPkg = service 包，to = 末段方法名）
  const deep = regEdge.to.find((c) => c.kind === 'pkgchain' && c.to === 'RegisterUser');
  assert.ok(deep, JSON.stringify(regEdge.to));
  assert.equal(deep.toPkg, 'example.com/app/service');
  // 变量链展开：baseApi.Reload → pkgchain 指向 v1 包
  const varEdge = edges.find((e) => e.from === 'BaseApi.CallViaVar');
  assert.ok(varEdge, JSON.stringify(edges));
  const viaVar = varEdge.to.find((c) => c.kind === 'pkgchain' && c.to === 'Reload');
  assert.ok(viaVar, JSON.stringify(varEdge.to));
  assert.equal(viaVar.toPkg, 'example.com/app/api/v1');
});

// ---- 端到端：Go CLI + HTTP 项目入快照 ----

const GO_MOD = [
  'module example.com/app',
  '',
  'go 1.21',
  '',
  'require (',
  '    github.com/spf13/cobra v1.8.0',
  '    github.com/gin-gonic/gin v1.9.1',
  ')',
].join('\n');

const MAIN_GO = [
  'package main',
  '',
  'import "example.com/app/cmd"',
  '',
  'func main() {',
  '    cmd.Execute()',
  '}',
].join('\n');

const ROOT_GO = [
  'package cmd',
  '',
  'import "github.com/spf13/cobra"',
  '',
  'var rootCmd = &cobra.Command{',
  '    Use:   "app",',
  '    Short: "App CLI",',
  '}',
  '',
  'var serveCmd = &cobra.Command{',
  '    Use:   "serve",',
  '    Short: "Start HTTP server",',
  '}',
  '',
  'func Execute() {',
  '    rootCmd.AddCommand(serveCmd)',
  '    rootCmd.Execute()',
  '}',
].join('\n');

const NEW_GO = [
  'package cmd',
  '',
  'import (',
  '    "github.com/spf13/cobra"',
  '    "example.com/app/service"',
  ')',
  '',
  'var newCmd = &cobra.Command{',
  '    Use:   "new [name]",',
  '    Short: "Create project",',
  '    Run: func(cmd *cobra.Command, args []string) {',
  '        service.CreateProject()',
  '    },',
  '}',
  '',
  'func init() {',
  '    rootCmd.AddCommand(newCmd)',
  '    newCmd.Flags().StringP("type", "T", "web", "project type")',
  '}',
].join('\n');

const ROUTER_GO = [
  'package router',
  '',
  'import (',
  '    "github.com/gin-gonic/gin"',
  '    "example.com/app/controller"',
  '    "example.com/app/middleware"',
  ')',
  '',
  'func Setup() *gin.Engine {',
  '    r := gin.New()',
  '    api := r.Group("/api")',
  '    api.Use(middleware.Auth())',
  '    user := api.Group("/user")',
  '    user.GET("/self", controller.GetSelf)',
  '    user.GET("/:id", controller.GetUser)',
  '    return r',
  '}',
].join('\n');

const CONTROLLER_GO = [
  'package controller',
  '',
  'import "example.com/app/service"',
  '',
  'func GetSelf() {',
  '    service.LoadUser(0)',
  '}',
  '',
  'func GetUser() {}',
].join('\n');

const SERVICE_GO = [
  'package service',
  '',
  'type Project struct {',
  '    Name string `json:"name"`',
  '}',
  '',
  'func CreateProject() {',
  '    p := &Project{}',
  '    p.validate()',
  '}',
  '',
  'func (p *Project) validate() {}',
  '',
  'func LoadUser(id int) {}',
].join('\n');

async function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-go-'));
  fs.mkdirSync(path.join(dir, 'cmd'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'router'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'controller'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'service'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'go.mod'), GO_MOD);
  fs.writeFileSync(path.join(dir, 'main.go'), MAIN_GO);
  fs.writeFileSync(path.join(dir, 'cmd/root.go'), ROOT_GO);
  fs.writeFileSync(path.join(dir, 'cmd/new.go'), NEW_GO);
  fs.writeFileSync(path.join(dir, 'router/router.go'), ROUTER_GO);
  fs.writeFileSync(path.join(dir, 'controller/controller.go'), CONTROLLER_GO);
  fs.writeFileSync(path.join(dir, 'service/service.go'), SERVICE_GO);
  const dataMap = await buildOntologyData(dir);
  return { dir, dataMap };
}

test('扫描：go.mod 检测 + go 依赖 + vendor 跳过', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-goscan-'));
  fs.mkdirSync(path.join(dir, 'vendor/github.com'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'testdata'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/app\n\ngo 1.21\n');
  fs.writeFileSync(path.join(dir, 'main.go'), 'package main\n\nfunc main() {}\n');
  fs.writeFileSync(path.join(dir, 'vendor/github.com/x.go'), 'package github\n');
  fs.writeFileSync(path.join(dir, 'testdata/fixture.go'), 'package testdata\n');
  const scan = scanProject(dir);
  assert.deepEqual(scan.files, ['main.go']);
  assert.equal(scan.framework, 'go');
  assert.equal(scan.goFileCount, 1);
  assert.equal(scan.goDetected, true);
  assert.equal(scan.goModule.name, 'example.com/app');
});

test('端到端：Go 实体入快照（Class/Method/Module/archLayer/依赖）', async () => {
  const { dataMap } = await buildFixture();
  const project = dataMap.Class.find((c) => c.name === 'Project');
  assert.ok(project, 'Project struct 应入快照');
  assert.equal(project.kind, 'struct');
  assert.equal(project.language, 'go');
  assert.deepEqual(project.fields.map((f) => f.name), ['Name']);
  // service/ 目录归业务层，cmd/ 归入口层
  assert.equal(project.archLayer, 'service');
  const validate = dataMap.Method.find((m) => m.name === 'validate');
  assert.ok(validate, '接收者方法 validate 应入快照');
  const createProject = dataMap.Method.find((m) => m.name === 'CreateProject' && m.ownerKind === 'module');
  assert.ok(createProject);
  assert.ok(createProject.callIds.includes(validate.id), 'CreateProject → validate 方法调用边');
  // cmd/new.go 的 service.CreateProject() 跨包调用链
  const newCmdRun = dataMap.Method.find((m) => m.name === 'CreateProject');
  assert.ok(newCmdRun.calledByIds?.length > 0 || newCmdRun.callIds.includes(validate.id));
  // go.mod require → Dependency（source=go）
  const gin = dataMap.Dependency.find((d) => d.name === 'github.com/gin-gonic/gin');
  assert.ok(gin, 'gin 依赖应入快照');
  assert.equal(gin.source, 'go');
  assert.ok(dataMap.Dependency.find((d) => d.name === 'github.com/spf13/cobra'));
});

test('端到端：cobra 命令树 → Route（go-cli 命令链 + flags）', async () => {
  const { dataMap } = await buildFixture();
  const cliRoutes = dataMap.Route.filter((r) => r.routeType === 'go-cli');
  const paths = cliRoutes.map((r) => r.routePath).sort();
  assert.deepEqual(paths, ['app', 'app new', 'app serve']);
  const newRoute = cliRoutes.find((r) => r.routePath === 'app new');
  assert.equal(newRoute.description, 'Create project');
  assert.deepEqual(newRoute.specialFiles, ['-T/--type']);
  assert.equal(newRoute.domain, 'cli');
});

test('端到端：gin 路由 → Route（go + handler Method 关联 + 中间件）', async () => {
  const { dataMap } = await buildFixture();
  const goRoutes = dataMap.Route.filter((r) => r.routeType === 'go');
  const find = (p) => goRoutes.find((r) => r.routePath === p);
  const self = find('/api/user/self');
  assert.ok(self, '/api/user/self 应入快照');
  assert.deepEqual(self.apiMethods, ['GET']);
  assert.deepEqual(self.middlewares, ['Auth']);
  assert.equal(self.componentRef, 'controller.GetSelf');
  // handler 关联：controller 包目录 → GetSelf 顶层函数 Method
  const handler = dataMap.Method.find((m) => m.id === self.componentId);
  assert.ok(handler, 'handler 应关联 controller.GetSelf Method');
  assert.equal(handler.ownerKind, 'module');
  const dyn = find('/api/user/:id');
  assert.equal(dyn.isDynamic, true);
  assert.equal(dyn.domain, 'user');
  // GetSelf → service.LoadUser 跨包调用链
  const loadUser = dataMap.Method.find((m) => m.name === 'LoadUser');
  assert.ok(loadUser.calledByIds.includes(handler.id), 'GetSelf → LoadUser 跨包调用边');
});

test('端到端：Go 项目无 tsx/vue 时 props 链为空（不影响既有管线）', async () => {
  const { dataMap } = await buildFixture();
  assert.equal((dataMap.PropEdge ?? []).length, 0);
  assert.equal((dataMap.Component ?? []).length, 0);
  assert.equal((dataMap._meta.analysisErrors ?? []).length || (dataMap.Project[0].analysisErrors ?? []).length, 0);
});

test('端到端：viewer 实体类图 Go 配色（节点描边/分布条/图例 gopher 蓝，修复回退 TS/JS 蓝）', async () => {
  const { dataMap } = await buildFixture();
  const model = buildViewerModel(dataMap);
  assert.ok(model.entities, 'Go fixture 应产出 entities 视图模型');
  assert.ok(model.entities.byLanguage.some((l) => l.key === 'go' && l.label === 'Go'));
  const html = renderViewerHtml(model);
  // CSS 契约：--go 变量与 .bar.go 类缺一则 Go 分布条回退 TS/JS 蓝
  assert.match(html, /--go:\s*#00add8/, 'CSS 应定义 --go gopher 蓝');
  assert.match(html, /\.bar\.go\s*\{\s*background:\s*var\(--go\)/, '语言分布条应有 .bar.go 类');

  const dataJson = html.match(/<script id="viewer-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  const script = html.match(/<script>\n([\s\S]*?)<\/script>\s*<\/body>/)[1];
  const elements = new Map();
  const makeEl = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        innerHTML: '', textContent: id === 'viewer-data' ? dataJson : '', dataset: {}, style: {}, value: '', addEventListener() {},
        classList: { add() {}, remove() {} },
        querySelectorAll: () => [], querySelector: () => null,
      });
    }
    return elements.get(id);
  };
  const prevDocument = globalThis.document;
  globalThis.document = {
    getElementById: makeEl, querySelectorAll: () => [], querySelector: () => makeEl('generic'),
  };
  try {
    new Function(script)();
  } finally {
    globalThis.document = prevDocument;
  }

  const view = makeEl('view-entities').innerHTML;
  assert.ok(view.includes('class="bar go"'), 'Go 语言分布条应使用 .bar.go 配色');
  // 图例数据驱动：Go 显示 gopher 蓝；项目内不存在的语言不再硬编码出现
  assert.ok(view.includes('background:#00add8"></span>Go'), '图例应含 Go gopher 蓝圆点');
  assert.ok(!view.includes('background:#3fb950"></span>Vue'), 'Go-only fixture 图例不应出现 Vue');
  assert.ok(!view.includes('background:#d29922"></span>Rust'), 'Go-only fixture 图例不应出现 Rust');
  // UML 类图：Go struct 类框描边为 gopher 蓝（修复前回退 TS/JS 蓝 #58a6ff）
  const graph = makeEl('entity-graph').innerHTML;
  assert.ok(graph.includes('stroke="#00add8"'), 'Go 类框描边应为 gopher 蓝');
  assert.ok(!graph.includes('stroke="#58a6ff"'), 'Go-only 类图不应出现 TS/JS 蓝描边');
});
