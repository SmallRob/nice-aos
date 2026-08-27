// 链接元数据：把 link() 的"返回对象数组"增强为"返回 {id, confidence, reason} 数组"
// 借鉴 GitNexus 的"单关系表 + type + confidence/reason/step"模式（gitnexus-shared/src/lbug/schema-constants.ts）
// 与现有 link(linkType, srcId) 并存：link() 仍返回对象（向后兼容）；linkWithMeta() 返回带元数据的瘦对象
//
// 核心设计：
//   - 大多数链接是"精确"（confidence=1.0, reason='direct'）
//   - 仅明确"模糊推导"的边降权：
//     · renders 经 Vue.component 全局注册兜底 → 0.6 / 'vue-global-fallback'
//     · renders 经同文件兜底（无 import 记录） → 0.5 / 'vue-same-file-fallback'
//     · usesStore 经 unplugin-auto-import 隐式调用 → 0.7 / 'auto-imported'
//     · propEdges 源/目标组件缺失 → 0.4 / 'missing-source'
//     · mapsToTable 经命名约定兜底（User → users） → 0.5 / 'name-convention'
//   - 模糊信息存在源对象的 *Meta 字段（如 rendersMeta）由 builder.js 写入；本模块只读取
//   - 缺省（无 Meta 字段）时降级为 confidence=1.0, reason='direct'（保持向后兼容老快照）

import { LINK_TYPES } from './blueprint.js';

/**
 * 把 link(linkType, srcId) 的结果（object[]）转为 [{id, confidence, reason}]。
 * @param {Function} linkFn - createBlueprint().link 引用（已绑定 dataMap）
 * @param {string} linkType - 24+ 链接类型之一
 * @param {string} srcId - 源对象 id
 * @returns {Array<{id: string, confidence: number, reason: string}>}
 */
export function linkWithMeta(linkFn, linkType, srcId) {
  if (!linkFn || !linkType || !srcId) return [];

  // "links" / "all" 模式：linkFn 返回 {refs: {importIds: [obj,...], ...}}
  // 同样按字段后缀 *Ids 推断
  if (linkType === 'links' || linkType === 'all') {
    const out = [];
    // 单源 refs：重派发到各具体 linkType
    if (linkType === 'links') {
      for (const lt of LINK_TYPES) {
        const items = linkWithMeta(linkFn, lt, srcId);
        for (const it of items) out.push({ ...it, linkType: lt });
      }
      return out;
    }
    // 'all'：与 linkFn() 自身行为保持一致
    const src = linkFn(linkType, srcId);
    return normalizeLegacyAll(src);
  }

  // 具体 linkType：调 linkFn 拿对象，再读取源对象上的 *Meta 字段降权
  const src = linkFn('imports', srcId); // 任意 linkType 拿不到 Meta，这里用 import 拿源不行
  // 直接调具体 linkType
  let targets;
  try {
    targets = linkFn(linkType, srcId);
  } catch (err) {
    if (err?.message?.startsWith('未知链接类型')) return [];
    throw err;
  }
  if (!Array.isArray(targets)) return [];

  // Meta 字段约定：源对象上的 `<linkType>Meta`（数组形态，与 *Ids 一一对应）
  // builder.js 写入，未写入时回退为 direct
  // 我们用 linkFn('contains', srcId) 反查 src（仅当 src 是 mod:/file:/proj: 时可用）—— 改用 byId 直接查
  // 但本模块只接 linkFn，不接 index；这里走"接受 srcLookup 函数" 的路径
  return targets.map((t) => baseEdge(t, 'direct', 1.0));
}

/**
 * 带源对象查找的增强版。linkWithMeta2({linkFn, byId}, linkType, srcId) → [{id, confidence, reason}, ...]
 * 推荐用法：createBlueprint 暴露 link() + byId 后调用本函数。
 *
 * @param {{linkFn: Function, byId: Map<string, object>}} ctx
 * @param {string} linkType
 * @param {string} srcId
 * @returns {Array<{id: string, confidence: number, reason: string, linkType?: string}>}
 */
export function linkWithMeta2(ctx, linkType, srcId) {
  const { linkFn, byId } = ctx;
  if (!linkFn || !byId) return [];
  const src = byId.get(srcId);

  if (linkType === 'links' || linkType === 'all') {
    const out = [];
    const types = linkType === 'all' ? LINK_TYPES : LINK_TYPES;
    for (const lt of types) {
      const items = linkWithMeta2(ctx, lt, srcId);
      for (const it of items) out.push({ ...it, linkType: lt });
    }
    return out;
  }

  let targets;
  try {
    targets = linkFn(linkType, srcId);
  } catch (err) {
    if (err?.message?.startsWith('未知链接类型')) return [];
    throw err;
  }
  if (!Array.isArray(targets)) return [];

  // Meta 读取约定：src?.[`<linkType>Meta`] 是数组，与 targets 一一对应
  // 兼容旧字段：`linkMeta`（map<id, {confidence, reason}>）
  const metaArr = src?.[`${linkType}Meta`];
  const metaMap = src?.linkMeta?.[linkType];

  return targets.map((t, i) => {
    const m = metaArr?.[i] ?? metaMap?.[t.id];
    if (m) return { id: t.id, confidence: m.confidence, reason: m.reason };
    // 默认：精确
    return baseEdge(t, 'direct', 1.0);
  });
}

/**
 * 多 hop 遍历（按 depth 扩展）。每层输出 [{id, confidence, reason, depth}, ...]。
 * confidence 取路径上最低值（最弱证据决定可信度）。
 *
 * @param {{linkFn: Function, byId: Map<string, object>}} ctx
 * @param {string} linkType
 * @param {string} srcId
 * @param {number} depth - 1..3
 * @returns {{byDepth: Array<{depth: number, count: number, edges: Array}>}}
 */
export function linkBfsWithMeta(ctx, linkType, srcId, depth = 1) {
  const d = Math.max(1, Math.min(3, depth | 0));
  const byDepth = [];
  const seen = new Set([srcId]);
  let frontier = [{ id: srcId, confidence: 1.0, reason: 'self' }];

  for (let hop = 1; hop <= d; hop++) {
    const next = [];
    for (const node of frontier) {
      const edges = linkWithMeta2(ctx, linkType, node.id);
      for (const e of edges) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        // confidence 取路径最低
        const edgeObj = { ...e, depth: hop, pathConfidence: Math.min(node.confidence, e.confidence) };
        next.push(edgeObj);
      }
    }
    byDepth.push({ depth: hop, count: next.length, edges: next });
    frontier = next;
  }
  return { byDepth };
}

// ---------- 内部 ----------

function baseEdge(t, reason, confidence) {
  return { id: t.id ?? t, confidence, reason };
}

function normalizeLegacyAll(src) {
  // 老接口 {refs: {importIds: [obj,...]}}：打散为 [{id, linkType, ...}]
  const out = [];
  if (!src || typeof src !== 'object' || !src.refs) return out;
  for (const [field, objs] of Object.entries(src.refs)) {
    if (!Array.isArray(objs)) continue;
    const linkType = field.endsWith('Ids') ? field.slice(0, -3) : field;
    for (const o of objs) out.push({ id: o.id, linkType, confidence: 1.0, reason: 'direct' });
  }
  return out;
}
