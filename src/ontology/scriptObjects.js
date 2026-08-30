// 单个油猴脚本的五类对象（UserScript/GmApiUsage/InjectionPoint/NetworkEndpoint/ScriptFunction）。
// 原为 builder.js 内部函数 buildUserScriptObjects，单文件分析（buildSingleFileOntology）
// 与全仓库扫描共用（纯函数迁移，逻辑不变）。

import path from 'node:path';
import { uniqueId } from './builderUtils.js';

export function buildUserScriptObjects(relPath, facts, fileObj) {
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
  // v0.41.0: 补 direction / lang / lib 三字段，使 NetworkEndpoint 从"油猴专用"升为统一网络端点
  const networkEndpoints = [];
  const netIds = [];
  for (const net of facts.networkRequests ?? []) {
    const netId = `net:${relPath}#${net.kind}:${net.domain}`;
    netIds.push(netId);
    networkEndpoints.push({
      id: netId,
      // v0.41.0 统一字段：油猴脚本的 GM_xmlhttpRequest / fetch / XHR 全部是客户端发出，即 outbound
      direction: 'outbound',
      lang: 'javascript',
      lib: null,
      kind: net.kind,
      domain: net.domain,
      urls: net.urls,
      methods: net.methods,
      callCount: net.callCount,
      lines: net.lines,
      allowedByConnect: net.allowedByConnect,
      fns: net.fns ?? [],
      fnIds: (net.fns ?? []).map((n) => fnIdMap.get(n)).filter(Boolean),
      files: [relPath],
      fileIds: [fileObj ? fileObj.id : `file:${relPath}`],
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
