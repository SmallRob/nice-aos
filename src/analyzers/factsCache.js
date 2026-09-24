// 跨调用 facts 缓存（v0.47，借鉴 asdm-aos contentHash + manifest 继承思想，作用于 facts 粒度）：
//   asdm-aos 在对象层做内容寻址（sha256 稳定序列化 + manifest 继承未变对象）；
//   nice-aos 的构建是"facts → 相位推导对象"的单管线内存构建，对象层继承会破坏跨文件相位
//   （renders / 路由聚合依赖全量 facts），因此把同一思想下沉到 facts 层：
//   未变文件（内容哈希一致）的解析结果直接复用，跳过昂贵的逐文件 parse（TS Compiler API /
//   状态机解析），后续相位照常全量运行 —— 正确性等价（facts 是文件内容的纯函数），
//   收益 = 全部解析成本中未变文件所占比例。
//
// 缓存形态：<dataDir>/facts-cache.json
//   { version, projectRoot, savedAt, entries: { [relPath]: { h: hash16, f: <序列化 facts> } } }
// 失效条件（任一命中即整体弃用，退回全量解析）：version 不匹配 / projectRoot 不匹配 / JSON 损坏。
// 剥离字段：imports[].resolved 不落盘（import 解析循环每次构建重跑，避免 tsconfig/文件集
//   变化后拿到陈旧解析结果 —— 解析循环本身远快于逐文件 parse）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 版本号：analyzer 行为变更（字段增删/语义变化）时 +1，旧缓存整体失效
export const FACTS_CACHE_VERSION = 1;

export function computeContentHash16(text) {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 16);
}

// 序列化：
//   - Set / Map 显式编码（__t 标记，reviver 还原）
//   - 键黑名单：'resolved'（import 解析每次构建重跑）、'node' / 'statementNode'
//     （tsAnalyzer 嵌入的 AST 节点引用——循环结构无法 JSON 化，且下游只消费普通字段）
//   - 类实例泛化丢弃：constructor 非 Object/Array/Map/Set/Date 的值（TS Compiler NodeObject 等）
//     一律不落盘 —— 缓存命中路径与全量路径对这些字段的存在性差异不影响任何下游消费者
const DROP_KEYS = new Set(['resolved', 'node', 'statementNode']);
const PLAIN_CTORS = new Set(['Object', 'Array', 'Map', 'Set', 'Date']);
function replacer(key, value) {
  if (DROP_KEYS.has(key)) return undefined;
  if (value !== null && typeof value === 'object') {
    if (value instanceof Map) return { __t: 'map', v: [...value.entries()] };
    if (value instanceof Set) return { __t: 'set', v: [...value] };
    if (!PLAIN_CTORS.has(value.constructor?.name)) return undefined;
  }
  return value;
}

function reviver(key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.__t === 'map') return new Map(value.v);
    if (value.__t === 'set') return new Set(value.v);
  }
  return value;
}

export function serializeFacts(facts) {
  return JSON.stringify(facts, replacer);
}

export function deserializeFacts(json) {
  return JSON.parse(json, reviver);
}

/**
 * 加载缓存。返回 Map<relPath, { h, facts }>；缺失/损坏/版本或项目根不匹配返回 null（全量回退）。
 */
export function loadFactsCache(cachePath, projectRoot) {
  try {
    if (!fs.existsSync(cachePath)) return null;
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    if (!raw || typeof raw !== 'object') return null;
    if (raw.version !== FACTS_CACHE_VERSION) return null;
    if (raw.projectRoot !== path.resolve(projectRoot)) return null;
    const entries = new Map();
    for (const [relPath, entry] of Object.entries(raw.entries ?? {})) {
      if (!entry || typeof entry.h !== 'string' || typeof entry.f !== 'string') continue;
      entries.set(relPath, { h: entry.h, facts: deserializeFacts(entry.f) });
    }
    return entries;
  } catch {
    return null;
  }
}

/**
 * 原子写缓存（tmp + rename）。entries: Map<relPath, { h, facts }>；失败仅返回 false 不抛出。
 */
export function saveFactsCache(cachePath, projectRoot, entries) {
  try {
    const payload = {
      version: FACTS_CACHE_VERSION,
      projectRoot: path.resolve(projectRoot),
      savedAt: new Date().toISOString(),
      entries: Object.fromEntries([...entries].map(([relPath, e]) => [relPath, { h: e.h, f: serializeFacts(e.facts) }])),
    };
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
    fs.renameSync(tmp, cachePath);
    return true;
  } catch (err) {
    // 缓存写入失败不阻断构建（下次退回全量解析）
    console.error(`⚠ facts 缓存写入失败（已忽略，继续全量）: ${err?.message ?? err}`);
    return false;
  }
}
