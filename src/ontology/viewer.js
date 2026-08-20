// 本体查看器（Viewer）——使用者层的"企业级知识中心"（对应参考架构中的 Web UI 消费者）
// 数据流：snapshot.json（DataMap）→ buildViewerModel()（数据聚合）→ renderViewerHtml()（视图层渲染）
// 三个视图：
//   1. 领域蓝图（Domain Blueprint）：每个功能域的业务层级构成 / 代码组织 / 单元清单
//   2. 业务数据图（Data Map）：Store 数据枢纽 + 跨域数据依赖
//   3. 业务逻辑流向（Logic Flow）：架构层间导入流向 + 跨域依赖 + 高扇入业务节点
// 原则：视图模型（JSON）独立于渲染，可被 AI agent 直接消费；HTML 自包含零依赖，可离线打开

import { ARCH_LAYERS } from './semantics.js';
import { ONTOLOGY_META, OBJECT_TYPES, LINK_TYPES } from './blueprint.js';

// 大仓库保护：单元清单按上限截断（计数保留全量，列表供浏览）
const UNIT_CAP = { components: 200, hooks: 120, stores: 100, services: 150, userScripts: 60, routes: 100 };
const USED_BY_CAP = 30;
const HUB_CAP = 15;
const MODULE_CAP = 150;

const layerLabel = (key) => ARCH_LAYERS[key]?.label ?? key;

// ============================================================
// 第一部分：数据聚合 —— DataMap → 视图模型（JSON）
// ============================================================
export function buildViewerModel(dataMap) {
  const project = (dataMap.Project ?? [])[0] ?? {};
  const domains = dataMap.Domain ?? [];
  const modules = dataMap.Module ?? [];
  const files = dataMap.SourceFile ?? [];
  const components = dataMap.Component ?? [];
  const stores = dataMap.Store ?? [];
  const hooks = dataMap.Hook ?? [];
  const services = dataMap.Service ?? [];
  const routes = dataMap.Route ?? [];
  const userScripts = dataMap.UserScript ?? [];
  const meta = dataMap._meta ?? {};

  const fileByPath = new Map(files.map((f) => [f.path, f]));
  const moduleById = new Map(modules.map((m) => [m.id, m]));
  const domainById = new Map(domains.map((d) => [d.id, d]));

  // 文件 → 功能域归属（从 Domain.fileIds 反查；多域嵌套取首个为业务主域）
  const fileDomainIds = new Map();
  for (const d of domains) {
    for (const fid of d.fileIds ?? []) {
      const p = fid.startsWith('file:') ? fid.slice(5) : fid;
      if (!fileDomainIds.has(p)) fileDomainIds.set(p, []);
      const arr = fileDomainIds.get(p);
      if (!arr.includes(d.id)) arr.push(d.id);
    }
  }
  const domainsOfPath = (p) => fileDomainIds.get(p) ?? [];

  // 被导入索引：目标文件路径 → 导入方文件数组
  const importersOf = new Map();
  for (const f of files) {
    for (const id of f.importIds ?? []) {
      if (!id.startsWith('file:')) continue;
      const target = id.slice(5);
      if (!importersOf.has(target)) importersOf.set(target, []);
      importersOf.get(target).push(f.path);
    }
  }

  // ---- 1. 本体蓝图（schema 展示：概念分类体系 + 对象/链接类型 + 实例计数）----
  const objectCounts = meta.objectCounts ?? {};
  const blueprint = {
    version: ONTOLOGY_META.version,
    abstractionLevels: ONTOLOGY_META.abstractionLevels,
    categories: ONTOLOGY_META.categories,
    objectTypes: OBJECT_TYPES.map((t) => ({
      type: t.type, prefix: t.prefix, category: t.category, level: t.level,
      description: t.description, count: objectCounts[t.type] ?? 0,
    })),
    linkTypes: LINK_TYPES,
    objectCounts,
  };

  // ---- 2. 领域蓝图：每个功能域的层级构成 / 代码组织 / 单元清单 ----
  const unitsOfDomain = (pred) => ({
    components: components.filter(pred).map(toComponentItem),
    stores: stores.filter(pred).map(toStoreItem),
    hooks: hooks.filter(pred).map(toHookItem),
    services: services.filter(pred).map(toServiceItem),
    userScripts: userScripts.filter(pred).map(toScriptItem),
  });

  const domainBlueprints = domains.map((d) => {
    const fileSet = new Set((d.fileIds ?? []).map((fid) => (fid.startsWith('file:') ? fid.slice(5) : fid)));
    // 域内层级构成（业务层级关系）
    const layerCounts = {};
    let lineCount = 0;
    for (const p of fileSet) {
      const f = fileByPath.get(p);
      if (!f) continue;
      const key = f.archLayer ?? 'shared';
      layerCounts[key] = (layerCounts[key] ?? 0) + 1;
      lineCount += f.lineCount ?? 0;
    }
    const layerComposition = Object.entries(layerCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([key, fileCount]) => ({ key, label: layerLabel(key), fileCount }));

    // 域内代码组织（模块清单，按子树文件数排序）
    const domainModules = (d.moduleIds ?? [])
      .map((mid) => moduleById.get(mid))
      .filter(Boolean)
      .sort((a, b) => (b.subtreeFileCount ?? b.fileCount ?? 0) - (a.subtreeFileCount ?? a.fileCount ?? 0))
      .slice(0, MODULE_CAP)
      .map((m) => ({
        path: m.path,
        archLayer: m.archLayer ?? null,
        archLayerLabel: m.archLayerLabel ?? (m.archLayer ? layerLabel(m.archLayer) : null),
        fileCount: m.fileCount ?? 0,
        subtreeFileCount: m.subtreeFileCount ?? m.fileCount ?? 0,
        summary: m.summary ?? null,
      }));

    // 域内单元清单（截断保护）
    const inDomain = (u) => (u.domainIds ?? []).includes(d.id);
    const units = unitsOfDomain(inDomain);
    const domainRoutes = (d.routeIds ?? [])
      .map((rid) => routes.find((r) => r.id === rid))
      .filter(Boolean)
      .slice(0, UNIT_CAP.routes)
      .map((r) => ({
        id: r.id, path: r.routePath ?? r.overlayId, routeType: r.routeType,
        description: r.description ?? null,
      }));

    return {
      id: d.id,
      name: d.name,
      sources: d.sources ?? [],
      capability: d.capability ?? null,
      summary: d.summary ?? null,
      fileCount: d.fileCount ?? fileSet.size,
      lineCount: d.lineCount ?? lineCount,
      layerComposition,
      modules: domainModules,
      moduleCount: d.moduleCount ?? (d.moduleIds ?? []).length,
      routes: domainRoutes,
      routeCount: d.routeCount ?? (d.routeIds ?? []).length,
      units,
      counts: {
        components: (d.componentIds ?? []).length,
        stores: (d.storeIds ?? []).length,
        hooks: (d.hookIds ?? []).length,
        services: (d.serviceIds ?? []).length,
        userScripts: (d.userScriptIds ?? []).length,
      },
    };
  });

  // ---- 3. 业务数据图：Store 数据枢纽 + 跨域数据依赖 ----
  const storeCards = stores.map((s) => {
    const importers = importersOf.get(s.filePath) ?? [];
    const usedByDomains = new Map(); // domainName -> count
    for (const p of importers) {
      for (const did of domainsOfPath(p)) {
        const dn = domainById.get(did)?.name ?? did;
        usedByDomains.set(dn, (usedByDomains.get(dn) ?? 0) + 1);
      }
    }
    return {
      id: s.id,
      name: s.name,
      filePath: s.filePath,
      domainIds: (s.domainIds ?? []).map((did) => domainById.get(did)?.name ?? did),
      stateKeyCount: s.stateKeyCount ?? (s.stateKeys ?? []).length,
      stateKeys: (s.stateKeys ?? []).slice(0, 20),
      actionKeyCount: (s.actionKeys ?? []).length,
      hasPersist: !!s.hasPersist,
      storageKey: s.storageKey ?? null,
      usedByFileCount: importers.length,
      usedBy: importers.slice(0, USED_BY_CAP),
      usedByDomains: [...usedByDomains.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count })),
    };
  });

  // 跨域数据依赖：导入方域 → Store 所在域（同一 Store 汇总）
  const crossDomainData = [];
  for (const s of storeCards) {
    const storeDomains = s.domainIds.length > 0 ? s.domainIds : ['（无域）'];
    for (const { name: importerDomain, count } of s.usedByDomains) {
      if (storeDomains.includes(importerDomain)) continue;
      for (const storeDomain of storeDomains) {
        crossDomainData.push({
          from: importerDomain,
          to: storeDomain,
          kind: 'store',
          target: s.name,
          count,
        });
      }
    }
  }
  crossDomainData.sort((a, b) => b.count - a.count);

  const dataMap2 = {
    stores: storeCards,
    crossDomainData,
    totalStateKeys: stores.reduce((a, s) => a + (s.stateKeyCount ?? (s.stateKeys ?? []).length), 0),
    persistedStores: stores.filter((s) => s.hasPersist).map((s) => s.name),
  };

  // ---- 4. 业务逻辑流向：层间导入流向 + 跨域依赖 + 高扇入节点 ----
  const layerFlowMap = new Map(); // "from>to" -> count
  const domainEdgeMap = new Map(); // "from>to" -> count
  for (const f of files) {
    if (f.isTest) continue;
    const fromLayer = f.archLayer ?? 'shared';
    const fromDomains = domainsOfPath(f.path).map((did) => domainById.get(did)?.name).filter(Boolean);
    for (const id of f.importIds ?? []) {
      if (!id.startsWith('file:')) continue;
      const t = fileByPath.get(id.slice(5));
      if (!t || t.isTest) continue;
      const toLayer = t.archLayer ?? 'shared';
      const fk = `${fromLayer}>${toLayer}`;
      layerFlowMap.set(fk, (layerFlowMap.get(fk) ?? 0) + 1);
      const toDomains = domainsOfPath(t.path).map((did) => domainById.get(did)?.name).filter(Boolean);
      for (const fd of fromDomains.length ? fromDomains : [null]) {
        for (const td of toDomains.length ? toDomains : [null]) {
          if (!fd || !td || fd === td) continue;
          const dk = `${fd}>${td}`;
          domainEdgeMap.set(dk, (domainEdgeMap.get(dk) ?? 0) + 1);
        }
      }
    }
  }

  const layerFlow = [...layerFlowMap.entries()]
    .map(([k, count]) => {
      const [from, to] = k.split('>');
      return { from, fromLabel: layerLabel(from), to, toLabel: layerLabel(to), count };
    })
    .sort((a, b) => b.count - a.count);

  const domainEdges = [...domainEdgeMap.entries()]
    .map(([k, count]) => {
      const [from, to] = k.split('>');
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count);

  // 高扇入业务节点（变更影响面最大的服务与状态）
  const hubServices = services
    .map((s) => ({
      id: s.id, name: s.name, filePath: s.filePath,
      importedByCount: (importersOf.get(s.filePath) ?? []).length,
      domainIds: (s.domainIds ?? []).map((did) => domainById.get(did)?.name ?? did),
      lineCount: s.lineCount ?? null,
    }))
    .sort((a, b) => b.importedByCount - a.importedByCount)
    .slice(0, HUB_CAP);

  const hubStores = storeCards
    .map((s) => ({ id: s.id, name: s.name, domainIds: s.domainIds, usedByFileCount: s.usedByFileCount }))
    .sort((a, b) => b.usedByFileCount - a.usedByFileCount)
    .slice(0, HUB_CAP);

  const logicFlow = {
    layerFlow,
    layerFlowTotal: layerFlow.reduce((a, e) => a + e.count, 0),
    domainEdges,
    domainEdgeTotal: domainEdges.reduce((a, e) => a + e.count, 0),
    hubServices,
    hubStores,
  };

  return {
    viewerVersion: '1.0',
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    blueprint,
    project: {
      id: project.id, name: project.name, framework: project.framework,
      fileCount: project.fileCount, tsxFileCount: project.tsxFileCount ?? null,
      vueFileCount: project.vueFileCount ?? null, userScriptFileCount: project.userScriptFileCount ?? null,
      commitHash: project.commitHash ?? null, branch: project.branch ?? null,
      summary: project.summary ?? null,
      architecture: project.architecture ?? null,
      health: project.health ?? null,
      capabilities: project.capabilities ?? null,
    },
    domainCount: domains.length,
    domains: domainBlueprints,
    dataMap: dataMap2,
    logicFlow,
    quality: {
      cycles: meta.cycles ?? [],
      orphanCandidateCount: (meta.orphanCandidates ?? []).length,
    },
  };
}

// ---- 单元条目（紧凑形态，供 HTML 渲染）----
function toComponentItem(c) {
  return { id: c.id, name: c.name, kind: c.kind, filePath: c.filePath, lineCount: c.lineCount ?? null, description: c.description ?? null };
}
function toStoreItem(s) {
  return { id: s.id, name: s.name, filePath: s.filePath, stateKeyCount: s.stateKeyCount ?? (s.stateKeys ?? []).length, hasPersist: !!s.hasPersist };
}
function toHookItem(h) {
  return { id: h.id, name: h.name, filePath: h.filePath, lineCount: h.lineCount ?? null, description: h.description ?? null };
}
function toServiceItem(s) {
  return { id: s.id, name: s.name, filePath: s.filePath, pattern: s.pattern, lineCount: s.lineCount ?? null };
}
function toScriptItem(u) {
  return { id: u.id, name: u.name, filePath: u.filePath, riskLevel: u.riskLevel ?? null, hostFramework: u.hostFramework ?? null };
}

// ============================================================
// 第二部分：视图层 —— 视图模型 → 自包含 HTML（零依赖，可离线打开）
// ============================================================
export function renderViewerHtml(model) {
  const dataJson = JSON.stringify(model).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(model.project.name)} · 本体蓝图查看器</title>
<style>
:root {
  --bg: #0d1117; --panel: #161b22; --panel2: #1c2128; --border: #30363d;
  --fg: #e6edf3; --fg-dim: #8b949e; --fg-faint: #6e7681;
  --blue: #58a6ff; --green: #3fb950; --amber: #d29922; --purple: #bc8cff;
  --red: #f85149; --cyan: #39c5cf;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--fg); font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; font-size: 14px; line-height: 1.6; }
header { padding: 20px 24px 0; border-bottom: 1px solid var(--border); }
h1 { font-size: 20px; }
h2 { font-size: 16px; margin-bottom: 12px; color: var(--fg); }
h3 { font-size: 14px; margin: 16px 0 8px; color: var(--fg); }
.sub { color: var(--fg-dim); font-size: 12px; margin-top: 4px; }
.tabs { display: flex; gap: 4px; margin-top: 14px; }
.tab { padding: 8px 16px; cursor: pointer; color: var(--fg-dim); border: 1px solid transparent; border-bottom: none; border-radius: 6px 6px 0 0; font-size: 14px; }
.tab:hover { color: var(--fg); background: var(--panel); }
.tab.active { color: var(--fg); background: var(--panel); border-color: var(--border); position: relative; top: 1px; }
main { padding: 20px 24px 48px; max-width: 1400px; }
section.view { display: none; }
section.view.active { display: block; }
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px; cursor: pointer; transition: border-color .15s; }
.card:hover { border-color: var(--blue); }
.card.selected { border-color: var(--blue); box-shadow: 0 0 0 1px var(--blue); }
.card h4 { font-size: 14px; margin-bottom: 6px; }
.card .sum { color: var(--fg-dim); font-size: 12px; margin-bottom: 8px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; background: var(--panel2); border: 1px solid var(--border); color: var(--fg-dim); }
.chip.blue { color: var(--blue); border-color: rgba(88,166,255,.4); }
.chip.green { color: var(--green); border-color: rgba(63,185,80,.4); }
.chip.amber { color: var(--amber); border-color: rgba(210,153,34,.4); }
.chip.purple { color: var(--purple); border-color: rgba(188,140,255,.4); }
.chip.red { color: var(--red); border-color: rgba(248,81,73,.4); }
.chip.cyan { color: var(--cyan); border-color: rgba(57,197,207,.4); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
th { color: var(--fg-dim); font-weight: 600; font-size: 12px; white-space: nowrap; }
tr:hover td { background: rgba(88,166,255,.04); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.bar-wrap { background: var(--panel2); border-radius: 4px; height: 8px; overflow: hidden; min-width: 60px; }
.bar { height: 100%; border-radius: 4px; background: var(--blue); }
.bar.green { background: var(--green); }
.bar.amber { background: var(--amber); }
.bar.purple { background: var(--purple); }
.bar.cyan { background: var(--cyan); }
.bar.red { background: var(--red); }
.layer-row { display: flex; align-items: center; gap: 10px; margin: 6px 0; }
.layer-row .lbl { width: 90px; color: var(--fg-dim); font-size: 12px; flex-shrink: 0; }
.layer-row .bar-wrap { flex: 1; }
.layer-row .val { width: 120px; font-size: 12px; color: var(--fg-dim); text-align: right; flex-shrink: 0; }
.kv { display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 12px; }
.kv .item { text-align: center; min-width: 80px; }
.kv .item .v { font-size: 22px; font-weight: 700; }
.kv .item .k { font-size: 11px; color: var(--fg-dim); }
ul.plain { list-style: none; }
ul.plain li { padding: 3px 0; color: var(--fg-dim); font-size: 13px; }
ul.plain li b { color: var(--fg); font-weight: 500; }
.path { font-family: 'SF Mono', Menlo, monospace; font-size: 12px; color: var(--fg-dim); }
details { margin: 6px 0; }
summary { cursor: pointer; color: var(--blue); font-size: 13px; padding: 4px 0; }
.matrix td.heat { text-align: center; font-variant-numeric: tabular-nums; }
.matrix td.heat span.hot { background: rgba(88,166,255,.25); color: var(--fg); font-weight: 600; display: inline-block; min-width: 34px; border-radius: 4px; }
.matrix td.heat span.warm { background: rgba(88,166,255,.12); color: var(--fg); display: inline-block; min-width: 34px; border-radius: 4px; }
.matrix td.heat span.cold { color: var(--fg-faint); }
.empty { color: var(--fg-faint); font-size: 13px; padding: 16px 0; }
.note { color: var(--fg-faint); font-size: 12px; margin-top: 8px; }
.split { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 1000px) { .split { grid-template-columns: 1fr; } }
.badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
.badge.ok { background: rgba(63,185,80,.15); color: var(--green); }
.badge.warn { background: rgba(210,153,34,.15); color: var(--amber); }
.badge.bad { background: rgba(248,81,73,.15); color: var(--red); }
.back { margin-bottom: 12px; }
button.btn { background: var(--panel2); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
button.btn:hover { border-color: var(--blue); color: var(--blue); }
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
  </nav>
</header>
<main>
  <section class="view active" id="view-overview"></section>
  <section class="view" id="view-blueprint"></section>
  <section class="view" id="view-data"></section>
  <section class="view" id="view-flow"></section>
</main>
<script id="viewer-data" type="application/json">${dataJson}</script>
<script>
const M = JSON.parse(document.getElementById('viewer-data').textContent);
const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmt = (n) => (n ?? 0).toLocaleString('zh-CN');

// ---------- Tab 切换 ----------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.view').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  document.getElementById('view-' + t.dataset.tab).classList.add('active');
}));

// ---------- 通用组件 ----------
const chip = (text, cls) => '<span class="chip ' + (cls || '') + '">' + esc(text) + '</span>';
function barRow(label, value, max, cls) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return '<div class="layer-row"><span class="lbl">' + esc(label) + '</span>'
    + '<div class="bar-wrap"><div class="bar ' + (cls || '') + '" style="width:' + pct + '%"></div></div>'
    + '<span class="val">' + fmt(value) + ' · ' + pct + '%</span></div>';
}
function table(headers, rows, opts) {
  opts = opts || {};
  const head = headers.map((h) => '<th class="' + (h.num ? 'num' : '') + '">' + esc(h.label) + '</th>').join('');
  const body = rows.map((r) => '<tr>' + r.map((c) => '<td class="' + (c.num ? 'num' : '') + '">' + (c.html || esc(c.v)) + '</td>').join('') + '</tr>').join('');
  return '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
}

// ---------- Tab 1: 总览 ----------
function renderOverview() {
  const p = M.project;
  const el = document.getElementById('view-overview');
  const arch = p.architecture || {};
  const layers = arch.layers || [];
  const maxLayer = layers.length ? layers[0].fileCount : 0;
  const h = p.health || {};
  const capMap = Object.fromEntries((p.capabilities || []).map((c) => [c.domain, c.summary]));

  el.innerHTML =
    '<div class="panel"><h2>执行摘要</h2>'
    + '<ul class="plain">' + (p.summary || '').split('。').filter(Boolean).map((s) => '<li>' + esc(s) + '。</li>').join('') + '</ul>'
    + '<div class="note">分层依据内容信号推断（单元构成/路由归属/引用结构），目录名仅作弱信号回退。</div></div>'

    + '<div class="panel"><h2>健康度</h2><div class="chips">'
    + (h.cycleCount ? chip('循环依赖 ' + h.cycleCount, 'red') : chip('循环依赖 0', 'green'))
    + (h.orphanFileCount ? chip('死代码候选 ' + fmt(h.orphanFileCount), 'amber') : chip('死代码候选 0', 'green'))
    + (h.undeclaredDependencyCount ? chip('未声明依赖 ' + h.undeclaredDependencyCount, 'amber') : chip('未声明依赖 0', 'green'))
    + (h.highRiskScriptCount ? chip('高风险脚本 ' + h.highRiskScriptCount, 'red') : '')
    + (h.analysisErrorCount ? chip('解析错误 ' + h.analysisErrorCount, 'red') : chip('解析错误 0', 'green'))
    + '</div></div>'

    + '<div class="panel"><h2>架构分层</h2>'
    + layers.map((l) => barRow(l.label + '（' + l.description + '）', l.fileCount, maxLayer)).join('')
    + '</div>'

    + '<div class="panel"><h2>功能域清单（' + M.domainCount + ' 个）</h2>'
    + table(
      [{ label: '功能域' }, { label: '能力画像', num: false }],
      M.domains.slice(0, 40).map((d) => [
        { v: d.name, html: '<b>' + esc(d.name) + '</b> ' + chip(d.fileCount + ' 文件', 'blue') },
        { v: capMap[d.name] || d.summary || '' },
      ]),
    )
    + (M.domains.length > 40 ? '<div class="note">仅显示前 40 个功能域，完整清单见"领域蓝图"页。</div>' : '')
    + '</div>'

    + '<div class="panel"><h2>本体蓝图（概念分类体系 v' + (M.blueprint.version || '') + '）</h2>'
    + '<div class="split"><div>'
    + '<h3>抽象层级</h3>'
    + table([{ label: '层级' }, { label: '名称' }, { label: '类型' }],
      M.blueprint.abstractionLevels.map((l) => [
        { v: l.level, html: chip(l.level, 'purple') },
        { v: l.name },
        { v: l.types.join(' / ') },
      ]))
    + '</div><div>'
    + '<h3>对象实例计数</h3>'
    + table([{ label: '类型' }, { label: '范畴' }, { label: '层级', num: true }, { label: '数量', num: true }],
      M.blueprint.objectTypes.map((t) => [
        { v: t.type, html: '<b>' + esc(t.type) + '</b> <span class="path">' + esc(t.prefix) + '</span>' },
        { v: t.category },
        { v: t.level },
        { v: fmt(t.count), num: true },
      ]))
    + '</div></div>'
    + '<h3>链接类型（' + M.blueprint.linkTypes.length + ' 种）</h3>'
    + '<div class="chips">' + M.blueprint.linkTypes.map((l) => chip(l, 'cyan')).join('') + '</div>'
    + '</div>';
}

// ---------- Tab 2: 领域蓝图 ----------
let selectedDomain = null;
function renderBlueprint() {
  const el = document.getElementById('view-blueprint');
  const cards = M.domains.map((d, i) =>
    '<div class="card" data-idx="' + i + '"><h4>' + esc(d.name) + '</h4>'
    + '<div class="sum">' + esc(d.summary || '') + '</div>'
    + '<div class="chips">'
    + (d.routeCount ? chip(d.routeCount + ' 路由', 'blue') : '')
    + (d.counts.components ? chip(d.counts.components + ' 组件', 'purple') : '')
    + (d.counts.stores ? chip(d.counts.stores + ' Store', 'green') : '')
    + (d.counts.hooks ? chip(d.counts.hooks + ' Hook', 'cyan') : '')
    + (d.counts.services ? chip(d.counts.services + ' Service', 'amber') : '')
    + (d.counts.userScripts ? chip(d.counts.userScripts + ' 脚本', 'red') : '')
    + chip(d.fileCount + ' 文件', '')
    + '</div></div>').join('');
  el.innerHTML =
    '<div class="panel"><h2>功能域地图（' + M.domainCount + ' 个功能域，点击下钻）</h2>'
    + '<div class="grid">' + cards + '</div></div>'
    + '<div id="domain-detail"></div>';
  el.querySelectorAll('.card').forEach((c) => c.addEventListener('click', () => {
    el.querySelectorAll('.card').forEach((x) => x.classList.remove('selected'));
    c.classList.add('selected');
    selectedDomain = M.domains[Number(c.dataset.idx)];
    renderDomainDetail();
  }));
}
function renderDomainDetail() {
  const d = selectedDomain;
  const box = document.getElementById('domain-detail');
  if (!d) { box.innerHTML = ''; return; }
  const maxLayer = d.layerComposition.length ? d.layerComposition[0].fileCount : 0;
  const unitSection = (title, list, render) => list.length
    ? '<details open><summary>' + title + '（' + list.length + '）</summary><ul class="plain">'
      + list.map(render).join('') + '</ul></details>'
    : '';
  box.innerHTML =
    '<div class="panel"><div class="back"><button class="btn" id="btn-back">← 收起</button></div>'
    + '<h2>功能域：' + esc(d.name) + '</h2>'
    + (d.capability ? '<div class="sub">' + esc(d.capability) + '</div>' : '')
    + '<div class="kv" style="margin-top:12px">'
    + '<div class="item"><div class="v">' + fmt(d.fileCount) + '</div><div class="k">文件</div></div>'
    + '<div class="item"><div class="v">' + fmt(d.lineCount) + '</div><div class="k">代码行</div></div>'
    + '<div class="item"><div class="v">' + fmt(d.routeCount) + '</div><div class="k">路由</div></div>'
    + '<div class="item"><div class="v">' + fmt(d.moduleCount) + '</div><div class="k">模块</div></div>'
    + '</div>'
    + '<div class="chips" style="margin-bottom:12px">' + (d.sources || []).map((s) => chip('来源: ' + s, 'cyan')).join('')
    + (d.counts.components ? chip(d.counts.components + ' 组件', 'purple') : '')
    + (d.counts.stores ? chip(d.counts.stores + ' Store', 'green') : '')
    + (d.counts.hooks ? chip(d.counts.hooks + ' Hook', 'cyan') : '')
    + (d.counts.services ? chip(d.counts.services + ' Service', 'amber') : '')
    + (d.counts.userScripts ? chip(d.counts.userScripts + ' 脚本', 'red') : '') + '</div>'

    + '<h3>业务层级构成</h3>'
    + d.layerComposition.map((l) => barRow(l.label, l.fileCount, maxLayer, 'green')).join('')

    + '<h3>代码组织（模块 ' + d.modules.length + ' / ' + d.moduleCount + '）</h3>'
    + (d.modules.length ? table(
      [{ label: '模块路径' }, { label: '语义层' }, { label: '直属文件', num: true }, { label: '子树文件', num: true }, { label: '职责画像' }],
      d.modules.map((m) => [
        { v: m.path, html: '<span class="path">' + esc(m.path) + '</span>' },
        { v: m.archLayerLabel || m.archLayer || '-', html: chip(m.archLayerLabel || m.archLayer || '-', 'blue') },
        { v: m.fileCount, num: true },
        { v: m.subtreeFileCount, num: true },
        { v: m.summary || '-' },
      ])) : '<div class="empty">（无直属模块）</div>')

    + '<h3>单元清单</h3>'
    + (d.routes.length ? unitSection('路由（' + d.routes.length + '）', d.routes,
      (r) => '<li><b>' + esc(r.path) + '</b> <span class="path">' + esc(r.routeType || '') + '</span>' + (r.description ? ' — ' + esc(r.description) : '') + '</li>') : '')
    + unitSection('组件（' + d.units.components.length + (d.units.components.length < d.counts.components ? ' / ' + d.counts.components : '') + '）', d.units.components,
      (c) => '<li><b>' + esc(c.name) + '</b> ' + chip(c.kind || 'common', 'purple') + ' <span class="path">' + esc(c.filePath) + '</span>' + (c.description ? '<br><span class="note">' + esc(c.description) + '</span>' : '') + '</li>')
    + unitSection('Store（' + d.units.stores.length + '）', d.units.stores,
      (s) => '<li><b>' + esc(s.name) + '</b> ' + chip((s.stateKeyCount || 0) + ' state', 'green') + (s.hasPersist ? chip('persist', 'amber') : '') + ' <span class="path">' + esc(s.filePath) + '</span></li>')
    + unitSection('Hook（' + d.units.hooks.length + (d.units.hooks.length < d.counts.hooks ? ' / ' + d.counts.hooks : '') + '）', d.units.hooks,
      (h) => '<li><b>' + esc(h.name) + '</b> <span class="path">' + esc(h.filePath) + '</span>' + (h.description ? '<br><span class="note">' + esc(h.description) + '</span>' : '') + '</li>')
    + unitSection('Service（' + d.units.services.length + (d.units.services.length < d.counts.services ? ' / ' + d.counts.services : '') + '）', d.units.services,
      (s) => '<li><b>' + esc(s.name) + '</b> ' + chip(s.pattern || '', 'amber') + ' <span class="path">' + esc(s.filePath) + '</span></li>')
    + (d.units.userScripts.length ? unitSection('油猴脚本（' + d.units.userScripts.length + (d.units.userScripts.length < d.counts.userScripts ? ' / ' + d.counts.userScripts : '') + '）', d.units.userScripts,
      (u) => '<li><b>' + esc(u.name) + '</b> ' + (u.riskLevel ? chip(u.riskLevel, u.riskLevel === 'high' ? 'red' : (u.riskLevel === 'medium' ? 'amber' : 'green')) : '') + (u.hostFramework ? chip(u.hostFramework, 'cyan') : '') + ' <span class="path">' + esc(u.filePath) + '</span></li>') : '')
    + '</div>';
  box.querySelector('#btn-back').addEventListener('click', () => {
    selectedDomain = null;
    document.getElementById('view-blueprint').querySelectorAll('.card').forEach((x) => x.classList.remove('selected'));
    box.innerHTML = '';
  });
}

// ---------- Tab 3: 业务数据图 ----------
function renderData() {
  const el = document.getElementById('view-data');
  const d = M.dataMap;
  if (!d.stores.length) {
    el.innerHTML = '<div class="panel"><h2>业务数据图</h2><div class="empty">未检测到状态管理（Zustand / Pinia）——纯脚本或无 Store 仓库无业务数据图。</div></div>';
    return;
  }
  const storeCards = d.stores.map((s) =>
    '<div class="card" style="cursor:default"><h4>' + esc(s.name) + '</h4>'
    + '<div class="chips" style="margin:6px 0">'
    + (s.domainIds || []).map((dn) => chip(dn, 'green')).join('')
    + chip((s.stateKeyCount || 0) + ' state', 'blue')
    + chip((s.actionKeyCount || 0) + ' action', 'cyan')
    + (s.hasPersist ? chip('persist → ' + (s.storageKey || s.name), 'amber') : '')
    + '</div>'
    + (s.stateKeys.length ? '<div class="sum">state：' + s.stateKeys.map(esc).join(' · ') + (s.stateKeyCount > s.stateKeys.length ? ' …' : '') + '</div>' : '')
    + '<div class="sub">被 ' + s.usedByFileCount + ' 个文件使用'
    + (s.usedByDomains.length ? ' ← ' + s.usedByDomains.map((u) => esc(u.name) + '（' + u.count + '）').join('、') : '')
    + '</div>'
    + '<details><summary>使用方文件</summary><ul class="plain">'
    + s.usedBy.map((p) => '<li><span class="path">' + esc(p) + '</span></li>').join('')
    + (s.usedByFileCount > s.usedBy.length ? '<li class="note">… 共 ' + s.usedByFileCount + ' 个（截断显示）</li>' : '')
    + '</ul></details></div>').join('');

  const crossRows = d.crossDomainData.map((e) => [
    { v: e.from, html: '<b>' + esc(e.from) + '</b>' },
    { v: '→ ' + e.to, html: '<span style="color:var(--fg-dim)">→</span> <b>' + esc(e.to) + '</b>' },
    { v: e.target, html: chip(e.target, 'green') },
    { v: e.count, num: true },
  ]);

  el.innerHTML =
    '<div class="panel"><h2>Store 数据枢纽（' + d.stores.length + ' 个 · 状态键 ' + fmt(d.totalStateKeys) + ' · 持久化 ' + d.persistedStores.length + ' 个）</h2>'
    + '<div class="grid">' + storeCards + '</div></div>'
    + '<div class="panel"><h2>跨域数据依赖（' + d.crossDomainData.length + ' 条）</h2>'
    + (crossRows.length ? table([{ label: '使用方域' }, { label: 'Store 所在域' }, { label: 'Store' }, { label: '引用数', num: true }], crossRows)
      : '<div class="empty">无跨域数据依赖（各域状态自包含）。</div>')
    + '<div class="note">数据流向：使用方域 → Store 所在域；引用数为该域导入 Store 文件的次数。</div></div>';
}

// ---------- Tab 4: 业务逻辑流向 ----------
function renderFlow() {
  const el = document.getElementById('view-flow');
  const f = M.logicFlow;

  // 层间流向矩阵（from 层 × to 层）
  const layerKeys = [];
  const flowIdx = new Map();
  for (const e of f.layerFlow) {
    for (const k of [e.from, e.to]) if (!layerKeys.includes(k)) layerKeys.push(k);
    flowIdx.set(e.from + '>' + e.to, e.count);
  }
  const layerOrder = ['entry', 'presentation', 'state', 'service', 'integration', 'shared', 'types', 'config', 'script', 'test', 'mixed'];
  layerKeys.sort((a, b) => layerOrder.indexOf(a) - layerOrder.indexOf(b));
  const maxCell = Math.max(1, ...f.layerFlow.map((e) => e.count));
  const matrixRows = layerKeys.map((from) => [
    { v: from, html: chip(from, 'blue') },
    ...layerKeys.map((to) => {
      const c = flowIdx.get(from + '>' + to) ?? 0;
      const cls = c === 0 ? 'cold' : (c / maxCell > 0.4 ? 'hot' : 'warm');
      return { v: c || '·', html: '<span class="' + cls + '">' + (c || '·') + '</span>' };
    }),
  ]);

  const maxEdge = f.domainEdges.length ? f.domainEdges[0].count : 1;
  const edgeRows = f.domainEdges.slice(0, 50).map((e) => [
    { v: e.from, html: '<b>' + esc(e.from) + '</b>' },
    { v: '→ ' + e.to, html: '<span style="color:var(--fg-dim)">→</span> <b>' + esc(e.to) + '</b>' },
    { v: e.count, html: '<div class="bar-wrap"><div class="bar purple" style="width:' + Math.round((e.count / maxEdge) * 100) + '%"></div></div>' },
    { v: e.count, num: true },
  ]);

  const hubRows = f.hubServices.filter((s) => s.importedByCount > 0).map((s) => [
    { v: s.name, html: '<b>' + esc(s.name) + '</b> ' + (s.domainIds || []).map((dn) => chip(dn, 'amber')).join('') },
    { v: s.filePath, html: '<span class="path">' + esc(s.filePath) + '</span>' },
    { v: s.importedByCount, num: true },
  ]);

  el.innerHTML =
    '<div class="panel"><h2>层间导入流向（' + fmt(f.layerFlowTotal) + ' 条内部依赖边，测试文件已排除）</h2>'
    + '<table class="matrix"><thead><tr><th>from ↓ / to →</th>'
    + layerKeys.map((k) => '<th>' + esc(k) + '</th>').join('')
    + '</tr></thead><tbody>' + matrixRows.map((r) => '<tr>' + r.map((c) => '<td class="heat">' + (c.html || esc(c.v)) + '</td>').join('') + '</tr>').join('')
    + '</tbody></table>'
    + '<div class="note">行 = 导入方所在层，列 = 被导入文件所在层；格子数字 = 依赖边数。健康流向通常为 presentation → state/service → integration 单向向下。</div></div>'

    + '<div class="panel"><h2>跨域依赖（' + f.domainEdges.length + ' 条域间边）</h2>'
    + (edgeRows.length ? table([{ label: '依赖方域' }, { label: '被依赖域' }, { label: '强度' }, { label: '边数', num: true }], edgeRows)
      : '<div class="empty">无跨域依赖边（各域独立）。</div>')
    + '<div class="note">域 A 文件 import 域 B 文件即计一条边；边数越多，域间耦合越强，拆分成本越高。</div></div>'

    + '<div class="panel"><h2>高扇入业务节点（变更影响面 Top ' + f.hubServices.length + '）</h2>'
    + (hubRows.length ? table([{ label: 'Service' }, { label: '文件' }, { label: '被引用数', num: true }], hubRows)
      : '<div class="empty">无 Service 节点。</div>')
    + (f.hubStores.length ? '<h3>高使用 Store</h3>'
      + '<div class="chips">' + f.hubStores.map((s) => chip(s.name + ' ← ' + s.usedByFileCount + ' 文件', 'green')).join('') + '</div>' : '')
    + '</div>';
}

// ---------- 初始化 ----------
document.getElementById('v-title').textContent = M.project.name + ' — 本体蓝图查看器';
document.getElementById('v-sub').textContent =
  (M.project.framework || 'unknown') + ' · ' + fmt(M.project.fileCount) + ' 源文件 · '
  + M.domainCount + ' 功能域 · ' + (M.project.commitHash ? ('commit ' + M.project.commitHash.slice(0, 7) + ' · ') : '')
  + '生成于 ' + (M.generatedAt || '').replace('T', ' ').slice(0, 19);
renderOverview();
renderBlueprint();
renderData();
renderFlow();
</script>
</body>
</html>`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
