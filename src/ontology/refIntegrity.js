// 引用完整性审计与清理（v0.47，借鉴 asdm-aos pending-refs + validate 的"数据即真相"思想）：
//   构建期各相位生成的 id 引用字段（*Id / *Ids）可能指向因解析失败 / 合并改名 / 路由
//   后建而缺失的对象。asdm-aos 用 pending_refs 表挂起、目标后到时补全（流式乱序构图）；
//   nice-aos 单管线内存构建无乱序问题，采用"组装末尾统一校验"的最小版本：
//     全局 id 索引一次建立 → 批量存在性判定 → 悬空引用摘除 + 样本上报（_meta.refIntegrity）
//   保证 query / link / viewer 拿到的引用边全部可解析（宁摘除不悬挂，与 aos"歧义即不连"同哲学）。
//
// 豁免字段（值不是对象 id 引用）：
//   overlayId        —— Route 的展示名（route path / go-cli 命令串），非对象 id
//   opensOverlayIds  —— SourceFile 的 overlay 目标原始清单（未过滤的声明，非解析结果）

const REF_ARRAY_KEY_RE = /Ids$/;
const REF_KEY_RE = /Id$/;
const SKIP_KEYS = new Set(['overlayId', 'opensOverlayIds', 'id']);

/**
 * 就地审计并清理 dataMap 中的悬空 id 引用。
 * @param {Object} dataMap 含 _meta 的完整 dataMap（_meta 不参与审计）
 * @returns {{ checkedObjects: number, danglingCount: number, samples: {type,id,field,value}[] }}
 */
export function auditRefIntegrity(dataMap) {
  // 1. 全局 id 索引（一次建立，O(total)）
  const idSet = new Set();
  for (const [type, arr] of Object.entries(dataMap)) {
    if (type === '_meta' || !Array.isArray(arr)) continue;
    for (const o of arr) if (o && typeof o.id === 'string') idSet.add(o.id);
  }

  // 2. 批量存在性判定 + 摘除
  let checkedObjects = 0;
  let danglingCount = 0;
  const samples = [];
  const record = (type, id, field, value) => {
    danglingCount += 1;
    if (samples.length < 20) samples.push({ type, id, field, value });
  };

  for (const [type, arr] of Object.entries(dataMap)) {
    if (type === '_meta' || !Array.isArray(arr)) continue;
    for (const obj of arr) {
      if (!obj || typeof obj !== 'object') continue;
      checkedObjects += 1;
      for (const [k, v] of Object.entries(obj)) {
        if (SKIP_KEYS.has(k)) continue;
        if (REF_ARRAY_KEY_RE.test(k) && Array.isArray(v)) {
          const removed = [];
          const kept = v.filter((x) => {
            const dangling = typeof x === 'string' && x && !idSet.has(x);
            if (dangling) removed.push(x);
            return !dangling;
          });
          if (removed.length > 0) {
            for (const r of removed) record(type, obj.id, k, r);
            obj[k] = kept;
          }
        } else if (REF_KEY_RE.test(k) && typeof v === 'string' && v && !idSet.has(v)) {
          record(type, obj.id, k, v);
          obj[k] = null;
        } else if (k === 'frontendCalls' && Array.isArray(v)) {
          for (const e of v) {
            if (e && typeof e.fileId === 'string' && e.fileId && !idSet.has(e.fileId)) {
              record(type, obj.id, 'frontendCalls[].fileId', e.fileId);
              e.fileId = null;
            }
          }
        }
      }
    }
  }
  return { checkedObjects, danglingCount, samples };
}
