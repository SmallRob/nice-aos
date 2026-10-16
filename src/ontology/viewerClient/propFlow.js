// 蓝图客户端脚本片段。顺序由 viewerClient.js 拼接，勿单独重排。
export const PROP_FLOW = `// ---------- Tab: 组件数据流（React Props 传递链）----------
const PROP_SOURCE_META = {
  forward: { label: '转发', cls: 'blue', desc: '父组件 props 原样转发' },
  state: { label: '本地状态', cls: 'amber', desc: 'useState 声明的组件内状态' },
  store: { label: '状态库', cls: 'green', desc: 'useXxxStore / useQuery 等外部数据源' },
  handler: { label: '回调', cls: 'purple', desc: '内联函数或本地函数引用' },
  computed: { label: '计算值', cls: 'cyan', desc: '成员访问 / 调用结果 / 表达式计算' },
  literal: { label: '字面量', cls: '', desc: '字符串 / 数字 / 布尔常量' },
  spread: { label: '展开', cls: 'red', desc: '{...obj} 整体透传（不展开成员）' },
};
const propSourceChip = (s) => {
  const m = PROP_SOURCE_META[s] ?? { label: s || '?', cls: '' };
  return '<span class="chip ' + (m.cls || '') + '">' + esc(m.label) + '</span>';
};

const PROP_DOMAIN_PALETTE = ['#58a6ff', '#bc8cff', '#3fb950', '#d29922', '#39c5cf', '#f85149', '#7ee787', '#ffa657', '#d2a8ff', '#79c0ff'];
const propDomainColor = (name) => {
  if (!name || !M.propFlow) return '#8b949e';
  const idx = M.propFlow.domainOptions.findIndex((d) => d.name === name);
  return idx >= 0 ? PROP_DOMAIN_PALETTE[idx % PROP_DOMAIN_PALETTE.length] : '#8b949e';
};

const PROP_NODE_CAP = 80;
function buildPropFlowSvg(nodes, edges) {
  // BFS 分层：入度 0（无父组件传 props）为第 0 层顶层容器；环内 / 被截断节点沉到最后一列
  const adj = {};
  const inn = {};
  edges.forEach((e) => {
    (adj[e.fromId] = adj[e.fromId] || []).push(e.toId);
    inn[e.toId] = (inn[e.toId] || 0) + 1;
  });
  const level = {};
  const q = [];
  nodes.forEach((n) => { if (!inn[n.id]) { level[n.id] = 0; q.push(n.id); } });
  while (q.length) {
    const cur = q.shift();
    (adj[cur] || []).forEach((to) => {
      if (level[to] === undefined || level[to] > level[cur] + 1) { level[to] = level[cur] + 1; q.push(to); }
    });
  }
  let maxLv = 0;
  Object.keys(level).forEach((k) => { if (level[k] > maxLv) maxLv = level[k]; });
  nodes.forEach((n) => { if (level[n.id] === undefined) level[n.id] = maxLv + 1; });
  maxLv = Math.max.apply(null, nodes.map((n) => level[n.id]));

  const COL = 260, ROW = 54, W = 208, H = 42, PADX = 24, PADY = 34;
  const cols = [];
  nodes.forEach((n) => { const lv = level[n.id]; (cols[lv] = cols[lv] || []).push(n); });
  cols.forEach((c) => c.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')));
  const pos = {};
  let maxRows = 1;
  cols.forEach((c, lv) => {
    c.forEach((n, i) => { pos[n.id] = { x: PADX + lv * COL, y: PADY + i * ROW }; });
    if (c.length > maxRows) maxRows = c.length;
  });
  const svgW = PADX * 2 + maxLv * COL + W;
  const svgH = PADY * 2 + Math.max(1, maxRows - 1) * ROW + H;

  let s = '<svg width="' + svgW + '" height="' + svgH + '" viewBox="0 0 ' + svgW + ' ' + svgH + '">';
  s += '<defs><marker id="parr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#8b949e"/></marker></defs>';
  s += '<text class="col-label" x="' + PADX + '" y="16">顶层</text>';
  for (let lv = 1; lv <= maxLv; lv += 1) s += '<text class="col-label" x="' + (PADX + lv * COL) + '" y="16">' + lv + ' 层</text>';
  edges.forEach((e) => {
    const a = pos[e.fromId]; const b = pos[e.toId];
    if (!a || !b) return;
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
    let c1x, c1y, c2x, c2y;
    if (b.x > a.x + 20) {
      const mx = (x1 + x2) / 2;
      c1x = mx; c1y = y1; c2x = mx; c2y = y2;
    } else {
      const cy = Math.min(y1, y2) - 24;
      c1x = x1 + 56; c1y = cy; c2x = x2 - 56; c2y = cy;
    }
    s += '<path class="ge" data-e="' + esc(e.fromId) + '§' + esc(e.toId) + '" d="M' + x1 + ' ' + y1 + ' C' + c1x + ' ' + c1y + ',' + c2x + ' ' + c2y + ',' + (x2 - 3) + ' ' + y2 + '" marker-end="url(#parr)"/>';
    // 边中点标签 = props 数（三次贝塞尔中点 = (P0 + 3C1 + 3C2 + P3) / 8）
    const lx = (x1 + 3 * c1x + 3 * c2x + x2) / 8;
    const ly = (y1 + 3 * c1y + 3 * c2y + y2) / 8;
    s += '<text class="pe-label" data-e="' + esc(e.fromId) + '§' + esc(e.toId) + '" x="' + lx + '" y="' + (ly - 3) + '" text-anchor="middle">' + e.propCount + '</text>';
  });
  nodes.forEach((n) => {
    const p = pos[n.id];
    const color = propDomainColor(n.domain);
    const label = n.name.length > 24 ? n.name.slice(0, 23) + '…' : n.name;
    const meta = (n.domain || '无域') + ' · 出' + n.outCount + ' / 入' + n.inCount;
    s += '<g class="gn" data-n="' + esc(n.id) + '">'
      + '<rect class="rbox" x="' + p.x + '" y="' + p.y + '" width="' + W + '" height="' + H + '" rx="6" stroke="' + color + '"'
      + (n.inCount === 0 ? ' stroke-width="2.5"' : '') + '/>'
      + '<text class="rpath" x="' + (p.x + 10) + '" y="' + (p.y + 18) + '">' + esc(label) + '</text>'
      + '<text class="rmeta" x="' + (p.x + 10) + '" y="' + (p.y + 33) + '">' + esc(meta) + '</text>'
      + '<title>' + esc(n.name + ' · ' + n.file) + '</title>'
      + '</g>';
  });
  s += '</svg>';
  return s;
}

let PROP_NODES_BY_ID = {};
function bindPropFlowEvents(svgEl) {
  if (!svgEl) return;
  const info = document.getElementById('props-info');
  svgEl.querySelectorAll('.gn').forEach((g) => {
    g.addEventListener('mouseenter', () => {
      svgEl.classList.add('focus');
      const n = g.dataset.n;
      const related = {};
      related[n] = 1;
      svgEl.querySelectorAll('.ge, .pe-label').forEach((e) => {
        const parts = e.dataset.e.split('§');
        if (parts[0] === n || parts[1] === n) {
          e.classList.add('hl');
          related[parts[0]] = 1;
          related[parts[1]] = 1;
        }
      });
      svgEl.querySelectorAll('.gn').forEach((x) => { if (related[x.dataset.n]) x.classList.add('hl'); });
    });
    g.addEventListener('mouseleave', () => {
      svgEl.classList.remove('focus');
      svgEl.querySelectorAll('.hl').forEach((x) => x.classList.remove('hl'));
    });
    g.addEventListener('click', () => {
      const node = PROP_NODES_BY_ID[g.dataset.n];
      if (!node) return;
      const pf = M.propFlow;
      const outEdges = pf.edges.filter((e) => e.fromId === node.id);
      const inEdges = pf.edges.filter((e) => e.toId === node.id);
      const propChips = (props) => props.slice(0, 8).map((p) =>
        '<span class="prop-item">' + esc(p.name) + ' ' + propSourceChip(p.source)
        + (p.storeHook ? '<span class="sub"> ← ' + esc(p.storeHook) + '</span>' : '')
        + (p.valueText && p.source !== 'literal' ? '<span class="sub"> ' + esc(p.valueText) + '</span>' : '')
        + '</span>').join('');
      const edgeList = (list, dir) => list.slice(0, 8).map((e) =>
        '<div class="prop-edge"><b>' + esc(dir === 'out' ? e.toName : e.fromName) + '</b>'
        + '<span class="sub"> ' + (dir === 'out' ? '传出' : '传入') + ' ' + e.propCount + ' props · ' + e.renderCount + ' 处渲染</span>'
        + '<div class="chips">' + (propChips(e.props) || '<span class="sub">（无）</span>') + '</div></div>').join('');
      info.innerHTML = '<b class="name">' + esc(node.name) + '</b>'
        + (node.domain ? chip(node.domain, 'blue') : '')
        + chip('传出 ' + node.outCount + ' 边 / ' + node.propOutCount + ' props', 'purple')
        + chip('传入 ' + node.inCount + ' 边 / ' + node.propInCount + ' props', 'cyan')
        + '<div class="sub">' + esc(node.file) + '</div>'
        + (outEdges.length ? '<h3>传出（' + outEdges.length + ' 个目标组件）</h3>' + edgeList(outEdges, 'out') : '<div class="sub">无传出边。</div>')
        + (inEdges.length ? '<h3>传入（' + inEdges.length + ' 个来源组件）</h3>' + edgeList(inEdges, 'in') : '<div class="sub">无传入边。</div>');
    });
  });
}

function currentPropFilter() {
  const domain = document.getElementById('prop-domain').value;
  const q = document.getElementById('prop-search').value.trim().toLowerCase();
  return (n) => (!domain || n.domain === domain)
    && (!q || n.name.toLowerCase().includes(q) || (n.file || '').toLowerCase().includes(q));
}

function renderPropFlowGraph() {
  const pf = M.propFlow;
  const match = currentPropFilter();
  let nodes = pf.nodes.filter(match);
  let capped = false;
  if (nodes.length > PROP_NODE_CAP) {
    nodes = nodes.slice()
      .sort((a, b) => (b.inCount + b.outCount) - (a.inCount + a.outCount) || (a.name ?? '').localeCompare(b.name ?? ''))
      .slice(0, PROP_NODE_CAP);
    capped = true;
  }
  const nodeSet = {};
  nodes.forEach((n) => { nodeSet[n.id] = 1; });
  const edges = pf.edges.filter((e) => nodeSet[e.fromId] && nodeSet[e.toId]);
  PROP_NODES_BY_ID = {};
  nodes.forEach((n) => { PROP_NODES_BY_ID[n.id] = n; });
  const wrap = document.getElementById('prop-graph');
  wrap.innerHTML = buildPropFlowSvg(nodes, edges)
    + (capped ? '<div class="note">匹配组件超过 ' + PROP_NODE_CAP + ' 个，已按连接度截断；使用域筛选或搜索缩小范围。</div>' : '');
  const svgEl = wrap.querySelector('svg');
  if (svgEl) bindPropFlowEvents(svgEl);
}

function renderPropFlow() {
  const el = document.getElementById('view-props');
  const pf = M.propFlow;
  const kv = (v, k) => '<div class="item"><div class="v">' + fmt(v) + '</div><div class="k">' + k + '</div></div>';

  const maxSrc = Math.max(1, ...pf.sourceOrder.map((k) => pf.sourceDist[k]));
  const srcRows = pf.sourceOrder.map((k) => {
    const m = PROP_SOURCE_META[k];
    return barRow(m.label, pf.sourceDist[k], maxSrc, m.cls, m.desc);
  });

  const degRows = (list, dir) => list.map((n) => [
    { html: '<b>' + esc(n.name) + '</b>' },
    { html: n.domain ? chip(n.domain, 'blue') : '-' },
    { v: dir === 'out' ? n.outCount : n.inCount, num: true },
    { v: dir === 'out' ? n.propOutCount : n.propInCount, num: true },
    { html: '<span class="path">' + esc(n.file) + '</span>' },
  ]);

  const edgeRows = pf.edges.slice(0, 80).map((e) => [
    { html: '<b>' + esc(e.fromName) + '</b>' + '<span class="sub"> → </span>' + '<b>' + esc(e.toName) + '</b>' },
    { v: e.propCount, num: true },
    { v: e.renderCount, num: true },
    { html: e.props.slice(0, 6).map((p) => esc(p.name) + ' ' + propSourceChip(p.source)).join(' ')
      + (e.props.length > 6 ? ' <span class="sub">+' + (e.props.length - 6) + '</span>' : '') },
    { html: (e.fromDomain && e.toDomain && e.fromDomain !== e.toDomain) ? chip('跨域', 'amber') : '·' },
  ]);

  const domainOptions = pf.domainOptions.map((d) =>
    '<option value="' + esc(d.name) + '">' + esc(d.name) + ' (' + d.count + ')</option>').join('');
  const legendHtml = pf.domainOptions.slice(0, 10).map((d) =>
    '<span class="legend-dot" style="background:' + propDomainColor(d.name) + '"></span>' + esc(d.name)).join('');

  el.innerHTML =
    '<div class="panel"><h2>组件数据流总览（' + fmt(pf.edgeCount) + ' 条传递边 · ' + fmt(pf.nodeCount) + ' 组件 · ' + fmt(pf.propTotal) + ' 个 props）</h2>'
    + '<div class="kv">' + kv(pf.edgeCount, '传递边') + kv(pf.nodeCount, '参与组件') + kv(pf.propTotal, 'props 总数')
    + (pf.spreadCount ? kv(pf.spreadCount, 'spread 透传') : '') + '</div>'
    + '<h3>props 来源分布</h3>' + srcRows.join('')
    + '<div class="note">PropEdge = 组件对间聚合的 props 传递边；来源分类为词法近似（组件声明范围 + 文件级变量表），spread 属性整体透传不展开成员。路由地图中 overlay 路由的工厂注入（App → 工厂 → 页面组件主干链）另以「工厂 N props」徽章展示。</div></div>'

    + '<div class="panel"><h2>Props 传递图（' + pf.nodeCount + ' 组件，BFS 分层：顶层容器 → 子组件，边标签 = props 数）</h2>'
    + '<div class="filter-bar">'
    + '<select id="prop-domain"><option value="">全部域</option>' + domainOptions + '</select>'
    + '<input id="prop-search" placeholder="搜索组件名 / 文件路径…">'
    + '<button class="btn" id="prop-reset">重置</button>'
    + '</div>'
    + '<div class="graph-wrap" id="prop-graph"></div>'
    + '<div class="legend">' + (legendHtml || '<span class="sub">组件未归属功能域</span>') + '</div>'
    + '<div id="props-info"></div>'
    + '<div class="note">节点从左到右按 props 传递层数分层（边框加粗 = 无入边的顶层组件）；边 = 组件对间的 props 传递（同名 prop 聚合）；悬停高亮相邻边，点击节点在下方查看 props 明细（名称 + 来源 + store hook）。默认渲染连接度 Top ' + PROP_NODE_CAP + ' 组件。</div></div>'

    + '<div class="split">'
    + '<div class="panel"><h3>高传出组件 Top ' + pf.topOut.length + '（props 分发枢纽）</h3>'
    + (pf.topOut.length ? table([{ label: '组件' }, { label: '域' }, { label: '出边', num: true }, { label: '传出 props', num: true }, { label: '文件' }], degRows(pf.topOut, 'out')) : '<div class="empty">无。</div>')
    + '</div>'
    + '<div class="panel"><h3>高传入组件 Top ' + pf.topIn.length + '（props 消费方）</h3>'
    + (pf.topIn.length ? table([{ label: '组件' }, { label: '域' }, { label: '入边', num: true }, { label: '传入 props', num: true }, { label: '文件' }], degRows(pf.topIn, 'in')) : '<div class="empty">无。</div>')
    + '</div>'
    + '</div>'

    + '<details class="panel"><summary>Props 传递边清单（' + pf.edges.length + ' 条' + (pf.edges.length > 80 ? '，表内截断至 80' : '') + '，按 props 数排序）</summary>'
    + table([{ label: '来源 → 目标' }, { label: 'props', num: true }, { label: '渲染处', num: true }, { label: 'props 明细' }, { label: '跨域' }], edgeRows)
    + '</details>';

  document.getElementById('prop-domain').addEventListener('change', renderPropFlowGraph);
  document.getElementById('prop-search').addEventListener('input', renderPropFlowGraph);
  document.getElementById('prop-reset').addEventListener('click', () => {
    document.getElementById('prop-domain').value = '';
    document.getElementById('prop-search').value = '';
    renderPropFlowGraph();
  });
  renderPropFlowGraph();
}

`;
