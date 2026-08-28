// output docs 测试：三明治上下文文档树生成（context-builder skill 的 CLI 支撑）
// 覆盖：L1/L2/L3 文件与内容契约、粒度预算、tree.json 结构、--format md 降级、
//       默认输出目录、--output 自定义目录、export 别名等价、纯函数边界（无 Domain / slug 去重 / CJK）
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');
const { buildContextDocs, slugify, buildTree, CONTEXT_DOCS_VERSION } = await import(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ontology', 'contextDocs.js')
);

const SNAP = {
  _meta: {
    generatedAt: '2026-08-22T00:00:00.000Z', durationMs: 5,
    cycles: [['src/a.ts', 'src/b.ts', 'src/a.ts']],
    orphanCandidates: [], deadExportCandidates: [],
    objectCounts: { Module: 2, SourceFile: 10, Component: 2, Route: 2, Store: 1, Hook: 1, Service: 1, Interface: 2, Class: 1, Dependency: 1, Domain: 2 },
  },
  Project: [{
    id: 'proj:demo', name: 'docs-demo', framework: 'react', frameworkLabel: 'React 单页应用', language: 'TypeScript',
    branch: 'main', commitHash: 'abc1234567890', fileCount: 10,
    architecture: {
      style: 'component-app', styleLabel: '组件应用',
      layers: [
        { key: 'presentation', label: '表现层', description: '页面组件', fileCount: 6, share: 60 },
        { key: 'service', label: '业务层', description: '服务', fileCount: 4, share: 40 },
      ],
    },
    health: { cycleCount: 1, orphanFileCount: 0, deadTypeCount: 0, deadFunctionCount: 2, deadExportCount: 1, undeclaredDependencyCount: 0, analysisErrorCount: 0, highRiskScriptCount: 0 },
    summary: 'React 单页应用（10 个源文件）。',
  }],
  Module: [
    { id: 'mod:src', name: 'src', path: 'src', archLayer: 'presentation', archLayerLabel: '表现层', fileCount: 6, subtreeFileCount: 6, unitCounts: { component: 2 }, domainIds: ['dom:shop'], summary: '表现层模块：页面组件。' },
    { id: 'mod:src/services', name: 'services', path: 'src/services', archLayer: 'service', archLayerLabel: '业务层', fileCount: 4, subtreeFileCount: 4, unitCounts: {}, domainIds: ['dom:shop'], summary: '业务服务。' },
  ],
  Component: [
    { id: 'comp:Home', name: 'Home', filePath: 'src/Home.tsx', kind: 'page', propsCount: 2, lineCount: 120, domainIds: ['dom:shop'] },
    { id: 'comp:Cart', name: 'Cart', filePath: 'src/Cart.tsx', kind: 'page', propsCount: 0, lineCount: 80, domainIds: ['dom:shop'] },
  ],
  Route: [
    { id: 'route:home', overlayId: 'home', routePath: '/home', routeType: 'overlay', backTarget: '', navigatesToIds: ['route:cart'], domainIds: ['dom:shop'] },
    { id: 'route:cart', overlayId: 'cart', routePath: '/cart', routeType: 'overlay', backTarget: 'home', navigatesToIds: [], domainIds: ['dom:shop'] },
  ],
  Store: [
    { id: 'store:useCartStore', name: 'useCartStore', filePath: 'src/stores/cart.ts', storageKey: 'cart', hasPersist: true, stateKeys: ['items'], actionKeys: ['add'], domainIds: ['dom:shop'] },
  ],
  Hook: [{ id: 'hook:useCart', name: 'useCart', filePath: 'src/hooks/useCart.ts', lineCount: 30, domainIds: ['dom:shop'] }],
  Service: [{ id: 'svc:cartService', name: 'cartService', filePath: 'src/services/cart.ts', pattern: 'functions', exportsCount: 3, lineCount: 100, domainIds: ['dom:shop'] }],
  Interface: [
    { id: 'iface:src/types.ts#CartItem', name: 'CartItem', filePath: 'src/types.ts', line: 1, exported: true },
    { id: 'iface:src/other.ts#Other', name: 'Other', filePath: 'src/other.ts', line: 1, exported: false },
  ],
  Class: [{ id: 'class:src/repo.ts#CartRepo', name: 'CartRepo', filePath: 'src/repo.ts', isSingleton: false }],
  Dependency: [{ id: 'dep:react', name: 'react', version: '18.0.0', scope: 'dependencies', source: 'npm', importCount: 12 }],
  Domain: [
    {
      id: 'dom:shop', name: 'shop', sources: ['route'], summary: '购物车域：商品浏览与下单。',
      fileCount: 8, lineCount: 900, routeCount: 2, componentCount: 2, storeCount: 1, hookCount: 1, serviceCount: 1, scriptCount: 0,
      routeIds: ['route:home', 'route:cart'], componentIds: ['comp:Home', 'comp:Cart'], storeIds: ['store:useCartStore'],
      hookIds: ['hook:useCart'], serviceIds: ['svc:cartService'], moduleIds: ['mod:src', 'mod:src/services'],
      fileIds: ['file:src/types.ts', 'file:src/repo.ts'],
    },
    {
      id: 'dom:empty', name: '空洞域', sources: ['module'], summary: '',
      fileCount: 2, lineCount: 10, routeCount: 0, componentCount: 0, storeCount: 0, hookCount: 0, serviceCount: 0, scriptCount: 0,
      moduleIds: [], fileIds: [],
    },
  ],
};

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', cwd });
}

function mkFixture(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-output-docs-'));
  fs.mkdirSync(path.join(dir, '.nice-aos', 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.nice-aos', 'data', 'snapshot.json'), JSON.stringify({ ...SNAP, ...extra }));
  return dir;
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf-8');
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
const bytes = (dir, rel) => Buffer.byteLength(read(dir, rel), 'utf-8');

test('output docs 默认 all：L1/L2/L3 + tree.json + docs.html 全链路', (t) => {
  const dir = mkFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = runCli(['output', 'docs'], dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);

  const summary = JSON.parse(r.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.format, 'all');
  assert.equal(summary.domains, 2);
  assert.equal(summary.mdFiles, 10);
  assert.equal(summary.treeFiles, 10);
  assert.match(summary.outputDir, /\.nice-aos[/\\]context$/);
  assert.match(summary.browse, /serve/);

  // L1 顶层索引：项目名 / 分层 / 领域链接 / 粒度预算 <2KB
  const index = read(dir, '.nice-aos/context/index.md');
  assert.match(index, /title: docs-demo/);
  assert.match(index, /layer: L1/);
  assert.match(index, /# docs-demo · 项目顶层索引/);
  assert.match(index, /\[shop\]\(domains\/shop\.md\)/);
  assert.match(index, /表现层 \| 6 \| 60%/);
  assert.ok(bytes(dir, '.nice-aos/context/index.md') < 2048, `L1 应 <2KB，实际 ${bytes(dir, '.nice-aos/context/index.md')}B`);

  // 汇总层：架构总览 / 模块地图
  const arch = read(dir, '.nice-aos/context/architecture.md');
  assert.match(arch, /## 循环依赖（Top 1 \/ 共 1 组）/);
  assert.match(arch, /a\.ts → b\.ts/);
  assert.match(arch, /\| react \| 18\.0\.0 \| npm \| 12 \|/);
  assert.match(arch, /死代码候选函数（治理点） \| 2 \|/);
  const modules = read(dir, '.nice-aos/context/modules.md');
  assert.match(modules, /## 表现层 presentation（1 个模块 · 6 文件）/);
  assert.match(modules, /`src` \| 6 \| 2 \| 表现层模块/);

  // L2 领域索引：<1KB 预算 + 成员清单 + L3 链接
  const l2 = read(dir, '.nice-aos/context/domains/shop.md');
  assert.match(l2, /layer: L2/);
  assert.match(l2, /购物车域：商品浏览与下单。/);
  assert.match(l2, /## 子模块（Top 2 \/ 共 2）/);
  assert.match(l2, /\[组件清单\]\(shop\/components\.md\)/);
  assert.ok(bytes(dir, '.nice-aos/context/domains/shop.md') < 1024, `L2 应 <1KB，实际 ${bytes(dir, '.nice-aos/context/domains/shop.md')}B`);

  // L3 领域详情：<5KB 预算 + 内容契约
  const comps = read(dir, '.nice-aos/context/domains/shop/components.md');
  assert.match(comps, /layer: L3/);
  assert.match(comps, /\| Home \| `Home\.tsx` \| page \| 2 \| 120 \|/);
  assert.ok(!comps.includes('仅列出前'), '成员数小于 TopN 上限时不应出现截断提示');
  assert.ok(bytes(dir, '.nice-aos/context/domains/shop/components.md') < 5120);
  const routes = read(dir, '.nice-aos/context/domains/shop/routes.md');
  assert.match(routes, /\| home \| \/home \| overlay \| - \| 1 \|/);
  const state = read(dir, '.nice-aos/context/domains/shop/state.md');
  assert.match(state, /\| useCartStore \| cart \| 是 \| 1 \| 1 \|/);
  assert.match(state, /\| useCart \|/);
  const services = read(dir, '.nice-aos/context/domains/shop/services.md');
  assert.match(services, /\| cartService \| functions \| 3 \| 100 \|/);
  // 接口按领域 fileIds 圈定：types.ts 圈入、other.ts 排除
  assert.match(services, /\| CartItem \|/);
  assert.ok(!services.includes('| Other |'), 'other.ts 不在领域文件集内，接口 Other 不应出现');

  // 空领域降级：仅有 L2，无 L3
  assert.ok(exists(dir, '.nice-aos/context/domains/空洞域.md'));
  assert.ok(!exists(dir, '.nice-aos/context/domains/空洞域/components.md'));

  // tree.json：结构 + 路径一致性 + 不含自身
  const tree = JSON.parse(read(dir, '.nice-aos/context/tree.json'));
  assert.equal(tree.version, CONTEXT_DOCS_VERSION);
  assert.equal(tree.totalFiles, 10);
  const paths = [];
  const walk = (nodes) => nodes.forEach((n) => {
    if (n.type === 'file') paths.push(n.path);
    else walk(n.children);
  });
  walk(tree.tree);
  assert.equal(paths.length, 10);
  assert.ok(paths.includes('index.md'));
  assert.ok(paths.includes('domains/shop/components.md'));
  assert.ok(!paths.includes('tree.json'), 'tree.json 不应把自己列入索引');
  assert.ok(paths.every((p) => !p.includes('..') && !p.startsWith('/')), 'tree 路径必须为相对路径');

  // docs.html：自包含浏览器
  const docsHtml = read(dir, '.nice-aos/context/docs.html');
  assert.match(docsHtml, /<title>项目文档<\/title>/);
  assert.match(docsHtml, /gitnexus|docs-demo|项目文档/);
  assert.match(docsHtml, /tree\.json/);
});

test('output docs --format md：纯 agent 模式（无 docs.html，tree.json 保留）', (t) => {
  const dir = mkFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = runCli(['output', 'docs', '--format', 'md'], dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const summary = JSON.parse(r.stdout);
  assert.equal(summary.format, 'md');
  assert.equal(summary.browse, undefined);
  assert.ok(!exists(dir, '.nice-aos/context/docs.html'), 'md 模式不应产出 docs.html');
  assert.ok(exists(dir, '.nice-aos/context/tree.json'), 'tree.json 作为结构索引始终产出');
  assert.ok(exists(dir, '.nice-aos/context/index.md'));
});

test('output docs --output 自定义目录 + export 别名等价', (t) => {
  const dir = mkFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = runCli(['export', 'docs', '--output', 'my-ctx'], dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const summary = JSON.parse(r.stdout);
  assert.match(summary.outputDir, /my-ctx$/);
  assert.ok(exists(dir, 'my-ctx/index.md'));
  assert.ok(exists(dir, 'my-ctx/docs.html'));
});

test('buildContextDocs 纯函数：无 Domain / 无 Project 降级 + slug 去重与 CJK', () => {
  // 完全空 dataMap：仍生成 4 个汇总文件 + 空领域地图
  const empty = buildContextDocs({ _meta: {} });
  const rels = empty.files.map((f) => f.path);
  assert.deepEqual(rels, ['index.md', 'architecture.md', 'modules.md', 'domains/_index.md']);
  assert.match(empty.files[0].content, /（未识别出功能域，见模块地图）/);

  // 同名领域 slug 去重
  const dupe = buildContextDocs({
    Domain: [
      { id: 'dom:a', name: 'core', fileCount: 5, moduleIds: [] },
      { id: 'dom:b', name: 'core', fileCount: 3, moduleIds: [] },
    ],
  });
  assert.ok(dupe.files.some((f) => f.path === 'domains/core.md'));
  assert.ok(dupe.files.some((f) => f.path === 'domains/core-1.md'));

  // CJK slug：保留中文、空白折叠
  assert.equal(slugify('购物车 域'), '购物车-域');
  assert.equal(slugify('!!'), 'domain');
});

test('buildTree：目录排序在前 + size 字节数正确', () => {
  const tree = buildTree([
    { path: 'b.md', content: 'bbbb' },
    { path: 'a.md', content: 'aa' },
    { path: 'sub/n.md', content: 'n' },
  ]);
  assert.equal(tree.totalFiles, 3);
  const [sub, a, b] = tree.tree;
  assert.equal(sub.type, 'directory');
  assert.equal(sub.path, 'sub');
  assert.equal(sub.count, 1);
  assert.equal(a.name, 'a.md');
  assert.equal(a.size, 2);
  assert.equal(b.name, 'b.md');
  assert.equal(b.size, 4);
});
