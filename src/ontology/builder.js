import path from 'node:path';
import fs from 'node:fs';
import { scanProject } from '../analyzers/projectScanner.js';
import { createResolver } from '../analyzers/importResolver.js';
import { analyzeFileFromDisk } from '../analyzers/tsAnalyzer.js';
import { analyzeVueFileFromDisk } from '../analyzers/vueAnalyzer.js';
import { analyzeUserScriptFromDisk, isUserScriptCandidate } from '../analyzers/userScriptAnalyzer.js';
import { analyzeRustFileFromDisk, analyzeRustFile, resolveRustUse } from '../analyzers/rustAnalyzer.js';
import { analyzeOverlayRoutes, analyzeJsxRoutes, analyzeDataRouterRoutes } from '../analyzers/overlayAnalyzer.js';
import { analyzeNextAppRoutes } from '../analyzers/nextAppAnalyzer.js';
import { analyzeDartFile, analyzeDartFileFromDisk } from '../analyzers/dartAnalyzer.js';
import { analyzeGoFile, analyzeGoFileFromDisk } from '../analyzers/goAnalyzer.js';
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
const ENTRY_BASENAMES = new Set(['App.tsx', 'index.tsx', 'main.tsx', 'index.ts', 'main.ts', 'main.js', 'App.vue', 'main.dart', 'main.go']);
const SERVICE_NAME_RE = /(Service|Engine|Manager|Repository|Factory)$/;

// 入口识别：位于任一扫描根顶层的常见入口文件名（多根 monorepo 每个根均可有自己的入口）
function isEntryFile(relPath, roots) {
  if (!ENTRY_BASENAMES.has(path.posix.basename(relPath))) return false;
  if (relPath.endsWith('.go')) return true; // Go 每个 main.go 都是二进制入口（cmd/<name>/main.go 惯例）
  const dir = path.posix.dirname(relPath);
  return roots.some((r) => dir === r || dir === r.replace(/\/+$/, ''));
}

function componentKind(name) {
  for (const [suffix, kind] of KIND_SUFFIXES) {
    if (name.endsWith(suffix)) return kind;
  }
  return 'common';
}

// kebab-case / camelCase → PascalCase（Vue 标签/注册键/导入名统一规范形式）
function pascalCaseName(s) {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

function moduleLayerOf(dir) {
  const parts = dir.split('/');
  if (parts[0] === 'src') return parts[1] ?? 'src';
  return parts[0];
}

function dirOf(relPath) {
  const d = path.posix.dirname(relPath);
  return d === '.' ? '' : d;
}

// Go import 解析（URL 风格路径语义与 npm 不同，不走通用 resolver）：
//   module 前缀命中 → internal（目标 = package 目录下全部 .go 文件，Go 包以目录为单位）；
//   首段不含 '.' → 标准库 builtin；其余 → external（go.mod require 最长前缀匹配定包名，未声明取整路径）。
// goModuleDir 为 go.mod 所在目录（相对 projectRoot）：''（根）/ 'server'（子目录）/
// '../..'（用户定位到 module 子目录，基准在上级）——import 目录用 path.resolve 折叠后转回相对路径
function createGoImportResolver(goFiles, goModuleName, goDepNames, goModuleDir, projectRoot) {
  const dirFilesCache = new Map();
  const filesOfDir = (dir) => {
    if (dirFilesCache.has(dir)) return dirFilesCache.get(dir);
    const prefix = dir === '' ? '' : `${dir}/`;
    const files = [...goFiles]
      .filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'))
      .sort();
    dirFilesCache.set(dir, files);
    return files;
  };
  const moduleDirOf = (rel) => {
    if (!rel) return goModuleDir || '';
    if (!goModuleDir) return rel;
    const abs = path.resolve(projectRoot, goModuleDir, rel);
    return path.relative(path.resolve(projectRoot), abs).split(path.sep).join('/');
  };
  return {
    filesOfDir,
    resolve(specifier) {
      if (goModuleName && (specifier === goModuleName || specifier.startsWith(`${goModuleName}/`))) {
        const rel = specifier === goModuleName ? '' : specifier.slice(goModuleName.length + 1);
        const dir = moduleDirOf(rel);
        const files = filesOfDir(dir);
        if (files.length > 0) return { kind: 'internal', files, file: files[0], dir };
        // 目录无直下 .go 文件但子树有（纯分组目录，handlerChain 子树搜索仍可用）
        const subtree = [...goFiles].some((f) => f.startsWith(`${dir}/`));
        if (subtree) return { kind: 'internal', files: [], file: null, dir };
        return { kind: 'unresolved', specifier, attempted: dir };
      }
      const first = specifier.split('/')[0];
      if (!first.includes('.')) return { kind: 'builtin', module: specifier };
      let pkg = null;
      for (const dep of goDepNames) {
        if ((specifier === dep || specifier.startsWith(`${dep}/`)) && (!pkg || dep.length > pkg.length)) pkg = dep;
      }
      return { kind: 'external', package: pkg ?? specifier, specifier };
    },
  };
}

function isTestFile(relPath) {
  if (relPath.endsWith('_test.go')) return true; // Go 测试文件惯例
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

// 类型实体收集（Interface/Class/Method）：单文件分析（buildSingleFileOntology）与全仓库扫描共用
// 引用计数：名字在本文件出现、且位于实体声明范围之外的位置数（排除声明自身与自递归，宁可漏报不误报）
function collectTypeEntities(relPaths, factsMap, fileObjectByPath) {
  const interfaces = [];
  const classes = [];
  const methods = [];
  const ifaceIdUsed = new Set();
  const classIdUsed = new Set();
  const methodIdUsed = new Set();
  const localTypesByFile = new Map(); // relPath -> Map(name -> id)，本文件全部类型（含未导出）
  const typeSpanById = new Map();     // id -> {pos, end}，声明范围（用于引用计数，不进快照）
  const refsOutsideSpan = (relPath, name, start, end) => {
    const positions = factsMap.get(relPath)?.nameReferences?.get(name) ?? [];
    return positions.filter((p) => p < start || p >= end).length;
  };
  const registerLocalType = (relPath, name, id) => {
    if (!localTypesByFile.has(relPath)) localTypesByFile.set(relPath, new Map());
    localTypesByFile.get(relPath).set(name, id);
  };

  for (const relPath of relPaths) {
    const facts = factsMap.get(relPath);
    const fileObj = fileObjectByPath.get(relPath);
    if (!fileObj) continue;

    for (const iface of facts.interfaces ?? []) {
      const id = uniqueId(`iface:${relPath}#${iface.name}`, ifaceIdUsed);
      registerLocalType(relPath, iface.name, id);
      typeSpanById.set(id, { pos: iface.pos, end: iface.end });
      const entity = {
        id, name: iface.name,
        fileId: fileObj.id, filePath: relPath,
        line: iface.line,
        exported: iface.exported,
        language: iface.language ?? 'ts',
        methodIds: [],
        extendsIds: [],
        extendsNames: iface.extendsNames,
        deadCandidate: false, deadReason: null,
        reviewed: false, notes: null,
      };
      for (const m of iface.methods) {
        const mid = uniqueId(`method:${relPath}#${iface.name}#${m.name}`, methodIdUsed);
        methods.push({
          id: mid, name: m.name,
          ownerKind: 'interface', ownerId: id, ownerName: iface.name,
          fileId: fileObj.id, filePath: relPath,
          line: m.line,
          isStatic: false, isAsync: false, isOverride: false, exported: false,
          signature: m.signature,
          overridesId: null, overriddenByIds: [],
          deadCandidate: false, deadReason: null, // 接口方法为契约声明，永不判死
          reviewed: false, notes: null,
        });
        entity.methodIds.push(mid);
      }
      // 非导出接口：本文件内零引用 → 死代码候选（导出实体的全仓库零导入检测在调用方统一做）
      if (!iface.exported && refsOutsideSpan(relPath, iface.name, iface.pos, iface.end) === 0) {
        entity.deadCandidate = true;
        entity.deadReason = '本文件内零引用';
      }
      interfaces.push(entity);
    }

    for (const cls of facts.classes ?? []) {
      const id = uniqueId(`class:${relPath}#${cls.name}`, classIdUsed);
      registerLocalType(relPath, cls.name, id);
      typeSpanById.set(id, { pos: cls.pos, end: cls.end });
      const entity = {
        id, name: cls.name,
        fileId: fileObj.id, filePath: relPath,
        line: cls.line,
        exported: cls.exported,
        language: cls.language ?? 'ts',
        kind: cls.kind ?? 'class',
        derives: cls.derives ?? [],
        fields: cls.fields ?? [],
        variants: cls.variants ?? [],
        isSingleton: cls.isSingleton,
        isWidget: cls.isWidget ?? false,
        widgetBase: cls.widgetBase ?? null,
        isStore: cls.isStore ?? false,
        withNames: cls.withNames ?? [],
        methodIds: [],
        implementsIds: [],
        implementsNames: cls.implementsNames,
        extendsId: null, extendsName: cls.extendsName,
        deadCandidate: false, deadReason: null,
        reviewed: false, notes: null,
      };
      for (const m of cls.methods) {
        const mid = uniqueId(`method:${relPath}#${cls.name}#${m.name}`, methodIdUsed);
        const methodEntity = {
          id: mid, name: m.name,
          ownerKind: 'class', ownerId: id, ownerName: cls.name,
          fileId: fileObj.id, filePath: relPath,
          line: m.line,
          isStatic: m.isStatic, isAsync: m.isAsync, isOverride: m.isOverride, exported: false,
          signature: m.signature,
          overridesId: null, overriddenByIds: [],
          deadCandidate: false, deadReason: null,
          reviewed: false, notes: null,
        };
        // 非导出类的方法可能仅被本文件调用：本文件内零引用才判死（导出类方法可能被外部调用，不判死）
        if (!cls.exported && refsOutsideSpan(relPath, m.name, m.pos, m.end) === 0) {
          methodEntity.deadCandidate = true;
          methodEntity.deadReason = '本文件内零引用';
        }
        methods.push(methodEntity);
        entity.methodIds.push(mid);
      }
      if (!cls.exported && refsOutsideSpan(relPath, cls.name, cls.pos, cls.end) === 0) {
        entity.deadCandidate = true;
        entity.deadReason = '本文件内零引用';
      }
      classes.push(entity);
    }

    for (const fn of facts.moduleFunctions ?? []) {
      const id = uniqueId(`method:${relPath}#${fn.name}`, methodIdUsed);
      typeSpanById.set(id, { pos: fn.pos, end: fn.end });
      const entity = {
        id, name: fn.name,
        ownerKind: 'module', ownerId: fileObj.id, ownerName: null,
        fileId: fileObj.id, filePath: relPath,
        line: fn.line,
        isStatic: false, isAsync: fn.isAsync, isOverride: false,
        exported: fn.exported,
        signature: fn.signature,
        overridesId: null, overriddenByIds: [],
        deadCandidate: false, deadReason: null,
        reviewed: false, notes: null,
      };
      // 非导出函数：本文件零引用即死；导出函数的判定在调用方全仓库零导入检测统一做
      if (!fn.exported && refsOutsideSpan(relPath, fn.name, fn.pos, fn.end) === 0) {
        entity.deadCandidate = true;
        entity.deadReason = '本文件内零引用';
      }
      methods.push(entity);
    }
  }
  return { interfaces, classes, methods, localTypesByFile, typeSpanById, refsOutsideSpan };
}

// 方法级 overrides：实现类方法与其实现接口/父类中的同名方法建立双向链接
function linkMethodOverrides(interfaces, classes, methods) {
  const methodById = new Map(methods.map((m) => [m.id, m]));
  const ifaceById = new Map(interfaces.map((i) => [i.id, i]));
  const classById = new Map(classes.map((c) => [c.id, c]));
  const linkOverride = (implId, contractId) => {
    const impl = methodById.get(implId);
    const contract = methodById.get(contractId);
    if (!impl || !contract || impl.id === contract.id) return;
    impl.overridesId = contract.id;
    if (!contract.overriddenByIds.includes(impl.id)) contract.overriddenByIds.push(impl.id);
  };
  for (const cls of classes) {
    const parents = [
      ...cls.implementsIds.map((id) => ifaceById.get(id)),
      ...(cls.extendsId ? [classById.get(cls.extendsId)] : []),
    ].filter(Boolean);
    for (const parent of parents) {
      for (const mid of cls.methodIds) {
        const m = methodById.get(mid);
        const parentMethod = parent.methodIds
          .map((id) => methodById.get(id))
          .find((pm) => pm && pm.name === m.name);
        if (parentMethod) linkOverride(mid, parentMethod.id);
      }
    }
  }
}

// 单个油猴脚本的五类对象（UserScript/GmApiUsage/InjectionPoint/NetworkEndpoint/ScriptFunction）
// 单文件分析（buildSingleFileOntology）与全仓库扫描共用
function buildUserScriptObjects(relPath, facts, fileObj) {
  const meta = facts.meta ?? {};
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
  // 函数级死代码候选：名字在声明范围外零出现（直调 / 回调传值 / 顶层调用均会留下标识符引用）；
  // 调用图零入边兜底（obj['fn']() 字符串键调用不产生标识符引用）；constructor 与事件角色函数豁免
  const topLevelCalled = new Set((facts.topLevelCalls ?? []).map((t) => t.name));
  const scriptFunctions = [];
  for (const fn of facts.functions ?? []) {
    const shortName = fn.name.includes('.') ? fn.name.slice(fn.name.lastIndexOf('.') + 1) : fn.name;
    const positions = facts.nameReferences?.get(shortName) ?? [];
    const outside = positions.filter((p) => p < fn.pos || p >= fn.end).length;
    let deadCandidate = false;
    let deadReason = null;
    if (outside === 0 && fn.calledByCount === 0 && !topLevelCalled.has(fn.name)
      && !fn.name.endsWith('.constructor') && !(fn.roles ?? []).includes('event')) {
      deadCandidate = true;
      deadReason = '全文零引用（排除声明与自身函数体）';
    }
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
      deadCandidate,
      deadReason,
      callIds: [],
      calledByIds: [],
      scriptId: usId,
      scriptName,
      filePath: relPath,
      reviewed: false, notes: null,
    });
  }
  // 调用边回填（from/to 均为已收集函数）
  const fnById = new Map(scriptFunctions.map((f) => [f.id, f]));
  for (const edge of facts.callEdges ?? []) {
    const fromFn = fnById.get(fnIdMap.get(edge.from));
    if (!fromFn) continue;
    for (const t of edge.to) {
      const toId = fnIdMap.get(t.to);
      if (!toId || toId === fromFn.id) continue;
      if (!fromFn.callIds.includes(toId)) fromFn.callIds.push(toId);
      const toFn = fnById.get(toId);
      if (toFn && !toFn.calledByIds.includes(fromFn.id)) toFn.calledByIds.push(fromFn.id);
    }
  }

  // GM API 使用对象
  const gmApiUsages = [];
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
  const injectionPoints = [];
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
  const networkEndpoints = [];
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
  const userScript = {
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
    deadFunctionCount: scriptFunctions.filter((f) => f.deadCandidate).length,
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
  };
  return { userScript, gmApiUsages, injectionPoints, networkEndpoints, scriptFunctions };
}

export async function buildOntologyData(projectRoot, options = {}) {
  const startedAt = Date.now();
  const scan = scanProject(projectRoot, options);
  // 入口识别使用实际扫描根（显式 roots 或默认 src/）；根级入口名在每个根顶层均有效
  const entryRoots = scan.roots ?? ['src'];
  const htmlEntries = new Set(scan.htmlEntryFiles ?? []);
  const resolver = createResolver(projectRoot, scan.tsconfigPaths, scan.files, scan.pubspecName ?? null);

  // 1. 逐文件解析（TypeScript Compiler API，仅词法/语法层，不做类型检查）
  // 路由：.rs → rustAnalyzer；.go → goAnalyzer；.dart → dartAnalyzer；.vue → vueAnalyzer；油猴脚本 → userScriptAnalyzer；其余 → tsAnalyzer（平级、逻辑独立）
  const rustFiles = new Set(scan.files.filter((f) => f.endsWith('.rs')));
  const goFiles = new Set(scan.files.filter((f) => f.endsWith('.go')));
  const goResolver = createGoImportResolver(
    goFiles,
    scan.goModule?.name ?? null,
    Object.entries(scan.dependencies ?? {}).filter(([, info]) => info.registry === 'go').map(([n]) => n),
    scan.goModule?.dir || '',
    projectRoot,
  );
  const factsMap = new Map();
  const analysisErrors = [];
  const getFacts = (relPath) => {
    if (factsMap.has(relPath)) return factsMap.get(relPath);
    try {
      const facts = relPath.endsWith('.rs')
        ? analyzeRustFileFromDisk(relPath, projectRoot)
        : relPath.endsWith('.go')
          ? analyzeGoFileFromDisk(relPath, projectRoot)
          : relPath.endsWith('.dart')
            ? analyzeDartFileFromDisk(relPath, projectRoot)
            : relPath.endsWith('.vue')
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
        interfaces: [], classes: [], moduleFunctions: [],
      };
      factsMap.set(relPath, empty);
      return empty;
    }
  };
  for (const file of scan.files) getFacts(file);

  // Rust use 路径解析器（crate::a::b::Name → 目标 .rs 文件；serde::X → Rust 外部 crate，不进 npm 依赖体系）
  const resolveRustImport = (relPath, specifier) => resolveRustUse(relPath, specifier, rustFiles);

  // 2. 依赖对象（package.json 声明 + 代码中实际导入；Rust 外部 crate 为 Cargo.toml 管辖，不计入）
  const depUsedCount = new Map();
  const externalImports = new Map(); // package -> Set<specifier>
  for (const [relPath, facts] of factsMap) {
    const isRust = relPath.endsWith('.rs');
    const isGo = relPath.endsWith('.go');
    for (const imp of facts.imports) {
      if (isRust) {
        const r = resolveRustImport(relPath, imp.specifier);
        imp.resolved = r.kind === 'internal' || r.kind === 'unresolved' ? r : { kind: 'rust-external', package: r.package };
        continue;
      }
      if (isGo) {
        const r = goResolver.resolve(imp.specifier);
        imp.resolved = r;
        if (r.kind === 'external') {
          depUsedCount.set(r.package, (depUsedCount.get(r.package) ?? 0) + 1);
          if (!externalImports.has(r.package)) externalImports.set(r.package, new Set());
          externalImports.get(r.package).add(imp.specifier);
        }
        continue;
      }
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
      source: info.registry === 'pub' ? 'pub' : (info.registry === 'go' ? 'go' : (info.version.startsWith('file:') ? 'workspace' : 'npm')),
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
    const isRustFile = relPath.endsWith('.rs');
    const isGoFile = relPath.endsWith('.go');
    for (const imp of facts.imports) {
      if (imp.isTypeOnly) typeImportCount += 1;
      if (isRustFile) {
        const r = imp.resolved ?? resolveRustImport(relPath, imp.specifier);
        if (r.kind === 'internal') {
          if (!seen.has(`file:${r.file}`)) { importIds.push(`file:${r.file}`); seen.add(`file:${r.file}`); }
        } else if (r.kind === 'unresolved') {
          if (!unresolvedImports.includes(imp.specifier)) unresolvedImports.push(imp.specifier);
        }
        // rust-external（Cargo crate）不进 npm 依赖体系
        continue;
      }
      if (isGoFile) {
        // Go import 目标是 package 目录（多文件）：关联到目录下全部 .go 文件
        const r = imp.resolved ?? goResolver.resolve(imp.specifier);
        if (r.kind === 'internal') {
          for (const tf of r.files) {
            if (tf === relPath) continue;
            if (!seen.has(`file:${tf}`)) { importIds.push(`file:${tf}`); seen.add(`file:${tf}`); }
          }
        } else if (r.kind === 'unresolved') {
          if (!unresolvedImports.includes(imp.specifier)) unresolvedImports.push(imp.specifier);
        }
        // builtin（标准库）/ external（go.mod 依赖）不进文件边
        continue;
      }
      const r = imp.resolved ?? resolver.resolve(relPath, imp.specifier);
      if (r.kind === 'internal') {
        if (!seen.has(`file:${r.file}`)) { importIds.push(`file:${r.file}`); seen.add(`file:${r.file}`); }
      } else if (r.kind === 'external') {
        if (!seen.has(`dep:${r.package}`)) { importIds.push(`dep:${r.package}`); seen.add(`dep:${r.package}`); }
      } else if (r.kind === 'unresolved') {
        if (!unresolvedImports.includes(imp.specifier)) unresolvedImports.push(imp.specifier);
      }
    }
    const stem = path.posix.basename(relPath).replace(/\.(tsx?|jsx?|dart)$/, '');
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
      isDeclaration: relPath.endsWith('.d.ts'),
      isEntry: htmlEntries.has(relPath) || isEntryFile(relPath, entryRoots),
      isPageFile: stem.endsWith('Page') || stem.endsWith('Screen') || (relPath.endsWith('.vue') && /\/(views|pages)\//.test(relPath)),
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
  const compStoreCallsById = new Map();
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
      if (comp.storeCalls?.length) compStoreCallsById.set(id, comp.storeCalls);
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
        providerType: store.providerType ?? null,
        notifierClass: store.notifierClass ?? null,
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

  // 5a. 隐式 usesStore：unplugin-auto-import 等场景组件直接调用 useXxxStore()/xxxStore() 而无 import 语句，
  // 静态导入图缺失该边；以全局 Store 名单匹配组件体内调用名（useCalls / setup storeVars 均不依赖 import）补齐
  {
    const storeIdByName = new Map();
    for (const s of stores) {
      if (!storeIdByName.has(s.name)) storeIdByName.set(s.name, s.id);
    }
    for (const c of components) {
      const names = new Set([...(c.hooksUsed ?? []), ...(compStoreCallsById.get(c.id) ?? [])]);
      const ids = new Set();
      for (const name of names) {
        const sid = storeIdByName.get(name);
        if (sid) ids.add(sid);
      }
      c.storeIds = [...ids];
    }
  }

  // 5b-0. 类型实体：Interface / Class / Method（跨文件 implements/extends/overrides + 函数级死代码候选）
  const {
    interfaces, classes, methods, localTypesByFile, typeSpanById, refsOutsideSpan,
  } = collectTypeEntities(scan.files, factsMap, fileObjectByPath);

  // 5b-0a. Go 同包跨文件方法合并：goOrphanMethods（接收者类型声明在同目录其他文件——Go 允许同包跨文件定义方法）
  {
    const goClassByDirName = new Map(); // `${dir}#${className}` → class entity
    for (const c of classes) {
      if (c.language !== 'go') continue;
      goClassByDirName.set(`${dirOf(c.filePath)}#${c.name}`, c);
    }
    const mergedMethodIdUsed = new Set();
    for (const relPath of scan.files) {
      if (!relPath.endsWith('.go')) continue;
      const facts = factsMap.get(relPath);
      const fileObj = fileObjectByPath.get(relPath);
      if (!fileObj || !facts?.goOrphanMethods?.length) continue;
      const dir = dirOf(relPath);
      for (const om of facts.goOrphanMethods) {
        const cls = goClassByDirName.get(`${dir}#${om.receiverType}`);
        if (!cls) continue; // 接收者类型来自外部包或未跟踪类型：跳过
        const mid = uniqueId(`method:${relPath}#${om.receiverType}#${om.name}`, mergedMethodIdUsed);
        methods.push({
          id: mid, name: om.name,
          ownerKind: 'class', ownerId: cls.id, ownerName: cls.name,
          fileId: fileObj.id, filePath: relPath,
          line: om.line,
          isStatic: false, isAsync: false, isOverride: false, exported: /^[A-Z]/.test(om.name),
          signature: om.signature,
          overridesId: null, overriddenByIds: [],
          callIds: [], calledByIds: [], compCallIds: [],
          deadCandidate: false, deadReason: null,
          reviewed: false, notes: null,
        });
        cls.methodIds.push(mid);
      }
    }
  }

  // 跨文件类型引用解析：本文件声明优先；其次具名 import（含 type-only，按 local 名匹配、imported 名定位目标文件导出）
  // Rust 文件：use crate::a::b::Name 路径解析为主，全仓库导出名唯一匹配兜底（crate 内 pub 名唯一性强）
  const exportedTypeIndex = new Map(); // `relPath#name` -> id（仅导出实体）
  for (const i of interfaces) if (i.exported) exportedTypeIndex.set(`${i.filePath}#${i.name}`, i.id);
  for (const c of classes) if (c.exported) exportedTypeIndex.set(`${c.filePath}#${c.name}`, c.id);
  const exportedIdsByName = new Map(); // name -> [id]（全仓库重名检测，Rust 唯一名兜底用）
  for (const e of [...interfaces, ...classes]) {
    if (!e.exported) continue;
    const arr = exportedIdsByName.get(e.name);
    if (arr) arr.push(e.id);
    else exportedIdsByName.set(e.name, [e.id]);
  }
  const resolveTypeRef = (relPath, name) => {
    const facts = factsMap.get(relPath);
    if (!facts) return null;
    const local = localTypesByFile.get(relPath)?.get(name);
    if (local) return local;
    if (relPath.endsWith('.rs')) {
      // use 路径解析：crate::a::b::Name → 目标文件 → exportedTypeIndex
      const usePath = facts.importMap.get(name);
      if (usePath) {
        const r = resolveRustUse(relPath, usePath, rustFiles);
        if (r.kind === 'internal') {
          const id = exportedTypeIndex.get(`${r.file}#${r.importedName}`);
          if (id) return id;
        }
      }
      // 全仓库唯一导出名兜底
      const ids = exportedIdsByName.get(name);
      if (ids && ids.length === 1) return ids[0];
      return null;
    }
    for (const imp of facts.imports) {
      const n = (imp.names ?? []).find((x) => x.local === name && x.imported && x.imported !== '*');
      if (!n) continue;
      const r = imp.resolved ?? resolver.resolve(relPath, imp.specifier);
      if (r.kind !== 'internal') continue;
      const id = exportedTypeIndex.get(`${r.file}#${n.imported}`);
      if (id) return id;
    }
    return null;
  };
  for (const iface of interfaces) {
    iface.extendsIds = iface.extendsNames.map((n) => resolveTypeRef(iface.filePath, n)).filter(Boolean);
  }
  for (const cls of classes) {
    cls.implementsIds = cls.implementsNames.map((n) => resolveTypeRef(cls.filePath, n)).filter(Boolean);
    if (cls.extendsName) cls.extendsId = resolveTypeRef(cls.filePath, cls.extendsName);
  }

  // 方法级 overrides：实现类方法与其实现接口/父类中的同名方法建立双向链接
  linkMethodOverrides(interfaces, classes, methods);

  // 5b-0b. Dart 方法调用链（dartAnalyzer 的 callEdges → Method.callIds / calledByIds / compCallIds）
  // self：本类方法或本文件顶层函数；static：owner 类方法（本文件优先，导入解析/全仓库唯一名兜底）；
  // widget：组件构造调用 → compCallIds（渲染链，蓝图展示）
  const methodById = new Map(methods.map((m) => [m.id, m]));
  const methodKey = new Map(); // `${filePath}#${ownerName ?? ''}#${name}` → id
  for (const m of methods) {
    m.callIds = m.callIds ?? [];
    m.calledByIds = m.calledByIds ?? [];
    m.compCallIds = m.compCallIds ?? [];
    methodKey.set(`${m.filePath}#${m.ownerName ?? ''}#${m.name}`, m.id);
  }
  const resolveCallTarget = (relPath, clsName, c) => {
    if (c.kind === 'widget') {
      return { type: 'component', id: compIdByName.get(c.to) ?? null };
    }
    const owner = c.kind === 'static' ? (c.owner ?? clsName) : clsName;
    const local = methodKey.get(`${relPath}#${owner}#${c.to}`);
    if (local) return { type: 'method', id: local };
    const facts = factsMap.get(relPath);
    if (c.kind === 'static' && c.owner && facts) {
      // 跨文件静态调用：importMap 定位导入文件
      const spec = facts.importMap.get(c.owner);
      if (spec) {
        const r = resolver.resolve(relPath, spec);
        if (r.kind === 'internal') {
          const id = methodKey.get(`${r.file}#${c.owner}#${c.to}`);
          if (id) return { type: 'method', id };
        }
      }
      const uniq = methods.filter((m) => m.ownerKind === 'class' && m.ownerName === c.owner && m.name === c.to);
      if (uniq.length === 1) return { type: 'method', id: uniq[0].id };
    }
    // 顶层函数兜底：本文件 / 全仓库唯一
    const topLocal = methodKey.get(`${relPath}##${c.to}`);
    if (topLocal) return { type: 'method', id: topLocal };
    if (c.kind === 'self') {
      const tops = methods.filter((m) => m.ownerKind === 'module' && m.name === c.to);
      if (tops.length === 1) return { type: 'method', id: tops[0].id };
    }
    return null;
  };
  for (const [relPath, facts] of factsMap) {
    if (!relPath.endsWith('.dart') || !facts.callEdges?.length) continue;
    for (const edge of facts.callEdges) {
      let fromId = null;
      let clsName = null;
      if (edge.from.includes('.')) {
        const dot = edge.from.lastIndexOf('.');
        clsName = edge.from.slice(0, dot);
        fromId = methodKey.get(`${relPath}#${clsName}#${edge.from.slice(dot + 1)}`) ?? null;
      } else {
        fromId = methodKey.get(`${relPath}##${edge.from}`) ?? null;
      }
      if (!fromId) continue;
      const fromMethod = methodById.get(fromId);
      if (!fromMethod) continue;
      const seen = new Set();
      for (const c of edge.to) {
        const hit = resolveCallTarget(relPath, clsName, c);
        if (!hit || !hit.id || hit.id === fromId || seen.has(hit.id)) continue;
        seen.add(hit.id);
        if (hit.type === 'method') {
          if (!fromMethod.callIds.includes(hit.id)) fromMethod.callIds.push(hit.id);
          const toM = methodById.get(hit.id);
          if (toM && !toM.calledByIds.includes(fromId)) toM.calledByIds.push(fromId);
        } else {
          if (!fromMethod.compCallIds.includes(hit.id)) fromMethod.compCallIds.push(hit.id);
        }
      }
    }
  }

  // 5b-0c. Go 调用链聚合（goAnalyzer callEdges → Method.callIds / calledByIds）
  // Go 包 = 目录：同包跨文件互调无需 import；跨包调用 pkgAlias.Func() 经 importMap 定位目标包目录；
  // pkgchain（pkg.Var.Chain.Method / baseApi := pkg.Chain 后 baseApi.M）：目标包子树内按方法名搜索（gin-vue-admin ApiGroupApp 惯例）
  {
    const goDirModuleFns = new Map();    // `${dir}#${fnName}` → [methodId]（ownerKind=module）
    const goDirClassMethods = new Map(); // `${dir}#${className}#${methodName}` → methodId
    const goMethodNameIndex = new Map(); // 方法名 → [{ id, filePath }]（pkgchain 子树搜索，词法近似）
    for (const m of methods) {
      if (!m.filePath?.endsWith('.go')) continue;
      const dir = dirOf(m.filePath);
      if (m.ownerKind === 'module') {
        const key = `${dir}#${m.name}`;
        if (!goDirModuleFns.has(key)) goDirModuleFns.set(key, []);
        goDirModuleFns.get(key).push(m.id);
      } else if (m.ownerKind === 'class' && m.ownerName) {
        goDirClassMethods.set(`${dir}#${m.ownerName}#${m.name}`, m.id);
      }
      if (!goMethodNameIndex.has(m.name)) goMethodNameIndex.set(m.name, []);
      goMethodNameIndex.get(m.name).push({ id: m.id, filePath: m.filePath });
    }
    for (const [relPath, facts] of factsMap) {
      if (!relPath.endsWith('.go') || !facts.callEdges?.length) continue;
      const dir = dirOf(relPath);
      for (const edge of facts.callEdges) {
        let fromId = null;
        if (edge.from.includes('.')) {
          const dot = edge.from.lastIndexOf('.');
          fromId = methodKey.get(`${relPath}#${edge.from.slice(0, dot)}#${edge.from.slice(dot + 1)}`) ?? null;
        } else {
          fromId = methodKey.get(`${relPath}##${edge.from}`) ?? null;
        }
        const fromMethod = fromId ? methodById.get(fromId) : null;
        if (!fromMethod) continue;
        const seen = new Set();
        for (const c of edge.to) {
          let toId = null;
          if (c.kind === 'pkg' || c.kind === 'pkgchain') {
            const r = goResolver.resolve(c.toPkg);
            if (r.kind === 'internal') {
              toId = (goDirModuleFns.get(`${r.dir}#${c.to}`) ?? [])[0] ?? null;
              if (!toId && c.kind === 'pkgchain') {
                // 目标包目录子树内同名方法（任意接收者）：ApiGroupApp.SystemApiGroup.BaseApi.Register 形态
                for (const cand of goMethodNameIndex.get(c.to) ?? []) {
                  if (cand.filePath.startsWith(`${r.dir}/`)) { toId = cand.id; break; }
                }
              }
            }
          } else if (c.kind === 'local') {
            toId = methodKey.get(`${relPath}##${c.to}`) ?? null;
            if (!toId) {
              // 同包其他文件的同名顶层函数（Go 包级可见性，无 import 记录）
              for (const id of goDirModuleFns.get(`${dir}#${c.to}`) ?? []) {
                const m = methodById.get(id);
                if (m && m.filePath !== relPath) { toId = id; break; }
              }
            }
          } else if (c.kind === 'method') {
            toId = goDirClassMethods.get(`${dir}#${c.receiverType}#${c.to}`) ?? null;
          }
          if (!toId || toId === fromId || seen.has(toId)) continue;
          seen.add(toId);
          if (!fromMethod.callIds.includes(toId)) fromMethod.callIds.push(toId);
          const toM = methodById.get(toId);
          if (toM && !toM.calledByIds.includes(fromId)) toM.calledByIds.push(fromId);
        }
      }
    }
  }

  // 导出符号的全仓库导入索引（export * 再导出 / 命名空间导入 / 动态 import 的目标文件——无法按名追踪，整文件豁免）
  const indirectlyReferencedFiles = new Set();
  const importedTypeRefs = new Set(); // `targetFile#importedName`
  const rustUsedNames = new Set(); // Rust use 名字全局集合（路径解析失败时的名字级兜底豁免）
  for (const [relPath, facts] of factsMap) {
    const isRust = relPath.endsWith('.rs');
    for (const imp of facts.imports) {
      if (isRust) {
        const r = imp.resolved ?? resolveRustImport(relPath, imp.specifier);
        if (r.kind === 'internal') {
          for (const n of imp.names ?? []) {
            if (n.imported === '*') {
              // 通配 use（use crate::db_v2::*）：mod.rs 可能 re-export 子模块名字（pub use schema::*），
              // 名字不可静态枚举 → 目标文件及其所在目录全部 .rs 文件豁免（宁可漏报不误报）
              indirectlyReferencedFiles.add(r.file);
              const dir = path.posix.dirname(r.file);
              for (const f of rustFiles) {
                if (f.startsWith(dir + '/')) indirectlyReferencedFiles.add(f);
              }
            } else if (n.imported) {
              importedTypeRefs.add(`${r.file}#${n.imported}`);
              rustUsedNames.add(n.imported);
            }
          }
        } else {
          for (const n of imp.names ?? []) {
            if (n.imported && n.imported !== '*') rustUsedNames.add(n.imported);
          }
        }
        continue;
      }
      const r = imp.resolved ?? resolver.resolve(relPath, imp.specifier);
      if (r.kind !== 'internal') continue;
      if (!imp.names || imp.names.length === 0) {
        indirectlyReferencedFiles.add(r.file);
        continue;
      }
      for (const n of imp.names) {
        if (n.imported === '*') indirectlyReferencedFiles.add(r.file);
        else if (n.imported) importedTypeRefs.add(`${r.file}#${n.imported}`);
      }
    }
  }
  // 导出 Interface/Class/模块函数 的全仓库零导入检测
  const exportedModuleFns = methods.filter((m) => m.ownerKind === 'module' && m.exported);
  for (const e of [...interfaces, ...classes, ...exportedModuleFns]) {
    if (!e.exported || e.deadCandidate) continue;
    if (e.filePath.endsWith('.go')) continue; // Go 跨包引用走 pkg.Name 标识符（无 import 名记录），由下方包级重判段处理
    if (indirectlyReferencedFiles.has(e.filePath)) continue;
    if (importedTypeRefs.has(`${e.filePath}#${e.name}`)) continue;
    if (e.filePath.endsWith('.rs') && rustUsedNames.has(e.name)) continue; // Rust use 名字级兜底豁免
    const span = typeSpanById.get(e.id);
    if (span && refsOutsideSpan(e.filePath, e.name, span.pos, span.end) === 0) {
      e.deadCandidate = true;
      e.deadReason = '导出但全仓库零导入且本文件零引用';
    }
  }

  // 5b-0d. Go 死代码重判（包级标识符引用）：Go 包 = 目录，同包跨文件共享符号且无 import 记录，
  // 泛 TS 判定（本文件零引用 / 全仓库零导入）对 Go 失真——按「声明至少出现一次」的计数语义重判：
  //   未导出（小写）：包内（同目录全部 .go 文件）引用计数 ≤ 1（仅声明自身）→ 死；
  //   导出（大写）：包内 ≤ 1 且全仓库 ≤ 1 → 死（跨包引用以标识符出现为准，词法近似、宁漏报不误报）
  {
    const goFilesList = scan.files.filter((f) => f.endsWith('.go'));
    if (goFilesList.length > 0) {
      const totalByName = new Map(); // name → 全仓库 .go 标识符出现计数
      const byDirByName = new Map(); // `${dir}#${name}` → 该目录出现计数
      for (const f of goFilesList) {
        const facts = factsMap.get(f);
        const dir = dirOf(f);
        for (const [name, positions] of facts.nameReferences ?? []) {
          totalByName.set(name, (totalByName.get(name) ?? 0) + positions.length);
          const key = `${dir}#${name}`;
          byDirByName.set(key, (byDirByName.get(key) ?? 0) + positions.length);
        }
      }
      const judge = (e, exported) => {
        const dir = dirOf(e.filePath);
        const inPkg = byDirByName.get(`${dir}#${e.name}`) ?? 0;
        if (!exported) {
          e.deadCandidate = inPkg <= 1;
          e.deadReason = e.deadCandidate ? '包内（同目录）零引用' : null;
          return;
        }
        const total = totalByName.get(e.name) ?? 0;
        e.deadCandidate = inPkg <= 1 && total <= 1;
        e.deadReason = e.deadCandidate ? '导出但全仓库零引用' : null;
      };
      for (const e of methods) {
        if (!e.filePath?.endsWith('.go') || e.ownerKind === 'interface') continue; // 接口方法为契约声明，不判死
        // 类方法的 exported 沿用 Go 可见性（首字母大写），collectTypeEntities 的恒 false 仅适用 TS
        judge(e, e.ownerKind === 'module' ? e.exported : /^[A-Z]/.test(e.name));
      }
      for (const e of [...interfaces, ...classes]) {
        if (e.language !== 'go') continue;
        judge(e, e.exported);
      }
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
    const set = buildUserScriptObjects(relPath, facts, fileObjectByPath.get(relPath));
    userScripts.push(set.userScript);
    gmApiUsages.push(...set.gmApiUsages);
    injectionPoints.push(...set.injectionPoints);
    networkEndpoints.push(...set.networkEndpoints);
    scriptFunctions.push(...set.scriptFunctions);
  }

  // 6. renders 关系：文件主组件的 JSX/模板标签 → 导入来源文件的组件
  // 统一标签解析（React 具名导入精确匹配为基底的超集）：
  //   局部 components 注册表 → import 索引（local 名 + PascalCase 双键）→ 全局 Vue.component 注册 → 同文件兜底；
  //   default 导入 → 目标文件 primary 组件（修复 Vue 默认导入名与组件名不一致的断裂）
  const globalVueComponents = new Map(); // PascalCase(全局注册名) → {file, exported}
  for (const [, facts] of factsMap) {
    for (const g of facts.vueGlobalComponents ?? []) {
      const key = pascalCaseName(g.name);
      if (globalVueComponents.has(key)) continue;
      for (const imp of facts.imports) {
        if (!imp.resolved || imp.resolved.kind !== 'internal' || imp.isTypeOnly) continue;
        const n = (imp.names ?? []).find((x) => x.local === g.local && x.imported && x.imported !== '*');
        if (!n) continue;
        globalVueComponents.set(key, { file: imp.resolved.file, exported: n.imported });
        break;
      }
    }
  }
  // 导入索引：local 名 + PascalCase(local 名) 双键 → {file, exported}
  const buildImportIndex = (facts, relPath) => {
    const index = new Map();
    for (const imp of facts.imports) {
      if (!imp.resolved || imp.resolved.kind !== 'internal' || imp.isTypeOnly) continue;
      for (const n of imp.names) {
        if (!n.local || !n.imported || n.imported === '*') continue;
        const entry = { file: imp.resolved.file, exported: n.imported };
        if (!index.has(n.local)) index.set(n.local, entry);
        const pc = pascalCaseName(n.local);
        if (pc !== n.local && !index.has(pc)) index.set(pc, entry);
      }
    }
    // defineAsyncComponent / React.lazy 包装：const X = defineAsyncComponent(() => import('./x.vue'))
    // 模板/JSX 可直接用 X 作标签（snowy 等 Vue3 项目惯用）
    for (const w of facts.lazyWrappers ?? []) {
      if (!w.name || index.has(w.name)) continue;
      const r = resolver.resolve(relPath, w.importPath);
      if (r.kind === 'internal') index.set(w.name, { file: r.file, exported: 'default' });
    }
    return index;
  };
  // 导入目标 → 目标文件组件（default → primary；具名 → exported 名 → tag 名；.vue 文件 primary 兜底）
  const pickTargetComponent = (target, tag) => {
    const targetComps = componentsByFile.get(target.file) ?? [];
    if (!targetComps.length) return null;
    if (target.exported === 'default') {
      return targetComps.find((c) => c.isPrimary) ?? targetComps[0];
    }
    return targetComps.find((c) => c.name === target.exported)
      ?? targetComps.find((c) => c.name === tag)
      ?? (target.file.endsWith('.vue') ? (targetComps.find((c) => c.isPrimary) ?? targetComps[0]) : null);
  };
  // 模板/JSX 标签 → 目标组件条目（componentsByFile 项）
  const resolveTagToComponent = (facts, tag, importIndex, fileComps) => {
    const pcTag = pascalCaseName(tag);
    // 1. Vue 局部注册表（Options API components 选项）：PascalCase(tag) → local 名 → 导入索引
    const regLocal = facts.vueComponents?.[pcTag] ?? facts.vueComponents?.[tag];
    if (regLocal) {
      const t = importIndex.get(regLocal);
      if (t) {
        const hit = pickTargetComponent(t, pcTag);
        if (hit) return hit;
      }
    }
    // 2. 导入索引直接命中（React 具名导入 / Vue3 setup 无注册表直用）
    const direct = importIndex.get(tag) ?? importIndex.get(pcTag);
    if (direct) {
      const hit = pickTargetComponent(direct, pcTag);
      if (hit) return hit;
    }
    // 3. 全局注册兜底（main.js 的 Vue.component）
    const globalTarget = globalVueComponents.get(pcTag) ?? globalVueComponents.get(tag);
    if (globalTarget) {
      const hit = pickTargetComponent(globalTarget, pcTag);
      if (hit) return hit;
    }
    // 4. 同文件兜底（无 import 记录的同文件导出组件）
    return fileComps.find((c) => c.name === tag) ?? fileComps.find((c) => c.name === pcTag) ?? null;
  };
  for (const relPath of scan.files) {
    const facts = factsMap.get(relPath);
    if (!facts.primaryComponentName) continue;
    const primaryId = compIdByName.get(facts.primaryComponentName);
    if (!primaryId || !facts.jsxTags.size) continue;
    const importIndex = buildImportIndex(facts, relPath);
    const primary = components.find((c) => c.id === primaryId);
    if (!primary) continue;
    const fileComps = componentsByFile.get(relPath) ?? [];
    for (const tag of facts.jsxTags) {
      const hit = resolveTagToComponent(facts, tag, importIndex, fileComps);
      if (hit && hit.id !== primaryId && !primary.rendersIds.includes(hit.id)) {
        primary.rendersIds.push(hit.id);
      }
    }
  }

  // 6a. Vue 组件类视图实体：.vue 主组件 → kind='component' 的 Class 实体
  // props 为字段、computed/methods 为方法；renders 组合边回填（目标同为 vclass 才成边）
  // 插在死代码检测之后，vclass 恒不判死（组件被模板引用，无 import 记录属常态）
  {
    const vclassIdUsed = new Set();
    const vmethodIdUsed = new Set();
    const vclassByCompId = new Map(); // comp:xxx → vclass:xxx
    const compById = new Map(components.map((c) => [c.id, c]));
    for (const relPath of scan.files) {
      if (!relPath.endsWith('.vue')) continue;
      const facts = factsMap.get(relPath);
      const fileObj = fileObjectByPath.get(relPath);
      if (!fileObj || !facts?.vueOptions) continue;
      const primary = (componentsByFile.get(relPath) ?? []).find((c) => c.isPrimary)
        ?? (componentsByFile.get(relPath) ?? [])[0];
      if (!primary) continue;
      const opts = facts.vueOptions;
      const id = uniqueId(`vclass:${primary.name}`, vclassIdUsed);
      const entity = {
        id, name: primary.name,
        fileId: fileObj.id, filePath: relPath,
        line: facts.components.find((c) => c.name === primary.name)?.line ?? 1,
        exported: true,
        language: 'vue',
        kind: 'component',
        derives: [],
        fields: opts.propsDefs.map((p) => ({ name: p.name, type: p.type ?? null })),
        variants: [],
        isSingleton: false,
        isWidget: false,
        widgetBase: null,
        isStore: false,
        withNames: [],
        methodIds: [],
        implementsIds: [],
        implementsNames: [],
        extendsId: null, extendsName: null,
        rendersIds: [],
        deadCandidate: false, deadReason: null,
        reviewed: false, notes: null,
      };
      for (const key of [...opts.computedKeys, ...opts.methodKeys]) {
        const mid = uniqueId(`vmethod:${primary.name}.${key}`, vmethodIdUsed);
        methods.push({
          id: mid, name: key,
          ownerKind: 'class', ownerId: id, ownerName: primary.name,
          fileId: fileObj.id, filePath: relPath,
          line: null,
          isStatic: false, isAsync: false, isOverride: false, exported: false,
          signature: null,
          overridesId: null, overriddenByIds: [],
          callIds: [], calledByIds: [], compCallIds: [],
          deadCandidate: false, deadReason: null,
          reviewed: false, notes: null,
        });
        entity.methodIds.push(mid);
      }
      classes.push(entity);
      vclassByCompId.set(primary.id, id);
    }
    // renders 组合边回填：组件 renders 关系映射到 vclass（非 vclass 目标不成边，保持类图纯净）
    for (const [compId, vclassId] of vclassByCompId) {
      const comp = compById.get(compId);
      const vclass = classes.find((c) => c.id === vclassId);
      if (!comp?.rendersIds?.length || !vclass) continue;
      for (const rid of comp.rendersIds) {
        const targetVclass = vclassByCompId.get(rid);
        if (targetVclass && targetVclass !== vclassId && !vclass.rendersIds.includes(targetVclass)) {
          vclass.rendersIds.push(targetVclass);
        }
      }
    }
  }

  // 6b. Props 传递链：tsx/jsx 的 jsxPropRenders + .vue 的 vuePropRenders（含来源分类）→ 按组件对聚合的 PropEdge 对象
  const propEdges = [];
  {
    const SOURCE_PRIORITY = { forward: 6, state: 5, store: 4, handler: 3, computed: 2, literal: 1, spread: 0 };
    const compById = new Map(components.map((c) => [c.id, c]));
    const agg = new Map(); // `${fromId}→${toId}` → { fromId, toId, props: Map<name, prop>, renderCount }
    for (const relPath of scan.files) {
      const isVue = relPath.endsWith('.vue');
      if (!isVue && !/\.(tsx|jsx)$/.test(relPath)) continue;
      const facts = factsMap.get(relPath);
      const passes = isVue ? facts?.vuePropRenders : facts?.jsxPropRenders;
      if (!passes?.length) continue;
      const importIndex = buildImportIndex(facts, relPath);
      const fileComps = componentsByFile.get(relPath) ?? [];
      for (const pass of passes) {
        // .vue 为单组件语义：from 固定取文件 primary 组件（vuePropRenders 无 fromComponent 字段）
        const from = isVue
          ? (fileComps.find((c) => c.isPrimary) ?? fileComps[0])
          : (pass.fromComponent ? fileComps.find((c) => c.name === pass.fromComponent) : null);
        if (!from) continue;
        const to = resolveTagToComponent(facts, pass.tag, importIndex, fileComps);
        if (!to || to.id === from.id) continue;
        const key = `${from.id}→${to.id}`;
        let entry = agg.get(key);
        if (!entry) {
          entry = { fromId: from.id, toId: to.id, props: new Map(), renderCount: 0 };
          agg.set(key, entry);
        }
        entry.renderCount += 1;
        for (const p of pass.props) {
          const prev = entry.props.get(p.name);
          if (!prev || (SOURCE_PRIORITY[p.source] ?? 0) > (SOURCE_PRIORITY[prev.source] ?? 0)) {
            entry.props.set(p.name, { name: p.name, source: p.source, valueText: p.valueText, storeHook: p.storeHook ?? null });
          }
        }
      }
    }
    const propEdgeIdsUsed = new Set();
    for (const entry of agg.values()) {
      const props = [...entry.props.values()];
      if (!props.length) continue;
      const from = compById.get(entry.fromId);
      const to = compById.get(entry.toId);
      const id = uniqueId(`prop:${from.name}→${to.name}`, propEdgeIdsUsed);
      propEdges.push({
        id,
        fromComponentId: entry.fromId,
        toComponentId: entry.toId,
        fromFileId: `file:${from.filePath}`,
        toFileId: `file:${to.filePath}`,
        props,
        renderCount: entry.renderCount,
        reviewed: false,
        notes: null,
      });
    }
    // 组件出入度统计
    for (const c of components) {
      c.propOutCount = 0;
      c.propInCount = 0;
    }
    for (const e of propEdges) {
      const from = components.find((c) => c.id === e.fromComponentId);
      const to = components.find((c) => c.id === e.toComponentId);
      if (from) from.propOutCount += 1;
      if (to) to.propInCount += 1;
    }
  }

  // 7. Overlay 路由（自定义 overlayGroups/lazyImports 体系）+ React JSX 声明式路由（react-router <Routes>/<Route>）
  const rawRoutes = [
    ...analyzeOverlayRoutes(projectRoot, resolver, getFacts, scan.files),
    ...analyzeJsxRoutes(projectRoot, resolver, getFacts, scan.files),
    ...analyzeDataRouterRoutes(projectRoot, resolver, getFacts, scan.files),
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
    // 布局外壳导航（数据路由）：布局 componentFile 及其直接 import 的内部文件（如 Sidebar）
    // 的 overlayOpens 并入子路由——侧边栏导航对所有子页面可达
    for (const lf of route.layoutFiles ?? []) {
      if (lf === componentFile) continue;
      if (factsMap.has(lf)) navigatesTo.push(...factsMap.get(lf).overlayOpens.map((o) => o.target));
      const layoutFileObj = fileObjectByPath.get(lf);
      for (const impId of layoutFileObj?.importIds ?? []) {
        if (!impId.startsWith('file:')) continue;
        const impFile = impId.slice('file:'.length);
        if (impFile === componentFile || !factsMap.has(impFile)) continue;
        navigatesTo.push(...factsMap.get(impFile).overlayOpens.map((o) => o.target));
      }
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
      factoryProps: route.factoryProps ?? [],
      routeType: route.routeType ?? 'overlay',
      rawPath: null, layoutFileIds: [], specialFiles: [],
      isDynamic: null, isClient: null, apiMethods: null,
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
      factoryProps: [],
      routeType: 'vue',
      rawPath: null, layoutFileIds: [], specialFiles: [],
      isDynamic: null, isClient: null, apiMethods: null,
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

  // 7c-b. Flutter GoRoute 路由（dartRoutes：path/builderWidget，跨文件组件解析 + 导航边）
  const dartRouteIds = new Set(routes.map((r) => r.id));
  const dartRouteByPath = new Map();
  for (const [relPath, facts] of factsMap) {
    if (!relPath.endsWith('.dart') || !facts.dartRoutes?.length) continue;
    for (const dr of facts.dartRoutes) {
      if (!dr.path) continue;
      // builderWidget → 导入来源文件中的组件（具名导入优先；通配导入按目标文件组件名匹配；本文件组件兜底）
      let componentFile = null;
      if (dr.builderWidget && facts.imports) {
        for (const imp of facts.imports) {
          const named = (imp.names ?? []).find((n) => (n.imported === dr.builderWidget || n.local === dr.builderWidget) && n.imported !== '*');
          if (named) {
            const r = imp.resolved ?? resolver.resolve(relPath, imp.specifier);
            if (r.kind === 'internal') { componentFile = r.file; break; }
          }
        }
        if (!componentFile) {
          for (const imp of facts.imports) {
            const r = imp.resolved ?? resolver.resolve(relPath, imp.specifier);
            if (r.kind !== 'internal') continue;
            if ((componentsByFile.get(r.file) ?? []).some((c) => c.name === dr.builderWidget)) {
              componentFile = r.file;
              break;
            }
          }
        }
        if (!componentFile && (componentsByFile.get(relPath) ?? []).some((c) => c.name === dr.builderWidget)) {
          componentFile = relPath;
        }
      }
      const id = uniqueId(`route:${dr.path}`, dartRouteIds);
      dartRouteByPath.set(dr.path, id);
      const compId = componentFile
        ? ((componentsByFile.get(componentFile) ?? []).find((c) => c.name === dr.builderWidget)?.id
          ?? (componentsByFile.get(componentFile) ?? []).find((c) => c.isPrimary)?.id
          ?? (componentsByFile.get(componentFile) ?? [])[0]?.id ?? null)
        : null;
      const seg = dr.path.split('/').filter(Boolean)[0];
      const domain = !seg || seg.startsWith(':') ? 'root' : seg;
      routes.push({
        id,
        overlayId: dr.path,
        name: dr.name ?? dr.path,
        routePath: dr.path,
        backTarget: null,
        hidesNav: null,
        domain,
        group: relPath,
        componentRef: dr.builderWidget,
        componentFileId: componentFile ? `file:${componentFile}` : null,
        componentId: compId,
        navigatesToIds: [],
        hasPropsFactory: false,
        factoryProps: [],
        routeType: 'flutter',
        rawPath: null, layoutFileIds: [], specialFiles: [],
        isDynamic: null, isClient: null, apiMethods: null,
        reviewed: false, notes: null,
      });
      if (compId) {
        const comp = components.find((c) => c.id === compId);
        if (comp) comp.routeIds.push(id);
      }
    }
  }
  // GoRouter 导航边：任意 .dart 文件内 context.go('/path') / context.push(AppRouter.xxx) → 该文件组件所属路由 → 目标路由
  // 常量引用参数（AppRouter.fengshui / home）用全仓库路由常量表回填；动态变量（feature.route）查不到即忽略
  const dartConstPathByName = new Map(); // 全仓库路由常量名 → path（跨文件常量引用回填）
  for (const [relPath, facts] of factsMap) {
    if (!relPath.endsWith('.dart') || !facts.dartRouteConstants) continue;
    for (const [name, p] of facts.dartRouteConstants) {
      if (!dartConstPathByName.has(name)) dartConstPathByName.set(name, p);
    }
  }
  for (const [relPath, facts] of factsMap) {
    if (!relPath.endsWith('.dart')) continue;
    const opens = (facts.overlayOpens ?? [])
      .map((o) => {
        let t = o.target;
        if (!t.startsWith('/')) {
          const name = t.includes('.') ? t.split('.').pop() : t;
          t = dartConstPathByName.get(name) ?? facts.dartRouteConstants?.get(name) ?? '';
        }
        return t;
      })
      .filter((t) => t.startsWith('/'));
    if (!opens.length) continue;
    const ownerIds = routes.filter((r) => r.componentFileId === `file:${relPath}`).map((r) => r.id);
    for (const o of opens) {
      const toId = dartRouteByPath.get(o);
      if (!toId) continue;
      for (const ownerId of ownerIds) {
        const route = routes.find((r) => r.id === ownerId);
        if (route && !route.navigatesToIds.includes(toId)) route.navigatesToIds.push(toId);
      }
    }
  }

  // 7c-c. Go cobra CLI 命令树 + gin HTTP 路由 → Route
  // cobra：var xxxCmd = &cobra.Command{Use/Short} + AddCommand 边 → 命令链路径（routeType='go-cli'）
  // gin：Group 前缀累积 + .GET/.POST(...) → 完整路径（routeType='go'，apiMethods/middlewares/handler Method 关联）
  const goRouteIds = new Set(routes.map((r) => r.id));
  {
    // --- cobra 命令树（varName 全局首见优先——cobra 命令 var 惯例全仓库唯一，cmd/ 先于 internal/ 扫描） ---
    const commandByVar = new Map();
    const commandByDirVar = new Map(); // `${dir}#${varName}` → varName（跨包限定子命令解析用）
    const commands = [];
    const edgeFiles = []; // {relPath, edges}（命令声明可能晚于 AddCommand 边出现，两遍处理）
    for (const relPath of scan.files) {
      if (!relPath.endsWith('.go')) continue;
      const facts = factsMap.get(relPath);
      for (const cmd of facts.goCommands ?? []) {
        if (!commandByVar.has(cmd.varName)) {
          commandByVar.set(cmd.varName, { ...cmd, file: relPath });
          commands.push(commandByVar.get(cmd.varName));
        }
        const dir = path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath);
        commandByDirVar.set(`${dir}#${cmd.varName}`, cmd.varName);
      }
      if (facts.goCommandEdges?.length) edgeFiles.push({ relPath, facts });
    }
    const cmdEdges = [];
    for (const { facts } of edgeFiles) {
      for (const e of facts.goCommandEdges) {
        if (!e.childPkg) { cmdEdges.push(e); continue; }
        // 跨包限定子命令 host.HostGetCmd → importMap 定位目录 → 该目录声明的命令 var
        let resolved = e.childVar;
        const spec = facts.importMap.get(e.childPkg);
        if (spec) {
          const r = goResolver.resolve(spec);
          if (r.kind === 'internal') {
            const target = commandByDirVar.get(`${r.dir}#${e.childName}`);
            if (target) resolved = target;
          }
        }
        cmdEdges.push({ parentVar: e.parentVar, childVar: resolved });
      }
    }
    const childrenOf = new Map();
    const childVars = new Set();
    for (const e of cmdEdges) {
      if (e.parentVar === e.childVar) continue;
      if (!childrenOf.has(e.parentVar)) childrenOf.set(e.parentVar, []);
      childrenOf.get(e.parentVar).push(e.childVar);
      childVars.add(e.childVar);
    }
    const walkCmd = (varName, chain, depth) => {
      if (depth > 8) return; // 防御环
      const cmd = commandByVar.get(varName);
      if (!cmd) return;
      const use = cmd.use || varName;
      const routePath = chain ? `${chain} ${use}` : use;
      routes.push({
        id: uniqueId(`route:go-cli:${routePath}`, goRouteIds),
        overlayId: `go-cli:${routePath}`,
        name: use,
        routePath,
        backTarget: null, hidesNav: null,
        domain: 'cli',
        group: cmd.file,
        componentRef: cmd.varName,
        componentFileId: `file:${cmd.file}`,
        componentId: null,
        navigatesToIds: [],
        hasPropsFactory: false,
        factoryProps: [],
        routeType: 'go-cli',
        rawPath: null, layoutFileIds: [],
        specialFiles: (cmd.flags ?? []).map((f) => (f.shorthand ? `-${f.shorthand}/--${f.name}` : `--${f.name}`)),
        isDynamic: null, isClient: null, apiMethods: null,
        description: cmd.short,
        reviewed: false, notes: null,
      });
      for (const child of childrenOf.get(varName) ?? []) walkCmd(child, routePath, depth + 1);
    };
    for (const cmd of commands) {
      if (!childVars.has(cmd.varName)) walkCmd(cmd.varName, '', 0);
    }

    // --- gin 路由（handler 'controller.Register' → importMap 定位包目录 → Register 顶层函数 Method） ---
    // 方法名 → [{ id, filePath }]：handlerChain（v1.ApiGroupApp...BaseApi.Register）子树搜索用
    const goRouteMethodNameIndex = new Map();
    for (const m of methods) {
      if (!m.filePath?.endsWith('.go')) continue;
      if (!goRouteMethodNameIndex.has(m.name)) goRouteMethodNameIndex.set(m.name, []);
      goRouteMethodNameIndex.get(m.name).push({ id: m.id, filePath: m.filePath });
    }
    for (const relPath of scan.files) {
      if (!relPath.endsWith('.go')) continue;
      const facts = factsMap.get(relPath);
      for (const gr of facts.goRoutes ?? []) {
        let handlerMethodId = null;
        let handlerFile = null;
        // handler 解析三级：pkg.Fn（importMap 直达顶层函数）→ handlerChain（v1.ApiGroupApp...BaseApi.Register
        // 链首 import 别名 → 目标包子树内同名方法搜索，gin-vue-admin 惯例）
        const hm = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(gr.handlers?.[0] ?? '');
        if (hm) {
          const spec = facts.importMap.get(hm[1]);
          if (spec) {
            const r = goResolver.resolve(spec);
            if (r.kind === 'internal') {
              handlerFile = r.file;
              for (const f of r.files) {
                const mid = methodKey.get(`${f}##${hm[2]}`);
                if (mid) { handlerMethodId = mid; handlerFile = f; break; }
              }
            }
          }
        }
        if (!handlerMethodId && gr.handlerChain) {
          const cm = /^([A-Za-z_]\w*)((?:\.[A-Za-z_]\w*)+)\.([A-Za-z_]\w*)$/.exec(gr.handlerChain);
          if (cm) {
            const spec = facts.importMap.get(cm[1]);
            if (spec) {
              const r = goResolver.resolve(spec);
              if (r.kind === 'internal') {
                for (const f of r.files) {
                  const mid = methodKey.get(`${f}##${cm[3]}`);
                  if (mid) { handlerMethodId = mid; handlerFile = f; break; }
                }
                if (!handlerMethodId) {
                  // 子树内同名方法（任意接收者）；同时记录最近声明文件供跳转
                  for (const cand of goRouteMethodNameIndex.get(cm[3]) ?? []) {
                    if (cand.filePath.startsWith(`${r.dir}/`)) { handlerMethodId = cand.id; handlerFile = cand.filePath; break; }
                  }
                }
              }
            }
          }
        }
        // 域取首个业务段：跳过 api/v1 等网关前缀（后续仍有静态段时）；动态段开头归 root
        const segs = gr.path.split('/').filter(Boolean);
        let si = 0;
        while (si < segs.length - 1 && /^(api|apis|v\d+)$/i.test(segs[si])) si += 1;
        const seg = segs[si] ?? null;
        const domain = !seg || seg.startsWith(':') || seg.startsWith('*') ? 'root' : seg;
        routes.push({
          id: uniqueId(`route:${gr.method} ${gr.path}`, goRouteIds),
          overlayId: `${gr.method} ${gr.path}`,
          name: gr.path,
          routePath: gr.path,
          backTarget: null, hidesNav: null,
          domain,
          group: relPath,
          componentRef: gr.handlers?.[0] ?? null,
          componentFileId: `file:${handlerFile ?? relPath}`,
          componentId: handlerMethodId, // 复用 componentId 承载 handler Method（viewer 按 routeType='go' 渲染方法链接）
          navigatesToIds: [],
          hasPropsFactory: false,
          factoryProps: [],
          routeType: 'go',
          rawPath: null, layoutFileIds: [],
          specialFiles: [],
          middlewares: gr.middlewares ?? [],
          isDynamic: /\/[:*]/.test(gr.path),
          isClient: null,
          apiMethods: gr.method === 'ANY' ? ['*'] : [gr.method],
          reviewed: false, notes: null,
        });
      }
    }
  }

  // 7c-d. 前后端逻辑映射：tsAnalyzer httpCalls（前端 API.get / axios.x / fetch）↔ go 路由路径匹配
  // :param / *wildcard 通配前端任意段；去 query、尾斜杠归一；method 不一致仍记录（详情可见）
  const unmatchedFrontendCalls = [];
  {
    const goApiRoutes = routes.filter((r) => r.routeType === 'go');
    if (goApiRoutes.length > 0) {
      const normPath = (p) => (p.split('?')[0].replace(/\/+$/, '') || '/');
      const routeSegs = goApiRoutes.map((r) => ({ r, segs: normPath(r.routePath).split('/').filter(Boolean) }));
      const matchRoute = (feSegs) => {
        for (const { r, segs } of routeSegs) {
          const segMatches = (s, fe) => s.startsWith(':') || s.startsWith('*') || s === fe;
          if (segs.length === feSegs.length) {
            if (segs.every((s, i) => segMatches(s, feSegs[i]))) return r;
          } else if (segs.length < feSegs.length && segs.some((s) => s.startsWith('*'))) {
            // 后端尾段 *wildcard 可吞前端剩余段
            const prefix = segs.slice(0, -1);
            if (prefix.length <= feSegs.length && prefix.every((s, i) => segMatches(s, feSegs[i]))) return r;
          }
        }
        return null;
      };
      for (const [relPath, facts] of factsMap) {
        if (/\.(go|rs|dart)$/.test(relPath)) continue;
        for (const call of facts.httpCalls ?? []) {
          const feSegs = normPath(call.path).split('/').filter(Boolean);
          const route = matchRoute(feSegs);
          const fileObj = fileObjectByPath.get(relPath);
          const entry = { fileId: fileObj?.id ?? `file:${relPath}`, filePath: relPath, line: call.line, method: call.method };
          if (route) {
            if (!route.frontendCalls) route.frontendCalls = [];
            if (!route.frontendCalls.some((c) => c.filePath === relPath && c.line === call.line)) {
              route.frontendCalls.push(entry);
            }
          } else {
            unmatchedFrontendCalls.push({ ...entry, path: call.path });
          }
        }
      }
    }
  }

  // 7e. Next.js App Router 路由（文件约定式：page/route/layout）
  //     导航边仅归属 page 文件内的 Link href / router.push（layout/共享组件文件不归属，避免边爆炸）
  if (scan.framework === 'next') {
    const nextRawRoutes = analyzeNextAppRoutes(projectRoot, scan, resolver, factsMap);
    const nextRouteIds = new Set(routes.map((r) => r.id));
    const nextRouteByPath = new Map();
    for (const route of nextRawRoutes) {
      const componentFile = route.componentFile;
      if (componentFile) lazyReferencedFiles.add(componentFile);
      const compId = componentFile
        ? ((componentsByFile.get(componentFile) ?? []).find((c) => c.isPrimary)?.id
          ?? (componentsByFile.get(componentFile) ?? [])[0]?.id ?? null)
        : null;
      const routeId = uniqueId(`route:${route.overlayId}`, nextRouteIds);
      nextRouteByPath.set(route.routePath, routeId);
      routes.push({
        id: routeId,
        overlayId: route.overlayId,
        name: route.overlayId,
        routePath: route.routePath,
        rawPath: route.rawPath,
        backTarget: route.backTarget,
        hidesNav: route.hidesNav,
        domain: route.domain,
        group: route.group,
        componentRef: route.componentRef,
        componentFileId: componentFile ? `file:${componentFile}` : null,
        componentId: compId,
        navigatesToIds: [],
        hasPropsFactory: false,
        factoryProps: [],
        routeType: route.routeType,
        layoutFileIds: route.layoutFileIds.map((f) => `file:${f}`),
        specialFiles: route.specialFiles,
        isDynamic: route.isDynamic,
        isClient: route.isClient,
        apiMethods: route.apiMethods,
        reviewed: false, notes: null,
      });
      if (compId) {
        const comp = components.find((c) => c.id === compId);
        if (comp) {
          comp.routeIds.push(routeId);
          if (route.routeType === 'next' && comp.kind === 'common') comp.kind = 'page';
        }
      }
    }
    for (const route of nextRawRoutes) {
      if (route.routeType !== 'next') continue;
      const routeObj = routes.find((r) => r.id === nextRouteByPath.get(route.routePath));
      const facts = factsMap.get(route.componentFile);
      if (!routeObj || !facts) continue;
      for (const o of facts.overlayOpens) {
        if (!o.target.startsWith('/')) continue;
        const toId = nextRouteByPath.get(o.target);
        if (!toId || toId === routeObj.id) continue;
        if (!routeObj.navigatesToIds.includes(toId)) routeObj.navigatesToIds.push(toId);
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
  for (const i of interfaces) i.archLayer = fileArchLayer.get(i.filePath) ?? null;
  for (const c of classes) c.archLayer = fileArchLayer.get(c.filePath) ?? null;
  for (const m of methods) m.archLayer = fileArchLayer.get(m.filePath) ?? null;

  // 8. 死代码候选与循环依赖
  const importedByCount = new Map();
  for (const f of fileObjects) {
    for (const id of f.importIds) {
      if (id.startsWith('file:')) importedByCount.set(id, (importedByCount.get(id) ?? 0) + 1);
    }
  }
  // import.meta.glob([...]) 动态批量导入的文件（如 snowy 的 views 菜单路由 / icon 选择器）豁免孤儿候选
  const globReferencedFiles = new Set();
  {
    const globToRegExp = (pattern) => {
      let re = '';
      let i = 0;
      while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === '*') {
          if (pattern[i + 1] === '*') {
            if (pattern[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 3; continue; }
            re += '[\\s\\S]*'; i += 2; continue;
          }
          re += '[^/]*'; i += 1; continue;
        }
        re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        i += 1;
      }
      return new RegExp(`^${re}$`);
    };
    // glob 模式归一为项目相对路径模式（/x → x；../y 相对声明文件目录解析）
    const normalizePattern = (pattern, fromFile) => {
      let p = pattern;
      if (p.startsWith('/')) return p.slice(1);
      if (!p.startsWith('.')) return p; // 相对同目录简写（assets/...）
      const parts = path.posix.dirname(fromFile).split('/');
      for (const seg of p.split('/')) {
        if (seg === '..') parts.pop();
        else if (seg !== '.') parts.push(seg);
      }
      return parts.join('/');
    };
    for (const [relPath, facts] of factsMap) {
      for (const g of facts.globPatterns ?? []) {
        const includes = g.patterns.filter((p) => !p.startsWith('!'))
          .map((p) => globToRegExp(normalizePattern(p.replace(/^!/, ''), g.fromFile)));
        const excludes = g.patterns.filter((p) => p.startsWith('!'))
          .map((p) => globToRegExp(normalizePattern(p.slice(1), g.fromFile)));
        if (!includes.length) continue;
        for (const f of fileObjects) {
          if (!includes.some((re) => re.test(f.path))) continue;
          if (excludes.some((re) => re.test(f.path))) continue;
          globReferencedFiles.add(f.path);
        }
      }
    }
  }
  const routeComponentFiles = new Set(routes.map((r) => r.componentFileId).filter(Boolean));
  // unplugin-vue-components（组件自动注册目录）/ unplugin-auto-import（导出自动导入目录）：
  // 编译期自动注入 import，源码零 import 记录属常态，豁免孤儿候选
  const autoComponentDirs = scan.autoComponentDirs ?? [];
  const autoImportDirs = scan.autoImportDirs ?? [];
  const isAutoRegistered = (p) => (p.endsWith('.vue') && autoComponentDirs.some((d) => p.startsWith(`${d}/`)))
    || autoImportDirs.some((d) => p.startsWith(`${d}/`));
  const orphanCandidates = fileObjects
    .filter((f) => (f.path.startsWith('src/') || f.path.startsWith('lib/'))
      && !f.isTest && !f.isEntry
      && !routeComponentFiles.has(f.id)
      && !lazyReferencedFiles.has(f.path)
      && !globReferencedFiles.has(f.path)
      && !isAutoRegistered(f.path)
      && (importedByCount.get(f.id) ?? 0) === 0)
    .map((f) => f.path);
  // 导出级死代码：导出符号全仓库零导入且本文件零使用（仅 export 冗余，代码可安全去导出/删除）
  // 保守豁免：入口/测试文件、被 export */命名空间/无子句动态 import 整体引用的文件、
  // 零导入文件（文件级 orphan 已覆盖）、default 导出（消费方按 default 导入，名字不可对照）
  const deadExportCandidates = [];
  for (const f of fileObjects) {
    f.unusedExports = [];
    if (f.isEntry || f.isTest) continue;
    if (f.path.endsWith('.go')) continue; // Go 导出符号的包级判定已在 5b-0d 完成
    if (indirectlyReferencedFiles.has(f.path)) continue;
    if ((importedByCount.get(f.id) ?? 0) === 0) continue;
    const facts = factsMap.get(f.path);
    for (const sym of facts?.exportSymbols ?? []) {
      if (!sym.isExported || sym.isDefault) continue;
      if (importedTypeRefs.has(`${f.path}#${sym.name}`)) continue;
      if (f.path.endsWith('.rs') && rustUsedNames.has(sym.name)) continue; // Rust use 名字级兜底豁免
      const positions = facts.nameReferences?.get(sym.name) ?? [];
      if (positions.length > 1) continue; // 本文件内仍有使用，仅 export 语句冗余，不判死
      f.unusedExports.push(sym.name);
    }
    if (f.unusedExports.length > 0) {
      deadExportCandidates.push({ file: f.path, names: f.unusedExports });
    }
  }
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
    language: (() => {
      const parts = [];
      if ((scan.tsFileCount ?? 0) + (scan.tsxFileCount ?? 0) + (scan.jsFileCount ?? 0) + (scan.vueFileCount ?? 0) > 0) parts.push('TypeScript');
      if ((scan.rustFileCount ?? 0) > 0) parts.push('Rust');
      if ((scan.dartFileCount ?? 0) > 0) parts.push('Dart');
      if ((scan.goFileCount ?? 0) > 0) parts.push('Go');
      return parts.join(' + ') || 'TypeScript';
    })(),
    commitHash: scan.commitHash,
    branch: scan.branch,
    fileCount: scan.fileCount,
    tsFileCount: scan.tsFileCount,
    tsxFileCount: scan.tsxFileCount,
    jsFileCount: scan.jsFileCount,
    vueFileCount: scan.vueFileCount,
    rustFileCount: scan.rustFileCount ?? 0,
    dartFileCount: scan.dartFileCount ?? 0,
    goFileCount: scan.goFileCount ?? 0,
    goModule: scan.goModule ?? null,
    subProjects: scan.subProjects ?? [],
    siblingProjects: scan.siblingProjects ?? [],
    flutterDetected: scan.flutterDetected ?? false,
    tauriDetected: scan.tauriDetected ?? false,
    electronDetected: scan.electronDetected ?? false,
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
    deadTypeCount: interfaces.filter((i) => i.deadCandidate).length + classes.filter((c) => c.deadCandidate).length,
    deadFunctionCount: methods.filter((m) => m.deadCandidate).length + scriptFunctions.filter((f) => f.deadCandidate).length,
    deadExportCount: deadExportCandidates.reduce((a, d) => a + d.names.length, 0),
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
      deadExportCandidates,
      unmatchedFrontendCalls,
      objectCounts: {
        Module: modules.length, SourceFile: fileObjects.length, Component: components.length,
        Hook: hooks.length, Store: stores.length, Service: services.length,
        Interface: interfaces.length, Class: classes.length, Method: methods.length,
        PropEdge: propEdges.length,
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
    Interface: interfaces,
    Class: classes,
    Method: methods,
    PropEdge: propEdges,
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

// 单文件分析（不落盘快照）：action analyzeFile 的核心实现
// 原子性：分析即输出 dataMap 形状 JSON，供 jq/findstr 管道组合；场景工作流（油猴审计/死代码清理）由 skill 编排
export async function buildSingleFileOntology(absFilePath) {
  const startedAt = Date.now();
  const fileName = path.basename(absFilePath);
  const dir = path.dirname(absFilePath);

  // 路由与全仓库扫描一致：.rs → rustAnalyzer；.go → goAnalyzer；.dart → dartAnalyzer；.vue → vueAnalyzer；油猴脚本 → userScriptAnalyzer；其余 → tsAnalyzer
  let facts;
  if (fileName.endsWith('.rs')) {
    facts = analyzeRustFile(fileName, fs.readFileSync(absFilePath, 'utf-8'));
  } else if (fileName.endsWith('.go')) {
    facts = analyzeGoFile(fileName, fs.readFileSync(absFilePath, 'utf-8'));
  } else if (fileName.endsWith('.dart')) {
    facts = analyzeDartFile(fileName, fs.readFileSync(absFilePath, 'utf-8'));
  } else if (fileName.endsWith('.vue')) {
    facts = analyzeVueFileFromDisk(fileName, dir);
  } else if (isUserScriptCandidate(absFilePath)) {
    facts = analyzeUserScriptFromDisk(fileName, dir);
  } else {
    facts = analyzeFileFromDisk(fileName, dir);
  }

  const fileObj = {
    id: `file:${fileName}`,
    name: fileName,
    path: fileName,
    ext: facts.ext,
    module: '',
    moduleId: null,
    layer: 'root',
    lineCount: facts.lineCount,
    isTest: false,
    isEntry: !!facts.isUserScript || ENTRY_BASENAMES.has(fileName),
    isPageFile: false,
    importIds: [],
    typeImportCount: 0,
    unresolvedImports: [],
    exportNames: facts.exportNames ?? [],
    opensOverlayIds: [],
    unusedExports: [], // 单文件模式无法判定跨文件使用，导出级判定仅全仓库扫描提供
    reviewed: false,
    notes: null,
  };
  const factsMap = new Map([[fileName, facts]]);
  const fileObjectByPath = new Map([[fileName, fileObj]]);

  // 类型实体：非导出实体按本文件引用计数判死；导出实体不判死（单文件模式无法判定跨文件使用）
  const { interfaces, classes, methods, localTypesByFile } = collectTypeEntities([fileName], factsMap, fileObjectByPath);

  // 本文件内 implements/extends 解析（本文件声明的类型；跨文件导入名留存原名不报错）
  const localType = (name) => localTypesByFile.get(fileName)?.get(name) ?? null;
  for (const iface of interfaces) {
    iface.extendsIds = iface.extendsNames.map(localType).filter(Boolean);
  }
  for (const cls of classes) {
    cls.implementsIds = cls.implementsNames.map(localType).filter(Boolean);
    if (cls.extendsName) cls.extendsId = localType(cls.extendsName);
  }
  linkMethodOverrides(interfaces, classes, methods);

  // 油猴文件：五类脚本对象（含函数级死代码候选）
  const us = facts.isUserScript
    ? buildUserScriptObjects(fileName, facts, fileObj)
    : { userScript: null, gmApiUsages: [], injectionPoints: [], networkEndpoints: [], scriptFunctions: [] };

  const dataMap = {
    _meta: {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      mode: 'single-file',
      file: absFilePath,
      objectCounts: {
        SourceFile: 1,
        Interface: interfaces.length,
        Class: classes.length,
        Method: methods.length,
        UserScript: us.userScript ? 1 : 0,
        GmApiUsage: us.gmApiUsages.length,
        InjectionPoint: us.injectionPoints.length,
        NetworkEndpoint: us.networkEndpoints.length,
        ScriptFunction: us.scriptFunctions.length,
      },
    },
    SourceFile: [fileObj],
    Interface: interfaces,
    Class: classes,
    Method: methods,
    UserScript: us.userScript ? [us.userScript] : [],
    GmApiUsage: us.gmApiUsages,
    InjectionPoint: us.injectionPoints,
    NetworkEndpoint: us.networkEndpoints,
    ScriptFunction: us.scriptFunctions,
  };
  return dataMap;
}
