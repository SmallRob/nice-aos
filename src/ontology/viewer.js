// 本体查看器（Viewer）——使用者层的"企业级知识中心"（对应参考架构中的 Web UI 消费者）
// 数据流：snapshot.json（DataMap）→ buildViewerModel()（数据聚合）→ renderViewerHtml()（视图层渲染）
// 六个视图：
//   1. 领域蓝图（Domain Blueprint）：每个功能域的业务层级构成 / 代码组织 / 单元清单
//   2. 业务数据图（Data Map）：Store 数据枢纽 + 跨域数据依赖
//   3. 业务逻辑流向（Logic Flow）：架构层间导入流向 + 跨域依赖 + 高扇入业务节点
//   4. 实体类图（Entity Class Diagram）：Interface/Class 实体 UML 关系图（跨语言 TS/JS/Vue/Rust/Dart）
//   5. 脚本蓝图（Script Blueprint）：单脚本函数调用图 + DOM 注入锚点 + 网络端点
//   6. 本体概览（Ontology）：概念分类体系 + 对象/链接类型清单
// 油猴意图适配：无 React/Vue 结构的纯脚本仓库，视图 1/2/3 按函数意图（roles）重建
//   （意图功能域 / 存储枢纽 / 意图流转矩阵）；意图信号不足时视图置空并隐藏 Tab
// 原则：视图模型（JSON）独立于渲染，可被 AI agent 直接消费；HTML 自包含零依赖，可离线打开；
//       宽屏分档扩展内容宽度（1400 → 2400px），SVG 图等比自适应不截断

import { ARCH_LAYERS } from './semantics.js';
import { ONTOLOGY_META, OBJECT_TYPES, LINK_TYPES } from './blueprint.js';
import { buildThemeCss, DEFAULT_THEMES } from '../themes/index.js';
import { SHARED_CSS } from '../themes/sharedCss.js';

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
  const gmApiUsages = dataMap.GmApiUsage ?? [];
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
      providerType: s.providerType ?? null,
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

  // ---- 6. 油猴脚本意图适配：无 React/Vue 结构时按函数意图（roles）重建三视图 ----
  // 意图信号不足（纯功能增强脚本：单一意图/无调用流转/无状态存取）时置 null，前端隐藏对应 Tab
  const scriptNameById = new Map(userScripts.map((s) => [s.id, s.name]));

  // 6a. 领域蓝图适配：按主角色分组的虚拟功能域（仅当无目录级功能域时）
  const scriptDomains = (() => {
    if (domains.length > 0 || !userScripts.length || !scriptFunctions.length) return null;
    const groups = new Map();
    for (const f of scriptFunctions) {
      const key = (f.roles ?? ['logic'])[0];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    // 全部函数同一意图（常见于纯功能增强脚本）→ 无法分析出业务结构，不显示
    if (groups.size < 2) return null;
    const doms = [...groups.entries()]
      .map(([role, fns]) => {
        const meta = SCRIPT_ROLE_META[role] ?? { label: role, color: '#8b949e', desc: '' };
        const sorted = [...fns].sort((a, b) => fnScore(b) - fnScore(a));
        return {
          role,
          name: meta.label,
          color: meta.color,
          description: meta.desc,
          functionCount: fns.length,
          scriptNames: [...new Set(fns.map((f) => scriptNameById.get(f.scriptId)).filter(Boolean))].slice(0, 3),
          injectionCount: fns.reduce((a, f) => a + (f.htmlInjectionCount ?? 0) + (f.mountCount ?? 0), 0),
          networkCount: fns.reduce((a, f) => a + (f.networkCallCount ?? 0), 0),
          listenerCount: fns.reduce((a, f) => a + (f.listenerCount ?? 0) + (f.observerCount ?? 0) + (f.timerCount ?? 0), 0),
          gmApiCount: fns.reduce((a, f) => a + (f.gmApiCount ?? 0), 0),
          functions: sorted.slice(0, SCRIPT_TABLE_CAP).map((f) => ({
            name: f.name,
            kind: f.kind,
            roles: f.roles ?? ['logic'],
            line: f.line ?? null,
            lineCount: f.lineCount ?? null,
            callCount: f.callCount ?? 0,
            calledByCount: f.calledByCount ?? 0,
            domInjectionCount: (f.htmlInjectionCount ?? 0) + (f.mountCount ?? 0),
            networkCallCount: f.networkCallCount ?? 0,
            scriptName: scriptNameById.get(f.scriptId) ?? null,
          })),
        };
      })
      .sort((a, b) => b.functionCount - a.functionCount);
    return { domains: doms, distinctRoles: doms.length };
  })();

  // 6b. 业务数据图适配：脚本存储枢纽（localStorage / sessionStorage / indexedDB / GM 存储）
  const SCRIPT_STATE_GM = new Set(['GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues', 'GM_addValueChangeListener', 'GM_removeValueChangeListener']);
  const scriptDataMap = (() => {
    if (stores.length > 0 || !userScripts.length) return null;
    const gmByScript = new Map();
    for (const g of gmApiUsages) {
      if (!SCRIPT_STATE_GM.has(g.name)) continue;
      if (!gmByScript.has(g.scriptId)) gmByScript.set(g.scriptId, []);
      gmByScript.get(g.scriptId).push({ name: g.name, callCount: g.callCount ?? 0 });
    }
    const hubs = userScripts.map((s) => {
      const su = s.storageUsage ?? {};
      const stateFns = (fnsByScript.get(s.id) ?? [])
        .filter((f) => (f.roles ?? []).includes('state'))
        .sort((a, b) => fnScore(b) - fnScore(a))
        .slice(0, 12);
      return {
        name: s.name,
        version: s.version ?? null,
        filePath: s.filePath,
        storageUsage: { localStorage: su.localStorage ?? 0, sessionStorage: su.sessionStorage ?? 0, indexedDB: su.indexedDB ?? 0 },
        gmStorageApis: gmByScript.get(s.id) ?? [],
        unsafeWindowReads: (s.unsafeWindowReads ?? []).slice(0, 8),
        stateFunctions: stateFns.map((f) => ({
          name: f.name,
          roles: f.roles ?? ['logic'],
          gmApiCalls: (f.gmApiCalls ?? []).slice(0, 6),
          line: f.line ?? null,
        })),
      };
    });
    const hasSignal = hubs.some((h) => h.storageUsage.localStorage + h.storageUsage.sessionStorage + h.storageUsage.indexedDB > 0 || h.gmStorageApis.length > 0);
    // 无任何持久化信号（纯功能增强，不涉及状态数据）→ 不显示
    if (!hasSignal) return null;
    return { hubs };
  })();

  // 6c. 业务逻辑流向适配：函数意图流转矩阵（调用边按 from 角色 → to 角色聚合）+ 高扇入函数
  const scriptFlow = (() => {
    if (logicFlow.layerFlowTotal > 0 || !userScripts.length || !scriptFunctions.length) return null;
    const fnById = new Map(scriptFunctions.map((f) => [f.id, f]));
    const flowMap = new Map();
    let crossRoleEdges = 0;
    let totalEdges = 0;
    for (const f of scriptFunctions) {
      const fromRole = (f.roles ?? ['logic'])[0];
      for (const toId of f.callIds ?? []) {
        const t = fnById.get(toId);
        if (!t) continue;
        totalEdges++;
        const toRole = (t.roles ?? ['logic'])[0];
        if (fromRole !== toRole) crossRoleEdges++;
        const k = `${fromRole}>${toRole}`;
        flowMap.set(k, (flowMap.get(k) ?? 0) + 1);
      }
    }
    // 调用流转稀疏（扁平脚本：无跨意图调用且边数不足）→ 不显示
    if (crossRoleEdges < 3 && totalEdges < 8) return null;
    const flows = [...flowMap.entries()]
      .map(([k, count]) => {
        const [from, to] = k.split('>');
        return { from, fromLabel: SCRIPT_ROLE_META[from]?.label ?? from, to, toLabel: SCRIPT_ROLE_META[to]?.label ?? to, count };
      })
      .sort((a, b) => b.count - a.count);
    const hubs = [...scriptFunctions]
      .filter((f) => (f.calledByCount ?? 0) > 0)
      .sort((a, b) => (b.calledByCount ?? 0) - (a.calledByCount ?? 0))
      .slice(0, HUB_CAP)
      .map((f) => ({
        name: f.name,
        roles: f.roles ?? ['logic'],
        calledByCount: f.calledByCount ?? 0,
        callCount: f.callCount ?? 0,
        scriptName: scriptNameById.get(f.scriptId) ?? null,
      }));
    return { flows, flowTotal: totalEdges, crossRoleEdges, hubs };
  })();

  // ---- 7. 实体类图：Class/Interface 实体 UML 关系图（跨语言 TS/JS/Vue/Rust；implements/extends 边）----
  // 大仓库保护：关系活跃度 Top N 进图；每框字段/方法截断；清单独立截断；无类型实体时置 null 隐藏 Tab
  const entities = (() => {
    const classEntities = dataMap.Class ?? [];
    const ifaceEntities = dataMap.Interface ?? [];
    const methodEntities = dataMap.Method ?? [];
    const all = [...ifaceEntities, ...classEntities];
    if (!all.length) return null;

    const methodsById = new Map(methodEntities.map((m) => [m.id, m]));
    const entityById = new Map(all.map((e) => [e.id, e]));
    // Dart 方法 → Widget 构造渲染链目标（compCallIds 指向 Component 实体）
    const compById = new Map((dataMap.Component ?? []).map((c) => [c.id, c.name]));

    // 已解析关系边：implements（类→接口）/ extends（子→父）/ renders（Vue 组件组合），目标必须在本仓库实体内
    const edges = [];
    for (const c of classEntities) {
      for (const tid of c.implementsIds ?? []) {
        if (entityById.has(tid) && tid !== c.id) edges.push({ from: c.id, to: tid, kind: 'implements' });
      }
      if (c.extendsId && entityById.has(c.extendsId) && c.extendsId !== c.id) {
        edges.push({ from: c.id, to: c.extendsId, kind: 'extends' });
      }
      for (const tid of c.rendersIds ?? []) {
        if (entityById.has(tid) && tid !== c.id) edges.push({ from: c.id, to: tid, kind: 'renders' });
      }
    }
    for (const i of ifaceEntities) {
      for (const tid of i.extendsIds ?? []) {
        if (entityById.has(tid) && tid !== i.id) edges.push({ from: i.id, to: tid, kind: 'extends' });
      }
    }

    const degree = new Map();
    for (const e of edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }

    const methodCountOf = (e) => (e.methodIds ?? []).length;
    const langOf = (e) => e.language ?? 'ts';
    const kindOf = (e) => (e.id.startsWith('iface:') ? 'interface' : (e.kind ?? 'class'));
    const KIND_LABEL = { class: '类', struct: '结构体', enum: '枚举', interface: '接口', trait: 'Trait', component: '组件' };
    const LANG_LABEL = { ts: 'TS/JS', vue: 'Vue', rust: 'Rust', dart: 'Dart', go: 'Go' };

    // 图节点携带成员明细（字段/变体/方法截断）；清单行仅携带计数
    const toNode = (e) => {
      const ms = (e.methodIds ?? []).map((id) => methodsById.get(id)).filter(Boolean);
      const kind = kindOf(e);
      return {
        id: e.id,
        name: e.name,
        entityType: e.id.startsWith('iface:') ? 'interface' : 'class',
        kind,
        kindLabel: KIND_LABEL[kind] ?? kind,
        language: langOf(e),
        filePath: e.filePath,
        line: e.line ?? null,
        module: fileByPath.get(e.filePath)?.module ?? '',
        archLayer: e.archLayer ?? fileByPath.get(e.filePath)?.archLayer ?? null,
        exported: !!e.exported,
        deadCandidate: !!e.deadCandidate,
        isSingleton: !!e.isSingleton,
        derives: (e.derives ?? []).slice(0, 4),
        fields: (e.fields ?? []).slice(0, ENTITY_MEMBER_CAP).map((f) => ({ name: f.name, type: f.type ?? null })),
        fieldCount: (e.fields ?? []).length,
        variants: (e.variants ?? []).slice(0, ENTITY_MEMBER_CAP),
        variantCount: (e.variants ?? []).length,
        methods: ms.slice(0, ENTITY_MEMBER_CAP).map((m) => ({
          name: m.name, isStatic: !!m.isStatic, isAsync: !!m.isAsync,
          calls: [
            ...(m.callIds ?? []).map((id) => methodsById.get(id)?.name),
            ...(m.compCallIds ?? []).map((id) => compById.get(id) ?? id),
          ].filter(Boolean).slice(0, 5),
          calledBy: (m.calledByIds ?? []).map((id) => methodsById.get(id)?.name).filter(Boolean).slice(0, 5),
        })),
        methodCount: ms.length,
        degree: degree.get(e.id) ?? 0,
        implementsNames: e.implementsNames ?? [],
        extendsName: e.extendsName ?? null,
      };
    };
    const toRow = (e) => {
      const n = toNode(e);
      return {
        id: n.id, name: n.name, kind: n.kind, kindLabel: n.kindLabel, language: n.language,
        filePath: n.filePath, line: n.line, module: n.module, archLayer: n.archLayer,
        exported: n.exported, deadCandidate: n.deadCandidate, isSingleton: n.isSingleton,
        fieldCount: n.fieldCount, variantCount: n.variantCount, methodCount: n.methodCount,
        degree: n.degree, implementsNames: n.implementsNames, extendsName: n.extendsName,
      };
    };

    // 图节点：关系活跃度优先（出入边数，其次方法数）；不足最小规模时按语言轮转补齐成员规模
    // 最大的实体，确保每种语言的代表性实体（如无继承关系的 Rust struct）都能进入类图
    const related = all
      .filter((e) => (degree.get(e.id) ?? 0) > 0)
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || methodCountOf(b) - methodCountOf(a));
    const graphEntities = related.slice(0, ENTITY_NODE_CAP);
    if (graphEntities.length < ENTITY_GRAPH_MIN) {
      const chosen = new Set(graphEntities.map((e) => e.id));
      const pools = [...new Set(all.map((e) => langOf(e)))]
        .map((lang) => ({
          list: all
            .filter((e) => !chosen.has(e.id) && langOf(e) === lang)
            .sort((a, b) => methodCountOf(b) - methodCountOf(a) || (b.fields ?? []).length - (a.fields ?? []).length),
        }))
        .filter((p) => p.list.length)
        .sort((a, b) => b.list.length - a.list.length);
      let need = ENTITY_GRAPH_MIN - graphEntities.length;
      while (need > 0 && pools.some((p) => p.list.length)) {
        for (const p of pools) {
          if (need <= 0) break;
          const e = p.list.shift();
          if (e) { graphEntities.push(e); need -= 1; }
        }
      }
    }
    const graphIds = new Set(graphEntities.map((e) => e.id));
    const graphEdges = edges
      .filter((e) => graphIds.has(e.from) && graphIds.has(e.to))
      .map((e) => ({ from: e.from, to: e.to, kind: e.kind }));

    // 统计分布：语言 / 类型 / 架构层（label 服务端备好，前端零依赖）
    const tally = (get, labels) => {
      const counts = new Map();
      for (const e of all) {
        const key = get(e) ?? 'unknown';
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts.entries()]
        .map(([key, count]) => ({ key, label: labels[key] ?? layerLabel(key), count }))
        .sort((a, b) => b.count - a.count);
    };
    const moduleCounts = new Map();
    for (const e of all) {
      const mod = fileByPath.get(e.filePath)?.module ?? '';
      moduleCounts.set(mod, (moduleCounts.get(mod) ?? 0) + 1);
    }
    const crossLanguageEdges = edges.filter((e) => {
      const a = entityById.get(e.from);
      const b = entityById.get(e.to);
      return a && b && langOf(a) !== langOf(b);
    }).length;

    const tableRows = all
      .slice()
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || methodCountOf(b) - methodCountOf(a))
      .slice(0, ENTITY_TABLE_CAP)
      .map(toRow);

    return {
      totalCount: all.length,
      classCount: classEntities.length,
      interfaceCount: ifaceEntities.length,
      methodCount: methodEntities.length,
      edgeCount: edges.length,
      implementsCount: edges.filter((e) => e.kind === 'implements').length,
      extendsCount: edges.filter((e) => e.kind === 'extends').length,
      rendersCount: edges.filter((e) => e.kind === 'renders').length,
      crossLanguageEdges,
      relatedEntityCount: related.length,
      deadCandidateCount: all.filter((e) => e.deadCandidate).length,
      byLanguage: tally(langOf, LANG_LABEL),
      byKind: tally(kindOf, KIND_LABEL),
      byLayer: tally((e) => e.archLayer ?? fileByPath.get(e.filePath)?.archLayer ?? 'shared', {}),
      moduleOptions: [...moduleCounts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      graph: { nodes: graphEntities.map(toNode), edges: graphEdges },
      table: tableRows,
    };
  })();

  // ---- 8. 路由地图：路由清单 / 类型与域分布 / 路径层级树 / 导航链（含 Next.js App Router 与 Flutter 原生路由）----
  // 无路由时置 null 隐藏 Tab；导航边去重，入度 0 的路由视为入口
  const routeMap = (() => {
    if (!routes.length) return null;
    const routeById = new Map(routes.map((r) => [r.id, r]));

    const items = routes
      .slice()
      .sort((a, b) => (a.routePath ?? a.overlayId ?? '').localeCompare(b.routePath ?? b.overlayId ?? ''))
      .map((r) => {
        const navTargets = (r.navigatesToIds ?? [])
          .map((id) => routeById.get(id))
          .filter((x) => x && x.id !== r.id);
        return {
          id: r.id,
          path: r.routePath ?? r.overlayId,
          routeType: r.routeType ?? 'overlay',
          domain: r.domain ?? null,
          componentRef: r.componentRef ?? null,
          componentFile: r.componentFileId ? r.componentFileId.replace(/^file:/, '') : null,
          isDynamic: r.isDynamic ?? null,
          isClient: r.isClient ?? null,
          apiMethods: r.apiMethods ?? null,
          middlewares: (r.middlewares ?? []).slice(0, 8),
          frontendCalls: (r.frontendCalls ?? []).slice(0, 12).map((c) => ({
            filePath: c.filePath, line: c.line ?? null, method: c.method ?? null,
          })),
          frontendCallCount: (r.frontendCalls ?? []).length,
          flags: (r.specialFiles ?? []).slice(0, 10),
          description: r.description ?? null,
          layoutCount: (r.layoutFileIds ?? []).length,
          specialCount: (r.specialFiles ?? []).length,
          factoryPropsCount: (r.factoryProps ?? []).length,
          factoryProps: r.factoryProps ?? [],
          navToPaths: [...new Set(navTargets.map((x) => x.routePath ?? x.overlayId))],
          navToIds: navTargets.map((x) => x.id),
        };
      });
    const itemById = new Map(items.map((it) => [it.id, it]));

    // 导航边（去重）+ 出入度
    const navEdges = [];
    const edgeSeen = new Set();
    const outDeg = new Map();
    const inDeg = new Map();
    for (const it of items) {
      for (const toId of it.navToIds) {
        const to = itemById.get(toId);
        if (!to) continue;
        const k = it.id + '>' + to.id;
        if (edgeSeen.has(k)) continue;
        edgeSeen.add(k);
        navEdges.push({ from: it.id, fromPath: it.path, to: to.id, toPath: to.path });
        inDeg.set(to.id, (inDeg.get(to.id) ?? 0) + 1);
        outDeg.set(it.id, (outDeg.get(it.id) ?? 0) + 1);
      }
    }
    const entryCount = items.filter((it) => !inDeg.get(it.id) && outDeg.get(it.id)).length;
    const orphanCount = items.filter((it) => !inDeg.get(it.id) && !outDeg.get(it.id)).length;

    // 类型分布（固定顺序，仅保留出现的类型）
    const TYPE_ORDER = ['overlay', 'react', 'vue', 'flutter', 'next', 'next-api', 'go', 'go-cli'];
    const byType = TYPE_ORDER
      .filter((k) => items.some((it) => it.routeType === k))
      .map((k) => ({ key: k, count: items.filter((it) => it.routeType === k).length }));

    // 域分组：按路由 domain 字段聚合（null → 未分组），组内按 path 排序
    const domainGroups = [];
    const groupIdx = new Map();
    for (const it of items) {
      const name = it.domain ?? '（未分组）';
      if (!groupIdx.has(name)) {
        groupIdx.set(name, { name, routes: [] });
        domainGroups.push(groupIdx.get(name));
      }
      groupIdx.get(name).routes.push(it);
    }
    domainGroups.sort((a, b) => b.routes.length - a.routes.length || a.name.localeCompare(b.name));

    // 路径层级树：'/' 为根，逐段嵌套（每节点独立子段索引，不同分支同名段不合并）；
    // 中间段节点 routes 为空数组；静态段在前动态段在后
    // go-cli 命令链（如 `smartide new instance`）按空格分段，呈现命令树
    const root = { seg: '/', full: '/', routes: [], children: [] };
    for (const it of items) {
      const segs = it.path === '/' ? []
        : it.routeType === 'go-cli' ? it.path.split(/\s+/).filter(Boolean)
        : it.path.replace(/^\//, '').split('/');
      let node = root;
      for (const seg of segs) {
        if (!node._idx) node._idx = new Map();
        let child = node._idx.get(seg);
        if (!child) {
          child = { seg, full: node.full === '/' ? '/' + seg : node.full + '/' + seg, routes: [], children: [] };
          node._idx.set(seg, child);
          node.children.push(child);
        }
        node = child;
      }
      node.routes.push(it);
    }
    const stripIdx = (node) => { delete node._idx; node.children.forEach(stripIdx); };
    stripIdx(root);
    const sortTree = (node) => {
      node.children.sort((a, b) => {
        const dyn = (x) => (x.seg.startsWith(':') ? 1 : 0);
        return dyn(a) - dyn(b) || a.seg.localeCompare(b.seg);
      });
      node.children.forEach(sortTree);
    };
    sortTree(root);
    let maxDepth = 0;
    const walkDepth = (node, d) => {
      if (d > maxDepth) maxDepth = d;
      node.children.forEach((c) => walkDepth(c, d + 1));
    };
    walkDepth(root, 0);

    return {
      totalCount: items.length,
      navEdgeCount: navEdges.length,
      entryCount,
      orphanCount,
      dynamicCount: items.filter((it) => it.isDynamic).length,
      apiRouteCount: items.filter((it) => it.routeType === 'next-api').length,
      goApiRouteCount: items.filter((it) => it.routeType === 'go').length,
      goCliRouteCount: items.filter((it) => it.routeType === 'go-cli').length,
      frontendCallTotal: items.reduce((a, it) => a + it.frontendCallCount, 0),
      unmatchedFrontendCalls: (meta.unmatchedFrontendCalls ?? []).slice(0, 30),
      byType,
      domainGroups,
      tree: root,
      maxDepth,
      navEdges,
      items,
    };
  })();

  // ---- 9. 组件数据流：PropEdge 传递边 / 来源分类分布 / 组件出入度（React props 传递链）----
  // 无 PropEdge 时置 null 隐藏 Tab；来源分类 spread 不计入六类分布
  const propFlow = (() => {
    const propEdges = dataMap.PropEdge ?? [];
    if (!propEdges.length) return null;
    const compById = new Map(components.map((c) => [c.id, c]));
    const domainNameOf = (c) => {
      const did = (c.domainIds ?? [])[0];
      return did ? (domainById.get(did)?.name ?? null) : null;
    };

    const SOURCE_ORDER = ['forward', 'state', 'store', 'handler', 'computed', 'literal'];
    const sourceDist = {};
    let propTotal = 0;
    const edges = [];
    for (const e of propEdges) {
      const from = compById.get(e.fromComponentId);
      const to = compById.get(e.toComponentId);
      if (!from || !to) continue;
      for (const p of e.props) {
        if (p.source !== 'spread') sourceDist[p.source] = (sourceDist[p.source] ?? 0) + 1;
      }
      propTotal += e.props.length;
      edges.push({
        id: e.id,
        fromId: from.id,
        fromName: from.name,
        fromFile: from.filePath,
        fromDomain: domainNameOf(from),
        toId: to.id,
        toName: to.name,
        toFile: to.filePath,
        toDomain: domainNameOf(to),
        propCount: e.props.length,
        renderCount: e.renderCount ?? 1,
        props: e.props.map((p) => ({ name: p.name, source: p.source, valueText: p.valueText ?? null, storeHook: p.storeHook ?? null })),
      });
    }
    if (!edges.length) return null;
    edges.sort((a, b) => b.propCount - a.propCount || (a.fromName + '>' + a.toName).localeCompare(b.fromName + '>' + b.toName));

    // 参与边的组件及出入度
    const nodes = [];
    const nodeIdx = new Map();
    const touch = (comp, dir, propCount) => {
      let n = nodeIdx.get(comp.id);
      if (!n) {
        n = {
          id: comp.id, name: comp.name, file: comp.filePath, domain: domainNameOf(comp),
          kind: comp.kind ?? null, inCount: 0, outCount: 0, propInCount: 0, propOutCount: 0,
        };
        nodeIdx.set(comp.id, n);
        nodes.push(n);
      }
      if (dir === 'out') { n.outCount += 1; n.propOutCount += propCount; }
      else { n.inCount += 1; n.propInCount += propCount; }
    };
    for (const e of edges) {
      touch(compById.get(e.fromId), 'out', e.propCount);
      touch(compById.get(e.toId), 'in', e.propCount);
    }

    const topOut = nodes.slice().sort((a, b) => b.outCount - a.outCount || b.propOutCount - a.propOutCount).slice(0, 12);
    const topIn = nodes.slice().sort((a, b) => b.inCount - a.inCount || b.propInCount - a.propInCount).slice(0, 12);
    const domainOptions = [...new Set(nodes.map((n) => n.domain).filter(Boolean))]
      .map((name) => ({ name, count: nodes.filter((n) => n.domain === name).length }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    return {
      edgeCount: edges.length,
      nodeCount: nodes.length,
      propTotal,
      sourceDist,
      sourceOrder: SOURCE_ORDER.filter((k) => sourceDist[k]),
      spreadCount: propEdges.reduce((a, e) => a + e.props.filter((p) => p.source === 'spread').length, 0),
      topOut,
      topIn,
      domainOptions,
      edges,
      nodes,
    };
  })();

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
    scriptDomains,
    dataMap: dataMap2,
    scriptDataMap,
    logicFlow,
    scriptFlow,
    scriptBlueprint,
    entities,
    routeMap,
    propFlow,
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
  return { id: s.id, name: s.name, filePath: s.filePath, providerType: s.providerType ?? null, stateKeyCount: s.stateKeyCount ?? (s.stateKeys ?? []).length, hasPersist: !!s.hasPersist };
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
:root { --content-w: 1400px; }
/* 宽屏适配：内容宽度随视口分档扩展并居中，超宽屏不留大片右侧空白 */
@media (min-width: 1600px) { :root { --content-w: 1520px; } }
@media (min-width: 1920px) { :root { --content-w: 1840px; } }
@media (min-width: 2240px) { :root { --content-w: 2160px; } }
@media (min-width: 2560px) { :root { --content-w: 2400px; } }
header > * { max-width: var(--content-w); }
main { max-width: var(--content-w); }
h2 { font-size: 16px; margin-bottom: 12px; color: var(--fg); }
h3 { font-size: 14px; margin: 16px 0 8px; color: var(--fg); }
.tabs { flex-wrap: nowrap; }
.card.selected { border-color: var(--blue); box-shadow: 0 0 0 1px var(--blue); }
.card h4 { font-size: 14px; margin-bottom: 6px; }
.card .sum { color: var(--fg-dim); font-size: 12px; margin-bottom: 8px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; background: var(--panel2); border: 1px solid var(--border); color: var(--fg-dim); }
.chip.blue { color: var(--blue); border-color: color-mix(in srgb, var(--blue) 40%, transparent); }
.chip.green { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
.chip.amber { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 40%, transparent); }
.chip.purple { color: var(--purple); border-color: color-mix(in srgb, var(--purple) 40%, transparent); }
.chip.red { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); }
.chip.cyan { color: var(--cyan); border-color: color-mix(in srgb, var(--cyan) 40%, transparent); }
.chip.teal { color: var(--teal); border-color: color-mix(in srgb, var(--teal) 40%, transparent); }
.bar-wrap { background: var(--panel2); border-radius: 4px; height: 8px; overflow: hidden; min-width: 60px; }
.bar { height: 100%; border-radius: 4px; background: var(--blue); }
.bar.green { background: var(--green); }
.bar.amber { background: var(--amber); }
.bar.purple { background: var(--purple); }
.bar.cyan { background: var(--cyan); }
.bar.red { background: var(--red); }
.bar.teal { background: var(--teal); }
.bar.go { background: var(--go); }
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
.matrix td.heat span.hot { background: color-mix(in srgb, var(--blue) 25%, transparent); color: var(--fg); font-weight: 600; display: inline-block; min-width: 34px; border-radius: 4px; }
.matrix td.heat span.warm { background: color-mix(in srgb, var(--blue) 12%, transparent); color: var(--fg); display: inline-block; min-width: 34px; border-radius: 4px; }
.matrix td.heat span.cold { color: var(--fg-faint); }
.empty { color: var(--fg-faint); font-size: 13px; padding: 16px 0; }
.note { color: var(--fg-faint); font-size: 12px; margin-top: 8px; }
.split { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 1000px) { .split { grid-template-columns: 1fr; } }
.badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
.badge.ok { background: color-mix(in srgb, var(--green) 15%, transparent); color: var(--green); }
.badge.warn { background: color-mix(in srgb, var(--amber) 15%, transparent); color: var(--amber); }
.badge.bad { background: color-mix(in srgb, var(--red) 15%, transparent); color: var(--red); }
.back { margin-bottom: 12px; }
button.btn { background: var(--panel2); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
button.btn:hover { border-color: var(--blue); color: var(--blue); }
/* ---- 脚本蓝图：SVG 逻辑注入关系图 ---- */
.graph-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--panel2); padding: 8px; }
/* 图随容器宽度自适应缩放（viewBox 等比），宽屏完整呈现、窄屏不截断右缘 */
.graph-wrap svg { display: block; max-width: 100%; height: auto; }
svg .gn { cursor: pointer; }
svg .gn rect { fill: var(--panel); stroke-width: 1.5; transition: opacity .12s; }
svg .gn text { font-size: 11px; font-family: 'SF Mono', Menlo, monospace; }
svg .ge { stroke: color-mix(in srgb, var(--blue) 50%, transparent); stroke-width: 1.2; fill: none; transition: opacity .12s; }
svg .ge.inject { stroke: color-mix(in srgb, var(--cyan) 65%, transparent); stroke-dasharray: 5 3; }
svg .ge.net { stroke: color-mix(in srgb, var(--purple) 65%, transparent); stroke-dasharray: 2 3; }
svg.focus .gn, svg.focus .ge { opacity: .15; }
svg.focus .gn.hl, svg.focus .ge.hl { opacity: 1; }
svg .col-label { fill: var(--fg-faint); font-size: 11px; font-family: -apple-system, 'PingFang SC', sans-serif; }
.legend { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; align-items: center; }
.legend .dot { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 4px; vertical-align: -1px; }
.legend-dot { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.legend .line { display: inline-block; width: 18px; height: 0; border-top: 1.5px solid; margin-right: 4px; vertical-align: 3px; }
#script-fn-info { margin-top: 10px; min-height: 20px; }
#script-fn-info .name { font-family: 'SF Mono', Menlo, monospace; color: var(--blue); }
/* ---- 实体类图：UML 类框 + 关系边 ---- */
.uml-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--panel2); padding: 12px; }
.uml-wrap svg { display: block; max-width: 100%; height: auto; }
svg.uml rect.box { fill: var(--panel); stroke-width: 1.5; transition: opacity .12s; }
svg.uml rect.hdr { stroke: none; }
svg.uml text.uname { font-size: 12px; font-weight: 700; font-family: 'SF Mono', Menlo, monospace; fill: var(--fg); }
svg.uml text.uname.it { font-style: italic; }
svg.uml text.ustereo { font-size: 10px; font-family: 'SF Mono', Menlo, monospace; fill: var(--fg-faint); }
svg.uml text.umember { font-size: 10px; font-family: 'SF Mono', Menlo, monospace; fill: var(--fg-dim); }
svg.uml text.umore { font-size: 10px; fill: var(--fg-faint); }
svg.uml line.usep { stroke: var(--border); }
svg .ge.impl { stroke: color-mix(in srgb, var(--cyan) 65%, transparent); stroke-dasharray: 6 4; }
svg .ge.ext { stroke: color-mix(in srgb, var(--purple) 70%, transparent); }
svg .ge.rnd { stroke: color-mix(in srgb, var(--green) 75%, transparent); }
.filter-bar { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.filter-bar select, .filter-bar input { background: var(--panel2); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; }
.filter-bar input { width: 200px; }
#entity-info { margin-top: 10px; min-height: 20px; }
#entity-info .name { font-family: 'SF Mono', Menlo, monospace; color: var(--blue); }
/* ---- 路由地图：导航链 SVG + 路径层级树 ---- */
svg text.rpath { font-size: 12px; font-weight: 600; font-family: 'SF Mono', Menlo, monospace; fill: var(--fg); }
svg text.rmeta { font-size: 10px; font-family: -apple-system, 'PingFang SC', sans-serif; fill: var(--fg-dim); }
svg .gn rect.rbox { fill: var(--panel); }
#route-info { margin-top: 10px; min-height: 20px; }
#route-info .name { font-family: 'SF Mono', Menlo, monospace; color: var(--blue); }
#props-info { margin-top: 10px; min-height: 20px; }
#props-info .name { font-family: 'SF Mono', Menlo, monospace; color: var(--blue); }
ul.tree, ul.tree ul { list-style: none; }
ul.tree ul { padding-left: 18px; margin-left: 8px; border-left: 1px solid var(--border); }
ul.tree li { padding: 2px 0; font-size: 13px; }
ul.tree li .seg { font-family: 'SF Mono', Menlo, monospace; color: var(--fg); }
ul.tree li .seg.dyn { color: var(--amber); }
ul.tree li .cnt { color: var(--fg-faint); font-size: 11px; margin-left: 6px; }

/* 组件数据流（props 传递链） */
svg text.pe-label { font-size: 9px; fill: var(--fg-faint); font-family: 'SF Mono', Menlo, monospace; }
svg.focus text.pe-label { opacity: .15; }
svg.focus text.pe-label.hl { opacity: 1; fill: var(--fg); }
.prop-edge { padding: 6px 0; border-bottom: 1px dashed var(--border); }
.prop-edge:last-child { border-bottom: none; }
.prop-item { display: inline-block; margin: 2px 6px 2px 0; font-family: 'SF Mono', Menlo, monospace; font-size: 11px; }
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
    <div class="tab" data-tab="routemap">路由地图</div>
    <div class="tab" data-tab="props">组件数据流</div>
    <div class="tab" data-tab="entities">实体类图</div>
    <div class="tab" data-tab="scripts">脚本蓝图</div>
  </nav>
</header>
<main>
  <section class="view active" id="view-overview"></section>
  <section class="view" id="view-blueprint"></section>
  <section class="view" id="view-data"></section>
  <section class="view" id="view-flow"></section>
  <section class="view" id="view-routemap"></section>
  <section class="view" id="view-props"></section>
  <section class="view" id="view-entities"></section>
  <section class="view" id="view-scripts"></section>
</main>
<script id="viewer-data" type="application/json">${dataJson}</script>
<script>
const M = JSON.parse(document.getElementById('viewer-data').textContent);
const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmt = (n) => (n ?? 0).toLocaleString('zh-CN');
const fmtLocalTime = (iso) => {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return String(iso || '').replace('T', ' ').slice(0, 19);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
};

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
let selectedScriptDomain = null;
function renderBlueprint() {
  const el = document.getElementById('view-blueprint');
  // 油猴意图适配：无目录级功能域时渲染脚本意图功能域（按函数角色分组）
  if (!M.domains.length && M.scriptDomains) return renderScriptDomainList(el);
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
      (s) => '<li><b>' + esc(s.name) + '</b> ' + (s.providerType ? chip(s.providerType, 'blue') : '') + chip((s.stateKeyCount || 0) + ' state', 'green') + (s.hasPersist ? chip('persist', 'amber') : '') + ' <span class="path">' + esc(s.filePath) + '</span></li>')
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

// ---------- Tab 2 适配：脚本意图功能域（函数意图分组，替代目录级功能域）----------
function renderScriptDomainList(el) {
  const sd = M.scriptDomains;
  const cards = sd.domains.map((d, i) =>
    '<div class="card" data-idx="' + i + '"><h4><span class="legend-dot" style="background:' + d.color + '"></span>' + esc(d.name) + '</h4>'
    + '<div class="sum">' + esc(d.description || '') + '</div>'
    + '<div class="chips">'
    + chip(d.functionCount + ' 函数', 'blue')
    + (d.injectionCount ? chip(d.injectionCount + ' DOM 注入', 'purple') : '')
    + (d.networkCount ? chip(d.networkCount + ' 网络调用', 'red') : '')
    + (d.listenerCount ? chip(d.listenerCount + ' 监听/定时', 'amber') : '')
    + (d.gmApiCount ? chip(d.gmApiCount + ' GM API', 'green') : '')
    + '</div></div>').join('');
  el.innerHTML =
    '<div class="panel"><h2>脚本意图功能域（' + sd.domains.length + ' 个意图分组，点击下钻）</h2>'
    + '<div class="grid">' + cards + '</div>'
    + '<div class="note">单文件脚本无目录级功能域，按函数意图（渲染注入 / 数据获取 / 状态存取 / 事件监听 / 元素构建 / 纯逻辑）聚合为虚拟功能域；仅单一意图的功能增强脚本不生成本视图。</div></div>'
    + '<div id="script-domain-detail"></div>';
  el.querySelectorAll('.card').forEach((c) => c.addEventListener('click', () => {
    el.querySelectorAll('.card').forEach((x) => x.classList.remove('selected'));
    c.classList.add('selected');
    selectedScriptDomain = sd.domains[Number(c.dataset.idx)];
    renderScriptDomainDetail();
  }));
}
function renderScriptDomainDetail() {
  const d = selectedScriptDomain;
  const box = document.getElementById('script-domain-detail');
  if (!d) { box.innerHTML = ''; return; }
  box.innerHTML =
    '<div class="panel"><div class="back"><button class="btn" id="btn-sdback">← 收起</button></div>'
    + '<h2><span class="legend-dot" style="background:' + d.color + '"></span>意图功能域：' + esc(d.name) + '</h2>'
    + '<div class="sub">' + esc(d.description || '') + '</div>'
    + '<div class="chips" style="margin:10px 0">'
    + chip(d.functionCount + ' 函数', 'blue')
    + (d.injectionCount ? chip(d.injectionCount + ' DOM 注入', 'purple') : '')
    + (d.networkCount ? chip(d.networkCount + ' 网络调用', 'red') : '')
    + (d.listenerCount ? chip(d.listenerCount + ' 监听/定时', 'amber') : '')
    + (d.gmApiCount ? chip(d.gmApiCount + ' GM API', 'green') : '')
    + (d.scriptNames || []).map((n) => chip(n, 'cyan')).join('')
    + '</div>'
    + '<h3>函数清单（按重要性 Top ' + d.functions.length + ' / ' + d.functionCount + '）</h3>'
    + table(
      [{ label: '函数' }, { label: '角色' }, { label: '行', num: true }, { label: '被调', num: true }, { label: '调出', num: true }, { label: 'DOM 注入', num: true }, { label: '网络', num: true }],
      d.functions.map((f) => [
        { v: f.name, html: '<b>' + esc(f.name) + '</b> <span class="path">L' + (f.line ?? '-') + '</span>' },
        { v: (f.roles || []).join('/'), html: (f.roles || []).map((r) => '<span class="chip" style="color:' + roleColor([r]) + ';border-color:' + roleColor([r]) + '55">' + esc(roleLabel(r)) + '</span>').join('') },
        { v: f.lineCount ?? '-', num: true },
        { v: f.calledByCount, num: true },
        { v: f.callCount, num: true },
        { v: f.domInjectionCount || '-', num: true },
        { v: f.networkCallCount || '-', num: true },
      ]))
    + '</div>';
  box.querySelector('#btn-sdback').addEventListener('click', () => {
    selectedScriptDomain = null;
    document.getElementById('view-blueprint').querySelectorAll('.card').forEach((x) => x.classList.remove('selected'));
    box.innerHTML = '';
  });
}

// ---------- Tab 3: 业务数据图 ----------
function renderData() {
  const el = document.getElementById('view-data');
  const d = M.dataMap;
  if (!d.stores.length) {
    // 油猴意图适配：无 Zustand/Pinia Store 时渲染脚本存储枢纽
    if (M.scriptDataMap) return renderScriptDataMap(el);
    el.innerHTML = '<div class="panel"><h2>业务数据图</h2><div class="empty">未检测到状态管理（Zustand / Pinia），也无脚本持久化信号——本仓库无业务数据图。</div></div>';
    return;
  }
  const storeCards = d.stores.map((s) =>
    '<div class="card" style="cursor:default"><h4>' + esc(s.name) + '</h4>'
    + '<div class="chips" style="margin:6px 0">'
    + (s.providerType ? chip(s.providerType, 'purple') : '')
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

// ---------- Tab 3 适配：脚本存储枢纽（localStorage / GM 存储 / 宿主数据读取）----------
function renderScriptDataMap(el) {
  const sd = M.scriptDataMap;
  const hubCards = sd.hubs.map((h) =>
    '<div class="card" style="cursor:default"><h4>' + esc(h.name) + (h.version ? ' <span class="sub">v' + esc(h.version) + '</span>' : '') + '</h4>'
    + '<div class="chips" style="margin:6px 0">'
    + (h.storageUsage.localStorage ? chip('localStorage × ' + h.storageUsage.localStorage, 'green') : '')
    + (h.storageUsage.sessionStorage ? chip('sessionStorage × ' + h.storageUsage.sessionStorage, 'cyan') : '')
    + (h.storageUsage.indexedDB ? chip('indexedDB × ' + h.storageUsage.indexedDB, 'purple') : '')
    + h.gmStorageApis.map((g) => chip(g.name + ' × ' + g.callCount, 'amber')).join('')
    + '</div>'
    + (h.unsafeWindowReads.length ? '<div class="sum">宿主数据读取：' + h.unsafeWindowReads.map((r) => '<span class="path">' + esc(typeof r === 'string' ? r : (r.prop || '')) + '</span>').join(' · ') + '</div>' : '')
    + (h.stateFunctions.length ? '<details open><summary>状态存取函数（' + h.stateFunctions.length + '）</summary><ul class="plain">'
      + h.stateFunctions.map((f) => '<li><b>' + esc(f.name) + '</b>'
        + (f.gmApiCalls.length ? ' ' + f.gmApiCalls.map((g) => chip(g, 'amber')).join('') : '')
        + ' <span class="path">L' + (f.line ?? '-') + '</span></li>').join('')
      + '</ul></details>' : '')
    + '<div class="sub"><span class="path">' + esc(h.filePath) + '</span></div></div>').join('');

  const hasHostReads = sd.hubs.some((h) => h.unsafeWindowReads.length);
  el.innerHTML =
    '<div class="panel"><h2>脚本存储枢纽（' + sd.hubs.length + ' 个脚本有持久化信号）</h2>'
    + '<div class="grid">' + hubCards + '</div>'
    + '<div class="note">脚本无集中式状态 Store，以浏览器存储（localStorage / sessionStorage / indexedDB）与 GM 存储 API 为数据枢纽；状态存取函数为读写这些存储的入口。'
    + (hasHostReads ? '宿主数据读取 = 脚本从页面全局变量（unsafeWindow）获取的数据。' : '') + '</div></div>';
}

// ---------- Tab 4: 业务逻辑流向 ----------
function renderFlow() {
  const el = document.getElementById('view-flow');
  const f = M.logicFlow;

  // 油猴意图适配：无模块导入（单文件）时渲染函数意图流转矩阵
  if (!f.layerFlow.length && M.scriptFlow) return renderScriptFlow(el);

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

// ---------- Tab 4 适配：函数意图流转矩阵（调用边按意图聚合）+ 高扇入函数 ----------
function renderScriptFlow(el) {
  const sf = M.scriptFlow;
  const roles = [];
  const flowIdx = new Map();
  for (const e of sf.flows) {
    for (const k of [e.from, e.to]) if (!roles.includes(k)) roles.push(k);
    flowIdx.set(e.from + '>' + e.to, e.count);
  }
  roles.sort((a, b) => ROLE_FLOW_ORDER.indexOf(a) - ROLE_FLOW_ORDER.indexOf(b));
  const maxCell = Math.max(1, ...sf.flows.map((e) => e.count));
  const roleChip = (r) => '<span class="chip" style="color:' + roleColor([r]) + ';border-color:' + roleColor([r]) + '55">' + esc(roleLabel(r)) + '</span>';
  const matrixRows = roles.map((from) => [
    { v: from, html: roleChip(from) },
    ...roles.map((to) => {
      const c = flowIdx.get(from + '>' + to) ?? 0;
      const cls = c === 0 ? 'cold' : (c / maxCell > 0.4 ? 'hot' : 'warm');
      return { v: c || '·', html: '<span class="' + cls + '">' + (c || '·') + '</span>' };
    }),
  ]);

  const hubRows = sf.hubs.map((h) => [
    { v: h.name, html: '<b>' + esc(h.name) + '</b>' },
    { v: (h.roles || []).map(roleLabel).join('/'), html: (h.roles || []).map((r) => roleChip(r)).join('') },
    { v: h.calledByCount, num: true },
    { v: h.callCount, num: true },
    { v: h.scriptName || '-', html: h.scriptName ? chip(h.scriptName, 'cyan') : '-' },
  ]);

  el.innerHTML =
    '<div class="panel"><h2>函数意图流转（' + fmt(sf.flowTotal) + ' 条调用边 · 跨意图 ' + sf.crossRoleEdges + ' 条）</h2>'
    + '<table class="matrix"><thead><tr><th>from ↓ / to →</th>'
    + roles.map((r) => '<th>' + roleChip(r) + '</th>').join('')
    + '</tr></thead><tbody>' + matrixRows.map((r) => '<tr>' + r.map((c) => '<td class="heat">' + (c.html || esc(c.v)) + '</td>').join('') + '</tr>').join('')
    + '</tbody></table>'
    + '<div class="note">单文件脚本无模块导入，以函数调用边按意图聚合：行 = 调用方意图，列 = 被调方意图。典型业务流转为 事件监听 → 纯逻辑 → 数据获取/状态存取 → 渲染注入；对角线为同意图内部互调（内聚）。</div></div>'

    + '<div class="panel"><h2>高扇入函数（变更影响面 Top ' + sf.hubs.length + '）</h2>'
    + (hubRows.length ? table([{ label: '函数' }, { label: '意图' }, { label: '被调数', num: true }, { label: '调出数', num: true }, { label: '所属脚本' }], hubRows)
      : '<div class="empty">无高扇入函数。</div>')
    + '<div class="note">被调数最多的函数改动影响面最大——修改前优先检查其调用方。</div></div>';
}

// ---------- Tab 4.5: 路由地图（路由总览 / 导航链 SVG / 路径层级树 / 域分组 / 全量清单）----------
const ROUTE_TYPE_META = {
  overlay: { label: 'overlay', color: '#bc8cff' },
  react: { label: 'react-router', color: '#58a6ff' },
  vue: { label: 'vue-router', color: '#3fb950' },
  flutter: { label: 'Flutter', color: '#00b4ab' },
  next: { label: 'Next 页面', color: '#d29922' },
  'next-api': { label: 'Next API', color: '#f85149' },
  go: { label: 'Go HTTP', color: '#00add8' },
  'go-cli': { label: 'Go CLI', color: '#008b8b' },
};
const routeTypeMeta = (t) => ROUTE_TYPE_META[t] ?? { label: t || 'route', color: '#8b949e' };
const routeTypeChip = (t) => {
  const m = routeTypeMeta(t);
  return '<span class="chip" style="color:' + m.color + ';border-color:' + m.color + '55">' + esc(m.label) + '</span>';
};

function buildRouteGraphSvg(rm) {
  const ROUTE_NODE_CAP = 60;
  const out = {}, inn = {};
  rm.navEdges.forEach((e) => { out[e.from] = (out[e.from] || 0) + 1; inn[e.to] = (inn[e.to] || 0) + 1; });
  let nodes = rm.items.slice();
  if (nodes.length > ROUTE_NODE_CAP) {
    nodes.sort((a, b) => ((out[b.id] || 0) + (inn[b.id] || 0)) - ((out[a.id] || 0) + (inn[a.id] || 0))
      || a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
    nodes = nodes.slice(0, ROUTE_NODE_CAP);
  }
  const nodeSet = {};
  nodes.forEach((n) => { nodeSet[n.id] = 1; });
  const edges = rm.navEdges.filter((e) => nodeSet[e.from] && nodeSet[e.to]);

  // BFS 分层：入度 0 的路由为第 0 层入口，沿导航边取最短跳数；未被覆盖的（环内/被截断）沉到最后一列
  const adj = {};
  edges.forEach((e) => { (adj[e.from] = adj[e.from] || []).push(e.to); });
  const level = {};
  const q = [];
  nodes.forEach((n) => { if (!inn[n.id]) { level[n.id] = 0; q.push(n.id); } });
  while (q.length) {
    const cur = q.shift();
    (adj[cur] || []).forEach((to) => {
      if (level[to] === undefined || level[to] > level[cur] + 1) { level[to] = level[cur] + 1; q.push(to); }
    });
  }
  let maxLv = 0;
  Object.keys(level).forEach((k) => { if (level[k] > maxLv) maxLv = level[k]; });
  nodes.forEach((n) => { if (level[n.id] === undefined) level[n.id] = maxLv + 1; });
  maxLv = Math.max.apply(null, nodes.map((n) => level[n.id]));

  const COL = 300, ROW = 58, W = 244, H = 46, PADX = 24, PADY = 34;
  const cols = [];
  nodes.forEach((n) => { const lv = level[n.id]; (cols[lv] = cols[lv] || []).push(n); });
  cols.forEach((c) => c.sort((a, b) => a.path.localeCompare(b.path)));
  const pos = {};
  let maxRows = 1;
  cols.forEach((c, lv) => {
    c.forEach((n, i) => { pos[n.id] = { x: PADX + lv * COL, y: PADY + i * ROW }; });
    if (c.length > maxRows) maxRows = c.length;
  });
  const svgW = PADX * 2 + maxLv * COL + W;
  const svgH = PADY * 2 + Math.max(1, maxRows - 1) * ROW + H;

  let s = '<svg width="' + svgW + '" height="' + svgH + '" viewBox="0 0 ' + svgW + ' ' + svgH + '">';
  s += '<defs><marker id="rarr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#8b949e"/></marker></defs>';
  s += '<text class="col-label" x="' + PADX + '" y="16">入口</text>';
  for (let lv = 1; lv <= maxLv; lv += 1) s += '<text class="col-label" x="' + (PADX + lv * COL) + '" y="16">' + lv + ' 跳</text>';
  edges.forEach((e) => {
    const a = pos[e.from]; const b = pos[e.to];
    if (!a || !b) return;
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
    let d;
    if (b.x > a.x + 20) {
      const mx = (x1 + x2) / 2;
      d = 'M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ',' + mx + ' ' + y2 + ',' + (x2 - 3) + ' ' + y2;
    } else {
      const cy = Math.min(y1, y2) - 24;
      d = 'M' + x1 + ' ' + y1 + ' C' + (x1 + 56) + ' ' + cy + ',' + (x2 - 56) + ' ' + cy + ',' + x2 + ' ' + y2;
    }
    s += '<path class="ge" data-e="' + esc(e.from) + '§' + esc(e.to) + '" d="' + d + '" marker-end="url(#rarr)"/>';
  });
  nodes.forEach((n) => {
    const p = pos[n.id]; const m = routeTypeMeta(n.routeType);
    const label = n.path.length > 30 ? n.path.slice(0, 29) + '…' : n.path;
    let meta = m.label + (n.componentRef ? ' · ' + n.componentRef : '') + (n.isDynamic ? ' · 动态' : '');
    if (meta.length > 38) meta = meta.slice(0, 37) + '…';
    s += '<g class="gn" data-n="' + esc(n.id) + '">'
      + '<rect class="rbox" x="' + p.x + '" y="' + p.y + '" width="' + W + '" height="' + H + '" rx="6" stroke="' + m.color + '"' + (!inn[n.id] ? ' stroke-width="2.5"' : '') + '/>'
      + '<text class="rpath" x="' + (p.x + 10) + '" y="' + (p.y + 19) + '">' + esc(label) + '</text>'
      + '<text class="rmeta" x="' + (p.x + 10) + '" y="' + (p.y + 35) + '">' + esc(meta) + '</text>'
      + '<title>' + esc(n.path + ' · ' + m.label + (n.componentFile ? ' · ' + n.componentFile : '')) + '</title>'
      + '</g>';
  });
  s += '</svg>';
  return s;
}

function bindRouteGraphEvents(svgEl) {
  if (!svgEl) return;
  const info = document.getElementById('route-info');
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
      const it = M.routeMap.items.find((x) => x.id === g.dataset.n);
      if (!it) return;
      info.innerHTML = '<b class="name">' + esc(it.path) + '</b> ' + routeTypeChip(it.routeType)
        + (it.domain ? chip(it.domain, 'blue') : '')
        + (it.isDynamic ? chip('动态段', 'amber') : '')
        + (it.isClient === true ? chip('use client', 'cyan') : (it.isClient === false ? chip('server', '') : ''))
        + (it.apiMethods && it.apiMethods.length ? chip('API ' + it.apiMethods.join('/'), 'red') : '')
        + (it.frontendCallCount ? chip('前端调用 ' + it.frontendCallCount, 'cyan') : '')
        + (it.flags?.length ? chip('flags ' + it.flags.length, 'purple') : '')
        + (it.layoutCount ? chip(it.layoutCount + ' 层 layout', 'purple') : '')
        + (it.factoryPropsCount ? chip('工厂注入 ' + it.factoryPropsCount + ' props', 'green') : '')
        + (it.description ? '<div class="sub">' + esc(it.description) + '</div>' : '')
        + (it.componentRef ? '<span class="sub"> ' + (it.routeType === 'go' ? 'handler' : (it.routeType === 'go-cli' ? '命令变量' : '组件')) + ' ' + esc(it.componentRef) + (it.componentFile ? '（' + esc(it.componentFile) + '）' : '') + '</span>' : '')
        + (it.middlewares?.length ? '<div class="sub">中间件：' + esc(it.middlewares.join(' → ')) + '</div>' : '')
        + (it.flags?.length ? '<div class="sub">flags：' + esc(it.flags.join('、')) + '</div>' : '')
        + (it.factoryProps?.length ? '<div class="sub">工厂 props：' + esc(it.factoryProps.join('、')) + '</div>' : '')
        + (it.frontendCalls?.length ? '<div class="sub">前端调用：' + it.frontendCalls.map((c) => esc((c.method ? c.method + ' ' : '') + c.filePath + (c.line ? ':' + c.line : ''))).join('、') + (it.frontendCallCount > it.frontendCalls.length ? ' 等 ' + it.frontendCallCount + ' 处' : '') + '</div>' : '')
        + '<div class="sub">导航 → ' + (it.navToPaths.length ? it.navToPaths.map(esc).join('、') : '（无）') + '</div>';
    });
  });
}

function renderRouteMap() {
  const el = document.getElementById('view-routemap');
  const rm = M.routeMap;

  // 反向索引：路由 ← 被哪些路由导航
  const navBy = {};
  rm.navEdges.forEach((e) => { (navBy[e.to] = navBy[e.to] || []).push(e.fromPath); });

  const TYPE_CLS = { overlay: 'purple', react: 'blue', vue: 'green', flutter: 'teal', next: 'amber', 'next-api': 'red', go: 'teal', 'go-cli': 'purple' };
  const maxType = Math.max(1, ...rm.byType.map((t) => t.count));
  const typeRows = rm.byType.map((t) => barRow(routeTypeMeta(t.key).label, t.count, maxType, TYPE_CLS[t.key]));
  const kv = (v, k) => '<div class="item"><div class="v">' + fmt(v) + '</div><div class="k">' + k + '</div></div>';

  // 路径层级树（递归缩进；段名 + 类型徽标 + 主组件名）
  const treeHtml = (node) => node.children.map((c) => '<li><span class="seg' + (c.seg.startsWith(':') ? ' dyn' : '') + '">' + esc(c.seg) + '</span>'
    + c.routes.map((r) => routeTypeChip(r.routeType)).join('')
    + (c.routes.length && c.routes.some((r) => r.componentRef) ? '<span class="cnt">' + esc(c.routes.map((r) => r.componentRef).filter(Boolean).join(' / ')) + '</span>' : '')
    + (c.children.length ? '<ul>' + treeHtml(c) + '</ul>' : '')
    + '</li>').join('');
  const treeFull = '<ul class="tree"><li><span class="seg">/</span>' + rm.tree.routes.map((r) => routeTypeChip(r.routeType)).join('')
    + (rm.tree.children.length ? '<ul>' + treeHtml(rm.tree) + '</ul>' : '') + '</li></ul>';

  // 域分组（每组路由清单 + 导航去向）
  const groupHtml = rm.domainGroups.slice(0, 12).map((g) => {
    const lis = g.routes.slice(0, 40).map((r) => '<li><b>' + esc(r.path) + '</b> ' + routeTypeChip(r.routeType)
      + (r.apiMethods?.length ? ' ' + chip(r.apiMethods.join('/'), 'red') : '')
      + (r.frontendCallCount ? ' ' + chip('前端 ' + r.frontendCallCount, 'cyan') : '')
      + (r.factoryPropsCount ? ' ' + chip('工厂 ' + r.factoryPropsCount + ' props', 'green') : '')
      + (r.componentRef ? ' <span class="path">' + esc(r.componentRef) + '</span>' : '')
      + (r.navToPaths.length ? '<span class="cnt">→ ' + r.navToPaths.map(esc).join('、') + '</span>' : '')
      + '</li>').join('');
    return '<div><h3>' + esc(g.name) + ' <span class="sub">' + g.routes.length + ' 条</span></h3><ul class="plain">' + lis + '</ul></div>';
  }).join('');

  // 前后端映射：未匹配的前端调用（可能是死接口 / 路径漂移 / 其他后端）
  const unmatchedHtml = rm.unmatchedFrontendCalls?.length
    ? '<details class="panel"><summary>未匹配的前端调用（' + rm.unmatchedFrontendCalls.length + ' 处'
      + (rm.frontendCallTotal ? '，已匹配 ' + rm.frontendCallTotal + ' 处' : '') + '）</summary>'
      + '<div class="note">前端发起但未在 Go 路由中找到对应路径的调用：可能是死接口、路径漂移，或由其他后端（Java/Node 等）承接。</div>'
      + '<ul class="plain">' + rm.unmatchedFrontendCalls.slice(0, 30).map((c) => '<li>'
        + chip(c.method || '?', 'red') + ' <b>' + esc(c.path || '') + '</b>'
        + ' <span class="path">' + esc(c.filePath) + (c.line ? ':' + c.line : '') + '</span></li>').join('')
      + '</ul></details>'
    : '';

  // 全量清单表
  const hasGoRoutes = rm.goApiRouteCount > 0;
  const tableRows = rm.items.slice(0, 150).map((r) => [
    { v: r.path, html: '<b>' + esc(r.path) + '</b>' + (r.isDynamic ? ' ' + chip('动态', 'amber') : '') },
    { v: r.routeType, html: routeTypeChip(r.routeType) },
    { v: r.domain ?? '-', html: r.domain ? chip(r.domain, 'blue') : '-' },
    { v: r.apiMethods?.join('/') ?? '-', html: r.apiMethods?.length ? chip(r.apiMethods.join('/'), 'red') : '-' },
    { v: r.componentRef ?? '-', html: r.componentRef ? esc(r.componentRef) : '-' },
    ...(hasGoRoutes ? [{ v: r.frontendCallCount ? String(r.frontendCallCount) : '-', html: r.frontendCallCount ? chip('前端 ' + r.frontendCallCount, 'cyan') : '-' }] : []),
    { v: r.navToPaths.join('、'), html: r.navToPaths.length ? esc(r.navToPaths.join('、')) : '·' },
    { v: (navBy[r.id] || []).join('、'), html: (navBy[r.id] || []).length ? esc(navBy[r.id].join('、')) : '·' },
  ]);

  el.innerHTML =
    '<div class="panel"><h2>路由总览（' + fmt(rm.totalCount) + ' 条路由 · ' + rm.maxDepth + ' 级路径深度 · ' + rm.domainGroups.length + ' 个域分组）</h2>'
    + '<div class="kv">' + kv(rm.totalCount, '路由') + kv(rm.navEdgeCount, '导航边') + kv(rm.entryCount, '入口路由')
    + kv(rm.orphanCount, '孤岛路由') + (rm.dynamicCount ? kv(rm.dynamicCount, '动态路由') : '')
    + (rm.apiRouteCount ? kv(rm.apiRouteCount, 'API 路由') : '')
    + (rm.goApiRouteCount ? kv(rm.goApiRouteCount, 'Go HTTP 路由') : '')
    + (rm.goCliRouteCount ? kv(rm.goCliRouteCount, 'Go CLI 命令') : '')
    + (rm.frontendCallTotal ? kv(rm.frontendCallTotal, '前端调用已匹配') : '') + '</div>'
    + '<h3>路由类型分布</h3>' + typeRows.join('')
    + '<div class="note">入口路由 = 无任何路由导航指向它（通常为应用首屏 / 登录页）；孤岛路由 = 无进出导航边（深链入口或仅被外部直达）。'
    + (rm.goApiRouteCount ? 'Go HTTP 路由 = Gin / 标准库注册的后端接口；前端调用 = 前端代码中 API.get / axios.x / fetch 与该路径的匹配次数。' : '')
    + (rm.goCliRouteCount ? 'Go CLI 命令 = cobra 命令树（路径层级树按命令段展示，flags 见详情）。' : '') + '</div></div>'

    + '<div class="panel"><h2>路由导航链（' + rm.navEdgeCount + ' 条导航边 · 悬停高亮相邻路由，点击查看详情）</h2>'
    + '<div class="graph-wrap">' + buildRouteGraphSvg(rm) + '</div>'
    + '<div class="legend">' + rm.byType.map((t) => {
      const m = routeTypeMeta(t.key);
      return '<span class="legend-dot" style="background:' + m.color + '"></span>' + esc(m.label);
    }).join('') + '</div>'
    + '<div id="route-info"></div>'
    + '<div class="note">节点从左到右按导航跳数分层（入口 → 1 跳 → 2 跳…），边框加粗 = 入口路由；边 = 源路由页面内的导航调用（Link / pushNamed / go 等）。超过 ' + 60 + ' 条路由时按导航活跃度截断。</div></div>'

    + '<div class="split">'
    + '<div class="panel"><h2>路径层级树（' + rm.maxDepth + ' 级' + (rm.goCliRouteCount ? ' · CLI 命令按段嵌套' : '') + '）</h2>' + treeFull + '</div>'
    + '<div class="panel"><h2>域分组（' + rm.domainGroups.length + ' 组）</h2>' + groupHtml + '</div>'
    + '</div>'

    + unmatchedHtml

    + '<details class="panel"><summary>全量路由清单（' + rm.items.length + ' 条' + (rm.items.length > 150 ? '，表内截断至 150' : '') + '）</summary>'
    + table(hasGoRoutes
      ? [{ label: '路径' }, { label: '类型' }, { label: '域' }, { label: '方法' }, { label: '组件/handler' }, { label: '前端调用' }, { label: '导航去向' }, { label: '被导航' }]
      : [{ label: '路径' }, { label: '类型' }, { label: '域' }, { label: '方法' }, { label: '组件' }, { label: '导航去向' }, { label: '被导航' }], tableRows)
    + '</details>';

  bindRouteGraphEvents(el.querySelector?.('.graph-wrap svg'));
}

// ---------- Tab: 组件数据流（React Props 传递链）----------
const PROP_SOURCE_META = {
  forward: { label: '转发', cls: 'blue', desc: '父组件 props 原样转发' },
  state: { label: '本地状态', cls: 'amber', desc: 'useState 声明的组件内状态' },
  store: { label: '状态库', cls: 'green', desc: 'useXxxStore / useQuery 等外部数据源' },
  handler: { label: '回调', cls: 'purple', desc: '内联函数或本地函数引用' },
  computed: { label: '计算值', cls: 'cyan', desc: '成员访问 / 调用结果 / 表达式计算' },
  literal: { label: '字面量', cls: '', desc: '字符串 / 数字 / 布尔常量' },
  spread: { label: '展开', cls: 'red', desc: '{...obj} 整体透传（不展开成员）' },
};
const propSourceChip = (s) => {
  const m = PROP_SOURCE_META[s] ?? { label: s || '?', cls: '' };
  return '<span class="chip ' + (m.cls || '') + '">' + esc(m.label) + '</span>';
};

const PROP_DOMAIN_PALETTE = ['#58a6ff', '#bc8cff', '#3fb950', '#d29922', '#39c5cf', '#f85149', '#7ee787', '#ffa657', '#d2a8ff', '#79c0ff'];
const propDomainColor = (name) => {
  if (!name || !M.propFlow) return '#8b949e';
  const idx = M.propFlow.domainOptions.findIndex((d) => d.name === name);
  return idx >= 0 ? PROP_DOMAIN_PALETTE[idx % PROP_DOMAIN_PALETTE.length] : '#8b949e';
};

const PROP_NODE_CAP = 80;
function buildPropFlowSvg(nodes, edges) {
  // BFS 分层：入度 0（无父组件传 props）为第 0 层顶层容器；环内 / 被截断节点沉到最后一列
  const adj = {};
  const inn = {};
  edges.forEach((e) => {
    (adj[e.fromId] = adj[e.fromId] || []).push(e.toId);
    inn[e.toId] = (inn[e.toId] || 0) + 1;
  });
  const level = {};
  const q = [];
  nodes.forEach((n) => { if (!inn[n.id]) { level[n.id] = 0; q.push(n.id); } });
  while (q.length) {
    const cur = q.shift();
    (adj[cur] || []).forEach((to) => {
      if (level[to] === undefined || level[to] > level[cur] + 1) { level[to] = level[cur] + 1; q.push(to); }
    });
  }
  let maxLv = 0;
  Object.keys(level).forEach((k) => { if (level[k] > maxLv) maxLv = level[k]; });
  nodes.forEach((n) => { if (level[n.id] === undefined) level[n.id] = maxLv + 1; });
  maxLv = Math.max.apply(null, nodes.map((n) => level[n.id]));

  const COL = 260, ROW = 54, W = 208, H = 42, PADX = 24, PADY = 34;
  const cols = [];
  nodes.forEach((n) => { const lv = level[n.id]; (cols[lv] = cols[lv] || []).push(n); });
  cols.forEach((c) => c.sort((a, b) => a.name.localeCompare(b.name)));
  const pos = {};
  let maxRows = 1;
  cols.forEach((c, lv) => {
    c.forEach((n, i) => { pos[n.id] = { x: PADX + lv * COL, y: PADY + i * ROW }; });
    if (c.length > maxRows) maxRows = c.length;
  });
  const svgW = PADX * 2 + maxLv * COL + W;
  const svgH = PADY * 2 + Math.max(1, maxRows - 1) * ROW + H;

  let s = '<svg width="' + svgW + '" height="' + svgH + '" viewBox="0 0 ' + svgW + ' ' + svgH + '">';
  s += '<defs><marker id="parr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#8b949e"/></marker></defs>';
  s += '<text class="col-label" x="' + PADX + '" y="16">顶层</text>';
  for (let lv = 1; lv <= maxLv; lv += 1) s += '<text class="col-label" x="' + (PADX + lv * COL) + '" y="16">' + lv + ' 层</text>';
  edges.forEach((e) => {
    const a = pos[e.fromId]; const b = pos[e.toId];
    if (!a || !b) return;
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
    let c1x, c1y, c2x, c2y;
    if (b.x > a.x + 20) {
      const mx = (x1 + x2) / 2;
      c1x = mx; c1y = y1; c2x = mx; c2y = y2;
    } else {
      const cy = Math.min(y1, y2) - 24;
      c1x = x1 + 56; c1y = cy; c2x = x2 - 56; c2y = cy;
    }
    s += '<path class="ge" data-e="' + esc(e.fromId) + '§' + esc(e.toId) + '" d="M' + x1 + ' ' + y1 + ' C' + c1x + ' ' + c1y + ',' + c2x + ' ' + c2y + ',' + (x2 - 3) + ' ' + y2 + '" marker-end="url(#parr)"/>';
    // 边中点标签 = props 数（三次贝塞尔中点 = (P0 + 3C1 + 3C2 + P3) / 8）
    const lx = (x1 + 3 * c1x + 3 * c2x + x2) / 8;
    const ly = (y1 + 3 * c1y + 3 * c2y + y2) / 8;
    s += '<text class="pe-label" data-e="' + esc(e.fromId) + '§' + esc(e.toId) + '" x="' + lx + '" y="' + (ly - 3) + '" text-anchor="middle">' + e.propCount + '</text>';
  });
  nodes.forEach((n) => {
    const p = pos[n.id];
    const color = propDomainColor(n.domain);
    const label = n.name.length > 24 ? n.name.slice(0, 23) + '…' : n.name;
    const meta = (n.domain || '无域') + ' · 出' + n.outCount + ' / 入' + n.inCount;
    s += '<g class="gn" data-n="' + esc(n.id) + '">'
      + '<rect class="rbox" x="' + p.x + '" y="' + p.y + '" width="' + W + '" height="' + H + '" rx="6" stroke="' + color + '"'
      + (n.inCount === 0 ? ' stroke-width="2.5"' : '') + '/>'
      + '<text class="rpath" x="' + (p.x + 10) + '" y="' + (p.y + 18) + '">' + esc(label) + '</text>'
      + '<text class="rmeta" x="' + (p.x + 10) + '" y="' + (p.y + 33) + '">' + esc(meta) + '</text>'
      + '<title>' + esc(n.name + ' · ' + n.file) + '</title>'
      + '</g>';
  });
  s += '</svg>';
  return s;
}

let PROP_NODES_BY_ID = {};
function bindPropFlowEvents(svgEl) {
  if (!svgEl) return;
  const info = document.getElementById('props-info');
  svgEl.querySelectorAll('.gn').forEach((g) => {
    g.addEventListener('mouseenter', () => {
      svgEl.classList.add('focus');
      const n = g.dataset.n;
      const related = {};
      related[n] = 1;
      svgEl.querySelectorAll('.ge, .pe-label').forEach((e) => {
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
      const node = PROP_NODES_BY_ID[g.dataset.n];
      if (!node) return;
      const pf = M.propFlow;
      const outEdges = pf.edges.filter((e) => e.fromId === node.id);
      const inEdges = pf.edges.filter((e) => e.toId === node.id);
      const propChips = (props) => props.slice(0, 8).map((p) =>
        '<span class="prop-item">' + esc(p.name) + ' ' + propSourceChip(p.source)
        + (p.storeHook ? '<span class="sub"> ← ' + esc(p.storeHook) + '</span>' : '')
        + (p.valueText && p.source !== 'literal' ? '<span class="sub"> ' + esc(p.valueText) + '</span>' : '')
        + '</span>').join('');
      const edgeList = (list, dir) => list.slice(0, 8).map((e) =>
        '<div class="prop-edge"><b>' + esc(dir === 'out' ? e.toName : e.fromName) + '</b>'
        + '<span class="sub"> ' + (dir === 'out' ? '传出' : '传入') + ' ' + e.propCount + ' props · ' + e.renderCount + ' 处渲染</span>'
        + '<div class="chips">' + (propChips(e.props) || '<span class="sub">（无）</span>') + '</div></div>').join('');
      info.innerHTML = '<b class="name">' + esc(node.name) + '</b>'
        + (node.domain ? chip(node.domain, 'blue') : '')
        + chip('传出 ' + node.outCount + ' 边 / ' + node.propOutCount + ' props', 'purple')
        + chip('传入 ' + node.inCount + ' 边 / ' + node.propInCount + ' props', 'cyan')
        + '<div class="sub">' + esc(node.file) + '</div>'
        + (outEdges.length ? '<h3>传出（' + outEdges.length + ' 个目标组件）</h3>' + edgeList(outEdges, 'out') : '<div class="sub">无传出边。</div>')
        + (inEdges.length ? '<h3>传入（' + inEdges.length + ' 个来源组件）</h3>' + edgeList(inEdges, 'in') : '<div class="sub">无传入边。</div>');
    });
  });
}

function currentPropFilter() {
  const domain = document.getElementById('prop-domain').value;
  const q = document.getElementById('prop-search').value.trim().toLowerCase();
  return (n) => (!domain || n.domain === domain)
    && (!q || n.name.toLowerCase().includes(q) || (n.file || '').toLowerCase().includes(q));
}

function renderPropFlowGraph() {
  const pf = M.propFlow;
  const match = currentPropFilter();
  let nodes = pf.nodes.filter(match);
  let capped = false;
  if (nodes.length > PROP_NODE_CAP) {
    nodes = nodes.slice()
      .sort((a, b) => (b.inCount + b.outCount) - (a.inCount + a.outCount) || a.name.localeCompare(b.name))
      .slice(0, PROP_NODE_CAP);
    capped = true;
  }
  const nodeSet = {};
  nodes.forEach((n) => { nodeSet[n.id] = 1; });
  const edges = pf.edges.filter((e) => nodeSet[e.fromId] && nodeSet[e.toId]);
  PROP_NODES_BY_ID = {};
  nodes.forEach((n) => { PROP_NODES_BY_ID[n.id] = n; });
  const wrap = document.getElementById('prop-graph');
  wrap.innerHTML = buildPropFlowSvg(nodes, edges)
    + (capped ? '<div class="note">匹配组件超过 ' + PROP_NODE_CAP + ' 个，已按连接度截断；使用域筛选或搜索缩小范围。</div>' : '');
  const svgEl = wrap.querySelector('svg');
  if (svgEl) bindPropFlowEvents(svgEl);
}

function renderPropFlow() {
  const el = document.getElementById('view-props');
  const pf = M.propFlow;
  const kv = (v, k) => '<div class="item"><div class="v">' + fmt(v) + '</div><div class="k">' + k + '</div></div>';

  const maxSrc = Math.max(1, ...pf.sourceOrder.map((k) => pf.sourceDist[k]));
  const srcRows = pf.sourceOrder.map((k) => {
    const m = PROP_SOURCE_META[k];
    return barRow(m.label, pf.sourceDist[k], maxSrc, m.cls, m.desc);
  });

  const degRows = (list, dir) => list.map((n) => [
    { html: '<b>' + esc(n.name) + '</b>' },
    { html: n.domain ? chip(n.domain, 'blue') : '-' },
    { v: dir === 'out' ? n.outCount : n.inCount, num: true },
    { v: dir === 'out' ? n.propOutCount : n.propInCount, num: true },
    { html: '<span class="path">' + esc(n.file) + '</span>' },
  ]);

  const edgeRows = pf.edges.slice(0, 80).map((e) => [
    { html: '<b>' + esc(e.fromName) + '</b>' + '<span class="sub"> → </span>' + '<b>' + esc(e.toName) + '</b>' },
    { v: e.propCount, num: true },
    { v: e.renderCount, num: true },
    { html: e.props.slice(0, 6).map((p) => esc(p.name) + ' ' + propSourceChip(p.source)).join(' ')
      + (e.props.length > 6 ? ' <span class="sub">+' + (e.props.length - 6) + '</span>' : '') },
    { html: (e.fromDomain && e.toDomain && e.fromDomain !== e.toDomain) ? chip('跨域', 'amber') : '·' },
  ]);

  const domainOptions = pf.domainOptions.map((d) =>
    '<option value="' + esc(d.name) + '">' + esc(d.name) + ' (' + d.count + ')</option>').join('');
  const legendHtml = pf.domainOptions.slice(0, 10).map((d) =>
    '<span class="legend-dot" style="background:' + propDomainColor(d.name) + '"></span>' + esc(d.name)).join('');

  el.innerHTML =
    '<div class="panel"><h2>组件数据流总览（' + fmt(pf.edgeCount) + ' 条传递边 · ' + fmt(pf.nodeCount) + ' 组件 · ' + fmt(pf.propTotal) + ' 个 props）</h2>'
    + '<div class="kv">' + kv(pf.edgeCount, '传递边') + kv(pf.nodeCount, '参与组件') + kv(pf.propTotal, 'props 总数')
    + (pf.spreadCount ? kv(pf.spreadCount, 'spread 透传') : '') + '</div>'
    + '<h3>props 来源分布</h3>' + srcRows.join('')
    + '<div class="note">PropEdge = 组件对间聚合的 props 传递边；来源分类为词法近似（组件声明范围 + 文件级变量表），spread 属性整体透传不展开成员。路由地图中 overlay 路由的工厂注入（App → 工厂 → 页面组件主干链）另以「工厂 N props」徽章展示。</div></div>'

    + '<div class="panel"><h2>Props 传递图（' + pf.nodeCount + ' 组件，BFS 分层：顶层容器 → 子组件，边标签 = props 数）</h2>'
    + '<div class="filter-bar">'
    + '<select id="prop-domain"><option value="">全部域</option>' + domainOptions + '</select>'
    + '<input id="prop-search" placeholder="搜索组件名 / 文件路径…">'
    + '<button class="btn" id="prop-reset">重置</button>'
    + '</div>'
    + '<div class="graph-wrap" id="prop-graph"></div>'
    + '<div class="legend">' + (legendHtml || '<span class="sub">组件未归属功能域</span>') + '</div>'
    + '<div id="props-info"></div>'
    + '<div class="note">节点从左到右按 props 传递层数分层（边框加粗 = 无入边的顶层组件）；边 = 组件对间的 props 传递（同名 prop 聚合）；悬停高亮相邻边，点击节点在下方查看 props 明细（名称 + 来源 + store hook）。默认渲染连接度 Top ' + PROP_NODE_CAP + ' 组件。</div></div>'

    + '<div class="split">'
    + '<div class="panel"><h3>高传出组件 Top ' + pf.topOut.length + '（props 分发枢纽）</h3>'
    + (pf.topOut.length ? table([{ label: '组件' }, { label: '域' }, { label: '出边', num: true }, { label: '传出 props', num: true }, { label: '文件' }], degRows(pf.topOut, 'out')) : '<div class="empty">无。</div>')
    + '</div>'
    + '<div class="panel"><h3>高传入组件 Top ' + pf.topIn.length + '（props 消费方）</h3>'
    + (pf.topIn.length ? table([{ label: '组件' }, { label: '域' }, { label: '入边', num: true }, { label: '传入 props', num: true }, { label: '文件' }], degRows(pf.topIn, 'in')) : '<div class="empty">无。</div>')
    + '</div>'
    + '</div>'

    + '<details class="panel"><summary>Props 传递边清单（' + pf.edges.length + ' 条' + (pf.edges.length > 80 ? '，表内截断至 80' : '') + '，按 props 数排序）</summary>'
    + table([{ label: '来源 → 目标' }, { label: 'props', num: true }, { label: '渲染处', num: true }, { label: 'props 明细' }, { label: '跨域' }], edgeRows)
    + '</details>';

  document.getElementById('prop-domain').addEventListener('change', renderPropFlowGraph);
  document.getElementById('prop-search').addEventListener('input', renderPropFlowGraph);
  document.getElementById('prop-reset').addEventListener('click', () => {
    document.getElementById('prop-domain').value = '';
    document.getElementById('prop-search').value = '';
    renderPropFlowGraph();
  });
  renderPropFlowGraph();
}

// ---------- Tab 5: 脚本蓝图（油猴脚本函数调用图 + 逻辑注入链）----------
const ROLE = {};
((M.scriptBlueprint && M.scriptBlueprint.roleMeta) || []).forEach((r) => { ROLE[r.key] = r; });
// 角色流向矩阵的展示顺序：事件驱动 → 逻辑 → 数据/状态 → 构建 → 渲染
const ROLE_FLOW_ORDER = ['event', 'logic', 'data', 'state', 'ui', 'render'];
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

// ---------- Tab 6: 实体类图（UML 类框 + implements/extends 关系边，跨语言 TS/Vue/Rust/Dart/Go）----------
const LANG_META = {
  ts: { label: 'TS/JS', color: '#58a6ff', hdr: 'rgba(88,166,255,.10)' },
  vue: { label: 'Vue', color: '#3fb950', hdr: 'rgba(63,185,80,.10)' },
  rust: { label: 'Rust', color: '#d29922', hdr: 'rgba(210,153,34,.12)' },
  dart: { label: 'Dart', color: '#00b4ab', hdr: 'rgba(0,180,171,.12)' },
  go: { label: 'Go', color: '#00add8', hdr: 'rgba(0,173,216,.12)' },
};
const langColor = (l) => (LANG_META[l] || LANG_META.ts).color;
const langHdr = (l) => (LANG_META[l] || LANG_META.ts).hdr;
const langLabel = (l) => (LANG_META[l] || { label: l }).label;

// 布局：父（被实现/继承）在左、子类在右按派生层级分列；无关系实体沉到最右列
function buildEntitiesSvg(nodes, edges) {
  if (!nodes.length) return '<div class="empty">无匹配实体（调整过滤条件试试）。</div>';
  const parentsOf = {};
  edges.forEach((e) => { (parentsOf[e.from] = parentsOf[e.from] || []).push(e.to); });
  const level = {};
  const computeLevel = (id, seen) => {
    if (level[id] !== undefined) return level[id];
    if (seen[id]) return 0;
    seen[id] = 1;
    let lv = 0;
    for (const p of parentsOf[id] || []) lv = Math.max(lv, computeLevel(p, seen) + 1);
    delete seen[id];
    level[id] = lv;
    return lv;
  };
  nodes.forEach((n) => computeLevel(n.id, {}));
  const hasEdge = {};
  edges.forEach((e) => { hasEdge[e.from] = 1; hasEdge[e.to] = 1; });
  let maxLv = 0;
  nodes.forEach((n) => { if (level[n.id] > maxLv) maxLv = level[n.id]; });
  const noEdgeLevel = maxLv + 1;
  nodes.forEach((n) => { if (!hasEdge[n.id]) level[n.id] = noEdgeLevel; });
  // 压缩空层级（过滤后中间层可能为空）
  const usedLevels = [...new Set(nodes.map((n) => level[n.id]))].sort((a, b) => a - b);
  const colIdx = {};
  usedLevels.forEach((lv, i) => { colIdx[lv] = i; });
  const cols = [];
  nodes.forEach((n) => { const i = colIdx[level[n.id]]; (cols[i] = cols[i] || []).push(n); });
  cols.forEach((c) => c.sort((a, b) => (b.methodCount + b.fieldCount + b.variantCount) - (a.methodCount + a.fieldCount + a.variantCount)));

  const W = 232, HDR = 24, ROW = 15, GAPY = 16, PADX = 26, PADY = 44, COLW = W + 84;
  const boxHeight = (n) => HDR + 6
    + (n.fields.length ? n.fields.length * ROW + 5 : 0)
    + (n.variants.length ? n.variants.length * ROW + 5 : 0)
    + (n.methods.length ? n.methods.length * ROW + 5 : 0)
    + 3;
  const pos = {};
  let colX = PADX, maxH = PADY;
  for (let i = 0; i < cols.length; i++) {
    const colNodes = cols[i] || [];
    let y = PADY;
    colNodes.forEach((n) => {
      pos[n.id] = { x: colX, y, h: boxHeight(n) };
      y += boxHeight(n) + GAPY;
    });
    colX += COLW;
    if (y > maxH) maxH = y;
  }
  const svgW = colX - COLW + W + PADX;
  const svgH = maxH + 8;
  const trunc = (s, len) => (String(s ?? '').length > len ? String(s).slice(0, len - 1) + '…' : String(s ?? ''));

  let s = '<svg width="' + svgW + '" height="' + svgH + '" viewBox="0 0 ' + svgW + ' ' + svgH + '" class="uml">';
  s += '<defs>'
    + '<marker id="arr-impl" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M2,2 L10,6 L2,10 z" fill="#0d1117" stroke="#39c5cf" stroke-width="1.4"/></marker>'
    + '<marker id="arr-ext" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M2,2 L10,6 L2,10 z" fill="#bc8cff"/></marker>'
    + '<marker id="arr-rnd" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M2,2 L10,6 L2,10 z" fill="#3fb950"/></marker>'
    + '</defs>';
  // 列标签：首列 = 契约/父类，末列（若为无关系列）= 未关联实体
  for (let i = 0; i < cols.length; i++) {
    const lv = usedLevels[i];
    let label = '派生第 ' + lv + ' 层';
    if (i === 0 && lv === 0) label = '契约 / 父类（被实现与继承）';
    if (lv === noEdgeLevel) label = '未关联实体';
    s += '<text class="col-label" x="' + (PADX + i * COLW) + '" y="16">' + esc(label) + '</text>';
  }
  // 关系边：子类左缘 → 父类右缘（UML 箭头指向接口/父类；renders 为组件组合，绿色实线）
  const EDGE_STYLE = { implements: ['impl', 'arr-impl'], renders: ['rnd', 'arr-rnd'] };
  edges.forEach((e) => {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) return;
    const [cls, marker] = EDGE_STYLE[e.kind] ?? ['ext', 'arr-ext'];
    const y1 = a.y + HDR / 2, y2 = b.y + HDR / 2;
    const x1 = a.x - 2, x2 = b.x + W + 2;
    const mx = (x1 + x2) / 2;
    const d = 'M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ',' + mx + ' ' + y2 + ',' + (x2 - 2) + ' ' + y2;
    s += '<path class="ge ' + cls + '" data-e="' + esc(e.from) + '§' + esc(e.to) + '" d="' + d + '" marker-end="url(#' + marker + ')"><title>' + esc(e.kind) + '</title></path>';
  });
  // UML 类框：头部（名称+构造型）→ 字段/变体 → 分隔线 → 方法
  nodes.forEach((n) => {
    const p = pos[n.id];
    const c = langColor(n.language);
    const stereo = n.kind === 'class' ? '' : '«' + n.kind + '»';
    let g = '<g class="gn" data-n="' + esc(n.id) + '">'
      + '<rect class="box" x="' + p.x + '" y="' + p.y + '" width="' + W + '" height="' + p.h + '" rx="5" stroke="' + c + '"' + (n.deadCandidate ? ' stroke-dasharray="4 3"' : '') + '/>'
      + '<rect class="hdr" x="' + p.x + '" y="' + p.y + '" width="' + W + '" height="' + HDR + '" rx="5" fill="' + langHdr(n.language) + '"/>'
      + '<text class="uname' + (n.entityType === 'interface' ? ' it' : '') + '" x="' + (p.x + 9) + '" y="' + (p.y + 16) + '">' + esc(trunc(n.name, 22)) + '</text>'
      + (stereo ? '<text class="ustereo" x="' + (p.x + W - 8) + '" y="' + (p.y + 16) + '" text-anchor="end">' + esc(stereo) + '</text>' : '');
    let cy = p.y + HDR + 6;
    n.fields.forEach((f) => {
      g += '<text class="umember" x="' + (p.x + 9) + '" y="' + cy + '">' + esc(trunc('+ ' + f.name + (f.type ? ': ' + f.type : ''), 34)) + '</text>';
      cy += ROW;
    });
    if (n.fieldCount > n.fields.length) {
      g += '<text class="umore" x="' + (p.x + 9) + '" y="' + cy + '">… 另有 ' + (n.fieldCount - n.fields.length) + ' 字段</text>';
      cy += ROW;
    }
    n.variants.forEach((v) => {
      g += '<text class="umember" x="' + (p.x + 9) + '" y="' + cy + '">' + esc(trunc('· ' + v, 34)) + '</text>';
      cy += ROW;
    });
    if (n.variantCount > n.variants.length) {
      g += '<text class="umore" x="' + (p.x + 9) + '" y="' + cy + '">… 另有 ' + (n.variantCount - n.variants.length) + ' 变体</text>';
      cy += ROW;
    }
    if (n.fields.length || n.variants.length || n.fieldCount > n.fields.length || n.variantCount > n.variants.length) {
      g += '<line class="usep" x1="' + (p.x + 1) + '" y1="' + (cy - 5) + '" x2="' + (p.x + W - 1) + '" y2="' + (cy - 5) + '"/>';
      cy += 2;
    }
    n.methods.forEach((m) => {
      g += '<text class="umember" x="' + (p.x + 9) + '" y="' + cy + '">' + esc(trunc((m.isStatic ? '$ ' : '+ ') + m.name + '()', 34)) + '</text>';
      cy += ROW;
    });
    if (n.methodCount > n.methods.length) {
      g += '<text class="umore" x="' + (p.x + 9) + '" y="' + cy + '">… 另有 ' + (n.methodCount - n.methods.length) + ' 方法</text>';
      cy += ROW;
    }
    const rel = []
      .concat(n.extendsName ? ['extends ' + n.extendsName] : [])
      .concat((n.implementsNames || []).map((x) => 'impl ' + x));
    g += '<title>' + esc(n.name + ' · ' + n.kindLabel + ' · ' + langLabel(n.language) + '\\n' + n.filePath + (n.line ? ':' + n.line : '')
      + '\\n模块 ' + (n.module || '（根）') + ' · 字段 ' + n.fieldCount + ' · 变体 ' + n.variantCount + ' · 方法 ' + n.methodCount
      + (rel.length ? '\\n关系: ' + rel.join('、') : '') + (n.derives.length ? '\\nderives: ' + n.derives.join(', ') : '')) + '</title>';
    g += '</g>';
    s += g;
  });
  s += '</svg>';
  return s;
}

function bindEntityGraphEvents(svgEl) {
  const info = document.getElementById('entity-info');
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
      const node = E_NODES_BY_ID[g.dataset.n];
      if (!node) return;
      const rel = [].concat(node.extendsName ? ['extends ' + node.extendsName] : [], (node.implementsNames || []).map((x) => 'impl ' + x));
      info.innerHTML = '<b class="name">' + esc(node.name) + '</b> '
        + chip(node.kindLabel, node.kind === 'interface' || node.kind === 'trait' ? 'cyan' : 'blue')
        + chip(langLabel(node.language), { rust: 'amber', vue: 'green', dart: 'teal' }[node.language] || '')
        + chip('关系度 ' + node.degree, node.degree > 0 ? 'purple' : '')
        + (node.exported ? chip('导出', 'green') : chip('内部', ''))
        + (node.isSingleton ? chip('单例', 'amber') : '')
        + (node.deadCandidate ? chip('死代码候选', 'red') : '')
        + '<div class="sub">' + esc(node.filePath) + (node.line ? ':' + node.line : '') + ' · 模块 ' + esc(node.module || '（根）')
        + ' · 字段 ' + node.fieldCount + ' · 变体 ' + node.variantCount + ' · 方法 ' + node.methodCount + '</div>'
        + (rel.length ? '<div class="sub">关系：' + rel.map(esc).join('、') + '</div>' : '')
        + (node.derives.length ? '<div class="sub">derives: ' + esc(node.derives.join(', ')) + '</div>' : '')
        + (node.methods.length ? '<div class="sub">方法调用链：' + node.methods.slice(0, 8).map((m) => esc(m.name) + (m.calls.length ? ' → ' + m.calls.map(esc).join('、') : '')).join('；') + '</div>' : '');
    });
  });
}

let E_NODES_BY_ID = {};
function currentEntityFilter() {
  const mod = document.getElementById('ent-mod').value;
  const kind = document.getElementById('ent-kind').value;
  const lang = document.getElementById('ent-lang').value;
  const q = document.getElementById('ent-search').value.trim().toLowerCase();
  return (n) => (!mod || n.module === mod)
    && (!kind || n.kind === kind)
    && (!lang || n.language === lang)
    && (!q || n.name.toLowerCase().includes(q));
}

function renderEntityGraph() {
  const E = M.entities;
  const match = currentEntityFilter();
  const shown = E.graph.nodes.filter(match);
  const shownIds = {};
  shown.forEach((n) => { shownIds[n.id] = 1; });
  const edges = E.graph.edges.filter((e) => shownIds[e.from] && shownIds[e.to]);
  E_NODES_BY_ID = {};
  shown.forEach((n) => { E_NODES_BY_ID[n.id] = n; });
  const wrap = document.getElementById('entity-graph');
  wrap.innerHTML = buildEntitiesSvg(shown, edges);
  const svgEl = wrap.querySelector('svg');
  if (svgEl) bindEntityGraphEvents(svgEl);
}

function renderEntityTable() {
  const E = M.entities;
  const match = currentEntityFilter();
  const rows = E.table.filter(match).map((n) => [
    { html: '<b>' + esc(n.name) + '</b>' },
    { html: chip(n.kindLabel, n.kind === 'interface' || n.kind === 'trait' ? 'cyan' : 'blue') },
    { html: chip(langLabel(n.language), n.language === 'rust' ? 'amber' : (n.language === 'vue' ? 'green' : '')) },
    { v: n.module || '（根）' },
    { html: '<span class="path">' + esc(n.filePath) + (n.line ? ':' + n.line : '') + '</span>' },
    { v: n.fieldCount + (n.variantCount ? ' (+' + n.variantCount + 'v)' : ''), num: true },
    { v: n.methodCount, num: true },
    { v: n.degree, num: true },
    { v: [].concat(n.extendsName ? ['extends ' + n.extendsName] : [], (n.implementsNames || []).map((x) => x)).join('、') || '—' },
    { html: (n.deadCandidate ? chip('死代码候选', 'red') + ' ' : '') + (n.exported ? chip('导出', 'green') : '') + (n.isSingleton ? chip('单例', 'amber') : '') || '—' },
  ]);
  document.getElementById('entity-table').innerHTML = rows.length
    ? table([
      { label: '实体' }, { label: '类型' }, { label: '语言' }, { label: '模块' }, { label: '文件' },
      { label: '字段', num: true }, { label: '方法', num: true }, { label: '关系度', num: true },
      { label: '实现/继承' }, { label: '状态' },
    ], rows)
    : '<div class="empty">无匹配实体。</div>';
}

function renderEntities() {
  const el = document.getElementById('view-entities');
  const E = M.entities;
  if (!E) {
    el.innerHTML = '<div class="panel"><h2>实体类图</h2><div class="empty">未检测到 Class/Interface 类型实体。</div></div>';
    return;
  }
  const maxLang = E.byLanguage.length ? E.byLanguage[0].count : 0;
  const maxLayer = E.byLayer.length ? E.byLayer[0].count : 0;
  const modOptions = E.moduleOptions.map((m) => '<option value="' + esc(m.name) + '">' + esc(m.name || '（根）') + ' (' + m.count + ')</option>').join('');
  const kindOptions = E.byKind.map((k) => '<option value="' + esc(k.key) + '">' + esc(k.label) + ' (' + k.count + ')</option>').join('');
  const langOptions = E.byLanguage.map((l) => '<option value="' + esc(l.key) + '">' + esc(l.label) + ' (' + l.count + ')</option>').join('');

  el.innerHTML =
    '<div class="panel"><h2>实体类图（' + fmt(E.totalCount) + ' 实体 · ' + fmt(E.methodCount) + ' 方法 · ' + fmt(E.edgeCount) + ' 关系边）</h2>'
    + '<div class="chips" style="margin-bottom:12px">'
    + chip('类 ' + fmt(E.classCount), 'blue')
    + chip('接口/Trait ' + fmt(E.interfaceCount), 'cyan')
    + chip('implements ' + fmt(E.implementsCount), 'cyan')
    + chip('extends ' + fmt(E.extendsCount), 'purple')
    + (E.rendersCount ? chip('renders ' + fmt(E.rendersCount), 'green') : '')
    + (E.crossLanguageEdges ? chip('跨语言关系 ' + fmt(E.crossLanguageEdges), 'amber') : '')
    + (E.deadCandidateCount ? chip('死代码候选 ' + fmt(E.deadCandidateCount), 'red') : '')
    + '</div>'
    + '<div class="note">实体 = Interface / Class（Rust struct/enum/trait 映射为同构实体；Vue 组件合成为 «组件» 实体，props 为字段、computed/methods 为方法）。图展示 '
    + E.graph.nodes.length + ' 个实体：关系活跃实体优先，各语言代表性实体按成员规模轮转补齐（共 '
    + fmt(E.relatedEntityCount) + ' 个参与关系的实体）；完整清单见下方表格。</div>'
    + '<div class="split" style="margin-top:12px">'
    + '<div><h3>语言分布</h3>' + E.byLanguage.map((l) => barRow(l.label, l.count, maxLang, { rust: 'amber', vue: 'green', dart: 'teal', go: 'go' }[l.key] || 'blue')).join('') + '</div>'
    + '<div><h3>架构层分布</h3>' + E.byLayer.map((l) => barRow(l.label, l.count, maxLayer, 'cyan')).join('') + '</div>'
    + '</div>'
    + '<div class="legend" style="margin-top:14px">'
    + E.byLanguage.map((l) => '<span class="legend-dot" style="background:' + langColor(l.key) + '"></span>' + esc(l.label)).join('')
    + '<span class="line" style="border-color:#39c5cf;border-top-style:dashed"></span>implements（虚线箭头）'
    + '<span class="line" style="border-color:#bc8cff"></span>extends（实线箭头）'
    + '<span class="line" style="border-color:#3fb950"></span>renders（组件组合，实线箭头）'
    + '</div>'
    + '</div>'

    + '<div class="panel"><h3>UML 类图</h3>'
    + '<div class="filter-bar">'
    + '<select id="ent-mod"><option value="">全部模块</option>' + modOptions + '</select>'
    + '<select id="ent-kind"><option value="">全部类型</option>' + kindOptions + '</select>'
    + '<select id="ent-lang"><option value="">全部语言</option>' + langOptions + '</select>'
    + '<input id="ent-search" placeholder="搜索实体名…">'
    + '<button class="btn" id="ent-reset">重置</button>'
    + '</div>'
    + '<div class="uml-wrap" id="entity-graph"></div>'
    + '<div id="entity-info"></div>'
    + '</div>'

    + '<div class="panel"><h3>实体清单（Top ' + E.table.length + '，按关系活跃度排序）</h3>'
    + '<div id="entity-table"></div>'
    + (E.totalCount > E.table.length ? '<div class="note">共 ' + fmt(E.totalCount) + ' 个实体，此处展示前 ' + E.table.length + ' 个；完整数据见 snapshot.json。</div>' : '')
    + '</div>';

  ['ent-mod', 'ent-kind', 'ent-lang'].forEach((id) => {
    document.getElementById(id).addEventListener('change', () => { renderEntityGraph(); renderEntityTable(); });
  });
  document.getElementById('ent-search').addEventListener('input', () => { renderEntityGraph(); renderEntityTable(); });
  document.getElementById('ent-reset').addEventListener('click', () => {
    document.getElementById('ent-mod').value = '';
    document.getElementById('ent-kind').value = '';
    document.getElementById('ent-lang').value = '';
    document.getElementById('ent-search').value = '';
    renderEntityGraph();
    renderEntityTable();
  });
  renderEntityGraph();
  renderEntityTable();
}

// ---------- 初始化 ----------
// Tab 显隐：视图无有效数据时隐藏（含油猴意图适配视图；纯功能增强脚本分析不出业务结构）
const hideTab = (tab) => { const t = document.querySelector('.tab[data-tab="' + tab + '"]'); if (t) t.style.display = 'none'; };
document.getElementById('v-title').textContent = M.project.name + ' — 本体蓝图查看器';
document.getElementById('v-sub').textContent =
  (M.project.frameworkLabel || M.project.framework || 'unknown') + ' · ' + fmt(M.project.fileCount) + ' 源文件 · '
  + M.domainCount + ' 功能域 · ' + (M.project.commitHash ? ('commit ' + M.project.commitHash.slice(0, 7) + ' · ') : '')
  + (M.scriptBlueprint ? M.scriptBlueprint.scriptCount + ' 油猴脚本 · ' : '')
  + '生成于 ' + fmtLocalTime(M.generatedAt);
if (!M.scriptBlueprint) hideTab('scripts');
if (!M.domains.length && !M.scriptDomains) hideTab('blueprint');
if (!M.dataMap.stores.length && !M.scriptDataMap) hideTab('data');
if (!M.logicFlow.layerFlowTotal && !M.scriptFlow) hideTab('flow');
if (!M.entities) hideTab('entities');
if (!M.routeMap) hideTab('routemap');
if (!M.propFlow) hideTab('props');
renderOverview();
renderBlueprint();
renderData();
renderFlow();
if (M.routeMap) renderRouteMap();
if (M.propFlow) renderPropFlow();
if (M.entities) renderEntities();
if (M.scriptBlueprint) renderScripts();
</script>
</body>
</html>`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
