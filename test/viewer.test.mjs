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

// 执行内嵌渲染脚本（DOM stub），验证架构分层排版：层名单行 + 描述副行，无双括号拼接
test('架构分层条形图：层名不换行压缩、描述独立副行（无括号拼接）', async () => {
  const dir = buildFixture();
  try {
    const dataMap = await buildOntologyData(dir);
    const model = buildViewerModel(dataMap);
    const html = renderViewerHtml(model);

    const dataJson = html.match(/<script id="viewer-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
    const script = html.match(/<script>\n([\s\S]*?)<\/script>\s*<\/body>/)[1];
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

    const overview = makeEl('view-overview').innerHTML;
    const archIdx = overview.indexOf('<h2>架构分层</h2>');
    const section = overview.slice(archIdx, overview.indexOf('<h2>功能域清单'));
    const layers = model.project.architecture.layers;
    assert.ok(layers.length >= 2, 'fixture 应有多层');
    // 每层一个主行 + 一条描述副行
    assert.equal((section.match(/lr-main/g) || []).length, layers.length);
    assert.equal((section.match(/lr-desc/g) || []).length, layers.length);
    // 层名在标签列内完整呈现（不被描述文字撑爆）
    for (const l of layers) {
      assert.ok(section.includes(`>${l.label}</span>`), `层名 ${l.label} 应独立成标签`);
    }
    // 描述不再与层名括号拼接
    assert.ok(!/（[^（）]*（/.test(section), '不应出现括号嵌套拼接');
    assert.ok(section.includes(layers[0].description), '描述应出现在副行');
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
    assert.equal(model.scriptBlueprint, null); // 无油猴脚本 → 脚本蓝图整体为 null
    const html = renderViewerHtml(model);
    assert.ok(html.includes('未检测到状态管理'));
    assert.ok(html.includes("data-tab=\"scripts\""), '脚本蓝图 Tab 始终存在（无脚本时隐藏）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- fixture：类风格油猴脚本（函数调用图 + DOM 注入锚点 + 网络端点的逻辑注入链）----
const SCRIPT_FIXTURE = [
  '// ==UserScript==',
  '// @name         Panel Demo',
  '// @version      1.2.0',
  '// @match        https://example.com/*',
  '// @grant        GM_xmlhttpRequest',
  '// @grant        GM_setValue',
  '// @connect      api.example.com',
  '// ==/UserScript==',
  '(function () {',
  "  'use strict';",
  '  class Panel {',
  '    constructor() {',
  '      this.mount();',
  '    }',
  '    mount() {',
  "      const host = document.querySelector('#app');",
  "      if (host) host.innerHTML = '<div class=\"panel\">loading</div>';",
  '    }',
  '    load() {',
  '      GM_xmlhttpRequest({',
  "        method: 'GET',",
  "        url: 'https://api.example.com/v1/data',",
  '        onload: (res) => this.update(JSON.parse(res.responseText)),',
  '      });',
  '    }',
  '    update(data) {',
  "      GM_setValue('last', data);",
  "      const host = document.querySelector('#app');",
  '      if (host) host.innerHTML = `<div>${data.name}</div>`;',
  '    }',
  '  }',
  '  const panel = new Panel();',
  '  panel.load();',
  '})();',
].join('\n');

test('脚本蓝图：函数调用图 + 注入锚点 + 网络端点一图聚合', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-viewer-script-'));
  try {
    fs.writeFileSync(path.join(dir, 'panel.user.js'), SCRIPT_FIXTURE);
    const dataMap = await buildOntologyData(dir);
    const model = buildViewerModel(dataMap);

    const sb = model.scriptBlueprint;
    assert.ok(sb, '应有脚本蓝图');
    assert.equal(sb.scriptCount, 1);
    assert.equal(sb.totalFunctionCount, 5); // Panel + constructor + mount/load/update
    assert.equal(sb.totalInjectionCount, 1);
    assert.equal(sb.totalNetworkCount, 1);
    assert.ok(sb.roleMeta.length >= 6, '应内置六类角色元数据');

    const s = sb.scripts[0];
    assert.equal(s.name, 'Panel Demo');
    assert.equal(s.version, '1.2.0');
    assert.deepEqual(s.matches, ['https://example.com/*']);
    // 图节点：调用关系内联（constructor→mount / load→update）
    const node = (n) => s.graph.nodes.find((x) => x.name === n);
    assert.ok(node('Panel.constructor'));
    assert.deepEqual(node('Panel.constructor').calls, ['Panel.mount']);
    assert.ok(node('Panel.update').calledBy.includes('Panel.load'));
    assert.ok(node('Panel.constructor').isEntry, 'new Panel() 入口应标记');
    assert.ok(node('Panel.load').isEntry, 'panel.load() 顶层调用应标记');
    assert.deepEqual(node('Panel.update').roles, ['render', 'state']);
    // 注入锚点：目标还原为页面选择器 + 归属函数
    const inj = s.graph.anchors.injections[0];
    assert.equal(inj.target, "querySelector('#app')");
    assert.deepEqual(inj.fns, ['Panel.mount', 'Panel.update']);
    // 网络锚点：域名 + 归属函数
    const net = s.graph.anchors.networks[0];
    assert.equal(net.domain, 'api.example.com');
    assert.deepEqual(net.fns, ['Panel.load']);
    // 函数清单与角色分布（render=3：Panel 类容器 + mount + update，层级归属）
    assert.ok(s.functionTable.length === 5);
    assert.equal(s.roleCounts.render, 3);
    assert.equal(s.roleCounts.data, 2);

    // HTML 渲染：脚本蓝图 Tab + SVG 调用图由前端数据驱动生成
    const html = renderViewerHtml(model);
    assert.ok(html.includes('脚本蓝图'), '应有脚本蓝图标签页');
    const m = html.match(/<script id="viewer-data" type="application\/json">([\s\S]*?)<\/script>/);
    const parsed = JSON.parse(m[1]);
    assert.equal(parsed.scriptBlueprint.scripts[0].graph.nodes.length, 5);
    assert.ok(html.includes('buildScriptGraphSvg'), '应内置 SVG 调用图生成器');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
