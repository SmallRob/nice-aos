// 本体查看器（Viewer）测试：视图模型聚合（领域蓝图/业务数据图/逻辑流向）+ HTML 渲染 + 端到端
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildViewerModel, renderViewerHtml } from '../src/ontology/viewer.js';
import { buildOntologyData } from '../src/ontology/builder.js';

// ---- fixture：React 分层布局 + 跨域依赖（health 域组件使用 diet 域 Store）----
function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-viewer-'));
  const w = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  w('package.json', JSON.stringify({
    name: 'viewer-fixture',
    dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0', 'react-router-dom': '^7.0.0', zustand: '^5.0.0' },
  }));
  w('src/main.tsx', [
    "import App from './App';",
    'const root = App;',
  ].join('\n'));
  w('src/App.tsx', [
    "import AppRoutes from './AppRoutes';",
    'export default function App() { return <AppRoutes />; }',
  ].join('\n'));
  w('src/AppRoutes.tsx', [
    "import { Routes, Route } from 'react-router-dom';",
    "import HealthPage from './components/health/HealthPage';",
    "import DietPage from './components/diet/DietPage';",
    'export default function AppRoutes() {',
    '  return (<Routes>',
    '    <Route path="/health" element={<HealthPage />} />',
    '    <Route path="/diet" element={<DietPage />} />',
    '  </Routes>);',
    '}',
  ].join('\n'));
  // health 域：组件（表现层）
  w('src/components/health/HealthPage.tsx', [
    "import { useDietStore } from '../../stores/diet/useDietStore';",
    "import HealthCard from './HealthCard';",
    'export default function HealthPage() {',
    '  const items = useDietStore((s) => s.items);',
    '  return <div><HealthCard />{items.length}</div>;',
    '}',
  ].join('\n'));
  w('src/components/health/HealthCard.tsx', 'export default function HealthCard() { return <div>card</div>; }');
  // diet 域：Store（状态层）
  w('src/stores/diet/useDietStore.ts', [
    "import { create } from 'zustand';",
    'export const useDietStore = create((set) => ({',
    '  items: [],',
    '  load: (xs) => set({ items: xs }),',
    '}));',
  ].join('\n'));
  // diet 域：页面组件使用本域 Store
  w('src/components/diet/DietPage.tsx', [
    "import { useDietStore } from '../../stores/diet/useDietStore';",
    'export default function DietPage() {',
    '  const load = useDietStore((s) => s.load);',
    '  return <div onClick={load}>diet</div>;',
    '}',
  ].join('\n'));
  // 共享服务（被 health 组件导入 → 表现层 → 业务层流向）
  w('src/services/analysisService.ts', [
    'export function analyze(items) { return items.length; }',
  ].join('\n'));
  w('src/components/health/HealthPage.tsx.bak', '');
  return dir;
}

test('buildViewerModel：视图模型结构完整（蓝图 schema / 项目 / 域 / 数据图 / 流向）', async () => {
  const dir = buildFixture();
  try {
    fs.rmSync(path.join(dir, 'src/components/health/HealthPage.tsx.bak'));
    const dataMap = await buildOntologyData(dir);
    const model = buildViewerModel(dataMap);

    // 本体蓝图 schema
    assert.equal(model.blueprint.version, '2.0');
    assert.ok(model.blueprint.objectTypes.length >= 15);
    assert.ok(model.blueprint.objectTypes.every((t) => 'category' in t && 'level' in t && 'count' in t));
    assert.ok(model.blueprint.linkTypes.includes('belongsTo'));
    assert.ok(model.blueprint.objectCounts.Domain > 0);

    // 项目画像透传
    assert.equal(model.project.name, 'viewer-fixture');
    assert.ok(model.project.summary);
    assert.ok(model.project.architecture.layers.length > 0);
    assert.ok(model.project.health);

    // 领域蓝图
    assert.ok(model.domainCount >= 2);
    const diet = model.domains.find((d) => d.name === 'diet');
    assert.ok(diet, '应聚合出 diet 功能域');
    assert.ok(diet.layerComposition.some((l) => l.key === 'state' || l.key === 'presentation'));
    assert.ok(diet.units.stores.some((s) => s.name === 'useDietStore'));
    assert.ok(diet.counts.components >= 1);

    // 业务数据图：useDietStore 被 health 域文件使用（跨域数据依赖）
    const store = model.dataMap.stores.find((s) => s.name === 'useDietStore');
    assert.ok(store, '应有 useDietStore 数据枢纽');
    assert.ok(store.usedByFileCount >= 2);
    assert.ok(store.usedBy.some((p) => p.includes('HealthPage')));
    assert.ok(store.usedByDomains.some((u) => u.name === 'health'));
    const cross = model.dataMap.crossDomainData.find((e) => e.from === 'health' && e.to === 'diet');
    assert.ok(cross, '应存在 health → diet 跨域数据依赖');

    // 业务逻辑流向：表现层 → 状态层 / 业务层
    const flowKeys = model.logicFlow.layerFlow.map((e) => `${e.from}>${e.to}`);
    assert.ok(flowKeys.includes('presentation>state'), `应有 presentation>state 流向，实际: ${flowKeys.join(',')}`);
    assert.ok(model.logicFlow.layerFlowTotal > 0);
    assert.ok(model.logicFlow.domainEdges.some((e) => e.from === 'health' && e.to === 'diet'));
    assert.ok(model.logicFlow.hubServices.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderViewerHtml：自包含 HTML + 嵌入数据可无损解析', async () => {
  const dir = buildFixture();
  try {
    fs.rmSync(path.join(dir, 'src/components/health/HealthPage.tsx.bak'));
    const dataMap = await buildOntologyData(dir);
    const model = buildViewerModel(dataMap);
    const html = renderViewerHtml(model);

    assert.ok(html.startsWith('<!DOCTYPE html>'));
    // 四个视图标签页
    for (const tab of ['总览', '领域蓝图', '业务数据图', '业务逻辑流向']) {
      assert.ok(html.includes(tab), `缺少标签页: ${tab}`);
    }
    // 嵌入数据可完整解析回来（防 </script> 注入截断）
    const m = html.match(/<script id="viewer-data" type="application\/json">([\s\S]*?)<\/script>/);
    assert.ok(m, '应嵌入 viewer-data JSON');
    const parsed = JSON.parse(m[1]);
    assert.equal(parsed.project.name, 'viewer-fixture');
    assert.equal(parsed.domainCount, model.domainCount);
    // 无外部依赖（零 CDN / 零外链脚本）
    assert.ok(!/src=["']https?:/.test(html), 'HTML 应零外部依赖');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('viewmodel 对空数据仓库的降级（无 Store / 无路由）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-viewer-empty-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'empty-repo', dependencies: {} }));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/thing.ts'), 'export const x = 1;\n');
    const dataMap = await buildOntologyData(dir);
    const model = buildViewerModel(dataMap);
    assert.equal(model.dataMap.stores.length, 0);
    assert.equal(model.dataMap.crossDomainData.length, 0);
    const html = renderViewerHtml(model);
    assert.ok(html.includes('未检测到状态管理'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
