// 后端服务蓝图 service-blueprint HTML 生成器
// 数据流：asdm-aos snapshot.json → ServiceModel → buildServiceViewerModel()（视图模型）→ renderServiceBlueprintHtml()（HTML）
// 九个视图：
//   1. 总览：仓库统计 + 技术栈 chips + 仓库信息
//   2. 模块：模块表（包/类/接口/方法/端点/职责）+ 模块柱状图
//   3. 分层：接口层/业务层/数据访问/Mapper/实体/DTO/配置/适配/任务/工具 卡片
//   4. 图谱：力导向图三视图（模块依赖 / 分层调用流 / 模块×技术栈）
//   5. API 面：HTTP 方法分布 + 端点表（搜索过滤）
//   6. 数据层：表网格 + FK 链 + 孤儿表清单
//   7. 依赖与集成：技术栈摘要 + 按分类分组的依赖表
//   8. 代码质量：复杂度热点 TOP + 测试统计
//   9. 健康审计：评分环 + 五维得分 + 问题清单

import { auditHealth, runAllServiceAudits } from './serviceAuditor.js';
import { buildThemeCss, DEFAULT_THEMES } from '../themes/index.js';
import { SHARED_CSS } from '../themes/sharedCss.js';
import { RING_JS } from '../themes/ring.js';

const ENDPOINT_DISPLAY_CAP = 2000;
const TABLE_DISPLAY_CAP = 500;
const HOTSPOT_DISPLAY_CAP = 50;

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtLocalTime(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return String(iso || '').replace('T', ' ').slice(0, 19);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

const HTTP_METHOD_COLORS = {
  GET: '#4ade80', POST: '#58a6ff', PUT: '#fbbf24', PATCH: '#f472b6', DELETE: '#f85149', OPTIONS: '#a78bfa', HEAD: '#a78bfa',
};
const LAYER_COLORS = {
  controller: '#f472b6', service: '#4ade80', repository: '#fb923c', mapper: '#f87171',
  entity: '#22d3ee', dto: '#38bdf8', config: '#94a3b8', adapter: '#a78bfa', job: '#fbbf24', util: '#64748b', other: '#8b949e',
};
const MODULE_SOURCE_LABELS = {
  cli: '自定义模块规则(--module-prefix)',
  config: '模块配置文件加载',
  derived: '模块动态推导',
  custom: '自定义模块规则',
  default: '模块动态推导',
};
const MODULE_GRAPH_COLORS = ['#39c5cf', '#58a6ff', '#3fb950', '#d29922', '#f472b6', '#818cf8', '#fb923c', '#00b4ab', '#f87171', '#bc8cff', '#4ade80', '#22d3ee'];

export function buildServiceViewerModel(model) {
  const meta = model._meta || {};
  const stats = model.stats || {};
  const modules = model.modules || [];
  const layers = model.layers || [];
  const endpoints = (model.endpoints || []).slice(0, ENDPOINT_DISPLAY_CAP);
  const tables = (model.tables || []).slice(0, TABLE_DISPLAY_CAP);
  const orphanTables = (model.tables || []).filter((t) => t.isOrphan).slice(0, 100);
  const dependencies = model.dependencies || [];
  const complexityHotspots = (model.complexityHotspots || []).slice(0, HOTSPOT_DISPLAY_CAP);

  // 依赖按技术栈分类分组（保序）
  const depsByCategory = {};
  for (const d of dependencies) {
    (depsByCategory[d.category] = depsByCategory[d.category] || []).push(d);
  }
  const techStack = model.techStack || [];

  // 模块柱状图数据
  const maxModuleClasses = Math.max(1, ...modules.map((m) => m.classCount));
  const moduleBars = modules.map((m) => ({ ...m, barPct: Math.round((m.classCount / maxModuleClasses) * 100) }));

  // 分层柱状图数据
  const maxLayerClasses = Math.max(1, ...layers.map((l) => l.classCount));
  const layerBars = layers.map((l) => ({ ...l, barPct: Math.round((l.classCount / maxLayerClasses) * 100), color: LAYER_COLORS[l.key] || '#64748b' }));

  const audits = runAllServiceAudits(model);
  // health.audits 与顶层 audits 内容重复，嵌入时剔除以减小 HTML 体积（审计只算一次并复用）
  const { audits: _nestedAudits, ...health } = auditHealth(model, audits);

  // 图谱数据：模块依赖 / 分层调用流（节点配色服务端赋好，客户端零映射）
  const rawGraph = model.moduleGraph;
  let moduleGraph = null;
  if (rawGraph) {
    const decorate = (g, colorOf) => (g ? {
      ...g,
      nodes: g.nodes.map((n, i) => ({ ...n, color: colorOf(n, i) })),
    } : null);
    moduleGraph = {
      moduleView: decorate(rawGraph.moduleView, (n, i) => MODULE_GRAPH_COLORS[i % MODULE_GRAPH_COLORS.length]),
      layerView: decorate(rawGraph.layerView, (n) => LAYER_COLORS[n.key] || '#8b949e'),
      techView: decorate(rawGraph.techView, (n, i) => (String(n.id).startsWith('tech:') ? '#bc8cff' : MODULE_GRAPH_COLORS[i % MODULE_GRAPH_COLORS.length])),
    };
  }

  return {
    meta: {
      repositoryName: meta.repositoryName || '',
      snapshotPath: meta.snapshotPath || '',
      scannedAt: meta.scannedAt || '',
      modulePrefixSource: meta.modulePrefixSource || 'default',
      ...stats,
    },
    stats,
    techStack,
    modules: moduleBars,
    layers: layerBars,
    moduleGraph,
    endpoints,
    endpointByMethod: stats.endpointByMethod || {},
    endpointTruncated: (model.endpoints || []).length > ENDPOINT_DISPLAY_CAP,
    tables,
    tableTruncated: (model.tables || []).length > TABLE_DISPLAY_CAP,
    orphanTables,
    fkChains: model.fkChains || [],
    dependencies,
    depsByCategory,
    techStackOrder: techStack.map((t) => t.key),
    complexityHotspots,
    hotspotsTruncated: (model.complexityHotspots || []).length > HOTSPOT_DISPLAY_CAP,
    testStats: model.testStats || {},
    repositories: model.repositories || [],
    audits: { health, ...audits },
  };
}

export function renderServiceBlueprintHtml(model, options = {}) {
  const dataJson = JSON.stringify(model).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
  const title = esc(model.meta.repositoryName || (model.meta.snapshotPath ? model.meta.snapshotPath.split('/').pop() : '后端服务'));
  const theme = options.theme || DEFAULT_THEMES.service;

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${esc(theme)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} · 后端服务蓝图</title>
<style>
${buildThemeCss(theme)}
${SHARED_CSS}
/* ---- 布局骨架固定，以下为服务蓝图专属样式 ---- */
/* ---- 技术栈 ---- */
.tech-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
.tech-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 12px; font-size: 12px; border: 1px solid var(--border); background: var(--panel2); color: var(--fg); }
.tech-chip .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 6px var(--green); }
.tech-chip .cnt { color: var(--fg-dim); }
/* ---- 模块 / 分层 ---- */
.bar-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
.bar-row .bar-label { min-width: 130px; font-size: 12px; color: var(--fg-dim); text-align: right; flex-shrink: 0; }
.bar-track { flex: 1; height: 14px; background: var(--panel2); border-radius: 3px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, color-mix(in srgb, var(--blue) 40%, transparent), var(--blue)); }
.bar-fill.layer { background: linear-gradient(90deg, color-mix(in srgb, var(--bar-c, var(--blue)) 40%, transparent), var(--bar-c, var(--blue))); }
.bar-row .bar-val { min-width: 60px; font-size: 12px; font-family: 'SF Mono', Menlo, monospace; }
/* ---- 端点 ---- */
.ep-method { display: inline-block; min-width: 56px; text-align: center; padding: 1px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; color: #0d1117; }
.ep-path { font-family: 'SF Mono', Menlo, monospace; word-break: break-all; }
/* ---- 数据层 ---- */
.tbl-card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.tbl-card .tbl-name { font-family: 'SF Mono', Menlo, monospace; font-size: 13px; font-weight: 600; word-break: break-all; }
.tbl-card .tbl-meta { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
.tbl-card .tbl-meta span { font-size: 10px; padding: 0 6px; border-radius: 8px; border: 1px solid var(--border); color: var(--fg-dim); }
.badge-orphan { color: var(--amber) !important; border-color: rgba(210,153,34,.4) !important; }
.fk-chain { font-family: 'SF Mono', Menlo, monospace; font-size: 12px; padding: 4px 8px; border-radius: 6px; background: var(--panel2); margin-bottom: 6px; display: inline-block; margin-right: 6px; }
/* ---- 质量 ---- */
.cc-badge { display: inline-block; min-width: 36px; text-align: center; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 700; color: #0d1117; }
.loc-mono { font-family: 'SF Mono', Menlo, monospace; font-size: 12px; word-break: break-all; }
/* ---- 图谱：力导向图 ---- */
.sg-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
button.btn.on { border-color: var(--cyan); color: var(--cyan); background: color-mix(in srgb, var(--cyan) 10%, var(--panel2)); }
.sg-hint { font-size: 12px; color: var(--fg-faint); }
.sg-stage { border: 1px solid var(--border); border-radius: 8px; background: var(--panel2); overflow: hidden; position: relative; }
.sg-stage svg { display: block; width: 100%; height: auto; cursor: grab; touch-action: none; }
.sg-stage svg.dragging { cursor: grabbing; }
svg .sgn circle { stroke-width: 1.5; cursor: pointer; }
svg .sgn text { font-size: 10px; font-family: 'SF Mono', Menlo, monospace; fill: var(--fg-dim); paint-order: stroke; stroke: var(--panel2); stroke-width: 3px; pointer-events: none; }
svg .sgn text.big { fill: var(--fg); font-weight: 600; }
svg .sge { stroke: color-mix(in srgb, var(--blue) 45%, transparent); stroke-width: 1.1; }
svg .sge.dep { stroke: color-mix(in srgb, var(--blue) 60%, transparent); }
svg .sge.call { stroke: color-mix(in srgb, var(--green) 60%, transparent); }
svg .sge.dim { opacity: .35; }
svg.focus .sgn { opacity: .18; }
svg.focus .sgn.hl { opacity: 1; }
svg.focus .sge { opacity: .06; }
svg.focus .sge.hl { opacity: 1; }
#sg-info { margin-top: 10px; min-height: 20px; font-size: 13px; }
#sg-info .name { font-family: 'SF Mono', Menlo, monospace; color: var(--blue); }
.legend { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 12px; font-size: 12px; color: var(--fg-dim); }
.legend-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; vertical-align: -1px; }
.legend .line { display: inline-block; width: 22px; height: 0; border-top: 2px solid var(--blue); margin: 0 4px 0 2px; vertical-align: 3px; }
.legend .cg-hint { color: var(--fg-faint); }
.note { margin-top: 10px; font-size: 12px; color: var(--fg-faint); }
</style>
</head>
<body>
<header>
  <h1>${title} · 后端服务蓝图</h1>
  <div class="sub">${esc(model.meta.repositoryName ? '仓库 ' + model.meta.repositoryName : model.meta.snapshotPath)} · ${MODULE_SOURCE_LABELS[model.meta.modulePrefixSource] || ''} · 扫描于 ${esc(fmtLocalTime(model.meta.scannedAt) || 'N/A')}</div>
  <div class="stats" id="stats"></div>
  <div class="tabs">
    <button class="tab-btn active" data-tab="overview">总览</button>
    <button class="tab-btn" data-tab="modules">模块</button>
    <button class="tab-btn" data-tab="layers">分层</button>
    <button class="tab-btn" data-tab="graph">图谱</button>
    <button class="tab-btn" data-tab="endpoints">API 面</button>
    <button class="tab-btn" data-tab="database">数据层</button>
    <button class="tab-btn" data-tab="deps">依赖与集成</button>
    <button class="tab-btn" data-tab="quality">代码质量</button>
    <button class="tab-btn" data-tab="health">健康审计</button>
  </div>
</header>
<main>
<section class="view active" id="view-overview">
  <h2 style="font-size:16px;margin-bottom:12px;">技术栈判定（本体证据）</h2>
  <div class="panel" id="tech-stack"></div>
  <h2 style="font-size:16px;margin-bottom:12px;">仓库信息</h2>
  <div class="panel" id="repo-list"></div>
</section>
<section class="view" id="view-modules">
  <div class="metric-row" id="module-metrics"></div>
  <div class="panel" style="margin-bottom:12px;"><div style="font-weight:600;margin-bottom:8px;">模块规模分布（按类数）</div><div id="module-bars"></div></div>
  <div class="panel" id="module-table"></div>
</section>
<section class="view" id="view-layers">
  <div class="grid" id="layer-grid"></div>
</section>
<section class="view" id="view-graph">
  <div id="graph-root"></div>
</section>
<section class="view" id="view-endpoints">
  <div class="metric-row" id="ep-metrics"></div>
  <div class="search-bar">
    <input type="text" id="ep-search" placeholder="搜索路径 / Controller / 模块..." oninput="renderEndpoints()">
  </div>
  <div class="panel" id="ep-list"></div>
</section>
<section class="view" id="view-database">
  <div class="metric-row" id="db-metrics"></div>
  <h2 style="font-size:16px;margin-bottom:12px;">表清单（${model.tables.length}${model.tableTruncated ? '+' : ''} 张）</h2>
  <div class="grid" id="table-grid"></div>
  <h2 style="font-size:16px;margin-bottom:12px;">外键引用链</h2>
  <div class="panel" id="fk-chains"></div>
  <h2 style="font-size:16px;margin-bottom:12px;">孤儿表（无实体映射且无外键）</h2>
  <div class="panel" id="orphan-list"></div>
</section>
<section class="view" id="view-deps">
  <h2 style="font-size:16px;margin-bottom:12px;">技术栈摘要</h2>
  <div class="panel" id="tech-stack-summary"></div>
  <h2 style="font-size:16px;margin-bottom:12px;">依赖清单（${model.dependencies.length} 项）</h2>
  <div id="dep-groups"></div>
</section>
<section class="view" id="view-quality">
  <div class="metric-row" id="quality-metrics"></div>
  <h2 style="font-size:16px;margin-bottom:12px;">高复杂度方法${model.complexityHotspots.length ? `（cc≥15，TOP${model.complexityHotspots.length}）` : '（cc≥15）'}</h2>
  <div class="panel" id="hotspot-list"></div>
  <h2 style="font-size:16px;margin-bottom:12px;">测试统计</h2>
  <div class="metric-row" id="test-metrics"></div>
  <div class="panel" id="test-class-list"></div>
</section>
<section class="view" id="view-health">
  <div class="panel" id="health-score"></div>
  <h2 style="font-size:16px;margin-bottom:12px;">维度得分</h2>
  <div class="dim-grid" id="health-dimensions"></div>
  <h2 style="font-size:16px;margin-bottom:12px;">问题清单</h2>
  <div class="panel" id="health-issues" style="margin-bottom:16px;"></div>
  <h2 style="font-size:16px;margin-bottom:12px;">审计明细</h2>
  <div class="panel" id="audit-details"></div>
</section>
</main>
<script id="service-viewer-data" type="application/json">${dataJson}</script>
<script>
${RING_JS}
const MODEL = JSON.parse(document.getElementById('service-viewer-data').textContent);

function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function methodColor(m) { return ${JSON.stringify(HTTP_METHOD_COLORS)}[m] || '#a78bfa'; }

// ---- Stats ----
(function() {
  const s = MODEL.meta;
  const stats = [
    { v: s.fileCount, k: '文件' },
    { v: s.packageCount, k: '包' },
    { v: s.classCount, k: '类' },
    { v: s.interfaceCount, k: '接口' },
    { v: s.methodCount, k: '方法' },
    { v: s.endpointCount, k: '端点' },
    { v: s.tableCount, k: '表' },
    { v: s.testMethodCount, k: '测试' },
    { v: s.dependencyCount, k: '依赖' },
  ];
  document.getElementById('stats').innerHTML = stats.map(x => '<div class="stat"><div class="v">' + x.v + '</div><div class="k">' + x.k + '</div></div>').join('');
})();

// ---- Tabs ----
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('section.view').forEach(s => s.classList.remove('active'));
    document.getElementById('view-' + btn.dataset.tab).classList.add('active');
  });
});

// ---- 1. 总览：技术栈 + 仓库 ----
(function() {
  const ts = MODEL.techStack || [];
  const el = document.getElementById('tech-stack');
  if (ts.length === 0) { el.innerHTML = '<div class="empty">未检测到技术栈依赖</div>'; }
  else {
    el.innerHTML = '<div class="tech-chips">' + ts.map(t =>
      '<span class="tech-chip"><span class="dot"></span>' + esc(t.label) + ' <span class="cnt">×' + t.count + '</span></span>'
    ).join('') + '</div>';
  }
  const repos = MODEL.repositories || [];
  const rl = document.getElementById('repo-list');
  if (repos.length === 0) { rl.innerHTML = '<div class="empty">无仓库信息</div>'; return; }
  rl.innerHTML = '<table><thead><tr><th>仓库</th><th>语言</th><th>分支</th><th>commit</th><th>文件数</th><th>类数</th><th>分析错误</th></tr></thead><tbody>' +
    repos.map(r => '<tr>' +
      '<td class="mono">' + esc(r.name) + '</td>' +
      '<td>' + esc(r.language || '-') + '</td>' +
      '<td class="mono">' + esc(r.branch || '-') + '</td>' +
      '<td class="mono" style="font-size:11px;">' + esc((r.commitHash || '-').slice(0, 8)) + '</td>' +
      '<td>' + (r.fileCount ?? '-') + '</td>' +
      '<td>' + (r.classCount ?? '-') + '</td>' +
      '<td>' + (r.analysisErrorCount > 0 ? '<span style="color:var(--red);">' + r.analysisErrorCount + '</span>' : '<span style="color:var(--green);">0</span>') + '</td>' +
    '</tr>').join('') + '</tbody></table>';
})();

// ---- 2. 模块 ----
(function() {
  const modules = MODEL.modules || [];
  const mEl = document.getElementById('module-metrics');
  mEl.innerHTML = [
    { v: modules.length, l: '模块数' },
    { v: modules.reduce((s, m) => s + m.classCount, 0), l: '类总数' },
    { v: modules.reduce((s, m) => s + m.endpointCount, 0), l: '端点总数' },
  ].map(m => '<div class="metric-card"><div class="metric-val">' + m.v + '</div><div class="metric-label">' + m.l + '</div></div>').join('');

  const bars = document.getElementById('module-bars');
  bars.innerHTML = modules.map(m =>
    '<div class="bar-row">' +
      '<div class="bar-label">' + esc(m.label) + ' <span style="color:var(--fg-faint);">' + m.classCount + ' 类</span></div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + m.barPct + '%"></div></div>' +
      '<div class="bar-val">' + m.packageCount + ' 包</div>' +
    '</div>'
  ).join('') || '<div class="empty">无模块数据</div>';

  const table = document.getElementById('module-table');
  table.innerHTML = '<table><thead><tr><th>模块</th><th>包前缀</th><th>包数</th><th>类</th><th>接口</th><th>方法</th><th>端点</th><th>职责</th></tr></thead><tbody>' +
    modules.map(m => '<tr>' +
      '<td style="font-weight:600;">' + esc(m.label) + ' <span class="mono" style="color:var(--fg-faint);font-size:11px;">' + esc(m.key) + '</span></td>' +
      '<td class="mono" style="font-size:11px;color:var(--fg-dim);">' + esc(m.packagePrefix || '-') + '</td>' +
      '<td>' + m.packageCount + '</td>' +
      '<td>' + m.classCount + '</td>' +
      '<td>' + m.interfaceCount + '</td>' +
      '<td>' + m.methodCount + '</td>' +
      '<td>' + m.endpointCount + '</td>' +
      '<td style="color:var(--fg-dim);font-size:12px;">' + esc(m.responsibility || '-') + '</td>' +
    '</tr>').join('') + '</tbody></table>';
})();

// ---- 3. 分层 ----
(function() {
  const layers = MODEL.layers || [];
  const grid = document.getElementById('layer-grid');
  if (layers.length === 0) { grid.innerHTML = '<div class="empty">无分层数据</div>'; return; }
  grid.innerHTML = layers.map(l =>
    '<div class="card" style="cursor:default;">' +
      '<div class="title" style="color:' + l.color + ';">' + esc(l.label) + '</div>' +
      '<div class="desc">' + l.classCount + ' 类 / ' + l.interfaceCount + ' 接口 / ' + l.methodCount + ' 方法' + (l.endpointCount ? ' / ' + l.endpointCount + ' 端点' : '') + '</div>' +
      '<div class="bar-track" style="margin:8px 0;"><div class="bar-fill layer" style="--bar-c:' + l.color + ';width:' + l.barPct + '%"></div></div>' +
      '<div style="display:flex;gap:4px;flex-wrap:wrap;">' +
        '<span class="badge">' + l.packageCount + ' 包</span>' +
        '<span class="badge">' + l.classIds.length + (l.classCount > l.classIds.length ? '+' : '') + ' 类展示</span>' +
      '</div>' +
    '</div>'
  ).join('');
})();

// ---- 4. API 面 ----
function renderEndpoints() {
  const query = (document.getElementById('ep-search')?.value || '').toLowerCase();
  const eps = MODEL.endpoints || [];
  const list = query ? eps.filter(e => e.path.toLowerCase().includes(query) || (e.className || '').toLowerCase().includes(query) || (e.domainPrefix || '').toLowerCase().includes(query)) : eps;
  const el = document.getElementById('ep-list');
  if (list.length === 0) { el.innerHTML = '<div class="empty">没有匹配的端点</div>'; return; }
  el.innerHTML = '<table><thead><tr><th>方法</th><th>路径</th><th>领域</th><th>Controller</th><th>模块</th></tr></thead><tbody>' +
    list.map(e => {
      const c = methodColor(e.httpMethod);
      return '<tr>' +
        '<td><span class="ep-method" style="background:' + c + ';">' + esc(e.httpMethod) + '</span></td>' +
        '<td class="ep-path">' + esc(e.path) + (e.hasPathVariables ? ' <span class="badge">路径参数</span>' : '') + '</td>' +
        '<td><span class="badge">' + esc(e.domainPrefix || '-') + '</span></td>' +
        '<td class="mono" style="font-size:12px;">' + esc(e.className || '-') + '</td>' +
        '<td class="mono" style="font-size:11px;color:var(--fg-dim);">' + esc(e.moduleKey) + '</td>' +
      '</tr>';
    }).join('') + '</tbody></table>';
}

(function() {
  const ebm = MODEL.endpointByMethod || {};
  const order = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
  const total = order.reduce((s, m) => s + (ebm[m] || 0), 0) || 1;
  const metrics = document.getElementById('ep-metrics');
  metrics.innerHTML = [
    { v: MODEL.endpoints.length, l: '端点总数' + (MODEL.endpointTruncated ? '+' : '') },
    ...order.filter(m => ebm[m]).map(m => ({ v: ebm[m], l: m })),
  ].map(m => '<div class="metric-card"><div class="metric-val" style="color:' + methodColor(m.l) + ';">' + m.v + '</div><div class="metric-label">' + m.l + '</div></div>').join('');
  const barsHtml = order.filter(m => ebm[m]).map(m =>
    '<div class="bar-row">' +
      '<div class="bar-label" style="min-width:70px;color:' + methodColor(m) + ';">' + m + ' <span style="color:var(--fg-faint);">' + ebm[m] + '</span></div>' +
      '<div class="bar-track"><div class="bar-fill" style="background:linear-gradient(90deg,' + methodColor(m) + '66,' + methodColor(m) + ');width:' + Math.round((ebm[m] / total) * 100) + '%"></div></div>' +
      '<div class="bar-val">' + Math.round((ebm[m] / total) * 100) + '%</div>' +
    '</div>'
  ).join('');
  metrics.insertAdjacentHTML('afterend', '<div class="panel" style="margin-bottom:12px;">' + barsHtml + '</div>');
  renderEndpoints();
})();

// ---- 5. 数据层 ----
(function() {
  const tables = MODEL.tables || [];
  const orphans = MODEL.orphanTables || [];
  const mEl = document.getElementById('db-metrics');
  mEl.innerHTML = [
    { v: tables.length, l: '表数' + (MODEL.tableTruncated ? '+' : '') },
    { v: tables.reduce((s, t) => s + t.columnCount, 0), l: '总列数' },
    { v: tables.reduce((s, t) => s + t.fkCount, 0), l: '外键' },
    { v: orphans.length, l: '孤儿表', c: orphans.length > 0 ? 'var(--amber)' : 'var(--green)' },
  ].map(m => '<div class="metric-card"><div class="metric-val" style="color:' + (m.c || 'var(--blue)') + ';">' + m.v + '</div><div class="metric-label">' + m.l + '</div></div>').join('');

  const grid = document.getElementById('table-grid');
  if (tables.length === 0) { grid.innerHTML = '<div class="empty">无表数据（快照无 DDL）</div>'; }
  else {
    grid.innerHTML = tables.map(t =>
      '<div class="tbl-card">' +
        '<div class="tbl-name">' + esc(t.name) + '</div>' +
        (t.comment ? '<div style="font-size:11px;color:var(--fg-dim);margin-top:2px;">' + esc(t.comment) + '</div>' : '') +
        '<div class="tbl-meta">' +
          '<span>' + t.columnCount + ' 列</span>' +
          (t.primaryKey ? '<span>PK: ' + esc(t.primaryKey) + '</span>' : '') +
          '<span>' + t.fkCount + ' FK</span>' +
          (t.matchedEntityClass ? '<span style="color:var(--green);border-color:rgba(74,222,128,.4);">实体 ' + esc(t.matchedEntityClass) + '</span>' : '<span class="badge-orphan">无实体映射</span>') +
          (t.isOrphan ? '<span class="badge-orphan">孤儿表</span>' : '') +
        '</div>' +
      '</div>'
    ).join('');
  }

  const fc = document.getElementById('fk-chains');
  const chains = MODEL.fkChains || [];
  if (chains.length === 0) { fc.innerHTML = '<div class="empty">无外键引用链（深度≥2）</div>'; }
  else {
    fc.innerHTML = chains.map(c =>
      '<span class="fk-chain">' + c.chain.map((t, i) => (i > 0 ? ' → ' : '') + esc(t)).join('') + '</span>'
    ).join('');
  }

  const ol = document.getElementById('orphan-list');
  if (orphans.length === 0) { ol.innerHTML = '<div style="color:var(--green);">✓ 无孤儿表</div>'; }
  else {
    ol.innerHTML = '<table><thead><tr><th>表名</th><th>列数</th><th>注释</th><th>原因</th></tr></thead><tbody>' +
      orphans.map(t => '<tr>' +
        '<td class="mono">' + esc(t.name) + '</td>' +
        '<td>' + t.columnCount + '</td>' +
        '<td style="color:var(--fg-dim);">' + esc(t.comment || '-') + '</td>' +
        '<td><span class="badge badge-orphan">' + (t.orphanReason === 'no_entity_no_fk' ? '无实体映射且无外键' : esc(t.orphanReason || '-')) + '</span></td>' +
      '</tr>').join('') + '</tbody></table>';
  }
})();

// ---- 6. 依赖与集成 ----
(function() {
  const ts = MODEL.techStack || [];
  const el = document.getElementById('tech-stack-summary');
  if (ts.length === 0) { el.innerHTML = '<div class="empty">无依赖数据</div>'; }
  else {
    el.innerHTML = '<div class="tech-chips">' + ts.map(t =>
      '<span class="tech-chip"><span class="dot"></span>' + esc(t.label) + ' <span class="cnt">×' + t.count + '</span></span>'
    ).join('') + '</div>';
  }

  const groups = MODEL.depsByCategory || {};
  const container = document.getElementById('dep-groups');
  const entries = Object.entries(groups);
  if (entries.length === 0) { container.innerHTML = '<div class="empty">无依赖</div>'; return; }
  const labelOf = (key) => (MODEL.techStack || []).find(t => t.key === key)?.label || key;
  container.innerHTML = entries.map(([cat, deps]) =>
    '<div class="panel" style="margin-bottom:12px;">' +
      '<div style="font-weight:600;margin-bottom:8px;">' + esc(labelOf(cat)) + ' <span style="color:var(--fg-dim);font-weight:400;font-size:12px;">(' + deps.length + ')</span></div>' +
      '<table><thead><tr><th>依赖</th><th>版本</th><th>scope</th><th>来源</th></tr></thead><tbody>' +
      deps.map(d => '<tr>' +
        '<td class="mono" style="font-size:12px;">' + esc(d.name) + '</td>' +
        '<td class="mono">' + (d.version ? esc(d.version) : '<span style="color:var(--amber);">未指定</span>') + '</td>' +
        '<td><span class="badge">' + esc(d.scope || '-') + '</span></td>' +
        '<td><span class="badge">' + esc(d.source || '-') + '</span></td>' +
      '</tr>').join('') + '</tbody></table>' +
    '</div>'
  ).join('');
})();

// ---- 7. 代码质量 ----
(function() {
  const hotspots = MODEL.complexityHotspots || [];
  const mEl = document.getElementById('quality-metrics');
  mEl.innerHTML = [
    { v: MODEL.stats.methodCount, l: '方法总数' },
    { v: hotspots.length, l: '热点方法(cc≥15)' + (MODEL.hotspotsTruncated ? '+' : '') },
    { v: MODEL.stats.avgCyclomatic != null ? MODEL.stats.avgCyclomatic : '-', l: '平均圈复杂度' },
  ].map(m => '<div class="metric-card"><div class="metric-val">' + m.v + '</div><div class="metric-label">' + m.l + '</div></div>').join('');

  const hl = document.getElementById('hotspot-list');
  if (hotspots.length === 0) { hl.innerHTML = '<div class="empty">未发现高复杂度方法</div>'; }
  else {
    hl.innerHTML = '<table><thead><tr><th>圈复杂度</th><th>方法</th><th>嵌套深度</th><th>分支</th><th>循环</th><th>模块</th></tr></thead><tbody>' +
      hotspots.map(h => {
        const c = h.cyclomaticComplexity >= 50 ? 'var(--red)' : h.cyclomaticComplexity >= 30 ? 'var(--amber)' : 'var(--orange)';
        return '<tr>' +
          '<td><span class="cc-badge" style="background:' + c + ';">' + h.cyclomaticComplexity + '</span></td>' +
          '<td class="loc-mono">' + esc(h.location) + '</td>' +
          '<td>' + h.maxNestingDepth + '</td>' +
          '<td>' + h.branchCount + '</td>' +
          '<td>' + h.loopCount + '</td>' +
          '<td class="mono" style="font-size:11px;color:var(--fg-dim);">' + esc(h.moduleKey) + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table>';
  }

  const ts = MODEL.testStats || {};
  const tm = document.getElementById('test-metrics');
  tm.innerHTML = [
    { v: ts.total || 0, l: '测试方法' },
    { v: ts.unitTest || 0, l: '单元测试' },
    { v: ts.integrationTest || 0, l: '集成测试' },
    { v: ts.testSetup || 0, l: '测试辅助' },
    { v: ts.testClassCount || 0, l: '测试类' },
  ].map(m => '<div class="metric-card"><div class="metric-val">' + m.v + '</div><div class="metric-label">' + m.l + '</div></div>').join('');

  const tc = document.getElementById('test-class-list');
  const byClass = ts.byClass || [];
  if (byClass.length === 0) { tc.innerHTML = '<div class="empty">无测试类</div>'; return; }
  tc.innerHTML = '<table><thead><tr><th>测试类</th><th>方法数</th><th>单元测试</th><th>集成测试</th></tr></thead><tbody>' +
    byClass.map(c => '<tr>' +
      '<td class="mono" style="font-size:12px;">' + esc(c.className) + '</td>' +
      '<td>' + c.methodCount + '</td>' +
      '<td>' + c.unitTest + '</td>' +
      '<td>' + c.integrationTest + '</td>' +
    '</tr>').join('') + '</tbody></table>';
})();

// ---- 8. 健康审计 ----
(function() {
  const h = MODEL.audits?.health;
  if (!h) return;

  document.getElementById('health-score').innerHTML =
    '<div class="health-score">' +
      scoreRingSvg(h.score, { label: '等级 ' + h.grade, size: 156 }) +
      '<div style="flex:1;">' +
        '<h2 style="font-size:18px;margin-bottom:8px;">后端服务健康度总评</h2>' +
        '<div style="color:var(--fg-dim);margin-bottom:8px;">基于 ' + MODEL.meta.classCount + ' 个类 / ' + MODEL.meta.endpointCount + ' 个端点 / ' + MODEL.meta.tableCount + ' 张表的静态分析</div>' +
        '<div style="display:flex;gap:16px;flex-wrap:wrap;">' +
          '<span style="color:var(--red);">● ' + h.errorCount + ' 错误</span>' +
          '<span style="color:var(--amber);">● ' + h.warnCount + ' 警告</span>' +
          '<span style="color:var(--blue);">● ' + h.infoCount + ' 提示</span>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.getElementById('health-dimensions').innerHTML = (h.dimensions || []).map(d => {
    const c = d.score >= 80 ? 'var(--green)' : d.score >= 60 ? 'var(--amber)' : 'var(--red)';
    return '<div class="dim-card">' +
      '<div class="dim-name">' + esc(d.label) + ' <span style="color:var(--fg-faint);">权重 ' + Math.round(d.weight * 100) + '%</span></div>' +
      '<div class="dim-score" style="color:' + c + '">' + d.score + '</div>' +
      '<div class="dim-bar"><div class="dim-bar-fill" style="--bar-c:' + c + ';width:' + d.score + '%"></div></div>' +
    '</div>';
  }).join('');

  document.getElementById('health-issues').innerHTML = (h.topFindings || []).map(f =>
    '<div class="issue-item ' + f.level + '">' +
      '<strong>' + (f.level === 'error' ? '错误' : f.level === 'warn' ? '警告' : '提示') + '</strong> · ' + esc(f.title) +
      (f.detail ? '<div style="color:var(--fg-dim);font-size:12px;margin-top:2px;">' + esc(f.detail) + '</div>' : '') +
      (f.location ? '<span class="loc" style="display:block;font-size:11px;color:var(--fg-faint);font-family:monospace;margin-top:2px;">' + esc(f.location) + '</span>' : '') +
    '</div>'
  ).join('') || '<div style="color:var(--green);">✓ 未发现问题</div>';

  const details = ['complexity', 'dataHealth', 'testCoverage', 'analysisQuality', 'dependencyHealth'].map(key => {
    const a = MODEL.audits?.[key];
    if (!a) return '';
    const c = a.score >= 80 ? 'var(--green)' : a.score >= 60 ? 'var(--amber)' : 'var(--red)';
    const findings = (a.findings || []).map(f =>
      '<div class="issue-item ' + f.level + '">' +
        '<strong>' + (f.level === 'error' ? '错误' : f.level === 'warn' ? '警告' : '提示') + '</strong> · ' + esc(f.title) +
        (f.detail ? '<div style="color:var(--fg-dim);font-size:12px;margin-top:2px;white-space:pre-wrap;">' + esc(f.detail) + '</div>' : '') +
        (f.location ? '<span class="loc" style="display:block;font-size:11px;color:var(--fg-faint);font-family:monospace;margin-top:2px;">' + esc(f.location) + '</span>' : '') +
      '</div>'
    ).join('');
    return '<div style="margin-bottom:20px;">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">' +
        '<span style="font-size:15px;font-weight:600;">' + esc(a.label) + '</span>' +
        '<span class="badge" style="color:' + c + ';border-color:' + c + '40;">得分 ' + a.score + '</span>' +
        '<span style="color:var(--fg-dim);font-size:12px;">' + (a.findings || []).length + ' 项发现</span>' +
      '</div>' +
      (findings || '<div style="color:var(--green);">✓ 全部通过</div>') +
    '</div>';
  }).join('');
  document.getElementById('audit-details').innerHTML = details;
})();

// ---- 9. 图谱（力导向图：模块依赖 / 分层调用流，内联力模拟零依赖） ----
const SG_W = 1280, SG_H = 860;
const SG = { mode: 'module', nodes: [], edges: [], nodeById: new Map(), view: { k: 1, x: 0, y: 0 } };

function sgSizeOf(n) { return n.classCount || n.methodCount || 1; }

function sgPrepare(mode) {
  const G = (MODEL.moduleGraph || {})[mode + 'View'];
  if (!G || !G.nodes.length) return false;
  SG.mode = mode;
  SG.nodes = G.nodes.map((n) => Object.assign({}, n));
  SG.nodeById = new Map(SG.nodes.map((n) => [n.id, n]));
  SG.edges = G.edges
    .filter((e) => SG.nodeById.has(e.source) && SG.nodeById.has(e.target))
    .map((e) => ({ source: e.source, target: e.target, weight: e.weight || 1, sa: SG.nodeById.get(e.source), sb: SG.nodeById.get(e.target) }));
  return true;
}

function sgInitPositions() {
  const count = SG.nodes.length || 1;
  SG.nodes.forEach((n, i) => {
    const angle = i * 2.39996;
    const r = 60 + 320 * Math.sqrt((i + 0.5) / count);
    n.x = SG_W / 2 + Math.cos(angle) * r;
    n.y = SG_H / 2 + Math.sin(angle) * r * 0.72;
    n.vx = 0; n.vy = 0; n.fixed = false;
  });
}

function sgTick(alpha) {
  const nodes = SG.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.01; }
      if (d2 > 900000) continue;
      const d = Math.sqrt(d2);
      const f = (5200 * alpha) / d2;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
    }
  }
  for (const e of SG.edges) {
    const a = e.sa, b = e.sb;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - 150) * 0.018 * alpha;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
  }
  for (const n of nodes) {
    n.vx += (SG_W / 2 - n.x) * 0.045 * alpha;
    n.vy += (SG_H / 2 - n.y) * 0.045 * alpha;
    if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
    n.vx *= 0.85; n.vy *= 0.85;
    const sp = Math.abs(n.vx) + Math.abs(n.vy);
    if (sp > 30) { n.vx = (n.vx / sp) * 30; n.vy = (n.vy / sp) * 30; }
    n.x += n.vx; n.y += n.vy;
    if (n.x < 50) { n.x = 50; n.vx = Math.abs(n.vx) * 0.4; }
    if (n.x > SG_W - 50) { n.x = SG_W - 50; n.vx = -Math.abs(n.vx) * 0.4; }
    if (n.y < 36) { n.y = 36; n.vy = Math.abs(n.vy) * 0.4; }
    if (n.y > SG_H - 36) { n.y = SG_H - 36; n.vy = -Math.abs(n.vy) * 0.4; }
  }
}

function sgLayout() {
  sgInitPositions();
  for (let t = 0; t < 320; t++) sgTick(Math.pow(1 - t / 320, 1.5) * 0.85 + 0.015);
}

function sgGraphSvgInner() {
  const maxSize = SG.nodes.reduce((a, n) => Math.max(a, sgSizeOf(n)), 1);
  const labeled = new Set(SG.nodes.slice().sort((a, b) => sgSizeOf(b) - sgSizeOf(a)).slice(0, 40).map((n) => n.id));
  let out = '';
  for (const e of SG.edges) {
    const w = Math.min(1 + (e.weight > 1 ? Math.log2(e.weight + 1) : 0), 6).toFixed(1);
    out += '<line class="sge' + (e.kind ? ' ' + e.kind : '') + '" x1="' + e.sa.x.toFixed(1) + '" y1="' + e.sa.y.toFixed(1)
      + '" x2="' + e.sb.x.toFixed(1) + '" y2="' + e.sb.y.toFixed(1) + '" stroke-width="' + w
      + '" data-a="' + esc(e.source) + '" data-b="' + esc(e.target) + '"></line>';
  }
  for (const n of SG.nodes) {
    const r = 7 + 24 * Math.sqrt(sgSizeOf(n) / maxSize);
    let label = '';
    if (labeled.has(n.id)) {
      const nm = n.name.length > 16 ? n.name.slice(0, 15) + '…' : n.name;
      label = '<text class="' + (sgSizeOf(n) > maxSize * 0.25 ? 'big' : '') + '" x="' + (n.x + r + 4).toFixed(1) + '" y="' + (n.y + 3).toFixed(1) + '">' + esc(nm) + '</text>';
    }
    out += '<g class="sgn" data-nid="' + esc(n.id) + '">'
      + '<circle cx="' + n.x.toFixed(1) + '" cy="' + n.y.toFixed(1) + '" r="' + r.toFixed(1) + '" fill="' + n.color + '"></circle>'
      + label + '</g>';
  }
  return out;
}

function sgApplyTransform() {
  const g = document.getElementById('sg-transform');
  if (g && g.setAttribute) g.setAttribute('transform', 'translate(' + SG.view.x.toFixed(1) + ',' + SG.view.y.toFixed(1) + ') scale(' + SG.view.k.toFixed(3) + ')');
}

function sgUpdateToolbar() {
  const c = document.getElementById('sg-count');
  if (c && c.textContent !== undefined) {
    const G = (MODEL.moduleGraph || {})[SG.mode + 'View'] || {};
    const hidden = (G.nodeCount || 0) - SG.nodes.length;
    const label = { module: '模块图谱', layer: '分层调用流', tech: '模块×技术栈' }[SG.mode] || SG.mode;
    c.textContent = label
      + ' · ' + SG.nodes.length + ' 节点 · ' + SG.edges.length + ' 边'
      + (hidden > 0 ? '（未展示 ' + hidden + ' 个节点）' : '');
  }
  ['module', 'layer', 'tech'].forEach((m) => {
    const b = document.getElementById('sg-mode-' + m);
    if (b && b.classList) {
      if (SG.mode === m) b.classList.add('on'); else b.classList.remove('on');
    }
  });
}

function sgUpdateLegend() {
  const lg = document.getElementById('sg-legend');
  if (!lg) return;
  let html = '';
  if (SG.mode === 'module') {
    const seen = [];
    SG.nodes.forEach((n) => { if (!seen.some((s) => s.id === n.id)) seen.push({ id: n.id, name: n.name, color: n.color }); });
    html = seen.map((s) => '<span><span class="legend-dot" style="background:' + s.color + '"></span>' + esc(s.name) + '</span>').join('');
    html += '<span class="line" style="border-color:#58a6ff"></span>包依赖'
      + '<span class="line" style="border-color:#3fb950"></span>跨模块调用';
  } else if (SG.mode === 'tech') {
    const seen = [];
    SG.nodes.forEach((n) => { if (!seen.some((s) => s.id === n.id)) seen.push({ id: n.id, name: n.name, color: n.color }); });
    html = seen.map((s) => '<span><span class="legend-dot" style="background:' + s.color + '"></span>' + esc(s.name) + '</span>').join('');
    html += '<span class="line" style="border-color:#a78bfa"></span>模块使用该技术';
  } else {
    const seen = [];
    SG.nodes.forEach((n) => { if (!seen.some((s) => s.key === n.key)) seen.push({ key: n.key, name: n.name, color: n.color }); });
    html = seen.map((s) => '<span><span class="legend-dot" style="background:' + s.color + '"></span>' + esc(s.name) + '</span>').join('');
    html += '<span class="line"></span>跨层方法调用（宽度 ∝ 调用次数）';
  }
  html += '<span class="cg-hint">节点大小 ∝ 类数/方法数 · 拖拽节点 / 滚轮缩放 / 拖空白平移 / 点击聚焦</span>';
  lg.innerHTML = html;
}

function sgSetFocus(node) {
  const svg = document.getElementById('sg-svg');
  const info = document.getElementById('sg-info');
  if (!svg || !svg.querySelectorAll || !info) return;
  if (!node) {
    svg.classList.remove('focus');
    svg.querySelectorAll('.sgn.hl, .sge.hl').forEach((x) => x.classList.remove('hl'));
    info.innerHTML = '<span class="sg-hint">点击节点查看详情并高亮邻接。</span>';
    return;
  }
  const neighbor = new Set([node.id]);
  const connKeys = new Set();
  for (const e of SG.edges) {
    if (e.source === node.id || e.target === node.id) {
      neighbor.add(e.source); neighbor.add(e.target);
      connKeys.add(e.source + '>' + e.target);
    }
  }
  svg.classList.add('focus');
  svg.querySelectorAll('.sgn').forEach((g) => {
    const nid = g.getAttribute('data-nid');
    if (neighbor.has(nid)) g.classList.add('hl'); else g.classList.remove('hl');
  });
  svg.querySelectorAll('.sge').forEach((ln) => {
    const key = ln.getAttribute('data-a') + '>' + ln.getAttribute('data-b');
    if (connKeys.has(key)) ln.classList.add('hl'); else ln.classList.remove('hl');
  });
  const isTechNode = SG.mode === 'tech' && String(node.id).startsWith('tech:');
  const meta = SG.mode === 'module'
    ? sgSizeOf(node) + ' 类 · ' + node.endpointCount + ' 端点 · ' + node.packageCount + ' 包'
    : SG.mode === 'tech'
      ? (isTechNode ? '技术栈 · ' + node.count + ' 项依赖 · 被 ' + connKeys.size + ' 个模块使用'
        : sgSizeOf(node) + ' 类 · ' + node.endpointCount + ' 端点 · 使用 ' + connKeys.size + ' 类技术')
      : sgSizeOf(node) + ' 方法 · ' + node.classCount + ' 类' + (node.endpointCount ? ' · ' + node.endpointCount + ' 端点' : '');
  info.innerHTML = '<span class="name">' + esc(node.name) + '</span> — ' + meta + ' · 邻接 ' + connKeys.size + ' 条边';
}

function sgSetMode(mode) {
  if (!sgPrepare(mode)) return;
  SG.view = { k: 1, x: 0, y: 0 };
  sgApplyTransform();
  sgLayout();
  document.getElementById('sg-transform').innerHTML = sgGraphSvgInner();
  sgSetFocus(null);
  sgUpdateToolbar();
  sgUpdateLegend();
}

function sgPointer(ev) {
  const svg = document.getElementById('sg-svg');
  const rect = svg.getBoundingClientRect();
  const sx = rect.width / SG_W, sy = rect.height / SG_H;
  return {
    x: ((ev.clientX - rect.left) / sx - SG.view.x) / SG.view.k,
    y: ((ev.clientY - rect.top) / sy - SG.view.y) / SG.view.k,
  };
}

function sgBindStage() {
  const stage = document.getElementById('sg-stage');
  if (!stage || !stage.addEventListener) return;
  let drag = null;
  stage.addEventListener('mousedown', (ev) => {
    const nidEl = ev.target && ev.target.closest ? ev.target.closest('[data-nid]') : null;
    const svg = document.getElementById('sg-svg');
    if (svg && svg.classList) svg.classList.add('dragging');
    if (nidEl) {
      const node = SG.nodeById.get(nidEl.getAttribute('data-nid'));
      if (!node) return;
      const p = sgPointer(ev);
      node.fixed = true;
      drag = { type: 'node', node, sx: ev.clientX, sy: ev.clientY, dx: node.x - p.x, dy: node.y - p.y, moved: false };
    } else {
      drag = { type: 'pan', sx: ev.clientX, sy: ev.clientY, ox: SG.view.x, oy: SG.view.y, moved: false };
    }
    ev.preventDefault();
  });
  stage.addEventListener('mousemove', (ev) => {
    if (!drag) return;
    if (Math.abs(ev.clientX - drag.sx) + Math.abs(ev.clientY - drag.sy) > 3) drag.moved = true;
    if (drag.type === 'node') {
      const p = sgPointer(ev);
      drag.node.x = p.x + drag.dx;
      drag.node.y = p.y + drag.dy;
      for (let t = 0; t < 2; t++) sgTick(0.25);
      document.getElementById('sg-transform').innerHTML = sgGraphSvgInner();
    } else {
      SG.view.x = drag.ox + (ev.clientX - drag.sx);
      SG.view.y = drag.oy + (ev.clientY - drag.sy);
      sgApplyTransform();
    }
  });
  stage.addEventListener('mouseup', () => {
    const svg = document.getElementById('sg-svg');
    if (svg && svg.classList) svg.classList.remove('dragging');
    if (!drag) return;
    if (drag.type === 'node') {
      if (!drag.moved) sgSetFocus(drag.node);
    } else if (!drag.moved) {
      sgSetFocus(null);
    }
    drag = null;
  });
  stage.addEventListener('mouseleave', () => {
    const svg = document.getElementById('sg-svg');
    if (svg && svg.classList) svg.classList.remove('dragging');
    drag = null;
  });
  stage.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const svg = document.getElementById('sg-svg');
    if (!svg || !svg.getBoundingClientRect) return;
    const rect = svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) / (rect.width / SG_W);
    const py = (ev.clientY - rect.top) / (rect.height / SG_H);
    const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
    const k2 = Math.max(0.25, Math.min(6, SG.view.k * factor));
    SG.view.x = px - (k2 / SG.view.k) * (px - SG.view.x);
    SG.view.y = py - (k2 / SG.view.k) * (py - SG.view.y);
    SG.view.k = k2;
    sgApplyTransform();
  }, { passive: false });
}

function renderGraph() {
  const el = document.getElementById('graph-root');
  const G = MODEL.moduleGraph;
  if (!G || (!G.moduleView && !G.layerView)) {
    el.innerHTML = '<div class="panel"><h2>图谱</h2><div class="empty">无图谱数据（需基于 asdm-aos 快照重新构建服务模型）。</div></div>';
    return;
  }
  const hasModule = !!(G.moduleView && G.moduleView.nodes.length);
  const hasLayer = !!(G.layerView && G.layerView.nodes.length);
  const hasTech = !!(G.techView && G.techView.nodes.length);
  el.innerHTML =
    '<div class="panel"><h2>图谱（力导向图）</h2>'
    + '<div class="sg-toolbar">'
    + (hasModule ? '<button class="btn" id="sg-mode-module">模块图谱</button>' : '')
    + (hasLayer ? '<button class="btn" id="sg-mode-layer">分层调用流</button>' : '')
    + (hasTech ? '<button class="btn" id="sg-mode-tech">模块×技术栈</button>' : '')
    + '<button class="btn" id="sg-relayout">重新布局</button>'
    + '<button class="btn" id="sg-reset">重置视图</button>'
    + '<span class="sg-hint" id="sg-count"></span>'
    + '</div>'
    + '<div class="sg-stage" id="sg-stage"><svg id="sg-svg" viewBox="0 0 ' + SG_W + ' ' + SG_H + '"><g id="sg-transform"></g></svg></div>'
    + '<div class="legend" id="sg-legend"></div>'
    + '<div id="sg-info"></div>'
    + '<div class="note">模块图谱：节点 = 服务模块（大小 ∝ 类数），边 = 模块间关系（蓝=包依赖 Package.dependsOnPackageIds，绿=跨模块方法调用）；'
    + '分层调用流：节点 = 架构分层，边 = 跨层方法调用（宽度 ∝ 调用次数，来自 Method.callsMethodIds，排除测试与外部库调用）；'
    + '模块×技术栈：节点 = 服务模块 + 技术分类（紫），边 = 模块使用该技术（来自 Package.dependencyIds）。'
    + '力导向布局由内置力模拟（斥力 + 弹簧 + 向心力）实时计算。</div>'
    + '</div>';
  sgBindStage();
  const bindMode = (id, mode) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', () => sgSetMode(mode));
  };
  bindMode('sg-mode-module', 'module');
  bindMode('sg-mode-layer', 'layer');
  bindMode('sg-mode-tech', 'tech');
  const relayout = document.getElementById('sg-relayout');
  if (relayout) relayout.addEventListener('click', () => {
    sgLayout();
    document.getElementById('sg-transform').innerHTML = sgGraphSvgInner();
    sgSetFocus(null);
  });
  const reset = document.getElementById('sg-reset');
  if (reset) reset.addEventListener('click', () => {
    SG.view = { k: 1, x: 0, y: 0 };
    sgApplyTransform();
    sgSetFocus(null);
  });
  sgSetMode(hasModule ? 'module' : hasLayer ? 'layer' : 'tech');
}

renderGraph();
</script>
</body>
</html>`;
}
