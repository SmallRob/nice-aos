// 蓝图客户端脚本片段。顺序由 viewerClient.js 拼接，勿单独重排。
export const BLUEPRINT = `// ---------- Tab 3: 领域蓝图 ----------
let selectedDomain = null;
let selectedScriptDomain = null;
function renderBlueprint() {
  const el = document.getElementById('view-blueprint');
  // 油猴意图适配：无目录级功能域时渲染脚本意图功能域（按函数角色分组）
  if (!M.domains.length && M.scriptDomains) return renderScriptDomainList(el);
  const cards = M.domains.map((d, i) =>
    '<div class="card" data-idx="' + i + '"><h4>' + esc(d.name) + '</h4>'
    + '<div class="sum">' + esc(d.summary || '') + '</div>'
    + '<div class="chips">'
    + (d.routeCount ? chip(d.routeCount + ' 路由', 'blue') : '')
    + (d.counts.components ? chip(d.counts.components + ' 组件', 'purple') : '')
    + (d.counts.stores ? chip(d.counts.stores + ' Store', 'green') : '')
    + (d.counts.hooks ? chip(d.counts.hooks + ' Hook', 'cyan') : '')
    + (d.counts.services ? chip(d.counts.services + ' Service', 'amber') : '')
    + (d.counts.userScripts ? chip(d.counts.userScripts + ' 脚本', 'red') : '')
    + chip(d.fileCount + ' 文件', '')
    + '</div></div>').join('');
  el.innerHTML =
    '<div class="panel"><h2>功能域地图（' + M.domainCount + ' 个功能域，点击下钻）</h2>'
    + '<div class="grid">' + cards + '</div></div>'
    + '<div id="domain-detail"></div>';
  el.querySelectorAll('.card').forEach((c) => c.addEventListener('click', () => {
    el.querySelectorAll('.card').forEach((x) => x.classList.remove('selected'));
    c.classList.add('selected');
    selectedDomain = M.domains[Number(c.dataset.idx)];
    renderDomainDetail();
  }));
}
function renderDomainDetail() {
  const d = selectedDomain;
  const box = document.getElementById('domain-detail');
  if (!d) { box.innerHTML = ''; return; }
  const maxLayer = d.layerComposition.length ? d.layerComposition[0].fileCount : 0;
  const unitSection = (title, list, render) => list.length
    ? '<details open><summary>' + title + '（' + list.length + '）</summary><ul class="plain">'
      + list.map(render).join('') + '</ul></details>'
    : '';
  box.innerHTML =
    '<div class="panel"><div class="back"><button class="btn" id="btn-back">← 收起</button></div>'
    + '<h2>功能域：' + esc(d.name) + '</h2>'
    + (d.capability ? '<div class="sub">' + esc(d.capability) + '</div>' : '')
    + '<div class="kv" style="margin-top:12px">'
    + '<div class="item"><div class="v">' + fmt(d.fileCount) + '</div><div class="k">文件</div></div>'
    + '<div class="item"><div class="v">' + fmt(d.lineCount) + '</div><div class="k">代码行</div></div>'
    + '<div class="item"><div class="v">' + fmt(d.routeCount) + '</div><div class="k">路由</div></div>'
    + '<div class="item"><div class="v">' + fmt(d.moduleCount) + '</div><div class="k">模块</div></div>'
    + '</div>'
    + '<div class="chips" style="margin-bottom:12px">' + (d.sources || []).map((s) => chip('来源: ' + s, 'cyan')).join('')
    + (d.counts.components ? chip(d.counts.components + ' 组件', 'purple') : '')
    + (d.counts.stores ? chip(d.counts.stores + ' Store', 'green') : '')
    + (d.counts.hooks ? chip(d.counts.hooks + ' Hook', 'cyan') : '')
    + (d.counts.services ? chip(d.counts.services + ' Service', 'amber') : '')
    + (d.counts.userScripts ? chip(d.counts.userScripts + ' 脚本', 'red') : '') + '</div>'

    + '<h3>业务层级构成</h3>'
    + d.layerComposition.map((l) => barRow(l.label, l.fileCount, maxLayer, 'green')).join('')

    + '<h3>代码组织（模块 ' + d.modules.length + ' / ' + d.moduleCount + '）</h3>'
    + (d.modules.length ? table(
      [{ label: '模块路径' }, { label: '语义层' }, { label: '直属文件', num: true }, { label: '子树文件', num: true }, { label: '职责画像' }],
      d.modules.map((m) => [
        { v: m.path, html: '<span class="path">' + esc(m.path) + '</span>' },
        { v: m.archLayerLabel || m.archLayer || '-', html: chip(m.archLayerLabel || m.archLayer || '-', 'blue') },
        { v: m.fileCount, num: true },
        { v: m.subtreeFileCount, num: true },
        { v: m.summary || '-' },
      ])) : '<div class="empty">（无直属模块）</div>')

    + '<h3>单元清单</h3>'
    + (d.routes.length ? unitSection('路由（' + d.routes.length + '）', d.routes,
      (r) => '<li><b>' + esc(r.path) + '</b> <span class="path">' + esc(r.routeType || '') + '</span>' + (r.description ? ' — ' + esc(r.description) : '') + '</li>') : '')
    + unitSection('组件（' + d.units.components.length + (d.units.components.length < d.counts.components ? ' / ' + d.counts.components : '') + '）', d.units.components,
      (c) => '<li><b>' + esc(c.name) + '</b> ' + chip(c.kind || 'common', 'purple') + ' <span class="path">' + esc(c.filePath) + '</span>' + (c.description ? '<br><span class="note">' + esc(c.description) + '</span>' : '') + '</li>')
    + unitSection('Store（' + d.units.stores.length + '）', d.units.stores,
      (s) => '<li><b>' + esc(s.name) + '</b> ' + (s.providerType ? chip(s.providerType, 'blue') : '') + chip((s.stateKeyCount || 0) + ' state', 'green') + (s.hasPersist ? chip('persist', 'amber') : '') + ' <span class="path">' + esc(s.filePath) + '</span></li>')
    + unitSection('Hook（' + d.units.hooks.length + (d.units.hooks.length < d.counts.hooks ? ' / ' + d.counts.hooks : '') + '）', d.units.hooks,
      (h) => '<li><b>' + esc(h.name) + '</b> <span class="path">' + esc(h.filePath) + '</span>' + (h.description ? '<br><span class="note">' + esc(h.description) + '</span>' : '') + '</li>')
    + unitSection('Service（' + d.units.services.length + (d.units.services.length < d.counts.services ? ' / ' + d.counts.services : '') + '）', d.units.services,
      (s) => '<li><b>' + esc(s.name) + '</b> ' + chip(s.pattern || '', 'amber') + ' <span class="path">' + esc(s.filePath) + '</span></li>')
    + (d.units.userScripts.length ? unitSection('油猴脚本（' + d.units.userScripts.length + (d.units.userScripts.length < d.counts.userScripts ? ' / ' + d.counts.userScripts : '') + '）', d.units.userScripts,
      (u) => '<li><b>' + esc(u.name) + '</b> ' + (u.riskLevel ? chip(u.riskLevel, u.riskLevel === 'high' ? 'red' : (u.riskLevel === 'medium' ? 'amber' : 'green')) : '') + (u.hostFramework ? chip(u.hostFramework, 'cyan') : '') + ' <span class="path">' + esc(u.filePath) + '</span></li>') : '')
    + '</div>';
  box.querySelector('#btn-back').addEventListener('click', () => {
    selectedDomain = null;
    document.getElementById('view-blueprint').querySelectorAll('.card').forEach((x) => x.classList.remove('selected'));
    box.innerHTML = '';
  });
}

// ---------- Tab 2 适配：脚本意图功能域（函数意图分组，替代目录级功能域）----------
function renderScriptDomainList(el) {
  const sd = M.scriptDomains;
  const cards = sd.domains.map((d, i) =>
    '<div class="card" data-idx="' + i + '"><h4><span class="legend-dot" style="background:' + d.color + '"></span>' + esc(d.name) + '</h4>'
    + '<div class="sum">' + esc(d.description || '') + '</div>'
    + '<div class="chips">'
    + chip(d.functionCount + ' 函数', 'blue')
    + (d.injectionCount ? chip(d.injectionCount + ' DOM 注入', 'purple') : '')
    + (d.networkCount ? chip(d.networkCount + ' 网络调用', 'red') : '')
    + (d.listenerCount ? chip(d.listenerCount + ' 监听/定时', 'amber') : '')
    + (d.gmApiCount ? chip(d.gmApiCount + ' GM API', 'green') : '')
    + '</div></div>').join('');
  el.innerHTML =
    '<div class="panel"><h2>脚本意图功能域（' + sd.domains.length + ' 个意图分组，点击下钻）</h2>'
    + '<div class="grid">' + cards + '</div>'
    + '<div class="note">单文件脚本无目录级功能域，按函数意图（渲染注入 / 数据获取 / 状态存取 / 事件监听 / 元素构建 / 纯逻辑）聚合为虚拟功能域；仅单一意图的功能增强脚本不生成本视图。</div></div>'
    + '<div id="script-domain-detail"></div>';
  el.querySelectorAll('.card').forEach((c) => c.addEventListener('click', () => {
    el.querySelectorAll('.card').forEach((x) => x.classList.remove('selected'));
    c.classList.add('selected');
    selectedScriptDomain = sd.domains[Number(c.dataset.idx)];
    renderScriptDomainDetail();
  }));
}
function renderScriptDomainDetail() {
  const d = selectedScriptDomain;
  const box = document.getElementById('script-domain-detail');
  if (!d) { box.innerHTML = ''; return; }
  box.innerHTML =
    '<div class="panel"><div class="back"><button class="btn" id="btn-sdback">← 收起</button></div>'
    + '<h2><span class="legend-dot" style="background:' + d.color + '"></span>意图功能域：' + esc(d.name) + '</h2>'
    + '<div class="sub">' + esc(d.description || '') + '</div>'
    + '<div class="chips" style="margin:10px 0">'
    + chip(d.functionCount + ' 函数', 'blue')
    + (d.injectionCount ? chip(d.injectionCount + ' DOM 注入', 'purple') : '')
    + (d.networkCount ? chip(d.networkCount + ' 网络调用', 'red') : '')
    + (d.listenerCount ? chip(d.listenerCount + ' 监听/定时', 'amber') : '')
    + (d.gmApiCount ? chip(d.gmApiCount + ' GM API', 'green') : '')
    + (d.scriptNames || []).map((n) => chip(n, 'cyan')).join('')
    + '</div>'
    + '<h3>函数清单（按重要性 Top ' + d.functions.length + ' / ' + d.functionCount + '）</h3>'
    + table(
      [{ label: '函数' }, { label: '角色' }, { label: '行', num: true }, { label: '被调', num: true }, { label: '调出', num: true }, { label: 'DOM 注入', num: true }, { label: '网络', num: true }],
      d.functions.map((f) => [
        { v: f.name, html: '<b>' + esc(f.name) + '</b> <span class="path">L' + (f.line ?? '-') + '</span>' },
        { v: (f.roles || []).join('/'), html: (f.roles || []).map((r) => '<span class="chip" style="color:' + roleColor([r]) + ';border-color:' + roleColor([r]) + '55">' + esc(roleLabel(r)) + '</span>').join('') },
        { v: f.lineCount ?? '-', num: true },
        { v: f.calledByCount, num: true },
        { v: f.callCount, num: true },
        { v: f.domInjectionCount || '-', num: true },
        { v: f.networkCallCount || '-', num: true },
      ]))
    + '</div>';
  box.querySelector('#btn-sdback').addEventListener('click', () => {
    selectedScriptDomain = null;
    document.getElementById('view-blueprint').querySelectorAll('.card').forEach((x) => x.classList.remove('selected'));
    box.innerHTML = '';
  });
}

`;
