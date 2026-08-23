// 数据蓝图 dataoverview HTML 生成器
// 数据流：db-snapshot.json（DbDataMap）→ buildDbViewerModel()（视图模型）→ renderDbOverviewHtml()（HTML）
// 八个视图：
//   1. ER 关系图（SVG）：表节点 + 外键边 + 领域分组 + 缩放平移
//   2. 表清单：搜索 + 领域过滤 + 表卡片（列/索引/外键展开）
//   3. 外键关系：源表 → 目标表引用卡片 + ON DELETE/UPDATE
//   4. 迁移时间线：版本排序 + 操作统计
//   5. 建模特征：模式统计 + 演进里程碑
//   6. 健康总览：仪表盘（评分 / 等级 / 维度得分 / Top 问题 / 建议）
//   7. 演进分析：表数增长曲线 + 操作类型分布 + 里程碑 + 领域首版
//   8. 索引优化：外键索引覆盖率 + 冗余索引 + 宽索引 + 主键类型分布

import {
  auditHealth, auditDomains, auditIndexes, auditEvolution, auditNaming,
} from './dbAuditor.js';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ISO UTC 时间 → 浏览器本地时间（YYYY-MM-DD HH:mm:ss），与代码蓝图 fmtLocalTime 对齐
function fmtLocalTime(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return String(iso || '').replace('T', ' ').slice(0, 19);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

export function buildDbViewerModel(dbDataMap) {
  const meta = dbDataMap._meta || {};
  const tables = dbDataMap.tables || [];
  const foreignKeys = dbDataMap.foreignKeys || [];
  const migrations = dbDataMap.migrations || [];
  const domains = dbDataMap.domains || [];
  const views = dbDataMap.views || [];
  const triggers = dbDataMap.triggers || [];
  const procedures = dbDataMap.procedures || [];

  const tableByName = new Map(tables.map((t) => [t.name, t]));

  const foreignKeyGraph = {
    nodes: tables.map((t) => ({
      id: t.name,
      label: t.name,
      domain: t.domain,
      color: t.domain,
      columnCount: t.columns.length,
      hasFk: (t.foreignKeys || []).length > 0,
    })),
    edges: foreignKeys.map((fk) => ({
      source: fk.fromTable,
      target: fk.toTable,
      label: fk.fromColumns.join(','),
      onDelete: fk.onDelete,
    })),
  };

  const schemaPatterns = {
    softDelete: tables.filter((t) => (t.patterns || []).includes('soft_delete')).map((t) => t.name),
    auditColumns: tables.filter((t) => (t.patterns || []).includes('audit_columns')).map((t) => t.name),
    selfReference: tables.filter((t) => (t.patterns || []).includes('self_reference')).map((t) => t.name),
    multiTenant: tables.filter((t) => (t.patterns || []).includes('multi_tenant')).map((t) => t.name),
    uuidPrimary: tables.filter((t) => (t.patterns || []).includes('uuid_primary')).map((t) => t.name),
  };

  const migrationTimeline = migrations.map((m) => ({
    version: m.version,
    description: m.description,
    operationSummary: m.operationSummary,
    tableCount: (m.tableNames || []).length,
    hasIdempotentDdl: m.hasIdempotentDdl,
  }));

  const tableSummaries = tables.map((t) => ({
    name: t.name,
    comment: t.comment,
    domain: t.domain,
    domainLabel: t.domainLabel,
    columnCount: t.columns.length,
    fkCount: (t.foreignKeys || []).length,
    indexCount: (t.indexes || []).length,
    patterns: t.patterns || [],
    createdAt: t.createdAt,
    modifiedAt: t.modifiedAt,
  }));

  const fkSummaries = foreignKeys.map((fk) => ({
    name: fk.name,
    fromTable: fk.fromTable,
    fromColumns: fk.fromColumns,
    toTable: fk.toTable,
    toColumns: fk.toColumns,
    onDelete: fk.onDelete,
    onUpdate: fk.onUpdate,
    fromDomain: tableByName.get(fk.fromTable)?.domain || 'other',
    toDomain: tableByName.get(fk.toTable)?.domain || 'other',
  }));

  // 审计数据
  const healthAudit = auditHealth(dbDataMap);
  const domainsAudit = auditDomains(dbDataMap);
  const indexesAudit = auditIndexes(dbDataMap);
  const evolutionAudit = auditEvolution(dbDataMap);
  const namingAudit = auditNaming(dbDataMap);

  return {
    meta: {
      tableCount: meta.tableCount || tables.length,
      fkCount: meta.fkCount || foreignKeys.length,
      indexCount: meta.indexCount || tables.reduce((s, t) => s + (t.indexes || []).length, 0),
      migrationCount: meta.migrationCount || migrations.length,
      domainCount: meta.domainCount || domains.length,
      sourceDir: meta.sourceDir || '',
      viewCount: meta.viewCount || views.length,
      triggerCount: meta.triggerCount || triggers.length,
      procedureCount: meta.procedureCount || procedures.length,
      scannedAt: meta.scannedAt || '',
      incremental: meta.incremental || false,
    },
    domains,
    tables: tableSummaries,
    tableDetails: tables,
    foreignKeys: fkSummaries,
    foreignKeyGraph,
    migrationTimeline,
    schemaPatterns,
    views,
    triggers,
    procedures,
    audits: {
      health: healthAudit,
      domains: domainsAudit,
      indexes: indexesAudit,
      evolution: evolutionAudit,
      naming: namingAudit,
    },
  };
}

export function renderDbOverviewHtml(model) {
  const dataJson = JSON.stringify(model).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
  const title = esc(model.meta.sourceDir ? model.meta.sourceDir.split('/').pop() : '数据库蓝图');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} · 数据库蓝图</title>
<style>
:root {
  --bg: #0d1117; --panel: #161b22; --panel2: #1c2128; --border: #30363d;
  --fg: #e6edf3; --fg-dim: #8b949e; --fg-faint: #6e7681;
  --blue: #58a6ff; --green: #4ade80; --amber: #d29922; --purple: #a78bfa;
  --red: #f85149; --cyan: #39c5cf; --pink: #f472b6; --orange: #fb923c;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--fg); font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; font-size: 14px; line-height: 1.6; }
header { padding: 20px 24px 0; border-bottom: 1px solid var(--border); }
header > * { max-width: 1600px; margin-left: auto; margin-right: auto; }
h1 { font-size: 20px; }
.sub { color: var(--fg-dim); font-size: 12px; margin-top: 4px; }
.stats { display: flex; gap: 12px; flex-wrap: wrap; margin: 14px 0; }
.stats .stat { text-align: center; flex: 1 1 90px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.stats .stat .v { font-size: 22px; font-weight: 700; color: var(--blue); }
.stats .stat .k { font-size: 11px; color: var(--fg-dim); }
.tabs { display: flex; gap: 4px; margin-top: 14px; }
.tab-btn { padding: 8px 16px; cursor: pointer; color: var(--fg-dim); border: 1px solid transparent; border-bottom: none; border-radius: 6px 6px 0 0; font-size: 14px; background: none; }
.tab-btn:hover { color: var(--fg); background: var(--panel); }
.tab-btn.active { color: var(--fg); background: var(--panel); border-color: var(--border); position: relative; top: 1px; }
main { padding: 20px 24px 48px; max-width: 1600px; margin-left: auto; margin-right: auto; }
section.view { display: none; }
section.view.active { display: block; }
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px; cursor: pointer; transition: border-color .15s; }
.card:hover { border-color: var(--blue); }
.card .title { font-size: 14px; font-weight: 600; margin-bottom: 4px; font-family: 'SF Mono', Menlo, monospace; }
.card .desc { color: var(--fg-dim); font-size: 12px; margin-bottom: 8px; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; border: 1px solid var(--border); }
.badge-domain { font-weight: 500; }
.badge-pk { color: var(--amber); border-color: rgba(210,153,34,.4); }
.badge-fk { color: var(--purple); border-color: rgba(167,139,250,.4); }
.badge-uniq { color: var(--cyan); border-color: rgba(57,197,207,.4); }
.badge-pattern { color: var(--green); border-color: rgba(74,222,128,.4); font-size: 10px; }
.cols { display: none; margin-top: 10px; border-top: 1px solid var(--border); padding-top: 10px; }
.card.expanded .cols { display: block; }
.col-row { display: flex; gap: 8px; padding: 3px 0; font-size: 12px; font-family: 'SF Mono', Menlo, monospace; }
.col-name { min-width: 120px; color: var(--fg); }
.col-type { min-width: 140px; color: var(--fg-dim); }
.col-key { min-width: 40px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
th { color: var(--fg-dim); font-weight: 600; font-size: 12px; white-space: nowrap; }
tr:hover td { background: rgba(88,166,255,.04); }
.search-bar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
.search-bar input { flex: 1; min-width: 200px; padding: 8px 12px; background: var(--panel2); border: 1px solid var(--border); border-radius: 6px; color: var(--fg); font-size: 14px; }
.domain-filters { display: flex; gap: 6px; flex-wrap: wrap; }
.domain-filter { padding: 4px 10px; border-radius: 12px; font-size: 12px; cursor: pointer; border: 1px solid var(--border); background: var(--panel2); color: var(--fg-dim); }
.domain-filter.active { color: var(--fg); border-color: var(--blue); }
.timeline { position: relative; padding-left: 24px; }
.timeline::before { content: ''; position: absolute; left: 8px; top: 0; bottom: 0; width: 2px; background: var(--border); }
.timeline-item { position: relative; margin-bottom: 16px; }
.timeline-item::before { content: ''; position: absolute; left: -20px; top: 6px; width: 10px; height: 10px; border-radius: 50%; background: var(--blue); border: 2px solid var(--bg); }
.timeline-item .ver { font-weight: 600; font-family: 'SF Mono', Menlo, monospace; }
.timeline-item .desc { color: var(--fg-dim); font-size: 12px; }
.timeline-item .ops { margin-top: 4px; display: flex; gap: 6px; flex-wrap: wrap; }
.timeline-item .ops span { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--panel2); border: 1px solid var(--border); color: var(--fg-dim); }
.pattern-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.pattern-card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
.pattern-card .pname { font-weight: 600; margin-bottom: 6px; }
.pattern-card .pcount { font-size: 22px; font-weight: 700; color: var(--blue); margin-bottom: 6px; }
.pattern-card .plist { font-size: 12px; color: var(--fg-dim); font-family: 'SF Mono', Menlo, monospace; }
.fk-card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fk-card .from, .fk-card .to { font-family: 'SF Mono', Menlo, monospace; font-weight: 600; }
.fk-card .arrow { color: var(--purple); }
.fk-card .cols { color: var(--fg-dim); font-size: 12px; }
.fk-card .on-delete { font-size: 11px; padding: 1px 6px; border-radius: 8px; border: 1px solid var(--border); }
.fk-card .on-delete.CASCADE { color: var(--red); border-color: rgba(248,81,73,.4); }
.fk-card .on-delete.SET\\ NULL { color: var(--amber); border-color: rgba(210,153,34,.4); }
.fk-card .on-delete.RESTRICT { color: var(--cyan); border-color: rgba(57,197,207,.4); }
.er-container { position: relative; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.er-toolbar { position: absolute; top: 8px; right: 8px; z-index: 10; display: flex; gap: 4px; }
.er-toolbar button { padding: 4px 10px; font-size: 12px; background: var(--panel2); border: 1px solid var(--border); border-radius: 4px; color: var(--fg-dim); cursor: pointer; }
.er-toolbar button:hover { color: var(--fg); }
.er-legend { position: absolute; bottom: 8px; left: 8px; z-index: 10; background: var(--panel2); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; font-size: 11px; }
.er-legend .item { display: flex; align-items: center; gap: 4px; margin: 2px 0; }
.er-legend .dot { width: 10px; height: 10px; border-radius: 2px; }
.er-empty { text-align: center; padding: 40px; color: var(--fg-dim); }
/* Health dashboard */
.health-score { display: flex; align-items: center; gap: 32px; margin-bottom: 24px; }
.health-score .score-ring { width: 140px; height: 140px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-direction: column; border: 6px solid var(--panel2); position: relative; }
.health-score .score-ring .score-num { font-size: 36px; font-weight: 700; }
.health-score .score-ring .score-grade { font-size: 14px; color: var(--fg-dim); }
.health-score .score-meta { flex: 1; }
.health-score .score-meta h2 { font-size: 18px; margin-bottom: 8px; }
.dim-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-bottom: 20px; }
.dim-card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
.dim-card .dim-name { font-size: 13px; color: var(--fg-dim); margin-bottom: 6px; }
.dim-card .dim-score { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
.dim-card .dim-bar { height: 6px; background: var(--panel2); border-radius: 3px; overflow: hidden; }
.dim-card .dim-bar-fill { height: 100%; border-radius: 3px; }
.issue-item { padding: 8px 12px; border-left: 3px solid var(--border); margin-bottom: 6px; background: var(--panel2); border-radius: 0 4px 4px 0; font-size: 13px; }
.issue-item.high { border-left-color: var(--red); }
.issue-item.medium { border-left-color: var(--amber); }
.issue-item.low { border-left-color: var(--blue); }
.rec-list { list-style: none; }
.rec-list li { padding: 6px 0 6px 24px; position: relative; font-size: 13px; }
.rec-list li::before { content: '→'; position: absolute; left: 0; color: var(--green); }
/* Evolution charts */
.chart-container { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
.chart-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
.chart-svg { width: 100%; height: 280px; }
.legend-row { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 8px; font-size: 12px; color: var(--fg-dim); }
.legend-item { display: flex; align-items: center; gap: 4px; }
.legend-dot { width: 10px; height: 10px; border-radius: 2px; }
/* Index optimization */
.metric-row { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 16px; }
.metric-card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px 20px; min-width: 140px; text-align: center; }
.metric-card .metric-val { font-size: 28px; font-weight: 700; color: var(--blue); }
.metric-card .metric-label { font-size: 12px; color: var(--fg-dim); margin-top: 2px; }
.pk-dist { display: flex; gap: 12px; align-items: flex-end; height: 120px; margin-top: 12px; }
.pk-bar { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.pk-bar-fill { width: 100%; max-width: 60px; background: var(--blue); border-radius: 4px 4px 0 0; min-height: 4px; }
.pk-bar .label { font-size: 11px; color: var(--fg-dim); text-align: center; }
.pk-bar .val { font-size: 12px; font-weight: 600; }
.coupling-table { width: 100%; font-size: 12px; }
.coupling-table th, .coupling-table td { padding: 4px 8px; text-align: right; }
.coupling-table th:first-child, .coupling-table td:first-child { text-align: left; }
.domain-sankey { display: flex; gap: 4px; align-items: stretch; height: 200px; margin-top: 12px; }
.sankey-col { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.sankey-block { border-radius: 3px; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #fff; min-height: 20px; overflow: hidden; }
@media (max-width: 768px) { .grid { grid-template-columns: 1fr; } .stats { gap: 12px; } .health-score { flex-direction: column; } }
</style>
</head>
<body>
<header>
  <h1>${title} · 数据库蓝图</h1>
  <div class="sub">${esc(model.meta.sourceDir)} · 扫描于 ${esc(fmtLocalTime(model.meta.scannedAt) || 'N/A')}${model.meta.incremental ? ' · 增量' : ' · 全量'}</div>
  <div class="stats" id="stats"></div>
  <div class="tabs">
    <button class="tab-btn active" data-tab="er">ER 关系图</button>
    <button class="tab-btn" data-tab="tables">表清单</button>
    <button class="tab-btn" data-tab="fks">外键关系</button>
    <button class="tab-btn" data-tab="migrations">迁移时间线</button>
    <button class="tab-btn" data-tab="patterns">建模特征</button>
    <button class="tab-btn" data-tab="health">健康总览</button>
    <button class="tab-btn" data-tab="evolution">演进分析</button>
    <button class="tab-btn" data-tab="indexes">索引优化</button>
  </div>
</header>
<main>
<section class="view active" id="view-er">
  <div class="er-container" id="er-container">
    <div class="er-toolbar">
      <button onclick="erZoom(-0.1)">−</button>
      <button onclick="erZoom(0.1)">+</button>
      <button onclick="erReset()">重置</button>
    </div>
    <div class="er-legend" id="er-legend"></div>
    <svg id="er-svg" width="100%" height="700" style="cursor: grab;"></svg>
  </div>
</section>
<section class="view" id="view-tables">
  <div class="search-bar">
    <input type="text" id="table-search" placeholder="搜索表名 / 描述 / 列名..." oninput="renderTables()">
    <div class="domain-filters" id="domain-filters"></div>
  </div>
  <div class="grid" id="table-grid"></div>
</section>
<section class="view" id="view-fks">
  <div id="fk-list"></div>
</section>
<section class="view" id="view-migrations">
  <div class="timeline" id="timeline"></div>
</section>
<section class="view" id="view-patterns">
  <div class="pattern-grid" id="pattern-grid"></div>
  <div style="margin-top: 24px;">
    <h2 style="font-size:16px;margin-bottom:12px;">幂等 DDL 使用统计</h2>
    <div class="panel" id="idempotent-stats"></div>
  </div>
  <div style="margin-top: 24px;">
    <h2 style="font-size:16px;margin-bottom:12px;">演进里程碑</h2>
    <div id="milestones"></div>
  </div>
</section>
<section class="view" id="view-health">
  <div class="panel" id="health-score"></div>
  <h2 style="font-size:16px;margin-bottom:12px;">维度得分</h2>
  <div class="dim-grid" id="health-dimensions"></div>
  <h2 style="font-size:16px;margin-bottom:12px;">Top 问题</h2>
  <div class="panel" id="health-issues" style="margin-bottom:16px;"></div>
  <h2 style="font-size:16px;margin-bottom:12px;">优化建议</h2>
  <div class="panel">
    <ul class="rec-list" id="health-recs"></ul>
  </div>
</section>
<section class="view" id="view-evolution">
  <div class="chart-container">
    <div class="chart-title">表数量增长曲线</div>
    <svg class="chart-svg" id="evo-chart-growth"></svg>
  </div>
  <div class="chart-container">
    <div class="chart-title">操作类型分布（按版本）</div>
    <svg class="chart-svg" id="evo-chart-ops"></svg>
    <div class="legend-row" id="evo-ops-legend"></div>
  </div>
  <div class="chart-container">
    <div class="chart-title">领域首版出现时间</div>
    <div id="evo-domain-first"></div>
  </div>
  <div class="chart-container">
    <div class="chart-title">演进趋势</div>
    <div id="evo-trends"></div>
  </div>
</section>
<section class="view" id="view-indexes">
  <div class="metric-row" id="idx-metrics"></div>
  <div class="chart-container">
    <div class="chart-title">主键类型分布</div>
    <div class="pk-dist" id="idx-pk-dist"></div>
  </div>
  <div class="chart-container">
    <div class="chart-title">未建索引的外键列 <span style="color:var(--amber);font-weight:normal;font-size:12px;">（TOP 20）</span></div>
    <div id="idx-unindexed"></div>
  </div>
  <div class="chart-container">
    <div class="chart-title">冗余索引（左前缀包含） <span style="color:var(--fg-dim);font-weight:normal;font-size:12px;">（TOP 10）</span></div>
    <div id="idx-redundant"></div>
  </div>
  <div class="chart-container">
    <div class="chart-title">领域耦合度排名</div>
    <table class="coupling-table" id="domain-coupling">
      <thead><tr><th>领域</th><th>表数</th><th>出度</th><th>入度</th><th>总耦合度</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
  <div class="chart-container">
    <div class="chart-title">优化建议</div>
    <ul class="rec-list" id="idx-recs"></ul>
  </div>
</section>
</main>
<script id="db-viewer-data" type="application/json">${dataJson}</script>
<script>
const MODEL = JSON.parse(document.getElementById('db-viewer-data').textContent);
const DOMAIN_COLORS = ${JSON.stringify(model.domains.reduce((acc, d) => { acc[d.key] = d.color; return acc; }, {}))};
let currentDomain = 'all';
let erScale = 1;
let erOffsetX = 0, erOffsetY = 0;

// ---- Stats ----
(function() {
  const m = MODEL.meta;
  const stats = [
    { v: m.tableCount, k: '表' },
    { v: m.fkCount, k: '外键' },
    { v: m.indexCount, k: '索引' },
    { v: m.migrationCount, k: '迁移' },
    { v: m.domainCount, k: '领域' },
    { v: m.viewCount, k: '视图' },
    { v: m.triggerCount, k: '触发器' },
    { v: m.procedureCount, k: '存储过程' },
  ];
  document.getElementById('stats').innerHTML = stats.map(s => '<div class="stat"><div class="v">' + s.v + '</div><div class="k">' + s.k + '</div></div>').join('');
})();

// ---- Tabs ----
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('section.view').forEach(s => s.classList.remove('active'));
    document.getElementById('view-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'er') renderER();
  });
});

// ---- ER Diagram ----
function renderER() {
  const svg = document.getElementById('er-svg');
  const graph = MODEL.foreignKeyGraph;
  if (!graph.nodes || graph.nodes.length === 0) {
    svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#8b949e">无表数据</text>';
    return;
  }

  const domains = {};
  graph.nodes.forEach(n => { (domains[n.domain] = domains[n.domain] || []).push(n); });
  const domainKeys = Object.keys(domains);

  const nodeW = 180, nodeH = 28, domainGap = 40, colRowH = 16;
  let x = 20, y = 20, maxH = 0;
  const nodePos = {};
  const ER_NODE_CAP = 60;

  domainKeys.forEach(dk => {
    const nodes = domains[dk];
    const visible = nodes.slice(0, ER_NODE_CAP);
    const colCount = Math.min(Math.ceil(visible.length / 6), 4) || 1;
    for (let i = 0; i < visible.length; i++) {
      const col = i % colCount;
      const row = Math.floor(i / colCount);
      const nx = x + col * (nodeW + 16);
      const ny = y + row * (nodeH + 4);
      const colLines = Math.min(visible[i].columnCount, 5);
      nodePos[visible[i].id] = { x: nx, y: ny, w: nodeW, h: nodeH + colLines * colRowH };
      maxH = Math.max(maxH, ny + nodeH + colLines * colRowH);
    }
    x += colCount * (nodeW + 16) + domainGap;
    if (x > 2400) { x = 20; y = maxH + domainGap; maxH = 0; }
  });

  const totalW = Math.max(...Object.values(nodePos).map(p => p.x + p.w)) + 40;
  const totalH = Math.max(...Object.values(nodePos).map(p => p.y + p.h)) + 40;

  svg.setAttribute('viewBox', '0 0 ' + totalW + ' ' + totalH);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', Math.min(totalH, 700));

  let html = '';
  html += '<defs><marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#a78bfa"/></marker></defs>';

  domainKeys.forEach(dk => {
    const color = DOMAIN_COLORS[dk] || '#64748b';
    const nodes = domains[dk].slice(0, ER_NODE_CAP);
    if (nodes.length === 0) return;
    const xs = nodes.map(n => nodePos[n.id]?.x).filter(Boolean);
    const ys = nodes.map(n => nodePos[n.id]?.y).filter(Boolean);
    if (xs.length === 0) return;
    const minX = Math.min(...xs), maxX = Math.max(...xs) + nodeW;
    const minY = Math.min(...ys), maxY = Math.max(...ys) + nodeH;
    html += '<rect x="' + (minX - 8) + '" y="' + (minY - 20) + '" width="' + (maxX - minX + 16) + '" height="' + (maxY - minY + 28) + '" fill="' + color + '10" stroke="' + color + '30" stroke-width="1" rx="8"/>';
    html += '<text x="' + (minX) + '" y="' + (minY - 6) + '" fill="' + color + '" font-size="11" font-weight="600">' + esc(Model_domains_label(dk)) + '</text>';
  });

  graph.edges.forEach(edge => {
    const s = nodePos[edge.source], t = nodePos[edge.target];
    if (!s || !t) return;
    const sx = s.x + s.w / 2, sy = s.y + s.h;
    const tx = t.x + t.w / 2, ty = t.y;
    const mx = (sx + tx) / 2, my = (sy + ty) / 2;
    const delColor = edge.onDelete === 'CASCADE' ? '#f85149' : edge.onDelete === 'SET NULL' ? '#d29922' : '#a78bfa';
    html += '<path d="M' + sx + ',' + sy + ' C' + sx + ',' + my + ' ' + tx + ',' + my + ' ' + tx + ',' + ty + '" fill="none" stroke="' + delColor + '" stroke-width="1.5" marker-end="url(#arrowhead)" opacity="0.7"/>';
  });

  graph.nodes.slice(0, ER_NODE_CAP * domainKeys.length).forEach(n => {
    const p = nodePos[n.id];
    if (!p) return;
    const color = DOMAIN_COLORS[n.domain] || '#64748b';
    const table = MODEL.tableDetails.find(t => t.name === n.id);
    const colLines = Math.min(table ? table.columns.length : 0, 5);
    const h = nodeH + colLines * colRowH;
    html += '<g class="er-node" data-table="' + esc(n.id) + '" style="cursor:pointer">';
    html += '<rect x="' + p.x + '" y="' + p.y + '" width="' + p.w + '" height="' + h + '" fill="var(--panel2)" stroke="' + color + '" stroke-width="1.5" rx="4"/>';
    html += '<rect x="' + p.x + '" y="' + p.y + '" width="' + p.w + '" height="20" fill="' + color + '30" rx="4"/>';
    html += '<text x="' + (p.x + 6) + '" y="' + (p.y + 14) + '" fill="' + color + '" font-size="11" font-weight="600">' + esc(n.id) + '</text>';
    if (table) {
      table.columns.slice(0, 5).forEach((c, i) => {
        const cy = p.y + 20 + (i + 1) * colRowH - 4;
        const keyBadge = c.key === 'PK' ? '★' : c.key === 'UNIQUE' ? 'U' : '';
        html += '<text x="' + (p.x + 6) + '" y="' + cy + '" fill="' + (c.key === 'PK' ? '#d29922' : '#8b949e') + '" font-size="10" font-family="monospace">' + esc(c.name) + '</text>';
        html += '<text x="' + (p.x + 110) + '" y="' + cy + '" fill="#6e7681" font-size="9" font-family="monospace">' + esc(c.type) + '</text>';
        if (keyBadge) html += '<text x="' + (p.x + p.w - 14) + '" y="' + cy + '" fill="#d29922" font-size="10">' + keyBadge + '</text>';
      });
      if (table.columns.length > 5) {
        html += '<text x="' + (p.x + 6) + '" y="' + (p.y + 20 + 6 * colRowH - 4) + '" fill="#6e7681" font-size="9">+' + (table.columns.length - 5) + ' more...</text>';
      }
    }
    html += '</g>';
  });

  svg.innerHTML = html;

  svg.querySelectorAll('.er-node').forEach(g => {
    g.addEventListener('click', () => {
      const tableName = g.dataset.table;
      svg.querySelectorAll('.er-node rect').forEach(r => r.setAttribute('stroke-width', '1.5'));
      g.querySelectorAll('rect').forEach(r => r.setAttribute('stroke-width', '3'));
      svg.querySelectorAll('path').forEach(p => { p.setAttribute('opacity', '0.2'); });
      graph.edges.forEach((edge, i) => {
        if (edge.source === tableName || edge.target === tableName) {
          const paths = svg.querySelectorAll('path');
          if (paths[i]) paths[i].setAttribute('opacity', '1');
        }
      });
    });
  });

  const legend = document.getElementById('er-legend');
  legend.innerHTML = domainKeys.map(dk => '<div class="item"><div class="dot" style="background:' + (DOMAIN_COLORS[dk] || '#64748b') + '"></div>' + esc(Model_domains_label(dk)) + '</div>').join('')
    + '<div class="item"><div class="dot" style="background:#f85149"></div>ON DELETE CASCADE</div>'
    + '<div class="item"><div class="dot" style="background:#d29922"></div>ON DELETE SET NULL</div>';
}

function Model_domains_label(key) {
  const d = MODEL.domains.find(d => d.key === key);
  return d ? d.label : key;
}

function erZoom(delta) {
  erScale = Math.max(0.3, Math.min(3, erScale + delta));
  const svg = document.getElementById('er-svg');
  const vb = svg.getAttribute('viewBox').split(' ').map(Number);
  const cx = vb[2] / 2, cy = vb[3] / 2;
  const nw = vb[2] / erScale, nh = vb[3] / erScale;
  svg.setAttribute('viewBox', (cx - nw/2) + ' ' + (cy - nh/2) + ' ' + nw + ' ' + nh);
}
function erReset() {
  erScale = 1;
  const svg = document.getElementById('er-svg');
  svg.setAttribute('viewBox', svg.getAttribute('data-original-vb') || '0 0 1000 700');
}
(function() {
  const svg = document.getElementById('er-svg');
  let isDrag = false, sx = 0, sy = 0, vbx = 0, vby = 0;
  svg.addEventListener('mousedown', e => {
    if (e.target.tagName === 'g' || e.target.closest('.er-node')) return;
    isDrag = true; sx = e.clientX; sy = e.clientY;
    const vb = svg.getAttribute('viewBox').split(' ').map(Number);
    vbx = vb[0]; vby = vb[1];
    svg.style.cursor = 'grabbing';
  });
  document.addEventListener('mousemove', e => {
    if (!isDrag) return;
    const dx = (e.clientX - sx) / erScale;
    const dy = (e.clientY - sy) / erScale;
    const vb = svg.getAttribute('viewBox').split(' ').map(Number);
    svg.setAttribute('viewBox', (vbx - dx) + ' ' + (vby - dy) + ' ' + vb[2] + ' ' + vb[3]);
  });
  document.addEventListener('mouseup', () => { isDrag = false; svg.style.cursor = 'grab'; });
  svg.addEventListener('wheel', e => { e.preventDefault(); erZoom(e.deltaY > 0 ? -0.1 : 0.1); });
})();

// ---- Tables ----
function renderTables() {
  const query = (document.getElementById('table-search')?.value || '').toLowerCase();
  const grid = document.getElementById('table-grid');
  let tables = MODEL.tableDetails || [];
  if (currentDomain !== 'all') tables = tables.filter(t => t.domain === currentDomain);
  if (query) {
    tables = tables.filter(t => {
      if (t.name.toLowerCase().includes(query)) return true;
      if ((t.comment || '').toLowerCase().includes(query)) return true;
      if (t.columns.some(c => c.name.toLowerCase().includes(query))) return true;
      return false;
    });
  }
  if (tables.length === 0) { grid.innerHTML = '<div style="color:var(--fg-dim);padding:20px;">没有匹配的表</div>'; return; }
  grid.innerHTML = tables.map(t => {
    const dc = DOMAIN_COLORS[t.domain] || '#64748b';
    const cols = t.columns.map(c => {
      const keyBadge = c.key === 'PK' ? '<span class="badge badge-pk">PK</span>' : c.key === 'UNIQUE' ? '<span class="badge badge-uniq">UQ</span>' : '';
      return '<div class="col-row"><span class="col-name">' + esc(c.name) + '</span><span class="col-type">' + esc(c.type) + '</span><span class="col-key">' + keyBadge + '</span></div>';
    }).join('');
    const fks = (t.foreignKeys || []).map(fk => '<div style="font-size:11px;color:var(--fg-dim);padding:2px 0;">FK: ' + esc(fk.columns.join(',')) + ' → ' + esc(fk.refTable) + '(' + esc(fk.refColumns.join(',')) + ')' + (fk.onDelete ? ' [ON DELETE ' + fk.onDelete + ']' : '') + '</div>').join('');
    const idxs = (t.indexes || []).map(idx => '<div style="font-size:11px;color:var(--fg-dim);padding:1px 0;">IDX: ' + esc(idx.name) + ' (' + esc(idx.columns.join(',')) + ')' + (idx.unique ? ' [UNIQUE]' : '') + '</div>').join('');
    const patterns = (t.patterns || []).map(p => '<span class="badge badge-pattern">' + p + '</span>').join(' ');
    return '<div class="card" onclick="this.classList.toggle(\\'expanded\\')">' +
      '<div class="title">' + esc(t.name) + '</div>' +
      '<div class="desc">' + esc(t.comment || '') + '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">' +
        '<span class="badge badge-domain" style="color:' + dc + ';border-color:' + dc + '40">' + esc(t.domainLabel) + '</span>' +
        '<span class="badge">' + t.columns.length + ' 列</span>' +
        '<span class="badge">' + (t.foreignKeys || []).length + ' FK</span>' +
        '<span class="badge">' + (t.indexes || []).length + ' 索引</span>' +
        patterns +
      '</div>' +
      '<div class="cols">' + cols + fks + idxs + '</div>' +
    '</div>';
  }).join('');
}

(function() {
  const filters = document.getElementById('domain-filters');
  filters.innerHTML = '<div class="domain-filter active" data-domain="all" onclick="setDomain(this,\\'all\\')">全部</div>' +
    MODEL.domains.map(d => '<div class="domain-filter" data-domain="' + d.key + '" onclick="setDomain(this,\\'' + d.key + '\\')" style="border-color:' + d.color + '40">' + esc(d.label) + ' (' + d.tableCount + ')</div>').join('');
})();

function setDomain(el, d) {
  document.querySelectorAll('.domain-filter').forEach(f => f.classList.remove('active'));
  el.classList.add('active');
  currentDomain = d;
  renderTables();
}

// ---- Foreign Keys ----
(function() {
  const list = document.getElementById('fk-list');
  if (!MODEL.foreignKeys || MODEL.foreignKeys.length === 0) {
    list.innerHTML = '<div class="er-empty">无外键关系</div>';
    return;
  }
  list.innerHTML = MODEL.foreignKeys.map(fk => {
    const delClass = fk.onDelete ? fk.onDelete.replace(/\\s/g, '') : '';
    return '<div class="fk-card">' +
      '<span class="from">' + esc(fk.fromTable) + '</span>' +
      '<span class="cols">(' + esc(fk.fromColumns.join(',')) + ')</span>' +
      '<span class="arrow">→</span>' +
      '<span class="to">' + esc(fk.toTable) + '</span>' +
      '<span class="cols">(' + esc(fk.toColumns.join(',')) + ')</span>' +
      (fk.onDelete ? '<span class="on-delete ' + delClass + '">' + fk.onDelete + '</span>' : '') +
      (fk.onUpdate ? '<span class="on-delete">' + fk.onUpdate + '</span>' : '') +
    '</div>';
  }).join('');
})();

// ---- Migrations ----
(function() {
  const tl = document.getElementById('timeline');
  if (!MODEL.migrationTimeline || MODEL.migrationTimeline.length === 0) {
    tl.innerHTML = '<div class="er-empty">无迁移记录</div>';
    return;
  }
  tl.innerHTML = MODEL.migrationTimeline.map(m => {
    const ops = Object.entries(m.operationSummary || {}).filter(([, v]) => v > 0).map(([k, v]) => '<span>' + k + ':' + v + '</span>').join('');
    return '<div class="timeline-item">' +
      '<div class="ver">' + esc(m.version) + '</div>' +
      '<div class="desc">' + esc(m.description) + ' · ' + m.tableCount + ' 表' + (m.hasIdempotentDdl ? ' · 幂等DDL' : '') + '</div>' +
      '<div class="ops">' + ops + '</div>' +
    '</div>';
  }).join('');
})();

// ---- Patterns ----
(function() {
  const grid = document.getElementById('pattern-grid');
  const patterns = [
    { key: 'softDelete', label: '软删除', list: MODEL.schemaPatterns.softDelete },
    { key: 'auditColumns', label: '审计字段', list: MODEL.schemaPatterns.auditColumns },
    { key: 'selfReference', label: '自引用外键', list: MODEL.schemaPatterns.selfReference },
    { key: 'multiTenant', label: '多租户', list: MODEL.schemaPatterns.multiTenant },
    { key: 'uuidPrimary', label: 'UUID 主键', list: MODEL.schemaPatterns.uuidPrimary },
  ];
  grid.innerHTML = patterns.map(p => {
    return '<div class="pattern-card">' +
      '<div class="pname">' + p.label + '</div>' +
      '<div class="pcount">' + p.list.length + '</div>' +
      '<div class="plist">' + p.list.map(esc).join(', ') + '</div>' +
    '</div>';
  }).join('');

  const idemStats = document.getElementById('idempotent-stats');
  const idemCount = (MODEL.migrationTimeline || []).filter(m => m.hasIdempotentDdl).length;
  idemStats.innerHTML = '使用幂等 DDL 模式的迁移文件: <strong>' + idemCount + '</strong> / ' + (MODEL.migrationTimeline || []).length + ' 总数';

  const milestones = document.getElementById('milestones');
  const versions = (MODEL.migrationTimeline || []).map(m => m.version);
  const majorVersions = {};
  versions.forEach(v => {
    const major = v.replace(/^(V\\d+\\.\\d+).*$/, '$1');
    if (!majorVersions[major]) majorVersions[major] = { count: 0, first: v, last: v };
    majorVersions[major].count++;
    majorVersions[major].last = v;
  });
  milestones.innerHTML = Object.entries(majorVersions).map(([major, info]) => {
    return '<div class="panel" style="display:inline-block;margin-right:12px;margin-bottom:8px;">' +
      '<strong>' + esc(major) + '</strong> · ' + info.count + ' 个迁移 (' + esc(info.first) + ' → ' + esc(info.last) + ')' +
    '</div>';
  }).join('');
})();

// ---- Health Dashboard ----
(function() {
  const h = MODEL.audits?.health;
  if (!h) return;

  const gradeColor = h.grade === 'A' ? 'var(--green)' : h.grade === 'B' ? 'var(--blue)' : h.grade === 'C' ? 'var(--amber)' : 'var(--red)';
  document.getElementById('health-score').innerHTML =
    '<div class="health-score">' +
      '<div class="score-ring" style="border-color:' + gradeColor + '30;border-top-color:' + gradeColor + '">' +
        '<div class="score-num" style="color:' + gradeColor + '">' + h.score + '</div>' +
        '<div class="score-grade">等级 ' + h.grade + '</div>' +
      '</div>' +
      '<div class="score-meta">' +
        '<h2>Schema 健康度总评</h2>' +
        '<div style="color:var(--fg-dim);margin-bottom:8px;">共发现 ' + h.totalIssues + ' 个问题，' + (h.recommendations?.length || 0) + ' 条优化建议</div>' +
        '<div style="display:flex;gap:16px;flex-wrap:wrap;">' +
          '<span style="color:var(--red);">● ' + (h.topIssues?.filter(i => i.severity === 'high').length || 0) + ' 高危</span>' +
          '<span style="color:var(--amber);">● ' + (h.topIssues?.filter(i => i.severity === 'medium').length || 0) + ' 中危</span>' +
          '<span style="color:var(--blue);">● ' + (h.topIssues?.filter(i => i.severity === 'low').length || 0) + ' 低危</span>' +
        '</div>' +
      '</div>' +
    '</div>';

  const dimLabels = { completeness: '完整性', consistency: '一致性', indexQuality: '索引质量', patternHealth: '模式健康' };
  const dimColors = { completeness: 'var(--green)', consistency: 'var(--blue)', indexQuality: 'var(--purple)', patternHealth: 'var(--cyan)' };
  const dimHtml = Object.entries(h.dimensions || {}).map(([key, dim]) => {
    const color = dim.score >= 80 ? 'var(--green)' : dim.score >= 60 ? 'var(--amber)' : 'var(--red)';
    return '<div class="dim-card">' +
      '<div class="dim-name">' + (dimLabels[key] || key) + '</div>' +
      '<div class="dim-score" style="color:' + color + '">' + dim.score + '</div>' +
      '<div class="dim-bar"><div class="dim-bar-fill" style="width:' + dim.score + '%;background:' + color + '"></div></div>' +
    '</div>';
  }).join('');
  document.getElementById('health-dimensions').innerHTML = dimHtml;

  const issuesHtml = (h.topIssues || []).slice(0, 15).map(i =>
    '<div class="issue-item ' + i.severity + '">' +
      '<strong>' + (i.severity === 'high' ? '高危' : i.severity === 'medium' ? '中危' : '低危') + '</strong> · ' +
      esc(i.message) +
    '</div>'
  ).join('') || '<div style="color:var(--fg-dim);">暂无问题</div>';
  document.getElementById('health-issues').innerHTML = issuesHtml;

  const recsHtml = (h.recommendations || []).map(r => '<li>' + esc(r) + '</li>').join('');
  document.getElementById('health-recs').innerHTML = recsHtml || '<li style="color:var(--fg-dim);">暂无建议</li>';
})();

// ---- Evolution Analysis ----
(function() {
  const evo = MODEL.audits?.evolution;
  if (!evo || !evo.timeline || evo.timeline.length === 0) return;

  // 表数增长曲线
  const growthSvg = document.getElementById('evo-chart-growth');
  const tl = evo.timeline;
  const W = 900, H = 260, padL = 50, padR = 20, padT = 20, padB = 40;
  const chartW = W - padL - padR, chartH = H - padT - padB;
  const maxVal = Math.max(...tl.map(t => t.cumulativeTables), 1);
  const n = tl.length;

  let points = tl.map((t, i) => {
    const x = padL + (i / Math.max(n - 1, 1)) * chartW;
    const y = padT + chartH - (t.cumulativeTables / maxVal) * chartH;
    return { x, y, val: t.cumulativeTables, ver: t.version };
  });

  let pathD = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x + ',' + p.y).join(' ');
  let areaD = pathD + ' L' + points[points.length - 1].x + ',' + (padT + chartH) + ' L' + points[0].x + ',' + (padT + chartH) + ' Z';

  // Y 轴刻度
  let yTicks = '';
  for (let i = 0; i <= 4; i++) {
    const val = Math.round((maxVal * i) / 4);
    const y = padT + chartH - (val / maxVal) * chartH;
    yTicks += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#30363d" stroke-dasharray="2,3"/>' +
      '<text x="' + (padL - 6) + '" y="' + (y + 4) + '" text-anchor="end" fill="#8b949e" font-size="10">' + val + '</text>';
  }

  // X 轴标签（每隔几个显示一个）
  let xLabels = '';
  const labelStep = Math.max(1, Math.floor(n / 8));
  tl.forEach((t, i) => {
    if (i % labelStep !== 0 && i !== n - 1) return;
    const x = padL + (i / Math.max(n - 1, 1)) * chartW;
    xLabels += '<text x="' + x + '" y="' + (H - padB + 16) + '" text-anchor="middle" fill="#8b949e" font-size="10" transform="rotate(-30 ' + x + ',' + (H - padB + 16) + ')">' + esc(t.version) + '</text>';
  });

  growthSvg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  growthSvg.innerHTML = yTicks + xLabels +
    '<path d="' + areaD + '" fill="rgba(88,166,255,0.15)" stroke="none"/>' +
    '<path d="' + pathD + '" fill="none" stroke="var(--blue)" stroke-width="2"/>' +
    points.filter((_, i) => i % labelStep === 0 || i === points.length - 1).map(p =>
      '<circle cx="' + p.x + '" cy="' + p.y + '" r="3" fill="var(--blue)"/>'
    ).join('');

  // 操作类型分布（堆叠柱状图）
  const opsSvg = document.getElementById('evo-chart-ops');
  const opCategories = ['create', 'alter', 'index', 'drop', 'dml', 'other'];
  const opColors = { create: '#4ade80', alter: '#58a6ff', index: '#a78bfa', drop: '#f85149', dml: '#d29922', other: '#64748b' };
  const opLabels = { create: 'CREATE', alter: 'ALTER', index: 'INDEX', drop: 'DROP', dml: 'DML', other: '其他' };

  const maxOps = Math.max(...tl.map(t => t.operationCount || 1), 1);
  const barW = Math.max(4, chartW / n - 2);

  let barsHtml = '';
  tl.forEach((t, i) => {
    const x = padL + (i / Math.max(n - 1, 1)) * chartW - barW / 2;
    let cumY = 0;
    const opTypes = t.opTypes || {};
    for (const cat of opCategories) {
      const count = opTypes[cat] || 0;
      if (count === 0) continue;
      const barH = (count / maxOps) * chartH;
      const y = padT + chartH - cumY - barH;
      barsHtml += '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + barH + '" fill="' + opColors[cat] + '"/>';
      cumY += barH;
    }
  });

  // Y 轴
  let yTicks2 = '';
  for (let i = 0; i <= 4; i++) {
    const val = Math.round((maxOps * i) / 4);
    const y = padT + chartH - (val / maxOps) * chartH;
    yTicks2 += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#30363d" stroke-dasharray="2,3"/>' +
      '<text x="' + (padL - 6) + '" y="' + (y + 4) + '" text-anchor="end" fill="#8b949e" font-size="10">' + val + '</text>';
  }

  opsSvg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  opsSvg.innerHTML = yTicks2 + xLabels + barsHtml;

  // 图例
  const legendHtml = opCategories.map(cat =>
    '<div class="legend-item"><div class="legend-dot" style="background:' + opColors[cat] + '"></div>' + opLabels[cat] + '</div>'
  ).join('');
  document.getElementById('evo-ops-legend').innerHTML = legendHtml;

  // 领域首版
  const domainFirst = evo.domainFirstVersions || {};
  const domainArr = Object.entries(domainFirst).sort((a, b) => a[1].localeCompare(b[1]));
  document.getElementById('evo-domain-first').innerHTML = domainArr.length ?
    '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
      domainArr.map(([key, ver]) => {
        const d = MODEL.domains.find(d => d.key === key);
        const color = d?.color || '#64748b';
        return '<span class="badge badge-domain" style="color:' + color + ';border-color:' + color + '40">' +
          esc(d?.label || key) + ' → ' + esc(ver) + '</span>';
      }).join('') +
    '</div>' :
    '<div style="color:var(--fg-dim);">暂无数据</div>';

  // 演进趋势
  const tr = evo.trends || {};
  document.getElementById('evo-trends').innerHTML =
    '<div style="line-height:1.8;">' +
      '<div>总版本数：<strong>' + evo.totalVersions + '</strong> · 最终表数：<strong>' + evo.finalTableCount + '</strong></div>' +
      '<div>早期 CREATE 占比：<strong>' + Math.round((tr.earlyCreateRatio || 0) * 100) + '%</strong></div>' +
      '<div>后期 ALTER 占比：<strong>' + Math.round((tr.lateAlterRatio || 0) * 100) + '%</strong></div>' +
      '<div style="color:var(--fg-dim);margin-top:8px;">' + esc(tr.description || '') + '</div>' +
      (evo.milestones && evo.milestones.length > 0 ?
        '<div style="margin-top:12px;"><strong>重大里程碑：</strong><br>' +
        evo.milestones.slice(0, 5).map(m =>
          '<span class="badge" style="margin:2px 4px 2px 0;">' + esc(m.version) + ' · ' + m.tableCount + ' 表</span>'
        ).join('') +
        '</div>' : '') +
    '</div>';
})();

// ---- Index Optimization ----
(function() {
  const idx = MODEL.audits?.indexes;
  const dom = MODEL.audits?.domains;
  if (!idx) return;

  // 指标卡
  const metrics = [
    { val: idx.totalIndexCount, label: '索引总数' },
    { val: idx.perTableAvg, label: '表均索引' },
    { val: idx.unindexedFkCount, label: '未建索引FK', color: 'var(--amber)' },
    { val: Math.round((1 - (idx.unindexedFkRatio || 0)) * 100) + '%', label: 'FK索引覆盖率' },
    { val: idx.redundantIndexCount, label: '冗余索引' },
    { val: idx.wideIndexCount, label: '宽索引(>4列)' },
  ];
  document.getElementById('idx-metrics').innerHTML = metrics.map(m =>
    '<div class="metric-card">' +
      '<div class="metric-val" style="color:' + (m.color || 'var(--blue)') + '">' + m.val + '</div>' +
      '<div class="metric-label">' + m.label + '</div>' +
    '</div>'
  ).join('');

  // 主键类型分布
  const pkDist = idx.pkTypeDistribution || {};
  const pkLabels = { autoIncrementInt: '自增INT', uuid: 'UUID', composite: '复合主键', other: '其他' };
  const pkTotal = Object.values(pkDist).reduce((s, v) => s + v, 0) || 1;
  const pkMax = Math.max(...Object.values(pkDist), 1);
  document.getElementById('idx-pk-dist').innerHTML = Object.entries(pkDist).map(([key, val]) => {
    const h = Math.round((val / pkMax) * 100);
    return '<div class="pk-bar">' +
      '<div class="val">' + val + '</div>' +
      '<div class="pk-bar-fill" style="height:' + h + 'px;"></div>' +
      '<div class="label">' + (pkLabels[key] || key) + '</div>' +
    '</div>';
  }).join('');

  // 未建索引外键
  const unindexed = idx.unindexedFks || [];
  document.getElementById('idx-unindexed').innerHTML = unindexed.length ?
    unindexed.map(item =>
      '<div class="issue-item medium"><strong>' + esc(item.table) + '</strong>.' + esc(item.column) +
      ' <span style="color:var(--fg-dim);font-size:12px;">（外键: ' + esc(item.fkName || 'N/A') + '）</span></div>'
    ).join('') :
    '<div style="color:var(--green);">✓ 所有外键列均已建索引</div>';

  // 冗余索引
  const redundant = idx.redundantIndexes || [];
  document.getElementById('idx-redundant').innerHTML = redundant.length ?
    redundant.map(item =>
      '<div class="issue-item low"><strong>' + esc(item.table) + '</strong>.' + esc(item.index) +
      ' <span style="color:var(--fg-dim);font-size:12px;">被 ' + esc(item.redundantWith) + ' 包含</span></div>'
    ).join('') :
    '<div style="color:var(--green);">✓ 未发现冗余索引</div>';

  // 领域耦合度表
  if (dom && dom.coupling) {
    const tbody = document.querySelector('#domain-coupling tbody');
    tbody.innerHTML = dom.coupling.map(c => {
      const d = MODEL.domains.find(d => d.key === c.key);
      const color = d?.color || '#64748b';
      return '<tr>' +
        '<td><span style="color:' + color + ';">●</span> ' + esc(c.label || c.key) + '</td>' +
        '<td>' + c.tableCount + '</td>' +
        '<td>' + c.outDegree + '</td>' +
        '<td>' + c.inDegree + '</td>' +
        '<td><strong>' + c.totalDegree + '</strong></td>' +
      '</tr>';
    }).join('');
  }

  // 优化建议
  const recs = idx.recommendations || [];
  document.getElementById('idx-recs').innerHTML = recs.length ?
    recs.map(r => '<li>' + esc(r) + '</li>').join('') :
    '<li style="color:var(--fg-dim);">暂无建议</li>';
})();

// init
renderTables();
renderER();
const origSvg = document.getElementById('er-svg');
origSvg.setAttribute('data-original-vb', origSvg.getAttribute('viewBox'));

function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
</script>
</body>
</html>`;
}
