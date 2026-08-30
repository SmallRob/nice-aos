// 本体查看器（Viewer）——使用者层的"企业级知识中心"（对应参考架构中的 Web UI 消费者）
// 数据流：snapshot.json（DataMap）→ buildViewerModel()（数据聚合，viewerModel.js）→ renderViewerHtml()（视图层渲染）
// 视图：
//   1. 领域蓝图（Domain Blueprint）：每个功能域的业务层级构成 / 代码组织 / 单元清单
//   2. 业务数据图（Data Map）：Store 数据枢纽 + 跨域数据依赖
//   3. 业务逻辑流向（Logic Flow）：架构层间导入流向 + 跨域依赖 + 高扇入业务节点
//   4. 代码统计（Code Stats）：行数 / 语言 / 架构层 / 模块 / Top 单元规模画像（KPI + 条形图 + 环形图）
//   5. 代码图谱（Code Graph）：模块 / 组件两级依赖网络的力导向图（内联力模拟，零依赖可离线）
//   6. 实体类图（Entity Class Diagram）：Interface/Class 实体 UML 关系图（跨语言 TS/JS/Vue/Rust/Dart）
//   7. 脚本蓝图（Script Blueprint）：单脚本函数调用图 + DOM 注入锚点 + 网络端点
//   8. 本体概览（Ontology）：概念分类体系 + 对象/链接类型清单
// 油猴意图适配：无 React/Vue 结构的纯脚本仓库，视图 1/2/3 按函数意图（roles）重建
//   （意图功能域 / 存储枢纽 / 意图流转矩阵）；意图信号不足时视图置空并隐藏 Tab
// 原则：视图模型（JSON）独立于渲染，可被 AI agent 直接消费；HTML 自包含零依赖，可离线打开；
//       宽屏分档扩展内容宽度（1400 → 2400px），SVG 图等比自适应不截断

import { buildThemeCss, DEFAULT_THEMES } from '../themes/index.js';
import { SHARED_CSS } from '../themes/sharedCss.js';
import { BLUEPRINT_CSS } from './viewerStyles.js';
import { renderInteractive, renderActionCardHtml } from './viewerInteractive.js';
import { CLIENT_BASE } from './viewerClient.js';
export { buildViewerModel } from './viewerModel.js';

// ============================================================
// 视图层 —— 视图模型 → 自包含 HTML（零依赖，可离线打开）
// ============================================================
export function renderViewerHtml(model, options = {}) {
  const dataJson = JSON.stringify(model).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
  const theme = options.theme || DEFAULT_THEMES.code;
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${esc(theme)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(model.project.name)} · 本体蓝图查看器</title>
<style>
${buildThemeCss(theme, { '--teal': '#00b4ab', '--go': '#00add8' })}
${SHARED_CSS}
/* ---- 布局骨架固定，以下为代码蓝图专属样式 ---- */
${BLUEPRINT_CSS}
</style>
</head>
<body>
<header>
  <h1 id="v-title"></h1>
  <div class="sub" id="v-sub"></div>
  <nav class="tabs">
    <div class="tab active" data-tab="overview">总览</div>
    <div class="tab" data-tab="blueprint">领域蓝图</div>
    <div class="tab" data-tab="data">业务数据图</div>
    <div class="tab" data-tab="flow">业务逻辑流向</div>
    <div class="tab" data-tab="stats">代码统计</div>
    <div class="tab" data-tab="codegraph">代码图谱</div>
    <div class="tab" data-tab="routemap">路由地图</div>
    <div class="tab" data-tab="props">组件数据流</div>
    <div class="tab" data-tab="entities">实体类图</div>
    <div class="tab" data-tab="scripts">脚本蓝图</div>
    <div class="tab" data-tab="interactive">交互操作</div>
  </nav>
</header>
<main>
  <section class="view active" id="view-overview"></section>
  <section class="view" id="view-blueprint"></section>
  <section class="view" id="view-data"></section>
  <section class="view" id="view-flow"></section>
  <section class="view" id="view-stats"></section>
  <section class="view" id="view-codegraph"></section>
  <section class="view" id="view-routemap"></section>
  <section class="view" id="view-props"></section>
  <section class="view" id="view-entities"></section>
  <section class="view" id="view-scripts"></section>
  <section class="view" id="view-interactive"></section>
</main>
<script id="viewer-data" type="application/json">${dataJson}</script>
${CLIENT_BASE}` + renderInteractiveScript() + `
</body>
</html>`;
}

// 借鉴 asdm-aos v0.0.12 ActionPanel.tsx 设计：按对象类型过滤可用动作、点击对象自动填表单、提交走 fetch 调 nice-aos serve
// 不引入 React 运行时；这些函数会被注入到 HTML 蓝图的 <script> 块中
// 拼接 </script> 字符串避免被 HTML 解析器 / JS 解析器误识别

// top-level esc: renderViewerHtml 模板字符串插值与 renderInteractive 浏览器端调用的实际目标
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function endScript() { return '<' + '/script>'; }

function renderInteractiveScript() {
  // 通过拼字符串避免 </script> 提前终止 script 标签
  return [
    '\n<script>',
    '// 借鉴 asdm-aos v0.0.12 ActionPanel.tsx + DependencyGraph.tsx',
    renderInteractive.toString(),
    renderActionCardHtml.toString(),
    'if (M.interactive) renderInteractive();',
    endScript(),
  ].join('\n');
}
