// 蓝图专属 CSS（viewerStyles.js）：viewer.js renderViewerHtml 中 <style> 块的「布局骨架固定/以下为代码蓝图专属样式」段
// 原为 viewer.js renderViewerHtml 内联 ${BLUEPRINT_CSS} 嵌入；与 buildThemeCss / SHARED_CSS 拼接构成完整 <style>。
// 与 themes/index.js 的 buildThemeCss / themes/sharedCss.js 的 SHARED_CSS 保持解耦：基础主题变量由前两者提供，本文件只放代码蓝图专属规则。
export const BLUEPRINT_CSS = `
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
/* ---- 代码统计：KPI 卡片 + 环形图 ---- */
.stats-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 16px; }
.stats-kpi { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; text-align: center; }
.stats-kpi .v { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
.stats-kpi .k { font-size: 12px; color: var(--fg-dim); margin-top: 4px; }
.donut-wrap { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.donut-legend { flex: 1; min-width: 220px; }
.donut-legend .dl-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 12px; color: var(--fg-dim); }
.donut-legend .dl-row .nm { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.donut-legend .dl-row .pv { font-variant-numeric: tabular-nums; }
.layer-row.lr-wide .lbl { width: 240px; }
.layer-row.lr-wide .val { width: 130px; }
@media (max-width: 720px) { .layer-row.lr-wide .lbl { width: 120px; } }
/* ---- 代码图谱：力导向图 ---- */
.cg-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
button.btn.on { border-color: var(--cyan); color: var(--cyan); background: color-mix(in srgb, var(--cyan) 10%, var(--panel2)); }
.cg-hint { font-size: 12px; color: var(--fg-faint); }
.cg-stage { border: 1px solid var(--border); border-radius: 8px; background: var(--panel2); overflow: hidden; position: relative; }
.cg-stage svg { display: block; width: 100%; height: auto; cursor: grab; touch-action: none; }
.cg-stage svg.dragging { cursor: grabbing; }
svg .cgn circle { stroke-width: 1.5; cursor: pointer; }
svg .cgn text { font-size: 10px; font-family: 'SF Mono', Menlo, monospace; fill: var(--fg-dim); paint-order: stroke; stroke: var(--panel2); stroke-width: 3px; pointer-events: none; }
svg .cgn text.big { fill: var(--fg); font-weight: 600; }
svg .cge { stroke: color-mix(in srgb, var(--blue) 45%, transparent); stroke-width: 1.1; }
svg .cge.props { stroke: color-mix(in srgb, var(--green) 60%, transparent); }
svg .cge.usesStore { stroke: color-mix(in srgb, var(--purple) 60%, transparent); stroke-dasharray: 4 3; }
svg .cge.dim { opacity: .35; }
svg.focus .cgn { opacity: .18; }
svg.focus .cgn.hl { opacity: 1; }
/* v0.35.0 邻接聚焦视觉增强（借鉴 GitNexus reducer 范式：选中节点提亮 + 尺寸放大 + 描边强化） */
svg.focus .cgn.hl circle { stroke-width: 3.5; filter: drop-shadow(0 0 6px currentColor); }
svg.focus .cgn.hl text { fill: var(--fg); font-weight: 700; }
svg.focus .cge { opacity: .06; }
svg.focus .cge.hl { opacity: 1; stroke-width: 2.4; filter: drop-shadow(0 0 3px currentColor); }
#cg-info { margin-top: 10px; min-height: 20px; font-size: 13px; }
#cg-info .name { font-family: 'SF Mono', Menlo, monospace; color: var(--blue); }
.ont-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 16px; }
.ont-kpi { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; text-align: center; }
.ont-kpi .v { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--fg); }
.ont-kpi .k { font-size: 11px; color: var(--fg-dim); margin-top: 4px; letter-spacing: 0.5px; }
.ont-kpi.emph .v { color: var(--cyan); }
.ont-cat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
.ont-cat-card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; transition: border-color .15s; }
.ont-cat-card:hover { border-color: color-mix(in srgb, var(--cyan) 40%, var(--border)); }
.ont-cat-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; gap: 8px; }
.ont-cat-head .cat-label { font-size: 14px; font-weight: 600; color: var(--fg); }
.ont-cat-head .cat-desc { font-size: 11px; color: var(--fg-faint); margin-top: 3px; line-height: 1.5; }
.ont-cat-progress { height: 6px; background: var(--panel2); border-radius: 3px; margin-bottom: 12px; }
.ont-cat-progress .fill { height: 100%; background: linear-gradient(90deg, var(--cyan), var(--purple)); border-radius: 3px; transition: width .3s; }
.ont-cat-types { display: flex; flex-direction: column; gap: 4px; }
.ont-type-row { display: grid; grid-template-columns: 56px 1fr auto; gap: 8px; padding: 5px 8px; border-radius: 6px; align-items: center; font-size: 12px; cursor: pointer; transition: background .12s; border: 1px solid transparent; }
.ont-type-row:hover { background: var(--panel2); border-color: var(--border); }
.ont-type-row.selected { background: color-mix(in srgb, var(--cyan) 14%, var(--panel2)); border-color: color-mix(in srgb, var(--cyan) 50%, var(--border)); }
.ont-type-row.idle { opacity: 0.55; }
.ont-type-row .lvl-tag { font-family: 'SF Mono', Menlo, monospace; font-size: 10px; color: var(--fg-faint); text-align: center; padding: 1px 0; border: 1px solid var(--border); border-radius: 3px; }
.ont-type-row .lvl-tag.L0 { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, var(--border)); }
.ont-type-row .lvl-tag.L1 { color: var(--cyan); border-color: color-mix(in srgb, var(--cyan) 40%, var(--border)); }
.ont-type-row .lvl-tag.L2 { color: var(--purple); border-color: color-mix(in srgb, var(--purple) 40%, var(--border)); }
.ont-type-row .lvl-tag.L3 { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, var(--border)); }
.ont-type-row .t-meta { display: flex; flex-direction: column; min-width: 0; }
.ont-type-row .t-name { font-family: 'SF Mono', Menlo, monospace; font-size: 12px; color: var(--blue); font-weight: 500; }
.ont-type-row .t-name .prefix-tag { font-size: 10px; color: var(--fg-faint); margin-left: 6px; font-weight: 400; }
.ont-type-row .t-desc { font-size: 11px; color: var(--fg-faint); margin-top: 1px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.ont-type-row .t-cnt { font-variant-numeric: tabular-nums; font-size: 11px; color: var(--fg-dim); padding: 2px 8px; border-radius: 10px; background: var(--panel2); border: 1px solid var(--border); white-space: nowrap; }
.ont-type-row.active .t-cnt { color: var(--cyan); border-color: color-mix(in srgb, var(--cyan) 50%, var(--border)); }
.ont-type-row.idle .t-cnt { color: var(--fg-faint); }
.ont-level-strip { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.ont-level-row { display: grid; grid-template-columns: 80px 1fr 160px; align-items: center; gap: 12px; padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.ont-level-row .lvl-mark { font-family: 'SF Mono', Menlo, monospace; font-size: 14px; font-weight: 700; padding: 2px 8px; border-radius: 4px; text-align: center; }
.ont-level-row.L0 .lvl-mark { color: var(--red); background: color-mix(in srgb, var(--red) 14%, transparent); }
.ont-level-row.L1 .lvl-mark { color: var(--cyan); background: color-mix(in srgb, var(--cyan) 14%, transparent); }
.ont-level-row.L2 .lvl-mark { color: var(--purple); background: color-mix(in srgb, var(--purple) 14%, transparent); }
.ont-level-row.L3 .lvl-mark { color: var(--green); background: color-mix(in srgb, var(--green) 14%, transparent); }
.ont-level-row .lvl-name { font-size: 13px; font-weight: 600; }
.ont-level-row .lvl-desc { font-size: 11px; color: var(--fg-dim); margin-top: 2px; }
.ont-level-row .lvl-stats { display: flex; gap: 12px; justify-content: flex-end; font-size: 12px; color: var(--fg-dim); }
.ont-level-row .lvl-stats b { color: var(--fg); font-variant-numeric: tabular-nums; }
.ont-link-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.ont-link-table th { text-align: left; padding: 7px 10px; font-weight: 600; font-size: 11px; letter-spacing: 0.5px; color: var(--fg-dim); border-bottom: 1px solid var(--border); background: var(--panel2); position: sticky; top: 0; }
.ont-link-table td { padding: 7px 10px; border-bottom: 1px solid var(--border); }
.ont-link-table tr:hover td { background: color-mix(in srgb, var(--cyan) 6%, transparent); }
.ont-link-pair { display: inline-flex; align-items: center; gap: 6px; font-family: 'SF Mono', Menlo, monospace; }
.ont-link-pair .arrow { color: var(--fg-faint); font-size: 11px; }
.ont-link-pair .link-name { padding: 1px 6px; border-radius: 4px; background: color-mix(in srgb, var(--blue) 14%, transparent); color: var(--blue); font-size: 11px; }
.ont-link-pair .link-name.rev { background: color-mix(in srgb, var(--purple) 14%, transparent); color: var(--purple); }
.ont-link-status { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
.ont-link-status.live { background: var(--green); box-shadow: 0 0 4px color-mix(in srgb, var(--green) 60%, transparent); }
.ont-link-status.decl { background: var(--fg-faint); }
.ont-link-status.unknown { background: var(--amber); }
#ont-type-detail { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-top: 12px; min-height: 80px; }
#ont-type-detail .d-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 8px; }
#ont-type-detail .d-head .d-name { font-family: 'SF Mono', Menlo, monospace; font-size: 16px; color: var(--cyan); font-weight: 600; }
#ont-type-detail .d-head .d-meta { display: flex; gap: 8px; font-size: 12px; color: var(--fg-dim); }
#ont-type-detail .d-desc { font-size: 13px; color: var(--fg); line-height: 1.7; margin-bottom: 10px; }
#ont-type-detail .d-sample h4 { font-size: 11px; color: var(--fg-dim); margin-bottom: 4px; letter-spacing: 0.5px; }
#ont-type-detail .d-sample-item { padding: 4px 8px; border-radius: 4px; font-family: 'SF Mono', Menlo, monospace; font-size: 11.5px; color: var(--fg-dim); background: var(--panel2); margin-bottom: 2px; }
#ont-type-detail .d-empty { color: var(--fg-faint); font-size: 12px; padding: 16px 0; text-align: center; }
@media (max-width: 760px) { .ont-level-row { grid-template-columns: 60px 1fr; } .ont-level-row .lvl-stats { grid-column: 2; justify-content: flex-start; } }
};
`;
