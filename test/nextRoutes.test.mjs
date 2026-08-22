// Next.js App Router 路由提取测试：文件约定式 page/route/layout、目录段归一、Link 导航边
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOntologyData } from '../src/ontology/builder.js';
import { analyzeFile } from '../src/analyzers/tsAnalyzer.js';

function makeProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nice-aos-next-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function buildSampleProject() {
  return makeProject({
    'package.json': JSON.stringify({ name: 'next-app-router', dependencies: { next: '^16.2.6', react: '^19.2.4' } }),
    'app/layout.tsx': [
      'export default function RootLayout({ children }: { children: React.ReactNode }) {',
      '  return <html><body>{children}</body></html>;',
      '}',
    ].join('\n'),
    'app/page.tsx': [
      "'use client';",
      'import Link from "next/link";',
      'export default function HomePage() {',
      '  return (',
      '    <div>',
      '      <Link href="/dashboard">Dashboard</Link>',
      '      <Link href={{ pathname: "/about" }}>About</Link>',
      '    </div>',
      '  );',
      '}',
    ].join('\n'),
    'app/dashboard/page.tsx': 'export default function DashboardPage() { return <div /> }',
    'app/shop/layout.tsx': 'export default function ShopLayout({ children }: { children: React.ReactNode }) { return <>{children}</> }',
    'app/shop/[id]/page.tsx': 'export default function ShopItemPage() { return <div /> }',
    'app/(marketing)/about/page.tsx': 'export default function AboutPage() { return <div /> }',
    'app/api/items/route.ts': [
      'export async function GET() { return Response.json([]) }',
      'export async function POST(request: Request) { return Response.json({}) }',
    ].join('\n'),
    // 私有目录：不产出路由
    'app/_lib/page.tsx': 'export default function IgnoredPage() { return <div /> }',
  });
}

test('next App Router：约定文件路由提取与目录段归一', async () => {
  const dir = buildSampleProject();
  const data = await buildOntologyData(dir);
  const routes = data.Route;
  const byPath = new Map(routes.map((r) => [r.routePath, r]));

  assert.equal(routes.length, 5);
  assert.ok(byPath.has('/'));
  assert.ok(byPath.has('/dashboard'));
  assert.ok(byPath.has('/shop/:id')); // 动态段归一
  assert.ok(byPath.has('/about')); // 路由组剔除
  assert.ok(byPath.has('/api/items')); // API 路由

  // 路由组段保留在 rawPath
  assert.equal(byPath.get('/about').rawPath, '(marketing)/about');

  // 私有目录不产出路由
  assert.ok(!routes.some((r) => r.routePath.includes('_lib')));

  // 页面组件文件与 routeType
  assert.equal(byPath.get('/dashboard').componentFileId, 'file:app/dashboard/page.tsx');
  assert.equal(byPath.get('/dashboard').routeType, 'next');
  assert.equal(byPath.get('/api/items').routeType, 'next-api');

  // 动态标记
  assert.equal(byPath.get('/shop/:id').isDynamic, true);
  assert.equal(byPath.get('/dashboard').isDynamic, false);

  // layout 链（外→内，含嵌套）
  assert.deepEqual(byPath.get('/shop/:id').layoutFileIds, ['file:app/layout.tsx', 'file:app/shop/layout.tsx']);
  assert.deepEqual(byPath.get('/dashboard').layoutFileIds, ['file:app/layout.tsx']);

  // 'use client' 指令识别
  assert.equal(byPath.get('/').isClient, true);
  assert.equal(byPath.get('/dashboard').isClient, false);

  // API 方法提取
  assert.deepEqual(byPath.get('/api/items').apiMethods, ['GET', 'POST']);

  // 默认导出组件名与 page kind 升级
  assert.equal(byPath.get('/').componentRef, 'HomePage');
  const home = data.Component.find((c) => c.name === 'HomePage');
  assert.equal(home.kind, 'page');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('next App Router：Link href（字符串与 pathname 对象）生成导航边', async () => {
  const dir = buildSampleProject();
  const data = await buildOntologyData(dir);
  const byPath = new Map(data.Route.map((r) => [r.routePath, r]));

  const home = byPath.get('/');
  assert.deepEqual(home.navigatesToIds, ['route:/dashboard', 'route:/about']);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('tsAnalyzer：<Link href>（next/link）计入 overlayOpens，非 next/link 的 Link 不计', () => {
  const nextContent = [
    'import Link from "next/link"',
    'export function Nav() {',
    '  return <div><Link href="/library">Lib</Link><Link href={{ pathname: "/sync", query: { a: 1 } }}>Sync</Link></div>;',
    '}',
  ].join('\n');
  const facts = analyzeFile('app/components/Nav.tsx', nextContent, process.cwd());
  assert.deepEqual(facts.overlayOpens.map((o) => o.target), ['/library', '/sync']);

  const otherContent = [
    'import { Link } from "some-ui-lib"',
    'export function Nav() {',
    '  return <Link href="/library">Lib</Link>;',
    '}',
  ].join('\n');
  const otherFacts = analyzeFile('app/components/Nav2.tsx', otherContent, process.cwd());
  assert.equal(otherFacts.overlayOpens.length, 0);
});

test('next App Router：无 app 目录的 next 项目返回空路由', async () => {
  const dir = makeProject({
    'package.json': JSON.stringify({ name: 'next-no-app', dependencies: { next: '^16.2.6' } }),
    'src/lib/util.ts': 'export const x = 1',
  });
  const data = await buildOntologyData(dir);
  assert.equal(data.Route.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
