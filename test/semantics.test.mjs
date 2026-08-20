// 语义本体引擎测试：概念分类体系 / 架构分层推断 / 功能域聚合 / 总结生成 / 端到端
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ONTOLOGY_META, OBJECT_TYPES, LINK_TYPES } from '../src/ontology/blueprint.js';
import {
  ARCH_LAYERS, inferFileArchLayer, inferModuleArchLayer,
  buildDomains, summarizeModule, buildProjectProfile,
} from '../src/ontology/semantics.js';
import { buildOntologyData } from '../src/ontology/builder.js';
import { createBlueprint } from '../src/ontology/blueprint.js';
import { exportToMarkdown } from '../src/ontology/exporter.js';

// ---- 概念分类体系（taxonomy）：类型不再平铺，按范畴/层级双维组织 ----
test('taxonomy：每个对象类型都有 category 与 level，且归属唯一', () => {
  const categoryNames = new Set(ONTOLOGY_META.categories.map((c) => c.category));
  const levelNames = new Set(ONTOLOGY_META.abstractionLevels.map((l) => l.level));
  for (const t of OBJECT_TYPES) {
    assert.ok(t.category, `${t.type} 缺 category`);
    assert.ok(t.level, `${t.type} 缺 level`);
    assert.ok(categoryNames.has(t.category), `${t.type} category=${t.category} 未在 categories 定义`);
    assert.ok(levelNames.has(t.level), `${t.type} level=${t.level} 未在 abstractionLevels 定义`);
  }
});

test('taxonomy：abstractionLevels 与 categories 均完整覆盖全部类型且无重叠', () => {
  const allTypes = OBJECT_TYPES.map((t) => t.type);
  const levelTypes = ONTOLOGY_META.abstractionLevels.flatMap((l) => l.types);
  const categoryTypes = ONTOLOGY_META.categories.flatMap((c) => c.types);
  assert.equal(new Set(levelTypes).size, levelTypes.length, 'abstractionLevels 内类型重复');
  assert.equal(new Set(categoryTypes).size, categoryTypes.length, 'categories 内类型重复');
  assert.deepEqual([...new Set([...levelTypes])].sort(), [...new Set(allTypes)].sort());
  assert.deepEqual([...new Set([...categoryTypes])].sort(), [...new Set(allTypes)].sort());
});

test('taxonomy：Domain 类型与 belongsTo 链接已注册', () => {
  const domain = OBJECT_TYPES.find((t) => t.type === 'Domain');
  assert.ok(domain);
  assert.equal(domain.prefix, 'dom:');
  assert.equal(domain.category, 'Container');
  assert.equal(domain.level, 'L3');
  assert.ok(LINK_TYPES.includes('belongsTo'));
});

// ---- 文件级架构分层推断：内容信号优先，目录名兜底 ----
test('inferFileArchLayer：内容信号优先于目录名', () => {
  assert.equal(inferFileArchLayer({ relPath: 'src/store/useThemeStore.ts', storeCount: 1 }), 'state');
  assert.equal(inferFileArchLayer({ relPath: 'src/services/ai.ts' }), 'service');
  assert.equal(inferFileArchLayer({ relPath: 'src/api/client.ts' }), 'integration');
  assert.equal(inferFileArchLayer({ relPath: 'src/components/health/HealthPage.tsx', componentCount: 1 }), 'presentation');
  assert.equal(inferFileArchLayer({ relPath: 'src/hooks/useX.ts', hookCount: 1 }), 'shared');
});

test('inferFileArchLayer：特殊形态（入口/测试/脚本/类型）', () => {
  assert.equal(inferFileArchLayer({ relPath: 'src/main.tsx', isEntry: true }), 'entry');
  assert.equal(inferFileArchLayer({ relPath: 'src/utils/format.test.ts', isTest: true }), 'test');
  assert.equal(inferFileArchLayer({ relPath: 'scripts/foo.user.js', isUserScript: true }), 'script');
  assert.equal(inferFileArchLayer({ relPath: 'src/types/models.d.ts' }), 'types');
});

test('inferFileArchLayer：store 与组件同文件时按组件归类（表现层）', () => {
  assert.equal(inferFileArchLayer({ relPath: 'src/foo.tsx', componentCount: 1, storeCount: 1 }), 'presentation');
});

test('inferFileArchLayer：无信号文件回退目录信号，再回退共享层', () => {
  assert.equal(inferFileArchLayer({ relPath: 'src/utils/format.ts' }), 'shared');
  assert.equal(inferFileArchLayer({ relPath: 'src/config/constants.ts' }), 'config');
  assert.equal(inferFileArchLayer({ relPath: 'src/anything/else.ts' }), 'shared');
});

// ---- 模块级架构分层：主导层 ≥ 60%，分散则如实标记 mixed ----
test('inferModuleArchLayer：主导层与混合层判定', () => {
  assert.equal(inferModuleArchLayer({ presentation: 10 }).archLayer, 'presentation');
  assert.equal(inferModuleArchLayer({ state: 8, presentation: 2 }).archLayer, 'state');
  assert.equal(inferModuleArchLayer({ presentation: 5, state: 4, service: 1 }).archLayer, 'mixed');
  assert.equal(inferModuleArchLayer({}).archLayer, null);
});

// ---- 总结生成 ----
test('summarizeModule：职责画像包含层标签、单元构成与外部引用', () => {
  const s = summarizeModule({
    archLayer: 'presentation',
    fileCount: 12,
    unitCounts: { component: 11, page: 4, hook: 2 },
    externalImportedByCount: 23,
    routeCount: 2,
  });
  assert.ok(s.startsWith('表现层：'));
  assert.ok(s.includes('12 个文件'));
  assert.ok(s.includes('组件 11（页面 4）'));
  assert.ok(s.includes('被模块外 23 处引用'));
  assert.ok(s.includes('承载 2 条路由'));
});

test('buildProjectProfile：架构画像 / 健康度 / 自然语言总结', () => {
  const profile = buildProjectProfile({
    framework: 'react',
    fileObjects: [
      { archLayer: 'presentation' }, { archLayer: 'presentation' },
      { archLayer: 'state' }, { archLayer: 'service' },
    ],
    modules: [{ path: 'src' }],
    domains: [{ name: 'health', fileCount: 2, summary: '健康：2 个文件。' }],
    routes: [{ id: 'route:/health' }],
    components: [], stores: [], hooks: [], services: [], userScripts: [],
    dependencies: [{ source: 'undeclared' }],
    cycles: [['a', 'b']],
    orphanCandidates: ['x.ts'],
    analysisErrors: [],
  });
  assert.equal(profile.architecture.style, 'layered-spa');
  assert.equal(profile.architecture.layers[0].key, 'presentation');
  assert.equal(profile.health.cycleCount, 1);
  assert.equal(profile.health.undeclaredDependencyCount, 1);
  assert.ok(profile.summary.includes('React 单页应用'));
  assert.ok(profile.summary.includes('功能域 1 个'));
  assert.ok(profile.summary.includes('循环依赖 1 组'));
  assert.equal(profile.capabilities.length, 1);
});

// ---- 端到端：React fixture（分层目录 + feature-sliced 目录混合布局）----
function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-sem-'));
  const w = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  w('package.json', JSON.stringify({
    name: 'semantics-fixture',
    dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0', 'react-router-dom': '^7.0.0', zustand: '^5.0.0' },
  }));
  w('src/main.tsx', [
    "import { createRoot } from 'react-dom/client';",
    "import App from './App';",
    "createRoot(document.getElementById('root')!).render(<App />);",
  ].join('\n'));
  w('src/App.tsx', [
    "import AppRoutes from './AppRoutes';",
    'export default function App() {',
    '  return <AppRoutes />;',
    '}',
  ].join('\n'));
  w('src/AppRoutes.tsx', [
    "import { Routes, Route } from 'react-router-dom';",
    "import HealthPage from './components/health/HealthPage';",
    "import DietPage from './features/diet/DietPage';",
    'export default function AppRoutes() {',
    '  return (',
    '    <Routes>',
    '      <Route path="/health" element={<HealthPage />} />',
    '      <Route path="/diet" element={<DietPage />} />',
    '    </Routes>',
    '  );',
    '}',
  ].join('\n'));
  w('src/components/health/HealthPage.tsx', [
    "import { useHealthStore } from '../../store/useHealthStore';",
    "import HealthCard from './HealthCard';",
    'export default function HealthPage() {',
    '  const items = useHealthStore((s) => s.items);',
    '  return <div><HealthCard />{items.length}</div>;',
    '}',
  ].join('\n'));
  w('src/components/health/HealthCard.tsx', [
    'export default function HealthCard() {',
    '  return <div>card</div>;',
    '}',
  ].join('\n'));
  w('src/features/diet/DietPage.tsx', [
    "import { useDietStore } from './store/useDietStore';",
    'export default function DietPage() {',
    '  const count = useDietStore((s) => s.count);',
    '  return <div>{count}</div>;',
    '}',
  ].join('\n'));
  w('src/features/diet/store/useDietStore.ts', [
    "import { create } from 'zustand';",
    'export const useDietStore = create((set) => ({',
    '  count: 0,',
    '  increment: () => set((s) => ({ count: s.count + 1 })),',
    '}));',
  ].join('\n'));
  w('src/store/useHealthStore.ts', [
    "import { create } from 'zustand';",
    'export const useHealthStore = create((set) => ({',
    '  items: [],',
    '  add: (item) => set({ items: [...item] }),',
    '}));',
  ].join('\n'));
  w('src/services/healthService.ts', [
    'export class HealthService {',
    "  async loadHealth() { return fetch('/api/health').then((r) => r.json()); }",
    '}',
  ].join('\n'));
  w('src/hooks/useHealthData.ts', [
    "import { useEffect } from 'react';",
    'export function useHealthData() {',
    '  useEffect(() => {}, []);',
    '}',
  ].join('\n'));
  w('src/utils/format.ts', 'export function formatDate(d: string) { return d; }');
  w('src/types/models.ts', 'export interface HealthRecord { id: string; }');
  return dir;
}

test('端到端：模块语义分层 + 功能域聚合 + 项目画像 + belongsTo 链接 + 导出报告', async () => {
  const dir = buildFixture();
  try {
    const dataMap = await buildOntologyData(dir);
    const modules = dataMap.Module;
    const modByPath = new Map(modules.map((m) => [m.path, m]));

    // 模块语义分层（内容信号驱动，而非目录名直译）
    assert.equal(modByPath.get('src/store')?.archLayer, 'state');
    assert.equal(modByPath.get('src/services')?.archLayer, 'service');
    assert.equal(modByPath.get('src/components/health')?.archLayer, 'presentation');
    assert.equal(modByPath.get('src/utils')?.archLayer, 'shared');
    assert.equal(modByPath.get('src/types')?.archLayer, 'types');
    assert.equal(modByPath.get('src/features/diet/store')?.archLayer, 'state');
    // feature-sliced 目录（UI + Store 混合）如实标记混合层，并展示层构成
    const dietFeature = modByPath.get('src/features/diet');
    assert.equal(dietFeature.archLayer, 'mixed');
    assert.ok(dietFeature.summary.includes('表现层'));
    assert.ok(dietFeature.summary.includes('状态层'));
    // 模块职责画像
    const healthMod = modByPath.get('src/components/health');
    assert.ok(healthMod.summary.startsWith('表现层：'));
    assert.ok(healthMod.summary.includes('组件 2'));
    assert.ok(healthMod.unitCounts.component === 2);
    assert.ok(healthMod.externalImportedByCount >= 1);

    // 功能域：health（路由 + 目录聚合）、diet（feature-sliced 全栈域）
    const domains = dataMap.Domain;
    const health = domains.find((d) => d.name === 'health');
    const diet = domains.find((d) => d.name === 'diet');
    assert.ok(health, 'health 域应存在');
    assert.ok(diet, 'diet 域应存在');
    assert.deepEqual(health.sources.sort(), ['module', 'route']);
    assert.equal(health.routeCount, 1);
    assert.equal(health.componentCount, 2);
    assert.ok(health.summary.includes('1 条路由'));
    assert.equal(diet.componentCount, 1);
    assert.equal(diet.storeCount, 1);
    assert.ok(diet.summary.includes('1 个 Store'));

    // 单元归属：架构层继承文件、功能域来自目录/路由
    const comp = dataMap.Component.find((c) => c.name === 'HealthPage');
    assert.equal(comp.archLayer, 'presentation');
    assert.ok(comp.domainIds.includes('dom:health'));
    assert.equal(comp.kind, 'page');
    const store = dataMap.Store.find((s) => s.name === 'useDietStore');
    assert.equal(store.archLayer, 'state');
    assert.ok(store.domainIds.includes('dom:diet'));
    const file = dataMap.SourceFile.find((f) => f.path === 'src/utils/format.ts');
    assert.equal(file.archLayer, 'shared');

    // 项目画像
    const proj = dataMap.Project[0];
    assert.ok(proj.summary.includes('React 单页应用'));
    assert.ok(proj.summary.includes('功能域 2 个'));
    assert.equal(proj.architecture.style, 'layered-spa');
    assert.ok(proj.architecture.layers.length >= 4);
    assert.equal(proj.architecture.layers[0].key, 'presentation');
    assert.ok(proj.capabilities.length === 2);

    // belongsTo 链接（双向）
    const blueprint = createBlueprint(dataMap);
    const members = blueprint.link('belongsTo', 'dom:diet');
    const memberIds = members.map((m) => m.id);
    assert.ok(memberIds.includes('comp:DietPage'));
    assert.ok(memberIds.includes('store:useDietStore'));
    const compDomain = blueprint.link('belongsTo', 'comp:DietPage');
    assert.deepEqual(compDomain.map((d) => d.id), ['dom:diet']);
    // contains：Project 直属功能域
    const projChildren = blueprint.link('contains', proj.id);
    assert.ok(projChildren.some((o) => o.id === 'dom:diet'));

    // 导出报告含执行摘要 / 架构总览 / 功能域地图
    const md = exportToMarkdown(dataMap);
    assert.ok(md.includes('执行摘要'));
    assert.ok(md.includes('架构总览（语义分层）'));
    assert.ok(md.includes('功能域地图（Domain）'));
    assert.ok(md.includes('React 单页应用'));
    assert.ok(md.includes('职责画像'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('端到端：油猴脚本仓库的域聚合与脚本层归层', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-sem-us-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts/steam'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts/steam/demo.user.js'), [
      '// ==UserScript==',
      '// @name         Demo',
      '// @version      1.0.0',
      '// @match        https://store.steampowered.com/*',
      '// @grant        GM_getValue',
      '// ==/UserScript==',
      '(function () {',
      "  'use strict';",
      '  function render() { document.body.innerHTML = "<b>x</b>"; }',
      '  render();',
      '})();',
    ].join('\n'));
    const dataMap = await buildOntologyData(dir);
    const proj = dataMap.Project[0];
    assert.equal(proj.framework, 'userscript');
    assert.equal(proj.architecture.style, 'script-collection');
    assert.ok(proj.summary.includes('油猴脚本集合'));
    assert.ok(proj.architecture.layers.some((l) => l.key === 'script'));
    // scripts/steam → 域 steam（父目录 scripts 为技术目录）
    const dom = dataMap.Domain.find((d) => d.name === 'steam');
    assert.ok(dom, 'steam 域应存在');
    assert.equal(dom.scriptCount, 1);
    const us = dataMap.UserScript[0];
    assert.equal(us.archLayer, 'script');
    assert.ok(us.domainIds.includes('dom:steam'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- buildDomains 纯函数：路由域与目录域归一合并 ----
test('buildDomains：路由域段与业务目录归一合并（大小写/分隔符不敏感）', () => {
  const modules = [
    { id: 'mod:src', name: 'src', path: 'src', parentId: null, depth: 1 },
    { id: 'mod:src/components', name: 'components', path: 'src/components', parentId: 'mod:src', depth: 2 },
    { id: 'mod:src/components/HealthTips', name: 'HealthTips', path: 'src/components/HealthTips', parentId: 'mod:src/components', depth: 3 },
  ];
  const fileObjects = [
    { id: 'file:src/components/HealthTips/Tips.tsx', path: 'src/components/HealthTips/Tips.tsx', lineCount: 10 },
  ];
  const routes = [{ id: 'route:/health-tips', domain: 'health-tips', description: '健康贴士', componentFileId: null }];
  const { domains } = buildDomains({
    routes, modules, fileObjects, components: [], stores: [], hooks: [], services: [], userScripts: [],
  });
  assert.equal(domains.length, 1);
  assert.equal(domains[0].name, 'health-tips');
  assert.deepEqual(domains[0].sources.sort(), ['module', 'route']);
  assert.equal(domains[0].fileCount, 1);
  assert.equal(domains[0].capability, '健康贴士');
});
