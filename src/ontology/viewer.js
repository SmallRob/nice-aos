// 本体查看器（Viewer）——使用者层的"企业级知识中心"（对应参考架构中的 Web UI 消费者）
// 数据流：snapshot.json（DataMap）→ buildViewerModel()（数据聚合）→ renderViewerHtml()（视图层渲染）
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

import { ARCH_LAYERS } from './semantics.js';
import { ONTOLOGY_META, OBJECT_TYPES, LINK_TYPES } from './blueprint.js';
import { ACTION_DEFS } from './actionDefs.js'; // E-2：纯定义单源（blueprintActions.js 仍 re-export 兼容）
import { buildThemeCss, DEFAULT_THEMES } from '../themes/index.js';
import { SHARED_CSS } from '../themes/sharedCss.js';
import { BLUEPRINT_CSS } from './viewerStyles.js';
import { renderInteractive, renderActionCardHtml } from './viewerInteractive.js';
import { CLIENT_BASE } from './viewerClient.js';
export { buildViewerModel } from './viewerModel.js';

// 大仓库保护：单元清单按上限截断（计数保留全量，列表供浏览）
const UNIT_CAP = { components: 200, hooks: 120, stores: 100, services: 150, userScripts: 60, routes: 100 };
const USED_BY_CAP = 30;
const HUB_CAP = 15;
const MODULE_CAP = 150;

// 脚本蓝图保护：图节点/锚点/清单截断（大油猴仓库单脚本可达数千函数）
const SCRIPT_CAP = 24;
const SCRIPT_NODE_CAP = 50;
const SCRIPT_TABLE_CAP = 40;
const SCRIPT_INJECT_CAP = 20;
const SCRIPT_NET_CAP = 12;

// 实体类图保护：图节点 / 实体清单 / 每框成员上限（大仓库类实体可达数百个）
const ENTITY_NODE_CAP = 48;
const ENTITY_GRAPH_MIN = 24;
const ENTITY_TABLE_CAP = 120;
const ENTITY_MEMBER_CAP = 6;

// 代码图谱保护：力导向图节点 / 边上限（大仓库模块/组件可达数百个）
const MODULE_GRAPH_NODE_CAP = 90;
const COMPONENT_GRAPH_NODE_CAP = 130;
const STORE_GRAPH_NODE_CAP = 36;
const GRAPH_EDGE_CAP = 600;

// 脚本函数业务角色（与解析器 inferRoles 对应）；desc 为意图描述，供脚本意图功能域展示
const SCRIPT_ROLE_META = {
  render: { label: '渲染注入', color: '#58a6ff', desc: '向页面注入与渲染 DOM 内容' },
  data: { label: '数据获取', color: '#bc8cff', desc: '发起网络请求获取外部数据' },
  state: { label: '状态存取', color: '#3fb950', desc: '读写持久化状态（GM 存储 / localStorage）' },
  event: { label: '事件监听', color: '#d29922', desc: '监听事件 / 观察 DOM 变化 / 定时器' },
  ui: { label: '元素构建', color: '#39c5cf', desc: '创建与组装页面元素' },
  logic: { label: '纯逻辑', color: '#8b949e', desc: '纯计算与流程控制' },
};

const layerLabel = (key) => ARCH_LAYERS[key]?.label ?? key;

// ============================================================
// 第一部分：数据聚合 —— DataMap → 视图模型（JSON）
// ============================================================

// ============================================================
// 第二部分：视图层 —— 视图模型 → 自包含 HTML（零依赖，可离线打开）
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
${CLIENT_BASE}
` + renderInteractiveScript() + `
</script>` + renderInteractiveScript() + `
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


