// 蓝图客户端脚本片段。顺序由 viewerClient.js 拼接，勿单独重排。
export const PREAMBLE = `
<script>
const M = JSON.parse(document.getElementById('viewer-data').textContent);
const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmt = (n) => (n ?? 0).toLocaleString('zh-CN');
const fmtLocalTime = (iso) => {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return String(iso || '').replace('T', ' ').slice(0, 19);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
};

// ---------- Tab 切换 ----------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.view').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  document.getElementById('view-' + t.dataset.tab).classList.add('active');
}));

// ---------- 通用组件 ----------
const chip = (text, cls) => '<span class="chip ' + (cls || '') + '">' + esc(text) + '</span>';
function barRow(label, value, max, cls, desc) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return '<div class="layer-row"><div class="lr-main"><span class="lbl">' + esc(label) + '</span>'
    + '<div class="bar-wrap"><div class="bar ' + (cls || '') + '" style="width:' + pct + '%"></div></div>'
    + '<span class="val">' + fmt(value) + ' · ' + pct + '%</span></div>'
    + (desc ? '<div class="lr-desc">' + esc(desc) + '</div>' : '')
    + '</div>';
}
function table(headers, rows, opts) {
  opts = opts || {};
  const head = headers.map((h) => '<th class="' + (h.num ? 'num' : '') + '">' + esc(h.label) + '</th>').join('');
  const body = rows.map((r) => '<tr>' + r.map((c) => '<td class="' + (c.num ? 'num' : '') + '">' + (c.html || esc(c.v)) + '</td>').join('') + '</tr>').join('');
  return '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
}

`;
