import path from 'node:path';
import { scanProject } from '../analyzers/projectScanner.js';
import { createResolver } from '../analyzers/importResolver.js';
import { analyzeFileFromDisk } from '../analyzers/tsAnalyzer.js';
import { analyzeVueFileFromDisk } from '../analyzers/vueAnalyzer.js';
import { analyzeUserScriptFromDisk } from '../analyzers/userScriptAnalyzer.js';
import { analyzeOverlayRoutes, analyzeJsxRoutes } from '../analyzers/overlayAnalyzer.js';
import {
  ARCH_LAYERS, inferFileArchLayer, inferModuleArchLayer, buildDomains,
  summarizeModule, buildProjectProfile,
} from './semantics.js';

const KIND_SUFFIXES = [
  ['Page', 'page'], ['Modal', 'modal'], ['Dialog', 'dialog'], ['Card', 'card'],
  ['Chart', 'chart'], ['Form', 'form'], ['Detail', 'detail'], ['Details', 'detail'],
  ['Panel', 'panel'], ['Section', 'section'], ['List', 'list'], ['Item', 'item'],
  ['Button', 'button'], ['Widget', 'widget'], ['View', 'view'], ['Provider', 'provider'],
  ['Overlay', 'overlay'], ['Tab', 'tab'], ['Picker', 'picker'], ['Badge', 'badge'],
];
const ENTRY_BASENAMES = new Set(['App.tsx', 'index.tsx', 'main.tsx', 'index.ts', 'main.ts', 'main.js', 'App.vue']);
const SERVICE_NAME_RE = /(Service|Engine|Manager|Repository|Factory)$/;

// 入口识别：位于任一扫描根顶层的常见入口文件名（多根 monorepo 每个根均可有自己的入口）
function isEntryFile(relPath, roots) {
  if (!ENTRY_BASENAMES.has(path.posix.basename(relPath))) return false;
  const dir = path.posix.dirname(relPath);
  return roots.some((r) => dir === r || dir === r.replace(/\/+$/, ''));
}

function componentKind(name) {
  for (const [suffix, kind] of KIND_SUFFIXES) {
    if (name.endsWith(suffix)) return kind;
  }
  return 'common';
}

function moduleLayerOf(dir) {
  const parts = dir.split('/');
  if (parts[0] === 'src') return parts[1] ?? 'src';
  return parts[0];
}

function isTestFile(relPath) {
  return /(__tests__|\.test\.|\.spec\.)/.test(relPath) || relPath.startsWith('src/tests/') || relPath.startsWith('src/e2e/');
}

function uniqueId(base, used) {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}@${i}`)) i += 1;
  const id = `${base}@${i}`;
  used.add(id);
  return id;
}

// Tarjan 强连通分量（循环依赖检测）
function findCycles(fileObjects) {
  const graph = new Map();
  for (const f of fileObjects) graph.set(f.id, (f.importIds ?? []).filter((id) => id.startsWith('file:')));
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  let counter = 0;
  const cycles = [];

  function strongConnect(v) {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) cycles.push(scc.map((id) => id.slice(5)).sort());
    }
  }
  for (const v of graph.keys()) {
    if (!index.has(v)) strongConnect(v);
  }
  return cycles;
}

export async function buildOntologyData(projectRoot, options = {}) {
  const startedAt = Date.now();
  const scan = scanProject(projectRoot, options);
  // 入口识别使用实际扫描根（显式 roots 或默认 src/）；根级入口名在每个根顶层均有效
  const entryRoots = scan.roots ?? ['src'];
  const htmlEntries = new Set(scan.htmlEntryFiles ?? []);
  const resolver = createResolver(projectRoot, scan.tsconfigPaths, scan.files);

  // 1. 逐文件解析（TypeScript Compiler API，仅词法/语法层，不做类型检查）
  // 路由：.vue → vueAnalyzer；油猴脚本 → userScriptAnalyzer；其余 → tsAnalyzer（三者平级、逻辑独立）
  const factsMap = new Map();
  const analysisErrors = [];
  const getFacts = (relPath) => {
    if (factsMap.has(relPath)) return factsMap.get(relPath);
    try {
      const facts = relPath.endsWith('.vue')
        ? analyzeVueFileFromDisk(relPath, projectRoot)
        : (scan.userScriptFiles?.has(relPath)
          ? analyzeUserScriptFromDisk(relPath, projectRoot)
          : analyzeFileFromDisk(relPath, projectRoot));
      factsMap.set(relPath, facts);
      return facts;
    } catch (err) {
      analysisErrors.push({ file: relPath, error: String(err.message ?? err) });
      const empty = {
        path: relPath, ext: path.extname(relPath).slice(1), lineCount: 0,
        imports: [], exportSymbols: [], exportNames: [], jsxTags: new Set(),
        useCalls: [], overlayOpens: [], stores: [], lazyWrappers: [], components: [],
        hooks: [], primaryComponentName: null, hasSingletonClass: false, hasClassExport: false,
        importMap: new Map(), vueRoutes: [], vueRouteMeta: null,
      };
      factsMap.set(relPath, empty);
      return empty;
    }
  };
  for (const file of scan.files) getFacts(file);

  // 2. 依赖对象（package.json 声明 + 代码中实际导入）
  const depUsedCount = new Map();
  const externalImports = new Map(); // package -> Set<specifier>
  for (const [relPath, facts] of factsMap) {
    for (const imp of facts.imports) {
      const resolved = resolver.resolve(relPath, imp.specifier);
      imp.resolved = resolved;
      if (resolved.kind === 'external') {
        depUsedCount.set(resolved.package, (depUsedCount.get(resolved.package) ?? 0) + 1);
        if (!externalImports.has(resolved.package)) externalImports.set(resolved.package, new Set());
        externalImports.get(resolved.package).add(imp.specifier);
      }
    }
  }
  const dependencies = [];
  for (const [name, info] of Object.entries(scan.dependencies)) {
    dependencies.push({
      id: `dep:${name}`, name,
      version: info.version, scope: info.scope,
      source: info.version.startsWith('file:') ? 'workspace' : 'npm',
      importCount: depUsedCount.get(name) ?? 0,
      used: (depUsedCount.get(name) ?? 0) > 0,
    });
  }
  for (const [name, count] of depUsedCount) {
    if (scan.dependencies[name]) continue;
    dependencies.push({
      id: `dep:${name}`, name, version: null, scope: null,
      source: 'undeclared', importCount: count, used: true,
    });
  }

  // 3. 模块树
  const modules = [];
  const moduleIds = new Set();
  function ensureModule(dir) {
    if (!dir || dir === '.') return null;
    if (moduleIds.has(`mod:${dir}`)) return `mod:${dir}`;
    const parent = path.posix.dirname(dir);
    const parentId = parent === '.' ? null : ensureModule(parent);
    modules.push({
      id: `mod:${dir}`,
      name: path.posix.basename(dir),
      path: dir,
      layer: moduleLayerOf(dir),
      depth: dir.split('/').length,
      parentId,
      fileCount: 0,
    });
    moduleIds.add(`mod:${dir}`);
    return `mod:${dir}`;
  }

  // 4. SourceFile 对象
  const fileObjects = [];
  const fileObjectByPath = new Map();
  for (const relPath of scan.files) {
    const facts = factsMap.get(relPath);
    const dir = path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath);
    const moduleId = dir ? ensureModule(dir) : null;
    const importIds = [];
    const unresolvedImports = [];
    let typeImportCount = 0;
    const seen = new Set();
    for (const imp of facts.imports) {
      if (imp.isTypeOnly) typeImportCount += 1;
      const r = imp.resolved ?? resolver.resolve(relPath, imp.specifier);
      if (r.kind === 'internal') {
        if (!seen.has(`file:${r.file}`)) { importIds.push(`file:${r.file}`); seen.add(`file:${r.file}`); }
      } else if (r.kind === 'external') {
        if (!seen.has(`dep:${r.package}`)) { importIds.push(`dep:${r.package}`); seen.add(`dep:${r.package}`); }
      } else if (r.kind === 'unresolved') {
        if (!unresolvedImports.includes(imp.specifier)) unresolvedImports.push(imp.specifier);
      }
    }
    const stem = path.posix.basename(relPath).replace(/\.(tsx?|jsx?)$/, '');
    const obj = {
      id: `file:${relPath}`,
      name: path.posix.basename(relPath),
      path: relPath,
      ext: facts.ext,
      module: dir,
      moduleId,
      layer: dir ? moduleLayerOf(dir) : 'root',
      lineCount: facts.lineCount,
      isTest: isTestFile(relPath),
      isEntry: htmlEntries.has(relPath) || isEntryFile(relPath, entryRoots),
      isPageFile: stem.endsWith('Page') || (relPath.endsWith('.vue') && /\/(views|pages)\//.test(relPath)),
      importIds,
      typeImportCount,
      unresolvedImports,
      exportNames: facts.exportNames,
      opensOverlayIds: facts.overlayOpens.map((o) => o.target),
      reviewed: false,
      notes: null,
    };
    fileObjects.push(obj);
    fileObjectByPath.set(relPath, obj);
    if (moduleId) {
      const mod = modules.find((m) => m.id === moduleId);
      if (mod) mod.fileCount += 1;
    }
  }

  // 5. 组件 / Hook / Store / Service
  const components = [];
  const compIdByName = new Map();
  const compUsedIds = new Set();
  const hooks = [];
  const hookUsedIds = new Set();
  const stores = [];
  const storeUsedIds = new Set();
  const services = [];
  const svcUsedIds = new Set();
  const componentsByFile = new Map();

  for (const relPath of scan.files) {
    const facts = factsMap.get(relPath);
    const fileObj = fileObjectByPath.get(relPath);

    for (const comp of facts.components) {
      const id = uniqueId(`comp:${comp.name}`, compUsedIds);
      const isVuePage = relPath.endsWith('.vue') && /\/(views|pages)\//.test(relPath);
      components.push({
        id, name: comp.name,
        fileId: fileObj.id, filePath: relPath,
        kind: isVuePage && componentKind(comp.name) === 'common' ? 'page' : componentKind(comp.name),
        isDefaultExport: comp.isDefault,
        isPrimary: facts.primaryComponentName === comp.name,
        propsCount: comp.propsCount,
        hooksUsed: comp.hooksUsed,
        stateCount: comp.stateCount,
        lineCount: comp.lineCount,
        description: comp.description,
        rendersIds: [],
        routeIds: [],
        reviewed: false,
        notes: null,
      });
      compIdByName.set(comp.name, id);
      if (!componentsByFile.has(relPath)) componentsByFile.set(relPath, []);
      componentsByFile.get(relPath).push({ id, name: comp.name, isPrimary: facts.primaryComponentName === comp.name });
    }

    for (const hook of facts.hooks) {
      const id = uniqueId(`hook:${hook.name}`, hookUsedIds);
      hooks.push({
        id, name: hook.name,
        fileId: fileObj.id, filePath: relPath,
        lineCount: hook.lineCount,
        description: hook.description,
        reviewed: false, notes: null,
      });
    }

    for (const store of facts.stores) {
      const id = uniqueId(`store:${store.name}`, storeUsedIds);
      stores.push({
        id, name: store.name,
        fileId: fileObj.id, filePath: relPath,
        stateKeys: store.stateKeys,
        actionKeys: store.actionKeys,
        stateKeyCount: store.stateKeys.length,
        hasPersist: store.hasPersist,
        storageKey: store.storageKey,
        location: relPath.includes('/store/') ? 'store' : (relPath.includes('/services/') ? 'services' : 'other'),
        lineCount: store.lineCount,
        reviewed: false, notes: null,
      });
    }

    const isStoreFile = facts.stores.length > 0;
    const stem = path.posix.basename(relPath).replace(/\.(tsx?|jsx?)$/, '');
    const serviceish = !isStoreFile && (
      relPath.includes('/services/') || SERVICE_NAME_RE.test(stem)
    ) && !relPath.includes('/routes/');
    if (serviceish) {
      const id = uniqueId(`svc:${stem}`, svcUsedIds);
      services.push({
        id, name: stem,
        fileId: fileObj.id, filePath: relPath,
        pattern: facts.hasSingletonClass ? 'singleton' : (facts.hasClassExport ? 'class' : 'functions'),
        exportsCount: facts.exportNames.length,
        lineCount: facts.lineCount,
        reviewed: false, notes: null,
      });
    }
  }

  // 5b. 油猴脚本对象（UserScript / GmApiUsage / InjectionPoint / NetworkEndpoint / ScriptFunction）
  // 与 React/Vue 组件体系并存：油猴脚本不产出 Component/Store，而是产出注入点、网络端点与脚本函数
  const userScripts = [];
  const gmApiUsages = [];
  const injectionPoints = [];
  const networkEndpoints = [];
  const scriptFunctions = [];
  for (const relPath of scan.files) {
    const facts = factsMap.get(relPath);
    if (!facts?.isUserScript) continue;
    const meta = facts.meta ?? {};
    const fileObj = fileObjectByPath.get(relPath);
    const stem = path.posix.basename(relPath).replace(/\.user\.js$|\.m?js$/, '');
    const scriptName = meta.name ?? stem;
    const usId = `us:${relPath}`;

    // 函数对象（先建，调用边依赖 id 映射）
    const fnIdUsed = new Set();
    const fnIds = [];
    const fnIdMap = new Map();
    for (const fn of facts.functions ?? []) {
      const fnId = uniqueId(`fn:${relPath}#${fn.name}`, fnIdUsed);
      fnIdMap.set(fn.name, fnId);
      fnIds.push(fnId);
    }
    for (const fn of facts.functions ?? []) {
      scriptFunctions.push({
        id: fnIdMap.get(fn.name),
        name: fn.name,
        kind: fn.kind,
        owner: fn.owner ?? null,
        isTopLevel: fn.isTopLevel,
        line: fn.line,
        lineCount: fn.lineCount,
        callCount: fn.callCount,
        calledByCount: fn.calledByCount,
        roles: fn.roles ?? ['logic'],
        gmApiCalls: fn.gmApiCalls ?? [],
        gmApiCount: (fn.gmApiCalls ?? []).length,
        domOpCount: fn.domOpCount ?? 0,
        htmlInjectionCount: fn.htmlInjectionCount ?? 0,
        mountCount: fn.mountCount ?? 0,
        networkCallCount: fn.networkCallCount ?? 0,
        observerCount: fn.observerCount ?? 0,
        listenerCount: fn.listenerCount ?? 0,
        timerCount: fn.timerCount ?? 0,
        callIds: [],
        calledByIds: [],
        scriptId: usId,
        scriptName,
        filePath: relPath,
        reviewed: false, notes: null,
      });
    }
    // 调用边回填（from/to 均为已收集函数）
    for (const edge of facts.callEdges ?? []) {
      const fromId = fnIdMap.get(edge.from);
      if (!fromId) continue;
      const fromFn = scriptFunctions.find((f) => f.id === fromId);
      for (const t of edge.to) {
        const toId = fnIdMap.get(t.to);
        if (!toId || toId === fromId) continue;
        if (!fromFn.callIds.includes(toId)) fromFn.callIds.push(toId);
        const toFn = scriptFunctions.find((f) => f.id === toId);
        if (toFn && !toFn.calledByIds.includes(fromId)) toFn.calledByIds.push(fromId);
      }
    }

    // GM API 使用对象
    const gmIds = [];
    for (const gm of facts.gmApiCalls ?? []) {
      const gmId = `gm:${relPath}#${gm.name}`;
      gmIds.push(gmId);
      gmApiUsages.push({
        id: gmId,
        name: gm.name,
        category: gm.category,
        callCount: gm.callCount,
        lines: gm.lines,
        declared: gm.declared,
        scriptId: usId,
        scriptName,
        filePath: relPath,
        reviewed: false, notes: null,
      });
    }

    // DOM 注入点对象（fnIds = 执行注入的函数，逻辑注入链）
    const injectIds = [];
    const injectSorted = [...(facts.domInjections ?? [])].sort((a, b) => (b.callCount - a.callCount) || String(a.kind).localeCompare(String(b.kind)) || String(a.target).localeCompare(String(b.target)));
    injectSorted.forEach((inj, i) => {
      const injId = `inject:${relPath}#${i + 1}`;
      injectIds.push(injId);
      injectionPoints.push({
        id: injId,
        kind: inj.kind,
        target: inj.target,
        callCount: inj.callCount,
        lines: inj.lines,
        interpolated: !!inj.interpolated,
        fns: inj.fns ?? [],
        fnIds: (inj.fns ?? []).map((n) => fnIdMap.get(n)).filter(Boolean),
        scriptId: usId,
        scriptName,
        filePath: relPath,
        reviewed: false, notes: null,
      });
    });

    // 网络端点对象（fnIds = 发起请求的函数）
    const netIds = [];
    for (const net of facts.networkRequests ?? []) {
      const netId = `net:${relPath}#${net.kind}:${net.domain}`;
      netIds.push(netId);
      networkEndpoints.push({
        id: netId,
        kind: net.kind,
        domain: net.domain,
        urls: net.urls,
        methods: net.methods,
        callCount: net.callCount,
        lines: net.lines,
        allowedByConnect: net.allowedByConnect,
        fns: net.fns ?? [],
        fnIds: (net.fns ?? []).map((n) => fnIdMap.get(n)).filter(Boolean),
        scriptId: usId,
        scriptName,
        filePath: relPath,
        reviewed: false, notes: null,
      });
    }

    const observerCount = (facts.observers ?? []).length;
    const intervalCount = (facts.timers ?? []).filter((t) => t.kind === 'interval').length;
    const timeoutCount = (facts.timers ?? []).filter((t) => t.kind === 'timeout').length;
    userScripts.push({
      id: usId,
      name: scriptName,
      namespace: meta.namespace ?? null,
      version: meta.version ?? null,
      author: meta.author ?? null,
      description: meta.description ? meta.description.slice(0, 200) : null,
      license: meta.license ?? null,
      filePath: relPath,
      fileId: fileObj ? fileObj.id : `file:${relPath}`,
      matches: meta.matches ?? [],
      excludes: meta.excludes ?? [],
      grants: meta.grants ?? [],
      grantNone: !!meta.grantNone,
      connects: meta.connects ?? [],
      requires: meta.requires ?? [],
      resources: (meta.resources ?? []).map((r) => r.name),
      runAt: meta.runAt ?? 'document-idle(默认)',
      noframes: !!meta.noframes,
      lineCount: facts.lineCount,
      isIife: facts.isIife,
      usesStrict: facts.usesStrict,
      hostFramework: facts.hostFramework,
      hostMarkers: facts.hostMarkers ?? [],
      functionCount: (facts.functions ?? []).length,
      topLevelFunctionCount: (facts.functions ?? []).filter((f) => f.isTopLevel).length,
      gmApiCount: (facts.gmApiCalls ?? []).length,
      gmApiCallCount: (facts.gmApiCalls ?? []).reduce((a, g) => a + g.callCount, 0),
      injectionCount: (facts.domInjections ?? []).length,
      mountCount: (facts.domInjections ?? []).filter((d) => d.kind === 'mount').length,
      htmlInjectionCount: (facts.domInjections ?? []).filter((d) => d.kind === 'inner-html' || d.kind === 'insert-adjacent' || d.kind === 'document-write').length,
      networkEndpointCount: (facts.networkRequests ?? []).length,
      networkCallCount: (facts.networkRequests ?? []).reduce((a, n) => a + n.callCount, 0),
      hijackCount: (facts.hijacks ?? []).length,
      mutationObserverCount: observerCount,
      intervalCount,
      timeoutCount,
      listenerCount: (facts.listeners ?? []).length,
      lifecycleEvents: facts.lifecycleEvents ?? [],
      customEventsEmitted: facts.customEventsEmitted ?? [],
      customEventsListened: facts.customEventsListened ?? [],
      usesUnsafeWindow: (facts.unsafeWindowReads?.length ?? 0) + (facts.unsafeWindowWrites?.length ?? 0) > 0,
      unsafeWindowReads: facts.unsafeWindowReads ?? [],
      unsafeWindowWrites: facts.unsafeWindowWrites ?? [],
      windowExposes: facts.windowExposes ?? [],
      storageUsage: facts.storageUsage ?? {},
      createElementCount: facts.createElementCount ?? 0,
      styleElementCount: facts.styleElementCount ?? 0,
      gmAddStyleCount: facts.gmAddStyleCount ?? 0,
      topLevelCalls: facts.topLevelCalls ?? [],
      risks: facts.risks ?? [],
      riskCount: (facts.risks ?? []).length,
      riskLevel: facts.riskLevel ?? 'none',
      gmApiIds: gmIds,
      injectionIds: injectIds,
      networkIds: netIds,
      functionIds: fnIds,
      reviewed: false, notes: null,
    });
  }

  // 6. renders 关系：文件主组件的 JSX 标签 → 导入来源文件的组件
  for (const relPath of scan.files) {
    const facts = factsMap.get(relPath);
    if (!facts.primaryComponentName) continue;
    const primaryId = compIdByName.get(facts.primaryComponentName);
    if (!primaryId || !facts.jsxTags.size) continue;
    // local 名 → (目标文件, 导出名) 映射
    const localToExport = new Map();
    for (const imp of facts.imports) {
      if (!imp.resolved || imp.resolved.kind !== 'internal' || imp.isTypeOnly) continue;
      for (const n of imp.names) {
        if (n.local && n.imported && n.imported !== '*') {
          localToExport.set(n.local, { file: imp.resolved.file, exported: n.imported });
        }
      }
    }
    const primary = components.find((c) => c.id === primaryId);
    if (!primary) continue;
    for (const tag of facts.jsxTags) {
      const target = localToExport.get(tag);
      if (!target) continue;
      const targetComps = componentsByFile.get(target.file) ?? [];
      const hit = targetComps.find((c) => c.name === target.exported) ?? targetComps.find((c) => c.name === tag);
      if (hit && hit.id !== primaryId && !primary.rendersIds.includes(hit.id)) {
        primary.rendersIds.push(hit.id);
      }
    }
  }

  // 7. Overlay 路由（自定义 overlayGroups/lazyImports 体系）+ React JSX 声明式路由（react-router <Routes>/<Route>）
  const rawRoutes = [
    ...analyzeOverlayRoutes(projectRoot, resolver, getFacts, scan.files),
    ...analyzeJsxRoutes(projectRoot, resolver, getFacts, scan.files),
  ];
  const knownRouteIds = new Set(rawRoutes.map((r) => r.overlayId));
  const routeIdsUsed = new Set();
  const routes = [];
  const lazyReferencedFiles = new Set();
  for (const [relPath, facts] of factsMap) {
    for (const w of facts.lazyWrappers) {
      const r = resolver.resolve(relPath, w.importPath);
      if (r.kind === 'internal') lazyReferencedFiles.add(r.file);
    }
  }
  for (const route of rawRoutes) {
    const componentFile = route.componentFile;
    if (componentFile) lazyReferencedFiles.add(componentFile);
    let navigatesTo = [...route.factoryNavigatesTo];
    if (componentFile && factsMap.has(componentFile)) {
      navigatesTo.push(...factsMap.get(componentFile).overlayOpens.map((o) => o.target));
    }
    navigatesTo = [...new Set(navigatesTo)].filter((id) => knownRouteIds.has(id));
    const compId = componentFile
      ? ((componentsByFile.get(componentFile) ?? []).find((c) => c.isPrimary)?.id
        ?? (componentsByFile.get(componentFile) ?? [])[0]?.id ?? null)
      : null;
    const routeId = uniqueId(`route:${route.overlayId}`, routeIdsUsed);
    routes.push({
      id: routeId,
      overlayId: route.overlayId,
      name: route.overlayId,
      routePath: route.routePath,
      backTarget: route.backTarget,
      hidesNav: route.hidesNav,
      domain: route.domain,
      group: route.group,
      componentRef: route.componentRef,
      componentFileId: componentFile ? `file:${componentFile}` : null,
      componentId: compId,
      navigatesToIds: navigatesTo.map((id) => `route:${id}`),
      hasPropsFactory: route.hasPropsFactory,
      routeType: route.routeType ?? 'overlay',
      reviewed: false, notes: null,
    });
    if (compId) {
      const comp = components.find((c) => c.id === compId);
      if (comp) {
        comp.routeIds.push(routeId);
        // React 页面组件升级：pages/ 目录下被路由直接引用的 common 组件视为 page
        if (route.routeType === 'react' && comp.kind === 'common' && comp.filePath?.includes('/pages/')) {
          comp.kind = 'page';
        }
      }
    }
  }

  // 7b. Vue Router 路由：RouteRecordRaw 显式声明 + views/pages 下 .vue 文件路由推导
  const vueRoutes = [];
  const explicitRouteFiles = new Set();
  for (const [relPath, facts] of factsMap) {
    for (const vr of facts.vueRoutes ?? []) {
      let componentFile = null;
      if (vr.specifier) {
        const r = resolver.resolve(relPath, vr.specifier);
        if (r.kind === 'internal') componentFile = r.file;
      }
      if (componentFile) explicitRouteFiles.add(componentFile);
      vueRoutes.push({ ...vr, componentFile, fromFile: relPath, fileBased: false });
    }
  }
  for (const relPath of scan.files) {
    if (!relPath.endsWith('.vue')) continue;
    if (explicitRouteFiles.has(relPath)) continue;
    const m = relPath.match(/^src\/(views|pages)\/(.+\.vue)$/);
    if (!m) continue;
    let rest = m[2].replace(/\/index\.vue$/, '').replace(/\.vue$/, '');
    if (rest === 'index') rest = ''; // src/views/index.vue → 根路径 '/'
    let routePath = rest ? `/${rest}` : '/';
    if (rest.includes('[')) routePath = '/:pathMatch(.*)*'; // [...all].vue catch-all
    const facts = factsMap.get(relPath);
    vueRoutes.push({
      path: routePath,
      name: facts.vueRouteMeta?.name ?? null,
      metaTitle: facts.vueRouteMeta?.title ?? null,
      componentRef: relPath,
      specifier: null,
      componentFile: relPath,
      fromFile: relPath,
      fileBased: true,
    });
  }
  const vueRouteIds = new Set();
  const vueRouteByPath = new Map();
  for (const vr of vueRoutes) {
    const id = uniqueId(`route:${vr.path}`, vueRouteIds);
    vueRouteByPath.set(vr.path, id);
    const compId = vr.componentFile
      ? ((componentsByFile.get(vr.componentFile) ?? []).find((c) => c.isPrimary)?.id
        ?? (componentsByFile.get(vr.componentFile) ?? [])[0]?.id ?? null)
      : null;
    const seg = vr.path.split('/').filter(Boolean)[0];
    // 顶层段为动态参数（:id）或 catch-all（(.*)）时无稳定语义，归入 root
    const domain = !seg || seg.startsWith(':') || seg.includes('(') ? 'root' : seg;
    routes.push({
      id,
      overlayId: vr.path,
      name: vr.name ?? vr.path,
      routePath: vr.path,
      backTarget: null,
      hidesNav: null,
      domain,
      group: vr.fromFile,
      componentRef: vr.componentRef,
      componentFileId: vr.componentFile ? `file:${vr.componentFile}` : null,
      componentId: compId,
      navigatesToIds: [],
      hasPropsFactory: false,
      routeType: 'vue',
      description: vr.metaTitle ?? null,
      reviewed: false, notes: null,
    });
    if (compId) {
      const comp = components.find((c) => c.id === compId);
      if (comp) comp.routeIds.push(id);
    }
  }

  // 7c. vue-router 导航边：文件内 router.push('/path') 调用 → 文件所属路由 → 目标路由
  const vueRouteOwner = new Map();
  for (const vr of vueRoutes) {
    if (!vr.componentFile) continue;
    if (!vueRouteOwner.has(vr.componentFile)) vueRouteOwner.set(vr.componentFile, []);
    vueRouteOwner.get(vr.componentFile).push(vueRouteByPath.get(vr.path));
  }
  for (const [relPath, facts] of factsMap) {
    const ownerIds = vueRouteOwner.get(relPath);
    if (!ownerIds || ownerIds.length === 0) continue;
    for (const o of facts.overlayOpens) {
      if (!o.target.startsWith('/')) continue; // 仅 Vue 路由 path（React overlay id 不参与）
      const toId = vueRouteByPath.get(o.target);
      if (!toId) continue;
      for (const ownerId of ownerIds) {
        const route = routes.find((r) => r.id === ownerId);
        if (route && !route.navigatesToIds.includes(toId)) route.navigatesToIds.push(toId);
      }
    }
  }

  // 7d. 语义富化：文件级架构分层 → 功能域聚合 → 模块职责画像 → 单元归属回填
  //     分类以内容信号为准（单元构成/路由归属/引用结构），目录名仅作弱信号兜底
  const importersOf = new Map(); // fileId -> Set(importerFileIds)
  for (const f of fileObjects) {
    for (const id of f.importIds) {
      if (!id.startsWith('file:')) continue;
      if (!importersOf.has(id)) importersOf.set(id, new Set());
      importersOf.get(id).add(f.id);
    }
  }
  const fileArchLayer = new Map(); // relPath -> archLayer
  for (const f of fileObjects) {
    const facts = factsMap.get(f.path);
    const archLayer = inferFileArchLayer({
      relPath: f.path,
      isUserScript: !!facts?.isUserScript,
      isTest: f.isTest,
      isEntry: f.isEntry,
      componentCount: facts?.components?.length ?? 0,
      storeCount: facts?.stores?.length ?? 0,
      hookCount: facts?.hooks?.length ?? 0,
    });
    f.archLayer = archLayer;
    fileArchLayer.set(f.path, archLayer);
  }

  // 功能域：路由域段 + 业务命名目录 → Domain（与纵向架构层正交的横向功能切片）
  const { domains, fileDomainIds, moduleDomainIds } = buildDomains({
    routes, modules, fileObjects, components, stores, hooks, services, userScripts,
  });

  // 模块子树（文件集合 + 层构成 + 单元构成 + 外部引用）
  const moduleSubtreeFiles = new Map(); // moduleId -> Set<relPath>
  for (const m of modules) {
    const set = new Set();
    for (const f of fileObjects) {
      if (f.path === m.path || f.path.startsWith(`${m.path}/`)) set.add(f.path);
    }
    moduleSubtreeFiles.set(m.id, set);
  }
  const moduleChainOf = (relPath) => {
    const chain = [];
    let dir = path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath);
    while (dir && dir !== '.') {
      chain.push(`mod:${dir}`);
      const parent = path.posix.dirname(dir);
      if (parent === '.') break;
      dir = parent;
    }
    return chain;
  };
  const moduleById = new Map(modules.map((m) => [m.id, m]));
  const bumpUnits = (relPath, key, extra = 0) => {
    for (const modId of moduleChainOf(relPath)) {
      const mod = moduleById.get(modId);
      if (!mod) continue;
      mod.unitCounts[key] = (mod.unitCounts[key] ?? 0) + 1;
      if (extra) mod.unitCounts[extra] = (mod.unitCounts[extra] ?? 0) + 1;
    }
  };
  for (const m of modules) {
    m.layerComposition = {};
    m.unitCounts = {};
  }
  for (const f of fileObjects) {
    for (const modId of moduleChainOf(f.path)) {
      const mod = moduleById.get(modId);
      if (mod) mod.layerComposition[f.archLayer] = (mod.layerComposition[f.archLayer] ?? 0) + 1;
    }
  }
  for (const c of components) bumpUnits(c.filePath, 'component', c.kind === 'page' ? 'page' : null);
  for (const h of hooks) bumpUnits(h.filePath, 'hook');
  for (const s of stores) bumpUnits(s.filePath, 'store');
  for (const s of services) bumpUnits(s.filePath, 'service');
  for (const fn of scriptFunctions) bumpUnits(fn.filePath, 'scriptFunction');
  for (const us of userScripts) bumpUnits(us.filePath, 'userScript');

  for (const m of modules) {
    const subtree = moduleSubtreeFiles.get(m.id);
    const { archLayer, dominantShare } = inferModuleArchLayer(m.layerComposition);
    m.archLayer = archLayer;
    m.archLayerLabel = ARCH_LAYERS[archLayer]?.label ?? null;
    m.dominantShare = Math.round(dominantShare * 100);
    m.subtreeFileCount = subtree.size;
    m.unitCount = Object.values(m.unitCounts).reduce((a, b) => a + b, 0);
    m.domainIds = moduleDomainIds.get(m.path) ?? [];
    m.routeCount = 0;
    for (const r of routes) {
      const fp = r.componentFileId?.slice(5);
      if (fp && subtree.has(fp)) m.routeCount += 1;
    }
    m.externalImportedByCount = 0;
    for (const fp of subtree) {
      for (const importerId of importersOf.get(`file:${fp}`) ?? []) {
        if (!subtree.has(importerId.slice(5))) m.externalImportedByCount += 1;
      }
    }
    m.summary = summarizeModule(m);
  }

  // 单元级归属回填：架构层（继承所在文件）+ 功能域
  for (const c of components) {
    c.archLayer = fileArchLayer.get(c.filePath) ?? null;
    c.domainIds = fileDomainIds.get(c.filePath) ?? [];
  }
  for (const h of hooks) {
    h.archLayer = fileArchLayer.get(h.filePath) ?? null;
    h.domainIds = fileDomainIds.get(h.filePath) ?? [];
  }
  for (const s of stores) {
    s.archLayer = fileArchLayer.get(s.filePath) ?? null;
    s.domainIds = fileDomainIds.get(s.filePath) ?? [];
  }
  for (const s of services) {
    s.archLayer = fileArchLayer.get(s.filePath) ?? null;
    s.domainIds = fileDomainIds.get(s.filePath) ?? [];
  }
  for (const us of userScripts) {
    us.archLayer = 'script';
    us.domainIds = fileDomainIds.get(us.filePath) ?? [];
  }
  for (const fn of scriptFunctions) fn.archLayer = 'script';

  // 8. 死代码候选与循环依赖
  const importedByCount = new Map();
  for (const f of fileObjects) {
    for (const id of f.importIds) {
      if (id.startsWith('file:')) importedByCount.set(id, (importedByCount.get(id) ?? 0) + 1);
    }
  }
  const routeComponentFiles = new Set(routes.map((r) => r.componentFileId).filter(Boolean));
  const orphanCandidates = fileObjects
    .filter((f) => f.path.startsWith('src/')
      && !f.isTest && !f.isEntry
      && !routeComponentFiles.has(f.id)
      && !lazyReferencedFiles.has(f.path)
      && (importedByCount.get(f.id) ?? 0) === 0)
    .map((f) => f.path);
  const cycles = findCycles(fileObjects);

  // 9. 汇总
  const project = {
    id: `proj:${scan.name}`,
    name: scan.name,
    version: scan.version,
    path: scan.root,
    framework: scan.framework,
    frameworkVariants: scan.frameworkVariants ?? [],
    frameworkLabel: scan.frameworkLabel ?? scan.framework,
    hostRoot: scan.hostRoot ?? null,
    hostConfigs: scan.hostConfigs ?? [],
    language: 'TypeScript',
    commitHash: scan.commitHash,
    branch: scan.branch,
    fileCount: scan.fileCount,
    tsFileCount: scan.tsFileCount,
    tsxFileCount: scan.tsxFileCount,
    jsFileCount: scan.jsFileCount,
    vueFileCount: scan.vueFileCount,
    userScriptFileCount: scan.userScriptFileCount ?? 0,
    analysisErrors,
    reviewed: false, notes: null,
  };

  // 9b. 项目级架构画像：分层结构 / 架构风格 / 健康度 / 能力清单 / 自然语言总结
  const profile = buildProjectProfile({
    framework: scan.framework,
    frameworkLabel: project.frameworkLabel,
    fileObjects, modules, domains, routes,
    components, stores, hooks, services, userScripts,
    dependencies, cycles, orphanCandidates, analysisErrors,
  });
  project.architecture = profile.architecture;
  project.health = profile.health;
  project.capabilities = profile.capabilities;
  project.summary = profile.summary;

  const dataMap = {
    _meta: {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      cycles,
      orphanCandidates,
      objectCounts: {
        Module: modules.length, SourceFile: fileObjects.length, Component: components.length,
        Hook: hooks.length, Store: stores.length, Service: services.length,
        Route: routes.length, Dependency: dependencies.length,
        UserScript: userScripts.length, GmApiUsage: gmApiUsages.length,
        InjectionPoint: injectionPoints.length, NetworkEndpoint: networkEndpoints.length,
        ScriptFunction: scriptFunctions.length, Domain: domains.length,
      },
    },
    Project: [project],
    Module: modules,
    SourceFile: fileObjects,
    Component: components,
    Hook: hooks,
    Store: stores,
    Service: services,
    Route: routes,
    Dependency: dependencies,
    UserScript: userScripts,
    GmApiUsage: gmApiUsages,
    InjectionPoint: injectionPoints,
    NetworkEndpoint: networkEndpoints,
    ScriptFunction: scriptFunctions,
    Domain: domains,
  };
  return dataMap;
}
