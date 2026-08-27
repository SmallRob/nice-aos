// 蓝图交互动作的**纯定义**单一数据源（E-2 技术债收敛，v0.35.0）。
//
// 历史背景（ADR 0002 审核报告 P1-1 / roadmap E-2）：
//   动作定义曾散落三处——blueprint.js 的 ACTION_PARAM_DEFS + blueprintActions.js 的
//   ACTION_DEFS + viewer.js 的内联 interactive.actionDefs，内容高度重叠但各有扩展，
//   已出现 viewer.js 少 analyzeFile 的实际漂移。v0.32.0 先收敛到 blueprintActions.js，
//   本模块按 roadmap 原方案把"定义"与"渲染"拆开：
//     - actionDefs.js      —— 纯数据（本文件）：ACTION_DEFS + getActionsForType
//     - blueprintActions.js —— 渲染层：buildActionCards / renderActionCardHtml(s)
//   依赖方向：blueprint.js / viewer.js 取数走 actionDefs.js；
//   blueprintActions.js re-export 兼容既有导入与测试断言。
//
// ParamDef 形态与 src/ontology/paramDefs.js / MCP toolRegistry.js 的 JSON Schema 一一对应。

/**
 * 内置动作的元数据。
 * 借鉴 aos 的 ActionDef + ParamDef；此为全部动作的单一事实源。
 *
 * @typedef {Object} ActionParamDef
 * @property {string} name
 * @property {'text'|'number'|'boolean'|'enum'|'objectRef'|'objectRefMulti'} kind
 * @property {string} label
 * @property {string} [placeholder]
 * @property {string[]} [options] kind=enum 时必填
 * @property {string} [refType] kind=objectRef/objectRefMulti 时可选
 * @property {number|string} [default]
 */

/**
 * @typedef {Object} ActionDef
 * @property {string} name 动作名（与 BLUEPRINT_SCHEMA.actionImpls 键一致）
 * @property {string} label 展示名
 * @property {string} description 描述
 * @property {ActionParamDef[]} params 表单参数
 * @property {'*'|string[]} applicableTypes 适用对象类型（'*' 为全部）
 */

/** @type {ActionDef[]} */
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
 * @returns {ActionDef[]} 适用的 ActionDef 列表
 */
export function getActionsForType(typeName) {
  return ACTION_DEFS.filter((a) => {
    if (a.applicableTypes === '*') return true;
    return Array.isArray(a.applicableTypes) && a.applicableTypes.includes(typeName);
  });
}
