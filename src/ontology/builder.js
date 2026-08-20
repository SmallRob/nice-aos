import path from 'node:path';
import { scanProject } from '../analyzers/projectScanner.js';
import { createResolver } from '../analyzers/importResolver.js';
import { analyzeFileFromDisk } from '../analyzers/tsAnalyzer.js';
import { analyzeVueFileFromDisk } from '../analyzers/vueAnalyzer.js';
import { analyzeOverlayRoutes, analyzeJsxRoutes } from '../analyzers/overlayAnalyzer.js';

const KIND_SUFFIXES = [
  ['Page', 'page'], ['Modal', 'modal'], ['Dialog', 'dialog'], ['Card', 'card'],
  ['Chart', 'chart'], ['Form', 'form'], ['Detail', 'detail'], ['Details', 'detail'],
  ['Panel', 'panel'], ['Section', 'section'], ['List', 'list'], ['Item', 'item'],
  ['Button', 'button'], ['Widget', 'widget'], ['View', 'view'], ['Provider', 'provider'],
  ['Overlay', 'overlay'], ['Tab', 'tab'], ['Picker', 'picker'], ['Badge', 'badge'],
];
const ENTRY_FILES = new Set(['src/App.tsx', 'src/index.tsx', 'src/main.tsx', 'src/index.ts', 'src/main.ts', 'src/main.js', 'src/App.vue']);
const SERVICE_NAME_RE = /(Service|Engine|Manager|Repository|Factory)$/;

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
  const resolver = createResolver(projectRoot, scan.tsconfigPaths, scan.files);

  // 1. 逐文件解析（TypeScript Compiler API，仅词法/语法层，不做类型检查）
  const factsMap = new Map();
  const analysisErrors = [];
  const getFacts = (relPath) => {
    if (factsMap.has(relPath)) return factsMap.get(relPath);
    try {
      const facts = relPath.endsWith('.vue')
        ? analyzeVueFileFromDisk(relPath, projectRoot)
        : analyzeFileFromDisk(relPath, projectRoot);
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
      isEntry: ENTRY_FILES.has(relPath),
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
    language: 'TypeScript',
    commitHash: scan.commitHash,
    branch: scan.branch,
    fileCount: scan.fileCount,
    tsFileCount: scan.tsFileCount,
    tsxFileCount: scan.tsxFileCount,
    jsFileCount: scan.jsFileCount,
    vueFileCount: scan.vueFileCount,
    analysisErrors,
    reviewed: false, notes: null,
  };

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
  };
  return dataMap;
}
