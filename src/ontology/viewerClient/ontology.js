// 蓝图客户端脚本片段。顺序由 viewerClient.js 拼接，勿单独重排。
export const ONTOLOGY = `// ---------- Tab 2: 本体概览（v0.46.0：借鉴 asdm-aos getVocabulary + 范畴 × 层级 双维呈现） ----------
// 四大区块：KPI 概览 → 抽象层级条带（L3→L0）→ 概念范畴矩阵（每范畴一张卡片，含类型目录与活跃度）→ 链接词汇表（正反向成对 + 活跃状态）
let selectedOntologyType = null;
function renderOntology() {
  const el = document.getElementById('view-ontology');
  const bp = M.blueprint;
  const vocab = bp.vocabulary || { objectTypes: [], linkTypes: [], reverseLinkTypes: [], actions: [] };
  const matrix = bp.categoryMatrix || [];
  const levels = bp.levelCards || [];

  // KPI 卡片：概念范畴 / 抽象层级 / 对象类型 / 活跃类型 / 链接类型 / 总实例
  const kpis = '<div class="ont-kpis">'
    + '<div class="ont-kpi emph"><div class="v">' + fmt(bp.declaredTypeCount) + '</div><div class="k">声明类型</div></div>'
    + '<div class="ont-kpi emph"><div class="v">' + fmt(bp.activeTypeCount) + '</div><div class="k">活跃类型</div></div>'
    + '<div class="ont-kpi"><div class="v">' + fmt(matrix.length) + '</div><div class="k">概念范畴</div></div>'
    + '<div class="ont-kpi"><div class="v">' + fmt(levels.length) + '</div><div class="k">抽象层级</div></div>'
    + '<div class="ont-kpi"><div class="v">' + fmt(bp.declaredLinkTypeCount) + '</div><div class="k">链接类型</div></div>'
    + '<div class="ont-kpi"><div class="v">' + fmt(bp.totalInstanceCount) + '</div><div class="k">实例总数</div></div>'
    + '</div>';

  // 抽象层级条带（L3 → L0 自顶向下，每行含活跃度 + 实例总数）
  const levelStrip = '<div class="ont-level-strip">'
    + levels.map((lv) => {
      const pct = lv.declaredCount > 0 ? Math.round((lv.activeCount / lv.declaredCount) * 100) : 0;
      return '<div class="ont-level-row ' + lv.level + '">'
        + '<div class="lvl-mark">' + esc(lv.level) + '</div>'
        + '<div>'
        + '<div class="lvl-name">' + esc(lv.name) + '</div>'
        + '<div class="lvl-desc">' + esc(lv.description) + '</div>'
        + '<div class="ont-cat-progress" style="margin-top:6px"><div class="fill" style="width:' + pct + '%"></div></div>'
        + '</div>'
        + '<div class="lvl-stats">'
        + '<div>声明 <b>' + fmt(lv.declaredCount) + '</b></div>'
        + '<div>活跃 <b>' + fmt(lv.activeCount) + '</b></div>'
        + '<div>实例 <b>' + fmt(lv.instanceTotal) + '</b></div>'
        + '</div>'
        + '</div>';
    }).join('')
    + '</div>';

  // 概念范畴矩阵：每张分类卡片 = 分类头 + 进度条 + 类型目录（点击进入详情）
  const catGrid = '<div class="ont-cat-grid">'
    + matrix.map((cat) => {
      const pct = cat.declaredCount > 0 ? Math.round((cat.activeCount / cat.declaredCount) * 100) : 0;
      const rows = cat.types
        .slice()
        .sort((a, b) => (b.count - a.count) || a.type.localeCompare(b.type))
        .map((t) => '<div class="ont-type-row ' + (t.active ? 'active' : 'idle') + '" data-type="' + esc(t.type) + '" data-cat="' + esc(cat.category) + '">'
          + '<div class="lvl-tag ' + esc(t.level || 'shared') + '">' + esc(t.level || '?') + '</div>'
          + '<div class="t-meta">'
          + '<div class="t-name">' + esc(t.type) + '<span class="prefix-tag">' + esc(t.prefix || '') + '</span></div>'
          + '<div class="t-desc" title="' + esc(t.description || '') + '">' + esc(t.description || '（未描述）') + '</div>'
          + '</div>'
          + '<div class="t-cnt">' + fmt(t.count) + '</div>'
          + '</div>')
        .join('');
      return '<div class="ont-cat-card">'
        + '<div class="ont-cat-head">'
        + '<div><div class="cat-label">' + esc(cat.label) + '</div>'
        + '<div class="cat-desc">' + esc(cat.description) + '</div></div>'
        + '<div style="text-align:right"><span class="chip blue">' + fmt(cat.activeCount) + '/' + fmt(cat.declaredCount) + ' 活跃</span>'
        + '<div style="font-size:11px;color:var(--fg-faint);margin-top:4px">' + fmt(cat.instanceTotal) + ' 实例</div></div>'
        + '</div>'
        + '<div class="ont-cat-progress"><div class="fill" style="width:' + pct + '%"></div></div>'
        + '<div class="ont-cat-types">' + (rows || '<div class="empty">（该范畴无类型）</div>') + '</div>'
        + '</div>';
    }).join('')
    + '</div>';

  // 链接词汇表：成对展示 forward ↔ reverse（asdm-aos getVocabulary 风格）
  const linkPairs = bp.linkTypePairs || {};
  const usedForward = new Set();
  const usedReverse = new Set();
  // 我们没有 link 实例计数（需 linkImpl 实际执行），先按"声明 + 是否有实现"展示；UI 上仍标"已声明"
  const fwdList = (bp.linkTypes || []).filter((l) => !Object.values(linkPairs).includes(l) && l !== 'belongsTo');
  const pairRows = Object.entries(linkPairs).map(([fwd, rev]) => {
    usedForward.add(fwd); usedReverse.add(rev);
    return '<tr><td>'
      + '<span class="ont-link-status live" title="已声明为正反向一对"></span>'
      + '</td><td><span class="ont-link-pair">'
      + '<span class="link-name">' + esc(fwd) + '</span>'
      + '<span class="arrow">↔</span>'
      + '<span class="link-name rev">' + esc(rev) + '</span>'
      + '</span></td>'
      + '<td style="color:var(--fg-faint);font-size:11px">双向语义</td></tr>';
  }).join('');
  const fwdOnlyRows = fwdList.map((l) =>
    '<tr><td><span class="ont-link-status decl" title="仅声明正向"></span></td>'
    + '<td><span class="ont-link-pair"><span class="link-name">' + esc(l) + '</span></span></td>'
    + '<td style="color:var(--fg-faint);font-size:11px">单向 / 反查</td></tr>'
  ).join('');
  const revOnlyRows = (bp.reverseLinkTypes || []).filter((l) => !usedReverse.has(l)).map((l) =>
    '<tr><td><span class="ont-link-status unknown" title="反向声明但无显式配对"></span></td>'
    + '<td><span class="ont-link-pair"><span class="link-name rev">' + esc(l) + '</span></span></td>'
    + '<td style="color:var(--fg-faint);font-size:11px">反向</td></tr>'
  ).join('');
  const linkTable = '<table class="ont-link-table"><thead><tr><th style="width:32px"></th><th>链接名</th><th>语义</th></tr></thead><tbody>'
    + pairRows + fwdOnlyRows + revOnlyRows + '</tbody></table>';

  el.innerHTML =
    '<div class="panel"><h2>本体概览（v' + esc(bp.version || '') + '）：把"哪些类型与边被声明"和"哪些类型与边真的有数据"摆到一起</h2>'
    + '<div class="note">借鉴 asdm-aos getVocabulary（ontology.service.ts:178-194）：objectTypes + count 按出现频次排序 + linkTypes/linksActions 一并暴露给 agent 与 UI。<br>'
    + '本页六大区块：① 顶部 KPI 指标（声明 / 活跃类型 / 范畴 / 层级 / 链接 / 实例）→ ② 抽象层级条带（L3 架构层 → L0 审计事实，活跃度进度条 + 实例总数）→ ③ 概念范畴矩阵（每张卡 = 一个范畴，按活跃度倒序排类型行；点击类型进入详情）→ ④ 链接词汇表（正反向成对 + 活跃状态点）→ ⑤ 选中类型后的描述 + 样本实例预览。</div>'
    + '</div>'
    + '<div class="panel"><h2>① 概览指标</h2>' + kpis + '</div>'
    + '<div class="panel"><h2>② 抽象层级（L3 架构 → L0 事实）</h2>' + levelStrip + '</div>'
    + '<div class="panel"><h2>③ 概念范畴矩阵</h2>' + catGrid + '</div>'
    + '<div id="ont-type-detail"></div>'
    + '<div class="panel"><h2>④ 链接词汇表（forward ↔ reverse）</h2>' + linkTable
    + '<div class="note">状态点：<span class="ont-link-status live"></span> 已声明为正反向一对 · '
    + '<span class="ont-link-status decl"></span> 仅声明正向（反查靠所属字段） · '
    + '<span class="ont-link-status unknown"></span> 反向声明但未与正向配对</div></div>';

  // 类型目录点击 → 详情面板
  el.querySelectorAll('.ont-type-row').forEach((row) => {
    row.addEventListener('click', () => {
      const typeName = row.dataset.type;
      el.querySelectorAll('.ont-type-row').forEach((x) => x.classList.toggle('selected', x === row));
      renderOntologyTypeDetail(typeName);
    });
  });
}

function renderOntologyTypeDetail(typeName) {
  const box = document.getElementById('ont-type-detail');
  if (!box) return;
  const t = M.blueprint.objectTypes.find((x) => x.type === typeName);
  if (!t) { box.innerHTML = '<div class="empty">未找到类型 ' + esc(typeName) + '</div>'; return; }
  const cat = (M.blueprint.categoryMatrix || []).find((c) => c.category === t.category);
  const level = (M.blueprint.levelCards || []).find((l) => l.level === t.level);
  const sampleList = (M.dataMap && M.dataMap[typeName]) || [];
  const samples = sampleList.slice(0, 5).map((o) => '<div class="d-sample-item">' + esc(o.name || o.id) + ' <span style="color:var(--fg-faint);font-size:10px">· ' + esc(o.id) + '</div>').join('');
  box.innerHTML =
    '<div class="d-head">'
    + '<div class="d-name">' + esc(typeName) + '</div>'
    + '<div class="d-meta">'
    + chip(t.level || '?', level ? t.level === 'L0' ? 'red' : (t.level === 'L1' ? 'cyan' : (t.level === 'L2' ? 'purple' : 'green')) : '')
    + chip(t.category, 'blue')
    + chip(t.count + ' 实例', t.count > 0 ? 'green' : '')
    + (t.prefix ? chip(t.prefix, 'cyan') : '')
    + '</div></div>'
    + '<div class="d-desc">' + esc(t.description || '（未提供描述）') + '</div>'
    + (samples ? '<div class="d-sample"><h4>样本实例（前 ' + Math.min(5, sampleList.length) + '）</h4>' + samples + '</div>' : '<div class="d-empty">（该类型当前快照无实例 — 声明但未在扫描范围或解析失败）</div>');
}

`;
