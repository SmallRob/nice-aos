// 视图模型聚合（viewerModel.js）：buildViewerModel 主函数 + 5 个 toXxxItem 工具
// 原为 viewer.js L66-L1289（export function buildViewerModel + function toComponentItem/StoreItem/HookItem/ServiceItem/ScriptItem）
// 把 dataMap 聚合为渲染层使用的视图模型 M，由 renderViewerHtml (viewer.js) 消费
// P2-6 阶段四：整体迁移，逻辑零改动；后续可按 builder.js 7 相位模式继续拆分
import { ARCH_LAYERS } from './semantics.js';
import { ONTOLOGY_META, OBJECT_TYPES, LINK_TYPES } from './blueprint.js';
import { ACTION_DEFS } from './actionDefs.js'; // E-2：纯定义单源（blueprintActions.js 仍 re-export 兼容）

const layerLabel = (key) => ARCH_LAYERS[key]?.label ?? key;

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
    // v0.41.0: 仅限油猴端点（scriptId 非空）—— Python outbound 端点不归属脚本蓝图，
    // 计入会让"脚本蓝图网络端点总数"与下列表的油猴端点数对不上
    totalNetworkCount: networkEndpoints.filter((n) => n.scriptId).length,
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
    domainGroups.sort((a, b) => b.routes.length - a.routes.length || (a.name ?? '').localeCompare(b.name ?? ''));

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
    edges.sort((a, b) => b.propCount - a.propCount || (a.fromName + '>' + a.toName).localeCompare(b.fromName + '>' + b.toName ?? ''));

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
      .sort((a, b) => b.count - a.count || (a.name ?? '').localeCompare(b.name ?? ''));

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

  // ---- 模块子树聚合（代码统计 / 代码图谱共用）----
  const moduleChildren = new Map();
  for (const m of modules) {
    const parent = moduleById.has(m.parentId) ? m.parentId : null;
    if (!moduleChildren.has(parent)) moduleChildren.set(parent, []);
    moduleChildren.get(parent).push(m);
  }
  const moduleDirect = new Map();
  for (const f of files) {
    if (!f.moduleId || !moduleById.has(f.moduleId)) continue;
    const d = moduleDirect.get(f.moduleId) ?? { lines: 0, files: 0 };
    d.lines += f.lineCount ?? 0;
    d.files += 1;
    moduleDirect.set(f.moduleId, d);
  }
  const subtreeAgg = (m) => {
    const d = moduleDirect.get(m.id) ?? { lines: 0, files: 0 };
    let lines = d.lines;
    let fileCount = d.files;
    for (const c of moduleChildren.get(m.id) ?? []) {
      const s = subtreeAgg(c);
      lines += s.lines;
      fileCount += s.files;
    }
    return { lines, files: fileCount };
  };

  // ---- 代码量统计（Code Stats）：行数 / 语言 / 架构层 / 模块 / 单元规模画像 ----
  const EXT_LABELS = {
    ts: 'TypeScript', tsx: 'TSX (React)', js: 'JavaScript', jsx: 'JSX',
    vue: 'Vue SFC', rs: 'Rust', dart: 'Dart', go: 'Go',
  };
  const UNIT_KIND_LABELS = { component: '组件', hook: 'Hook', store: 'Store', service: '服务' };
  const stats = (() => {
    if (!files.length) return null;
    const totalLines = files.reduce((a, f) => a + (f.lineCount ?? 0), 0);
    const testFileCount = files.filter((f) => f.isTest).length;
    const declarationFileCount = files.filter((f) => f.isDeclaration).length;

    const extMap = new Map();
    for (const f of files) {
      // 各分析器扩展名格式不一（ts: 'tsx'；dart/rs: '.dart'），统一去点
      const key = (f.ext || '(无扩展名)').replace(/^\./, '');
      const e = extMap.get(key) ?? { ext: key, label: EXT_LABELS[key] ?? key, files: 0, lines: 0 };
      e.files += 1;
      e.lines += f.lineCount ?? 0;
      extMap.set(key, e);
    }
    const byExt = [...extMap.values()].sort((a, b) => b.lines - a.lines || b.files - a.files);
    byExt.forEach((e) => { e.pct = totalLines > 0 ? +((100 * e.lines) / totalLines).toFixed(1) : 0; });

    const layerMap = new Map();
    for (const f of files) {
      const key = f.archLayer ?? 'shared';
      const e = layerMap.get(key) ?? { key, label: layerLabel(key), files: 0, lines: 0 };
      e.files += 1;
      e.lines += f.lineCount ?? 0;
      layerMap.set(key, e);
    }
    const byLayer = [...layerMap.values()].sort((a, b) => b.lines - a.lines || b.files - a.files);
    byLayer.forEach((e) => { e.pct = totalLines > 0 ? +((100 * e.lines) / totalLines).toFixed(1) : 0; });

    // 一级模块统计；顶层分区过少（单 src/ 或融合仓库）时下钻一层，让粒度对齐真实代码分区
    const fileBearing = (list) => list.filter((k) => subtreeAgg(k).files > 0);
    let statRoots = fileBearing(moduleChildren.get(null) ?? []);
    if (statRoots.length > 0 && statRoots.length < 6) {
      const expanded = [];
      for (const r of statRoots) {
        const kids = fileBearing(moduleChildren.get(r.id) ?? []);
        if (kids.length >= 2) expanded.push(...kids);
        else expanded.push(r);
      }
      if (expanded.length >= 2) statRoots = expanded;
    }
    const moduleStats = statRoots
      .map((m) => ({ name: m.name, path: m.path, layer: m.layer ?? null, ...subtreeAgg(m) }))
      .filter((m) => m.files > 0)
      .sort((a, b) => b.lines - a.lines);
    moduleStats.forEach((m) => { m.pct = totalLines > 0 ? +((100 * m.lines) / totalLines).toFixed(1) : 0; });

    const topUnits = [
      ...components.map((c) => ({ name: c.name, kind: 'component', kindLabel: UNIT_KIND_LABELS.component, filePath: c.filePath, lineCount: c.lineCount ?? 0 })),
      ...hooks.map((h) => ({ name: h.name, kind: 'hook', kindLabel: UNIT_KIND_LABELS.hook, filePath: h.filePath, lineCount: h.lineCount ?? 0 })),
      ...stores.map((s) => ({ name: s.name, kind: 'store', kindLabel: UNIT_KIND_LABELS.store, filePath: s.filePath, lineCount: s.lineCount ?? 0 })),
      ...services.map((s) => ({ name: s.name, kind: 'service', kindLabel: UNIT_KIND_LABELS.service, filePath: s.filePath, lineCount: s.lineCount ?? 0 })),
    ].sort((a, b) => b.lineCount - a.lineCount || (a.name ?? '').localeCompare(b.name ?? '')).slice(0, 20);

    const topFiles = files
      .slice().sort((a, b) => (b.lineCount ?? 0) - (a.lineCount ?? 0))
      .slice(0, 15)
      .map((f) => ({ name: f.name, path: f.path, ext: f.ext ?? null, lineCount: f.lineCount ?? 0, isTest: !!f.isTest, archLayer: f.archLayer ?? null }));

    return {
      totalLines,
      totalFiles: files.length,
      testFileCount,
      declarationFileCount,
      avgLinesPerFile: files.length ? Math.round(totalLines / files.length) : 0,
      unitCounts: { components: components.length, hooks: hooks.length, stores: stores.length, services: services.length },
      byExt,
      byLayer,
      moduleStats,
      topUnits,
      topFiles,
    };
  })();

  // ---- 代码图谱（Code Graph）：模块 / 组件两级依赖网络（供力导向图渲染）----
  const codeGraph = (() => {
    if (!files.length) return null;

    const moduleView = (() => {
      // 与 moduleStats 下钻逻辑对齐：单一顶层根（如 src/）拥有多个文件分区时，排除根模块本身，
      // 避免图中出现"全部代码聚合"的巨型冗余节点
      const rootCandidates = modules.filter((m) => {
        const p = m.parentId;
        return !p || !moduleById.has(p);
      });
      const excludedRoots = new Set();
      for (const r of rootCandidates) {
        const kids = (moduleChildren.get(r.id) ?? []).filter((k) => subtreeAgg(k).files > 0);
        if (kids.length >= 2) excludedRoots.add(r.id);
      }
      const candidates = modules.filter((m) => (m.depth ?? 1) <= 2 && !excludedRoots.has(m.id));
      const pool = candidates.length >= 2 ? candidates : modules;
      const ranked = pool
        .map((m) => ({ m, agg: subtreeAgg(m) }))
        .sort((a, b) => b.agg.lines - a.agg.lines)
        .slice(0, MODULE_GRAPH_NODE_CAP);
      if (!ranked.length) return null;
      const kept = new Set(ranked.map((r) => r.m.id));
      const nearestKept = (moduleId) => {
        let m = moduleById.get(moduleId);
        while (m && !kept.has(m.id)) m = moduleById.get(m.parentId);
        return m ?? null;
      };
      const edgeMap = new Map();
      for (const f of files) {
        const src = nearestKept(f.moduleId);
        if (!src) continue;
        for (const iid of f.importIds ?? []) {
          if (!iid.startsWith('file:')) continue;
          const tf = fileByPath.get(iid.slice(5));
          if (!tf) continue;
          const dst = nearestKept(tf.moduleId);
          if (!dst || dst.id === src.id) continue;
          const key = src.id + '>' + dst.id;
          const e = edgeMap.get(key) ?? { source: src.id, target: dst.id, weight: 0 };
          e.weight += 1;
          edgeMap.set(key, e);
        }
      }
      const nodes = ranked.map((r) => ({
        id: r.m.id, name: r.m.name, path: r.m.path, layer: r.m.layer ?? null,
        lines: r.agg.lines, files: r.agg.files,
      }));
      const edges = [...edgeMap.values()].sort((a, b) => b.weight - a.weight).slice(0, GRAPH_EDGE_CAP);
      return {
        nodes,
        edges,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        hiddenModuleCount: modules.filter((m) => !kept.has(m.id) && !excludedRoots.has(m.id)).length,
      };
    })();

    const componentView = (() => {
      if (!components.length) return null;
      const propEdges = dataMap.PropEdge ?? [];
      const mainCompByFileId = new Map();
      for (const c of components) {
        if (!c.fileId) continue;
        const cur = mainCompByFileId.get(c.fileId);
        if (!cur || (c.lineCount ?? 0) > (cur.lineCount ?? 0)) mainCompByFileId.set(c.fileId, c);
      }
      const storeByFileId = new Map();
      for (const s of stores) {
        if (s.fileId) storeByFileId.set(s.fileId, s);
      }
      const domainNameOf = (u) => {
        const did = (u.domainIds ?? [])[0];
        return did ? (domainById.get(did)?.name ?? null) : null;
      };

      const edgeMap = new Map();
      const addEdge = (source, target, kind, weight) => {
        if (source === target) return;
        const key = kind + '|' + source + '>' + target;
        const e = edgeMap.get(key) ?? { source, target, kind, weight: 0 };
        e.weight += weight ?? 1;
        edgeMap.set(key, e);
      };
      for (const pe of propEdges) {
        addEdge(pe.fromComponentId, pe.toComponentId, 'props', pe.props?.length ?? 1);
      }
      for (const f of files) {
        const srcComp = mainCompByFileId.get(f.id);
        if (!srcComp) continue;
        for (const iid of f.importIds ?? []) {
          if (!iid.startsWith('file:')) continue;
          const store = storeByFileId.get(iid);
          if (store) {
            addEdge(srcComp.id, store.id, 'usesStore', 1);
            continue;
          }
          const dstComp = mainCompByFileId.get(iid);
          if (dstComp) addEdge(srcComp.id, dstComp.id, 'imports', 1);
        }
      }
      // 隐式 useStore：auto-import 场景组件直接调用 useXxxStore() 无 import 语句（builder 已解析 Component.storeIds）
      for (const c of components) {
        for (const sid of c.storeIds ?? []) addEdge(c.id, sid, 'usesStore', 1);
      }

      const degreeOf = new Map();
      for (const e of edgeMap.values()) {
        degreeOf.set(e.source, (degreeOf.get(e.source) ?? 0) + 1);
        degreeOf.set(e.target, (degreeOf.get(e.target) ?? 0) + 1);
      }
      const storeNodes = stores
        .slice().sort((a, b) => (b.lineCount ?? 0) - (a.lineCount ?? 0) || (degreeOf.get(b.id) ?? 0) - (degreeOf.get(a.id) ?? 0))
        .slice(0, STORE_GRAPH_NODE_CAP)
        .map((s) => ({ id: s.id, name: s.name, kind: 'store', domain: domainNameOf(s), lines: s.lineCount ?? 0 }));
      const storeIds = new Set(storeNodes.map((s) => s.id));
      const compNodes = components
        .slice().sort((a, b) => (degreeOf.get(b.id) ?? 0) - (degreeOf.get(a.id) ?? 0) || (b.lineCount ?? 0) - (a.lineCount ?? 0) || (a.name ?? '').localeCompare(b.name ?? ''))
        .slice(0, Math.max(0, COMPONENT_GRAPH_NODE_CAP - storeNodes.length))
        .map((c) => ({ id: c.id, name: c.name, kind: 'component', domain: domainNameOf(c), lines: c.lineCount ?? 0, filePath: c.filePath ?? null }));
      const nodes = [...compNodes, ...storeNodes];
      const nodeIds = new Set(nodes.map((n) => n.id));
      const edges = [...edgeMap.values()]
        .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, GRAPH_EDGE_CAP);
      return {
        nodes,
        edges,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        hiddenComponentCount: Math.max(0, components.length - compNodes.length),
      };
    })();

    if (!moduleView && !componentView) return null;
    return { moduleView, componentView };
  })();

  // ---- 蓝图交互动作（借鉴 asdm-aos ActionPanel；注入到 HTML 蓝图供前端 JS 渲染）----
  // 借鉴 asdm-aos v0.0.12 ActionPanel.tsx 的设计思路：
  //   - 蓝图元数据里输出所有可用动作的 schema（markReviewed/addNote/refreshRepo/analyzeFile）
  //   - 前端 JS 按"当前选中对象类型"过滤可用动作
  //   - 提交走 fetch('/action', ...) 调 nice-aos serve 端点
  // 当前实现：viewer 静态渲染时不绑定对象（用户点击对象时由前端 JS 接管）；
  // 此处输出 action schemas 供 HTML 蓝图 JS 消费
  const interactive = {
    // 从 blueprintActions.js ACTION_DEFS 获取（单一数据源，含 markReviewed/addNote/refreshRepo/analyzeFile）
    actionDefs: ACTION_DEFS,
    endpoint: '/action',
  };

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
    stats,
    codeGraph,
    // v0.35.0 渲染预算声明（借鉴 GitNexus 的大图阈值熔断 + AI 标记回灌）
    // UI 拿 budgets 与 codeGraph 对比，超限给用户明确告知
    renderBudgets: {
      moduleGraphNodeCap: MODULE_GRAPH_NODE_CAP,
      componentGraphNodeCap: COMPONENT_GRAPH_NODE_CAP,
      storeGraphNodeCap: STORE_GRAPH_NODE_CAP,
      graphEdgeCap: GRAPH_EDGE_CAP,
      entityNodeCap: ENTITY_NODE_CAP,
      entityTableCap: ENTITY_TABLE_CAP,
    },
    interactive,
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
