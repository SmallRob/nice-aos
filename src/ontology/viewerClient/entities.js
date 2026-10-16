// 蓝图客户端脚本片段。顺序由 viewerClient.js 拼接，勿单独重排。
export const ENTITIES = `// ---------- Tab 6: 实体类图（UML 类框 + implements/extends 关系边，跨语言 TS/Vue/Rust/Dart/Go）----------
const LANG_META = {
  ts: { label: 'TS/JS', color: '#58a6ff', hdr: 'rgba(88,166,255,.10)' },
  vue: { label: 'Vue', color: '#3fb950', hdr: 'rgba(63,185,80,.10)' },
  rust: { label: 'Rust', color: '#d29922', hdr: 'rgba(210,153,34,.12)' },
  dart: { label: 'Dart', color: '#00b4ab', hdr: 'rgba(0,180,171,.12)' },
  go: { label: 'Go', color: '#00add8', hdr: 'rgba(0,173,216,.12)' },
};
const langColor = (l) => (LANG_META[l] || LANG_META.ts).color;
const langHdr = (l) => (LANG_META[l] || LANG_META.ts).hdr;
const langLabel = (l) => (LANG_META[l] || { label: l }).label;

// 布局：父（被实现/继承）在左、子类在右按派生层级分列；无关系实体沉到最右列
function buildEntitiesSvg(nodes, edges) {
  if (!nodes.length) return '<div class="empty">无匹配实体（调整过滤条件试试）。</div>';
  const parentsOf = {};
  edges.forEach((e) => { (parentsOf[e.from] = parentsOf[e.from] || []).push(e.to); });
  const level = {};
  const computeLevel = (id, seen) => {
    if (level[id] !== undefined) return level[id];
    if (seen[id]) return 0;
    seen[id] = 1;
    let lv = 0;
    for (const p of parentsOf[id] || []) lv = Math.max(lv, computeLevel(p, seen) + 1);
    delete seen[id];
    level[id] = lv;
    return lv;
  };
  nodes.forEach((n) => computeLevel(n.id, {}));
  const hasEdge = {};
  edges.forEach((e) => { hasEdge[e.from] = 1; hasEdge[e.to] = 1; });
  let maxLv = 0;
  nodes.forEach((n) => { if (level[n.id] > maxLv) maxLv = level[n.id]; });
  const noEdgeLevel = maxLv + 1;
  nodes.forEach((n) => { if (!hasEdge[n.id]) level[n.id] = noEdgeLevel; });
  // 压缩空层级（过滤后中间层可能为空）
  const usedLevels = [...new Set(nodes.map((n) => level[n.id]))].sort((a, b) => a - b);
  const colIdx = {};
  usedLevels.forEach((lv, i) => { colIdx[lv] = i; });
  const cols = [];
  nodes.forEach((n) => { const i = colIdx[level[n.id]]; (cols[i] = cols[i] || []).push(n); });
  cols.forEach((c) => c.sort((a, b) => (b.methodCount + b.fieldCount + b.variantCount) - (a.methodCount + a.fieldCount + a.variantCount)));

  const W = 232, HDR = 24, ROW = 15, GAPY = 16, PADX = 26, PADY = 44, COLW = W + 84;
  const boxHeight = (n) => HDR + 6
    + (n.fields.length ? n.fields.length * ROW + 5 : 0)
    + (n.variants.length ? n.variants.length * ROW + 5 : 0)
    + (n.methods.length ? n.methods.length * ROW + 5 : 0)
    + 3;
  const pos = {};
  let colX = PADX, maxH = PADY;
  for (let i = 0; i < cols.length; i++) {
    const colNodes = cols[i] || [];
    let y = PADY;
    colNodes.forEach((n) => {
      pos[n.id] = { x: colX, y, h: boxHeight(n) };
      y += boxHeight(n) + GAPY;
    });
    colX += COLW;
    if (y > maxH) maxH = y;
  }
  const svgW = colX - COLW + W + PADX;
  const svgH = maxH + 8;
  const trunc = (s, len) => (String(s ?? '').length > len ? String(s).slice(0, len - 1) + '…' : String(s ?? ''));

  let s = '<svg width="' + svgW + '" height="' + svgH + '" viewBox="0 0 ' + svgW + ' ' + svgH + '" class="uml">';
  s += '<defs>'
    + '<marker id="arr-impl" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M2,2 L10,6 L2,10 z" fill="#0d1117" stroke="#39c5cf" stroke-width="1.4"/></marker>'
    + '<marker id="arr-ext" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M2,2 L10,6 L2,10 z" fill="#bc8cff"/></marker>'
    + '<marker id="arr-rnd" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M2,2 L10,6 L2,10 z" fill="#3fb950"/></marker>'
    + '</defs>';
  // 列标签：首列 = 契约/父类，末列（若为无关系列）= 未关联实体
  for (let i = 0; i < cols.length; i++) {
    const lv = usedLevels[i];
    let label = '派生第 ' + lv + ' 层';
    if (i === 0 && lv === 0) label = '契约 / 父类（被实现与继承）';
    if (lv === noEdgeLevel) label = '未关联实体';
    s += '<text class="col-label" x="' + (PADX + i * COLW) + '" y="16">' + esc(label) + '</text>';
  }
  // 关系边：子类左缘 → 父类右缘（UML 箭头指向接口/父类；renders 为组件组合，绿色实线）
  const EDGE_STYLE = { implements: ['impl', 'arr-impl'], renders: ['rnd', 'arr-rnd'] };
  edges.forEach((e) => {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) return;
    const [cls, marker] = EDGE_STYLE[e.kind] ?? ['ext', 'arr-ext'];
    const y1 = a.y + HDR / 2, y2 = b.y + HDR / 2;
    const x1 = a.x - 2, x2 = b.x + W + 2;
    const mx = (x1 + x2) / 2;
    const d = 'M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ',' + mx + ' ' + y2 + ',' + (x2 - 2) + ' ' + y2;
    s += '<path class="ge ' + cls + '" data-e="' + esc(e.from) + '§' + esc(e.to) + '" d="' + d + '" marker-end="url(#' + marker + ')"><title>' + esc(e.kind) + '</title></path>';
  });
  // UML 类框：头部（名称+构造型）→ 字段/变体 → 分隔线 → 方法
  nodes.forEach((n) => {
    const p = pos[n.id];
    const c = langColor(n.language);
    const stereo = n.kind === 'class' ? '' : '«' + n.kind + '»';
    let g = '<g class="gn" data-n="' + esc(n.id) + '">'
      + '<rect class="box" x="' + p.x + '" y="' + p.y + '" width="' + W + '" height="' + p.h + '" rx="5" stroke="' + c + '"' + (n.deadCandidate ? ' stroke-dasharray="4 3"' : '') + '/>'
      + '<rect class="hdr" x="' + p.x + '" y="' + p.y + '" width="' + W + '" height="' + HDR + '" rx="5" fill="' + langHdr(n.language) + '"/>'
      + '<text class="uname' + (n.entityType === 'interface' ? ' it' : '') + '" x="' + (p.x + 9) + '" y="' + (p.y + 16) + '">' + esc(trunc(n.name, 22)) + '</text>'
      + (stereo ? '<text class="ustereo" x="' + (p.x + W - 8) + '" y="' + (p.y + 16) + '" text-anchor="end">' + esc(stereo) + '</text>' : '');
    let cy = p.y + HDR + 6;
    n.fields.forEach((f) => {
      g += '<text class="umember" x="' + (p.x + 9) + '" y="' + cy + '">' + esc(trunc('+ ' + f.name + (f.type ? ': ' + f.type : ''), 34)) + '</text>';
      cy += ROW;
    });
    if (n.fieldCount > n.fields.length) {
      g += '<text class="umore" x="' + (p.x + 9) + '" y="' + cy + '">… 另有 ' + (n.fieldCount - n.fields.length) + ' 字段</text>';
      cy += ROW;
    }
    n.variants.forEach((v) => {
      g += '<text class="umember" x="' + (p.x + 9) + '" y="' + cy + '">' + esc(trunc('· ' + v, 34)) + '</text>';
      cy += ROW;
    });
    if (n.variantCount > n.variants.length) {
      g += '<text class="umore" x="' + (p.x + 9) + '" y="' + cy + '">… 另有 ' + (n.variantCount - n.variants.length) + ' 变体</text>';
      cy += ROW;
    }
    if (n.fields.length || n.variants.length || n.fieldCount > n.fields.length || n.variantCount > n.variants.length) {
      g += '<line class="usep" x1="' + (p.x + 1) + '" y1="' + (cy - 5) + '" x2="' + (p.x + W - 1) + '" y2="' + (cy - 5) + '"/>';
      cy += 2;
    }
    n.methods.forEach((m) => {
      g += '<text class="umember" x="' + (p.x + 9) + '" y="' + cy + '">' + esc(trunc((m.isStatic ? '$ ' : '+ ') + m.name + '()', 34)) + '</text>';
      cy += ROW;
    });
    if (n.methodCount > n.methods.length) {
      g += '<text class="umore" x="' + (p.x + 9) + '" y="' + cy + '">… 另有 ' + (n.methodCount - n.methods.length) + ' 方法</text>';
      cy += ROW;
    }
    const rel = []
      .concat(n.extendsName ? ['extends ' + n.extendsName] : [])
      .concat((n.implementsNames || []).map((x) => 'impl ' + x));
    g += '<title>' + esc(n.name + ' · ' + n.kindLabel + ' · ' + langLabel(n.language) + '\\n' + n.filePath + (n.line ? ':' + n.line : '')
      + '\\n模块 ' + (n.module || '（根）') + ' · 字段 ' + n.fieldCount + ' · 变体 ' + n.variantCount + ' · 方法 ' + n.methodCount
      + (rel.length ? '\\n关系: ' + rel.join('、') : '') + (n.derives.length ? '\\nderives: ' + n.derives.join(', ') : '')) + '</title>';
    g += '</g>';
    s += g;
  });
  s += '</svg>';
  return s;
}

function bindEntityGraphEvents(svgEl) {
  const info = document.getElementById('entity-info');
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
      const node = E_NODES_BY_ID[g.dataset.n];
      if (!node) return;
      const rel = [].concat(node.extendsName ? ['extends ' + node.extendsName] : [], (node.implementsNames || []).map((x) => 'impl ' + x));
      info.innerHTML = '<b class="name">' + esc(node.name) + '</b> '
        + chip(node.kindLabel, node.kind === 'interface' || node.kind === 'trait' ? 'cyan' : 'blue')
        + chip(langLabel(node.language), { rust: 'amber', vue: 'green', dart: 'teal' }[node.language] || '')
        + chip('关系度 ' + node.degree, node.degree > 0 ? 'purple' : '')
        + (node.exported ? chip('导出', 'green') : chip('内部', ''))
        + (node.isSingleton ? chip('单例', 'amber') : '')
        + (node.deadCandidate ? chip('死代码候选', 'red') : '')
        + '<div class="sub">' + esc(node.filePath) + (node.line ? ':' + node.line : '') + ' · 模块 ' + esc(node.module || '（根）')
        + ' · 字段 ' + node.fieldCount + ' · 变体 ' + node.variantCount + ' · 方法 ' + node.methodCount + '</div>'
        + (rel.length ? '<div class="sub">关系：' + rel.map(esc).join('、') + '</div>' : '')
        + (node.derives.length ? '<div class="sub">derives: ' + esc(node.derives.join(', ')) + '</div>' : '')
        + (node.methods.length ? '<div class="sub">方法调用链：' + node.methods.slice(0, 8).map((m) => esc(m.name) + (m.calls.length ? ' → ' + m.calls.map(esc).join('、') : '')).join('；') + '</div>' : '');
    });
  });
}

let E_NODES_BY_ID = {};
function currentEntityFilter() {
  const mod = document.getElementById('ent-mod').value;
  const kind = document.getElementById('ent-kind').value;
  const lang = document.getElementById('ent-lang').value;
  const q = document.getElementById('ent-search').value.trim().toLowerCase();
  return (n) => (!mod || n.module === mod)
    && (!kind || n.kind === kind)
    && (!lang || n.language === lang)
    && (!q || n.name.toLowerCase().includes(q));
}

function renderEntityGraph() {
  const E = M.entities;
  const match = currentEntityFilter();
  const shown = E.graph.nodes.filter(match);
  const shownIds = {};
  shown.forEach((n) => { shownIds[n.id] = 1; });
  const edges = E.graph.edges.filter((e) => shownIds[e.from] && shownIds[e.to]);
  E_NODES_BY_ID = {};
  shown.forEach((n) => { E_NODES_BY_ID[n.id] = n; });
  const wrap = document.getElementById('entity-graph');
  wrap.innerHTML = buildEntitiesSvg(shown, edges);
  const svgEl = wrap.querySelector('svg');
  if (svgEl) bindEntityGraphEvents(svgEl);
}

function renderEntityTable() {
  const E = M.entities;
  const match = currentEntityFilter();
  const rows = E.table.filter(match).map((n) => [
    { html: '<b>' + esc(n.name) + '</b>' },
    { html: chip(n.kindLabel, n.kind === 'interface' || n.kind === 'trait' ? 'cyan' : 'blue') },
    { html: chip(langLabel(n.language), n.language === 'rust' ? 'amber' : (n.language === 'vue' ? 'green' : '')) },
    { v: n.module || '（根）' },
    { html: '<span class="path">' + esc(n.filePath) + (n.line ? ':' + n.line : '') + '</span>' },
    { v: n.fieldCount + (n.variantCount ? ' (+' + n.variantCount + 'v)' : ''), num: true },
    { v: n.methodCount, num: true },
    { v: n.degree, num: true },
    { v: [].concat(n.extendsName ? ['extends ' + n.extendsName] : [], (n.implementsNames || []).map((x) => x)).join('、') || '—' },
    { html: (n.deadCandidate ? chip('死代码候选', 'red') + ' ' : '') + (n.exported ? chip('导出', 'green') : '') + (n.isSingleton ? chip('单例', 'amber') : '') || '—' },
  ]);
  document.getElementById('entity-table').innerHTML = rows.length
    ? table([
      { label: '实体' }, { label: '类型' }, { label: '语言' }, { label: '模块' }, { label: '文件' },
      { label: '字段', num: true }, { label: '方法', num: true }, { label: '关系度', num: true },
      { label: '实现/继承' }, { label: '状态' },
    ], rows)
    : '<div class="empty">无匹配实体。</div>';
}

function renderEntities() {
  const el = document.getElementById('view-entities');
  const E = M.entities;
  if (!E) {
    el.innerHTML = '<div class="panel"><h2>实体类图</h2><div class="empty">未检测到 Class/Interface 类型实体。</div></div>';
    return;
  }
  const maxLang = E.byLanguage.length ? E.byLanguage[0].count : 0;
  const maxLayer = E.byLayer.length ? E.byLayer[0].count : 0;
  const modOptions = E.moduleOptions.map((m) => '<option value="' + esc(m.name) + '">' + esc(m.name || '（根）') + ' (' + m.count + ')</option>').join('');
  const kindOptions = E.byKind.map((k) => '<option value="' + esc(k.key) + '">' + esc(k.label) + ' (' + k.count + ')</option>').join('');
  const langOptions = E.byLanguage.map((l) => '<option value="' + esc(l.key) + '">' + esc(l.label) + ' (' + l.count + ')</option>').join('');

  el.innerHTML =
    '<div class="panel"><h2>实体类图（' + fmt(E.totalCount) + ' 实体 · ' + fmt(E.methodCount) + ' 方法 · ' + fmt(E.edgeCount) + ' 关系边）</h2>'
    + '<div class="chips" style="margin-bottom:12px">'
    + chip('类 ' + fmt(E.classCount), 'blue')
    + chip('接口/Trait ' + fmt(E.interfaceCount), 'cyan')
    + chip('implements ' + fmt(E.implementsCount), 'cyan')
    + chip('extends ' + fmt(E.extendsCount), 'purple')
    + (E.rendersCount ? chip('renders ' + fmt(E.rendersCount), 'green') : '')
    + (E.crossLanguageEdges ? chip('跨语言关系 ' + fmt(E.crossLanguageEdges), 'amber') : '')
    + (E.deadCandidateCount ? chip('死代码候选 ' + fmt(E.deadCandidateCount), 'red') : '')
    + '</div>'
    + '<div class="note">实体 = Interface / Class（Rust struct/enum/trait 映射为同构实体；Vue 组件合成为 «组件» 实体，props 为字段、computed/methods 为方法）。图展示 '
    + E.graph.nodes.length + ' 个实体：关系活跃实体优先，各语言代表性实体按成员规模轮转补齐（共 '
    + fmt(E.relatedEntityCount) + ' 个参与关系的实体）；完整清单见下方表格。</div>'
    + '<div class="split" style="margin-top:12px">'
    + '<div><h3>语言分布</h3>' + E.byLanguage.map((l) => barRow(l.label, l.count, maxLang, { rust: 'amber', vue: 'green', dart: 'teal', go: 'go' }[l.key] || 'blue')).join('') + '</div>'
    + '<div><h3>架构层分布</h3>' + E.byLayer.map((l) => barRow(l.label, l.count, maxLayer, 'cyan')).join('') + '</div>'
    + '</div>'
    + '<div class="legend" style="margin-top:14px">'
    + E.byLanguage.map((l) => '<span class="legend-dot" style="background:' + langColor(l.key) + '"></span>' + esc(l.label)).join('')
    + '<span class="line" style="border-color:#39c5cf;border-top-style:dashed"></span>implements（虚线箭头）'
    + '<span class="line" style="border-color:#bc8cff"></span>extends（实线箭头）'
    + '<span class="line" style="border-color:#3fb950"></span>renders（组件组合，实线箭头）'
    + '</div>'
    + '</div>'

    + '<div class="panel"><h3>UML 类图</h3>'
    + '<div class="filter-bar">'
    + '<select id="ent-mod"><option value="">全部模块</option>' + modOptions + '</select>'
    + '<select id="ent-kind"><option value="">全部类型</option>' + kindOptions + '</select>'
    + '<select id="ent-lang"><option value="">全部语言</option>' + langOptions + '</select>'
    + '<input id="ent-search" placeholder="搜索实体名…">'
    + '<button class="btn" id="ent-reset">重置</button>'
    + '</div>'
    + '<div class="uml-wrap" id="entity-graph"></div>'
    + '<div id="entity-info"></div>'
    + '</div>'

    + '<div class="panel"><h3>实体清单（Top ' + E.table.length + '，按关系活跃度排序）</h3>'
    + '<div id="entity-table"></div>'
    + (E.totalCount > E.table.length ? '<div class="note">共 ' + fmt(E.totalCount) + ' 个实体，此处展示前 ' + E.table.length + ' 个；完整数据见 snapshot.json。</div>' : '')
    + '</div>';

  ['ent-mod', 'ent-kind', 'ent-lang'].forEach((id) => {
    document.getElementById(id).addEventListener('change', () => { renderEntityGraph(); renderEntityTable(); });
  });
  document.getElementById('ent-search').addEventListener('input', () => { renderEntityGraph(); renderEntityTable(); });
  document.getElementById('ent-reset').addEventListener('click', () => {
    document.getElementById('ent-mod').value = '';
    document.getElementById('ent-kind').value = '';
    document.getElementById('ent-lang').value = '';
    document.getElementById('ent-search').value = '';
    renderEntityGraph();
    renderEntityTable();
  });
  renderEntityGraph();
  renderEntityTable();
}

`;
