// IO 扫描器：对方法源码做静态扫描，找出所有敏感 API 调用。
// 借鉴 code-graph-rag 的 IO_SINKS 数据驱动表（src/ontology/ioRegistry.js）。
// 阶段 2.1 范围：JS/TS 静态扫描 + 油猴 GM API（不做 Rust/Go/Java 跨语言 taint）。
//
// 输出格式：每方法返回 IOUsage[]：
//   { sink, callText, argsText, line, danger }
//
// 不做 taint propagation：v0.32.0 范围限定为"调用点报告"。
// 后续 v0.33.0 扩展：FLOWS_TO 三 kind taint walk。

import { scanSource, extractDeclaredLocals, getSink, RESOURCE_KINDS, DANGER_LEVELS } from '../ontology/ioRegistry.js';

/**
 * 扫描单个方法源码的 IO 使用。
 * @param {string} source 方法体源码
 * @returns {Array<{ sink, callText, argsText, line, danger }>}
 */
export function scanMethodIO(source) {
  if (!source) return [];
  const locals = extractDeclaredLocals(source);
  return scanSource(source, locals);
}

/**
 * 扫描整个快照的 IO 使用（按方法聚合）。
 * 输出：方法 ID → IOUsage[]
 *
 * @param {Object} snap  本体快照
 * @param {Object} [opts]
 *   - minDanger: 最低危险等级（默认 'low' 含全部；'medium' 起过滤 LOW/INFO）
 *   - kinds: ResourceKind[] 只看这些 kind（默认全）
 * @returns {{
 *   byMethod: Map<string, Array<{ sink, callText, argsText, line, danger }>>,
 *   summary: { totalMethods, methodsWithIO, totalIO, byDanger, byKind },
 * }}
 */
// scanSnapshotIO 的早期 stub 实现已移除：snapshot 不带 fileContent，
// 高级 API 必须由调用方提供 fileContent cache，见下方 scanSnapshotIOWithContent。

const DANGER_LEVELS_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/**
 * 高级 API：扫描整个快照，调用方传 fileContent cache。
 * @param {Object} snap
 * @param {Map<string,string>} fileContentCache relPath -> file content
 * @param {Object} [opts]
 * @returns {{
 *   byMethod: Map<string, Array>,
 *   summary: { totalMethodsScanned, methodsWithIO, totalIO, byDanger, byKind },
 * }}
 */
export function scanSnapshotIOWithContent(snap, fileContentCache, opts = {}) {
  const { minDanger = 'low', kinds = null } = opts;
  const minRank = DANGER_LEVELS_RANK[minDanger] ?? 0;

  const byMethod = new Map();
  let methodsWithIO = 0;
  let totalIO = 0;
  const byDanger = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const byKind = { STORAGE: 0, NETWORK: 0, DOM: 0, STDOUT: 0, SCRIPT: 0 };
  let totalMethodsScanned = 0;

  for (const m of snap.Method ?? []) {
    if (m.pos == null || m.end == null) continue;
    if (m.end - m.pos < 30) continue;
    if (!m.filePath) continue;
    const content = fileContentCache.get(m.filePath);
    if (!content) continue;
    const source = content.slice(m.pos, m.end);
    const hits = scanMethodIO(source);

    const filtered = kinds
      ? hits.filter((h) => kinds.includes(h.sink.kind))
      : hits;
    const dangerFiltered = filtered.filter((h) => DANGER_LEVELS_RANK[h.sink.danger] >= minRank);

    if (dangerFiltered.length) {
      byMethod.set(m.id, dangerFiltered);
      methodsWithIO += 1;
      totalIO += dangerFiltered.length;
      for (const h of dangerFiltered) {
        byDanger[h.sink.danger] = (byDanger[h.sink.danger] || 0) + 1;
        byKind[h.sink.kind] = (byKind[h.sink.kind] || 0) + 1;
      }
    }
    totalMethodsScanned += 1;
  }

  return {
    byMethod,
    summary: { totalMethodsScanned, methodsWithIO, totalIO, byDanger, byKind },
  };
}
