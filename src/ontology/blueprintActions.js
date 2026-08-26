// 蓝图交互动作的 HTML 表单 schema 生成器。
// 借鉴 asdm-aos v0.0.12 ActionPanel.tsx 的设计（src/web/components/ActionPanel.tsx）：
//   - 按对象类型过滤可用动作（getActionsForType）
//   - 自动按 ParamDef.kind 渲染表单
//   - 提交走 fetch 调后端
//
// nice-aos 改造点：
//   - 不引入 React 运行时，输出纯 HTML 字符串（蓝图报告内可内嵌）
//   - 输出结构化的"动作卡片" JSON，供 viewer.js 注入到 HTML 蓝图
//   - 油猴脚本（contrib/blueprint-ai-agent）能直接消费 actions[] 渲染交互
//
// 用法：
//   import { buildActionCards, renderActionCardHtml } from '../src/ontology/blueprintActions.js';
//   const cards = buildActionCards({ dataMap, blueprintSchema, selectedObjId });
//   const html = renderActionCardHtml(cards[0]); // 单个卡片 HTML

import { paramDefsToFormFields, PARAM_RENDER_DEFAULTS } from './paramDefs.js';

/**
 * 内置动作的元数据。
 * 借鉴 aos 的 ActionDef + ParamDef；此为动作定义的单一数据源，blueprint.js / viewer.js 均从此导入。
 */
export const ACTION_DEFS = [
  {
    name: 'markReviewed',
    label: '标记已审查',
    description: '将指定对象标记为已审查（不影响 DataMap 其他字段）',
    params: [
      { name: 'objectId', kind: 'text', label: '对象 ID', placeholder: '如 method:Foo.bar 或 comp:Button' },
    ],
    applicableTypes: '*', // 所有类型
  },
  {
    name: 'addNote',
    label: '添加注释',
    description: '为指定对象添加注释（多行累加）',
    params: [
      { name: 'objectId', kind: 'text', label: '对象 ID', placeholder: '如 method:Foo.bar' },
      { name: 'note', kind: 'text', label: '注释内容', placeholder: '自由文本' },
    ],
    applicableTypes: '*',
  },
  {
    name: 'refreshRepo',
    label: '刷新仓库',
    description: '重新分析指定 git 仓库路径',
    params: [
      { name: 'repoPath', kind: 'text', label: '仓库路径', placeholder: '项目根或 .' },
    ],
    applicableTypes: ['Project'], // 仅 Project 可用
  },
  {
    name: 'analyzeFile',
    label: '分析单文件',
    description: '对单个文件运行本体分析，输出 DataMap',
    params: [
      { name: 'file', kind: 'text', label: '文件路径', placeholder: '相对 cwd 或绝对路径' },
    ],
    applicableTypes: '*',
  },
];

/**
 * 按对象类型过滤可用动作。
 * 借鉴 aos 的 getActionsForType（src/web/components/ActionPanel.tsx:65-77）。
 *
 * @param {string} typeName 对象类型名（如 'Component' / 'Project'）
 * @returns {Array} 适用的 ActionDef 列表
 */
export function getActionsForType(typeName) {
  return ACTION_DEFS.filter((a) => {
    if (a.applicableTypes === '*') return true;
    return Array.isArray(a.applicableTypes) && a.applicableTypes.includes(typeName);
  });
}

/**
 * 构造当前选中对象可用的动作卡片数据。
 * 输出结构化 JSON（不是 HTML），供 viewer.js / 油猴脚本消费。
 *
 * @param {object} ctx
 * @param {string} ctx.selectedObjId 当前选中的对象 ID
 * @param {string} ctx.selectedObjType 选中对象的类型名（用于过滤）
 * @param {string} [ctx.endpoint='/action'] POST 端点
 * @returns {Array<{ name, label, description, params: Array, applicableNow: boolean, reason?: string }>}
 */
export function buildActionCards({ selectedObjId, selectedObjType, endpoint = '/action' }) {
  if (!selectedObjId) {
    return ACTION_DEFS
      .filter((a) => a.applicableTypes === '*' || a.applicableTypes.includes('Project'))
      .map((a) => buildActionCard(a, null, endpoint, false, '未选中对象'));
  }
  const applicable = getActionsForType(selectedObjType ?? 'Unknown');
  return ACTION_DEFS.map((a) => {
    const inApplicable = applicable.includes(a);
    return buildActionCard(a, selectedObjId, endpoint, inApplicable,
      inApplicable ? null : `${a.label} 不适用于 ${selectedObjType ?? '当前对象'}`);
  });
}

function buildActionCard(actionDef, objectId, endpoint, applicableNow, reason) {
  return {
    name: actionDef.name,
    label: actionDef.label,
    description: actionDef.description,
    params: actionDef.params.map((p) => {
      // objectId 默认填入
      if (p.name === 'objectId' && objectId) {
        return paramDefsToFormFields({ params: [p] })[0] && { ...paramDefsToFormFields({ params: [p] })[0], default: objectId };
      }
      return paramDefsToFormFields({ params: [p] })[0];
    }),
    endpoint,
    applicableNow,
    reason,
  };
}

/**
 * 把单个动作卡片渲染为 HTML 字符串。
 * 借鉴 aos ActionPanel 的表单渲染：按 ParamDef.kind 自动生成控件。
 * 输出包含 dataset-action 钩子，方便前端 JS 拦截。
 *
 * @param {object} card buildActionCards 输出的单个卡片
 * @param {object} [opts]
 * @param {string} [opts.themeColor='#58a6ff'] 主题色（按钮/边框）
 * @returns {string} HTML 字符串
 */
export function renderActionCardHtml(card, opts = {}) {
  const themeColor = opts.themeColor ?? '#58a6ff';
  const disabled = !card.applicableNow ? 'disabled' : '';
  const disabledClass = !card.applicableNow ? 'bp-action-card--disabled' : '';
  const reasonHtml = card.reason ? `<div class="bp-action-reason">${escapeHtml(card.reason)}</div>` : '';
  const fieldsHtml = card.params.map((p) => renderParamField(p, themeColor)).join('\n');
  return `<form class="bp-action-card ${disabledClass}" data-action="${escapeHtml(card.name)}" data-endpoint="${escapeHtml(card.endpoint)}" autocomplete="off">
  <div class="bp-action-header">
    <span class="bp-action-label">${escapeHtml(card.label)}</span>
    ${card.applicableNow ? '' : '<span class="bp-action-badge">不可用</span>'}
  </div>
  <div class="bp-action-desc">${escapeHtml(card.description)}</div>
  ${reasonHtml}
  <div class="bp-action-fields">${fieldsHtml}</div>
  <div class="bp-action-footer">
    <button type="submit" ${disabled} style="background:${themeColor}">执行 ${escapeHtml(card.label)}</button>
    <span class="bp-action-result" data-result></span>
  </div>
</form>`;
}

function renderParamField(field, themeColor) {
  if (!field) return '';
  const { name, kind, label, input, default: defaultVal, options, refType, placeholder, min, max } = field;
  const id = `bp-field-${name}`;
  const valAttr = defaultVal != null ? ` value="${escapeHtml(String(defaultVal))}"` : '';
  const placeholderAttr = placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : '';
  let inputHtml = '';
  if (kind === 'boolean') {
    const checked = defaultVal ? 'checked' : '';
    inputHtml = `<input type="checkbox" id="${id}" name="${name}" ${checked} />`;
  } else if (kind === 'enum' && options) {
    const opts = options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
    inputHtml = `<select id="${id}" name="${name}">${opts}</select>`;
  } else if (kind === 'objectRef' || kind === 'objectRefMulti') {
    // objectRef 在蓝图报告中无法完整渲染（缺数据时只能给下拉）；
    // 留 placeholder 让 blueprint 渲染器替换为真实对象列表
    const refAttr = refType ? ` data-reftype="${escapeHtml(refType)}"` : '';
    const multi = kind === 'objectRefMulti' ? 'multiple' : '';
    inputHtml = `<select id="${id}" name="${name}" ${multi} ${refAttr} data-reftype="${escapeHtml(refType ?? '')}"><option value="">(待 blueprint 注入)</option></select>`;
  } else if (kind === 'number') {
    const minAttr = min != null ? ` min="${min}"` : '';
    const maxAttr = max != null ? ` max="${max}"` : '';
    inputHtml = `<input type="number" id="${id}" name="${name}"${valAttr}${placeholderAttr}${minAttr}${maxAttr} />`;
  } else {
    // text（默认）
    inputHtml = `<input type="text" id="${id}" name="${name}"${valAttr}${placeholderAttr} />`;
  }
  return `<label class="bp-field" for="${id}">
  <span class="bp-field-label">${escapeHtml(label)}</span>
  ${inputHtml}
</label>`;
}

/**
 * 简单 HTML 转义（蓝图报告 innerHTML 注入用）。
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 把所有动作卡片拼成一段 HTML（蓝图报告嵌入用）。
 * @param {object[]} cards
 * @param {object} [opts]
 * @returns {string} HTML 字符串
 */
export function renderActionCardsHtml(cards, opts = {}) {
  if (!cards || cards.length === 0) return '<div class="bp-actions-empty">无可用动作</div>';
  return cards.map((c) => renderActionCardHtml(c, opts)).join('\n');
}
