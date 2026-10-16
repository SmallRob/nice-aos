// 蓝图客户端脚本片段。顺序由 viewerClient.js 拼接，勿单独重排。
export const SCRIPTS_TAB = `// ---------- Tab 5: 脚本蓝图（油猴脚本函数调用图 + 逻辑注入链）----------
const ROLE = {};
((M.scriptBlueprint && M.scriptBlueprint.roleMeta) || []).forEach((r) => { ROLE[r.key] = r; });
// 角色流向矩阵的展示顺序：事件驱动 → 逻辑 → 数据/状态 → 构建 → 渲染
const ROLE_FLOW_ORDER = ['event', 'logic', 'data', 'state', 'ui', 'render'];
const roleColor = (roles) => ((ROLE[(roles || ['logic'])[0]] || {}).color) || '#8b949e';
const roleLabel = (r) => (ROLE[r] ? ROLE[r].label : r);

let selectedScript = null;
function renderScripts() {
  const el = document.getElementById('view-scripts');
  const sb = M.scriptBlueprint;
  if (!sb || !sb.scriptCount) {
    el.innerHTML = '<div class="panel"><h2>脚本蓝图</h2><div class="empty">未检测到油猴脚本（UserScript）——React/Vue 仓库无脚本蓝图。</div></div>';
    return;
  }
  const cards = sb.scripts.map((s, i) =>
    '<div class="card" data-idx="' + i + '"><h4>' + esc(s.name) + (s.version ? ' <span class="sub">v' + esc(s.version) + '</span>' : '') + '</h4>'
    + (s.matches.length ? '<div class="sum">' + s.matches.map(esc).join(' · ') + '</div>' : '')
    + '<div class="chips">'
    + (s.riskLevel !== 'none' ? chip('风险 ' + s.riskLevel, s.riskLevel === 'high' ? 'red' : (s.riskLevel === 'medium' ? 'amber' : 'green')) : chip('风险 none', 'green'))
    + (s.hostFramework && s.hostFramework !== 'unknown' ? chip(s.hostFramework, 'cyan') : '')
    + chip(fmt(s.lineCount) + ' 行', '')
    + chip((s.functionTable.length ? '函数 ' + fmt(s.functionTable.length) + '+' : '') + (s.roleCounts ? fmt(Object.values(s.roleCounts).reduce((a, b) => a + b, 0)) + ' 函数' : ''), 'purple')
    + chip(s.graph.anchors.injectionTotal + ' 注入', 'cyan')
    + chip(s.graph.anchors.networkTotal + ' 端点', 'amber')
    + '</div>'
    + (s.topRisks.length ? '<div class="sum" style="color:var(--amber)">' + s.topRisks[0].detail + '</div>' : '')
    + '</div>').join('');
  el.innerHTML =
    '<div class="panel"><h2>油猴脚本蓝图（' + sb.scriptCount + ' 个脚本 · 高风险 ' + sb.highRiskCount + ' · 中风险 ' + sb.mediumRiskCount + '）</h2>'
    + '<div class="chips" style="margin-bottom:12px">'
    + chip('函数 ' + fmt(sb.totalFunctionCount), 'purple')
    + chip('DOM 注入点 ' + fmt(sb.totalInjectionCount), 'cyan')
    + chip('网络端点 ' + fmt(sb.totalNetworkCount), 'amber')
    + '</div>'
    + '<div class="note">展示规模最大的前 ' + sb.shownScriptCount + ' 个脚本（按函数数排序）；点击卡片查看该脚本的函数调用关系图与逻辑注入链。</div>'
    + '<div class="grid">' + cards + '</div></div>'
    + '<div id="script-detail"></div>';
  el.querySelectorAll('.card').forEach((c) => c.addEventListener('click', () => {
    el.querySelectorAll('.card').forEach((x) => x.classList.remove('selected'));
    c.classList.add('selected');
    selectedScript = sb.scripts[Number(c.dataset.idx)];
    renderScriptDetail();
  }));
}

function buildScriptGraphSvg(g) {
  const nodes = g.nodes || [];
  if (!nodes.length) return '<div class="empty">该脚本无可识别的逻辑单元（函数/对象/类）。</div>';
  const byName = {};
  nodes.forEach((n) => { byName[n.name] = n; });
  let entries = (g.entryNames || []).filter((n) => byName[n]);
  if (!entries.length) entries = nodes.filter((n) => !(n.calledBy || []).length).map((n) => n.name);
  if (!entries.length) entries = [nodes[0].name];
  const level = {};
  const q = [];
  entries.forEach((n) => { level[n] = 0; q.push(n); });
  while (q.length) {
    const cur = q.shift();
    const lv = level[cur];
    (byName[cur].calls || []).forEach((to) => {
      if (!byName[to] || to === cur) return;
      if (level[to] === undefined || level[to] > lv + 1) { level[to] = lv + 1; q.push(to); }
    });
  }
  let maxLv = 0;
  Object.values(level).forEach((v) => { if (v > maxLv) maxLv = v; });
  nodes.forEach((n) => { if (level[n.name] === undefined) level[n.name] = maxLv + 1; });
  maxLv = Math.max.apply(null, nodes.map((n) => level[n.name]));

  const COL = 250, ROW = 48, W = 184, H = 36, PADX = 24, PADY = 34;
  const cols = [];
  nodes.forEach((n) => { const lv = level[n.name]; (cols[lv] = cols[lv] || []).push(n); });
  const pos = {};
  let maxRows = 1;
  cols.forEach((c, lv) => {
    c.forEach((n, i) => { pos[n.name] = { x: PADX + lv * COL, y: PADY + i * ROW }; });
    if (c.length > maxRows) maxRows = c.length;
  });
  const inj = (g.anchors && g.anchors.injections) || [];
  const net = (g.anchors && g.anchors.networks) || [];
  const injX = PADX + (maxLv + 1) * COL;
  const netX = injX + COL;
  inj.forEach((a, i) => { pos['@i' + i] = { x: injX, y: PADY + i * ROW }; });
  net.forEach((a, i) => { pos['@n' + i] = { x: netX, y: PADY + i * ROW }; });
  const rowsTotal = Math.max(maxRows, inj.length, net.length);
  const svgW = netX + W + PADX;
  const svgH = PADY * 2 + Math.max(1, rowsTotal - 1) * ROW;

  const edgeSeen = {};
  const edges = [];
  nodes.forEach((n) => (n.calls || []).forEach((to) => {
    if (!byName[to] || to === n.name) return;
    const k = n.name + '>' + to;
    if (edgeSeen[k]) return;
    edgeSeen[k] = 1;
    edges.push({ from: n.name, to: to, kind: 'call' });
  }));
  inj.forEach((a, i) => (a.fns || []).forEach((fn) => { if (byName[fn]) edges.push({ from: fn, to: '@i' + i, kind: 'inject' }); }));
  net.forEach((a, i) => (a.fns || []).forEach((fn) => { if (byName[fn]) edges.push({ from: fn, to: '@n' + i, kind: 'net' }); }));

  let s = '<svg width="' + svgW + '" height="' + svgH + '" viewBox="0 0 ' + svgW + ' ' + svgH + '">';
  s += '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#8b949e"/></marker></defs>';
  s += '<text class="col-label" x="' + PADX + '" y="14">入口</text>';
  if (inj.length) s += '<text class="col-label" x="' + injX + '" y="14">DOM 注入点</text>';
  if (net.length) s += '<text class="col-label" x="' + netX + '" y="14">网络端点</text>';
  edges.forEach((e) => {
    const a = pos[e.from]; const b = pos[e.to];
    if (!a || !b) return;
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
    let d;
    if (b.x > a.x + 20) {
      const mx = (x1 + x2) / 2;
      d = 'M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ',' + mx + ' ' + y2 + ',' + (x2 - 3) + ' ' + y2;
    } else {
      const cy = Math.min(y1, y2) - 22;
      d = 'M' + x1 + ' ' + y1 + ' C' + (x1 + 46) + ' ' + cy + ',' + (x2 - 46) + ' ' + cy + ',' + x2 + ' ' + y2;
    }
    s += '<path class="ge ' + e.kind + '" data-e="' + esc(e.from) + '§' + esc(e.to) + '" d="' + d + '" marker-end="url(#arr)"/>';
  });
  nodes.forEach((n) => {
    const p = pos[n.name]; const c = roleColor(n.roles);
    const label = n.name.length > 24 ? n.name.slice(0, 23) + '…' : n.name;
    s += '<g class="gn" data-n="' + esc(n.name) + '">'
      + '<rect x="' + p.x + '" y="' + p.y + '" width="' + W + '" height="' + H + '" rx="6" stroke="' + c + '"' + (n.isEntry ? ' stroke-width="2.5"' : '') + '/>'
      + '<text x="' + (p.x + 10) + '" y="' + (p.y + 15) + '">' + esc(label) + '</text>'
      + '<text x="' + (p.x + 10) + '" y="' + (p.y + 28) + '" style="fill:#8b949e;font-size:10px">' + esc((n.roles || []).map(roleLabel).join(' · ')) + '</text>'
      + '<title>' + esc(n.name) + '  L' + (n.line || '?') + ' · ' + (n.lineCount || 0) + ' 行 · 被调 ' + ((n.calledBy || []).length) + ' 次</title>'
      + '</g>';
  });
  inj.forEach((a, i) => {
    const p = pos['@i' + i];
    const label = String(a.target || '').length > 26 ? String(a.target).slice(0, 25) + '…' : (a.target || '');
    s += '<g class="gn" data-n="@i' + i + '">'
      + '<rect x="' + p.x + '" y="' + p.y + '" width="' + W + '" height="' + H + '" rx="10" stroke="#39c5cf" fill="rgba(57,197,207,.07)" stroke-dasharray="4 3"/>'
      + '<text x="' + (p.x + 10) + '" y="' + (p.y + 15) + '" style="fill:#39c5cf">' + esc(label) + '</text>'
      + '<text x="' + (p.x + 10) + '" y="' + (p.y + 28) + '" style="fill:#8b949e;font-size:10px">' + esc(a.kind + (a.interpolated ? ' · 动态插值' : '')) + '</text>'
      + '<title>' + esc(a.kind + ' → ' + a.target + ' × ' + a.callCount + (a.lines && a.lines.length ? '  L' + a.lines.join(',') : '')) + '</title></g>';
  });
  net.forEach((a, i) => {
    const p = pos['@n' + i];
    const label = String(a.domain || '').length > 26 ? String(a.domain).slice(0, 25) + '…' : (a.domain || '');
    s += '<g class="gn" data-n="@n' + i + '">'
      + '<rect x="' + p.x + '" y="' + p.y + '" width="' + W + '" height="' + H + '" rx="18" stroke="#bc8cff" fill="rgba(188,140,255,.07)" stroke-dasharray="3 3"/>'
      + '<text x="' + (p.x + 10) + '" y="' + (p.y + 15) + '" style="fill:#bc8cff">' + esc(label) + '</text>'
      + '<text x="' + (p.x + 10) + '" y="' + (p.y + 28) + '" style="fill:#8b949e;font-size:10px">' + esc(a.kind + (a.methods && a.methods.length ? ' ' + a.methods.join('/') : '') + (a.allowedByConnect === false ? ' · 未@connect' : '')) + '</text>'
      + '<title>' + esc(a.kind + ' → ' + a.domain + ' × ' + a.callCount) + '</title></g>';
  });
  s += '</svg>';
  return s;
}

function bindGraphEvents(svgEl, script) {
  const info = document.getElementById('script-fn-info');
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
      const key = g.dataset.n;
      if (key.charAt(0) === '@') {
        const isNet = key.charAt(1) === 'n';
        const idx = Number(key.slice(2));
        const a = isNet ? script.graph.anchors.networks[idx] : script.graph.anchors.injections[idx];
        if (!a) return;
        info.innerHTML = '<b class="name">' + esc(isNet ? a.domain : a.target) + '</b> '
          + chip(isNet ? a.kind : a.kind, isNet ? 'purple' : 'cyan')
          + (isNet ? (a.allowedByConnect === false ? chip('未在 @connect 声明', 'red') : (a.allowedByConnect === true ? chip('@connect 已声明', 'green') : '')) : (a.interpolated ? chip('动态插值（XSS 面）', 'red') : ''))
          + ' <span class="sub">× ' + a.callCount + ' · 归属函数：' + (a.fns && a.fns.length ? a.fns.map(esc).join('、') : '（未识别）') + '</span>';
        return;
      }
      const node = script.graph.nodes.find((x) => x.name === key);
      if (!node) return;
      info.innerHTML = '<b class="name">' + esc(node.name) + '</b> '
        + (node.roles || []).map((r) => chip(roleLabel(r), r === 'render' ? 'blue' : r === 'data' ? 'purple' : r === 'state' ? 'green' : r === 'event' ? 'amber' : r === 'ui' ? 'cyan' : '')).join(' ')
        + chip('L' + (node.line || '?'), '')
        + chip((node.lineCount || 0) + ' 行', '')
        + (node.isEntry ? chip('入口', 'red') : '')
        + (node.gmApis && node.gmApis.length ? chip('GM: ' + node.gmApis.join(','), 'amber') : '')
        + '<div class="sub">调用 → ' + ((node.calls || []).length ? node.calls.map(esc).join('、') : '（无）')
        + ' · 被 ← ' + ((node.calledBy || []).length ? node.calledBy.map(esc).join('、') : '（顶层直调）') + '</div>'
        + (node.injects && node.injects.length ? '<div class="sub">注入 → ' + node.injects.map((i) => esc(i.kind + ' ' + i.target)).join('；') + '</div>' : '')
        + (node.nets && node.nets.length ? '<div class="sub">请求 → ' + node.nets.map((n) => esc(n.domain)).join('、') + '</div>' : '');
    });
  });
}

function renderScriptDetail() {
  const s = selectedScript;
  const box = document.getElementById('script-detail');
  if (!s) { box.innerHTML = ''; return; }
  const riskChip = s.riskLevel === 'high' ? chip('风险 high', 'red') : s.riskLevel === 'medium' ? chip('风险 medium', 'amber') : chip('风险 ' + s.riskLevel, 'green');
  const roleEntries = Object.entries(s.roleCounts || {}).sort((a, b) => b[1] - a[1]);
  const maxRole = roleEntries.length ? roleEntries[0][1] : 0;
  const inj = s.graph.anchors.injections;
  const net = s.graph.anchors.networks;

  box.innerHTML =
    '<div class="panel"><div class="back"><button class="btn" id="btn-sback">← 收起</button></div>'
    + '<h2>' + esc(s.name) + (s.version ? ' v' + esc(s.version) : '') + '</h2>'
    + '<div class="path">' + esc(s.filePath) + '</div>'
    + '<div class="chips" style="margin:8px 0">' + riskChip
    + (s.hostFramework && s.hostFramework !== 'unknown' ? chip('宿主 ' + s.hostFramework, 'cyan') : '')
    + (s.runAt ? chip('run-at ' + s.runAt, '') : '')
    + chip(fmt(s.lineCount) + ' 行', '')
    + (s.grantNone ? chip('@grant none', 'amber') : (s.grants.length ? chip('@grant × ' + s.grants.length, 'blue') : ''))
    + (s.connects.length ? chip('@connect × ' + s.connects.length, 'purple') : '')
    + '</div>'
    + (s.matches.length ? '<div class="sub">匹配页面：' + s.matches.map(esc).join(' · ') + '</div>' : '')

    + '<h3>逻辑注入关系图（函数调用 → DOM 注入点 / 网络端点）</h3>'
    + '<div class="graph-wrap" id="script-graph"></div>'
    + '<div class="legend">'
    + '<span><span class="line" style="border-color:rgba(88,166,255,.8)"></span>调用</span>'
    + '<span><span class="line" style="border-color:#39c5cf;border-top-style:dashed"></span>DOM 注入</span>'
    + '<span><span class="line" style="border-color:#bc8cff;border-top-style:dotted"></span>网络请求</span>'
    + '<span class="note" style="margin:0">· 悬停高亮邻接 · 点击查看详情 · 从左到右为调用深度</span></div>'
    + '<div id="script-fn-info"><div class="note">点击图中节点查看函数详情（角色/行号/调用关系/注入目标）。</div></div>'
    + (s.functionTable.length > s.graph.nodes.length ? '<div class="note">图示重要性 Top ' + s.graph.nodes.length + ' 函数（共 ' + fmt(Object.values(s.roleCounts || {}).reduce((a, b) => a + b, 0)) + ' 个），完整清单见下表。</div>' : '')
    + '</div>'

    + '<div class="panel"><h3>业务角色分布</h3>'
    + roleEntries.map((r) => barRow(roleLabel(r[0]), r[1], maxRole, r[0] === 'render' ? '' : r[0] === 'data' ? 'purple' : r[0] === 'state' ? 'green' : r[0] === 'event' ? 'amber' : 'cyan')).join('')
    + '<div class="note">角色按函数内行为推断：渲染注入（innerHTML/挂载）、数据获取（网络请求）、状态存取（GM 存储）、事件监听（监听器/观察者/定时器）、元素构建（createElement）。</div></div>'

    + '<div class="panel"><h3>函数清单（Top ' + s.functionTable.length + '）</h3>'
    + table(
      [{ label: '函数' }, { label: '角色' }, { label: '行', num: true }, { label: '行数', num: true }, { label: '调用', num: true }, { label: '被调', num: true }, { label: 'GM', num: true }, { label: 'DOM', num: true }, { label: '网络', num: true }],
      s.functionTable.map((f) => [
        { v: f.name, html: '<b>' + esc(f.name) + '</b> <span class="note">' + esc(f.kind) + '</span>' },
        { v: (f.roles || []).join(','), html: (f.roles || []).map((r) => chip(roleLabel(r), r === 'render' ? 'blue' : r === 'data' ? 'purple' : r === 'state' ? 'green' : r === 'event' ? 'amber' : r === 'ui' ? 'cyan' : '')).join(' ') },
        { v: f.line ?? '-', num: true },
        { v: f.lineCount ?? '-', num: true },
        { v: f.callCount, num: true },
        { v: f.calledByCount, num: true },
        { v: f.gmApiCount, num: true },
        { v: f.domOpCount, num: true },
        { v: f.networkCallCount, num: true },
      ]))
    + '</div>'

    + '<div class="panel"><h3>DOM 注入点（' + inj.length + ' / ' + s.graph.anchors.injectionTotal + '）</h3>'
    + (inj.length ? table(
      [{ label: '类型' }, { label: '注入目标（页面锚点）' }, { label: '归属函数' }, { label: '次数', num: true }, { label: '行' }],
      inj.map((i) => [
        { v: i.kind, html: chip(i.kind, i.kind === 'mount' ? 'cyan' : 'blue') },
        { v: i.target, html: '<span class="path">' + esc(i.target) + '</span>' + (i.interpolated ? ' ' + chip('动态插值', 'red') : '') },
        { v: (i.fns || []).join(','), html: (i.fns || []).length ? (i.fns || []).map((f) => '<b>' + esc(f) + '</b>').join('、') : '<span class="note">（未识别）</span>' },
        { v: i.callCount, num: true },
        { v: (i.lines || []).join(',') || '-' },
      ])) : '<div class="empty">无 DOM 注入点。</div>')
    + '<div class="note">挂载目标经 querySelector 变量锚点还原（如 container → #gameList）；动态插值标记为潜在 XSS 面。</div></div>'

    + '<div class="panel"><h3>网络端点（' + net.length + ' / ' + s.graph.anchors.networkTotal + '）</h3>'
    + (net.length ? table(
      [{ label: '域名' }, { label: '类型' }, { label: '方法' }, { label: '@connect' }, { label: '归属函数' }, { label: '次数', num: true }],
      net.map((n) => [
        { v: n.domain, html: '<b>' + esc(n.domain) + '</b>' },
        { v: n.kind, html: chip(n.kind, 'purple') },
        { v: (n.methods || []).join('/') || '-' },
        { v: n.allowedByConnect, html: n.allowedByConnect === true ? chip('已声明', 'green') : n.allowedByConnect === false ? chip('未声明', 'red') : '<span class="note">—</span>' },
        { v: (n.fns || []).join(','), html: (n.fns || []).length ? (n.fns || []).map((f) => '<b>' + esc(f) + '</b>').join('、') : '<span class="note">（未识别）</span>' },
        { v: n.callCount, num: true },
      ])) : '<div class="empty">无网络请求。</div>')
    + '</div>'

    + (s.topRisks.length ? '<div class="panel"><h3>风险清单</h3><ul class="plain">'
      + s.topRisks.map((r) => '<li>' + chip(r.severity, r.severity === 'high' ? 'red' : r.severity === 'medium' ? 'amber' : 'green') + ' <b>' + esc(r.kind) + '</b> — ' + esc(r.detail) + (r.line ? '（L' + r.line + '）' : '') + '</li>').join('')
      + '</ul></div>' : '');

  const graphEl = document.getElementById('script-graph');
  graphEl.innerHTML = buildScriptGraphSvg(s.graph);
  const svgEl = graphEl.querySelector('svg');
  if (svgEl) bindGraphEvents(svgEl, s);
  box.querySelector('#btn-sback').addEventListener('click', () => {
    selectedScript = null;
    document.getElementById('view-scripts').querySelectorAll('.card').forEach((x) => x.classList.remove('selected'));
    box.innerHTML = '';
  });
}

`;
