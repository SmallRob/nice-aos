// 蓝图客户端脚本片段。顺序由 viewerClient.js 拼接，勿单独重排。
export const DATA = `// ---------- Tab 3: 业务数据图 ----------
function renderData() {
  const el = document.getElementById('view-data');
  const d = M.dataMap;
  if (!d.stores.length) {
    // 油猴意图适配：无 Zustand/Pinia Store 时渲染脚本存储枢纽
    if (M.scriptDataMap) return renderScriptDataMap(el);
    el.innerHTML = '<div class="panel"><h2>业务数据图</h2><div class="empty">未检测到状态管理（Zustand / Pinia），也无脚本持久化信号——本仓库无业务数据图。</div></div>';
    return;
  }
  const storeCards = d.stores.map((s) =>
    '<div class="card" style="cursor:default"><h4>' + esc(s.name) + '</h4>'
    + '<div class="chips" style="margin:6px 0">'
    + (s.providerType ? chip(s.providerType, 'purple') : '')
    + (s.domainIds || []).map((dn) => chip(dn, 'green')).join('')
    + chip((s.stateKeyCount || 0) + ' state', 'blue')
    + chip((s.actionKeyCount || 0) + ' action', 'cyan')
    + (s.hasPersist ? chip('persist → ' + (s.storageKey || s.name), 'amber') : '')
    + '</div>'
    + (s.stateKeys.length ? '<div class="sum">state：' + s.stateKeys.map(esc).join(' · ') + (s.stateKeyCount > s.stateKeys.length ? ' …' : '') + '</div>' : '')
    + '<div class="sub">被 ' + s.usedByFileCount + ' 个文件使用'
    + (s.usedByDomains.length ? ' ← ' + s.usedByDomains.map((u) => esc(u.name) + '（' + u.count + '）').join('、') : '')
    + '</div>'
    + '<details><summary>使用方文件</summary><ul class="plain">'
    + s.usedBy.map((p) => '<li><span class="path">' + esc(p) + '</span></li>').join('')
    + (s.usedByFileCount > s.usedBy.length ? '<li class="note">… 共 ' + s.usedByFileCount + ' 个（截断显示）</li>' : '')
    + '</ul></details></div>').join('');

  const crossRows = d.crossDomainData.map((e) => [
    { v: e.from, html: '<b>' + esc(e.from) + '</b>' },
    { v: '→ ' + e.to, html: '<span style="color:var(--fg-dim)">→</span> <b>' + esc(e.to) + '</b>' },
    { v: e.target, html: chip(e.target, 'green') },
    { v: e.count, num: true },
  ]);

  el.innerHTML =
    '<div class="panel"><h2>Store 数据枢纽（' + d.stores.length + ' 个 · 状态键 ' + fmt(d.totalStateKeys) + ' · 持久化 ' + d.persistedStores.length + ' 个）</h2>'
    + '<div class="grid">' + storeCards + '</div></div>'
    + '<div class="panel"><h2>跨域数据依赖（' + d.crossDomainData.length + ' 条）</h2>'
    + (crossRows.length ? table([{ label: '使用方域' }, { label: 'Store 所在域' }, { label: 'Store' }, { label: '引用数', num: true }], crossRows)
      : '<div class="empty">无跨域数据依赖（各域状态自包含）。</div>')
    + '<div class="note">数据流向：使用方域 → Store 所在域；引用数为该域导入 Store 文件的次数。</div></div>';
}

// ---------- Tab 3 适配：脚本存储枢纽（localStorage / GM 存储 / 宿主数据读取）----------
function renderScriptDataMap(el) {
  const sd = M.scriptDataMap;
  const hubCards = sd.hubs.map((h) =>
    '<div class="card" style="cursor:default"><h4>' + esc(h.name) + (h.version ? ' <span class="sub">v' + esc(h.version) + '</span>' : '') + '</h4>'
    + '<div class="chips" style="margin:6px 0">'
    + (h.storageUsage.localStorage ? chip('localStorage × ' + h.storageUsage.localStorage, 'green') : '')
    + (h.storageUsage.sessionStorage ? chip('sessionStorage × ' + h.storageUsage.sessionStorage, 'cyan') : '')
    + (h.storageUsage.indexedDB ? chip('indexedDB × ' + h.storageUsage.indexedDB, 'purple') : '')
    + h.gmStorageApis.map((g) => chip(g.name + ' × ' + g.callCount, 'amber')).join('')
    + '</div>'
    + (h.unsafeWindowReads.length ? '<div class="sum">宿主数据读取：' + h.unsafeWindowReads.map((r) => '<span class="path">' + esc(typeof r === 'string' ? r : (r.prop || '')) + '</span>').join(' · ') + '</div>' : '')
    + (h.stateFunctions.length ? '<details open><summary>状态存取函数（' + h.stateFunctions.length + '）</summary><ul class="plain">'
      + h.stateFunctions.map((f) => '<li><b>' + esc(f.name) + '</b>'
        + (f.gmApiCalls.length ? ' ' + f.gmApiCalls.map((g) => chip(g, 'amber')).join('') : '')
        + ' <span class="path">L' + (f.line ?? '-') + '</span></li>').join('')
      + '</ul></details>' : '')
    + '<div class="sub"><span class="path">' + esc(h.filePath) + '</span></div></div>').join('');

  const hasHostReads = sd.hubs.some((h) => h.unsafeWindowReads.length);
  el.innerHTML =
    '<div class="panel"><h2>脚本存储枢纽（' + sd.hubs.length + ' 个脚本有持久化信号）</h2>'
    + '<div class="grid">' + hubCards + '</div>'
    + '<div class="note">脚本无集中式状态 Store，以浏览器存储（localStorage / sessionStorage / indexedDB）与 GM 存储 API 为数据枢纽；状态存取函数为读写这些存储的入口。'
    + (hasHostReads ? '宿主数据读取 = 脚本从页面全局变量（unsafeWindow）获取的数据。' : '') + '</div></div>';
}

`;
