// 蓝图客户端脚本片段。顺序由 viewerClient.js 拼接，勿单独重排。
export const CODE_GRAPH = `// ---------- Tab: 代码图谱（力导向图：内联力模拟，零依赖） ----------
const CG_W = 1280, CG_H = 860;
const CG_LAYER_COLORS = {
  entry: '#f87171', presentation: '#58a6ff', state: '#bc8cff', service: '#3fb950',
  integration: '#d29922', shared: '#8b949e', types: '#39c5cf', config: '#fb923c',
  tauri: '#f87171', electron: '#f87171', script: '#fb923c', test: '#8b949e', mixed: '#818cf8',
};
const CG_DOMAIN_COLORS = ['#39c5cf', '#58a6ff', '#3fb950', '#d29922', '#f472b6', '#818cf8', '#fb923c', '#00b4ab', '#f87171', '#bc8cff'];
const CG = { mode: 'module', nodes: [], edges: [], nodeById: new Map(), domainList: [], view: { k: 1, x: 0, y: 0 } };

function cgPrepare(mode) {
  const G = (M.codeGraph || {})[mode + 'View'];
  if (!G || !G.nodes.length) return false;
  CG.mode = mode;
  CG.nodes = G.nodes.map((n) => Object.assign({}, n));
  CG.nodeById = new Map(CG.nodes.map((n) => [n.id, n]));
  CG.edges = G.edges
    .filter((e) => CG.nodeById.has(e.source) && CG.nodeById.has(e.target))
    .map((e) => ({ source: e.source, target: e.target, kind: e.kind || null, weight: e.weight || 1, sa: CG.nodeById.get(e.source), sb: CG.nodeById.get(e.target) }));
  if (mode === 'module') {
    CG.nodes.forEach((n) => { n.color = CG_LAYER_COLORS[n.layer] || '#8b949e'; });
  } else {
    CG.domainList = [...new Set(CG.nodes.map((n) => n.domain).filter(Boolean))].sort();
    CG.nodes.forEach((n) => {
      n.color = n.kind === 'store' ? '#bc8cff'
        : (n.domain ? CG_DOMAIN_COLORS[CG.domainList.indexOf(n.domain) % CG_DOMAIN_COLORS.length] : '#8b949e');
    });
  }
  return true;
}

function cgInitPositions() {
  const count = CG.nodes.length || 1;
  CG.nodes.forEach((n, i) => {
    const angle = i * 2.39996;
    const r = 50 + 330 * Math.sqrt((i + 0.5) / count);
    n.x = CG_W / 2 + Math.cos(angle) * r;
    n.y = CG_H / 2 + Math.sin(angle) * r * 0.72;
    n.vx = 0; n.vy = 0; n.fixed = false;
  });
}

// 单步力模拟：库仑斥力 + 弹簧引力 + 向心重力 + 速度阻尼
function cgTick(alpha) {
  const nodes = CG.nodes;
  const edges = CG.edges;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.01; }
      if (d2 > 900000) continue;
      const d = Math.sqrt(d2);
      const f = (5200 * alpha) / d2;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
    }
  }
  for (const e of edges) {
    const a = e.sa, b = e.sb;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - 150) * 0.018 * alpha;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
  }
  for (const n of nodes) {
    n.vx += (CG_W / 2 - n.x) * 0.045 * alpha;
    n.vy += (CG_H / 2 - n.y) * 0.045 * alpha;
    if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
    n.vx *= 0.85; n.vy *= 0.85;
    const sp = Math.abs(n.vx) + Math.abs(n.vy);
    if (sp > 30) { n.vx = (n.vx / sp) * 30; n.vy = (n.vy / sp) * 30; }
    n.x += n.vx; n.y += n.vy;
    if (n.x < 50) { n.x = 50; n.vx = Math.abs(n.vx) * 0.4; }
    if (n.x > CG_W - 50) { n.x = CG_W - 50; n.vx = -Math.abs(n.vx) * 0.4; }
    if (n.y < 36) { n.y = 36; n.vy = Math.abs(n.vy) * 0.4; }
    if (n.y > CG_H - 36) { n.y = CG_H - 36; n.vy = -Math.abs(n.vy) * 0.4; }
  }
}

function cgLayout() {
  cgInitPositions();
  for (let t = 0; t < 320; t++) cgTick(Math.pow(1 - t / 320, 1.5) * 0.85 + 0.015);
}

function cgGraphSvgInner() {
  const maxLines = CG.nodes.reduce((a, n) => Math.max(a, n.lines || 0), 1);
  const labelCap = CG.mode === 'module' ? 60 : 40;
  const labeled = new Set(CG.nodes.slice().sort((a, b) => (b.lines || 0) - (a.lines || 0)).slice(0, labelCap).map((n) => n.id));
  let out = '';
  for (const e of CG.edges) {
    const w = Math.min(1 + (e.weight > 1 ? Math.log2(e.weight + 1) : 0), 5).toFixed(1);
    out += '<line class="cge' + (e.kind ? ' ' + e.kind : '') + '" x1="' + e.sa.x.toFixed(1) + '" y1="' + e.sa.y.toFixed(1)
      + '" x2="' + e.sb.x.toFixed(1) + '" y2="' + e.sb.y.toFixed(1) + '" stroke-width="' + w
      + '" data-a="' + esc(e.source) + '" data-b="' + esc(e.target) + '"></line>';
  }
  for (const n of CG.nodes) {
    const r = 6 + 26 * Math.sqrt((n.lines || 0) / maxLines);
    let label = '';
    if (labeled.has(n.id)) {
      const nm = n.name.length > 20 ? n.name.slice(0, 19) + '…' : n.name;
      label = '<text class="' + ((n.lines || 0) > maxLines * 0.25 ? 'big' : '') + '" x="' + (n.x + r + 4).toFixed(1) + '" y="' + (n.y + 3).toFixed(1) + '">' + esc(nm) + '</text>';
    }
    out += '<g class="cgn" data-nid="' + esc(n.id) + '">'
      + '<circle cx="' + n.x.toFixed(1) + '" cy="' + n.y.toFixed(1) + '" r="' + r.toFixed(1) + '" fill="' + n.color + '"></circle>'
      + label + '</g>';
  }
  return out;
}

function cgApplyTransform() {
  const g = document.getElementById('cg-transform');
  if (g && g.setAttribute) g.setAttribute('transform', 'translate(' + CG.view.x.toFixed(1) + ',' + CG.view.y.toFixed(1) + ') scale(' + CG.view.k.toFixed(3) + ')');
}

function cgLayerLabel(key) {
  const l = ((M.stats ? M.stats.byLayer : []) || []).find((x) => x.key === key);
  return l ? l.label : key;
}

function cgUpdateToolbar() {
  const c = document.getElementById('cg-count');
  if (c && c.textContent !== undefined) {
    const G = (M.codeGraph || {})[CG.mode + 'View'] || {};
    const hidden = CG.mode === 'module' ? G.hiddenModuleCount : G.hiddenComponentCount;
    c.textContent = (CG.mode === 'module' ? '模块视图' : '组件视图')
      + ' · ' + CG.nodes.length + ' 节点 · ' + CG.edges.length + ' 边'
      + (hidden ? '（未展示 ' + hidden + ' 个小' + (CG.mode === 'module' ? '模块' : '组件') + '）' : '');
  }
  ['module', 'component'].forEach((m) => {
    const b = document.getElementById('cg-mode-' + m);
    if (b && b.classList) {
      if (CG.mode === m) b.classList.add('on'); else b.classList.remove('on');
    }
  });
}

function cgUpdateLegend() {
  const lg = document.getElementById('cg-legend');
  if (!lg) return;
  let html = '';
  if (CG.mode === 'module') {
    const seen = [];
    CG.nodes.forEach((n) => { if (n.layer && !seen.some((s) => s.layer === n.layer)) seen.push({ layer: n.layer, color: n.color }); });
    html = seen.map((s) => '<span><span class="legend-dot" style="background:' + s.color + '"></span>' + esc(cgLayerLabel(s.layer)) + '</span>').join('');
  } else {
    html = '<span><span class="legend-dot" style="background:#bc8cff"></span>Store</span>'
      + (CG.domainList || []).map((d, i) => '<span><span class="legend-dot" style="background:' + CG_DOMAIN_COLORS[i % CG_DOMAIN_COLORS.length] + '"></span>' + esc(d) + '</span>').join('');
  }
  html += '<span class="line" style="border-color:#3fb950"></span>props 传递'
    + '<span class="line" style="border-color:#58a6ff"></span>文件导入'
    + '<span class="line" style="border-color:#bc8cff;border-top-style:dashed"></span>useStore'
    + '<span class="cg-hint">节点大小 ∝ 代码行数 · 拖拽节点 / 滚轮缩放 / 拖空白平移 / 点击聚焦</span>';
  lg.innerHTML = html;
}

function cgSetFocus(node) {
  const svg = document.getElementById('cg-svg');
  const info = document.getElementById('cg-info');
  if (!svg || !svg.querySelectorAll || !info) return;
  if (!node) {
    svg.classList.remove('focus');
    svg.querySelectorAll('.cgn.hl, .cge.hl').forEach((x) => x.classList.remove('hl'));
    info.innerHTML = '<span class="cg-hint">点击节点查看详情并高亮邻接。</span>';
    return;
  }
  const neighbor = new Set([node.id]);
  const connKeys = new Set();
  for (const e of CG.edges) {
    if (e.source === node.id || e.target === node.id) {
      neighbor.add(e.source); neighbor.add(e.target);
      connKeys.add(e.source + '>' + e.target);
    }
  }
  svg.classList.add('focus');
  svg.querySelectorAll('.cgn').forEach((g) => {
    const nid = g.getAttribute('data-nid');
    if (neighbor.has(nid)) g.classList.add('hl'); else g.classList.remove('hl');
  });
  svg.querySelectorAll('.cge').forEach((ln) => {
    const key = ln.getAttribute('data-a') + '>' + ln.getAttribute('data-b');
    if (connKeys.has(key)) ln.classList.add('hl'); else ln.classList.remove('hl');
  });
  const meta = CG.mode === 'module'
    ? fmt(node.lines || 0) + ' 行 · ' + fmt(node.files || 0) + ' 文件' + (node.path ? ' · <span class="path">' + esc(node.path) + '</span>' : '')
    : (node.kind === 'store' ? 'Store' : '组件') + ' · ' + fmt(node.lines || 0) + ' 行'
      + (node.domain ? ' · ' + esc(node.domain) + ' 域' : '')
      + (node.filePath ? ' · <span class="path">' + esc(node.filePath) + '</span>' : '');
  info.innerHTML = '<span class="name">' + esc(node.name) + '</span> — ' + meta + ' · 邻接 ' + connKeys.size + ' 条边';
}

function cgSetMode(mode) {
  if (!cgPrepare(mode)) return;
  CG.view = { k: 1, x: 0, y: 0 };
  cgApplyTransform();
  cgLayout();
  document.getElementById('cg-transform').innerHTML = cgGraphSvgInner();
  cgSetFocus(null);
  cgUpdateToolbar();
  cgUpdateLegend();
}

function cgPointer(ev) {
  const svg = document.getElementById('cg-svg');
  const rect = svg.getBoundingClientRect();
  const sx = rect.width / CG_W, sy = rect.height / CG_H;
  return {
    x: ((ev.clientX - rect.left) / sx - CG.view.x) / CG.view.k,
    y: ((ev.clientY - rect.top) / sy - CG.view.y) / CG.view.k,
  };
}

function cgBindStage() {
  const stage = document.getElementById('cg-stage');
  if (!stage || !stage.addEventListener) return;
  let drag = null;
  stage.addEventListener('mousedown', (ev) => {
    const nidEl = ev.target && ev.target.closest ? ev.target.closest('[data-nid]') : null;
    const svg = document.getElementById('cg-svg');
    if (svg && svg.classList) svg.classList.add('dragging');
    if (nidEl) {
      const node = CG.nodeById.get(nidEl.getAttribute('data-nid'));
      if (!node) return;
      const p = cgPointer(ev);
      node.fixed = true;
      drag = { type: 'node', node, sx: ev.clientX, sy: ev.clientY, dx: node.x - p.x, dy: node.y - p.y, moved: false };
    } else {
      drag = { type: 'pan', sx: ev.clientX, sy: ev.clientY, ox: CG.view.x, oy: CG.view.y, moved: false };
    }
    ev.preventDefault();
  });
  stage.addEventListener('mousemove', (ev) => {
    if (!drag) return;
    if (Math.abs(ev.clientX - drag.sx) + Math.abs(ev.clientY - drag.sy) > 3) drag.moved = true;
    if (drag.type === 'node') {
      const p = cgPointer(ev);
      drag.node.x = p.x + drag.dx;
      drag.node.y = p.y + drag.dy;
      for (let t = 0; t < 2; t++) cgTick(0.25);
      document.getElementById('cg-transform').innerHTML = cgGraphSvgInner();
    } else {
      CG.view.x = drag.ox + (ev.clientX - drag.sx);
      CG.view.y = drag.oy + (ev.clientY - drag.sy);
      cgApplyTransform();
    }
  });
  stage.addEventListener('mouseup', () => {
    const svg = document.getElementById('cg-svg');
    if (svg && svg.classList) svg.classList.remove('dragging');
    if (!drag) return;
    if (drag.type === 'node') {
      if (!drag.moved) cgSetFocus(drag.node);
    } else if (!drag.moved) {
      cgSetFocus(null);
    }
    drag = null;
  });
  stage.addEventListener('mouseleave', () => {
    const svg = document.getElementById('cg-svg');
    if (svg && svg.classList) svg.classList.remove('dragging');
    drag = null;
  });
  stage.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const svg = document.getElementById('cg-svg');
    if (!svg || !svg.getBoundingClientRect) return;
    const rect = svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) / (rect.width / CG_W);
    const py = (ev.clientY - rect.top) / (rect.height / CG_H);
    const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
    const k2 = Math.max(0.25, Math.min(6, CG.view.k * factor));
    CG.view.x = px - (k2 / CG.view.k) * (px - CG.view.x);
    CG.view.y = py - (k2 / CG.view.k) * (py - CG.view.y);
    CG.view.k = k2;
    cgApplyTransform();
  }, { passive: false });
}

function renderCodeGraph() {
  const el = document.getElementById('view-codegraph');
  const G = M.codeGraph;
  if (!G) {
    el.innerHTML = '<div class="panel"><h2>代码图谱</h2><div class="empty">无代码图谱数据。</div></div>';
    return;
  }
  const hasModule = !!(G.moduleView && G.moduleView.nodes.length);
  const hasComponent = !!(G.componentView && G.componentView.nodes.length);
  // v0.35.0 渲染预算声明（借鉴 GitNexus 的大图阈值熔断）：超 cap 时明确告知用户
  // 不静默截断，让用户知道图谱已经"超出可清晰交互的尺寸"
  const budgets = M.renderBudgets || {};
  let budgetNote = '';
  if (hasModule) {
    const mNodes = G.moduleView.nodes.length;
    const mCap = budgets.moduleGraphNodeCap || 90;
    if (mNodes >= mCap) budgetNote += ' · <span class="warn">模块节点已达渲染上限 ' + mCap + '（' + mNodes + ' 个）</span>';
  }
  if (hasComponent) {
    const cNodes = G.componentView.nodes.length;
    const cCap = budgets.componentGraphNodeCap || 130;
    if (cNodes >= cCap) budgetNote += ' · <span class="warn">组件节点已达渲染上限 ' + cCap + '（' + cNodes + ' 个）</span>';
  }
  el.innerHTML =
    '<div class="panel"><h2>代码图谱（力导向图）</h2>'
    + '<div class="cg-toolbar">'
    + (hasModule ? '<button class="btn" id="cg-mode-module">模块图谱</button>' : '')
    + (hasComponent ? '<button class="btn" id="cg-mode-component">组件图谱</button>' : '')
    + '<button class="btn" id="cg-relayout">重新布局</button>'
    + '<button class="btn" id="cg-reset">重置视图</button>'
    + '<button class="btn" id="cg-clear-focus">清除聚焦</button>'
    + '<span class="cg-hint" id="cg-count"></span>'
    + '</div>'
    + '<div class="cg-stage" id="cg-stage"><svg id="cg-svg" viewBox="0 0 ' + CG_W + ' ' + CG_H + '"><g id="cg-transform"></g></svg></div>'
    + '<div class="legend" id="cg-legend"></div>'
    + '<div id="cg-info"></div>'
    + '<div class="note">模块视图：节点 = 二级以内模块，边 = 模块间文件导入（权重 = 导入次数）；组件视图：节点 = 组件 / Store，边 = props 传递、组件间文件导入与 useStore 依赖。力导向布局由内置力模拟（斥力 + 弹簧 + 向心力）实时计算。点击节点高亮邻接（邻接焦点模式），再次点击或按 Esc 取消。</div>'
    + (budgetNote ? '<div class="note">' + budgetNote + '</div>' : '')
    + '</div>';
  cgBindStage();
  const bindMode = (id, mode) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', () => cgSetMode(mode));
  };
  bindMode('cg-mode-module', 'module');
  bindMode('cg-mode-component', 'component');
  const relayout = document.getElementById('cg-relayout');
  if (relayout) relayout.addEventListener('click', () => {
    cgLayout();
    document.getElementById('cg-transform').innerHTML = cgGraphSvgInner();
    cgSetFocus(null);
  });
  const reset = document.getElementById('cg-reset');
  if (reset) reset.addEventListener('click', () => {
    CG.view = { k: 1, x: 0, y: 0 };
    cgApplyTransform();
    cgSetFocus(null);
  });
  const clearFocus = document.getElementById('cg-clear-focus');
  if (clearFocus) clearFocus.addEventListener('click', () => cgSetFocus(null));
  // v0.35.0 Esc 键清除聚焦
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cgSetFocus(null);
  });
  cgSetMode(hasModule ? 'module' : 'component');
}

`;
