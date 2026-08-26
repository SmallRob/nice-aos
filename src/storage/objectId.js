// 业务 id（"file:src/index.js" / "mod:src"）拆解为 { type, id }
// 用途：action markReviewed/addNote 时定位 aos_overlays 写入位置
// 规则：从 blueprint.js OBJECT_TYPES 取 prefix；若 id 不匹配任何 prefix 则抛错（避免污染 aos_overlays）

import { OBJECT_TYPES } from '../ontology/blueprint.js';

const PREFIX_BY_TYPE = new Map(OBJECT_TYPES.map((t) => [t.prefix, t.type]));

export function parseObjectId(objectId) {
  if (!objectId || typeof objectId !== 'string') {
    throw new Error(`无效 objectId: ${objectId}`);
  }
  // 找最长匹配的 prefix（如 'mod:src/components' 应匹配 mod:，而不是 m:）
  let bestPrefix = null;
  let bestType = null;
  for (const [prefix, type] of PREFIX_BY_TYPE) {
    if (objectId.startsWith(prefix) && (bestPrefix === null || prefix.length > bestPrefix.length)) {
      bestPrefix = prefix;
      bestType = type;
    }
  }
  if (!bestPrefix) {
    throw new Error(`无法识别 objectId 前缀: ${objectId}（已知 prefix: ${Array.from(PREFIX_BY_TYPE.keys()).join(', ')}）`);
  }
  return { type: bestType, id: objectId };
}
