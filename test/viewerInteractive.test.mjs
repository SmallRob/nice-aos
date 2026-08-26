// viewer 交互动作（interactive）端到端测试：
//   验证 viewer.js 通过 interactive.actionDefs 暴露的 4 个动作（markReviewed/addNote/refreshRepo/analyzeFile）
//   在最终 HTML 蓝图里都被序列化到 <script id="viewer-data"> 中，供前端 JS 动态渲染动作卡片。
//
// 回归保护：0002-code-review-report.md P0-2 "viewer.js 缺 analyzeFile 动作"
// 历史上 v0.31.0 时该缺陷存在；v0.32.0 修复后（viewer 改为引用 ACTION_DEFS 单一数据源）需锁住状态。
//
// 渲染机制说明：4 张动作卡片是浏览器端 renderInteractive() 在用户点击"对象选择"中某对象时
// 动态插入到 #bp-actions-col 的；服务端 renderViewerHtml 输出的是骨架（标题+空容器+viewer-data JSON）。
// 因此 HTML 本身只含 1 个空 .bp-actions-col 容器 + 序列化 JSON，不含 4 张 form。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildViewerModel, renderViewerHtml } from '../src/ontology/viewer.js';
import { ACTION_DEFS, buildActionCards } from '../src/ontology/blueprintActions.js';

// 最小 dataMap：让 buildViewerModel 走到 interactive 段
const MIN_DATA = {
  _meta: { generatedAt: '2026-08-22T00:00:00.000Z', cycles: [], orphanCandidates: [] },
  Project: [{ id: 'proj:t', name: 'interactive-test', framework: 'react' }],
  SourceFile: [],
  Component: [],
  Module: [],
  Domain: [],
};

test('viewer model.interactive.actionDefs 含全部 4 个动作（markReviewed/addNote/refreshRepo/analyzeFile）', () => {
  const model = buildViewerModel(MIN_DATA);
  const names = model.interactive.actionDefs.map((a) => a.name).sort();
  assert.deepEqual(names, ['addNote', 'analyzeFile', 'markReviewed', 'refreshRepo']);
});

test('viewer model.interactive.endpoint = "/action"', () => {
  const model = buildViewerModel(MIN_DATA);
  assert.equal(model.interactive.endpoint, '/action');
});

test('viewer model.interactive.actionDefs 与 ACTION_DEFS 同一引用（防 P1-1 独立定义漂移）', () => {
  const model = buildViewerModel(MIN_DATA);
  assert.equal(model.interactive.actionDefs, ACTION_DEFS, 'viewer.interactive.actionDefs 应 === ACTION_DEFS（同一引用）');
});

test('viewer HTML 含 <script id="viewer-data"> 序列化（含 interactive.actionDefs）', () => {
  const html = renderViewerHtml(buildViewerModel(MIN_DATA), { theme: 'deep-blue' });
  // viewer-data 脚本块是 viewer 数据的 JSON 序列化
  assert.match(html, /<script[^>]*id="viewer-data"/, 'HTML 应含 <script id="viewer-data">');
  // 序列化 JSON 中含 4 个动作名（前端 JS 读取后渲染动作卡片）
  for (const a of ACTION_DEFS) {
    assert.ok(html.includes(`"name":"${a.name}"`) || html.includes(`"name": "${a.name}"`),
      `viewer-data 应含 "${a.name}"`);
  }
  assert.match(html, /"endpoint":"\/action"/, 'viewer-data 应含 endpoint=/action');
});

test('viewer HTML 含"交互操作"区块标题 + 空容器 #bp-actions-col + 对象选择器', () => {
  const html = renderViewerHtml(buildViewerModel(MIN_DATA), { theme: 'deep-blue' });
  assert.match(html, /<div class="tab"[^>]*data-tab="interactive"/, '应有 interactive Tab 标题');
  assert.match(html, /<section class="view"[^>]*id="view-interactive"/, '应有 view-interactive 容器');
  assert.match(html, /<h2>交互操作<\/h2>/, '应有"交互操作" 区块标题');
  assert.match(html, /id="bp-actions-col"/, '应有 bp-actions-col 空容器（前端 JS 动态填充）');
  assert.match(html, /id="bp-obj-search"/, '应有对象搜索框');
  assert.match(html, /id="bp-type-filter"/, '应有类型筛选下拉');
});

test('viewer 前端 renderInteractive 注入 4 个动作卡片（脚本块含完整逻辑）', () => {
  const html = renderViewerHtml(buildViewerModel(MIN_DATA), { theme: 'deep-blue' });
  // 渲染函数必须出现在第二个 script 块（依赖 M.interactive）
  assert.match(html, /function renderInteractive\(\)/, 'HTML 应含 renderInteractive 函数');
  assert.match(html, /I\.actionDefs\.map/, 'renderInteractive 应遍历 actionDefs');
  // 4 个动作名在源代码里都被引用（不是仅在 viewer-data JSON 里）
  for (const a of ACTION_DEFS) {
    assert.match(html, new RegExp(`'${a.name}'|"${a.name}"`),
      `renderInteractive 源码应引用 ${a.name}`);
  }
});

test('buildActionCards：未选中对象时返回 4 张卡片（3 张 applicable + 1 张 Project 专属）', () => {
  // 这个验证 4 个动作都进入 buildActionCards 流程（即使非 applicable）
  const cards = buildActionCards({ selectedObjId: null, selectedObjType: null });
  assert.equal(cards.length, 4, '未选中时应返回全部 4 张卡片（即使 applicableNow=false）');
  const names = cards.map((c) => c.name).sort();
  assert.deepEqual(names, ['addNote', 'analyzeFile', 'markReviewed', 'refreshRepo']);
});

