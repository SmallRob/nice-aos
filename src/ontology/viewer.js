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

// 脚本蓝图保护：图节点/锚点/清单截断（大油猴仓库单脚本可达数千函数）
const SCRIPT_CAP = 24;
const SCRIPT_NODE_CAP = 50;
const SCRIPT_TABLE_CAP = 40;
const SCRIPT_INJECT_CAP = 20;
const SCRIPT_NET_CAP = 12;

// 脚本函数业务角色（与解析器 inferRoles 对应）
const SCRIPT_ROLE_META = {
  render: { label: '渲染注入', color: '#58a6ff' },
  data: { label: '数据获取', color: '#bc8cff' },
  state: { label: '状态存取', color: '#3fb950' },
  event: { label: '事件监听', color: '#d29922' },
  ui: { label: '元素构建', color: '#39c5cf' },
  logic: { label: '纯逻辑', color: '#8b949e' },
};

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
  const scriptFunctions = dataMap.ScriptFunction ?? [];
  const injectionPoints = dataMap.InjectionPoint ?? [];
  const networkEndpoints = dataMap.NetworkEndpoint ?? [];
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

  // ---- 5. 脚本蓝图：单脚本函数调用图 + DOM 注入锚点 + 网络域（一图呈现逻辑注入链）----
  // 函数重要性：被调 ×3 + 调出 + 行为操作加权（注入/请求是逻辑注入链的关键节点）
  const fnScore = (f) => (f.calledByCount ?? 0) * 3 + (f.callCount ?? 0)
    + (f.htmlInjectionCount ?? 0) * 2 + (f.mountCount ?? 0) * 2
    + (f.networkCallCount ?? 0) * 2 + (f.gmApiCount ?? 0) + (f.listenerCount ?? 0);

  const fnsByScript = new Map();
  for (const f of scriptFunctions) {
    if (!fnsByScript.has(f.scriptId)) fnsByScript.set(f.scriptId, []);
    fnsByScript.get(f.scriptId).push(f);
  }
  const injectsByScript = new Map();
  for (const i of injectionPoints) {
    if (!injectsByScript.has(i.scriptId)) injectsByScript.set(i.scriptId, []);
    injectsByScript.get(i.scriptId).push(i);
  }
  const netsByScript = new Map();
  for (const n of networkEndpoints) {
    if (!netsByScript.has(n.scriptId)) netsByScript.set(n.scriptId, []);
    netsByScript.get(n.scriptId).push(n);
  }

  const scriptBlueprints = [...userScripts]
    .sort((a, b) => (b.functionCount ?? 0) - (a.functionCount ?? 0))
    .slice(0, SCRIPT_CAP)
    .map((s) => {
      const fns = fnsByScript.get(s.id) ?? [];
      const injects = (injectsByScript.get(s.id) ?? [])
        .slice().sort((a, b) => (b.callCount ?? 0) - (a.callCount ?? 0));
      const nets = (netsByScript.get(s.id) ?? [])
        .slice().sort((a, b) => (b.callCount ?? 0) - (a.callCount ?? 0));
      const idToName = new Map(fns.map((f) => [f.id, f.name]));

      // 图节点：重要性 Top N ∪ 入口函数（topLevelCalls 命中的函数必进图）
      const ranked = [...fns].sort((a, b) => fnScore(b) - fnScore(a));
      const entryNames = (s.topLevelCalls ?? [])
        .map((t) => t.name)
        .filter((n) => fns.some((f) => f.name === n))
        .slice(0, 8);
      const keep = new Set(ranked.slice(0, SCRIPT_NODE_CAP).map((f) => f.name));
      for (const n of entryNames) keep.add(n);
      const keptFns = fns.filter((f) => keep.has(f.name));
      const injectsOf = (name) => injects.filter((i) => (i.fns ?? []).includes(name));
      const netsOf = (name) => nets.filter((n) => (n.fns ?? []).includes(name));

      const nodes = keptFns.map((f) => ({
        name: f.name,
        kind: f.kind,
        roles: f.roles ?? ['logic'],
        line: f.line ?? null,
        lineCount: f.lineCount ?? null,
        isEntry: entryNames.includes(f.name),
        calls: (f.callIds ?? []).map((id) => idToName.get(id)).filter((n) => n && keep.has(n)),
        calledBy: (f.calledByIds ?? []).map((id) => idToName.get(id)).filter((n) => n && keep.has(n)),
        gmApis: (f.gmApiCalls ?? []).slice(0, 4),
        injects: injectsOf(f.name).slice(0, 3).map((i) => ({ kind: i.kind, target: i.target, interpolated: !!i.interpolated })),
        nets: netsOf(f.name).slice(0, 3).map((n) => ({ kind: n.kind, domain: n.domain })),
      }));

      const anchors = {
        injections: injects.slice(0, SCRIPT_INJECT_CAP).map((i) => ({
          kind: i.kind,
          target: i.target,
          interpolated: !!i.interpolated,
          callCount: i.callCount ?? 0,
          lines: i.lines ?? [],
          fns: (i.fns ?? []).filter((n) => keep.has(n)),
        })),
        injectionTotal: injects.length,
        networks: nets.slice(0, SCRIPT_NET_CAP).map((n) => ({
          kind: n.kind,
          domain: n.domain,
          methods: n.methods ?? [],
          allowedByConnect: n.allowedByConnect ?? null,
          callCount: n.callCount ?? 0,
          fns: (n.fns ?? []).filter((n2) => keep.has(n2)),
        })),
        networkTotal: nets.length,
      };

      const roleCounts = {};
      for (const f of fns) {
        for (const r of (f.roles ?? ['logic'])) roleCounts[r] = (roleCounts[r] ?? 0) + 1;
      }

      return {
        id: s.id,
        name: s.name,
        version: s.version ?? null,
        filePath: s.filePath,
        matches: (s.matches ?? []).slice(0, 3),
        grants: (s.grants ?? []).slice(0, 6),
        grantNone: !!s.grantNone,
        connects: (s.connects ?? []).slice(0, 6),
        hostFramework: s.hostFramework ?? null,
        runAt: s.runAt ?? null,
        riskLevel: s.riskLevel ?? 'none',
        lineCount: s.lineCount ?? 0,
        graph: { nodes, entryNames, anchors },
        functionTable: ranked.slice(0, SCRIPT_TABLE_CAP).map((f) => ({
          name: f.name,
          kind: f.kind,
          roles: f.roles ?? ['logic'],
          line: f.line ?? null,
          lineCount: f.lineCount ?? null,
          callCount: f.callCount ?? 0,
          calledByCount: f.calledByCount ?? 0,
          gmApiCount: f.gmApiCount ?? 0,
          domOpCount: (f.domOpCount ?? 0) + (f.htmlInjectionCount ?? 0) + (f.mountCount ?? 0),
          networkCallCount: f.networkCallCount ?? 0,
        })),
        roleCounts,
        topRisks: (s.risks ?? []).slice(0, 4),
      };
    });

  const scriptBlueprint = userScripts.length ? {
    scriptCount: userScripts.length,
    shownScriptCount: scriptBlueprints.length,
    highRiskCount: userScripts.filter((s) => s.riskLevel === 'high').length,
    mediumRiskCount: userScripts.filter((s) => s.riskLevel === 'medium').length,
    totalFunctionCount: scriptFunctions.length,
    totalInjectionCount: injectionPoints.length,
    totalNetworkCount: networkEndpoints.length,
    roleMeta: Object.entries(SCRIPT_ROLE_META).map(([key, v]) => ({ key, ...v })),
    scripts: scriptBlueprints,
  } : null;

  return {
    viewerVersion: '1.0',
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    blueprint,
    project: {
      id: project.id, name: project.name, framework: project.framework,
      frameworkLabel: project.frameworkLabel ?? project.framework,
      hostConfigs: project.hostConfigs ?? [],
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
    scriptBlueprint,
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
.layer-row { margin: 6px 0; }
.layer-row .lr-main { display: flex; align-items: center; gap: 10px; }
.layer-row .lbl { width: 90px; color: var(--fg-dim); font-size: 12px; flex-shrink: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.layer-row .bar-wrap { flex: 1; }
.layer-row .val { width: 120px; font-size: 12px; color: var(--fg-dim); text-align: right; flex-shrink: 0; white-space: nowrap; }
.layer-row .lr-desc { margin: 3px 0 0 100px; font-size: 11px; color: var(--fg-dim); opacity: 0.85; line-height: 1.5; }
@media (max-width: 720px) { .layer-row .lr-desc { margin-left: 0; } }
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
/* ---- 脚本蓝图：SVG 逻辑注入关系图 ---- */
.graph-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--panel2); padding: 8px; }
.graph-wrap svg { display: block; }
svg .gn { cursor: pointer; }
svg .gn rect { fill: var(--panel); stroke-width: 1.5; transition: opacity .12s; }
svg .gn text { font-size: 11px; font-family: 'SF Mono', Menlo, monospace; }
svg .ge { stroke: rgba(88,166,255,.5); stroke-width: 1.2; fill: none; transition: opacity .12s; }
svg .ge.inject { stroke: rgba(57,197,207,.65); stroke-dasharray: 5 3; }
svg .ge.net { stroke: rgba(188,140,255,.65); stroke-dasharray: 2 3; }
svg.focus .gn, svg.focus .ge { opacity: .15; }
svg.focus .gn.hl, svg.focus .ge.hl { opacity: 1; }
svg .col-label { fill: var(--fg-faint); font-size: 11px; font-family: -apple-system, 'PingFang SC', sans-serif; }
.legend { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; align-items: center; }
.legend .dot { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 4px; vertical-align: -1px; }
.legend .line { display: inline-block; width: 18px; height: 0; border-top: 1.5px solid; margin-right: 4px; vertical-align: 3px; }
#script-fn-info { margin-top: 10px; min-height: 20px; }
#script-fn-info .name { font-family: 'SF Mono', Menlo, monospace; color: var(--blue); }
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
    <div class="tab" data-tab="scripts">脚本蓝图</div>
  </nav>
</header>
<main>
  <section class="view active" id="view-overview"></section>
  <section class="view" id="view-blueprint"></section>
  <section class="view" id="view-data"></section>
  <section class="view" id="view-flow"></section>
  <section class="view" id="view-scripts"></section>
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
function barRow(label, value, max, cls, desc) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return '<div class="layer-row"><div class="lr-main"><span class="lbl">' + esc(label) + '</span>'
    + '<div class="bar-wrap"><div class="bar ' + (cls || '') + '" style="width:' + pct + '%"></div></div>'
    + '<span class="val">' + fmt(value) + ' · ' + pct + '%</span></div>'
    + (desc ? '<div class="lr-desc">' + esc(desc) + '</div>' : '')
    + '</div>';
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
    + layers.map((l) => barRow(l.label, l.fileCount, maxLayer, '', l.description)).join('')
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

// ---------- Tab 5: 脚本蓝图（油猴脚本函数调用图 + 逻辑注入链）----------
const ROLE = {};
((M.scriptBlueprint && M.scriptBlueprint.roleMeta) || []).forEach((r) => { ROLE[r.key] = r; });
const roleColor = (roles) => ((ROLE[(roles || ['logic'])[0]] || {}).color) || '#8b949e';
const roleLabel = (r) => (ROLE[r] ? ROLE[r].label : r);

let selectedScript = null;
function renderScripts() {
  const el = document.getElementById('view-scripts');
  const sb = M.scriptBlueprint;
  if (!sb || !sb.scriptCount) {
    el.innerHTML = '<div class="panel"><h2>脚本蓝图</h2><div class="empty">未检测到油猴脚本（UserScript）——React/Vue 仓库无脚本蓝图。</div></div>';
    return;
  }
  const cards = sb.scripts.map((s, i) =>
    '<div class="card" data-idx="' + i + '"><h4>' + esc(s.name) + (s.version ? ' <span class="sub">v' + esc(s.version) + '</span>' : '') + '</h4>'
    + (s.matches.length ? '<div class="sum">' + s.matches.map(esc).join(' · ') + '</div>' : '')
    + '<div class="chips">'
    + (s.riskLevel !== 'none' ? chip('风险 ' + s.riskLevel, s.riskLevel === 'high' ? 'red' : (s.riskLevel === 'medium' ? 'amber' : 'green')) : chip('风险 none', 'green'))
    + (s.hostFramework && s.hostFramework !== 'unknown' ? chip(s.hostFramework, 'cyan') : '')
    + chip(fmt(s.lineCount) + ' 行', '')
    + chip((s.functionTable.length ? '函数 ' + fmt(s.functionTable.length) + '+' : '') + (s.roleCounts ? fmt(Object.values(s.roleCounts).reduce((a, b) => a + b, 0)) + ' 函数' : ''), 'purple')
    + chip(s.graph.anchors.injectionTotal + ' 注入', 'cyan')
    + chip(s.graph.anchors.networkTotal + ' 端点', 'amber')
    + '</div>'
    + (s.topRisks.length ? '<div class="sum" style="color:var(--amber)">' + s.topRisks[0].detail + '</div>' : '')
    + '</div>').join('');
  el.innerHTML =
    '<div class="panel"><h2>油猴脚本蓝图（' + sb.scriptCount + ' 个脚本 · 高风险 ' + sb.highRiskCount + ' · 中风险 ' + sb.mediumRiskCount + '）</h2>'
    + '<div class="chips" style="margin-bottom:12px">'
    + chip('函数 ' + fmt(sb.totalFunctionCount), 'purple')
    + chip('DOM 注入点 ' + fmt(sb.totalInjectionCount), 'cyan')
    + chip('网络端点 ' + fmt(sb.totalNetworkCount), 'amber')
    + '</div>'
    + '<div class="note">展示规模最大的前 ' + sb.shownScriptCount + ' 个脚本（按函数数排序）；点击卡片查看该脚本的函数调用关系图与逻辑注入链。</div>'
    + '<div class="grid">' + cards + '</div></div>'
    + '<div id="script-detail"></div>';
  el.querySelectorAll('.card').forEach((c) => c.addEventListener('click', () => {
    el.querySelectorAll('.card').forEach((x) => x.classList.remove('selected'));
    c.classList.add('selected');
    selectedScript = sb.scripts[Number(c.dataset.idx)];
    renderScriptDetail();
  }));
}

function buildScriptGraphSvg(g) {
  const nodes = g.nodes || [];
  if (!nodes.length) return '<div class="empty">该脚本无可识别的逻辑单元（函数/对象/类）。</div>';
  const byName = {};
  nodes.forEach((n) => { byName[n.name] = n; });
  let entries = (g.entryNames || []).filter((n) => byName[n]);
  if (!entries.length) entries = nodes.filter((n) => !(n.calledBy || []).length).map((n) => n.name);
  if (!entries.length) entries = [nodes[0].name];
  const level = {};
  const q = [];
  entries.forEach((n) => { level[n] = 0; q.push(n); });
  while (q.length) {
    const cur = q.shift();
    const lv = level[cur];
    (byName[cur].calls || []).forEach((to) => {
      if (!byName[to] || to === cur) return;
      if (level[to] === undefined || level[to] > lv + 1) { level[to] = lv + 1; q.push(to); }
    });
  }
  let maxLv = 0;
  Object.values(level).forEach((v) => { if (v > maxLv) maxLv = v; });
  nodes.forEach((n) => { if (level[n.name] === undefined) level[n.name] = maxLv + 1; });
  maxLv = Math.max.apply(null, nodes.map((n) => level[n.name]));

  const COL = 250, ROW = 48, W = 184, H = 36, PADX = 24, PADY = 34;
  const cols = [];
  nodes.forEach((n) => { const lv = level[n.name]; (cols[lv] = cols[lv] || []).push(n); });
  const pos = {};
  let maxRows = 1;
  cols.forEach((c, lv) => {
    c.forEach((n, i) => { pos[n.name] = { x: PADX + lv * COL, y: PADY + i * ROW }; });
    if (c.length > maxRows) maxRows = c.length;
  });
  const inj = (g.anchors && g.anchors.injections) || [];
  const net = (g.anchors && g.anchors.networks) || [];
  const injX = PADX + (maxLv + 1) * COL;
  const netX = injX + COL;
  inj.forEach((a, i) => { pos['@i' + i] = { x: injX, y: PADY + i * ROW }; });
  net.forEach((a, i) => { pos['@n' + i] = { x: netX, y: PADY + i * ROW }; });
  const rowsTotal = Math.max(maxRows, inj.length, net.length);
  const svgW = netX + W + PADX;
  const svgH = PADY * 2 + Math.max(1, rowsTotal - 1) * ROW;

  const edgeSeen = {};
  const edges = [];
  nodes.forEach((n) => (n.calls || []).forEach((to) => {
    if (!byName[to] || to === n.name) return;
    const k = n.name + '>' + to;
    if (edgeSeen[k]) return;
    edgeSeen[k] = 1;
    edges.push({ from: n.name, to: to, kind: 'call' });
  }));
  inj.forEach((a, i) => (a.fns || []).forEach((fn) => { if (byName[fn]) edges.push({ from: fn, to: '@i' + i, kind: 'inject' }); }));
  net.forEach((a, i) => (a.fns || []).forEach((fn) => { if (byName[fn]) edges.push({ from: fn, to: '@n' + i, kind: 'net' }); }));

  let s = '<svg width="' + svgW + '" height="' + svgH + '" viewBox="0 0 ' + svgW + ' ' + svgH + '">';
  s += '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#8b949e"/></marker></defs>';
  s += '<text class="col-label" x="' + PADX + '" y="14">入口</text>';
  if (inj.length) s += '<text class="col-label" x="' + injX + '" y="14">DOM 注入点</text>';
  if (net.length) s += '<text class="col-label" x="' + netX + '" y="14">网络端点</text>';
  edges.forEach((e) => {
    const a = pos[e.from]; const b = pos[e.to];
    if (!a || !b) return;
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
    let d;
    if (b.x > a.x + 20) {
      const mx = (x1 + x2) / 2;
      d = 'M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ',' + mx + ' ' + y2 + ',' + (x2 - 3) + ' ' + y2;
    } else {
      const cy = Math.min(y1, y2) - 22;
      d = 'M' + x1 + ' ' + y1 + ' C' + (x1 + 46) + ' ' + cy + ',' + (x2 - 46) + ' ' + cy + ',' + x2 + ' ' + y2;
    }
    s += '<path class="ge ' + e.kind + '" data-e="' + esc(e.from) + '§' + esc(e.to) + '" d="' + d + '" marker-end="url(#arr)"/>';
  });
  nodes.forEach((n) => {
    const p = pos[n.name]; const c = roleColor(n.roles);
    const label = n.name.length > 24 ? n.name.slice(0, 23) + '…' : n.name;
    s += '<g class="gn" data-n="' + esc(n.name) + '">'
      + '<rect x="' + p.x + '" y="' + p.y + '" width="' + W + '" height="' + H + '" rx="6" stroke="' + c + '"' + (n.isEntry ? ' stroke-width="2.5"' : '') + '/>'
      + '<text x="' + (p.x + 10) + '" y="' + (p.y + 15) + '">' + esc(label) + '</text>'
      + '<text x="' + (p.x + 10) + '" y="' + (p.y + 28) + '" style="fill:#8b949e;font-size:10px">' + esc((n.roles || []).map(roleLabel).join(' · ')) + '</text>'
      + '<title>' + esc(n.name) + '  L' + (n.line || '?') + ' · ' + (n.lineCount || 0) + ' 行 · 被调 ' + ((n.calledBy || []).length) + ' 次</title>'
      + '</g>';
  });
  inj.forEach((a, i) => {
    const p = pos['@i' + i];
    const label = String(a.target || '').length > 26 ? String(a.target).slice(0, 25) + '…' : (a.target || '');
    s += '<g class="gn" data-n="@i' + i + '">'
      + '<rect x="' + p.x + '" y="' + p.y + '" width="' + W + '" height="' + H + '" rx="10" stroke="#39c5cf" fill="rgba(57,197,207,.07)" stroke-dasharray="4 3"/>'
      + '<text x="' + (p.x + 10) + '" y="' + (p.y + 15) + '" style="fill:#39c5cf">' + esc(label) + '</text>'
      + '<text x="' + (p.x + 10) + '" y="' + (p.y + 28) + '" style="fill:#8b949e;font-size:10px">' + esc(a.kind + (a.interpolated ? ' · 动态插值' : '')) + '</text>'
      + '<title>' + esc(a.kind + ' → ' + a.target + ' × ' + a.callCount + (a.lines && a.lines.length ? '  L' + a.lines.join(',') : '')) + '</title></g>';
  });
  net.forEach((a, i) => {
    const p = pos['@n' + i];
    const label = String(a.domain || '').length > 26 ? String(a.domain).slice(0, 25) + '…' : (a.domain || '');
    s += '<g class="gn" data-n="@n' + i + '">'
      + '<rect x="' + p.x + '" y="' + p.y + '" width="' + W + '" height="' + H + '" rx="18" stroke="#bc8cff" fill="rgba(188,140,255,.07)" stroke-dasharray="3 3"/>'
      + '<text x="' + (p.x + 10) + '" y="' + (p.y + 15) + '" style="fill:#bc8cff">' + esc(label) + '</text>'
      + '<text x="' + (p.x + 10) + '" y="' + (p.y + 28) + '" style="fill:#8b949e;font-size:10px">' + esc(a.kind + (a.methods && a.methods.length ? ' ' + a.methods.join('/') : '') + (a.allowedByConnect === false ? ' · 未@connect' : '')) + '</text>'
      + '<title>' + esc(a.kind + ' → ' + a.domain + ' × ' + a.callCount) + '</title></g>';
  });
  s += '</svg>';
  return s;
}

function bindGraphEvents(svgEl, script) {
  const info = document.getElementById('script-fn-info');
  svgEl.querySelectorAll('.gn').forEach((g) => {
    g.addEventListener('mouseenter', () => {
      svgEl.classList.add('focus');
      const n = g.dataset.n;
      const related = {};
      related[n] = 1;
      svgEl.querySelectorAll('.ge').forEach((e) => {
        const parts = e.dataset.e.split('§');
        if (parts[0] === n || parts[1] === n) {
          e.classList.add('hl');
          related[parts[0]] = 1;
          related[parts[1]] = 1;
        }
      });
      svgEl.querySelectorAll('.gn').forEach((x) => { if (related[x.dataset.n]) x.classList.add('hl'); });
    });
    g.addEventListener('mouseleave', () => {
      svgEl.classList.remove('focus');
      svgEl.querySelectorAll('.hl').forEach((x) => x.classList.remove('hl'));
    });
    g.addEventListener('click', () => {
      const key = g.dataset.n;
      if (key.charAt(0) === '@') {
        const isNet = key.charAt(1) === 'n';
        const idx = Number(key.slice(2));
        const a = isNet ? script.graph.anchors.networks[idx] : script.graph.anchors.injections[idx];
        if (!a) return;
        info.innerHTML = '<b class="name">' + esc(isNet ? a.domain : a.target) + '</b> '
          + chip(isNet ? a.kind : a.kind, isNet ? 'purple' : 'cyan')
          + (isNet ? (a.allowedByConnect === false ? chip('未在 @connect 声明', 'red') : (a.allowedByConnect === true ? chip('@connect 已声明', 'green') : '')) : (a.interpolated ? chip('动态插值（XSS 面）', 'red') : ''))
          + ' <span class="sub">× ' + a.callCount + ' · 归属函数：' + (a.fns && a.fns.length ? a.fns.map(esc).join('、') : '（未识别）') + '</span>';
        return;
      }
      const node = script.graph.nodes.find((x) => x.name === key);
      if (!node) return;
      info.innerHTML = '<b class="name">' + esc(node.name) + '</b> '
        + (node.roles || []).map((r) => chip(roleLabel(r), r === 'render' ? 'blue' : r === 'data' ? 'purple' : r === 'state' ? 'green' : r === 'event' ? 'amber' : r === 'ui' ? 'cyan' : '')).join(' ')
        + chip('L' + (node.line || '?'), '')
        + chip((node.lineCount || 0) + ' 行', '')
        + (node.isEntry ? chip('入口', 'red') : '')
        + (node.gmApis && node.gmApis.length ? chip('GM: ' + node.gmApis.join(','), 'amber') : '')
        + '<div class="sub">调用 → ' + ((node.calls || []).length ? node.calls.map(esc).join('、') : '（无）')
        + ' · 被 ← ' + ((node.calledBy || []).length ? node.calledBy.map(esc).join('、') : '（顶层直调）') + '</div>'
        + (node.injects && node.injects.length ? '<div class="sub">注入 → ' + node.injects.map((i) => esc(i.kind + ' ' + i.target)).join('；') + '</div>' : '')
        + (node.nets && node.nets.length ? '<div class="sub">请求 → ' + node.nets.map((n) => esc(n.domain)).join('、') + '</div>' : '');
    });
  });
}

function renderScriptDetail() {
  const s = selectedScript;
  const box = document.getElementById('script-detail');
  if (!s) { box.innerHTML = ''; return; }
  const riskChip = s.riskLevel === 'high' ? chip('风险 high', 'red') : s.riskLevel === 'medium' ? chip('风险 medium', 'amber') : chip('风险 ' + s.riskLevel, 'green');
  const roleEntries = Object.entries(s.roleCounts || {}).sort((a, b) => b[1] - a[1]);
  const maxRole = roleEntries.length ? roleEntries[0][1] : 0;
  const inj = s.graph.anchors.injections;
  const net = s.graph.anchors.networks;

  box.innerHTML =
    '<div class="panel"><div class="back"><button class="btn" id="btn-sback">← 收起</button></div>'
    + '<h2>' + esc(s.name) + (s.version ? ' v' + esc(s.version) : '') + '</h2>'
    + '<div class="path">' + esc(s.filePath) + '</div>'
    + '<div class="chips" style="margin:8px 0">' + riskChip
    + (s.hostFramework && s.hostFramework !== 'unknown' ? chip('宿主 ' + s.hostFramework, 'cyan') : '')
    + (s.runAt ? chip('run-at ' + s.runAt, '') : '')
    + chip(fmt(s.lineCount) + ' 行', '')
    + (s.grantNone ? chip('@grant none', 'amber') : (s.grants.length ? chip('@grant × ' + s.grants.length, 'blue') : ''))
    + (s.connects.length ? chip('@connect × ' + s.connects.length, 'purple') : '')
    + '</div>'
    + (s.matches.length ? '<div class="sub">匹配页面：' + s.matches.map(esc).join(' · ') + '</div>' : '')

    + '<h3>逻辑注入关系图（函数调用 → DOM 注入点 / 网络端点）</h3>'
    + '<div class="graph-wrap" id="script-graph"></div>'
    + '<div class="legend">'
    + '<span><span class="line" style="border-color:rgba(88,166,255,.8)"></span>调用</span>'
    + '<span><span class="line" style="border-color:#39c5cf;border-top-style:dashed"></span>DOM 注入</span>'
    + '<span><span class="line" style="border-color:#bc8cff;border-top-style:dotted"></span>网络请求</span>'
    + '<span class="note" style="margin:0">· 悬停高亮邻接 · 点击查看详情 · 从左到右为调用深度</span></div>'
    + '<div id="script-fn-info"><div class="note">点击图中节点查看函数详情（角色/行号/调用关系/注入目标）。</div></div>'
    + (s.functionTable.length > s.graph.nodes.length ? '<div class="note">图示重要性 Top ' + s.graph.nodes.length + ' 函数（共 ' + fmt(Object.values(s.roleCounts || {}).reduce((a, b) => a + b, 0)) + ' 个），完整清单见下表。</div>' : '')
    + '</div>'

    + '<div class="panel"><h3>业务角色分布</h3>'
    + roleEntries.map((r) => barRow(roleLabel(r[0]), r[1], maxRole, r[0] === 'render' ? '' : r[0] === 'data' ? 'purple' : r[0] === 'state' ? 'green' : r[0] === 'event' ? 'amber' : 'cyan')).join('')
    + '<div class="note">角色按函数内行为推断：渲染注入（innerHTML/挂载）、数据获取（网络请求）、状态存取（GM 存储）、事件监听（监听器/观察者/定时器）、元素构建（createElement）。</div></div>'

    + '<div class="panel"><h3>函数清单（Top ' + s.functionTable.length + '）</h3>'
    + table(
      [{ label: '函数' }, { label: '角色' }, { label: '行', num: true }, { label: '行数', num: true }, { label: '调用', num: true }, { label: '被调', num: true }, { label: 'GM', num: true }, { label: 'DOM', num: true }, { label: '网络', num: true }],
      s.functionTable.map((f) => [
        { v: f.name, html: '<b>' + esc(f.name) + '</b> <span class="note">' + esc(f.kind) + '</span>' },
        { v: (f.roles || []).join(','), html: (f.roles || []).map((r) => chip(roleLabel(r), r === 'render' ? 'blue' : r === 'data' ? 'purple' : r === 'state' ? 'green' : r === 'event' ? 'amber' : r === 'ui' ? 'cyan' : '')).join(' ') },
        { v: f.line ?? '-', num: true },
        { v: f.lineCount ?? '-', num: true },
        { v: f.callCount, num: true },
        { v: f.calledByCount, num: true },
        { v: f.gmApiCount, num: true },
        { v: f.domOpCount, num: true },
        { v: f.networkCallCount, num: true },
      ]))
    + '</div>'

    + '<div class="panel"><h3>DOM 注入点（' + inj.length + ' / ' + s.graph.anchors.injectionTotal + '）</h3>'
    + (inj.length ? table(
      [{ label: '类型' }, { label: '注入目标（页面锚点）' }, { label: '归属函数' }, { label: '次数', num: true }, { label: '行' }],
      inj.map((i) => [
        { v: i.kind, html: chip(i.kind, i.kind === 'mount' ? 'cyan' : 'blue') },
        { v: i.target, html: '<span class="path">' + esc(i.target) + '</span>' + (i.interpolated ? ' ' + chip('动态插值', 'red') : '') },
        { v: (i.fns || []).join(','), html: (i.fns || []).length ? (i.fns || []).map((f) => '<b>' + esc(f) + '</b>').join('、') : '<span class="note">（未识别）</span>' },
        { v: i.callCount, num: true },
        { v: (i.lines || []).join(',') || '-' },
      ])) : '<div class="empty">无 DOM 注入点。</div>')
    + '<div class="note">挂载目标经 querySelector 变量锚点还原（如 container → #gameList）；动态插值标记为潜在 XSS 面。</div></div>'

    + '<div class="panel"><h3>网络端点（' + net.length + ' / ' + s.graph.anchors.networkTotal + '）</h3>'
    + (net.length ? table(
      [{ label: '域名' }, { label: '类型' }, { label: '方法' }, { label: '@connect' }, { label: '归属函数' }, { label: '次数', num: true }],
      net.map((n) => [
        { v: n.domain, html: '<b>' + esc(n.domain) + '</b>' },
        { v: n.kind, html: chip(n.kind, 'purple') },
        { v: (n.methods || []).join('/') || '-' },
        { v: n.allowedByConnect, html: n.allowedByConnect === true ? chip('已声明', 'green') : n.allowedByConnect === false ? chip('未声明', 'red') : '<span class="note">—</span>' },
        { v: (n.fns || []).join(','), html: (n.fns || []).length ? (n.fns || []).map((f) => '<b>' + esc(f) + '</b>').join('、') : '<span class="note">（未识别）</span>' },
        { v: n.callCount, num: true },
      ])) : '<div class="empty">无网络请求。</div>')
    + '</div>'

    + (s.topRisks.length ? '<div class="panel"><h3>风险清单</h3><ul class="plain">'
      + s.topRisks.map((r) => '<li>' + chip(r.severity, r.severity === 'high' ? 'red' : r.severity === 'medium' ? 'amber' : 'green') + ' <b>' + esc(r.kind) + '</b> — ' + esc(r.detail) + (r.line ? '（L' + r.line + '）' : '') + '</li>').join('')
      + '</ul></div>' : '');

  const graphEl = document.getElementById('script-graph');
  graphEl.innerHTML = buildScriptGraphSvg(s.graph);
  const svgEl = graphEl.querySelector('svg');
  if (svgEl) bindGraphEvents(svgEl, s);
  box.querySelector('#btn-sback').addEventListener('click', () => {
    selectedScript = null;
    document.getElementById('view-scripts').querySelectorAll('.card').forEach((x) => x.classList.remove('selected'));
    box.innerHTML = '';
  });
}

// ---------- 初始化 ----------
document.getElementById('v-title').textContent = M.project.name + ' — 本体蓝图查看器';
document.getElementById('v-sub').textContent =
  (M.project.frameworkLabel || M.project.framework || 'unknown') + ' · ' + fmt(M.project.fileCount) + ' 源文件 · '
  + M.domainCount + ' 功能域 · ' + (M.project.commitHash ? ('commit ' + M.project.commitHash.slice(0, 7) + ' · ') : '')
  + (M.scriptBlueprint ? M.scriptBlueprint.scriptCount + ' 油猴脚本 · ' : '')
  + '生成于 ' + (M.generatedAt || '').replace('T', ' ').slice(0, 19);
if (!M.scriptBlueprint) document.querySelector('.tab[data-tab="scripts"]').style.display = 'none';
renderOverview();
renderBlueprint();
renderData();
renderFlow();
if (M.scriptBlueprint) renderScripts();
</script>
</body>
</html>`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
