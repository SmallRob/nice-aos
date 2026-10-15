// ontology converter 钩子层（v0.51.0）：
// 借鉴 asdm-aos-server 的 GraphConverter 抽象（src/modules/graph/converter/aos-gitnexus/index.ts）。
// 把 linkType 通用遍历的"领域特定语义"收敛到 3 个钩子里：
//   - resolveLink(linkType)  — 解析 linkType（含反向别名）→ 遍历方向
//   - expandLinked(ctx)      — 遍历后处理（如接口多态展开；当前为空实现）
//   - linkVocabulary()        — 返回正向 + 反向 linkType 词汇清单
//
// 当前 default impl (niceAosConverter) 直接复用 linkDefs 的派生数据：
//   resolveLink 通过 FORWARD_OF 反查
//   expandLinked 在 nice-aos 当前没有"多态展开"需求，恒返回 []
//   linkVocabulary 从 linkDefs.LINK_TYPE_PAIRS 派生
//
// 与 v0.50.0 linkDefs 的关系：
//   linkDefs 是"声明"层（数据形态、sourcePrefixes、description 等）
//   converter 是"语义"层（遍历方向、遍历后处理、词汇暴露）
//   linkDefs 是 converter 的下层数据源；converter 是 service/registry 的下层协议
//
// 保持零依赖（与现有 v0.48.0 与 v0.50.0 决策一致）：
//   - registerConverter 接口留作未来扩展（asdm 的多 converter 并存场景）
//   - 当前默认实现单例：registerConverter 不覆盖默认（按约定 optIn）
//   - 任何 hook 都是纯函数，无副作用、无 IO

import {
  LINK_DEF_BY_NAME,
  REVERSE_OF,
  FORWARD_OF,
  LINK_TYPE_PAIRS,
  REVERSE_LINK_TYPES,
} from './linkDefs.js';

/**
 * @typedef {Object} LinkDirection
 * @property {string} base  — 物化的正向 linkType
 * @property {'in'|'out'} direction — 反向时为 'in'，正向为 'out'
 *
 * @typedef {Object} ExpandContext
 * @property {object} index — {byId, out, inn} 双向链接索引（可由调用方构造）
 * @property {string} srcId — 源对象 id
 * @property {object} srcEntity — 源对象
 * @property {string} base — 物化的正向 linkType
 * @property {'in'|'out'} direction
 * @property {object[]} direct — 直接遍历得到的目标实体（按 direction 解析后）
 *
 * @typedef {Object} LinkVocabulary
 * @property {Record<string, string>} linkTypePairs — 正向 → 反向 映射（如 renders → renderedBy）
 * @property {string[]} reverseLinkTypes — 反向 linkType name 数组（独立列出）
 *
 * @typedef {Object} OntologyConverter
 * @property {(linkType: string) => (LinkDirection | null)} resolveLink
 * @property {(ctx: ExpandContext) => object[]} expandLinked
 * @property {() => LinkVocabulary} linkVocabulary
 */

/**
 * 默认 converter 实现（niceAosConverter）：基于 linkDefs 派生
 * resolveLink/expandLinked/linkVocabulary 三钩子的语义镜像。
 */
export const niceAosConverter = {
  /**
   * 把 linkType（含反向别名）解析为 base + direction。
   * - 'renders' → {base: 'renders', direction: 'out'}
   * - 'renderedBy' → {base: 'renders', direction: 'in'}（反向访问正向 impl）
   * - 'unknown' → null（让调用方走"未知 linkType"错误路径）
   *
   * 设计要点：nice-aos 的 linkImpls 是双向同时存在的（renderedBy 是独立函数，不是渲染器推），
   * 但 ontology 视角下"反向遍历"语义上等同调用正向 impl + direction=in。
   * 这样 converter 让 traverse_links / linkWithMeta2 不需要硬编码反向映射表。
   */
  resolveLink(linkType) {
    if (!linkType) return null;
    // 反向 linkType 反查
    const forwardFromReverse = FORWARD_OF[linkType];
    if (forwardFromReverse) {
      return { base: forwardFromReverse, direction: 'in' };
    }
    // 正向 linkType 直接返回
    if (LINK_DEF_BY_NAME[linkType]) {
      return { base: linkType, direction: 'out' };
    }
    return null;
  },

  /**
   * 遍历后处理钩子。当前默认实现：返回空 extras。
   *
   * 借鉴 asdm-aos 的 expandLinked 钩子语义："calls 命中接口方法 → 追加实现类方法"
   * nice-aos 当前没有这个需求（linkImpls 直接跑数据），但保留接口为未来多态扩展留位。
   *
   * @param {ExpandContext} ctx
   * @returns {object[]} 需追加到 traverse 目标的实体数组
   */
  expandLinked(_ctx) {
    return [];
  },

  /**
   * 暴露 linkVocabulary：返回成对的 linkTypePairs（正向 → 反向映射）+ reverseLinkTypes 列表。
   * 直接复用 linkDefs.LINK_TYPE_PAIRS / REVERSE_LINK_TYPES 派生。
   *
   * @returns {LinkVocabulary}
   */
  linkVocabulary() {
    return {
      linkTypePairs: { ...LINK_TYPE_PAIRS },
      reverseLinkTypes: [...new Set(REVERSE_LINK_TYPES)],
    };
  },
};

// ============================================================
// 注册表（接口式 API，未来扩展；当前默认 singleton）
// ============================================================

/** 当前活跃 converter 实例 */
let _activeConverter = niceAosConverter;

/**
 * 取当前活跃 converter（默认 niceAosConverter）。
 * @returns {OntologyConverter}
 */
export function getConverter() {
  return _activeConverter;
}

/**
 * 注册自定义 converter（替换默认）。
 * 借鉴 asdm-aos 的 registry.ts registerConverter(converter, opts)。
 *
 * 当前约束（保持零复杂）：
 *   - opts.default = true（默认 false）才替换 _activeConverter
 *   - 单一 instance 同时只有一个活跃
 *   - 多 converter 并存市场场景留 v0.52+ 评估（如果出现真实需求）
 *
 * @param {OntologyConverter} converter
 * @param {{default?: boolean}} [opts]
 */
export function registerConverter(converter, opts = {}) {
  if (!converter || typeof converter !== 'object') {
    throw new Error('registerConverter: 必须传入 converter 对象');
  }
  for (const hook of ['resolveLink', 'expandLinked', 'linkVocabulary']) {
    if (typeof converter[hook] !== 'function') {
      throw new Error(`registerConverter: converter 缺少 ${hook}() 钩子`);
    }
  }
  if (opts.default === true) {
    _activeConverter = converter;
  }
}

/**
 * 测试用：清空注册表，恢复默认 converter。
 * 模块加载时 active = niceAosConverter；该函数仅用于 registerConverter 的回归测试。
 */
export function __resetConverterForTest() {
  _activeConverter = niceAosConverter;
}
