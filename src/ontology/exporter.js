function table(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const cell = (c) => String(c ?? '').replace(/\|/g, '\\|'); // 签名中的联合类型 | 需转义，避免撑破表格列
  const body = rows.map((r) => `| ${r.map(cell).join(' | ')} |`).join('\n');
  return [head, sep, body].join('\n');
}

export function exportToMarkdown(dataMap) {
  const meta = dataMap._meta ?? {};
  const counts = meta.objectCounts ?? {};
  const proj = dataMap.Project?.[0] ?? {};
  const userScripts = dataMap.UserScript ?? [];
  const out = [];
  let sectionNo = 0;
  const heading = (title) => {
    sectionNo += 1;
    out.push(`## ${sectionNo}. ${title}`);
    out.push('');
  };

  out.push(`# ${proj.name} 前端代码本体快照`);
  out.push('');
  out.push(`> 生成时间: ${meta.generatedAt ?? '-'} | 分支: ${proj.branch ?? '-'} | commit: ${(proj.commitHash ?? '-').slice(0, 8)} | 分析耗时: ${meta.durationMs ?? '-'}ms`);
  out.push('');

  heading('项目概览');
  out.push(table(['指标', '数值'], [
    ['框架', proj.frameworkLabel ?? proj.framework ?? 'unknown'],
    ['架构风格', proj.architecture?.styleLabel ?? '-'],
    ['语义架构层数', proj.architecture?.layerCount ?? '-'],
    ['功能域数', proj.architecture?.domainCount ?? '-'],
    ['源文件总数', proj.fileCount],
    ['tsx 文件', proj.tsxFileCount],
    ['ts 文件', proj.tsFileCount],
    ['js/jsx 文件', proj.jsFileCount],
    ['vue 文件', proj.vueFileCount ?? 0],
    ['油猴脚本文件', proj.userScriptFileCount ?? 0],
    ['模块数', counts.Module],
    ['功能域对象数', counts.Domain ?? 0],
    ['组件数', counts.Component],
    ['自定义 Hook/Composable 数', counts.Hook],
    ['Store 数（Zustand/Pinia）', counts.Store],
    ['Service 模块数', counts.Service],
    ['接口数（Interface）', counts.Interface ?? 0],
    ['类数（Class）', counts.Class ?? 0],
    ['方法/函数数（Method）', counts.Method ?? 0],
    ['路由数（Overlay/Vue Router）', counts.Route],
    ['npm 依赖数', counts.Dependency],
    ['油猴脚本数', counts.UserScript ?? 0],
    ['DOM 注入点数', counts.InjectionPoint ?? 0],
    ['网络端点数', counts.NetworkEndpoint ?? 0],
    ['脚本函数数', counts.ScriptFunction ?? 0],
    ['解析错误数', (proj.analysisErrors ?? []).length],
  ]));
  out.push('');

  heading('执行摘要');
  if (proj.summary) {
    for (const sentence of proj.summary.split('。').filter(Boolean)) {
      out.push(`- ${sentence}。`);
    }
    out.push('');
  }
  if (proj.health) {
    out.push(table(['健康指标', '数值'], [
      ['循环依赖组数', proj.health.cycleCount ?? 0],
      ['死代码候选文件数', proj.health.orphanFileCount ?? 0],
      ['死代码候选类型数（接口/类）', proj.health.deadTypeCount ?? 0],
      ['死代码候选函数数（方法/模块函数）', proj.health.deadFunctionCount ?? 0],
      ['未声明依赖数', proj.health.undeclaredDependencyCount ?? 0],
      ['高风险油猴脚本数', proj.health.highRiskScriptCount ?? 0],
      ['解析错误数', proj.health.analysisErrorCount ?? 0],
    ]));
    out.push('');
  }

  heading('架构总览（语义分层）');
  const archLayers = proj.architecture?.layers ?? [];
  if (archLayers.length === 0) {
    out.push('（无分层信息）');
  } else {
    out.push(table(['语义层', '定位', '文件数', '占比'], archLayers.map((l) => [
      l.label, l.description, l.fileCount, `${l.share}%`,
    ])));
    out.push('');
    out.push(`> 分层依据内容信号推断（单元构成/路由归属/引用结构），目录名仅作弱信号回退；单一模块内构成分散时标记为混合层。`);
    out.push('');
  }

  const domains = dataMap.Domain ?? [];
  if (domains.length > 0) {
    heading('功能域地图（Domain）');
    out.push(table(['功能域', '来源', '路由', '组件', 'Store', '脚本', '文件', '职责画像'], domains.map((d) => [
      d.name, (d.sources ?? []).join('+'), d.routeCount, d.componentCount, d.storeCount,
      d.scriptCount, d.fileCount, d.summary,
    ])));
    out.push('');
  }

  heading('目录层文件分布');
  const layerCount = new Map();
  for (const f of dataMap.SourceFile ?? []) {
    layerCount.set(f.layer, (layerCount.get(f.layer) ?? 0) + 1);
  }
  out.push(table(['目录层', '文件数'], [...layerCount.entries()].sort((a, b) => b[1] - a[1])));
  out.push('');

  heading('模块 Top 30（按直属文件数）');
  const topModules = [...(dataMap.Module ?? [])].sort((a, b) => b.fileCount - a.fileCount).slice(0, 30);
  out.push(table(['模块', '语义层', '层构成', '直属文件', '子树文件', '职责画像'], topModules.map((m) => [
    m.path,
    m.archLayerLabel ?? m.archLayer ?? '-',
    Object.entries(m.layerComposition ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') || '-',
    m.fileCount,
    m.subtreeFileCount ?? m.fileCount,
    m.summary ?? '-',
  ])));
  out.push('');

  heading('路由地图（Overlay / Vue Router）');
  out.push(table(['路由', 'routePath', 'backTarget', 'hidesNav', 'domain', '组件文件'], (dataMap.Route ?? []).map((r) => [
    r.overlayId, r.routePath ?? '-', r.backTarget ?? '-', r.hidesNav ?? '-', r.domain,
    r.componentFileId ? r.componentFileId.slice(5) : `⚠️ ${r.componentRef}`,
  ])));
  out.push('');

  heading('页面导航图（navigatesTo 边）');
  const navEdges = (dataMap.Route ?? []).flatMap((r) => r.navigatesToIds.map((t) => [r.overlayId, t.slice(6)]));
  out.push(`共 ${navEdges.length} 条跳转边：`);
  out.push('');
  out.push(table(['从 (overlay)', '到 (overlay)'], navEdges));
  out.push('');

  heading('高扇入组件 Top 20（被渲染最多）');
  const renderedByCount = new Map();
  for (const c of dataMap.Component ?? []) {
    for (const t of c.rendersIds ?? []) renderedByCount.set(t, (renderedByCount.get(t) ?? 0) + 1);
  }
  const topRendered = [...renderedByCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([id, n]) => {
      const comp = (dataMap.Component ?? []).find((c) => c.id === id);
      return [id.slice(5), comp?.filePath ?? '', n];
    });
  out.push(table(['组件', '文件', '被渲染次数'], topRendered));
  out.push('');

  heading('Store 一览（Zustand / Pinia）');
  out.push(table(['Store', '状态键数', 'persist', 'storageKey', '位置', '文件'], (dataMap.Store ?? []).map((s) => [
    s.name, s.stateKeyCount, s.hasPersist ? '✓' : '-', s.storageKey ?? '-', s.location, s.filePath,
  ])));
  out.push('');

  // ---- 类型实体：Interface / Class / Method ----
  const ifaces = dataMap.Interface ?? [];
  const allClasses = dataMap.Class ?? [];
  const allMethods = dataMap.Method ?? [];
  const methodById = new Map(allMethods.map((m) => [m.id, m]));
  if (ifaces.length > 0 || allClasses.length > 0) {
    const implementersByIface = new Map();
    for (const c of allClasses) {
      for (const iid of c.implementsIds ?? []) {
        if (!implementersByIface.has(iid)) implementersByIface.set(iid, []);
        implementersByIface.get(iid).push(c.name);
      }
    }
    const loc = (e) => `${e.filePath}:${e.line}`;
    const extendsCell = (e) => {
      const names = e.extendsNames ?? [];
      if (names.length === 0) return '-';
      return `${names.join(', ')}（${(e.extendsIds ?? []).length}/${names.length} 解析）`;
    };

    heading('接口与实现（Interface ↔ implementedBy）');
    if (ifaces.length === 0) {
      out.push('（未提取到接口实体）');
    } else {
      out.push(table(['接口', '文件:行', 'extends', '方法数', '被实现数', '实现类', '死代码候选'], ifaces.slice(0, 300).map((i) => [
        i.name, loc(i), extendsCell(i), (i.methodIds ?? []).length,
        (implementersByIface.get(i.id) ?? []).length,
        (implementersByIface.get(i.id) ?? []).join(', ') || '-',
        i.deadCandidate ? `⚠️ ${i.deadReason}` : '-',
      ])));
      if (ifaces.length > 300) out.push(`> 仅显示前 300 个接口，共 ${ifaces.length} 个。`);
      out.push('');
      // 方法覆盖矩阵：有实现类的接口，方法级 overrides 汇总
      const matrixRows = [];
      for (const i of ifaces) {
        if ((implementersByIface.get(i.id) ?? []).length === 0) continue;
        for (const mid of i.methodIds ?? []) {
          const m = methodById.get(mid);
          if (!m) continue;
          matrixRows.push([
            i.name, m.name, m.signature ?? '-', (m.overriddenByIds ?? []).length,
            (m.overriddenByIds ?? []).map((id) => methodById.get(id)?.ownerName ?? id).join(', ') || '⚠️ 无实现',
          ]);
        }
      }
      if (matrixRows.length > 0) {
        out.push('方法覆盖矩阵（有实现类的接口，⚠️ 无实现 = 契约方法未被任何实现类覆盖）：');
        out.push('');
        out.push(table(['接口', '方法', '签名', '被覆盖数', '实现方法（owner）'], matrixRows.slice(0, 200)));
        if (matrixRows.length > 200) out.push(`> 仅显示前 200 行，共 ${matrixRows.length} 行。`);
        out.push('');
      }
    }

    heading('类与方法（Class）');
    if (allClasses.length === 0) {
      out.push('（未提取到类实体）');
    } else {
      out.push(table(['类', '文件:行', 'implements', 'extends', '单例', '方法数', '死代码候选'], allClasses.slice(0, 300).map((c) => [
        c.name, loc(c),
        (c.implementsNames ?? []).length > 0 ? `${c.implementsNames.join(', ')}（${(c.implementsIds ?? []).length}/${c.implementsNames.length} 解析）` : '-',
        c.extendsName ? `${c.extendsName}${c.extendsId ? '' : '（未解析）'}` : '-',
        c.isSingleton ? '✓' : '-', (c.methodIds ?? []).length,
        c.deadCandidate ? `⚠️ ${c.deadReason}` : '-',
      ])));
      if (allClasses.length > 300) out.push(`> 仅显示前 300 个类，共 ${allClasses.length} 个。`);
      out.push('');
      // 契约热点：被覆盖最多的方法（接口/父类方法）
      const hotMethods = allMethods
        .filter((m) => (m.overriddenByIds ?? []).length > 0)
        .sort((a, b) => b.overriddenByIds.length - a.overriddenByIds.length)
        .slice(0, 30);
      if (hotMethods.length > 0) {
        out.push('契约热点 Top 30（被实现/覆盖最多的方法）：');
        out.push('');
        out.push(table(['方法', 'owner', '文件:行', '被覆盖数', '签名'], hotMethods.map((m) => [
          m.name, `${m.ownerKind}:${m.ownerName ?? '-'}`, loc(m), m.overriddenByIds.length, m.signature ?? '-',
        ])));
        out.push('');
      }
    }
  }

  // ---- 油猴脚本分析（存在 UserScript 对象时输出）----
  if (userScripts.length > 0) {
    heading('油猴脚本一览（UserScript）');
    out.push(table(['脚本', '版本', '宿主框架', '行数', '函数数', 'GM API', '注入点', '网络端点', '风险', '文件'], userScripts.map((s) => [
      s.name, s.version ?? '-', s.hostFramework, s.lineCount, s.functionCount,
      `${s.gmApiCount}(${s.gmApiCallCount})`, s.injectionCount, s.networkEndpointCount,
      `${s.riskLevel}/${s.riskCount}`, s.filePath,
    ])));
    out.push('');
    for (const s of userScripts) {
      out.push(`### ${s.name}（${s.version ?? '-'}）`);
      out.push('');
      out.push(table(['属性', '值'], [
        ['@match', s.matches.join('<br>')],
        ['@grant', s.grantNone ? 'none（页面上下文，无沙箱）' : s.grants.join(', ')],
        ['@connect', s.connects.join(', ') || '-'],
        ['@require', s.requires.length],
        ['@resource', s.resources.join(', ') || '-'],
        ['@run-at', s.runAt],
        ['代码结构', `${s.isIife ? 'IIFE' : '顶层直执行'}${s.usesStrict ? ' + strict' : ''}，顶层函数 ${s.topLevelFunctionCount}/${s.functionCount}`],
        ['观察者/定时器', `MutationObserver ${s.mutationObserverCount}，interval ${s.intervalCount}，timeout ${s.timeoutCount}，listener ${s.listenerCount}`],
        ['生命周期事件', s.lifecycleEvents.join(', ') || '-'],
        ['事件总线', s.customEventsEmitted.length > 0 ? `派发: ${s.customEventsEmitted.slice(0, 10).join(', ')}；监听: ${s.customEventsListened.slice(0, 10).join(', ')}` : '-'],
        ['unsafeWindow', s.usesUnsafeWindow ? `读: ${s.unsafeWindowReads.slice(0, 8).join(', ') || '-'}；写: ${s.unsafeWindowWrites.slice(0, 8).join(', ') || '-'}` : '未使用'],
        ['存储策略', `GM_set/GetValue、localStorage ${s.storageUsage.localStorage ?? 0}、sessionStorage ${s.storageUsage.sessionStorage ?? 0}、indexedDB ${s.storageUsage.indexedDB ?? 0}`],
        ['顶层调用链', s.topLevelCalls.slice(0, 8).map((c) => `${c.name}×${c.count}`).join(', ') || '-'],
      ]));
      out.push('');
    }

    heading('GM API 使用（@grant 声明比对）');
    out.push(table(['脚本', 'API', '类别', '调用次数', '声明'], (dataMap.GmApiUsage ?? []).map((g) => [
      g.scriptName, g.name, g.category, g.callCount, g.declared ? '✓' : '⚠️ 未声明',
    ])));
    out.push('');

    heading('DOM 注入点');
    out.push(table(['脚本', '类型', '目标', '次数', '动态插值', '行'], (dataMap.InjectionPoint ?? []).map((i) => [
      i.scriptName,
      { 'mount': '页面挂载', 'inner-html': 'innerHTML', 'insert-adjacent': 'insertAdjacentHTML', 'document-write': 'document.write', 'style-gm': 'GM_addStyle', 'style-element': 'style 元素', 'shadow-dom': 'Shadow DOM' }[i.kind] ?? i.kind,
      String(i.target).slice(0, 80), i.callCount, i.interpolated ? '⚠️' : '-', (i.lines ?? []).slice(0, 3).join(','),
    ])));
    out.push('');

    heading('网络请求与请求劫持');
    const netRows = (dataMap.NetworkEndpoint ?? []).map((n) => [
      n.scriptName,
      { 'gm-xhr': 'GM_xmlhttpRequest', 'fetch': 'fetch', 'xhr': 'XHR', 'websocket': 'WebSocket', 'beacon': 'sendBeacon' }[n.kind] ?? n.kind,
      n.domain, n.callCount, (n.urls ?? []).slice(0, 2).join('<br>') || '-',
      n.allowedByConnect === null ? '-' : (n.allowedByConnect ? '✓' : '⚠️ 未声明'),
    ]);
    const hijackRows = userScripts.flatMap((s) => (s.risks ?? [])
      .filter((r) => r.kind.startsWith('hijack-'))
      .map((r) => [s.name, r.kind.replace('hijack-', '劫持 '), r.detail, r.line ?? '-']));
    out.push(table(['脚本', '方式', '域名', '次数', '示例 URL', '@connect'], netRows));
    out.push('');
    if (hijackRows.length > 0) {
      out.push(`请求劫持（原型/全局函数重写）共 ${hijackRows.length} 处：`);
      out.push('');
      out.push(table(['脚本', '类型', '目标', '行'], hijackRows));
    } else {
      out.push('未检测到 fetch/XHR/EventTarget/history 等请求劫持。');
    }
    out.push('');

    heading('脚本函数 Top 30（按行数，逻辑分布）');
    const topFns = [...(dataMap.ScriptFunction ?? [])].sort((a, b) => b.lineCount - a.lineCount).slice(0, 30);
    out.push(table(['函数', '类型', '行', '行数', '调用出边', '被调', 'GM', '网络', 'DOM', '注入'], topFns.map((f) => [
      f.name, f.kind, f.line, f.lineCount, f.callCount, f.calledByCount, f.gmApiCount, f.networkCallCount, f.domOpCount, f.htmlInjectionCount + f.mountCount,
    ])));
    out.push('');

    heading('安全风险清单（油猴脚本）');
    const allRisks = userScripts.flatMap((s) => (s.risks ?? []).map((r) => [s.name, r.severity, r.kind, r.detail, r.line ?? '-']));
    if (allRisks.length === 0) {
      out.push('未检测到风险项。');
    } else {
      const sevOrder = { high: 0, medium: 1, low: 2 };
      allRisks.sort((a, b) => sevOrder[a[1]] - sevOrder[b[1]]);
      out.push(table(['脚本', '级别', '类型', '说明', '行'], allRisks));
    }
    out.push('');
  }

  heading('循环依赖');
  const cycles = meta.cycles ?? [];
  if (cycles.length === 0) {
    out.push('未检测到循环依赖。');
  } else {
    out.push(`检测到 ${cycles.length} 组循环依赖：`);
    out.push('');
    for (const cycle of cycles.slice(0, 50)) {
      out.push(`- ${cycle.join(' → ')}`);
    }
  }
  out.push('');

  heading('死代码候选（文件级 + 类型级 + 函数级）');
  const orphans = meta.orphanCandidates ?? [];
  if (orphans.length === 0) {
    out.push('未发现零引用文件。');
  } else {
    out.push(`共 ${orphans.length} 个文件未被任何模块导入、也未被路由/lazy 引用（人工确认后可清理）：`);
    out.push('');
    for (const f of orphans.slice(0, 200)) out.push(`- ${f}`);
    if (orphans.length > 200) out.push(`- ……（其余 ${orphans.length - 200} 个略）`);
  }
  out.push('');

  const deadTypes = [...(dataMap.Interface ?? []), ...(dataMap.Class ?? [])].filter((e) => e.deadCandidate);
  out.push(`类型级（接口/类，保守判定，共 ${deadTypes.length} 个）：`);
  out.push('');
  if (deadTypes.length > 0) {
    out.push(table(['类型', '名称', '文件:行', '理由'], deadTypes.slice(0, 200).map((e) => [
      e.id.startsWith('iface:') ? 'Interface' : 'Class', e.name, `${e.filePath}:${e.line}`, e.deadReason,
    ])));
    if (deadTypes.length > 200) out.push(`> 仅显示前 200 个，共 ${deadTypes.length} 个。`);
  } else {
    out.push('未发现死代码候选类型。');
  }
  out.push('');

  const deadFns = (dataMap.Method ?? []).filter((m) => m.deadCandidate);
  out.push(`函数级（方法/模块函数，保守判定，共 ${deadFns.length} 个；接口方法为契约声明不判死）：`);
  out.push('');
  if (deadFns.length > 0) {
    out.push(table(['方法/函数', 'owner', '文件:行', '理由'], deadFns.slice(0, 300).map((m) => [
      m.name, m.ownerKind === 'module' ? '模块函数' : `${m.ownerKind}:${m.ownerName ?? '-'}`,
      `${m.filePath}:${m.line}`, m.deadReason,
    ])));
    if (deadFns.length > 300) out.push(`> 仅显示前 300 个，共 ${deadFns.length} 个。`);
  } else {
    out.push('未发现死代码候选函数。');
  }
  out.push('');

  heading('外部依赖使用频次 Top 30');
  const topDeps = [...(dataMap.Dependency ?? [])].sort((a, b) => b.importCount - a.importCount).slice(0, 30);
  out.push(table(['依赖', '版本', '导入次数', '声明状态'], topDeps.map((d) => [
    d.name, d.version ?? '-', d.importCount, d.source === 'undeclared' ? '⚠️ 未声明' : d.source,
  ])));
  out.push('');

  const errors = proj.analysisErrors ?? [];
  if (errors.length > 0) {
    heading('解析错误');
    for (const e of errors.slice(0, 50)) out.push(`- ${e.file}: ${e.error}`);
    out.push('');
  }

  return out.join('\n');
}
