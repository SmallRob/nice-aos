// 产品规划蓝图 HTML 生成器
// 数据流：planning-snapshot.json（PlanningModel）→ buildPlanningViewerModel()（视图模型）→ renderPlanningBlueprintHtml()（HTML）
// 布局：总览 / 特性 / 模块 / 图谱 / 迭代与发布 / Roadmap与战略 / 审计（暗色、统计卡 + 分节卡片，参照 系统架构设计全览.html 风格）
// 内嵌 <script id="planning-viewer-data">，供 contrib/blueprint-ai-agent 问答代理消费。

import { auditHealth } from './docsAuditor.js';
import { STATUS_DEFS, STATUS_ORDER } from './docsModel.js';
import { buildThemeCss, DEFAULT_THEMES } from '../themes/index.js';
import { SHARED_CSS } from '../themes/sharedCss.js';
import { RING_JS } from '../themes/ring.js';

const GRAPH_NODE_CAP = 160;

const STATUS_COLORS = {
  done: '#4ade80', implementing: '#fbbf24', designing: '#fb923c',
  clarifying: '#a78bfa', blocked: '#f87171', unknown: '#64748b',
};
const MOD_COLORS = ['#39c5cf', '#58a6ff', '#3fb950', '#d29922', '#f472b6', '#818cf8', '#fb923c', '#00b4ab', '#f87171', '#bc8cff', '#4ade80', '#22d3ee', '#f0abfc', '#2dd4bf', '#fbbf24'];

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildPlanningViewerModel(model) {
  const meta = model._meta || {};
  return {
    meta: {
      name: meta.name || '产品规划',
      sourceDir: meta.sourceDir || '',
      scannedAt: meta.scannedAt || '',
      durationMs: meta.durationMs,
      fileCount: meta.fileCount,
      featureCount: meta.featureCount,
      moduleCount: meta.moduleCount,
      releaseCount: meta.releaseCount,
      milestoneCount: meta.milestoneCount,
      themeCount: meta.themeCount,
      dependencyCount: meta.dependencyCount,
      version: meta.version || '',
    },
    distribution: model.distribution || { status: {}, priority: {}, targetVersion: {} },
    stats: model.stats || {},
    features: model.features || [],
    modules: model.modules || [],
    releases: model.releases || [],
    milestones: model.milestones || [],
    themes: model.themes || [],
    dependencies: (model.dependencies || []).map((d) => ({ source: d.source, target: d.target, kind: d.kind })),
    audit: auditHealth(model),
    statusDefs: STATUS_DEFS,
    statusColors: STATUS_COLORS,
    statusOrder: STATUS_ORDER,
  };
}

export function renderPlanningBlueprintHtml(model, options = {}) {
  const dataJson = JSON.stringify(model).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
  const meta = model.meta || {};
  const title = esc(meta.name || '产品规划蓝图');
  const theme = options.theme || DEFAULT_THEMES.planning || 'deep-blue';

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${esc(theme)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} · 产品规划蓝图</title>
<style>
${buildThemeCss(theme)}
${SHARED_CSS}
/* ---- 产品规划蓝图专属样式 ---- */
.ctrl { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; align-items: center; }
.ctrl select, .ctrl input { background: var(--panel); border: 1px solid var(--border); color: var(--fg); border-radius: 6px; padding: 6px 10px; font-size: 13px; }
.ctrl input[type=search] { min-width: 220px; }
.chip { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; border: 1px solid var(--border); margin-right: 4px; }
table.pgrid { width: 100%; border-collapse: collapse; font-size: 12px; }
table.pgrid th, table.pgrid td { border: 1px solid var(--border); padding: 6px 8px; text-align: left; vertical-align: top; }
table.pgrid th { background: var(--panel2); color: var(--fg-dim); font-weight: 600; white-space: nowrap; position: sticky; top: 0; }
table.pgrid tr:hover td { background: color-mix(in srgb, var(--accent-blue, var(--blue)) 4%, transparent); }
.mod-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; margin-top: 12px; }
.mod-card { background: var(--panel); border: 1px solid var(--border); border-left: 3px solid var(--blue); border-radius: 10px; padding: 12px 14px; }
.mod-card .mc-title { font-weight: 600; font-size: 14px; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
.mod-card .mc-desc { font-size: 12px; color: var(--fg-dim); margin-bottom: 8px; line-height: 1.5; }
.mod-card .mc-feats { display: flex; flex-wrap: wrap; gap: 4px; }
.mod-card .mc-feats span { font-size: 11px; padding: 1px 6px; border-radius: 6px; border: 1px solid var(--border); color: var(--fg-dim); }
.graph-wrap { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; align-items: center; }
.graph-btn { background: var(--panel); border: 1px solid var(--border); color: var(--fg-dim); padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.graph-btn.active { color: var(--fg); border-color: var(--blue); background: color-mix(in srgb, var(--blue) 12%, var(--panel)); }
.graph-hint { color: var(--fg-faint); font-size: 11px; margin-left: auto; }
.graph-container { position: relative; border: 1px solid var(--border); border-radius: 10px; background: linear-gradient(135deg, color-mix(in srgb, var(--blue) 5%, transparent), color-mix(in srgb, var(--purple) 5%, transparent)); overflow: hidden; }
.graph-toolbar { position: absolute; top: 8px; right: 8px; z-index: 10; display: flex; gap: 4px; }
.graph-toolbar button { padding: 4px 10px; font-size: 12px; background: var(--panel2); border: 1px solid var(--border); border-radius: 4px; color: var(--fg-dim); cursor: pointer; }
.graph-toolbar button:hover { color: var(--fg); border-color: var(--blue); }
.graph-legend { position: absolute; bottom: 8px; left: 8px; z-index: 10; background: var(--panel2); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; font-size: 11px; display: flex; gap: 12px; flex-wrap: wrap; max-width: 78%; }
.graph-legend .item { display: flex; align-items: center; gap: 5px; color: var(--fg-dim); }
.graph-legend .dot { width: 10px; height: 10px; border-radius: 50%; }
.graph-legend .line { width: 18px; height: 2px; }
.graph-svg { width: 100%; height: 620px; display: none; cursor: grab; user-select: none; }
.graph-svg:active { cursor: grabbing; }
.graph-svg .g-node { cursor: pointer; }
.graph-svg .g-node text { pointer-events: none; }
.graph-svg .g-node.dim circle, .graph-svg .g-node.dim rect { opacity: 0.18; }
.graph-svg .g-node.active circle { stroke-width: 3; }
.graph-svg .g-node.active rect { stroke-width: 3; }
.graph-svg .g-edge { transition: opacity 120ms ease; }
.graph-svg .g-edge.dim { opacity: 0.08; }
.graph-svg .g-title { font-size: 13px; fill: var(--fg-dim); }
.graph-svg .g-col-label { font-size: 11px; fill: var(--fg-dim); font-weight: 600; }
.graph-svg .g-col-bg { fill: color-mix(in srgb, var(--blue) 3%, transparent); stroke: var(--border); }
.audit-top { display: flex; gap: 24px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
.audit-dim { display: flex; gap: 10px; flex-wrap: wrap; }
.audit-dim .dim { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; min-width: 160px; }
.audit-dim .dim .dl { font-size: 12px; color: var(--fg-dim); }
.audit-dim .dim .dv { font-size: 22px; font-weight: 700; }
.theme-card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
.theme-card .tc-title { font-weight: 600; margin-bottom: 4px; }
.theme-card .tc-sum { font-size: 12px; color: var(--fg-dim); }
.empty { color: var(--fg-faint); font-size: 13px; padding: 12px 2px; }
</style>
</head>
<body>
<header>
  <div style="max-width:1600px;margin:0 auto;">
    <h1>🛰 ${title} · 产品规划蓝图</h1>
    <div class="sub">来源 <b id="h-source">${esc(meta.sourceDir || '—')}</b> ｜ 扫描 <span id="h-scanned"></span> ｜ 引擎 <span id="h-ver"></span></div>
    <div class="stats" id="stats"></div>
    <nav class="tabs" id="tabs">
      <div class="tab-btn active" data-tab="overview">总览</div>
      <div class="tab-btn" data-tab="features">特性</div>
      <div class="tab-btn" data-tab="modules">模块</div>
      <div class="tab-btn" data-tab="graph" id="tab-graph">图谱</div>
      <div class="tab-btn" data-tab="releases">迭代与发布</div>
      <div class="tab-btn" data-tab="roadmap">Roadmap 与战略</div>
      <div class="tab-btn" data-tab="audit">审计</div>
    </nav>
  </div>
</header>
<main>
  <!-- 总览 -->
  <section class="view active" id="view-overview">
    <div class="section-title" style="font-size:16px;font-weight:600;margin:14px 0 10px;">状态分布</div>
    <div class="mod-grid" id="ov-status"></div>
    <div class="section-title" style="font-size:16px;font-weight:600;margin:18px 0 10px;">优先级分布</div>
    <div class="mod-grid" id="ov-priority"></div>
    <div class="section-title" style="font-size:16px;font-weight:600;margin:18px 0 10px;">目标版本分布</div>
    <div class="mod-grid" id="ov-version"></div>
  </section>

  <!-- 特性 -->
  <section class="view" id="view-features">
    <div class="ctrl">
      <select id="fStatus"><option value="">全部状态</option></select>
      <select id="fPriority"><option value="">全部优先级</option></select>
      <select id="fVersion"><option value="">全部版本</option></select>
      <select id="fModule"><option value="">全部模块</option></select>
      <input type="search" id="fSearch" placeholder="搜索特性标题 / 描述 / 负责人…">
      <span class="chip" id="fCount">0 条</span>
    </div>
    <div style="overflow:auto;max-height:70vh;">
      <table class="pgrid" id="featTable">
        <thead><tr><th>ID</th><th>特性</th><th>优先级</th><th>版本</th><th>负责人</th><th>状态</th><th>模块</th><th>描述</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </section>

  <!-- 模块 -->
  <section class="view" id="view-modules">
    <div class="mod-grid" id="modList"></div>
  </section>

  <!-- 图谱 -->
  <section class="view" id="view-graph">
    <div class="graph-wrap">
      <button class="graph-btn active" data-g="featdep" id="gBtnFeatDep">特性依赖</button>
      <button class="graph-btn" data-g="featmod" id="gBtnFeatMod">特性 × 模块</button>
      <span class="graph-hint">滚轮缩放 · 拖拽平移 · 点击节点高亮关联边</span>
    </div>
    <div class="graph-container" id="graphContainer">
      <div class="graph-toolbar">
        <button data-z="-" title="缩小">−</button>
        <button data-z="+" title="放大">+</button>
        <button data-z="r" title="重置视图">重置</button>
      </div>
      <div class="graph-legend" id="graphLegend"></div>
      <svg class="graph-svg active" id="svgFeatDep"></svg>
      <svg class="graph-svg" id="svgFeatMod"></svg>
    </div>
  </section>

  <!-- 迭代与发布 -->
  <section class="view" id="view-releases">
    <div class="section-title" style="font-size:16px;font-weight:600;margin:8px 0 10px;">迭代里程碑</div>
    <div id="releaseTable"></div>
    <div class="section-title" style="font-size:16px;font-weight:600;margin:18px 0 10px;">发布规划</div>
    <div class="mod-grid" id="releaseList"></div>
  </section>

  <!-- Roadmap -->
  <section class="view" id="view-roadmap">
    <div class="mod-grid" id="themeList"></div>
  </section>

  <!-- 审计 -->
  <section class="view" id="view-audit">
    <div class="audit-top">
      <div id="audit-ring"></div>
      <div class="audit-dim" id="auditDims"></div>
    </div>
    <div class="section-title" style="font-size:16px;font-weight:600;margin:8px 0 10px;">问题清单</div>
    <div id="auditIssues"></div>
  </section>
</main>

<script id="planning-viewer-data" type="application/json">${dataJson}</script>
<script>
${RING_JS}
const MODEL = JSON.parse(document.getElementById('planning-viewer-data').textContent);
const SC = MODEL.statusColors || {};
const SD = MODEL.statusDefs || {};
const GRAPH_NODE_CAP = ${GRAPH_NODE_CAP};
const MOD_COLORS = ${JSON.stringify(MOD_COLORS)};
const featureById = new Map((MODEL.features || []).map(f => [f.id, f]));
const knownId = new Set((MODEL.features || []).map(f => f.id));

function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ---- 头部 ----
(function(){
  document.getElementById('h-scanned').textContent = MODEL.meta.scannedAt || '';
  document.getElementById('h-ver').textContent = 'nice-aos planning ' + (MODEL.meta.version || '');
  const m = MODEL.meta;
  const stats = [
    { v: m.featureCount, k: '特性' },
    { v: m.moduleCount, k: '模块' },
    { v: m.dependencyCount, k: '依赖边' },
    { v: m.releaseCount, k: '发布' },
    { v: m.milestoneCount, k: '里程碑' },
    { v: m.themeCount, k: '战略主题' },
    { v: m.fileCount, k: '文档数' },
  ];
  document.getElementById('stats').innerHTML = stats.map(s => '<div class="stat"><div class="v">' + s.v + '</div><div class="k">' + s.k + '</div></div>').join('');
})();

// ---- 图谱内容判定：无可用关系时隐藏图谱 Tab / 子视图 ----
(function(){
  const modKeys = new Set((MODEL.modules||[]).map(m=>m.key));
  const hasDep = (MODEL.dependencies||[]).some(d => featureById.has(d.source) && featureById.has(d.target));
  const hasFM = (MODEL.features||[]).some(f => f.moduleKey && modKeys.has(f.moduleKey));
  if (hasDep && hasFM) return;
  if (!hasDep && !hasFM) {
    document.getElementById('tab-graph').style.display = 'none';
    document.getElementById('view-graph').style.display = 'none';
    return;
  }
  if (!hasDep) {
    document.getElementById('gBtnFeatDep').style.display = 'none';
    document.getElementById('svgFeatDep').style.display = 'none';
    document.getElementById('gBtnFeatDep').classList.remove('active');
    document.getElementById('svgFeatDep').classList.remove('active');
    document.getElementById('gBtnFeatMod').classList.add('active');
    document.getElementById('svgFeatMod').classList.add('active');
  } else {
    document.getElementById('gBtnFeatMod').style.display = 'none';
    document.getElementById('svgFeatMod').style.display = 'none';
  }
})();

// ---- Tabs ----
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('section.view').forEach(s => s.classList.remove('active'));
    document.getElementById('view-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'graph') renderGraphs();
    if (btn.dataset.tab === 'audit') renderAudit();
  });
});

// ---- 总览分布 ----
function distCards(el, dist, colorFn) {
  const items = Object.entries(dist || {}).sort((a,b)=>b[1]-a[1]);
  el.innerHTML = items.length ? items.map(([k,v]) =>
    '<div class="mod-card"><div class="mc-title"><span style="width:10px;height:10px;border-radius:50%;background:' + (colorFn ? colorFn(k) : 'var(--blue)') + ';display:inline-block"></span>' + esc(k) + ' <span class="mc-feats" style="margin-left:auto">' + v + '</span></div></div>'
  ).join('') : '<div class="empty">（无数据）</div>';
}
(function(){
  const d = MODEL.distribution || {};
  distCards(document.getElementById('ov-status'), d.status, k => SC[k] || '#64748b');
  distCards(document.getElementById('ov-priority'), d.priority, k => k === 'P1' ? '#f87171' : k === 'P0' ? '#fbbf24' : k === 'P2' ? '#58a6ff' : '#64748b');
  distCards(document.getElementById('ov-version'), d.targetVersion, () => '#a78bfa');
})();

// ---- 特性表 ----
const featTable = document.getElementById('featTable');
function renderFeatures(){
  const fs = MODEL.features || [];
  const st = document.getElementById('fStatus').value;
  const pr = document.getElementById('fPriority').value;
  const ve = document.getElementById('fVersion').value;
  const mo = document.getElementById('fModule').value;
  const q = document.getElementById('fSearch').value.trim().toLowerCase();
  let rows = fs.filter(f => (!st || f.status === st) && (!pr || f.priority === pr) && (!ve || f.targetVersion === ve) && (!mo || f.moduleKey === mo || f.moduleLabel === mo));
  if (q) rows = rows.filter(f => (f.id + ' ' + f.title + ' ' + f.description + ' ' + f.owner + ' ' + f.moduleLabel).toLowerCase().includes(q));
  const tbody = featTable.tBodies[0];
  tbody.innerHTML = rows.map(f =>
    '<tr>' +
      '<td><b>' + esc(f.id) + '</b></td>' +
      '<td>' + esc(f.title) + '<div style="font-size:11px;color:var(--fg-faint)">' + esc(f.docPath || '') + '</div></td>' +
      '<td>' + esc(f.priority) + '</td>' +
      '<td>' + esc(f.targetVersion) + '</td>' +
      '<td>' + esc(f.owner) + '</td>' +
      '<td><span class="chip" style="color:' + (SC[f.status]||'') + ';border-color:' + (SC[f.status]||'') + '66">' + esc(f.statusEmoji + ' ' + (SD[f.status]?.label || f.status)) + '</span></td>' +
      '<td>' + esc(f.moduleLabel || '—') + '</td>' +
      '<td style="max-width:380px">' + esc(f.description) + (f.openQuestionCount ? ' <span class="chip" style="color:#f87171;border-color:#f8717177">❓' + f.openQuestionCount + ' 开放问题</span>' : '') + '</td>' +
    '</tr>'
  ).join('');
  document.getElementById('fCount').textContent = rows.length + ' / ' + fs.length + ' 条';
}
function fillSelect(sel, values){
  const cur = sel.value;
  const set = new Set(values.filter(Boolean));
  set.forEach(v => { if(![...sel.options].some(o=>o.value===v)){ const o=document.createElement('option'); o.value=v; o.textContent=v; sel.appendChild(o);} });
  sel.value = set.has(cur) ? cur : '';
}
(function(){
  const d = MODEL.distribution || {};
  fillSelect(document.getElementById('fStatus'), (MODEL.statusOrder||[]).map(k => d.status[k]? k : null).filter(Boolean));
  fillSelect(document.getElementById('fPriority'), Object.keys(d.priority || {}));
  fillSelect(document.getElementById('fVersion'), Object.keys(d.targetVersion || {}));
  fillSelect(document.getElementById('fModule'), (MODEL.modules||[]).map(m => m.key));
  ['fStatus','fPriority','fVersion','fModule'].forEach(id => document.getElementById(id).addEventListener('change', renderFeatures));
  document.getElementById('fSearch').addEventListener('input', renderFeatures);
  renderFeatures();
})();

// ---- 模块 ----
(function(){
  const mods = MODEL.modules || [];
  const list = document.getElementById('modList');
  list.innerHTML = mods.length ? mods.map((m,i) => {
    const fc = (m.featureIds || []).length;
    const fcLabel = fc > 0
      ? ' <span class="mc-feats" style="margin-left:auto">' + fc + ' 特性</span>'
      : '';
    return '<div class="mod-card" style="border-left-color:' + (MOD_COLORS[i%MOD_COLORS.length]) + '">' +
      '<div class="mc-title">' + esc(m.label) + fcLabel + '</div>' +
      (m.description ? '<div class="mc-desc">' + esc(m.description.slice(0,200)) + '</div>' : '') +
      '<div class="mc-feats">' + (m.featureIds||[]).map(id => '<span>' + esc(id) + '</span>').join('') + '</div>' +
    '</div>';
  }).join('') : '<div class="empty">（无模块数据）</div>';
})();

// ---- 图谱 ----
// 借鉴 src/deployment/deployViewer.js 的实践：
// - 单 SVG + viewBox：缩放/平移通过 viewBox 修改实现，不依赖第三方库
// - 节点为 group 形式（g.g-node），可点击高亮关联边；保留 <circle> 形式以兼容旧测试断言
// - 边为 path + marker 箭头，data-from / data-to 便于高亮过滤
// - 力导向初始位置用 id 哈希替代 Math.random，避免切换 tab 重渲染时的"图谱抖动"
function hashPos(id, W, H, pad) {
  let h = 2166136261 >>> 0; // FNV-1a offset basis
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  const u = ((h >>> 0) % 100000) / 100000;
  let h2 = 0x9e3779b1;
  for (let i = 0; i < id.length; i++) { h2 ^= id.charCodeAt(i); h2 = Math.imul(h2, 2246822519) >>> 0; }
  const v = ((h2 >>> 0) % 100000) / 100000;
  return { x: pad + u * (W - 2 * pad), y: pad + v * (H - 2 * pad) };
}
function forceLayout(nodes, edges, W, H){
  const n = nodes.length;
  if (!n) return [];
  // 初始位置用 id 哈希：同输入恒出同位置，杜绝重渲染随机抖动
  const pos = nodes.map((nd) => {
    const p = hashPos(nd.id, W, H, 60);
    return { x: p.x, y: p.y };
  });
  const adj = Array.from({length:n}, ()=>[]);
  const seenEdge = new Set();
  for (const e of edges){
    const a = nodes.findIndex(x=>x.id===e.source), b = nodes.findIndex(x=>x.id===e.target);
    if (a>=0 && b>=0 && a!==b){ const k=a+'-'+b; if(!seenEdge.has(k)){ seenEdge.add(k); adj[a].push(b); adj[b].push(a); } }
  }
  const k = Math.sqrt((W*H) / Math.max(n, 1));
  const t0 = Math.min(W, H) * 0.06;
  const disp = pos.map(()=>({x:0,y:0}));
  for (let step=0; step<160; step++){
    const t = t0*(1 - step/160) + 0.5;
    for (const d of disp){ d.x=0; d.y=0; }
    for (let i=0;i<n;i++) for (let j=i+1;j<n;j++){
      let dx = pos[j].x-pos[i].x, dy = pos[j].y-pos[i].y;
      let d2 = dx*dx+dy*dy;
      if (d2 < 0.01){ dx = 1; dy = 0; d2 = 1; }
      const d = Math.sqrt(d2);
      const f = (k*k)/d;
      const fx = (dx/d)*f, fy = (dy/d)*f;
      disp[i].x-=fx; disp[i].y-=fy; disp[j].x+=fx; disp[j].y+=fy;
    }
    for (let i=0;i<n;i++){
      for (const j of adj[i]){
        const dx = pos[j].x-pos[i].x, dy = pos[j].y-pos[i].y;
        const d = Math.sqrt(dx*dx+dy*dy) || 1;
        const f = (d*d)/k;
        disp[i].x += (dx/d)*f; disp[i].y += (dy/d)*f;
      }
      disp[i].x += (W/2 - pos[i].x)/120;
      disp[i].y += (H/2 - pos[i].y)/120;
      const dl = Math.sqrt(disp[i].x*disp[i].x + disp[i].y*disp[i].y) || 1;
      const lim = Math.min(dl, t);
      pos[i].x += (disp[i].x/dl)*lim;
      pos[i].y += (disp[i].y/dl)*lim;
    }
  }
  // 非有限值兜底（防御异常输入）+ 归一化到视图
  let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;
  pos.forEach(p => {
    p.x = Number.isFinite(p.x) ? p.x : W/2;
    p.y = Number.isFinite(p.y) ? p.y : H/2;
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  });
  const pad = 40, sw = Math.max(1, maxX-minX), sh = Math.max(1, maxY-minY);
  return pos.map(p => ({ x: pad + (p.x-minX)/sw*(W-2*pad), y: pad + (p.y-minY)/sh*(H-2*pad) }));
}
function _setVB(svg, W, H) {
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('data-original-vb', '0 0 ' + W + ' ' + H);
}
function layoutColumns(list, columns, W, H) {
  const colGap = 110, rowGap = 18, edge = 30, baseY = 56;
  const colW = Math.max(120, (W - 2*edge - colGap*(columns.length-1)) / Math.max(columns.length,1));
  const pos = new Array(list.length);
  const idxById = new Map(list.map((n, i) => [n.id, i]));
  let x = edge;
  for (const col of columns) {
    col.items.forEach((id, i) => {
      const i2 = idxById.get(id);
      if (i2 == null) return;
      pos[i2] = { x: x + 24, y: baseY + i * rowGap, colX: x, colW };
    });
    x += colW + colGap;
  }
  return pos;
}
function layoutColumnsBg(list, columns, W, H) {
  let s = '';
  const baseY = 56, rowGap = 18, edge = 30, colGap = 110;
  const colW = Math.max(120, (W - 2*edge - colGap*(columns.length-1)) / Math.max(columns.length,1));
  let x = edge;
  for (const col of columns) {
    if (!col.items.length) { x += colW + colGap; continue; }
    const itemsShown = col.items.filter(id => list.some(n => n.id === id)).length;
    const h = Math.max(80, itemsShown * rowGap + 40);
    s += '<rect class="g-col-bg" x="' + (x-12) + '" y="' + (baseY-22) + '" width="' + (colW+24) + '" height="' + h + '" rx="8"/>';
    s += '<text class="g-col-label" x="' + x + '" y="' + (baseY-8) + '">' + esc(col.label) +
      ' <tspan fill="var(--fg-faint)" font-weight="400">' + itemsShown + '</tspan></text>';
    x += colW + colGap;
  }
  return s;
}
function drawGraph(svgId, opts){
  // opts: { layout, nodes, edges, color(node), label(node), kind(node), title, legend, emptyMsg }
  const svg = document.getElementById(svgId);
  const W = svg.clientWidth || 880, H = svg.clientHeight || 620;
  const nodes = opts.nodes || [];
  const edges = opts.edges || [];
  if (!nodes.length) {
    _setVB(svg, W, H);
    svg.innerHTML = '<text class="g-title" x="' + (W/2) + '" y="' + (H/2) +
      '" text-anchor="middle" dominant-baseline="middle" fill="var(--fg-faint)">' + esc(opts.emptyMsg || '（暂无数据）') + '</text>';
    if (document.getElementById('graphLegend') && opts.legend) {
      document.getElementById('graphLegend').innerHTML = opts.legend.map(it =>
        it.kind === 'edge'
          ? '<div class="item"><span class="line" style="background:' + esc(it.color) + '"></span>' + esc(it.label) + '</div>'
          : '<div class="item"><span class="dot" style="background:' + esc(it.color) + '"></span>' + esc(it.label) + '</div>'
      ).join('');
    }
    return;
  }
  const list = nodes.length > GRAPH_NODE_CAP ? nodes.slice(0, GRAPH_NODE_CAP) : nodes;
  const edgeSet = new Set();
  const shownEdges = edges.filter(e => {
    const k = e.source + '\u0000' + e.target + '\u0000' + (e.kind || '');
    if (edgeSet.has(k)) return false;
    edgeSet.add(k);
    return list.some(x => x.id === e.source) && list.some(x => x.id === e.target);
  });
  // 不同 layout 走不同的定位
  let nodePos;
  if (opts.layout === 'columns') {
    nodePos = layoutColumns(list, opts.columns || [], W, H);
  } else {
    nodePos = forceLayout(list, shownEdges, W, H);
  }
  const byId = new Map(list.map((n, i) => [n.id, { ...n, i }]));
  _setVB(svg, W, H);

  let s = '<defs><marker id="' + svgId + '-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="rgba(255,255,255,0.45)"/></marker>';

  // 分列布局：列背景 + 列标签
  if (opts.layout === 'columns' && opts.columns) {
    s += layoutColumnsBg(list, opts.columns, W, H);
  }
  s += '</defs>';

  // 边（path + marker）
  shownEdges.forEach(e => {
    const a = byId.get(e.source), b = byId.get(e.target);
    if (!a || !b) return;
    const ax = nodePos[a.i], bx = nodePos[b.i];
    if (!ax || !bx) return;
    const color = e.color || 'rgba(255,255,255,0.25)';
    const directed = e.directed !== false;
    s += '<path class="g-edge" data-from="' + esc(e.source) + '" data-to="' + esc(e.target) +
      '" d="M' + ax.x.toFixed(1) + ',' + ax.y.toFixed(1) + ' L' + bx.x.toFixed(1) + ',' + bx.y.toFixed(1) +
      '" fill="none" stroke="' + color + '" stroke-width="1.2" opacity="0.55"' +
      (directed ? ' marker-end="url(#' + svgId + '-arrow)"' : '') + '/>';
  });

  // 节点（g-node + circle + text）
  list.forEach((n, i) => {
    const p = nodePos[i];
    if (!p) return;
    const c = opts.color ? opts.color(n) : '#58a6ff';
    const kind = opts.kind ? opts.kind(n) : 'feature';
    const r = kind === 'module' ? 14 : 9;
    const label = opts.label ? opts.label(n) : n.id;
    const shortLabel = label.length > 22 ? label.slice(0, 21) + '…' : label;
    s += '<g class="g-node" data-id="' + esc(n.id) + '">' +
      '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + r +
      '" fill="' + c + '" fill-opacity="0.85" stroke="' + c + '" stroke-width="1.5"/>' +
      '<text x="' + (p.x + r + 4).toFixed(1) + '" y="' + (p.y + 4).toFixed(1) +
      '" font-size="11" fill="var(--fg)">' + esc(shortLabel) + '</text>' +
    '</g>';
  });

  // 标题（在数据 cap 时附注）
  const cappedNote = list.length < nodes.length ? '（仅显示前 ' + list.length + ' / ' + nodes.length + '）' : '';
  s += '<text class="g-title" x="' + (W/2) + '" y="18" text-anchor="middle">' + esc(opts.title || '') + ' ' + esc(cappedNote) + '</text>';

  svg.innerHTML = s;

  // 图例
  const lg = document.getElementById('graphLegend');
  if (lg && opts.legend) {
    lg.innerHTML = opts.legend.map(it =>
      it.kind === 'edge'
        ? '<div class="item"><span class="line" style="background:' + esc(it.color) + '"></span>' + esc(it.label) + '</div>'
        : '<div class="item"><span class="dot" style="background:' + esc(it.color) + '"></span>' + esc(it.label) + '</div>'
    ).join('');
  }
}
const STATUS_LEGEND = (function(){
  const arr = [];
  for (const k of (MODEL.statusOrder || [])) {
    if (SC[k]) arr.push({ label: (SD[k] && SD[k].label || k), color: SC[k] });
  }
  return arr;
})();
function renderFeatDep(){
  // 特性依赖：保留力导向（无天然分层），但初始位置确定性 + 节点为 group，关联边可点击高亮
  const feats = (MODEL.features || []).slice(0, GRAPH_NODE_CAP);
  const featset = new Set(feats.map(f => f.id));
  const depsRaw = (MODEL.dependencies || []).filter(d => featset.has(d.source) && featset.has(d.target));
  if (!feats.length) {
    return drawGraph('svgFeatDep', { nodes: [], edges: [], title: '特性依赖关系图',
      emptyMsg: '（无特性数据）', legend: STATUS_LEGEND });
  }
  if (!depsRaw.length) {
    return drawGraph('svgFeatDep', { nodes: [], edges: [], title: '特性依赖关系图',
      emptyMsg: '（当前特性集中暂无依赖关系）', legend: STATUS_LEGEND });
  }
  drawGraph('svgFeatDep', {
    layout: 'force',
    nodes: feats.map(f => ({ id: f.id, kind: 'feature', f })),
    edges: depsRaw.map(e => ({ source: e.source, target: e.target, color: '#a78bfa', kind: 'dep' })),
    color: n => SC[n.f.status] || '#58a6ff',
    label: n => n.f.id,
    kind: n => 'feature',
    title: '特性依赖关系图（连线 = 特性间引用）',
    legend: STATUS_LEGEND.concat([{ kind: 'edge', label: '依赖引用', color: '#a78bfa' }]),
  });
}
function renderFeatMod(){
  // 借鉴 deployViewer 的分层分列布局：特性 × 模块（左：模块列；右：特性列）
  const allFeats = MODEL.features || [];
  const allMods = MODEL.modules || [];
  const feats = allFeats.slice(0, 90);
  const mods = allMods.slice(0, 40);
  const indexedMods = new Map(mods.map(m => [m.key, m]));
  // 选取实际有归属特性的模块（避免列里全是空）
  const usedModKeys = new Set(feats.map(f => f.moduleKey).filter(k => k && indexedMods.has(k)));
  const usedMods = mods.filter(m => usedModKeys.has(m.key));
  if (!feats.length || !usedMods.length) {
    return drawGraph('svgFeatMod', { nodes: [], edges: [], title: '特性 × 模块 关系图',
      emptyMsg: '（无特性归属模块数据）', legend: STATUS_LEGEND });
  }
  const modColor = {};
  usedMods.forEach((m, i) => { modColor[m.key] = MOD_COLORS[i % MOD_COLORS.length]; });
  const modCols = usedMods.map(m => ({
    label: '模块 · ' + (m.label || m.key),
    items: ['M:' + m.key],
  }));
  const featCol = { label: '特性（按模块归属分组）', items: [] };
  const nodes = [];
  usedMods.forEach(m => nodes.push({ id: 'M:' + m.key, kind: 'module', m, _color: modColor[m.key], _label: '『' + m.label + '』' }));
  feats.forEach(f => {
    if (f.moduleKey && indexedMods.has(f.moduleKey)) {
      nodes.push({ id: 'F:' + f.id, kind: 'feature', f, _color: SC[f.status] || '#58a6ff', _label: f.id });
      featCol.items.push('F:' + f.id);
    }
  });
  const edges = feats.filter(f => f.moduleKey && indexedMods.has(f.moduleKey))
    .map(f => ({ source: 'F:' + f.id, target: 'M:' + f.moduleKey, color: 'rgba(163,230,53,0.55)', kind: 'feat-mod' }));
  drawGraph('svgFeatMod', {
    layout: 'columns',
    nodes,
    edges,
    columns: modCols.concat([featCol]),
    color: n => n._color || '#58a6ff',
    label: n => n._label || n.id,
    kind: n => n.kind || 'feature',
    title: '特性 × 模块 关系图（连线 = 特性归属模块）',
    legend: STATUS_LEGEND.concat([{ kind: 'edge', label: '特性归属', color: 'rgba(163,230,53,0.85)' }]),
  });
}

// ---- 图谱交互：滚轮缩放 / 拖拽平移 / 点击节点高亮 / 重置 ----
function graphZoomBy(svgId, factor) {
  const svg = document.getElementById(svgId);
  const vb = svg.getAttribute('viewBox');
  if (!vb) return;
  const parts = vb.split(' ').map(Number);
  if (parts.length !== 4 || !isFinite(parts[0])) return;
  const cx = parts[0] + parts[2] / 2, cy = parts[1] + parts[3] / 2;
  const nvbW = Math.max(80, parts[2] * factor);
  const nvbH = Math.max(80, parts[3] * factor);
  svg.setAttribute('viewBox', (cx - nvbW/2) + ' ' + (cy - nvbH/2) + ' ' + nvbW + ' ' + nvbH);
}
function graphReset(svgId) {
  const svg = document.getElementById(svgId);
  const orig = svg.getAttribute('data-original-vb');
  if (orig) svg.setAttribute('viewBox', orig);
}
function getActiveGraphId() {
  const a = document.querySelector('.graph-svg.active');
  return a ? a.id : null;
}
// 沙盒/SSR 友好：document.addEventListener 不存在时退化到 window
function _globalEvtTarget() {
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') return document;
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') return window;
  return null;
}
function _safePrevent(e) { if (e && typeof e.preventDefault === 'function') e.preventDefault(); }
function initGraphInteraction() {
  ['svgFeatDep', 'svgFeatMod'].forEach(svgId => {
    const svg = document.getElementById(svgId);
    if (!svg) return;
    const evtTarget = _globalEvtTarget();
    let dragging = false, sx = 0, sy = 0, vbx0 = 0, vby0 = 0;
    svg.addEventListener('mousedown', (e) => {
      if (e.target.closest('.g-node')) return; // 点击节点时不进入拖拽
      dragging = true; sx = e.clientX; sy = e.clientY;
      const vb = svg.getAttribute('viewBox').split(' ').map(Number);
      vbx0 = vb[0]; vby0 = vb[1];
      svg.style.cursor = 'grabbing';
    });
    if (evtTarget) {
      evtTarget.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const rect = svg.getBoundingClientRect();
        const vb = svg.getAttribute('viewBox').split(' ').map(Number);
        const sx2vb = vb[2] / Math.max(1, rect.width);
        const sy2vb = vb[3] / Math.max(1, rect.height);
        svg.setAttribute('viewBox', (vbx0 - (e.clientX - sx) * sx2vb) + ' ' + (vby0 - (e.clientY - sy) * sy2vb) + ' ' + vb[2] + ' ' + vb[3]);
      });
      evtTarget.addEventListener('mouseup', () => { dragging = false; if (svg.classList.contains('active')) svg.style.cursor = 'grab'; });
    }
    svg.addEventListener('wheel', (e) => {
      if (!svg.classList.contains('active')) return;
      _safePrevent(e);
      const factor = e.deltaY > 0 ? 1.18 : 0.85;
      graphZoomBy(svgId, factor);
    }, { passive: false });
    // 点击节点：高亮关联边 + 关联节点，其它 dim；点空白取消
    svg.addEventListener('click', (e) => {
      const node = e.target.closest('.g-node');
      const edges = svg.querySelectorAll('.g-edge');
      const nodes = svg.querySelectorAll('.g-node');
      if (!node) {
        nodes.forEach(n => n.classList.remove('active', 'dim'));
        edges.forEach(p => p.classList.remove('dim'));
        return;
      }
      const id = node.dataset.id;
      if (node.classList.contains('active')) {
        node.classList.remove('active');
        nodes.forEach(n => n.classList.remove('dim'));
        edges.forEach(p => p.classList.remove('dim'));
        return;
      }
      nodes.forEach(n => n.classList.remove('active', 'dim'));
      edges.forEach(p => p.classList.remove('dim'));
      node.classList.add('active');
      const connected = new Set();
      edges.forEach(p => {
        const f = p.dataset.from, t = p.dataset.to;
        if (f === id || t === id) { connected.add(f); connected.add(t); }
        else p.classList.add('dim');
      });
      nodes.forEach(n => {
        if (n === node) return;
        if (!connected.has(n.dataset.id)) n.classList.add('dim');
      });
    });
  });
  // toolbar 绑定
  document.querySelectorAll('#graphContainer .graph-toolbar button').forEach(btn => {
    btn.addEventListener('click', () => {
      const svgId = getActiveGraphId();
      if (!svgId) return;
      const z = btn.dataset.z;
      if (z === '+') graphZoomBy(svgId, 0.85);
      else if (z === '-') graphZoomBy(svgId, 1.18);
      else if (z === 'r') graphReset(svgId);
    });
  });
}
document.querySelectorAll('.graph-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.graph-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const wantDep = btn.dataset.g === 'featdep';
    document.getElementById('svgFeatDep').classList.toggle('active', wantDep);
    document.getElementById('svgFeatMod').classList.toggle('active', !wantDep);
    window.setTimeout(() => { if (wantDep) renderFeatDep(); else renderFeatMod(); }, 10);
  });
});
function renderGraphs(){ renderFeatDep(); renderFeatMod(); }
initGraphInteraction();

// ---- 迭代与发布 ----
function renderMilestones(){
  const ms = MODEL.milestones || [];
  const box = document.getElementById('releaseTable');
  box.innerHTML = ms.length ? '<table class="pgrid"><thead><tr><th>版本</th><th>周期</th><th>状态</th><th>说明 / 特性</th></tr></thead><tbody>' +
    ms.map(x => '<tr><td><b>' + esc(x.version) + '</b></td><td>' + esc(x.window) + '</td><td>' + esc(x.status) + '</td><td>' + esc(x.features.slice(0,300)) + '</td></tr>').join('') +
    '</tbody></table>' : '<div class="empty">（未解析到迭代里程碑）</div>';
}
function renderReleases(){
  const rs = MODEL.releases || [];
  const box = document.getElementById('releaseList');
  box.innerHTML = rs.length ? rs.map(r => {
    const itCount = (r.iterations || []).length;
    const fcCount = (r.featureIds || []).length;
    const metaParts = [];
    if (itCount) metaParts.push(itCount + ' 迭代');
    if (fcCount) metaParts.push(fcCount + ' 特性');
    const meta = metaParts.length
      ? ' <span class="mc-feats" style="margin-left:auto">' + metaParts.join(' · ') + '</span>'
      : '';
    return '<div class="mod-card">' +
      '<div class="mc-title">' + esc(r.name) + meta + '</div>' +
      '<div class="mc-feats" style="margin-top:6px">' + (r.iterations||[]).map(it => '<span>' + esc(it.name) + (it.featureIds && it.featureIds.length ? ' (' + it.featureIds.length + ')' : '') + '</span>').join('') + '</div>' +
      (r.featureIds && r.featureIds.length ? '<div class="mc-feats" style="margin-top:6px">' + r.featureIds.slice(0,60).map(id=>'<span>'+esc(id)+'</span>').join('') + (r.featureIds.length>60?'<span>…</span>':'') + '</div>' : '') +
    '</div>';
  }).join('') : '<div class="empty">（无发布规划）</div>';
}
renderMilestones();
renderReleases();

// ---- Roadmap ----
(function(){
  const ts = MODEL.themes || [];
  document.getElementById('themeList').innerHTML = ts.length ? ts.map((t,i) =>
    '<div class="theme-card"><div class="tc-title" style="color:' + (MOD_COLORS[i%MOD_COLORS.length]) + '">' + (t.kind==='doc' ? '📄 ' : '◆ ') + esc(t.title) + '</div>' +
    (t.summary ? '<div class="tc-sum">' + esc(t.summary.slice(0,240)) + '</div>' : '') + '</div>'
  ).join('') : '<div class="empty">（无 Roadmap 文档）</div>';
})();

// ---- 审计 ----
function renderAudit(){
  const a = MODEL.audit || { score: 0, dimensions: [], issues: [] };
  document.getElementById('audit-ring').innerHTML = scoreRingSvg(a.score, { size: 170 });
  document.getElementById('auditDims').innerHTML = (a.dimensions||[]).map(d =>
    '<div class="dim"><div class="dl">' + esc(d.label) + '</div><div class="dv" style="color:' + (d.score>=80?'var(--green)':d.score>=60?'var(--amber)':'var(--red)') + '">' + d.score + '</div>' +
    '<div style="font-size:11px;color:var(--fg-faint)">' + d.issues.length + ' 项问题</div></div>'
  ).join('');
  const issues = a.issues || [];
  document.getElementById('auditIssues').innerHTML = issues.length ?
    '<table class="pgrid"><thead><tr><th>维度</th><th>特性</th><th>说明</th></tr></thead><tbody>' +
    issues.slice(0, 120).map(i => '<tr><td>' + esc(i.dimension) + '</td><td>' + esc(i.feature || (i.source ? i.source+'→'+i.target : '')) + '</td><td>' + esc(i.reason || i.title || '') + '</td></tr>').join('') +
    '</tbody></table>' : '<div class="empty">✅ 无审计问题</div>';
}
</script>
</body>
</html>`;
}