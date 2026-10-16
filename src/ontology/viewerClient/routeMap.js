// 蓝图客户端脚本片段。顺序由 viewerClient.js 拼接，勿单独重排。
export const ROUTE_MAP = `// ---------- Tab 4.5: 路由地图（路由总览 / 导航链 SVG / 路径层级树 / 域分组 / 全量清单）----------
const ROUTE_TYPE_META = {
  overlay: { label: 'overlay', color: '#bc8cff' },
  react: { label: 'react-router', color: '#58a6ff' },
  vue: { label: 'vue-router', color: '#3fb950' },
  flutter: { label: 'Flutter', color: '#00b4ab' },
  next: { label: 'Next 页面', color: '#d29922' },
  'next-api': { label: 'Next API', color: '#f85149' },
  go: { label: 'Go HTTP', color: '#00add8' },
  'go-cli': { label: 'Go CLI', color: '#008b8b' },
};
const routeTypeMeta = (t) => ROUTE_TYPE_META[t] ?? { label: t || 'route', color: '#8b949e' };
const routeTypeChip = (t) => {
  const m = routeTypeMeta(t);
  return '<span class="chip" style="color:' + m.color + ';border-color:' + m.color + '55">' + esc(m.label) + '</span>';
};

function buildRouteGraphSvg(rm) {
  const ROUTE_NODE_CAP = 60;
  const out = {}, inn = {};
  rm.navEdges.forEach((e) => { out[e.from] = (out[e.from] || 0) + 1; inn[e.to] = (inn[e.to] || 0) + 1; });
  let nodes = rm.items.slice();
  if (nodes.length > ROUTE_NODE_CAP) {
    nodes.sort((a, b) => ((out[b.id] || 0) + (inn[b.id] || 0)) - ((out[a.id] || 0) + (inn[a.id] || 0))
      || a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
    nodes = nodes.slice(0, ROUTE_NODE_CAP);
  }
  const nodeSet = {};
  nodes.forEach((n) => { nodeSet[n.id] = 1; });
  const edges = rm.navEdges.filter((e) => nodeSet[e.from] && nodeSet[e.to]);

  // BFS 分层：入度 0 的路由为第 0 层入口，沿导航边取最短跳数；未被覆盖的（环内/被截断）沉到最后一列
  const adj = {};
  edges.forEach((e) => { (adj[e.from] = adj[e.from] || []).push(e.to); });
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

  const COL = 300, ROW = 58, W = 244, H = 46, PADX = 24, PADY = 34;
  const cols = [];
  nodes.forEach((n) => { const lv = level[n.id]; (cols[lv] = cols[lv] || []).push(n); });
  cols.forEach((c) => c.sort((a, b) => a.path.localeCompare(b.path)));
  const pos = {};
  let maxRows = 1;
  cols.forEach((c, lv) => {
    c.forEach((n, i) => { pos[n.id] = { x: PADX + lv * COL, y: PADY + i * ROW }; });
    if (c.length > maxRows) maxRows = c.length;
  });
  const svgW = PADX * 2 + maxLv * COL + W;
  const svgH = PADY * 2 + Math.max(1, maxRows - 1) * ROW + H;

  let s = '<svg width="' + svgW + '" height="' + svgH + '" viewBox="0 0 ' + svgW + ' ' + svgH + '">';
  s += '<defs><marker id="rarr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#8b949e"/></marker></defs>';
  s += '<text class="col-label" x="' + PADX + '" y="16">入口</text>';
  for (let lv = 1; lv <= maxLv; lv += 1) s += '<text class="col-label" x="' + (PADX + lv * COL) + '" y="16">' + lv + ' 跳</text>';
  edges.forEach((e) => {
    const a = pos[e.from]; const b = pos[e.to];
    if (!a || !b) return;
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
    let d;
    if (b.x > a.x + 20) {
      const mx = (x1 + x2) / 2;
      d = 'M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ',' + mx + ' ' + y2 + ',' + (x2 - 3) + ' ' + y2;
    } else {
      const cy = Math.min(y1, y2) - 24;
      d = 'M' + x1 + ' ' + y1 + ' C' + (x1 + 56) + ' ' + cy + ',' + (x2 - 56) + ' ' + cy + ',' + x2 + ' ' + y2;
    }
    s += '<path class="ge" data-e="' + esc(e.from) + '§' + esc(e.to) + '" d="' + d + '" marker-end="url(#rarr)"/>';
  });
  nodes.forEach((n) => {
    const p = pos[n.id]; const m = routeTypeMeta(n.routeType);
    const label = n.path.length > 30 ? n.path.slice(0, 29) + '…' : n.path;
    let meta = m.label + (n.componentRef ? ' · ' + n.componentRef : '') + (n.isDynamic ? ' · 动态' : '');
    if (meta.length > 38) meta = meta.slice(0, 37) + '…';
    s += '<g class="gn" data-n="' + esc(n.id) + '">'
      + '<rect class="rbox" x="' + p.x + '" y="' + p.y + '" width="' + W + '" height="' + H + '" rx="6" stroke="' + m.color + '"' + (!inn[n.id] ? ' stroke-width="2.5"' : '') + '/>'
      + '<text class="rpath" x="' + (p.x + 10) + '" y="' + (p.y + 19) + '">' + esc(label) + '</text>'
      + '<text class="rmeta" x="' + (p.x + 10) + '" y="' + (p.y + 35) + '">' + esc(meta) + '</text>'
      + '<title>' + esc(n.path + ' · ' + m.label + (n.componentFile ? ' · ' + n.componentFile : '')) + '</title>'
      + '</g>';
  });
  s += '</svg>';
  return s;
}

function bindRouteGraphEvents(svgEl) {
  if (!svgEl) return;
  const info = document.getElementById('route-info');
  svgEl.querySelectorAll('.gn').forEach((g) => {
    g.addEventListener('mouseenter', () => {
      svgEl.classList.add('focus');
      const n = g.dataset.n;
      const related = {};
      related[n] = 1;
      svgEl.querySelectorAll('.ge').forEach((e) => {
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
      const it = M.routeMap.items.find((x) => x.id === g.dataset.n);
      if (!it) return;
      info.innerHTML = '<b class="name">' + esc(it.path) + '</b> ' + routeTypeChip(it.routeType)
        + (it.domain ? chip(it.domain, 'blue') : '')
        + (it.isDynamic ? chip('动态段', 'amber') : '')
        + (it.isClient === true ? chip('use client', 'cyan') : (it.isClient === false ? chip('server', '') : ''))
        + (it.apiMethods && it.apiMethods.length ? chip('API ' + it.apiMethods.join('/'), 'red') : '')
        + (it.frontendCallCount ? chip('前端调用 ' + it.frontendCallCount, 'cyan') : '')
        + (it.flags?.length ? chip('flags ' + it.flags.length, 'purple') : '')
        + (it.layoutCount ? chip(it.layoutCount + ' 层 layout', 'purple') : '')
        + (it.factoryPropsCount ? chip('工厂注入 ' + it.factoryPropsCount + ' props', 'green') : '')
        + (it.description ? '<div class="sub">' + esc(it.description) + '</div>' : '')
        + (it.componentRef ? '<span class="sub"> ' + (it.routeType === 'go' ? 'handler' : (it.routeType === 'go-cli' ? '命令变量' : '组件')) + ' ' + esc(it.componentRef) + (it.componentFile ? '（' + esc(it.componentFile) + '）' : '') + '</span>' : '')
        + (it.middlewares?.length ? '<div class="sub">中间件：' + esc(it.middlewares.join(' → ')) + '</div>' : '')
        + (it.flags?.length ? '<div class="sub">flags：' + esc(it.flags.join('、')) + '</div>' : '')
        + (it.factoryProps?.length ? '<div class="sub">工厂 props：' + esc(it.factoryProps.join('、')) + '</div>' : '')
        + (it.frontendCalls?.length ? '<div class="sub">前端调用：' + it.frontendCalls.map((c) => esc((c.method ? c.method + ' ' : '') + c.filePath + (c.line ? ':' + c.line : ''))).join('、') + (it.frontendCallCount > it.frontendCalls.length ? ' 等 ' + it.frontendCallCount + ' 处' : '') + '</div>' : '')
        + '<div class="sub">导航 → ' + (it.navToPaths.length ? it.navToPaths.map(esc).join('、') : '（无）') + '</div>';
    });
  });
}

function renderRouteMap() {
  const el = document.getElementById('view-routemap');
  const rm = M.routeMap;

  // 反向索引：路由 ← 被哪些路由导航
  const navBy = {};
  rm.navEdges.forEach((e) => { (navBy[e.to] = navBy[e.to] || []).push(e.fromPath); });

  const TYPE_CLS = { overlay: 'purple', react: 'blue', vue: 'green', flutter: 'teal', next: 'amber', 'next-api': 'red', go: 'teal', 'go-cli': 'purple' };
  const maxType = Math.max(1, ...rm.byType.map((t) => t.count));
  const typeRows = rm.byType.map((t) => barRow(routeTypeMeta(t.key).label, t.count, maxType, TYPE_CLS[t.key]));
  const kv = (v, k) => '<div class="item"><div class="v">' + fmt(v) + '</div><div class="k">' + k + '</div></div>';

  // 路径层级树（递归缩进；段名 + 类型徽标 + 主组件名）
  const treeHtml = (node) => node.children.map((c) => '<li><span class="seg' + (c.seg.startsWith(':') ? ' dyn' : '') + '">' + esc(c.seg) + '</span>'
    + c.routes.map((r) => routeTypeChip(r.routeType)).join('')
    + (c.routes.length && c.routes.some((r) => r.componentRef) ? '<span class="cnt">' + esc(c.routes.map((r) => r.componentRef).filter(Boolean).join(' / ')) + '</span>' : '')
    + (c.children.length ? '<ul>' + treeHtml(c) + '</ul>' : '')
    + '</li>').join('');
  const treeFull = '<ul class="tree"><li><span class="seg">/</span>' + rm.tree.routes.map((r) => routeTypeChip(r.routeType)).join('')
    + (rm.tree.children.length ? '<ul>' + treeHtml(rm.tree) + '</ul>' : '') + '</li></ul>';

  // 域分组（每组路由清单 + 导航去向）
  const groupHtml = rm.domainGroups.slice(0, 12).map((g) => {
    const lis = g.routes.slice(0, 40).map((r) => '<li><b>' + esc(r.path) + '</b> ' + routeTypeChip(r.routeType)
      + (r.apiMethods?.length ? ' ' + chip(r.apiMethods.join('/'), 'red') : '')
      + (r.frontendCallCount ? ' ' + chip('前端 ' + r.frontendCallCount, 'cyan') : '')
      + (r.factoryPropsCount ? ' ' + chip('工厂 ' + r.factoryPropsCount + ' props', 'green') : '')
      + (r.componentRef ? ' <span class="path">' + esc(r.componentRef) + '</span>' : '')
      + (r.navToPaths.length ? '<span class="cnt">→ ' + r.navToPaths.map(esc).join('、') + '</span>' : '')
      + '</li>').join('');
    return '<div><h3>' + esc(g.name) + ' <span class="sub">' + g.routes.length + ' 条</span></h3><ul class="plain">' + lis + '</ul></div>';
  }).join('');

  // 前后端映射：未匹配的前端调用（可能是死接口 / 路径漂移 / 其他后端）
  const unmatchedHtml = rm.unmatchedFrontendCalls?.length
    ? '<details class="panel"><summary>未匹配的前端调用（' + rm.unmatchedFrontendCalls.length + ' 处'
      + (rm.frontendCallTotal ? '，已匹配 ' + rm.frontendCallTotal + ' 处' : '') + '）</summary>'
      + '<div class="note">前端发起但未在 Go 路由中找到对应路径的调用：可能是死接口、路径漂移，或由其他后端（Java/Node 等）承接。</div>'
      + '<ul class="plain">' + rm.unmatchedFrontendCalls.slice(0, 30).map((c) => '<li>'
        + chip(c.method || '?', 'red') + ' <b>' + esc(c.path || '') + '</b>'
        + ' <span class="path">' + esc(c.filePath) + (c.line ? ':' + c.line : '') + '</span></li>').join('')
      + '</ul></details>'
    : '';

  // 全量清单表
  const hasGoRoutes = rm.goApiRouteCount > 0;
  const tableRows = rm.items.slice(0, 150).map((r) => [
    { v: r.path, html: '<b>' + esc(r.path) + '</b>' + (r.isDynamic ? ' ' + chip('动态', 'amber') : '') },
    { v: r.routeType, html: routeTypeChip(r.routeType) },
    { v: r.domain ?? '-', html: r.domain ? chip(r.domain, 'blue') : '-' },
    { v: r.apiMethods?.join('/') ?? '-', html: r.apiMethods?.length ? chip(r.apiMethods.join('/'), 'red') : '-' },
    { v: r.componentRef ?? '-', html: r.componentRef ? esc(r.componentRef) : '-' },
    ...(hasGoRoutes ? [{ v: r.frontendCallCount ? String(r.frontendCallCount) : '-', html: r.frontendCallCount ? chip('前端 ' + r.frontendCallCount, 'cyan') : '-' }] : []),
    { v: r.navToPaths.join('、'), html: r.navToPaths.length ? esc(r.navToPaths.join('、')) : '·' },
    { v: (navBy[r.id] || []).join('、'), html: (navBy[r.id] || []).length ? esc(navBy[r.id].join('、')) : '·' },
  ]);

  el.innerHTML =
    '<div class="panel"><h2>路由总览（' + fmt(rm.totalCount) + ' 条路由 · ' + rm.maxDepth + ' 级路径深度 · ' + rm.domainGroups.length + ' 个域分组）</h2>'
    + '<div class="kv">' + kv(rm.totalCount, '路由') + kv(rm.navEdgeCount, '导航边') + kv(rm.entryCount, '入口路由')
    + kv(rm.orphanCount, '孤岛路由') + (rm.dynamicCount ? kv(rm.dynamicCount, '动态路由') : '')
    + (rm.apiRouteCount ? kv(rm.apiRouteCount, 'API 路由') : '')
    + (rm.goApiRouteCount ? kv(rm.goApiRouteCount, 'Go HTTP 路由') : '')
    + (rm.goCliRouteCount ? kv(rm.goCliRouteCount, 'Go CLI 命令') : '')
    + (rm.frontendCallTotal ? kv(rm.frontendCallTotal, '前端调用已匹配') : '') + '</div>'
    + '<h3>路由类型分布</h3>' + typeRows.join('')
    + '<div class="note">入口路由 = 无任何路由导航指向它（通常为应用首屏 / 登录页）；孤岛路由 = 无进出导航边（深链入口或仅被外部直达）。'
    + (rm.goApiRouteCount ? 'Go HTTP 路由 = Gin / 标准库注册的后端接口；前端调用 = 前端代码中 API.get / axios.x / fetch 与该路径的匹配次数。' : '')
    + (rm.goCliRouteCount ? 'Go CLI 命令 = cobra 命令树（路径层级树按命令段展示，flags 见详情）。' : '') + '</div></div>'

    + '<div class="panel"><h2>路由导航链（' + rm.navEdgeCount + ' 条导航边 · 悬停高亮相邻路由，点击查看详情）</h2>'
    + '<div class="graph-wrap">' + buildRouteGraphSvg(rm) + '</div>'
    + '<div class="legend">' + rm.byType.map((t) => {
      const m = routeTypeMeta(t.key);
      return '<span class="legend-dot" style="background:' + m.color + '"></span>' + esc(m.label);
    }).join('') + '</div>'
    + '<div id="route-info"></div>'
    + '<div class="note">节点从左到右按导航跳数分层（入口 → 1 跳 → 2 跳…），边框加粗 = 入口路由；边 = 源路由页面内的导航调用（Link / pushNamed / go 等）。超过 ' + 60 + ' 条路由时按导航活跃度截断。</div></div>'

    + '<div class="split">'
    + '<div class="panel"><h2>路径层级树（' + rm.maxDepth + ' 级' + (rm.goCliRouteCount ? ' · CLI 命令按段嵌套' : '') + '）</h2>' + treeFull + '</div>'
    + '<div class="panel"><h2>域分组（' + rm.domainGroups.length + ' 组）</h2>' + groupHtml + '</div>'
    + '</div>'

    + unmatchedHtml

    + '<details class="panel"><summary>全量路由清单（' + rm.items.length + ' 条' + (rm.items.length > 150 ? '，表内截断至 150' : '') + '）</summary>'
    + table(hasGoRoutes
      ? [{ label: '路径' }, { label: '类型' }, { label: '域' }, { label: '方法' }, { label: '组件/handler' }, { label: '前端调用' }, { label: '导航去向' }, { label: '被导航' }]
      : [{ label: '路径' }, { label: '类型' }, { label: '域' }, { label: '方法' }, { label: '组件' }, { label: '导航去向' }, { label: '被导航' }], tableRows)
    + '</details>';

  bindRouteGraphEvents(el.querySelector?.('.graph-wrap svg'));
}

`;
