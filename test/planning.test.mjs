// 产品规划 / PRD 文档蓝图子系统测试：扫描模型 / 快照往返 / 视图模型 / 蓝图 HTML / 审计 / 解析辅助
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { scanPlanningModel, parseMarkdownTables, extractOverview } from '../src/planning/docsScanner.js';
import {
  setPlanningSnapshotDir, getPlanningSnapshotPath, savePlanningSnapshot, loadPlanningSnapshot,
} from '../src/planning/docsSnapshot.js';
import { buildPlanningViewerModel, renderPlanningBlueprintHtml } from '../src/planning/docsViewer.js';
import { auditHealth } from '../src/planning/docsAuditor.js';
import { statusKey } from '../src/planning/docsModel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'planning-docs');

test('statusKey 状态归一化', () => {
  assert.equal(statusKey('🟡'), 'implementing');
  assert.equal(statusKey('🟢'), 'done');
  assert.equal(statusKey('🟣'), 'clarifying');
  assert.equal(statusKey('🟠'), 'designing');
  assert.equal(statusKey('🔴'), 'blocked');
  assert.equal(statusKey('实现中'), 'implementing');
  assert.equal(statusKey('完成'), 'done');
  assert.equal(statusKey('anything'), 'unknown');
});

test('parseMarkdownTables 解析表格', () => {
  const tables = parseMarkdownTables('## x\n\n| id | v |\n|---|--:|\n| a | 1 |\n| b | 2 |\n\n文字\n| c | 3 |\n|---|--:|\n| d | 4 |');
  assert.equal(tables.length, 2);
  assert.deepEqual(tables[0].header, ['id', 'v']);
  assert.equal(tables[0].rows.length, 2);
  assert.equal(tables[1].rows[0][0], 'd');
});

test('extractOverview 提取功能概述段落', () => {
  assert.equal(extractOverview('# F\n\n## 功能概述\n\n对各类资源提供细粒度读写权限控制。\n\n说明继续。'), '对各类资源提供细粒度读写权限控制。');
});

test('scanPlanningModel 解析特性/模块/依赖/里程碑/发布/主题', () => {
  const model = scanPlanningModel(FIXTURE_DIR);
  assert.equal(model.features.length, 4, '应解析出 4 个特性');

  const f1 = model.features.find((f) => f.id === 'FT-001');
  assert.equal(f1.title, '资源级权限控制');
  assert.equal(f1.status, 'implementing');
  assert.equal(f1.statusEmoji, '🟡');
  assert.equal(f1.priority, 'P1');
  assert.equal(f1.targetVersion, 'v1.2.1');
  assert.equal(f1.owner, '张三');
  assert.equal(f1.completion, 70, '从进展报告读取完成度');
  assert.equal(f1.openQuestionCount, 3, '§15 开放问题：2 个列表项 + 1 行问题表');
  assert.equal(f1.lastUpdated, '2026-05-18');
  assert.deepEqual(f1.depIds, ['FT-002', 'FT-041'], '依赖抽取');
  assert.ok(f1.description.includes('读写权限'), 'PRD §1 描述增强');

  const f41 = model.features.find((f) => f.id === 'FT-041');
  assert.equal(f41.status, 'designing');
  assert.equal(f41.completion, 40);

  // 模块
  assert.ok(model.modules.some((m) => m.label.includes('权限')), 'Modules 目录文档合并');
  const mcp = model.modules.find((m) => m.label === 'MCP');
  assert.ok(mcp && mcp.featureIds.includes('FT-041'));
  assert.ok(mcp.featureIds.includes('FT-042'));

  // 依赖
  assert.ok(model.dependencies.some((d) => d.source === 'FT-001' && d.target === 'FT-002'));

  // 里程碑
  assert.ok(model.milestones.some((m) => m.version === 'v1.2.1'), '里程碑含 v1.2.1');
  assert.ok(model.milestones.some((m) => m.version === 'v1.3.0'));

  // 发布
  assert.equal(model.releases.length, 1);
  assert.equal(model.releases[0].id, 'R03');

  // 主题
  assert.ok(model.themes.length >= 2, 'Roadmap 主题');

  // 统计
  assert.equal(model.stats.totalFeatures, 4);
  assert.equal(model._meta.fileCount > 0, true);
});

test('快照 save/load 往返', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-planning-'));
  setPlanningSnapshotDir(tmp);
  const model = scanPlanningModel(FIXTURE_DIR);
  const filePath = savePlanningSnapshot(model);
  assert.equal(filePath, getPlanningSnapshotPath());
  assert.ok(fs.existsSync(filePath));
  const loaded = loadPlanningSnapshot();
  assert.equal(loaded.features.length, model.features.length);
  assert.deepEqual(loaded.dependencies, model.dependencies);
});

test('buildPlanningViewerModel 视图模型字段齐全', () => {
  const model = scanPlanningModel(FIXTURE_DIR);
  const vm = buildPlanningViewerModel(model);
  assert.ok(Array.isArray(vm.features) && vm.features.length === 4);
  assert.ok(vm.stats && typeof vm.stats.totalFeatures === 'number');
  assert.ok(vm.distribution?.status?.implementing >= 1);
  assert.ok(Array.isArray(vm.modules) && vm.modules.length >= 2);
  assert.ok(Array.isArray(vm.dependencies));
  assert.ok(vm.audit && Array.isArray(vm.audit.dimensions));
  const f = vm.features[0];
  for (const k of ['id', 'title', 'moduleKey', 'moduleLabel', 'priority', 'targetVersion', 'owner', 'status', 'statusEmoji', 'description']) {
    assert.ok(k in f, `feature 缺少字段 ${k}`);
  }
});

test('renderPlanningBlueprintHtml 含 planning-viewer-data 且可解析', () => {
  const model = scanPlanningModel(FIXTURE_DIR);
  const html = renderPlanningBlueprintHtml(buildPlanningViewerModel(model), { theme: 'deep-blue' });
  assert.match(html, /planning-viewer-data/);
  const m = /<script id="planning-viewer-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, '应内嵌 planning-viewer-data');
  const parsed = JSON.parse(m[1]);
  assert.equal(parsed.features.length, 4);
  assert.ok(parsed.audit);
});

test('auditHealth 输出四维审计', () => {
  const model = scanPlanningModel(FIXTURE_DIR);
  const audit = auditHealth(model);
  assert.equal(typeof audit.score, 'number');
  const keys = audit.dimensions.map((d) => d.key);
  assert.deepEqual(keys.sort(), ['coverage', 'dependencyRisk', 'releasePlanning', 'statusHealth']);
  assert.ok(Array.isArray(audit.issues));
});

// ---- 浏览器脚本运行时冒烟：最小 DOM 垫片 + node:vm 执行内嵌主脚本 ----
// 回归背景：模板内 JS 曾直接引用 Node 模块作用域常量（MOD_COLORS / GRAPH_NODE_CAP），
// 静态 JSON/语法检查无法发现，只有真实执行浏览器脚本才能捕获 ReferenceError。
function makeStubEl(id) {
  const cls = new Set();
  const el = {
    id: id || '',
    children: [],
    options: [],
    value: '',
    textContent: '',
    clientWidth: 900,
    clientHeight: 620,
    dataset: {},
    style: {},
    tBodies: [{ innerHTML: '' }],
    classList: {
      add: (...cs) => cs.forEach((c) => cls.add(c)),
      remove: (...cs) => cs.forEach((c) => cls.delete(c)),
      contains: (c) => cls.has(c),
      toggle: (c, force) => { const on = force === undefined ? !cls.has(c) : force; on ? cls.add(c) : cls.delete(c); },
    },
    appendChild(c) { this.children.push(c); if (String(c.tagName).toLowerCase() === 'option') this.options.push(c); },
    addEventListener() {},
    querySelectorAll: () => [],
    setAttribute() {},
  };
  Object.defineProperty(el, 'innerHTML', { get() { return this._h || ''; }, set(v) { this._h = v; } });
  return el;
}

function runBrowserScript(html) {
  const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 2, '应包含 viewer-data 与主脚本两个 script 块');
  const dataBlock = blocks[0];
  const js = blocks[blocks.length - 1];

  const els = new Map();
  const dataEl = makeStubEl('planning-viewer-data');
  dataEl.textContent = dataBlock;
  els.set('planning-viewer-data', dataEl);

  const sandbox = {
    document: {
      title: 'test',
      documentElement: makeStubEl('html'),
      getElementById: (id) => { if (!els.has(id)) els.set(id, makeStubEl(id)); return els.get(id); },
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: () => makeStubEl(''),
    },
    location: { hash: '' },
    console,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox, { filename: 'planning-inline.js' });
  return { sandbox, els };
}

test('蓝图浏览器脚本运行时冒烟：无 ReferenceError，图谱可渲染', () => {
  const model = scanPlanningModel(FIXTURE_DIR);
  const html = renderPlanningBlueprintHtml(buildPlanningViewerModel(model));
  const { sandbox, els } = runBrowserScript(html); // 首次加载（含模块卡渲染）不应抛错

  assert.equal(typeof sandbox.renderFeatDep, 'function');
  assert.doesNotThrow(() => sandbox.renderFeatDep(), '特性依赖图渲染');
  assert.doesNotThrow(() => sandbox.renderFeatMod(), '特性-模块图渲染');

  const modHtml = els.get('modList')?._h || '';
  assert.ok(modHtml.includes('mod-card'), '模块卡应渲染');

  // 图谱坐标必须有效：回归背景 —— 力导向数值发散曾致全部 cx="NaN" 图谱空白
  for (const svgId of ['svgFeatDep', 'svgFeatMod']) {
    const svgHtml = els.get(svgId)?._h || '';
    const circles = svgHtml.match(/<circle [^>]*>/g) || [];
    assert.ok(circles.length > 0, `${svgId} 应渲染圆节点`);
    const valid = circles.filter((c) => /^<circle cx="[0-9]/.test(c));
    assert.equal(valid.length, circles.length, `${svgId} 所有圆坐标应为有限数值（实际有效 ${valid.length}/${circles.length}）`);
  }
});

test('图谱无内容时隐藏图谱 Tab 与子视图', () => {
  const model = scanPlanningModel(FIXTURE_DIR);
  // 剥离全部依赖与模块归属 → 图谱完全无内容
  const empty = {
    ...buildPlanningViewerModel(model),
    dependencies: [],
    features: model.features.map((f) => ({ ...f, moduleKey: '', moduleLabel: '' })),
    modules: [],
  };
  const { els } = runBrowserScript(renderPlanningBlueprintHtml(empty));
  assert.equal(els.get('tab-graph').style.display, 'none', '图谱 tab 应隐藏');
  assert.equal(els.get('view-graph').style.display, 'none', '图谱 section 应隐藏');
});

test('仅特性依赖无模块归属时隐藏「特性 × 模块」子视图并切换默认激活', () => {
  const model = scanPlanningModel(FIXTURE_DIR);
  const depsOnly = {
    ...buildPlanningViewerModel(model),
    features: model.features.map((f) => ({ ...f, moduleKey: '', moduleLabel: '' })),
    modules: [],
  };
  const { els } = runBrowserScript(renderPlanningBlueprintHtml(depsOnly));
  const tabGraph = els.get('tab-graph');
  assert.ok(!tabGraph || tabGraph.style.display !== 'none', '图谱 tab 应保留');
  assert.equal(els.get('gBtnFeatMod').style.display, 'none', '特性×模块子按钮应隐藏');
  assert.equal(els.get('svgFeatMod').style.display, 'none', '特性×模块 SVG 应隐藏');
});

test('仅模块归属无依赖时隐藏「特性依赖」子视图并默认激活「特性 × 模块」', () => {
  const model = scanPlanningModel(FIXTURE_DIR);
  const fmOnly = { ...buildPlanningViewerModel(model), dependencies: [] };
  const { els } = runBrowserScript(renderPlanningBlueprintHtml(fmOnly));
  assert.equal(els.get('gBtnFeatDep').style.display, 'none', '特性依赖子按钮应隐藏');
  assert.equal(els.get('svgFeatDep').style.display, 'none', '特性依赖 SVG 应隐藏');
  assert.equal(els.get('gBtnFeatDep').classList.contains('active'), false, 'featdep 不应激活');
  assert.equal(els.get('gBtnFeatMod').classList.contains('active'), true, 'featmod 按钮应激活');
  assert.equal(els.get('svgFeatMod').classList.contains('active'), true, 'featmod SVG 应激活');
});

// ---- 图谱交互与样式新增回归 ----
test('图谱 HTML 模板含 toolbar / legend / viewBox 占位 + 脚本挂载交互', () => {
  const model = scanPlanningModel(FIXTURE_DIR);
  const html = renderPlanningBlueprintHtml(buildPlanningViewerModel(model));
  // HTML 模板必须包含 container / toolbar / legend + 两个 SVG
  assert.ok(html.includes('id="graphContainer"'), 'HTML 应包含 graphContainer 容器');
  assert.ok(html.includes('class="graph-toolbar"'), 'HTML 应包含 graphToolbar');
  assert.ok(html.includes('id="graphLegend"'), 'HTML 应包含 graphLegend 占位');
  assert.ok(html.includes('id="svgFeatDep"'), 'HTML 应包含 svgFeatDep');
  assert.ok(html.includes('id="svgFeatMod"'), 'HTML 应包含 svgFeatMod');
  // toolbar 三个按钮（缩放-/+/重置）
  assert.ok(/data-z="-"/.test(html) && /data-z="\+"/.test(html) && /data-z="r"/.test(html), 'toolbar 应含缩放与重置');
  // 交互函数（顶级声明成为 sandbox 全局属性）
  const { sandbox } = runBrowserScript(html);
  assert.equal(typeof sandbox.graphZoomBy, 'function', 'graphZoomBy 函数应可调用');
  assert.equal(typeof sandbox.graphReset, 'function', 'graphReset 函数应可调用');
  assert.equal(typeof sandbox.initGraphInteraction, 'function', 'initGraphInteraction 应暴露');
});

test('特性依赖图节点为 g.g-node + 边为 path.g-edge，数据属性可定位高亮', () => {
  const model = scanPlanningModel(FIXTURE_DIR);
  const { sandbox, els } = runBrowserScript(renderPlanningBlueprintHtml(buildPlanningViewerModel(model)));
  sandbox.renderFeatDep(); // 沙盒不主动渲染图谱，需手动触发
  const depHtml = els.get('svgFeatDep')._h || '';
  // 节点 group 形式（旧 <circle> 节点仍保留为内核，保证旧断言不破）
  assert.ok(/<g[^>]*class="g-node"/.test(depHtml), '依赖图应输出 g.g-node 节点');
  assert.ok(/data-id="FT-/.test(depHtml), '节点 data-id 应携带特性 ID');
  // 边：path + class=g-edge + data-from / data-to
  assert.ok(/<path[^>]*class="g-edge"/.test(depHtml), '依赖图应输出 path.g-edge 边');
  assert.ok(/data-from="FT-/.test(depHtml) && /data-to="FT-/.test(depHtml), '边应携带 data-from / data-to');
});

test('特性 × 模块图为分层分列布局：列背景 + 模块节点 + 特性节点', () => {
  const model = scanPlanningModel(FIXTURE_DIR);
  const { sandbox, els } = runBrowserScript(renderPlanningBlueprintHtml(buildPlanningViewerModel(model)));
  sandbox.renderFeatMod(); // 沙盒不主动渲染图谱
  const modHtml = els.get('svgFeatMod')._h || '';
  assert.ok(/<rect[^>]*class="g-col-bg"/.test(modHtml), '分层布局应输出列背景矩形');
  assert.ok(/data-id="M:/.test(modHtml), '应输出模块节点 M:<key>');
  assert.ok(/data-id="F:/.test(modHtml), '应输出特性节点 F:<id>');
  assert.ok(/<text[^>]*class="g-col-label"/.test(modHtml), '应输出列标签');
});

test('图例渲染：状态色节点 + 边类型', () => {
  const model = scanPlanningModel(FIXTURE_DIR);
  const { sandbox, els } = runBrowserScript(renderPlanningBlueprintHtml(buildPlanningViewerModel(model)));
  sandbox.renderFeatDep(); // 触发依赖图渲染，会顺带写入 legend
  const legendHtml = els.get('graphLegend')?._h || '';
  assert.ok(/<span[^>]*class="dot"/.test(legendHtml), '图例应含状态色 dot');
  assert.ok(legendHtml.includes('依赖') || legendHtml.includes('特性归属'), '图例应含边类型说明');
});

test('forceLayout 确定性：相同输入两次结果完全一致（同 id → 同坐标）', () => {
  const model = scanPlanningModel(FIXTURE_DIR);
  const { sandbox } = runBrowserScript(renderPlanningBlueprintHtml(buildPlanningViewerModel(model)));
  assert.equal(typeof sandbox.hashPos, 'function', 'hashPos 应作为工具函数暴露');
  const a = sandbox.hashPos('FT-001', 800, 600, 60);
  const b = sandbox.hashPos('FT-001', 800, 600, 60);
  assert.deepEqual(a, b, '同 id 同尺寸应得到一致初始坐标');
  const c = sandbox.hashPos('FT-002', 800, 600, 60);
  assert.notDeepEqual(a, c, '不同 id 应得到不同坐标');
});