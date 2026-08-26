// 蓝图引擎：领域无关的"本体运行时"。
// 借鉴 asdm-aos v0.0.12 的 BlueprintRuntime + createEngine 模式（src/server/ontology/engine.ts:39-93）：
//   - 解耦：元模型（schema）/ 数据（dataMap）/ 链接解析（linkImpls）/ 动作实现（actionImpls）四层分离
//   - 引擎只认通用契约，不知道任何具体业务字段
//   - 链接解析接收 (src, ctx)，ctx 暴露 byId/byType/snapshot
//   - 动作通过 (ctx, input) => ActionResult 统一返回 {ok, message}，支持守卫语义
//   - 写回不污染种子：engine.data 是 seedData 的深拷贝副本
//   - 抽象类型支持：ObjectTypeDef.kind = "object" | "interface"（参考 Foundry Ontology InterfaceDefinition）
//
// 与 nice-aos 既有 createBlueprint()（src/ontology/blueprint.js）共存：
//   - createBlueprint() 走"数据驱动单蓝图"路线（既有 CLI 走这里，零迁移）
//   - createBlueprintEngine() 走"schema+impls"配置路线（新蓝图如 service/planning/db/deploy 可走这里）
//
// 数据契约：
//   - dataMap: 任意形如 { Type1: [obj1, obj2], Type2: [...] } 的对象集合
//   - objectTypes: [{ name, label?, kind?, properties?, actions? }, ...]
//   - linkTypes: ['contains', 'imports', ...]（字符串数组即可）
//   - actionDefs: [{ name, label, params: [ParamDef], description? }, ...]（可选；没有则用 actionNames 字符串数组）
//   - linkImpls: { [linkType]: (src, ctx) => AnyObj[] }
//   - actionImpls: { [actionName]: (ctx, input) => { ok, message } }
//   - findById: (id) => AnyObj | null（提供快速 by-id 索引，默认走 ctx.byId.get(id)）

/**
 * @typedef {Object} AnyObj
 * @property {string} id 任意对象：必有 id，其余字段任意。与 aos 引擎的 AnyObj 同构。
 */

/**
 * @typedef {Object.<string, AnyObj[]>} DataMap
 * 数据容器：类型名 -> 实例数组。与 aos 的 DataMap 同构。
 */

/**
 * @typedef {Object} PropertyDef
 * @property {string} key
 * @property {string} label
 * @property {('text'|'number'|'boolean'|'array'|'object')} [kind] 与 aos 的 PropertyDef 对齐
 */

/**
 * @typedef {Object} ObjectTypeDef
 * @property {string} name
 * @property {string} [label]
 * @property {('object'|'interface')} [kind] 对象种类：object（具体类型，有数据实例）| interface（抽象类型，无数据实例）。默认 object
 * @property {PropertyDef[]} [properties] 属性元数据
 * @property {string[]} [actions] 该对象类型可用的动作名（蓝图 UI 按类型过滤）。可选
 * @property {string} [prefix] id 前缀（如 'mod:' / 'comp:'），用于 findObjectByPrefix 推断类型
 * @property {string} [description]
 */

/**
 * @typedef {Object} LinkTypeDef
 * @property {string} name
 * @property {string} [label]
 * @property {string} [sourceType]
 * @property {string} [targetType]
 * @property {string} [description]
 */

/**
 * @typedef {(
 *   { name: string, kind: 'text', label: string, placeholder?: string } |
 *   { name: string, kind: 'number', label: string, min?: number, max?: number } |
 *   { name: string, kind: 'boolean', label: string } |
 *   { name: string, kind: 'enum', label: string, options: string[] } |
 *   { name: string, kind: 'objectRef', label: string, refType: string } |
 *   { name: string, kind: 'objectRefMulti', label: string, refType: string }
 * )} ParamDef
 *
 * 借鉴 aos 的 ParamDef 四种 kind（text/enum/objectRef/objectRefMulti），扩展 number/boolean。
 */

/**
 * @typedef {Object} ActionDef
 * @property {string} name
 * @property {string} label
 * @property {ParamDef[]} params
 * @property {string} [description]
 */

/**
 * @typedef {Object} ActionResult
 * @property {boolean} ok 始终显式返回，便于 UI / Agent 呈现守卫结果
 * @property {string} message
 * @property {Object.<string, *>} [data]
 */

/**
 * @typedef {Object} EngineContext
 * @property {DataMap} data
 * @property {Map<string, AnyObj>} byId
 * @property {Map<string, AnyObj[]>} byType
 * @property {() => DataMap} snapshot
 */

/**
 * @typedef {(src: AnyObj, ctx: EngineContext) => AnyObj[]} LinkImpl
 * 借鉴 aos 的 linkImpls 形态。
 */

/**
 * @typedef {(ctx: EngineContext, input: Object.<string, *>) => ActionResult} ActionImpl
 * 借鉴 aos 的 actionImpls 形态。
 */

/**
 * @typedef {Object} BlueprintRuntime
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {ObjectTypeDef[]} objectTypes
 * @property {(string|LinkTypeDef)[]} linkTypes
 * @property {(string|ActionDef)[]} actionDefs 动作名（简写：string[]）或动作定义（ActionDef[]）
 * @property {Object.<string, LinkImpl>} linkImpls 链接解析实现，键与 linkTypes 的 name 一致
 * @property {Object.<string, ActionImpl>} actionImpls 动作实现，键与 actionDefs 的 name 一致
 * @property {() => DataMap} [createData] 可选：种子数据。引擎构造时会深拷贝（不污染 seed）
 */

/**
 * @typedef {Object} BlueprintSchema
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {ObjectTypeDef[]} objectTypes
 * @property {LinkTypeDef[]} linkTypes
 * @property {ActionDef[]} actionDefs
 * @property {Object.<string, number>} objectCounts
 */

/**
 * @typedef {Object} Engine
 * @property {BlueprintRuntime} blueprint
 * @property {(id: string) => AnyObj|null} find 按 id 查找对象（O(1)）
 * @property {(type: string, pred?: (obj: AnyObj) => boolean) => AnyObj[]} where 按类型 + 谓词过滤（无类型时返回全量）
 * @property {(linkType: string, srcId: string) => AnyObj[]} link 遍历链接
 * @property {(name: string, input?: Object.<string, *>) => ActionResult} action 执行动作
 * @property {() => DataMap} snapshot 获取当前数据快照（深拷贝防外部污染）
 * @property {() => BlueprintSchema} schema Schema 元数据（自描述：types / linkTypes / actions / objectTypeDefs / actionDefs）
 */

/**
 * 创建蓝图引擎实例。
 * 借鉴 aos 的 createEngine(bp)：
 *   - seedData 深拷贝到 data
 *   - 每个声明的对象类型至少有空数组
 *   - 构造 byId / byType 索引
 *   - linkImpls / actionImpls 暴露为 engine.link / engine.action
 *
 * @param {BlueprintRuntime} bp
 * @returns {Engine}
 */
export function createBlueprintEngine(bp) {
  // 深拷贝种子数据（递归拷贝嵌套对象/数组，防 action 写穿 seed）
  /** @type {DataMap} */
  const data = {};
  const seedData = bp.createData ? bp.createData() : {};
  for (const key of Object.keys(seedData)) {
    const val = seedData[key];
    if (Array.isArray(val)) {
      data[key] = val.map((r) => deepCloneObj(r));
    } else if (val != null) {
      data[key] = deepCloneObj(val);
    }
  }
  // 保证每个已声明对象类型至少存在空数组
  for (const t of bp.objectTypes) {
    if (!data[t.name]) data[t.name] = [];
  }

  // 构造 byId / byType 索引
  /** @type {Map<string, AnyObj>} */
  const byId = new Map();
  /** @type {Map<string, AnyObj[]>} */
  const byType = new Map();
  for (const t of bp.objectTypes) {
    const arr = data[t.name] ?? [];
    byType.set(t.name, arr);
    for (const obj of arr) byId.set(obj.id, obj);
  }

  // 引擎上下文（每次 link/action 调用时都拿最新 data / byId / byType，
  // 避免闭包捕获旧引用；snapshot() 也走最新 data）
  const buildCtx = () => ({
    data,
    byId,
    byType,
    snapshot: () => deepSnapshot(data),
  });

  // find
  const find = (id) => byId.get(id) ?? null;

  // where
  const where = (type, pred) => {
    const arr = byType.get(type);
    if (!arr) return [];
    if (!pred) return arr.slice();
    return arr.filter(pred);
  };

  // link：先查源对象（按 id 找），再调 linkImpl
  const link = (linkType, srcId) => {
    const impl = bp.linkImpls[linkType];
    if (!impl) {
      throw new Error(
        `未知链接类型: ${linkType}（可用: ${Object.keys(bp.linkImpls).join(', ')}）`,
      );
    }
    const src = byId.get(srcId);
    if (!src) {
      // 与既有 createBlueprint() 行为对齐：源不存在返回空数组（不抛错）
      return [];
    }
    return impl(src, buildCtx());
  };

  // action：调 actionImpl；动作未注册则返回守卫失败
  const action = (name, input = {}) => {
    const impl = bp.actionImpls[name];
    if (!impl) {
      return {
        ok: false,
        message: `未知动作: ${name}（可用: ${Object.keys(bp.actionImpls).join(', ')}）`,
      };
    }
    try {
      return impl(buildCtx(), input);
    } catch (err) {
      return {
        ok: false,
        message: `动作执行异常: ${err?.message ?? err}`,
      };
    }
  };

  // snapshot：返回深拷贝（防外部污染 engine.data）
  const snapshot = () => deepSnapshot(data);

  // schema：暴露给 agent
  const schema = () => {
    /** @type {Object.<string, number>} */
    const objectCounts = {};
    for (const t of bp.objectTypes) objectCounts[t.name] = (data[t.name] ?? []).length;
    return {
      id: bp.id,
      name: bp.name,
      description: bp.description,
      objectTypes: bp.objectTypes,
      linkTypes: bp.linkTypes.map((lt) =>
        typeof lt === 'string' ? { name: lt } : lt,
      ),
      actionDefs: bp.actionDefs.map((ad) =>
        typeof ad === 'string' ? { name: ad, label: ad, params: [] } : ad,
      ),
      objectCounts,
    };
  };

  return {
    blueprint: bp,
    find,
    where,
    link,
    action,
    snapshot,
    schema,
  };
}

/**
 * 深拷贝 DataMap（递归拷贝嵌套对象/数组）。
 * 防止 action 写穿嵌套字段（如 sqlQueries、methodIds）到 seed。
 *
 * @param {DataMap} data
 * @returns {DataMap}
 */
function deepSnapshot(data) {
  const out = {};
  for (const key of Object.keys(data)) {
    const val = data[key];
    if (Array.isArray(val)) {
      out[key] = val.map((r) => deepCloneObj(r));
    } else if (val != null) {
      out[key] = deepCloneObj(val);
    }
  }
  return out;
}

/**
 * 递归深拷贝单个对象（支持嵌套对象和数组）。
 * @param {*} obj
 * @returns {*}
 */
function deepCloneObj(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(deepCloneObj);
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = deepCloneObj(v);
  return out;
}

/**
 * 辅助：根据对象 id 前缀查找对象类型名（蓝图 UI 自动推断类型用）。
 * 借鉴 aos 的 findObjectById 思路，但走 byId Map 索引。
 *
 * @param {Map<string, AnyObj>} byId
 * @param {ObjectTypeDef[]} objectTypes
 * @param {string} objectId
 * @returns {{obj: AnyObj, typeName: string}|null}
 */
export function findObjectByPrefix(byId, objectTypes, objectId) {
  const obj = byId.get(objectId);
  if (!obj) return null;
  // 按 objectTypes 的 prefix 字段匹配 id 前缀
  for (const t of objectTypes) {
    const prefix = t.prefix || prefixOf(t);
    if (prefix && objectId.startsWith(prefix)) {
      return { obj, typeName: t.name };
    }
  }
  return { obj, typeName: 'Unknown' };
}

/**
 * 辅助：根据对象类型定义推断其 id 前缀（用于自动渲染 / 蓝图 UI）。
 * 优先取 type 的 prefix 字段（若存在）；无 prefix 时从 name 推断。
 *
 * @param {ObjectTypeDef} type
 * @returns {string}
 */
export function prefixOf(type) {
  if (type.prefix) return type.prefix;
  // fallback：name 小写 + ':'（nice-aos 的 prefix 无统一缩写规则，全名小写更可预测）
  return type.name.toLowerCase() + ':';
}
