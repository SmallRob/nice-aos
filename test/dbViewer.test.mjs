// 数据库蓝图查看器测试：数据统计 / 数据图谱视图模型聚合 + Tab 渲染（DOM stub 执行内嵌脚本）
// fixture 与 dbBuilder 产物形态对齐：tables / foreignKeys / migrations / domains / views / triggers / procedures
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDbViewerModel, renderDbOverviewHtml } from '../src/database/dbViewer.js';

const col = (name, type, key = null) => ({ name, type, nullable: true, key, default: null, autoIncrement: false, comment: null });
const mkFk = (name, columns, refTable, refColumns, onDelete = null) => ({ name, columns, refTable, refColumns, onDelete, onUpdate: null });

function T(name, domain, domainLabel, columns, foreignKeys, comment = null) {
  return {
    id: `table:${name}`, name, database: null, comment, domain, domainLabel,
    engine: 'InnoDB', charset: 'utf8mb4', collate: null,
    columns, primaryKey: ['id'], foreignKeys, indexes: [],
    createdAt: 'V1.0', modifiedAt: 'V1.0', migrationVersions: ['V1.0'], patterns: [],
  };
}

function buildDbDataMap() {
  const users = T('users', 'auth', '用户与权限',
    [col('id', 'BIGINT', 'PK'), col('org_id', 'BIGINT'), col('name', 'VARCHAR(64)'), col('created_at', 'DATETIME'), col('deleted_at', 'DATETIME')],
    [mkFk('fk_users_org', ['org_id'], 'orgs', ['id'], 'CASCADE')], '用户表');
  const orgs = T('orgs', 'auth', '用户与权限',
    [col('id', 'BIGINT', 'PK'), col('name', 'VARCHAR(128)'), col('created_at', 'DATETIME')], []);
  const workspaces = T('workspaces', 'ws', '工作空间',
    [col('id', 'BIGINT', 'PK'), col('name', 'VARCHAR(64)')], []);
  const projects = T('projects', 'proj', '项目与仓库',
    [col('id', 'BIGINT', 'PK'), col('org_id', 'BIGINT'), col('workspace_id', 'BIGINT'), col('owner_org_id', 'BIGINT'), col('title', 'VARCHAR(128)')],
    [mkFk('fk_projects_org', ['org_id'], 'orgs', ['id']), mkFk('fk_projects_ws', ['workspace_id'], 'workspaces', ['id']), mkFk('fk_projects_owner', ['owner_org_id'], 'orgs', ['id'])]);
  // 6 列宽表 + 悬挂外键（source_id → ghost_table 不存在于表集）
  const articles = T('articles', 'portal', 'Portal 门户',
    [col('id', 'BIGINT', 'PK'), col('author_id', 'BIGINT'), col('title', 'VARCHAR(200)'), col('content', 'TEXT'), col('status', 'ENUM'), col('created_at', 'DATETIME')],
    [mkFk('fk_articles_author', ['author_id'], 'users', ['id']), mkFk('fk_articles_source', ['source_id'], 'ghost_table', ['id'])]);
  const config = T('config_settings', 'config', '系统配置',
    [col('id', 'BIGINT', 'PK'), col('cfg_key', 'VARCHAR(64)'), col('cfg_value', 'JSON')], []);

  const tables = [users, orgs, workspaces, projects, articles, config];

  const FK = (name, fromTable, fromColumns, toTable, toColumns, onDelete = null) => ({
    name, fromTable, fromDatabase: null, fromColumns, toTable, toDatabase: null, toColumns, onDelete, onUpdate: null,
  });
  const foreignKeys = [
    FK('fk_users_org', 'users', ['org_id'], 'orgs', ['id'], 'CASCADE'),
    FK('fk_projects_org', 'projects', ['org_id'], 'orgs', ['id']),
    FK('fk_projects_ws', 'projects', ['workspace_id'], 'workspaces', ['id']),
    FK('fk_projects_owner', 'projects', ['owner_org_id'], 'orgs', ['id']),
    FK('fk_articles_author', 'articles', ['author_id'], 'users', ['id']),
    FK('fk_articles_source', 'articles', ['source_id'], 'ghost_table', ['id']),
  ];

  const domains = [
    { key: 'auth', label: '用户与权限', color: '#a78bfa', tableCount: 2, tableNames: ['users', 'orgs'], database: null },
    { key: 'ws', label: '工作空间', color: '#4ade80', tableCount: 1, tableNames: ['workspaces'], database: null },
    { key: 'proj', label: '项目与仓库', color: '#38bdf8', tableCount: 1, tableNames: ['projects'], database: null },
    { key: 'portal', label: 'Portal 门户', color: '#f87171', tableCount: 1, tableNames: ['articles'], database: null },
    { key: 'config', label: '系统配置', color: '#64748b', tableCount: 1, tableNames: ['config_settings'], database: null },
  ];

  const opZero = { createTable: 0, alterTable: 0, createIndex: 0, dropTable: 0, insert: 0, update: 0, createView: 0, createTrigger: 0, createProcedure: 0 };
  const migrations = [
    { id: 'mig:V1.0', version: 'V1.0', description: 'init', fileName: 'V1.0__init.sql', filePath: '/x/V1.0__init.sql', relativePath: 'V1.0__init.sql', fileSize: 100,
      operationSummary: { ...opZero, createTable: 4, createIndex: 2 }, tableNames: ['users', 'orgs', 'workspaces', 'projects'], hasIdempotentDdl: false, databases: [] },
    { id: 'mig:V2.0', version: 'V2.0', description: 'portal and config', fileName: 'V2.0__portal.sql', filePath: '/x/V2.0__portal.sql', relativePath: 'V2.0__portal.sql', fileSize: 200,
      operationSummary: { ...opZero, createTable: 2, alterTable: 3, insert: 5 }, tableNames: ['articles', 'config_settings'], hasIdempotentDdl: false, databases: [] },
  ];

  return {
    tables,
    foreignKeys,
    migrations,
    domains,
    databases: [],
    views: [{ id: 'view:v_author_articles', database: null, viewName: 'v_author_articles', columns: [], definition: 'SELECT 1' }],
    triggers: [],
    procedures: [],
    _meta: {
      tableCount: 6, fkCount: 6, indexCount: 0, migrationCount: 2, domainCount: 5,
      sourceDir: '/x/sqls', viewCount: 1, triggerCount: 0, procedureCount: 0,
      scannedAt: '2026-08-24T00:00:00Z', incremental: false,
    },
  };
}

test('数据统计：视图模型聚合（表/列/领域/操作/列类型/Top 表/迁移）', () => {
  const model = buildDbViewerModel(buildDbDataMap());
  const S = model.stats;
  assert.ok(S, 'stats 视图模型应存在');
  assert.equal(S.totalTables, 6);
  assert.equal(S.totalColumns, 24);
  assert.equal(S.totalFks, 6);
  assert.equal(S.totalMigrations, 2);
  assert.equal(S.avgColumnsPerTable, 4);
  assert.equal(S.totalViews, 1);

  // 领域分布：按列数降序，auth（users 5 + orgs 3 = 8 列）居首
  assert.equal(S.byDomain[0].key, 'auth');
  assert.equal(S.byDomain[0].columns, 8);
  assert.equal(S.byDomain[0].tables, 2);
  assert.ok(Math.abs(S.byDomain[0].pct - 33.3) < 0.01, `auth 占比应约 33.3%，实际 ${S.byDomain[0].pct}`);
  const pctSum = S.byDomain.reduce((a, d) => a + d.pct, 0);
  assert.ok(pctSum > 99 && pctSum < 101, `领域占比合计应约等于 100，实际 ${pctSum}`);

  // DDL/DML 操作聚合：全部迁移 operationSummary 累计
  const opByKey = Object.fromEntries(S.byOperation.map((o) => [o.key, o.count]));
  assert.equal(opByKey.createTable, 6);
  assert.equal(opByKey.alterTable, 3);
  assert.equal(opByKey.insert, 5);
  assert.equal(opByKey.createIndex, 2);
  assert.ok(S.byOperation[0].key === 'createTable' && S.byOperation[0].label === 'CREATE TABLE', '操作分布应按数量降序且带标签');

  // 列类型归一化：VARCHAR(64)/(128)/(200) 同为 VARCHAR，BIGINT/INT UNSIGNED 均归并
  const typeByKey = Object.fromEntries(S.byColumnType.map((t) => [t.type, t.count]));
  assert.equal(typeByKey.BIGINT, 11);
  assert.equal(typeByKey.VARCHAR, 6);
  assert.equal(typeByKey.DATETIME, 4);
  assert.equal(typeByKey.JSON, 1);

  // Top 宽表 + 迁移版本操作量
  assert.equal(S.topTables[0].name, 'articles');
  assert.equal(S.topTables[0].columnCount, 6);
  assert.equal(S.topMigrations[0].version, 'V2.0');
  assert.equal(S.topMigrations[0].ops, 10);
});

test('数据图谱：表视图（FK 边聚合 + 悬挂外键排除）与领域视图（跨域耦合）', () => {
  const model = buildDbViewerModel(buildDbDataMap());
  const G = model.dataGraph;
  assert.ok(G, 'dataGraph 视图模型应存在');

  const tv = G.tableView;
  assert.equal(tv.nodeCount, 6, '表视图应含全部 6 张表');
  const nodeIds = new Set(tv.nodes.map((n) => n.id));
  assert.ok(tv.edges.every((e) => nodeIds.has(e.source) && nodeIds.has(e.target) && e.weight >= 1), '边端点应存在于节点集');
  const edgeByKey = Object.fromEntries(tv.edges.map((e) => [`${e.source}>${e.target}`, e.weight]));
  assert.equal(edgeByKey['projects>orgs'], 2, '同向两条 FK 应聚合为权重 2');
  assert.equal(edgeByKey['users>orgs'], 1);
  assert.equal(edgeByKey['projects>workspaces'], 1);
  assert.equal(edgeByKey['articles>users'], 1);
  assert.equal(edgeByKey['articles>ghost_table'], undefined, '悬挂外键（指向不存在的表）不应建边');
  assert.equal(tv.edgeCount, 4);
  // 节点携带领域配色（与 domains 数组一致，客户端零映射）
  const usersNode = tv.nodes.find((n) => n.id === 'users');
  assert.equal(usersNode.color, '#a78bfa');
  assert.equal(usersNode.columns, 5);

  const dv = G.domainView;
  assert.equal(dv.nodeCount, 5);
  const domEdge = Object.fromEntries(dv.edges.map((e) => [`${e.source}>${e.target}`, e.weight]));
  assert.equal(domEdge['proj>auth'], 2, 'projects→orgs 两条跨域 FK 应聚合权重 2');
  assert.equal(domEdge['proj>ws'], 1);
  assert.equal(domEdge['portal>auth'], 1);
  assert.equal(domEdge['auth>auth'], undefined, '域内 FK（users→orgs）不应建边');
  assert.ok(dv.edges.every((e) => e.source !== e.target), '领域视图不应有自环边');
});

test('数据统计 / 数据图谱 Tab：KPI + 环形图 + 力导向图 SVG 渲染（DOM stub 执行内嵌脚本）', () => {
  const model = buildDbViewerModel(buildDbDataMap());
  const html = renderDbOverviewHtml(model);

  for (const token of ['data-tab="dbstats"', 'data-tab="dbgraph"', 'id="view-dbstats"', 'id="view-dbgraph"', '数据统计', '数据图谱']) {
    assert.ok(html.includes(token), `HTML 应含 ${token}`);
  }

  // 执行内嵌脚本（DOM stub），验证两个新视图的渲染产物
  const dataJson = html.match(/<script id="db-viewer-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  const script = html.match(/<script>\n([\s\S]*?)<\/script>\s*<\/body>/)[1];
  const elements = new Map();
  const makeEl = (id) => {
    if (!elements.has(id)) {
      const attrs = {};
      elements.set(id, {
        innerHTML: '', textContent: id === 'db-viewer-data' ? dataJson : '',
        attrs, dataset: {}, style: {}, value: '',
        addEventListener() {},
        classList: { add() {}, remove() {} },
        setAttribute(k, v) { attrs[k] = String(v); },
        getAttribute(k) { return attrs[k] ?? null; },
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ width: 900, height: 300 }),
      });
    }
    return elements.get(id);
  };
  const prevDocument = globalThis.document;
  const prevRaf = globalThis.requestAnimationFrame;
  globalThis.document = {
    getElementById: makeEl,
    querySelectorAll: () => [],
    querySelector: () => makeEl('generic'),
    addEventListener() {},
    documentElement: { getAttribute: () => 'fresh-green' },
  };
  globalThis.requestAnimationFrame = (fn) => { fn(() => {}); return 0; };
  try {
    new Function(script)();
  } finally {
    globalThis.document = prevDocument;
    globalThis.requestAnimationFrame = prevRaf;
  }

  const statsHtml = makeEl('dbstats-body').innerHTML;
  for (const token of ['数据统计', '数据表', '列总数', '迁移版本', '平均每表列数', '领域数据量分布', '领域列数占比', 'stroke-dasharray', 'DDL / DML 操作分布', 'CREATE TABLE', '列类型分布', 'Top 20 宽表', '迁移版本操作量', 'articles']) {
    assert.ok(statsHtml.includes(token), `数据统计视图应含 ${token}`);
  }

  // 顶部统计卡片：网格均分 CSS（flex 版本窄屏 7+1 孤卡拉满整行）
  assert.ok(html.includes('grid-template-columns: repeat(8, 1fr)'), '统计卡片应使用 8 列网格布局');
  assert.ok(html.includes('repeat(4, 1fr)') && html.includes('repeat(2, 1fr)'), '统计卡片应含窄屏 4/2 列断点');

  // 演进分析：图表应有数据（增长曲线 + 操作堆叠柱），不再是空坐标轴
  const growthSvg = makeEl('evo-chart-growth').innerHTML;
  assert.ok(growthSvg.includes('<path'), '表数增长曲线应渲染路径');
  assert.ok(!growthSvg.includes('NaN'), '增长曲线不应出现 NaN');
  const opsSvg = makeEl('evo-chart-ops').innerHTML;
  assert.ok(opsSvg.includes('<rect'), '操作类型分布应渲染柱条');
  assert.ok(!opsSvg.includes('NaN'), '操作分布不应出现 NaN');

  const graphBodyHtml = makeEl('dbgraph-body').innerHTML;
  for (const token of ['数据图谱（力导向图）', '表图谱', '领域图谱', '重新布局', '重置视图', 'dg-svg']) {
    assert.ok(graphBodyHtml.includes(token), `数据图谱视图应含 ${token}`);
  }
  assert.ok((makeEl('dg-count').textContent || '').includes('表视图 · 6 节点'), '工具栏应显示表视图节点计数');

  const graphSvg = makeEl('dg-transform').innerHTML;
  assert.ok(graphSvg.includes('<circle'), '力导向图应渲染节点');
  assert.ok(graphSvg.includes('class="dge'), '力导向图应渲染边');
  assert.ok(!graphSvg.includes('NaN'), '力导向布局坐标不应出现 NaN');
  const cxVals = [...graphSvg.matchAll(/cx="(\d+(?:\.\d+)?)"/g)].map((m) => parseFloat(m[1]));
  assert.ok(cxVals.length >= 6 && cxVals.every((v) => v >= 0 && v <= 1280), '节点坐标应落在画布范围内');
});

test('演进分析：operationSummary 聚合（增长曲线终点=当前表数，操作分布非空）', () => {
  const map = buildDbDataMap();
  // fixture 默认全部建于 V1.0；把 articles / config_settings 改为 V2.0 增量建表
  for (const name of ['articles', 'config_settings']) {
    const t = map.tables.find((x) => x.name === name);
    t.createdAt = 'V2.0';
    t.migrationVersions = ['V2.0'];
  }
  const model = buildDbViewerModel(map);
  const tl = model.audits.evolution.timeline;
  assert.equal(tl.length, 2);
  assert.equal(tl[0].version, 'V1.0');
  assert.equal(tl[0].cumulativeTables, 4, 'V1.0 后应累计 4 张表');
  assert.equal(tl[0].operationCount, 6, 'V1.0 操作总数 = createTable 4 + createIndex 2');
  assert.equal(tl[0].opTypes.create, 4);
  assert.equal(tl[0].opTypes.index, 2);
  assert.equal(tl[1].version, 'V2.0');
  assert.equal(tl[1].cumulativeTables, 6, 'V2.0 后应累计全部 6 张表');
  assert.equal(tl[1].operationCount, 10, 'V2.0 操作总数 = createTable 2 + alterTable 3 + insert 5');
  assert.equal(tl[1].opTypes.create, 2);
  assert.equal(tl[1].opTypes.alter, 3);
  assert.equal(tl[1].opTypes.dml, 5);
  assert.equal(tl[tl.length - 1].cumulativeTables, map.tables.length, '增长曲线终点应等于当前表数');
});

test('演进图表惰性渲染：隐藏时不绘制，Tab 激活后按实测宽度 1:1 绘制（无拉伸）', () => {
  const model = buildDbViewerModel(buildDbDataMap());
  const html = renderDbOverviewHtml(model);
  const dataJson = html.match(/<script id="db-viewer-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  const script = html.match(/<script>\n([\s\S]*?)<\/script>\s*<\/body>/)[1];

  const elements = new Map();
  let containerWidth = 0; // 模拟：初始隐藏（display:none → 宽度 0），点击 Tab 后可见
  const makeEl = (id) => {
    if (!elements.has(id)) {
      const attrs = {};
      const listeners = {};
      elements.set(id, {
        innerHTML: '', textContent: id === 'db-viewer-data' ? dataJson : '',
        attrs, dataset: { tab: id }, style: {}, value: '',
        addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
        fire(ev) { (listeners[ev] || []).forEach((fn) => fn()); },
        classList: { add() {}, remove() {} },
        setAttribute(k, v) { attrs[k] = String(v); },
        getAttribute(k) { return attrs[k] ?? null; },
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ width: containerWidth, height: 300 }),
      });
    }
    return elements.get(id);
  };
  const tabButtons = ['er', 'dbstats', 'dbgraph', 'tables', 'fks', 'migrations', 'patterns', 'health', 'evolution', 'indexes'].map((name) => makeEl('tab-btn-' + name));
  tabButtons.forEach((el, i) => { el.dataset = { tab: ['er', 'dbstats', 'dbgraph', 'tables', 'fks', 'migrations', 'patterns', 'health', 'evolution', 'indexes'][i] }; });

  const prevDocument = globalThis.document;
  const prevRaf = globalThis.requestAnimationFrame;
  globalThis.document = {
    getElementById: makeEl,
    querySelectorAll: (sel) => (sel === '.tab-btn' ? tabButtons : []),
    querySelector: () => makeEl('generic'),
    addEventListener() {},
    documentElement: { getAttribute: () => 'fresh-green' },
  };
  globalThis.requestAnimationFrame = (fn) => { fn(() => {}); return 0; };
  try {
    new Function(script)();

    // 初始隐藏：静态部分已渲染，图表不应绘制（旧实现会用 480 假宽度 + preserveAspectRatio=none）
    assert.ok(makeEl('evo-trends').innerHTML.includes('总版本数'), '静态趋势部分应在加载时渲染');
    assert.equal(makeEl('evo-chart-growth').getAttribute('viewBox'), null, '隐藏时不应绘制图表');
    assert.equal(makeEl('evo-chart-ops').innerHTML, '', '隐藏时操作分布不应有内容');

    // Tab 激活（可见，容器宽度 900）：按实测宽度绘制
    containerWidth = 900;
    const evoBtn = tabButtons.find((b) => b.dataset.tab === 'evolution');
    evoBtn.fire('click');
    assert.equal(makeEl('evo-chart-growth').getAttribute('viewBox'), '0 0 900 260', 'viewBox 应等于实测宽度（1:1 无缩放）');
    assert.equal(makeEl('evo-chart-growth').getAttribute('preserveAspectRatio'), null, '不应设置 preserveAspectRatio=none');
    assert.ok(makeEl('evo-chart-growth').innerHTML.includes('<path'), '激活后增长曲线应绘制');
    assert.ok(makeEl('evo-chart-ops').innerHTML.includes('<rect'), '激活后操作柱条应绘制');

    // 窗口 resize 后重绘：宽度变化 → viewBox 跟随
    containerWidth = 1400;
    evoBtn.fire('click');
    assert.equal(makeEl('evo-chart-growth').getAttribute('viewBox'), '0 0 1400 260', '重复激活应按新宽度重绘');
  } finally {
    globalThis.document = prevDocument;
    globalThis.requestAnimationFrame = prevRaf;
  }
});

test('空数据容错：无表时 stats/dataGraph 置空且 HTML 可渲染', () => {
  const model = buildDbViewerModel({ _meta: {} });
  assert.equal(model.stats, null);
  assert.equal(model.dataGraph, null);
  const html = renderDbOverviewHtml({ meta: { sourceDir: '/x/1.mysql' }, tables: [], foreignKeys: [], migrations: [], domains: [], views: [], triggers: [], procedures: [] });
  assert.ok(html.includes('data-tab="dbstats"'), '空数据时 Tab 按钮仍在（由脚本按需隐藏）');
  assert.ok(html.length > 1000);
});
