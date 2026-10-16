// 蓝图客户端脚本片段。顺序由 viewerClient.js 拼接，勿单独重排。
export const FLOW = `// ---------- Tab 4: 业务逻辑流向 ----------
function renderFlow() {
  const el = document.getElementById('view-flow');
  const f = M.logicFlow;

  // 油猴意图适配：无模块导入（单文件）时渲染函数意图流转矩阵
  if (!f.layerFlow.length && M.scriptFlow) return renderScriptFlow(el);

  // 层间流向矩阵（from 层 × to 层）
  const layerKeys = [];
  const flowIdx = new Map();
  for (const e of f.layerFlow) {
    for (const k of [e.from, e.to]) if (!layerKeys.includes(k)) layerKeys.push(k);
    flowIdx.set(e.from + '>' + e.to, e.count);
  }
  const layerOrder = ['entry', 'presentation', 'state', 'service', 'integration', 'shared', 'types', 'config', 'script', 'test', 'mixed'];
  layerKeys.sort((a, b) => layerOrder.indexOf(a) - layerOrder.indexOf(b));
  const maxCell = Math.max(1, ...f.layerFlow.map((e) => e.count));
  const matrixRows = layerKeys.map((from) => [
    { v: from, html: chip(from, 'blue') },
    ...layerKeys.map((to) => {
      const c = flowIdx.get(from + '>' + to) ?? 0;
      const cls = c === 0 ? 'cold' : (c / maxCell > 0.4 ? 'hot' : 'warm');
      return { v: c || '·', html: '<span class="' + cls + '">' + (c || '·') + '</span>' };
    }),
  ]);

  const maxEdge = f.domainEdges.length ? f.domainEdges[0].count : 1;
  const edgeRows = f.domainEdges.slice(0, 50).map((e) => [
    { v: e.from, html: '<b>' + esc(e.from) + '</b>' },
    { v: '→ ' + e.to, html: '<span style="color:var(--fg-dim)">→</span> <b>' + esc(e.to) + '</b>' },
    { v: e.count, html: '<div class="bar-wrap"><div class="bar purple" style="width:' + Math.round((e.count / maxEdge) * 100) + '%"></div></div>' },
    { v: e.count, num: true },
  ]);

  const hubRows = f.hubServices.filter((s) => s.importedByCount > 0).map((s) => [
    { v: s.name, html: '<b>' + esc(s.name) + '</b> ' + (s.domainIds || []).map((dn) => chip(dn, 'amber')).join('') },
    { v: s.filePath, html: '<span class="path">' + esc(s.filePath) + '</span>' },
    { v: s.importedByCount, num: true },
  ]);

  el.innerHTML =
    '<div class="panel"><h2>层间导入流向（' + fmt(f.layerFlowTotal) + ' 条内部依赖边，测试文件已排除）</h2>'
    + '<table class="matrix"><thead><tr><th>from ↓ / to →</th>'
    + layerKeys.map((k) => '<th>' + esc(k) + '</th>').join('')
    + '</tr></thead><tbody>' + matrixRows.map((r) => '<tr>' + r.map((c) => '<td class="heat">' + (c.html || esc(c.v)) + '</td>').join('') + '</tr>').join('')
    + '</tbody></table>'
    + '<div class="note">行 = 导入方所在层，列 = 被导入文件所在层；格子数字 = 依赖边数。健康流向通常为 presentation → state/service → integration 单向向下。</div></div>'

    + '<div class="panel"><h2>跨域依赖（' + f.domainEdges.length + ' 条域间边）</h2>'
    + (edgeRows.length ? table([{ label: '依赖方域' }, { label: '被依赖域' }, { label: '强度' }, { label: '边数', num: true }], edgeRows)
      : '<div class="empty">无跨域依赖边（各域独立）。</div>')
    + '<div class="note">域 A 文件 import 域 B 文件即计一条边；边数越多，域间耦合越强，拆分成本越高。</div></div>'

    + '<div class="panel"><h2>高扇入业务节点（变更影响面 Top ' + f.hubServices.length + '）</h2>'
    + (hubRows.length ? table([{ label: 'Service' }, { label: '文件' }, { label: '被引用数', num: true }], hubRows)
      : '<div class="empty">无 Service 节点。</div>')
    + (f.hubStores.length ? '<h3>高使用 Store</h3>'
      + '<div class="chips">' + f.hubStores.map((s) => chip(s.name + ' ← ' + s.usedByFileCount + ' 文件', 'green')).join('') + '</div>' : '')
    + '</div>';
}

// ---------- Tab 4 适配：函数意图流转矩阵（调用边按意图聚合）+ 高扇入函数 ----------
function renderScriptFlow(el) {
  const sf = M.scriptFlow;
  const roles = [];
  const flowIdx = new Map();
  for (const e of sf.flows) {
    for (const k of [e.from, e.to]) if (!roles.includes(k)) roles.push(k);
    flowIdx.set(e.from + '>' + e.to, e.count);
  }
  roles.sort((a, b) => ROLE_FLOW_ORDER.indexOf(a) - ROLE_FLOW_ORDER.indexOf(b));
  const maxCell = Math.max(1, ...sf.flows.map((e) => e.count));
  const roleChip = (r) => '<span class="chip" style="color:' + roleColor([r]) + ';border-color:' + roleColor([r]) + '55">' + esc(roleLabel(r)) + '</span>';
  const matrixRows = roles.map((from) => [
    { v: from, html: roleChip(from) },
    ...roles.map((to) => {
      const c = flowIdx.get(from + '>' + to) ?? 0;
      const cls = c === 0 ? 'cold' : (c / maxCell > 0.4 ? 'hot' : 'warm');
      return { v: c || '·', html: '<span class="' + cls + '">' + (c || '·') + '</span>' };
    }),
  ]);

  const hubRows = sf.hubs.map((h) => [
    { v: h.name, html: '<b>' + esc(h.name) + '</b>' },
    { v: (h.roles || []).map(roleLabel).join('/'), html: (h.roles || []).map((r) => roleChip(r)).join('') },
    { v: h.calledByCount, num: true },
    { v: h.callCount, num: true },
    { v: h.scriptName || '-', html: h.scriptName ? chip(h.scriptName, 'cyan') : '-' },
  ]);

  el.innerHTML =
    '<div class="panel"><h2>函数意图流转（' + fmt(sf.flowTotal) + ' 条调用边 · 跨意图 ' + sf.crossRoleEdges + ' 条）</h2>'
    + '<table class="matrix"><thead><tr><th>from ↓ / to →</th>'
    + roles.map((r) => '<th>' + roleChip(r) + '</th>').join('')
    + '</tr></thead><tbody>' + matrixRows.map((r) => '<tr>' + r.map((c) => '<td class="heat">' + (c.html || esc(c.v)) + '</td>').join('') + '</tr>').join('')
    + '</tbody></table>'
    + '<div class="note">单文件脚本无模块导入，以函数调用边按意图聚合：行 = 调用方意图，列 = 被调方意图。典型业务流转为 事件监听 → 纯逻辑 → 数据获取/状态存取 → 渲染注入；对角线为同意图内部互调（内聚）。</div></div>'

    + '<div class="panel"><h2>高扇入函数（变更影响面 Top ' + sf.hubs.length + '）</h2>'
    + (hubRows.length ? table([{ label: '函数' }, { label: '意图' }, { label: '被调数', num: true }, { label: '调出数', num: true }, { label: '所属脚本' }], hubRows)
      : '<div class="empty">无高扇入函数。</div>')
    + '<div class="note">被调数最多的函数改动影响面最大——修改前优先检查其调用方。</div></div>';
}

`;
