function table(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map((c) => String(c ?? '')).join(' | ')} |`).join('\n');
  return [head, sep, body].join('\n');
}

export function exportToMarkdown(dataMap) {
  const meta = dataMap._meta ?? {};
  const counts = meta.objectCounts ?? {};
  const proj = dataMap.Project?.[0] ?? {};
  const out = [];

  out.push(`# ${proj.name} 前端代码本体快照`);
  out.push('');
  out.push(`> 生成时间: ${meta.generatedAt ?? '-'} | 分支: ${proj.branch ?? '-'} | commit: ${(proj.commitHash ?? '-').slice(0, 8)} | 分析耗时: ${meta.durationMs ?? '-'}ms`);
  out.push('');

  out.push('## 1. 项目概览');
  out.push('');
  out.push(table(['指标', '数值'], [
    ['源文件总数', proj.fileCount],
    ['tsx 文件', proj.tsxFileCount],
    ['ts 文件', proj.tsFileCount],
    ['js/jsx 文件', proj.jsFileCount],
    ['模块数', counts.Module],
    ['组件数', counts.Component],
    ['自定义 Hook 数', counts.Hook],
    ['Zustand Store 数', counts.Store],
    ['Service 模块数', counts.Service],
    ['Overlay 路由数', counts.Route],
    ['npm 依赖数', counts.Dependency],
    ['解析错误数', (proj.analysisErrors ?? []).length],
  ]));
  out.push('');

  out.push('## 2. 分层文件分布');
  out.push('');
  const layerCount = new Map();
  for (const f of dataMap.SourceFile ?? []) {
    layerCount.set(f.layer, (layerCount.get(f.layer) ?? 0) + 1);
  }
  out.push(table(['层', '文件数'], [...layerCount.entries()].sort((a, b) => b[1] - a[1])));
  out.push('');

  out.push('## 3. 模块 Top 30（按文件数）');
  out.push('');
  const topModules = [...(dataMap.Module ?? [])].sort((a, b) => b.fileCount - a.fileCount).slice(0, 30);
  out.push(table(['模块', '层', '文件数'], topModules.map((m) => [m.path, m.layer, m.fileCount])));
  out.push('');

  out.push('## 4. Overlay 路由地图');
  out.push('');
  out.push(table(['路由 ID', 'routePath', 'backTarget', 'hidesNav', 'domain', '组件文件'], (dataMap.Route ?? []).map((r) => [
    r.overlayId, r.routePath ?? '-', r.backTarget ?? '(stack)', r.hidesNav, r.domain,
    r.componentFileId ? r.componentFileId.slice(5) : `⚠️ ${r.componentRef}`,
  ])));
  out.push('');

  out.push('## 5. 页面导航图（navigatesTo 边）');
  out.push('');
  const navEdges = (dataMap.Route ?? []).flatMap((r) => r.navigatesToIds.map((t) => [r.overlayId, t.slice(6)]));
  out.push(`共 ${navEdges.length} 条跳转边：`);
  out.push('');
  out.push(table(['从 (overlay)', '到 (overlay)'], navEdges));
  out.push('');

  out.push('## 6. 高扇入组件 Top 20（被渲染最多）');
  out.push('');
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

  out.push('## 7. Zustand Store 一览');
  out.push('');
  out.push(table(['Store', '状态键数', 'persist', 'storageKey', '位置', '文件'], (dataMap.Store ?? []).map((s) => [
    s.name, s.stateKeyCount, s.hasPersist ? '✓' : '-', s.storageKey ?? '-', s.location, s.filePath,
  ])));
  out.push('');

  out.push('## 8. 循环依赖');
  out.push('');
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

  out.push('## 9. 死代码候选（零引用文件）');
  out.push('');
  const orphans = meta.orphanCandidates ?? [];
  if (orphans.length === 0) {
    out.push('未发现零引用文件。');
  } else {
    out.push(`共 ${orphans.length} 个文件未被任何模块导入、也未被路由/lazy 引用（人工确认后可清理）：`);
    out.push('');
    for (const f of orphans.slice(0, 200)) out.push(`- ${f}`);
  }
  out.push('');

  out.push('## 10. 外部依赖使用频次 Top 30');
  out.push('');
  const topDeps = [...(dataMap.Dependency ?? [])].sort((a, b) => b.importCount - a.importCount).slice(0, 30);
  out.push(table(['依赖', '版本', '导入次数', '声明状态'], topDeps.map((d) => [
    d.name, d.version ?? '-', d.importCount, d.source === 'undeclared' ? '⚠️ 未声明' : d.source,
  ])));
  out.push('');

  const errors = proj.analysisErrors ?? [];
  if (errors.length > 0) {
    out.push('## 11. 解析错误');
    out.push('');
    for (const e of errors.slice(0, 50)) out.push(`- ${e.file}: ${e.error}`);
    out.push('');
  }

  return out.join('\n');
}
