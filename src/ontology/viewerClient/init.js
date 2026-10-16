// 蓝图客户端脚本片段。顺序由 viewerClient.js 拼接，勿单独重排。
export const INIT = `// ---------- 初始化 ----------
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
if (!M.stats) hideTab('stats');
if (!M.codeGraph || (!M.codeGraph.moduleView && !M.codeGraph.componentView)) hideTab('codegraph');
renderOverview();
renderOntology();
renderBlueprint();
renderData();
renderFlow();
if (M.stats) renderStats();
if (M.codeGraph) renderCodeGraph();
if (M.routeMap) renderRouteMap();
if (M.propFlow) renderPropFlow();
if (M.entities) renderEntities();
if (M.scriptBlueprint) renderScripts();
if (M.interactive) { /* renderInteractive 调用移到第二个 script 块中（依赖其内定义的 renderInteractive / renderActionCardHtml） */ }
</script>
`;
