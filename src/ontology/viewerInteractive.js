// 交互操作客户端脚本段（viewerInteractive.js）：renderInteractive + renderActionCardHtml
// 原为 viewer.js L3373-3527 中的 function renderInteractive / function renderActionCardHtml
// viewer.js 的 renderInteractiveScript()（L3361-3371）仍用 .toString() 把这两个函数注入到 HTML 第二个 <script> 块
// 函数体中的 M/esc/fmt/fmtLocalTime 等 const 来自 viewer.js 第一个 <script> 块（L1341-1348），浏览器共享全局作用域
// 函数体内部不引用本文件外部 import 内容，import 仅用于 viewer.js 通过 .toString() 拿到函数引用
export function renderInteractive() {
  const I = M.interactive;
  if (!I) return;
  const el = document.getElementById('view-interactive');
  el.innerHTML =
    '<div class="panel"><h2>交互操作</h2>'
    + '<div class="note">借鉴 asdm-aos ActionPanel.tsx：按对象类型过滤可用动作；点击下方"对象选择"中的对象可自动填入 objectId，提交走 fetch 调 nice-aos serve 的 <code>/action</code> 端点。</div>'
    + '<div class="bp-interactive-grid">'
    + '<div class="bp-actions-col" id="bp-actions-col"></div>'
    + '<div class="bp-picker-col"><h3>对象选择</h3>'
    + '<input type="search" id="bp-obj-search" placeholder="按 id / 名称 / 路径模糊搜索…" />'
    + '<select id="bp-type-filter"><option value="">全部类型</option></select>'
    + '<div class="bp-obj-list" id="bp-obj-list"></div>'
    + '</div></div>'
    + '</div>';
  const typeFilter = document.getElementById('bp-type-filter');
  const types = new Set();
  for (const k of Object.keys(M.dataMap || {})) {
    if (Array.isArray(M.dataMap[k]) && M.dataMap[k].length > 0) types.add(k);
  }
  for (const t of [...types].sort()) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t + ' (' + M.dataMap[t].length + ')';
    typeFilter.appendChild(opt);
  }
  window.__bp_selected = { id: null, type: null };
  const objList = document.getElementById('bp-obj-list');
  const allObjs = [];
  for (const t of types) {
    for (const o of M.dataMap[t]) allObjs.push({ type: t, obj: o });
  }
  const renderObjList = (filter, tf) => {
    objList.innerHTML = '';
    const lower = (filter || '').toLowerCase();
    const matched = allObjs.filter((x) => {
      if (tf && x.type !== tf) return false;
      if (!lower) return true;
      const o = x.obj;
      return (o.id || '').toLowerCase().includes(lower)
        || (o.name || '').toLowerCase().includes(lower)
        || (o.path || o.filePath || '').toLowerCase().includes(lower);
    }).slice(0, 200);
    for (const x of matched) {
      const div = document.createElement('div');
      div.className = 'bp-obj-item';
      div.dataset.id = x.obj.id;
      div.dataset.type = x.type;
      div.innerHTML = '<span class="bp-obj-type">' + esc(x.type) + '</span> '
        + '<span class="bp-obj-name">' + esc(x.obj.name || x.obj.id) + '</span> '
        + '<code class="bp-obj-id">' + esc(x.obj.id) + '</code>';
      div.addEventListener('click', () => {
        window.__bp_selected = { id: x.obj.id, type: x.type };
        objList.querySelectorAll('.bp-obj-item').forEach((e) => e.classList.remove('selected'));
        div.classList.add('selected');
        renderActions();
      });
      objList.appendChild(div);
    }
    if (matched.length === 0) objList.innerHTML = '<div class="empty">无匹配对象</div>';
    if (matched.length === 200) {
      var notice = document.createElement('div');
      notice.className = 'bp-obj-truncated';
      notice.textContent = '仅显示前 200 条，请缩小搜索范围查看更多';
      objList.appendChild(notice);
    }
  };
  document.getElementById('bp-obj-search').addEventListener('input', (e) => {
    renderObjList(e.target.value, typeFilter.value);
  });
  typeFilter.addEventListener('change', (e) => {
    renderObjList(document.getElementById('bp-obj-search').value, e.target.value);
  });
  renderObjList('', '');
  const renderActions = () => {
    const sel = window.__bp_selected;
    const col = document.getElementById('bp-actions-col');
    if (!sel.id) {
      col.innerHTML = '<div class="bp-actions-empty">请在右侧选择一个对象</div>';
      return;
    }
    const cards = I.actionDefs.map((a) => {
      const applicable = a.applicableTypes === '*' || (Array.isArray(a.applicableTypes) && a.applicableTypes.includes(sel.type));
      const params = a.params.map((p) => {
        const field = { name: p.name, kind: p.kind, label: p.label, placeholder: p.placeholder, options: p.options, refType: p.refType, min: p.min, max: p.max };
        if (p.name === 'objectId') field.default = sel.id;
        return field;
      });
      return { name: a.name, label: a.label, description: a.description, params, endpoint: I.endpoint, applicableNow: applicable, reason: applicable ? null : (a.label + ' 不适用于 ' + sel.type) };
    });
    col.innerHTML = cards.map((c) => renderActionCardHtml(c)).join('');
    col.querySelectorAll('form.bp-action-card').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const input = {};
        for (const [k, v] of fd.entries()) input[k] = v;
        const resultEl = form.querySelector('[data-result]');
        resultEl.textContent = '提交中…';
        try {
          const resp = await fetch(form.dataset.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actionName: form.dataset.action, params: input }),
          });
          const j = await resp.json();
          resultEl.textContent = j.ok ? ('✓ ' + j.message) : ('✗ ' + j.message);
          resultEl.className = 'bp-action-result ' + (j.ok ? 'ok' : 'err');
        } catch (err) {
          resultEl.textContent = '✗ ' + err.message;
          resultEl.className = 'bp-action-result err';
        }
      });
    });
  };
  renderActions();
}

export function renderActionCardHtml(c) {
  const disabled = !c.applicableNow ? 'disabled' : '';
  const disabledClass = !c.applicableNow ? 'bp-action-card--disabled' : '';
  const reasonHtml = c.reason ? '<div class="bp-action-reason">' + esc(c.reason) + '</div>' : '';
  var fieldsHtml = c.params.map(function(p) {
    var id = 'bp-field-' + p.name;
    var val = p.default != null ? ' value="' + esc(String(p.default)) + '"' : '';
    var ph = p.placeholder ? ' placeholder="' + esc(p.placeholder) + '"' : '';
    var inputHtml = '';
    if (p.kind === 'boolean') {
      var checked = p.default ? 'checked' : '';
      inputHtml = '<input type="checkbox" id="' + id + '" name="' + p.name + '" ' + checked + ' />';
    } else if (p.kind === 'number') {
      var minA = p.min != null ? ' min="' + p.min + '"' : '';
      var maxA = p.max != null ? ' max="' + p.max + '"' : '';
      inputHtml = '<input type="number" id="' + id + '" name="' + p.name + '"' + val + ph + minA + maxA + ' />';
    } else if (p.kind === 'enum' && p.options) {
      var opts = p.options.map(function(o) { return '<option value="' + esc(o) + '">' + esc(o) + '</option>'; }).join('');
      inputHtml = '<select id="' + id + '" name="' + p.name + '">' + opts + '</select>';
    } else if (p.kind === 'objectRef' || p.kind === 'objectRefMulti') {
      var multi = p.kind === 'objectRefMulti' ? ' multiple' : '';
      var refAttr = p.refType ? ' data-reftype="' + esc(p.refType) + '"' : '';
      inputHtml = '<select id="' + id + '" name="' + p.name + '"' + multi + refAttr + '><option value="">(选择对象)</option></select>';
    } else {
      inputHtml = '<input type="text" id="' + id + '" name="' + p.name + '"' + val + ph + ' />';
    }
    return '<label class="bp-field" for="' + id + '"><span class="bp-field-label">' + esc(p.label) + '</span>' + inputHtml + '</label>';
  }).join('');
  return '<form class="bp-action-card ' + disabledClass + '" data-action="' + esc(c.name) + '" data-endpoint="' + esc(c.endpoint) + '" autocomplete="off">'
    + '<div class="bp-action-header"><span class="bp-action-label">' + esc(c.label) + '</span>'
    + (c.applicableNow ? '' : '<span class="bp-action-badge">不可用</span>') + '</div>'
    + '<div class="bp-action-desc">' + esc(c.description) + '</div>'
    + reasonHtml
    + '<div class="bp-action-fields">' + fieldsHtml + '</div>'
    + '<div class="bp-action-footer"><button type="submit" ' + disabled + '>执行 ' + esc(c.label) + '</button><span class="bp-action-result" data-result></span></div>'
    + '</form>';
}
