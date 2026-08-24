// 数据蓝图 dataoverview HTML 生成器
// 数据流：db-snapshot.json（DbDataMap）→ buildDbViewerModel()（视图模型）→ renderDbOverviewHtml()（HTML）
// 十个视图：
//   1. ER 关系图（SVG）：表节点 + 外键边 + 领域分组 + 缩放平移
//   2. 数据统计：表/列/外键/索引规模画像（KPI + 领域分布条形图/环形图 + DDL 操作分布 + 列类型分布 + Top 宽表/迁移）
//   3. 数据图谱：表 / 领域两级关系网络力导向图（内联力模拟，零依赖可离线；FK 边 + 跨域耦合边）
//   4. 表清单：搜索 + 领域过滤 + 表卡片（列/索引/外键展开）
//   5. 外键关系：源表 → 目标表引用卡片 + ON DELETE/UPDATE
//   6. 迁移时间线：版本排序 + 操作统计
//   7. 建模特征：模式统计 + 演进里程碑
//   8. 健康总览：仪表盘（评分 / 等级 / 维度得分 / Top 问题 / 建议）
//   9. 演进分析：表数增长曲线 + 操作类型分布 + 里程碑 + 领域首版
//  10. 索引优化：外键索引覆盖率 + 冗余索引 + 宽索引 + 主键类型分布

import {
  auditHealth, auditDomains, auditIndexes, auditEvolution, auditNaming, auditEntities,
} from './dbAuditor.js';
import { buildEntities, classifyTableKind, TABLE_KIND_LABELS } from './dbModel.js';
import { buildThemeCss, DEFAULT_THEMES } from '../themes/index.js';
import { SHARED_CSS } from '../themes/sharedCss.js';
import { RING_JS } from '../themes/ring.js';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 数据图谱保护：力导向图节点 / 边上限（大库表可达数百张，领域通常十几个）
const DB_TABLE_GRAPH_NODE_CAP = 150;
const DB_DOMAIN_GRAPH_NODE_CAP = 24;
const DB_GRAPH_EDGE_CAP = 600;

// DDL/DML 操作类型 → 展示标签（键与 sqlAnalyzer operationSummary 对齐）
const DB_OPERATION_LABELS = {
  createTable: 'CREATE TABLE',
  alterTable: 'ALTER TABLE',
  createIndex: 'CREATE INDEX',
  dropTable: 'DROP TABLE',
  createView: 'CREATE VIEW',
  createTrigger: 'CREATE TRIGGER',
  createProcedure: 'CREATE PROC/FUNC',
  insert: 'INSERT',
  update: 'UPDATE',
};

// 列类型归一化：VARCHAR(255) → VARCHAR，INT UNSIGNED → INT（取首个类型词）
function baseColumnType(type) {
  const m = String(type || '').toUpperCase().match(/^[A-Z][A-Z0-9_]*/);
  return m ? m[0] : '?';
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

  // 表 → 领域键映射（键与 domains 数组一致，含多库前缀 "db:domain"；统计与图谱共用）
  const domainKeyOf = new Map();
  for (const t of tables) {
    domainKeyOf.set(t.name, t.database ? `${t.database}:${t.domain}` : (t.domain || 'other'));
  }

  // ---- 数据库统计（DB Stats）：表/列/外键/索引规模画像 ----
  const stats = (() => {
    if (!tables.length) return null;
    const totalColumns = tables.reduce((a, t) => a + (t.columns || []).length, 0);
    const totalIndexes = tables.reduce((a, t) => a + (t.indexes || []).length, 0);

    // 领域分布（按列数排序——比表数更能反映数据体量；键与 domains 数组一致，含多库前缀）
    const domainAgg = new Map();
    for (const t of tables) {
      const key = domainKeyOf.get(t.name);
      const d = domainAgg.get(key) ?? { key, label: t.domainLabel || t.domain || key, tables: 0, columns: 0, fks: 0 };
      d.tables += 1;
      d.columns += (t.columns || []).length;
      d.fks += (t.foreignKeys || []).length;
      domainAgg.set(key, d);
    }
    const byDomain = [...domainAgg.values()].sort((a, b) => b.columns - a.columns || b.tables - a.tables);
    byDomain.forEach((d) => { d.pct = totalColumns > 0 ? +((100 * d.columns) / totalColumns).toFixed(1) : 0; });

    // DDL/DML 操作类型分布（聚合所有迁移版本的 operationSummary）
    const opAgg = new Map();
    for (const m of migrations) {
      for (const [k, v] of Object.entries(m.operationSummary || {})) {
        if (!v) continue;
        const e = opAgg.get(k) ?? { key: k, label: DB_OPERATION_LABELS[k] ?? k, count: 0 };
        e.count += v;
        opAgg.set(k, e);
      }
    }
    const byOperation = [...opAgg.values()].sort((a, b) => b.count - a.count);

    // 列类型分布（归一化基础类型）
    const typeAgg = new Map();
    for (const t of tables) {
      for (const c of t.columns || []) {
        const base = baseColumnType(c.type);
        const e = typeAgg.get(base) ?? { type: base, count: 0 };
        e.count += 1;
        typeAgg.set(base, e);
      }
    }
    const totalTypedColumns = [...typeAgg.values()].reduce((a, e) => a + e.count, 0);
    const byColumnType = [...typeAgg.values()].sort((a, b) => b.count - a.count);
    byColumnType.forEach((e) => { e.pct = totalTypedColumns > 0 ? +((100 * e.count) / totalTypedColumns).toFixed(1) : 0; });

    const topTables = tables
      .map((t) => ({
        name: t.name,
        domainLabel: t.domainLabel || t.domain || null,
        comment: t.comment || null,
        columnCount: (t.columns || []).length,
        fkCount: (t.foreignKeys || []).length,
        indexCount: (t.indexes || []).length,
      }))
      .sort((a, b) => b.columnCount - a.columnCount || a.name.localeCompare(b.name))
      .slice(0, 20);

    const topMigrations = migrations
      .map((m) => ({
        version: m.version,
        description: m.description,
        ops: Object.values(m.operationSummary || {}).reduce((a, v) => a + v, 0),
        tableCount: (m.tableNames || []).length,
      }))
      .sort((a, b) => b.ops - a.ops || String(a.version).localeCompare(String(b.version)))
      .slice(0, 10);

    // 实体层统计（DDD）：主实体聚合 / 关联表 / 链接表分类
    const entityAggs = buildEntities(tables, foreignKeys).filter((e) => e.kind === 'aggregate');
    const kindCounts = { entity: 0, association: 0, link: 0 };
    for (const t of tables) kindCounts[classifyTableKind(t)] += 1;

    return {
      totalTables: tables.length,
      totalColumns,
      totalFks: foreignKeys.length,
      totalIndexes,
      totalMigrations: migrations.length,
      totalViews: views.length,
      totalTriggers: triggers.length,
      totalProcedures: procedures.length,
      avgColumnsPerTable: tables.length ? Math.round((totalColumns / tables.length) * 10) / 10 : 0,
      entityCounts: {
        aggregates: entityAggs.length,
        associations: kindCounts.association,
        links: kindCounts.link,
        isolated: entityAggs.filter((e) => e.fkInCount + e.fkOutCount === 0).length,
      },
      byDomain,
      byOperation,
      byColumnType,
      topTables,
      topMigrations,
    };
  })();

  // ---- 数据关系图谱（Data Graph）：表 / 领域两级网络（供力导向图渲染）----
  const dataGraph = (() => {
    if (!tables.length) return null;

    // 表视图：节点 = 表（大小 ∝ 列数，颜色 = 领域），边 = 外键引用（同向聚合权重）
    const tableView = (() => {
      const tableNames = new Set(tables.map((t) => t.name));
      const degree = new Map();
      const edgeAgg = new Map();
      for (const fk of foreignKeys) {
        // 悬挂外键（指向不存在的表）不建边，只计入审计
        if (!tableNames.has(fk.fromTable) || !tableNames.has(fk.toTable)) continue;
        degree.set(fk.fromTable, (degree.get(fk.fromTable) ?? 0) + 1);
        degree.set(fk.toTable, (degree.get(fk.toTable) ?? 0) + 1);
        const key = fk.fromTable + '>' + fk.toTable;
        const e = edgeAgg.get(key) ?? { source: fk.fromTable, target: fk.toTable, kind: 'fk', weight: 0 };
        e.weight += 1;
        edgeAgg.set(key, e);
      }
      const domainColor = new Map(domains.map((d) => [d.key, d.color]));
      const ranked = tables
        .slice()
        .sort((a, b) => (degree.get(b.name) ?? 0) - (degree.get(a.name) ?? 0)
          || (b.columns || []).length - (a.columns || []).length
          || a.name.localeCompare(b.name))
        .slice(0, DB_TABLE_GRAPH_NODE_CAP);
      const kept = new Set(ranked.map((t) => t.name));
      const nodes = ranked.map((t) => ({
        id: t.name,
        name: t.name,
        domainKey: domainKeyOf.get(t.name) ?? null,
        domainLabel: t.domainLabel || t.domain || null,
        color: domainColor.get(domainKeyOf.get(t.name)) ?? '#94a3b8',
        kind: classifyTableKind(t),
        columns: (t.columns || []).length,
        fks: (t.foreignKeys || []).length,
        indexes: (t.indexes || []).length,
        comment: t.comment || null,
        createdAt: t.createdAt ?? null,
      }));
      const edges = [...edgeAgg.values()]
        .filter((e) => kept.has(e.source) && kept.has(e.target))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, DB_GRAPH_EDGE_CAP);
      return {
        nodes,
        edges,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        hiddenTableCount: Math.max(0, tables.length - nodes.length),
      };
    })();

    // 领域视图：节点 = 领域（大小 ∝ 表数），边 = 跨领域外键聚合（权重 = FK 数；域内 FK 不建边）
    const domainView = (() => {
      if (!domains.length) return null;
      const edgeAgg = new Map();
      for (const fk of foreignKeys) {
        const src = domainKeyOf.get(fk.fromTable);
        const dst = domainKeyOf.get(fk.toTable);
        if (!src || !dst || src === dst) continue;
        const key = src + '>' + dst;
        const e = edgeAgg.get(key) ?? { source: src, target: dst, kind: 'domainFk', weight: 0 };
        e.weight += 1;
        edgeAgg.set(key, e);
      }
      const columnAgg = new Map();
      for (const t of tables) {
        const key = domainKeyOf.get(t.name);
        if (!key) continue;
        columnAgg.set(key, (columnAgg.get(key) ?? 0) + (t.columns || []).length);
      }
      const nodes = domains
        .slice()
        .sort((a, b) => b.tableCount - a.tableCount)
        .slice(0, DB_DOMAIN_GRAPH_NODE_CAP)
        .map((d) => ({ id: d.key, name: d.label, color: d.color, tables: d.tableCount, columns: columnAgg.get(d.key) ?? 0 }));
      const nodeIds = new Set(nodes.map((n) => n.id));
      const edges = [...edgeAgg.values()]
        .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, DB_GRAPH_EDGE_CAP);
      return { nodes, edges, nodeCount: nodes.length, edgeCount: edges.length };
    })();

    return { tableView, domainView };
  })();

  // 审计数据
  const healthAudit = auditHealth(dbDataMap);
  const domainsAudit = auditDomains(dbDataMap);
  const indexesAudit = auditIndexes(dbDataMap);
  const evolutionAudit = auditEvolution(dbDataMap);
  const namingAudit = auditNaming(dbDataMap);
  const entitiesAudit = auditEntities(dbDataMap);

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
    stats,
    dataGraph,
    views,
    triggers,
    procedures,
    audits: {
      health: healthAudit,
      domains: domainsAudit,
      indexes: indexesAudit,
      evolution: evolutionAudit,
      naming: namingAudit,
      entities: entitiesAudit,
    },
  };
}

export function renderDbOverviewHtml(model, options = {}) {
  const dataJson = JSON.stringify(model).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
  const title = esc(model.meta.sourceDir ? model.meta.sourceDir.split('/').pop() : '数据库蓝图');
  const theme = options.theme || DEFAULT_THEMES.db;

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${esc(theme)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} · 数据库蓝图</title>
<style>
${buildThemeCss(theme)}
${SHARED_CSS}
/* ---- 布局骨架固定，以下为数据库蓝图专属样式 ---- */
/* 顶部统计卡片：固定 8 项，网格均分整行（flex 版本窄屏会出现"7 张挤一行 + 1 张孤卡拉满整行"） */
.stats { display: grid; grid-template-columns: repeat(8, 1fr); }
.stats .stat { flex: none; }
@media (max-width: 1080px) { .stats { grid-template-columns: repeat(4, 1fr); } }
@media (max-width: 560px) { .stats { grid-template-columns: repeat(2, 1fr); } }
.badge-domain { font-weight: 500; }
.badge-pk { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 40%, transparent); }
.badge-fk { color: var(--purple); border-color: color-mix(in srgb, var(--purple) 40%, transparent); }
.badge-uniq { color: var(--cyan); border-color: color-mix(in srgb, var(--cyan) 40%, transparent); }
.badge-pattern { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); font-size: 10px; }
.cols { display: none; margin-top: 10px; border-top: 1px solid var(--border); padding-top: 10px; }
.card.expanded .cols { display: block; }
.col-row { display: flex; gap: 8px; padding: 3px 0; font-size: 12px; font-family: 'SF Mono', Menlo, monospace; }
.col-name { min-width: 120px; color: var(--fg); }
.col-type { min-width: 140px; color: var(--fg-dim); }
.col-key { min-width: 40px; }
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
.fk-card .on-delete.CASCADE { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); }
.fk-card .on-delete.SET\\ NULL { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 40%, transparent); }
.fk-card .on-delete.RESTRICT { color: var(--cyan); border-color: color-mix(in srgb, var(--cyan) 40%, transparent); }
.er-container { position: relative; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.er-toolbar { position: absolute; top: 8px; right: 8px; z-index: 10; display: flex; gap: 4px; }
.er-toolbar button { padding: 4px 10px; font-size: 12px; background: var(--panel2); border: 1px solid var(--border); border-radius: 4px; color: var(--fg-dim); cursor: pointer; }
.er-toolbar button:hover { color: var(--fg); }
.er-legend { position: absolute; bottom: 8px; left: 8px; z-index: 10; background: var(--panel2); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; font-size: 11px; }
.er-legend .item { display: flex; align-items: center; gap: 4px; margin: 2px 0; }
.er-legend .dot { width: 10px; height: 10px; border-radius: 2px; }
.er-empty { text-align: center; padding: 40px; color: var(--fg-dim); }
/* Health dashboard（基础仪表盘样式见共享骨架，此处仅数据库专属） */
.health-score .score-meta { flex: 1; }
.health-score .score-meta h2 { font-size: 18px; margin-bottom: 8px; }
.rec-list { list-style: none; }
.rec-list li { padding: 6px 0 6px 24px; position: relative; font-size: 13px; }
.rec-list li::before { content: '→'; position: absolute; left: 0; color: var(--green); }
/* Evolution charts */
.chart-container { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
.chart-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
.chart-svg { width: 100%; height: auto; }
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
/* ---- 数据统计：横向条形图 + 环形图 ---- */
.db-split { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
@media (max-width: 900px) { .db-split { grid-template-columns: 1fr; } .hbar .lbl { width: 130px; } .hbar .sub { margin-left: 138px; } }
.hbar { margin-bottom: 9px; }
.hbar .row1 { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.hbar .lbl { width: 210px; flex-shrink: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--fg); }
.hbar .track { flex: 1; height: 8px; background: var(--panel2); border-radius: 4px; overflow: hidden; }
.hbar .fill { height: 100%; border-radius: 4px; background: var(--bar-c, var(--blue)); min-width: 2px; }
.hbar .val { width: 150px; flex-shrink: 0; text-align: right; color: var(--fg-dim); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.hbar .sub { font-size: 11px; color: var(--fg-faint); margin: 2px 0 0 218px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.donut-wrap { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.donut-legend { flex: 1; min-width: 220px; }
.donut-legend .dl-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 12px; color: var(--fg-dim); }
.donut-legend .dl-row .nm { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.donut-legend .dl-row .pv { font-variant-numeric: tabular-nums; white-space: nowrap; }
/* ---- 数据图谱：力导向图 ---- */
.dg-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.dg-toolbar button { padding: 4px 12px; font-size: 12px; background: var(--panel2); border: 1px solid var(--border); border-radius: 4px; color: var(--fg-dim); cursor: pointer; }
.dg-toolbar button:hover { color: var(--fg); }
.dg-toolbar button.on { color: var(--cyan); border-color: var(--cyan); background: color-mix(in srgb, var(--cyan) 10%, var(--panel2)); }
.dg-hint { font-size: 12px; color: var(--fg-faint); }
.dg-stage { border: 1px solid var(--border); border-radius: 8px; background: var(--panel2); overflow: hidden; position: relative; }
.dg-stage svg { display: block; width: 100%; height: auto; cursor: grab; touch-action: none; }
.dg-stage svg.dragging { cursor: grabbing; }
svg .dgn circle { stroke-width: 1.5; cursor: pointer; }
svg .dgn.association circle { fill-opacity: .8; }
svg .dgn.link circle { fill-opacity: .5; stroke-dasharray: 3 2; }
svg .dgn text { font-size: 10px; font-family: 'SF Mono', Menlo, monospace; fill: var(--fg-dim); paint-order: stroke; stroke: var(--panel2); stroke-width: 3px; pointer-events: none; }
svg .dgn text.big { fill: var(--fg); font-weight: 600; }
svg .dge { stroke: color-mix(in srgb, var(--purple) 55%, transparent); stroke-width: 1.1; }
svg .dge.domainFk { stroke: color-mix(in srgb, var(--blue) 60%, transparent); }
svg.focus .dgn { opacity: .18; }
svg.focus .dgn.hl { opacity: 1; }
svg.focus .dge { opacity: .06; }
svg.focus .dge.hl { opacity: 1; }
#dg-info { margin-top: 10px; min-height: 20px; font-size: 13px; }
#dg-info .name { font-family: 'SF Mono', Menlo, monospace; color: var(--purple); }
</style>
</head>
<body>
<header>
  <h1>${title} · 数据库蓝图</h1>
  <div class="sub">${esc(model.meta.sourceDir)} · 扫描于 ${esc(fmtLocalTime(model.meta.scannedAt) || 'N/A')}${model.meta.incremental ? ' · 增量' : ' · 全量'}</div>
  <div class="stats" id="stats"></div>
  <div class="tabs">
    <button class="tab-btn active" data-tab="er">ER 关系图</button>
    <button class="tab-btn" data-tab="dbstats">数据统计</button>
    <button class="tab-btn" data-tab="dbgraph">数据图谱</button>
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
<section class="view" id="view-dbstats">
  <div id="dbstats-body"></div>
</section>
<section class="view" id="view-dbgraph">
  <div id="dbgraph-body"></div>
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
${RING_JS}
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
    if (btn.dataset.tab === 'evolution') renderEvolution();
  });
});

// ---- ER Diagram ----
function renderER() {
  const svg = document.getElementById('er-svg');
  const graph = MODEL.foreignKeyGraph;
  if (!graph.nodes || graph.nodes.length === 0) {
    svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="var(--fg-dim)">无表数据</text>';
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
        html += '<text x="' + (p.x + 6) + '" y="' + cy + '" fill="' + (c.key === 'PK' ? 'var(--amber)' : 'var(--fg-dim)') + '" font-size="10" font-family="monospace">' + esc(c.name) + '</text>';
        html += '<text x="' + (p.x + 110) + '" y="' + cy + '" fill="var(--fg-faint)" font-size="9" font-family="monospace">' + esc(c.type) + '</text>';
        if (keyBadge) html += '<text x="' + (p.x + p.w - 14) + '" y="' + cy + '" fill="var(--amber)" font-size="10">' + keyBadge + '</text>';
      });
      if (table.columns.length > 5) {
        html += '<text x="' + (p.x + 6) + '" y="' + (p.y + 20 + 6 * colRowH - 4) + '" fill="var(--fg-faint)" font-size="9">+' + (table.columns.length - 5) + ' more...</text>';
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

// ---- 数据统计（DB Stats：KPI + 横向条形图 + 环形图，纯内联 SVG） ----
function fmt(n) { return String(n == null ? 0 : n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ','); }

// 环形图：r=15.9155 时周长恰为 100，dasharray 直接用百分比（与代码蓝图代码统计对齐）
function donutSvg(segs, centerVal, centerLabel) {
  const total = segs.reduce((a, s) => a + s.value, 0);
  if (!total) return '<div class="empty">无数据。</div>';
  let acc = 0;
  let circles = '';
  segs.forEach((s, i) => {
    const raw = (s.value / total) * 100;
    const pct = i === segs.length - 1 ? +(100 - acc).toFixed(2) : +raw.toFixed(2);
    circles += '<circle cx="21" cy="21" r="15.9155" fill="none" stroke="' + s.color + '" stroke-width="5.5" stroke-dasharray="' + pct + ' ' + (100 - pct).toFixed(2) + '" stroke-dashoffset="' + (25 - acc).toFixed(2) + '"></circle>';
    acc += pct;
  });
  return '<svg viewBox="0 0 42 42" style="width:180px;height:180px;flex-shrink:0" role="img" aria-label="' + esc(centerLabel) + '">'
    + '<circle cx="21" cy="21" r="15.9155" fill="none" stroke="var(--panel)" stroke-width="5.5"></circle>'
    + circles
    + '<text x="21" y="20.2" text-anchor="middle" style="font-size:6.5px;font-weight:700;fill:var(--fg)">' + esc(centerVal) + '</text>'
    + '<text x="21" y="26.5" text-anchor="middle" style="font-size:3.2px;fill:var(--fg-dim)">' + esc(centerLabel) + '</text>'
    + '</svg>';
}

// 横向条形图行：label + 进度条 + 值（+ 可选说明行）
function hbarRow(label, value, max, color, valText, sub) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return '<div class="hbar"><div class="row1">'
    + '<span class="lbl" title="' + esc(label) + '">' + esc(label) + '</span>'
    + '<div class="track"><div class="fill" style="width:' + pct + '%' + (color ? ';--bar-c:' + color : '') + '"></div></div>'
    + '<span class="val">' + (valText || fmt(value)) + '</span></div>'
    + (sub ? '<div class="sub" title="' + esc(sub) + '">' + esc(sub) + '</div>' : '')
    + '</div>';
}

(function() {
  const el = document.getElementById('dbstats-body');
  const S = MODEL.stats;
  if (!el || !S) return;

  const domainColor = {};
  (MODEL.domains || []).forEach((d) => { domainColor[d.key] = d.color; });

  const kpis = [
    { v: fmt(S.totalTables), k: '数据表' },
    { v: fmt(S.totalColumns), k: '列总数' },
    { v: fmt(S.totalFks), k: '外键' },
    { v: fmt(S.totalIndexes), k: '索引' },
    { v: fmt(S.totalMigrations), k: '迁移版本' },
    { v: String(S.avgColumnsPerTable), k: '平均每表列数' },
  ];
  const kpiHtml = '<div class="metric-row">' + kpis.map((m) =>
    '<div class="metric-card"><div class="metric-val">' + m.v + '</div><div class="metric-label">' + m.k + '</div></div>'
  ).join('') + '</div>';

  const chips = [];
  if (S.totalViews) chips.push('视图 ' + S.totalViews);
  if (S.totalTriggers) chips.push('触发器 ' + S.totalTriggers);
  if (S.totalProcedures) chips.push('存储过程 ' + S.totalProcedures);
  const E = S.entityCounts;
  if (E) {
    chips.push('主实体聚合 ' + E.aggregates);
    if (E.associations) chips.push('关联表 ' + E.associations);
    if (E.links) chips.push('链接表 ' + E.links);
    if (E.isolated) chips.push('孤立实体 ' + E.isolated);
  }
  const chipsHtml = chips.length ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">' + chips.map((c) => '<span class="badge">' + c + '</span>').join('') + '</div>' : '';

  // 领域数据量分布（按列数）+ 占比环形图
  const maxDomCols = S.byDomain.length ? S.byDomain[0].columns : 0;
  const domainBars = S.byDomain.slice(0, 12).map((d) =>
    hbarRow(d.label, d.columns, maxDomCols, domainColor[d.key] || '#94a3b8', null, d.tables + ' 张表 · ' + d.fks + ' 个外键 · 占比 ' + d.pct + '%')
  ).join('');

  const donutSrc = S.byDomain.slice(0, 9);
  const restCols = S.byDomain.slice(9).reduce((a, d) => a + d.columns, 0);
  if (restCols > 0) donutSrc.push({ label: '其他 ' + (S.byDomain.length - 9) + ' 个领域', columns: restCols, color: '#8b949e' });
  const donutSegs = donutSrc.map((d) => ({ label: d.label, value: d.columns, color: d.color || domainColor[d.key] || '#94a3b8' }));
  const donutTotal = donutSegs.reduce((a, s) => a + s.value, 0);
  const donutLegend = donutSegs.map((s) => {
    const pct = donutTotal ? ((100 * s.value) / donutTotal).toFixed(1) : '0';
    return '<div class="dl-row"><span class="legend-dot" style="background:' + s.color + '"></span>'
      + '<span class="nm" title="' + esc(s.label) + '">' + esc(s.label) + '</span>'
      + '<span class="pv">' + fmt(s.value) + ' 列 · ' + pct + '%</span></div>';
  }).join('');

  // DDL / DML 操作分布 + 列类型分布
  const maxOp = S.byOperation.length ? S.byOperation[0].count : 0;
  const opBars = S.byOperation.map((o) => hbarRow(o.label, o.count, maxOp, null)).join('') || '<div class="empty">无操作记录。</div>';
  const maxType = S.byColumnType.length ? S.byColumnType[0].count : 0;
  const typeBars = S.byColumnType.slice(0, 12).map((t) =>
    hbarRow(t.type, t.count, maxType, null, fmt(t.count) + ' 列 · ' + t.pct + '%')
  ).join('') || '<div class="empty">无列数据。</div>';

  // Top 宽表 + 迁移版本操作量
  const maxCols = S.topTables.length ? S.topTables[0].columnCount : 0;
  const tableBars = S.topTables.map((t) =>
    hbarRow(t.name, t.columnCount, maxCols, null, t.columnCount + ' 列',
      [t.domainLabel, t.fkCount + ' FK', t.indexCount + ' 索引', t.comment].filter(Boolean).join(' · '))
  ).join('');

  const migRows = S.topMigrations.map((m) =>
    '<tr><td class="mono">' + esc(m.version) + '</td><td>' + esc(m.description || '') + '</td>'
    + '<td style="text-align:right;font-weight:600;">' + m.ops + '</td>'
    + '<td style="text-align:right;">' + m.tableCount + '</td></tr>'
  ).join('');
  const migTable = S.topMigrations.length
    ? '<table><thead><tr><th>版本</th><th>描述</th><th style="text-align:right;">操作总数</th><th style="text-align:right;">涉及表数</th></tr></thead><tbody>' + migRows + '</tbody></table>'
    : '<div class="empty">无迁移记录。</div>';

  const h3 = 'style="font-size:14px;font-weight:600;margin-bottom:10px;"';
  el.innerHTML =
    '<div class="panel"><h2 style="font-size:16px;margin-bottom:12px;">数据统计</h2>'
    + chipsHtml + kpiHtml
    + '<div class="db-split" style="margin-top:8px">'
    + '<div><h3 ' + h3 + '>领域数据量分布' + (S.byDomain.length > 12 ? '（Top 12 / ' + S.byDomain.length + '）' : '') + '</h3>' + domainBars + '</div>'
    + '<div><h3 ' + h3 + '>领域列数占比</h3><div class="donut-wrap">' + donutSvg(donutSegs, fmt(S.totalColumns), '列总数') + '<div class="donut-legend">' + donutLegend + '</div></div></div>'
    + '</div></div>'
    + '<div class="panel"><div class="db-split">'
    + '<div><h3 ' + h3 + '>DDL / DML 操作分布（全部迁移累计）</h3>' + opBars + '</div>'
    + '<div><h3 ' + h3 + '>列类型分布（Top 12）</h3>' + typeBars + '</div>'
    + '</div></div>'
    + '<div class="panel"><h3 ' + h3 + '>Top 20 宽表（按列数）</h3>' + tableBars + '</div>'
    + '<div class="panel"><h3 ' + h3 + '>迁移版本操作量 Top 10</h3>' + migTable + '</div>';
})();

// ---- 数据图谱（Data Graph：表 / 领域两级力导向图，内联力模拟零依赖） ----
const DG_W = 1280, DG_H = 860;
const DG = { mode: 'table', nodes: [], edges: [], nodeById: new Map(), view: { k: 1, x: 0, y: 0 } };

function dgSizeOf(n) { return DG.mode === 'table' ? (n.columns || 0) : (n.tables || 0); }

function dgPrepare(mode) {
  const G = (MODEL.dataGraph || {})[mode + 'View'];
  if (!G || !G.nodes || !G.nodes.length) return false;
  DG.mode = mode;
  DG.nodes = G.nodes.map((n) => Object.assign({}, n));
  DG.nodeById = new Map(DG.nodes.map((n) => [n.id, n]));
  DG.edges = (G.edges || [])
    .filter((e) => DG.nodeById.has(e.source) && DG.nodeById.has(e.target))
    .map((e) => ({ source: e.source, target: e.target, kind: e.kind || null, weight: e.weight || 1, sa: DG.nodeById.get(e.source), sb: DG.nodeById.get(e.target) }));
  return true;
}

function dgInitPositions() {
  const count = DG.nodes.length || 1;
  DG.nodes.forEach((n, i) => {
    const angle = i * 2.39996;
    const r = 50 + 330 * Math.sqrt((i + 0.5) / count);
    n.x = DG_W / 2 + Math.cos(angle) * r;
    n.y = DG_H / 2 + Math.sin(angle) * r * 0.72;
    n.vx = 0; n.vy = 0; n.fixed = false;
  });
}

// 单步力模拟：库仑斥力 + 弹簧引力 + 向心重力 + 速度阻尼（与代码蓝图代码图谱同一套参数）
function dgTick(alpha) {
  const nodes = DG.nodes;
  const edges = DG.edges;
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
  for (const e of edges) {
    const a = e.sa, b = e.sb;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - 150) * 0.018 * alpha;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
  }
  for (const n of nodes) {
    n.vx += (DG_W / 2 - n.x) * 0.045 * alpha;
    n.vy += (DG_H / 2 - n.y) * 0.045 * alpha;
    if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
    n.vx *= 0.85; n.vy *= 0.85;
    const sp = Math.abs(n.vx) + Math.abs(n.vy);
    if (sp > 30) { n.vx = (n.vx / sp) * 30; n.vy = (n.vy / sp) * 30; }
    n.x += n.vx; n.y += n.vy;
    if (n.x < 50) { n.x = 50; n.vx = Math.abs(n.vx) * 0.4; }
    if (n.x > DG_W - 50) { n.x = DG_W - 50; n.vx = -Math.abs(n.vx) * 0.4; }
    if (n.y < 36) { n.y = 36; n.vy = Math.abs(n.vy) * 0.4; }
    if (n.y > DG_H - 36) { n.y = DG_H - 36; n.vy = -Math.abs(n.vy) * 0.4; }
  }
}

function dgLayout() {
  dgInitPositions();
  for (let t = 0; t < 320; t++) dgTick(Math.pow(1 - t / 320, 1.5) * 0.85 + 0.015);
}

function dgGraphSvgInner() {
  const maxSize = DG.nodes.reduce((a, n) => Math.max(a, dgSizeOf(n)), 1);
  const labelCap = DG.mode === 'table' ? 60 : 40;
  const labeled = new Set(DG.nodes.slice().sort((a, b) => dgSizeOf(b) - dgSizeOf(a)).slice(0, labelCap).map((n) => n.id));
  let out = '';
  for (const e of DG.edges) {
    const w = Math.min(1 + (e.weight > 1 ? Math.log2(e.weight + 1) : 0), 5).toFixed(1);
    out += '<line class="dge' + (e.kind ? ' ' + e.kind : '') + '" x1="' + e.sa.x.toFixed(1) + '" y1="' + e.sa.y.toFixed(1)
      + '" x2="' + e.sb.x.toFixed(1) + '" y2="' + e.sb.y.toFixed(1) + '" stroke-width="' + w
      + '" data-a="' + esc(e.source) + '" data-b="' + esc(e.target) + '"></line>';
  }
  for (const n of DG.nodes) {
    const r = 6 + 26 * Math.sqrt(dgSizeOf(n) / maxSize);
    let label = '';
    if (labeled.has(n.id)) {
      const nm = n.name.length > 24 ? n.name.slice(0, 23) + '…' : n.name;
      label = '<text class="' + (dgSizeOf(n) > maxSize * 0.25 ? 'big' : '') + '" x="' + (n.x + r + 4).toFixed(1) + '" y="' + (n.y + 3).toFixed(1) + '">' + esc(nm) + '</text>';
    }
    out += '<g class="dgn' + (n.kind && n.kind !== 'entity' ? ' ' + n.kind : '') + '" data-nid="' + esc(n.id) + '">'
      + '<circle cx="' + n.x.toFixed(1) + '" cy="' + n.y.toFixed(1) + '" r="' + r.toFixed(1) + '" fill="' + (n.color || '#94a3b8') + '"></circle>'
      + label + '</g>';
  }
  return out;
}

function dgApplyTransform() {
  const g = document.getElementById('dg-transform');
  if (g && g.setAttribute) g.setAttribute('transform', 'translate(' + DG.view.x.toFixed(1) + ',' + DG.view.y.toFixed(1) + ') scale(' + DG.view.k.toFixed(3) + ')');
}

function dgUpdateToolbar() {
  const c = document.getElementById('dg-count');
  if (c && c.textContent !== undefined) {
    const G = (MODEL.dataGraph || {})[DG.mode + 'View'] || {};
    const hidden = G.hiddenTableCount || 0;
    c.textContent = (DG.mode === 'table' ? '表视图' : '领域视图')
      + ' · ' + DG.nodes.length + ' 节点 · ' + DG.edges.length + ' 边'
      + (hidden ? '（未展示 ' + hidden + ' 张小表）' : '');
  }
  ['table', 'domain'].forEach((m) => {
    const b = document.getElementById('dg-mode-' + m);
    if (b && b.classList) {
      if (DG.mode === m) b.classList.add('on'); else b.classList.remove('on');
    }
  });
}

function dgUpdateLegend() {
  const lg = document.getElementById('dg-legend');
  if (!lg) return;
  let html = '';
  const seen = [];
  DG.nodes.forEach((n) => {
    const nm = DG.mode === 'table' ? n.domainLabel : n.name;
    const key = DG.mode === 'table' ? n.domainKey : n.id;
    if (nm && !seen.some((s) => s.key === key)) seen.push({ key, label: nm, color: n.color });
  });
  html = seen.slice(0, 14).map((s) => '<div class="legend-item"><div class="legend-dot" style="background:' + (s.color || '#94a3b8') + '"></div>' + esc(s.label) + '</div>').join('');
  html += '<div class="legend-item"><div class="legend-dot" style="background:color-mix(in srgb, var(--purple) 55%, transparent)"></div>外键引用</div>'
    + '<div class="legend-item"><div class="legend-dot" style="background:color-mix(in srgb, var(--blue) 60%, transparent)"></div>跨领域耦合</div>'
    + '<div class="legend-item dg-hint">节点大小 ∝ ' + (DG.mode === 'table' ? '列数' : '表数') + '</div>';
  lg.innerHTML = html;
}

function dgSetFocus(node) {
  const svg = document.getElementById('dg-svg');
  const info = document.getElementById('dg-info');
  if (!svg || !svg.querySelectorAll || !info) return;
  if (!node) {
    svg.classList.remove('focus');
    svg.querySelectorAll('.dgn.hl, .dge.hl').forEach((x) => x.classList.remove('hl'));
    info.innerHTML = '<span class="dg-hint">点击节点查看详情并高亮邻接。</span>';
    return;
  }
  const neighbor = new Set([node.id]);
  const connKeys = new Set();
  for (const e of DG.edges) {
    if (e.source === node.id || e.target === node.id) {
      neighbor.add(e.source); neighbor.add(e.target);
      connKeys.add(e.source + '>' + e.target);
    }
  }
  svg.classList.add('focus');
  svg.querySelectorAll('.dgn').forEach((g) => {
    const nid = g.getAttribute('data-nid');
    if (neighbor.has(nid)) g.classList.add('hl'); else g.classList.remove('hl');
  });
  svg.querySelectorAll('.dge').forEach((ln) => {
    const key = ln.getAttribute('data-a') + '>' + ln.getAttribute('data-b');
    if (connKeys.has(key)) ln.classList.add('hl'); else ln.classList.remove('hl');
  });
  const KIND_LABELS = ${JSON.stringify(TABLE_KIND_LABELS)};
  const meta = DG.mode === 'table'
    ? (KIND_LABELS[node.kind] ? KIND_LABELS[node.kind] + ' · ' : '')
      + fmt(node.columns || 0) + ' 列 · ' + (node.fks || 0) + ' 外键 · ' + (node.indexes || 0) + ' 索引'
      + (node.domainLabel ? ' · ' + esc(node.domainLabel) : '')
      + (node.createdAt ? ' · 建于 ' + esc(node.createdAt) : '')
      + (node.comment ? ' · ' + esc(node.comment) : '')
    : fmt(node.tables || 0) + ' 张表 · ' + fmt(node.columns || 0) + ' 列';
  info.innerHTML = '<span class="name">' + esc(node.name) + '</span> — ' + meta + ' · 邻接 ' + connKeys.size + ' 条边';
}

function dgSetMode(mode) {
  if (!dgPrepare(mode)) return false;
  DG.view = { k: 1, x: 0, y: 0 };
  dgApplyTransform();
  dgLayout();
  document.getElementById('dg-transform').innerHTML = dgGraphSvgInner();
  dgSetFocus(null);
  dgUpdateToolbar();
  dgUpdateLegend();
  return true;
}

function dgPointer(ev) {
  const svg = document.getElementById('dg-svg');
  const rect = svg.getBoundingClientRect();
  const sx = rect.width / DG_W, sy = rect.height / DG_H;
  return {
    x: ((ev.clientX - rect.left) / sx - DG.view.x) / DG.view.k,
    y: ((ev.clientY - rect.top) / sy - DG.view.y) / DG.view.k,
  };
}

function dgBindStage() {
  const stage = document.getElementById('dg-stage');
  if (!stage || !stage.addEventListener) return;
  let drag = null;
  stage.addEventListener('mousedown', (ev) => {
    const nidEl = ev.target && ev.target.closest ? ev.target.closest('[data-nid]') : null;
    const svg = document.getElementById('dg-svg');
    if (svg && svg.classList) svg.classList.add('dragging');
    if (nidEl) {
      const node = DG.nodeById.get(nidEl.getAttribute('data-nid'));
      if (!node) return;
      const p = dgPointer(ev);
      node.fixed = true;
      drag = { type: 'node', node, sx: ev.clientX, sy: ev.clientY, dx: node.x - p.x, dy: node.y - p.y, moved: false };
    } else {
      drag = { type: 'pan', sx: ev.clientX, sy: ev.clientY, ox: DG.view.x, oy: DG.view.y, moved: false };
    }
    ev.preventDefault();
  });
  stage.addEventListener('mousemove', (ev) => {
    if (!drag) return;
    if (Math.abs(ev.clientX - drag.sx) + Math.abs(ev.clientY - drag.sy) > 3) drag.moved = true;
    if (drag.type === 'node') {
      const p = dgPointer(ev);
      drag.node.x = p.x + drag.dx;
      drag.node.y = p.y + drag.dy;
      for (let t = 0; t < 2; t++) dgTick(0.25);
      document.getElementById('dg-transform').innerHTML = dgGraphSvgInner();
    } else {
      DG.view.x = drag.ox + (ev.clientX - drag.sx);
      DG.view.y = drag.oy + (ev.clientY - drag.sy);
      dgApplyTransform();
    }
  });
  stage.addEventListener('mouseup', () => {
    const svg = document.getElementById('dg-svg');
    if (svg && svg.classList) svg.classList.remove('dragging');
    if (!drag) return;
    if (drag.type === 'node') {
      if (!drag.moved) dgSetFocus(drag.node);
    } else if (!drag.moved) {
      dgSetFocus(null);
    }
    drag = null;
  });
  stage.addEventListener('mouseleave', () => {
    const svg = document.getElementById('dg-svg');
    if (svg && svg.classList) svg.classList.remove('dragging');
    drag = null;
  });
  stage.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const svg = document.getElementById('dg-svg');
    if (!svg || !svg.getBoundingClientRect) return;
    const rect = svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) / (rect.width / DG_W);
    const py = (ev.clientY - rect.top) / (rect.height / DG_H);
    const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
    const k2 = Math.max(0.25, Math.min(6, DG.view.k * factor));
    DG.view.x = px - (k2 / DG.view.k) * (px - DG.view.x);
    DG.view.y = py - (k2 / DG.view.k) * (py - DG.view.y);
    DG.view.k = k2;
    dgApplyTransform();
  }, { passive: false });
}

(function() {
  const el = document.getElementById('dbgraph-body');
  const G = MODEL.dataGraph;
  if (!el || !G) return;
  const hasTable = !!(G.tableView && G.tableView.nodes.length);
  const hasDomain = !!(G.domainView && G.domainView.nodes.length);
  if (!hasTable && !hasDomain) return;
  el.innerHTML =
    '<div class="panel"><h2 style="font-size:16px;margin-bottom:12px;">数据图谱（力导向图）</h2>'
    + '<div class="dg-toolbar">'
    + (hasTable ? '<button id="dg-mode-table">表图谱</button>' : '')
    + (hasDomain ? '<button id="dg-mode-domain">领域图谱</button>' : '')
    + '<button id="dg-relayout">重新布局</button>'
    + '<button id="dg-reset">重置视图</button>'
    + '<span class="dg-hint" id="dg-count"></span>'
    + '</div>'
    + '<div class="dg-stage" id="dg-stage"><svg id="dg-svg" viewBox="0 0 ' + DG_W + ' ' + DG_H + '"><g id="dg-transform"></g></svg></div>'
    + '<div class="legend-row" id="dg-legend"></div>'
    + '<div id="dg-info"></div>'
    + '<div class="sub" style="margin-top:8px;">表图谱：节点 = 表（大小 ∝ 列数，颜色 = 领域；实心 = 主实体、八成透明 = 关联表、虚线半透明 = 链接表/junction），边 = 外键引用（粗细 ∝ FK 数）；领域图谱：节点 = 领域（大小 ∝ 表数），边 = 跨领域外键耦合。力导向布局由内置力模拟（斥力 + 弹簧 + 向心力）实时计算：拖拽节点 / 滚轮缩放 / 拖空白平移 / 点击聚焦邻接。</div>'
    + '</div>';
  dgBindStage();
  const bind = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener('click', fn); };
  bind('dg-mode-table', () => dgSetMode('table'));
  bind('dg-mode-domain', () => dgSetMode('domain'));
  bind('dg-relayout', () => {
    dgLayout();
    document.getElementById('dg-transform').innerHTML = dgGraphSvgInner();
    dgSetFocus(null);
  });
  bind('dg-reset', () => {
    DG.view = { k: 1, x: 0, y: 0 };
    dgApplyTransform();
    dgSetFocus(null);
  });
  dgSetMode(hasTable ? 'table' : 'domain');
})();

// 数据缺失时隐藏对应 Tab（保持 Tab 栏整洁）
(function() {
  if (!MODEL.stats) { const t = document.querySelector('[data-tab="dbstats"]'); if (t) t.style.display = 'none'; }
  if (!MODEL.dataGraph) { const t = document.querySelector('[data-tab="dbgraph"]'); if (t) t.style.display = 'none'; }
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

  document.getElementById('health-score').innerHTML =
    '<div class="health-score">' +
      scoreRingSvg(h.score, { label: '等级 ' + h.grade, size: 156 }) +
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
  const dimHtml = Object.entries(h.dimensions || {}).map(([key, dim]) => {
    const color = dim.score >= 80 ? 'var(--green)' : dim.score >= 60 ? 'var(--amber)' : 'var(--red)';
    return '<div class="dim-card">' +
      '<div class="dim-name">' + (dimLabels[key] || key) + '</div>' +
      '<div class="dim-score" style="color:' + color + '">' + dim.score + '</div>' +
      '<div class="dim-bar"><div class="dim-bar-fill" style="--bar-c:' + color + ';width:' + dim.score + '%"></div></div>' +
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
// 图表必须在可见状态下绘制：本 Tab 默认 display:none，隐藏时 getBoundingClientRect 宽度为 0，
// 量不到真实宽度（旧实现回退 480 假宽度 + preserveAspectRatio="none"，宽屏下横向拉伸 3 倍变形）。
// 因此改为惰性渲染：Tab 激活时绘制 + 窗口 resize 防抖重绘；viewBox 严格等于实测宽度，等比 1:1 无变形。
function renderEvolution() {
  const evo = MODEL.audits?.evolution;
  if (!evo || !evo.timeline || evo.timeline.length === 0) return;
  const tl = evo.timeline;

  // 静态部分（图例 / 领域首版 / 趋势 / 里程碑）与宽度无关，只渲染一次
  if (!renderEvolution._staticDone) {
    renderEvolution._staticDone = true;
    const opCategories = ['create', 'alter', 'index', 'drop', 'dml', 'other'];
    const opColors = { create: '#4ade80', alter: '#58a6ff', index: '#a78bfa', drop: '#f85149', dml: '#d29922', other: '#64748b' };
    const opLabels = { create: 'CREATE', alter: 'ALTER', index: 'INDEX', drop: 'DROP', dml: 'DML', other: '其他' };
    document.getElementById('evo-ops-legend').innerHTML = opCategories.map(cat =>
      '<div class="legend-item"><div class="legend-dot" style="background:' + opColors[cat] + '"></div>' + opLabels[cat] + '</div>'
    ).join('');

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
  }

  // ---- 图表部分：按当前可见宽度绘制（隐藏时跳过，等 Tab 激活） ----
  const growthSvg = document.getElementById('evo-chart-growth');
  const W = Math.round(growthSvg.getBoundingClientRect().width);
  if (W < 50) return;
  const H = 260, padL = 50, padR = 20, padT = 20, padB = 40;
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

  let yTicks = '';
  for (let i = 0; i <= 4; i++) {
    const val = Math.round((maxVal * i) / 4);
    const y = padT + chartH - (val / maxVal) * chartH;
    yTicks += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="var(--border)" stroke-dasharray="2,3"/>' +
      '<text x="' + (padL - 6) + '" y="' + (y + 4) + '" text-anchor="end" fill="var(--fg-dim)" font-size="10">' + val + '</text>';
  }

  // X 轴标签（每隔几个显示一个）
  let xLabels = '';
  const labelStep = Math.max(1, Math.floor(n / 8));
  tl.forEach((t, i) => {
    if (i % labelStep !== 0 && i !== n - 1) return;
    const x = padL + (i / Math.max(n - 1, 1)) * chartW;
    xLabels += '<text x="' + x + '" y="' + (H - padB + 16) + '" text-anchor="middle" fill="var(--fg-dim)" font-size="10" transform="rotate(-30 ' + x + ',' + (H - padB + 16) + ')">' + esc(t.version) + '</text>';
  });

  // viewBox = 实测像素宽度，svg 尺寸显式声明，1:1 等比绘制（禁止 preserveAspectRatio="none" 非均匀拉伸）
  growthSvg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  growthSvg.setAttribute('width', W);
  growthSvg.setAttribute('height', H);
  growthSvg.innerHTML = yTicks + xLabels +
    '<path d="' + areaD + '" fill="color-mix(in srgb, var(--blue) 15%, transparent)" stroke="none"/>' +
    '<path d="' + pathD + '" fill="none" stroke="var(--blue)" stroke-width="2"/>' +
    points.filter((_, i) => i % labelStep === 0 || i === points.length - 1).map(p =>
      '<circle cx="' + p.x + '" cy="' + p.y + '" r="3" fill="var(--blue)"/>'
    ).join('');

  // 操作类型分布（堆叠柱状图，同一 W 重绘）
  const opsSvg = document.getElementById('evo-chart-ops');
  const opCategories = ['create', 'alter', 'index', 'drop', 'dml', 'other'];
  const opColors = { create: '#4ade80', alter: '#58a6ff', index: '#a78bfa', drop: '#f85149', dml: '#d29922', other: '#64748b' };

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

  let yTicks2 = '';
  for (let i = 0; i <= 4; i++) {
    const val = Math.round((maxOps * i) / 4);
    const y = padT + chartH - (val / maxOps) * chartH;
    yTicks2 += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="var(--border)" stroke-dasharray="2,3"/>' +
      '<text x="' + (padL - 6) + '" y="' + (y + 4) + '" text-anchor="end" fill="var(--fg-dim)" font-size="10">' + val + '</text>';
  }

  opsSvg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  opsSvg.setAttribute('width', W);
  opsSvg.setAttribute('height', H);
  opsSvg.innerHTML = yTicks2 + xLabels + barsHtml;
}

// 窗口尺寸变化时防抖重绘（图表宽度跟随容器，避免任何拉伸变形）
if (typeof window !== 'undefined' && window.addEventListener) {
  let evoResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(evoResizeTimer);
    evoResizeTimer = setTimeout(renderEvolution, 150);
  });
}

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
renderEvolution();
const origSvg = document.getElementById('er-svg');
origSvg.setAttribute('data-original-vb', origSvg.getAttribute('viewBox'));

function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
</script>
</body>
</html>`;
}
