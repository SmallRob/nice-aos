// 路由地图（Viewer routeMap）测试：模型层（清单/导航边/入口孤岛/类型分布/路径层级树/域分组）+ HTML 渲染
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildViewerModel, renderViewerHtml } from '../src/ontology/viewer.js';
import { buildOntologyData } from '../src/ontology/builder.js';

// ---- fixture：Next.js App Router（页面/API/动态段/路由组/私有目录 + Link 导航边）----
function buildNextFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-routemap-'));
  const w = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  w('package.json', JSON.stringify({ name: 'next-fixture', dependencies: { next: '^16.2.6', react: '^19.2.4' } }));
  w('app/layout.tsx', 'export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }');
  w('app/page.tsx', [
    "'use client';",
    'import Link from "next/link";',
    'export default function HomePage() {',
    '  return (<div>',
    '    <Link href="/dashboard">Dashboard</Link>',
    '    <Link href={{ pathname: "/about" }}>About</Link>',
    '  </div>);',
    '}',
  ].join('\n'));
  w('app/dashboard/page.tsx', [
    'import Link from "next/link";',
    'export default function DashboardPage() {',
    '  return <Link href="/about">About</Link>;',
    '}',
  ].join('\n'));
  w('app/about/page.tsx', 'export default function AboutPage() { return <div /> }');
  w('app/shop/[id]/page.tsx', 'export default function ShopItemPage() { return <div /> }');
  w('app/api/items/route.ts', 'export async function GET() { return Response.json([]) }');
  return dir;
}

test('routeMap 模型层：清单/导航边/入口孤岛/类型分布/树/域分组', async () => {
  const dir = buildNextFixture();
  try {
    const dataMap = await buildOntologyData(dir);
    const model = buildViewerModel(dataMap);
    const rm = model.routeMap;
    assert.ok(rm, '有路由时 routeMap 应存在');

    // 清单与类型分布
    assert.equal(rm.totalCount, 5);
    assert.deepEqual(rm.byType, [{ key: 'next', count: 4 }, { key: 'next-api', count: 1 }]);
    assert.equal(rm.dynamicCount, 1);
    assert.equal(rm.apiRouteCount, 1);

    // 导航边（/ → dashboard、/ → about、dashboard → about）
    assert.equal(rm.navEdgeCount, 3);
    const edgeKeys = rm.navEdges.map((e) => e.fromPath + '>' + e.toPath).sort();
    assert.deepEqual(edgeKeys, ['/>' + '/about', '/>' + '/dashboard', '/dashboard>/about']);

    // 入口（无入边有出边）与孤岛（无入边无出边）
    assert.equal(rm.entryCount, 1);
    assert.equal(rm.orphanCount, 2); // /shop/:id 与 /api/items

    // 条目字段
    const home = rm.items.find((i) => i.path === '/');
    assert.equal(home.routeType, 'next');
    assert.equal(home.isClient, true);
    assert.equal(home.componentRef, 'HomePage');
    assert.deepEqual(home.navToPaths.sort(), ['/about', '/dashboard']);
    const api = rm.items.find((i) => i.path === '/api/items');
    assert.equal(api.routeType, 'next-api');
    assert.deepEqual(api.apiMethods, ['GET']);
    const shop = rm.items.find((i) => i.path === '/shop/:id');
    assert.equal(shop.isDynamic, true);

    // 路径层级树：根下静态段字母序在前、动态段在后；嵌套段父子正确
    assert.equal(rm.maxDepth, 2); // /shop/:id 与 /api/items 均为 2 段
    const rootSegs = rm.tree.children.map((c) => c.seg);
    assert.deepEqual(rootSegs, ['about', 'api', 'dashboard', 'shop']);
    const shopNode = rm.tree.children.find((c) => c.seg === 'shop');
    assert.deepEqual(shopNode.children.map((c) => c.seg), [':id']);
    assert.equal(shopNode.children[0].routes.length, 1);
    // 中间段（api）无路由，叶段（items）承载路由
    const apiNode = rm.tree.children.find((c) => c.seg === 'api');
    assert.equal(apiNode.routes.length, 0);
    assert.deepEqual(apiNode.children.map((c) => c.seg), ['items']);

    // 域分组：next 路由 domain 取首个非动态段
    const groupNames = rm.domainGroups.map((g) => g.name).sort();
    assert.deepEqual(groupNames, ['about', 'api', 'dashboard', 'root', 'shop']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('routeMap 渲染：路由地图 Tab 输出导航链 SVG / 层级树 / 域分组', async () => {
  const dir = buildNextFixture();
  try {
    const dataMap = await buildOntologyData(dir);
    const model = buildViewerModel(dataMap);
    const html = renderViewerHtml(model);

    // Tab 与视图容器
    assert.ok(html.includes('data-tab="routemap"'), '应有路由地图 Tab');
    assert.ok(html.includes('id="view-routemap"'));

    // 嵌入数据无损
    const dataJson = html.match(/<script id="viewer-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
    const script = html.match(/<script>\n([\s\S]*?)<\/script>\s*<\/body>/)[1];
    const parsed = JSON.parse(dataJson);
    assert.equal(parsed.routeMap.totalCount, 5);

    // mock DOM 执行内嵌脚本，验证渲染输出
    const elements = new Map();
    const makeEl = (id) => {
      if (!elements.has(id)) {
        elements.set(id, {
          innerHTML: '', textContent: id === 'viewer-data' ? dataJson : '',
          dataset: {}, style: {}, addEventListener() {},
          classList: { add() {}, remove() {} }, querySelectorAll: () => [],
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

    const out = makeEl('view-routemap').innerHTML;
    assert.ok(out.includes('<h2>路由总览'), '应有路由总览面板');
    assert.ok(out.includes('路由导航链'), '应有导航链面板');
    assert.ok(out.includes('<svg'), '导航链应渲染 SVG 图');
    assert.ok(out.includes('路径层级树'), '应有路径层级树面板');
    assert.ok(out.includes('域分组'), '应有域分组面板');
    assert.ok(out.includes('全量路由清单'), '应有全量路由清单表');
    // 路由节点与边（/ → /dashboard 导航）
    assert.ok(out.includes('/dashboard'), 'SVG/树中应含 /dashboard 路由');
    assert.ok(out.includes('Next API'), '类型徽标应含 Next API');
    // 层级树：动态段高亮 class
    assert.ok(out.includes('seg dyn'), '动态段应带 dyn 标记');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('routeMap：无路由项目 routeMap 为 null（Tab 由客户端隐藏）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-routemap-empty-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'no-route-fixture', dependencies: { react: '^19.0.0' },
  }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/util.ts'), 'export const x = 1;');
  try {
    const dataMap = await buildOntologyData(dir);
    const model = buildViewerModel(dataMap);
    assert.equal(model.routeMap, null);
    const html = renderViewerHtml(model);
    assert.ok(html.includes("if (!M.routeMap) hideTab('routemap');"), '无路由时应隐藏 Tab');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
