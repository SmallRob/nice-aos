// React JSX 声明式路由测试：react-router v6/v7 <Routes>/<Route path element> 模式
// 样例模式取自 asdm-admin-web 的 src/AppRoutes.tsx
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOntologyData } from '../src/ontology/builder.js';
import { analyzeFile } from '../src/analyzers/tsAnalyzer.js';

const ROOT = process.cwd();

function makeProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nice-aos-react-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// 构造 asdm-admin-web 风格的 AppRoutes：布局 Route（无 path）+ 绝对/相对 children、
// index 路由、element 嵌套包装、element 变量（createElement 布局）、Navigate 相对归一
function buildSampleProject() {
  return makeProject({
    'package.json': JSON.stringify({ name: 'react-jsx-routes', dependencies: { react: '^19.0.0', 'react-router': '^7.1.5' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    'src/AppRoutes.tsx': [
      'import { Routes, Route } from "react-router";',
      'import Home from "./pages/Home";',
      'import SignIn from "./pages/SignIn";',
      'import Summary from "./pages/Projects/Summary";',
      'import Protected from "./components/auth/Protected";',
      'import ScopeUidGuard from "./components/routing/ScopeUidGuard";',
      'import { ScopeIndex } from "./components/routing/scopeRouting";',
      'import { protectedAppLayoutRouteElement } from "./components/routing/routeLayouts";',
      '',
      'export default function AppRoutes() {',
      '  return (',
      '    <Routes>',
      '      <Route element={protectedAppLayoutRouteElement}>',
      '        <Route path="/home" element={<Home />} />',
      '      </Route>',
      '      <Route path="/:scopeUid" element={<ScopeUidGuard />}>',
      '        <Route index element={<ScopeIndex />} />',
      '        <Route path="_settings" element={<ScopeIndex />} />',
      '        <Route path="_overview/summary" element={<Summary />} />',
      '      </Route>',
      '      <Route path="/signin" element={<SignIn />} />',
      '      <Route path="/migration" element={<Protected><Summary /></Protected>} />',
      '    </Routes>',
      '  );',
      '}',
    ].join('\n'),
    'src/pages/Home.tsx': 'export default function Home() { return <div /> }',
    'src/pages/SignIn.tsx': 'export default function SignIn() { return <div /> }',
    'src/pages/Projects/Summary.tsx': 'export default function Summary() { return <div /> }',
    'src/components/auth/Protected.tsx': 'export default function Protected() { return null }',
    'src/components/routing/ScopeUidGuard.tsx': 'export default function ScopeUidGuard() { return <div /> }',
    'src/components/routing/scopeRouting.tsx': [
      'import { Navigate } from "react-router";',
      'export function ScopeIndex() {',
      '  return <Navigate to="_overview/summary" replace />;',
      '}',
    ].join('\n'),
    'src/layout/AppLayout.tsx': 'export default function AppLayout() { return <div /> }',
    'src/components/routing/routeLayouts.tsx': [
      'import { createElement } from "react";',
      'import Protected from "../auth/Protected";',
      'import AppLayout from "../../layout/AppLayout";',
      'export function ProtectedAppLayoutRoute() {',
      '  return (<Protected><AppLayout /></Protected>);',
      '}',
      'export const protectedAppLayoutRouteElement = createElement(ProtectedAppLayoutRoute);',
    ].join('\n'),
    // 测试文件中的 mock 路由不应参与
    'src/context/UidRouteContext.test.tsx': [
      'import { Routes, Route } from "react-router";',
      'export function mock() {',
      '  return <Routes><Route path=":uid" element={<div />} /></Routes>;',
      '}',
    ].join('\n'),
  });
}

test('react JSX 路由：布局/绝对 children/嵌套相对路径/index/包装 element', async () => {
  const dir = buildSampleProject();
  const data = await buildOntologyData(dir);
  const routes = data.Route;
  const byOverlay = new Map(routes.map((r) => [r.overlayId, r]));

  // 布局 Route（无 path）下的绝对 children
  assert.ok(byOverlay.has('/home'));
  assert.equal(byOverlay.get('/home').componentFileId, 'file:src/pages/Home.tsx');
  assert.equal(byOverlay.get('/home').routeType, 'react');

  // 嵌套相对路径拼接（/:scopeUid + _settings）
  assert.ok(byOverlay.has('/:scopeUid/_settings'));
  assert.equal(byOverlay.get('/:scopeUid/_settings').componentFileId, 'file:src/components/routing/scopeRouting.tsx');
  assert.ok(byOverlay.has('/:scopeUid/_overview/summary'));
  assert.equal(byOverlay.get('/:scopeUid/_overview/summary').componentFileId, 'file:src/pages/Projects/Summary.tsx');

  // index 路由：overlayId 与父路由相同，id 需去重
  const scopeRoutes = routes.filter((r) => r.overlayId === '/:scopeUid');
  assert.equal(scopeRoutes.length, 2);
  assert.notEqual(scopeRoutes[0].id, scopeRoutes[1].id);

  // element 嵌套包装（<Protected><Summary /></Protected>）→ 最内层组件
  assert.equal(byOverlay.get('/migration').componentFileId, 'file:src/pages/Projects/Summary.tsx');

  // 测试文件中的 mock 路由被排除
  assert.ok(!byOverlay.has('/:uid'));

  // pages/ 目录下被路由引用的组件升级为 page kind
  const home = data.Component.find((c) => c.name === 'Home');
  assert.equal(home.kind, 'page');
  const signIn = data.Component.find((c) => c.name === 'SignIn');
  assert.equal(signIn.kind, 'page');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('react JSX 路由：Navigate 相对路径归一为导航边', async () => {
  const dir = buildSampleProject();
  const data = await buildOntologyData(dir);
  const routes = data.Route;
  // index 路由（ScopeIndex）：to="_overview/summary" 相对当前 /:scopeUid → /:scopeUid/_overview/summary
  const scopeIndex = routes.find((r) => r.overlayId === '/:scopeUid'
    && r.componentFileId === 'file:src/components/routing/scopeRouting.tsx');
  assert.ok(scopeIndex);
  assert.deepEqual(scopeIndex.navigatesToIds, ['route:/:scopeUid/_overview/summary']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tsAnalyzer：<Navigate to> 字面量计入 overlayOpens，动态表达式不计入', () => {
  const content = [
    'import { Navigate } from "react-router"',
    '',
    'export function Redirector() {',
    '  if (x) return <Navigate to="/signin" replace />;',
    '  return <Navigate to={buildPath(uid, "home")} />;',
    '}',
  ].join('\n');
  const facts = analyzeFile('src/components/Redirector.tsx', content, ROOT);
  const targets = facts.overlayOpens.map((o) => o.target);
  assert.deepEqual(targets, ['/signin']); // 模板/表达式 to 不提取
});

test('tsAnalyzer：<NavLink to> 字面量计入 overlayOpens；动态引用触发常量表兜底', () => {
  // 字符串字面量 / { pathname } 对象形态
  const literal = [
    'import { NavLink } from "react-router-dom"',
    '',
    'export function Nav() {',
    '  return (',
    '    <nav>',
    '      <NavLink to="/library">Library</NavLink>',
    "      <NavLink to={{ pathname: '/settings' }}>Settings</NavLink>",
    '    </nav>',
    '  );',
    '}',
  ].join('\n');
  const facts1 = analyzeFile('src/components/Nav.tsx', literal, ROOT);
  assert.deepEqual(facts1.overlayOpens.map((o) => o.target).sort(), ['/library', '/settings']);

  // 数据驱动侧边栏：to={item.path} 动态引用 → 同文件常量表 { path: '/xxx' } 兜底
  const dataDriven = [
    'import { NavLink } from "react-router-dom"',
    '',
    'const NAV_ITEMS = [',
    '  { path: "/", label: "library" },',
    '  { path: "/dashboard", label: "dashboard" },',
    '  { path: "/spending", label: "spending" },',
    '];',
    '',
    'export function Sidebar() {',
    '  return (',
    '    <nav>',
    '      {NAV_ITEMS.map((item) => (',
    '        <NavLink key={item.label} to={item.path}>{item.label}</NavLink>',
    '      ))}',
    '    </nav>',
    '  );',
    '}',
  ].join('\n');
  const facts2 = analyzeFile('src/components/Sidebar.tsx', dataDriven, ROOT);
  assert.deepEqual(facts2.overlayOpens.map((o) => o.target).sort(), ['/', '/dashboard', '/spending']);

  // 常量成员引用 { path: ROUTES.DASHBOARD }：ROUTES 从 router 文件导入（跨文件 const 对象表）
  const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-navref-'));
  fs.mkdirSync(path.join(hubDir, 'src/components/layout'), { recursive: true });
  fs.mkdirSync(path.join(hubDir, 'src/router'), { recursive: true });
  fs.writeFileSync(path.join(hubDir, 'src/router/index.tsx'), [
    'export const ROUTES = {',
    '  DASHBOARD: "/dashboard",',
    '  LIBRARY: "/library",',
    '  GAME_DETAIL: "/game/:appid",',
    '};',
  ].join('\n'));
  fs.writeFileSync(path.join(hubDir, 'src/components/layout/Sidebar.tsx'), [
    'import { NavLink } from "react-router-dom";',
    'import { ROUTES } from "../../router";',
    '',
    'const STEAM_NAV = [',
    '  { path: ROUTES.DASHBOARD, label: "dashboard" },',
    '  { path: ROUTES.LIBRARY, label: "library" },',
    '  { path: ROUTES.GAME_DETAIL, label: "game" },',
    '  { path: item.path, label: "unresolved" },',
    '];',
    '',
    'export function Sidebar() {',
    '  return (<nav>{STEAM_NAV.map((item) => (',
    '    <NavLink key={item.label} to={item.path}>{item.label}</NavLink>',
    '  ))}</nav>);',
    '}',
  ].join('\n'));
  const factsHub = analyzeFile('src/components/layout/Sidebar.tsx',
    fs.readFileSync(path.join(hubDir, 'src/components/layout/Sidebar.tsx'), 'utf8'), hubDir);
  assert.deepEqual(
    factsHub.overlayOpens.map((o) => o.target).sort(),
    ['/dashboard', '/game/:appid', '/library'],
  );
  fs.rmSync(hubDir, { recursive: true, force: true });

  // 非 react-router 的 NavLink（如自研组件）不提取
  const foreign = [
    'import { NavLink } from "@radix-ui/nav"',
    'export function Nav() { return <NavLink to="/x">x</NavLink> }',
  ].join('\n');
  const facts3 = analyzeFile('src/components/ForeignNav.tsx', foreign, ROOT);
  assert.equal(facts3.overlayOpens.length, 0);
});

test('react JSX 路由：无路由声明的普通项目返回空', async () => {
  const dir = makeProject({
    'package.json': JSON.stringify({ name: 'plain-react', dependencies: { react: '^19.0.0' } }),
    'src/App.tsx': 'export default function App() { return <div>hello</div> }',
  });
  const data = await buildOntologyData(dir);
  assert.equal(data.Route.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- React Router 6.4+ 数据路由：createBrowserRouter([{ path, element, index, children }]) ----
// 样例模式取自 steam-game-library 的 src/router/index.tsx：
// lazy 包装变量（含 .then 命名导出链）、本地 wrapper 函数展开、布局对象跳过、index 路由
function buildDataRouterProject() {
  return makeProject({
    'package.json': JSON.stringify({
      name: 'react-data-router',
      dependencies: { react: '^18.0.0', 'react-router-dom': '^6.4.0' },
    }),
    'src/router/index.tsx': [
      'import { lazy, Suspense, createBrowserRouter, Navigate } from "react-router-dom";',
      'import AppLayout from "../components/AppLayout";',
      'import { PageSkeleton } from "../components/PageSkeleton";',
      '',
      'const LibraryPage = lazy(() => import("../pages/LibraryPage"));',
      'const PublisherPage = lazy(() => import("../pages/PublisherPage").then((m) => ({ default: m.PublisherPage })));',
      'const SettingsPage = lazy(() => import("../pages/SettingsPage"));',
      'const GameDetailPage = lazy(() => import("../pages/GameDetailPage"));',
      '',
      'function PublisherPageWrapper() {',
      '  return (',
      '    <Suspense fallback={<PageSkeleton />}>',
      '      <PublisherPage />',
      '    </Suspense>',
      '  );',
      '}',
      '',
      '// 包装函数（steam-game-hub-2.0 惯例）',
      'const withSuspense = (Component) => (',
      '  <Suspense fallback={<PageSkeleton />}>',
      '    <Component />',
      '  </Suspense>',
      ');',
      '',
      'const withPlatformGuard = (Component, platform) => (',
      '  <Suspense fallback={<PageSkeleton />}>',
      '    <Component />',
      '  </Suspense>',
      ');',
      '',
      'export const router = createBrowserRouter([',
      '  {',
      '    path: "/",',
      '    element: withSuspense(AppLayout),',
      '    children: [',
      '      { index: true, element: <Navigate to="/library" replace /> },',
      '      { path: "library", element: withSuspense(LibraryPage) },',
      '      { path: "publishers", element: <PublisherPageWrapper /> },',
      '      { path: "games/:id", element: <GameDetailPage /> },',
      '      { path: "settings", element: withSuspense(SettingsPage) },',
      '      { path: "report/ps", element: withPlatformGuard(SettingsPage, "playstation") },',
      '      { path: "*", element: <Navigate to="/library" replace /> },',
      '    ],',
      '  },',
      '  { path: "/standalone", element: <AppLayout /> },',
      ']);',
    ].join('\n'),
    'src/components/AppLayout.tsx': [
      'import { Outlet } from "react-router-dom";',
      'import Sidebar from "./Sidebar";',
      'export default function AppLayout() {',
      '  return (<div><Sidebar /><Outlet /></div>);',
      '}',
    ].join('\n'),
    'src/components/Sidebar.tsx': [
      'import { NavLink } from "react-router-dom";',
      '',
      'const NAV_ITEMS = [',
      '  { path: "/publishers", label: "publishers" },',
      '  { path: "/settings", label: "settings" },',
      '];',
      '',
      'export default function Sidebar() {',
      '  return (<nav>{NAV_ITEMS.map((item) => (',
      '    <NavLink key={item.label} to={item.path}>{item.label}</NavLink>',
      '  ))}</nav>);',
      '}',
    ].join('\n'),
    'src/components/PageSkeleton.tsx': 'export function PageSkeleton() { return <div /> }',
    'src/pages/LibraryPage.tsx': 'export default function LibraryPage() { return <div /> }',
    'src/pages/PublisherPage.tsx': 'export function PublisherPage() { return <div /> }',
    'src/pages/SettingsPage.tsx': 'export default function SettingsPage() { return <div /> }',
    'src/pages/GameDetailPage.tsx': 'export default function GameDetailPage() { return <div /> }',
    // 测试文件中的 mock 数据路由不参与
    'src/router/__tests__/router.test.tsx': [
      'import { createHashRouter } from "react-router-dom";',
      'export const mock = createHashRouter([{ path: "/mock", element: <div /> }]);',
    ].join('\n'),
  });
}

test('react 数据路由：lazy 包装/then 链/本地 wrapper/布局跳过/index/测试文件排除', async () => {
  const dir = buildDataRouterProject();
  const data = await buildOntologyData(dir);
  const routes = data.Route;
  const byOverlay = new Map(routes.map((r) => [r.overlayId, r]));

  // 布局对象（path="/" + children，withSuspense 包装）自身不产出，index: true 产出 '/'
  assert.equal(routes.filter((r) => r.overlayId === '/').length, 1);
  // index 重定向路由：element 为 <Navigate to="/library"> → 无组件关联，但有导航边
  assert.equal(byOverlay.get('/').componentFileId, null);
  assert.ok(byOverlay.get('/').navigatesToIds.includes('route:/library'));
  assert.equal(byOverlay.get('/').routeType, 'react');

  // 包装函数调用 withSuspense(X)：第一个组件参数（lazy 变量）解析
  assert.equal(byOverlay.get('/settings').componentFileId, 'file:src/pages/SettingsPage.tsx');
  // 包装函数调用 withPlatformGuard(X, 'playstation')：多参数取首个组件参数
  assert.equal(byOverlay.get('/report/ps').componentFileId, 'file:src/pages/SettingsPage.tsx');
  // lazy + .then() 命名导出链 → 本地 wrapper 函数 return JSX 展开
  assert.ok(byOverlay.has('/publishers'));
  assert.equal(byOverlay.get('/publishers').componentFileId, 'file:src/pages/PublisherPage.tsx');
  // element 直接 <GameDetailPage />（lazy 变量）
  assert.equal(byOverlay.get('/games/:id').componentFileId, 'file:src/pages/GameDetailPage.tsx');
  // 相对 path 拼接：'games/:id' + parent '/' → '/games/:id'；domain 取首段
  assert.equal(byOverlay.get('/games/:id').domain, 'games');

  // catch-all '*'：相对 path + parent '/' → '/*'，Navigate 重定向
  assert.ok(byOverlay.has('/*'));
  assert.equal(byOverlay.get('/*').componentFileId, null);
  assert.ok(byOverlay.get('/*').navigatesToIds.includes('route:/library'));

  // 无 children 的顶层路由正常产出
  assert.equal(byOverlay.get('/standalone').componentFileId, 'file:src/components/AppLayout.tsx');

  // 测试文件中的 mock 数据路由排除
  assert.ok(!byOverlay.has('/mock'));

  // 页面组件 kind 升级（pages/ 目录 + 路由直接引用）
  const publisher = data.Component.find((c) => c.name === 'PublisherPage');
  assert.equal(publisher.kind, 'page');

  // 布局外壳导航闭包：Sidebar（AppLayout 直接 import）的 NavLink 常量表目标
  // 并入所有子路由的导航边（侧边栏对子页面全局可达）
  const settings = byOverlay.get('/settings');
  assert.ok(settings.navigatesToIds.includes('route:/publishers'), JSON.stringify(settings.navigatesToIds));
  const games = byOverlay.get('/games/:id');
  assert.ok(games.navigatesToIds.includes('route:/settings'));
  assert.ok(games.navigatesToIds.includes('route:/publishers'));
  // /standalone 直接用 AppLayout（无 children）→ 无 Sidebar 导航边（非子路由）
  assert.deepEqual(byOverlay.get('/standalone').navigatesToIds, []);

  // 总数：index '/' + library + publishers + games/:id + settings + report/ps + * + standalone = 8
  assert.equal(routes.length, 8, JSON.stringify(routes.map((r) => r.overlayId)));

  fs.rmSync(dir, { recursive: true, force: true });
});
