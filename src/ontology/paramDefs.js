// ParamDef 形态定义 + 蓝图 UI 自动渲染契约。
// 借鉴 asdm-aos v0.0.12 的 ParamDef 设计（src/server/ontology/meta.ts:40-44）：
//   - text: 文本输入
//   - enum: 下拉选择
//   - objectRef: 单个对象引用
//   - objectRefMulti: 多个对象引用
// 扩展（前端友好）：
//   - number: 数字输入
//   - boolean: 复选框
//
// 蓝图 UI（HTML 蓝图 + 油猴脚本）按 ParamDef 自动渲染合适的表单控件。
// 控件契约：每个 ParamDef 对应一个 HTML 控件，自动绑定到 form 的 dataset[paramName]。

/**
 * 控件类型 → HTML 控件默认属性。
 * 蓝图 UI 渲染表单时按此生成。
 */
export const PARAM_RENDER_DEFAULTS = {
  text: { tag: 'input', type: 'text', attrs: { class: 'bp-input' } },
  number: { tag: 'input', type: 'number', attrs: { class: 'bp-input bp-num' } },
  boolean: { tag: 'input', type: 'checkbox', attrs: { class: 'bp-check' } },
  enum: { tag: 'select', attrs: { class: 'bp-select' } },
  objectRef: { tag: 'select', attrs: { class: 'bp-select bp-ref' }, multiple: false },
  objectRefMulti: { tag: 'select', attrs: { class: 'bp-select bp-ref', multiple: 'multiple' } },
};

/**
 * 蓝图 UI 自动渲染契约：将 ParamDef 列表转为 HTML 表单字段数组。
 * 不渲染 HTML 字符串（避免 SSR 风险），仅产出字段描述，前端按此渲染。
 *
 * @param {ActionDef} actionDef
 * @returns {Array<{ name, kind, label, input: { tag, type?, attrs, options?, multiple? } }>}
 */
export function paramDefsToFormFields(actionDef) {
  if (!actionDef?.params) return [];
  return actionDef.params.map((p) => ({
    name: p.name,
    kind: p.kind,
    label: p.label,
    placeholder: p.placeholder,
    input: PARAM_RENDER_DEFAULTS[p.kind] || PARAM_RENDER_DEFAULTS.text,
    options: p.options,
    refType: p.refType,
    min: p.min,
    max: p.max,
  }));
}
