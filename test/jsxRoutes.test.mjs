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

test('react JSX 路由：无路由声明的普通项目返回空', async () => {
  const dir = makeProject({
    'package.json': JSON.stringify({ name: 'plain-react', dependencies: { react: '^19.0.0' } }),
    'src/App.tsx': 'export default function App() { return <div>hello</div> }',
  });
  const data = await buildOntologyData(dir);
  assert.equal(data.Route.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
