// 蓝图共享骨架样式：三个查看器（部署 / 数据库 / 代码）完全一致的基础规则。
// 透明色一律用 color-mix() 从主题变量派生，保证任意主题下视觉跟随。
// 各查看器专属布局（拓扑层 / ER 图 / 功能域图等）保留在各自 viewer 中，并在共享块之后注入以覆盖差异。

export const SHARED_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--fg); font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; font-size: 14px; line-height: 1.6; }
header { padding: 20px 24px 0; border-bottom: 1px solid var(--border); }
header > * { max-width: 1600px; margin-left: auto; margin-right: auto; }
h1 { font-size: 20px; }
.sub { color: var(--fg-dim); font-size: 12px; margin-top: 4px; }
/* ---- 统计卡片 ---- */
.stats { display: flex; gap: 12px; flex-wrap: wrap; margin: 14px 0; }
.stats .stat { text-align: center; flex: 1 1 90px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.stats .stat .v { font-size: 22px; font-weight: 700; color: var(--blue); }
.stats .stat .k { font-size: 11px; color: var(--fg-dim); }
/* ---- 标签页 ---- */
.tabs { display: flex; gap: 4px; margin-top: 14px; flex-wrap: wrap; }
.tab-btn, .tab { padding: 8px 16px; cursor: pointer; color: var(--fg-dim); border: 1px solid transparent; border-bottom: none; border-radius: 6px 6px 0 0; font-size: 14px; background: none; }
.tab-btn:hover, .tab:hover { color: var(--fg); background: var(--panel); }
.tab-btn.active, .tab.active { color: var(--fg); background: var(--panel); border-color: var(--border); position: relative; top: 1px; }
/* ---- 主区 ---- */
main { padding: 20px 24px 48px; max-width: 1600px; margin-left: auto; margin-right: auto; }
section.view { display: none; }
section.view.active { display: block; }
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
.mono { font-family: 'SF Mono', Menlo, Consolas, monospace; }
/* ---- 卡片网格 ---- */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px; cursor: pointer; transition: border-color .15s; }
.card:hover { border-color: var(--blue); }
.card .title { font-size: 14px; font-weight: 600; margin-bottom: 4px; font-family: 'SF Mono', Menlo, monospace; word-break: break-all; }
.card .desc { color: var(--fg-dim); font-size: 12px; margin-bottom: 8px; }
/* ---- 通用元素 ---- */
.badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; border: 1px solid var(--border); }
.search-bar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
.search-bar input { flex: 1; min-width: 200px; padding: 8px 12px; background: var(--panel2); border: 1px solid var(--border); border-radius: 6px; color: var(--fg); font-size: 14px; }
.empty { text-align: center; padding: 40px; color: var(--fg-dim); }
/* ---- 表格 ---- */
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
th { color: var(--fg-dim); font-weight: 600; font-size: 12px; white-space: nowrap; }
tr:hover td { background: color-mix(in srgb, var(--blue) 4%, transparent); }
/* ---- 健康仪表盘 ---- */
.health-score { display: flex; align-items: center; gap: 32px; margin-bottom: 24px; }
.score-ring-svg { flex-shrink: 0; line-height: 0; }
.score-ring-svg circle.score-arc { transition: stroke-dashoffset 1.1s cubic-bezier(.25,.8,.35,1); }
.dim-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-bottom: 20px; }
.dim-card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
.dim-card .dim-name { font-size: 13px; color: var(--fg-dim); margin-bottom: 6px; }
.dim-card .dim-score { font-size: 24px; font-weight: 700; margin-bottom: 8px; font-variant-numeric: tabular-nums; }
.dim-bar { height: 6px; background: var(--panel2); border-radius: 3px; overflow: hidden; }
.dim-bar-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, color-mix(in srgb, var(--bar-c, var(--blue)) 40%, transparent), var(--bar-c, var(--blue))); box-shadow: 0 0 10px color-mix(in srgb, var(--bar-c, var(--blue)) 45%, transparent); }
.issue-item { padding: 8px 12px; border-left: 3px solid var(--border); margin-bottom: 6px; background: var(--panel2); border-radius: 0 4px 4px 0; font-size: 13px; }
.issue-item.error, .issue-item.high { border-left-color: var(--red); }
.issue-item.warn, .issue-item.medium { border-left-color: var(--amber); }
.issue-item.info, .issue-item.low { border-left-color: var(--blue); }
.metric-row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.metric-card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 20px; min-width: 130px; text-align: center; }
.metric-card .metric-val { font-size: 26px; font-weight: 700; color: var(--blue); font-variant-numeric: tabular-nums; }
.metric-card .metric-label { font-size: 12px; color: var(--fg-dim); margin-top: 2px; }
@media (max-width: 768px) { .grid { grid-template-columns: 1fr; } .stats { gap: 12px; } .health-score { flex-direction: column; } }
@media (prefers-reduced-motion: reduce) { .score-ring-svg circle.score-arc { transition: none; } .card { transition: none; } }
`;
