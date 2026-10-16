// 蓝图客户端脚本片段。顺序由 viewerClient.js 拼接，勿单独重排。
export const STATS = `// ---------- Tab: 代码统计（KPI + 条形图 + 环形图，纯内联 SVG） ----------
const STATS_COLORS = ['#39c5cf', '#58a6ff', '#bc8cff', '#f472b6', '#3fb950', '#d29922', '#fb923c', '#f87171', '#00b4ab', '#818cf8'];
const STATS_BAR_CLASSES = ['cyan', '', 'purple', '', 'green', 'amber', 'red', 'teal', 'go', ''];
// 环形图：r=15.9155 时周长恰为 100，dasharray 可直接用百分比
function donutSvg(segs, centerVal, centerLabel) {
  const total = segs.reduce((a, s) => a + s.value, 0);
  if (!total) return '<div class="empty">无数据。</div>';
  let acc = 0;
  let circles = '';
  segs.forEach((s, i) => {
    const raw = (s.value / total) * 100;
    const pct = i === segs.length - 1 ? +(100 - acc).toFixed(2) : +raw.toFixed(2);
    circles += '<circle cx="21" cy="21" r="15.9155" fill="none" stroke="' + s.color + '" stroke-width="5.5" stroke-dasharray="' + pct + ' ' + (100 - pct).toFixed(2) + '" stroke-dashoffset="' + (25 - acc).toFixed(2) + '"></circle>';
    acc += pct;
  });
  return '<svg viewBox="0 0 42 42" style="width:180px;height:180px;flex-shrink:0" role="img" aria-label="' + esc(centerLabel) + '">'
    + '<circle cx="21" cy="21" r="15.9155" fill="none" stroke="var(--panel)" stroke-width="5.5"></circle>'
    + circles
    + '<text x="21" y="20.2" text-anchor="middle" style="font-size:6.5px;font-weight:700;fill:var(--fg)">' + esc(centerVal) + '</text>'
    + '<text x="21" y="26.5" text-anchor="middle" style="font-size:3.2px;fill:var(--fg-dim)">' + esc(centerLabel) + '</text>'
    + '</svg>';
}

function renderStats() {
  const el = document.getElementById('view-stats');
  const S = M.stats;
  if (!S) {
    el.innerHTML = '<div class="panel"><h2>代码统计</h2><div class="empty">无源文件数据。</div></div>';
    return;
  }
  const U = S.unitCounts;
  const unitTotal = U.components + U.hooks + U.stores + U.services;
  const kpis = [
    ['var(--cyan)', fmt(S.totalLines), '代码总行数'],
    ['var(--green)', fmt(S.totalFiles), '源文件总数'],
    ['var(--purple)', fmt(S.moduleStats.length), '一级模块'],
    ['var(--orange)', fmt(unitTotal), '代码单元'],
    ['var(--amber)', fmt(S.avgLinesPerFile), '平均单文件行数'],
    ['var(--teal)', fmt(S.testFileCount), '测试文件'],
  ];
  const kpiHtml = '<div class="stats-kpis">' + kpis.map((k) =>
    '<div class="stats-kpi"><div class="v" style="color:' + k[0] + '">' + k[1] + '</div><div class="k">' + k[2] + '</div></div>'
  ).join('') + '</div>';

  const maxMod = S.moduleStats.length ? S.moduleStats[0].lines : 0;
  const moduleBars = S.moduleStats.slice(0, 12).map((m, i) =>
    barRow(m.name, m.lines, maxMod, STATS_BAR_CLASSES[i % STATS_BAR_CLASSES.length], m.path + ' · ' + fmt(m.files) + ' 文件')
  ).join('');

  const donutSrc = S.moduleStats.slice(0, 9);
  const restLines = S.moduleStats.slice(9).reduce((a, m) => a + m.lines, 0);
  if (restLines > 0) donutSrc.push({ name: '其他 ' + (S.moduleStats.length - 9) + ' 个模块', lines: restLines });
  const donutSegs = donutSrc.map((m, i) => ({ label: m.name, value: m.lines, color: STATS_COLORS[i % STATS_COLORS.length] }));
  const donutTotal = donutSegs.reduce((a, s) => a + s.value, 0);
  const donutLegend = donutSegs.map((s) => {
    const pct = donutTotal ? ((100 * s.value) / donutTotal).toFixed(1) : '0';
    return '<div class="dl-row"><span class="legend-dot" style="background:' + s.color + '"></span>'
      + '<span class="nm" title="' + esc(s.label) + '">' + esc(s.label) + '</span>'
      + '<span class="pv">' + fmt(s.value) + ' 行 · ' + pct + '%</span></div>';
  }).join('');

  const maxExt = S.byExt.length ? S.byExt[0].lines : 0;
  const extBars = S.byExt.map((e, i) =>
    barRow(e.label, e.lines, maxExt, STATS_BAR_CLASSES[i % STATS_BAR_CLASSES.length], fmt(e.files) + ' 文件 · ' + e.pct + '%')
  ).join('');
  const maxLayer = S.byLayer.length ? S.byLayer[0].lines : 0;
  const layerBars = S.byLayer.map((l, i) =>
    barRow(l.label, l.lines, maxLayer, STATS_BAR_CLASSES[i % STATS_BAR_CLASSES.length], fmt(l.files) + ' 文件 · ' + l.pct + '%')
  ).join('');

  const unitCls = { component: 'cyan', hook: 'teal', store: 'purple', service: 'amber' };
  const maxUnit = S.topUnits.length ? S.topUnits[0].lineCount : 0;
  const unitBars = S.topUnits.map((u) => {
    const pct = maxUnit > 0 ? Math.round((u.lineCount / maxUnit) * 100) : 0;
    const cls = unitCls[u.kind] || '';
    return '<div class="layer-row lr-wide"><div class="lr-main">'
      + '<span class="lbl" title="' + esc(u.filePath || u.name) + '">' + esc(u.name) + ' ' + chip(u.kindLabel, cls) + '</span>'
      + '<div class="bar-wrap"><div class="bar ' + cls + '" style="width:' + pct + '%"></div></div>'
      + '<span class="val">' + fmt(u.lineCount) + ' 行</span></div>'
      + '<div class="lr-desc">' + esc(u.filePath || '') + '</div></div>';
  }).join('');

  const layerLabelOf = {};
  S.byLayer.forEach((l) => { layerLabelOf[l.key] = l.label; });
  const fileRows = S.topFiles.map((f) => [
    { html: '<span class="path">' + esc(f.name) + '</span>' },
    { v: f.ext || '-' },
    { v: fmt(f.lineCount), num: true },
    { v: f.archLayer ? (layerLabelOf[f.archLayer] || f.archLayer) : '-' },
    { html: '<span class="path">' + esc(f.path) + '</span>' },
  ]);

  el.innerHTML =
    '<div class="panel"><h2>代码统计</h2>'
    + '<div class="chips" style="margin-bottom:12px">'
    + chip('组件 ' + fmt(U.components), 'cyan') + chip('Hook ' + fmt(U.hooks), 'teal')
    + chip('Store ' + fmt(U.stores), 'purple') + chip('服务 ' + fmt(U.services), 'amber')
    + (S.declarationFileCount ? chip('声明文件 ' + fmt(S.declarationFileCount), 'red') : '')
    + '</div>'
    + kpiHtml
    + '<div class="split" style="margin-top:8px">'
    + '<div><h3>模块代码量分布' + (S.moduleStats.length > 12 ? '（Top 12 / ' + S.moduleStats.length + '）' : '') + '</h3>' + moduleBars + '</div>'
    + '<div><h3>代码分布占比</h3><div class="donut-wrap">' + donutSvg(donutSegs, fmt(S.totalLines), '总行数') + '<div class="donut-legend">' + donutLegend + '</div></div></div>'
    + '</div></div>'
    + '<div class="panel"><div class="split">'
    + '<div><h3>语言分布（按行数）</h3>' + extBars + '</div>'
    + '<div><h3>架构层分布（按行数）</h3>' + layerBars + '</div>'
    + '</div></div>'
    + '<div class="panel"><h3>Top 20 代码单元（按行数）</h3>' + unitBars + '</div>'
    + '<div class="panel"><h3>最大文件 Top 15</h3>'
    + table([{ label: '文件' }, { label: '扩展' }, { label: '行数', num: true }, { label: '架构层' }, { label: '路径' }], fileRows)
    + '</div>';
}

`;
