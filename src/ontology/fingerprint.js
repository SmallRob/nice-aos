// AST fingerprint：把任意函数体规范化为"shape hash"，用于跨函数 / 跨文件去重。
// 借鉴 code-graph-rag 的去标识符 + 去字面量 + 去注释 → SHA 哈希 算法（docs/guide/duplicates.md）：
//   - 删注释（// + /* */）
//   - 替换字符串字面量为 STR
//   - 替换数字字面量为 NUM
//   - 替换正则字面量为 REGEX
//   - 替换标识符为 □（保留关键字、this、super、true/false/null/undefined）
//   - 规范化空白
//   - SHA-256 哈希
//
// 阶段 1.3（v0.32.0）范围：整树 fingerprint（fast, O(n) 分组）。
// 阶段 2（v0.33.0）扩展：分支 fingerprint（用于检测"修改过的副本"，AST-based，需要 parser 介入）。
//
// 关键设计权衡：
//   - text-based 而非 AST-based：跨语言统一（TS/JS/Vue/Go/Rust/Python/油猴都能用）
//     缺点：保留 token shape 但不看语法正确性（如 if/else 嵌套层级不显式）
//   - 用 SHA-256 而非 SHA-1：避免碰撞（code-graph-rag 用 md5，碰撞概率更高）
//   - 关键字白名单保留：保留语法"形状"（function/return/if/await 等），是 shape 的一部分
//   - 数字/字符串规范化：避免 "abc" 和 "xyz" 误判
//
// 与 nice-aos 现有架构集成：
//   - 每个 method/fn/interface-method 挂 astFingerprint + astFingerprintNodes 字段
//   - duplicateDetector 用 groupBy(fingerprint) → O(n) 分组 → 列重复
//   - blueprintEngine 不变（fingerprint 字段在 method 上，引擎不感知）

import crypto from 'node:crypto';

// JS/TS 关键字 + 字面量 + 保留字（保留作为 shape 的一部分）
const RESERVED_TOKENS = new Set([
  // 关键字
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'finally',
  'for', 'function', 'if', 'import', 'in', 'instanceof', 'new',
  'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield',
  'async', 'await', 'let', 'static', 'from', 'as',
  // 字面量
  'true', 'false', 'null', 'undefined',
  // TypeScript 特有
  'interface', 'type', 'enum', 'namespace', 'declare', 'abstract',
  'implements', 'private', 'protected', 'public', 'readonly',
  'keyof', 'infer', 'is', 'satisfies',
  'never', 'unknown', 'any', 'void',
]);

/**
 * 规范化源码为 shape 字符串（去标识符 + 去字面量 + 去注释 + 规范化空白）。
 *
 * @param {string} source 函数体源码（任意语言，但当前为 JS/TS 优化）
 * @returns {string} 规范化后的字符串
 */
export function normalizeSource(source) {
  if (!source || typeof source !== 'string') return '';
  let s = source;

  // 1. 删块注释 /* ... */（非贪婪，避免跨函数污染）
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');

  // 2. 删行注释 // ...（到行尾）
  s = s.replace(/\/\/[^\n]*/g, '');

  // 3. 删模板字符串 `${...}` 内部插值
  s = s.replace(/`\$\{[\s\S]*?\}`/g, 'STR');

  // 4. 删模板字符串字面量（保留 STR 占位）
  s = s.replace(/`(?:\\.|[^`\\])*`/g, 'STR');

  // 5. 删字符串字面量（"..." / '...'）
  s = s.replace(/(["'])(?:\\.|(?!\1).)*\1/g, 'STR');

  // 6. 删正则字面量 /pattern/flags（粗略，可能误判但小概率）
  s = s.replace(/\/((?:\\.|\[[^\]]*\]|[^/\\\n])+)\/[gimsuy]*/g, 'REGEX');

  // 7. 删十六进制 / 二进制 / 八进制字面量
  s = s.replace(/\b0[xX][0-9a-fA-F]+\b/g, 'NUM');
  s = s.replace(/\b0[bB][01]+\b/g, 'NUM');
  s = s.replace(/\b0[oO][0-7]+\b/g, 'NUM');

  // 8. 删数字字面量（含浮点、负号前置、BigInt 后缀）
  s = s.replace(/-?\b\d+\.?\d*(?:[eE][+-]?\d+)?\b/g, 'NUM');
  s = s.replace(/-?\b\d+n\b/g, 'NUM'); // BigInt

  // 9. 替换标识符为 □（保留关键字和保留字 + 已生成的占位符 NUM/STR/REGEX/□/□C）
  const PLACEHOLDERS = new Set(['NUM', 'STR', 'REGEX', '□', '□C']);
  s = s.replace(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g, (m) => {
    if (RESERVED_TOKENS.has(m)) return m;
    if (PLACEHOLDERS.has(m)) return m; // 跳过上一步生成的占位符，避免被误判为标识符
    // JSX/TSX: 标签大写开头可能是组件，保留为 □C 占位符
    if (/^[A-Z]/.test(m)) return '□C';
    return '□';
  });

  // 10. 规范化空白（多个空白 → 单个空格，trim）
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

/**
 * 计算单个函数体的 fingerprint（整树 hash + 节点数）。
 *
 * @param {string} source 函数体源码
 * @returns {{ fingerprint: string, nodes: number, normalized: string }}
 *   fingerprint: SHA-256 hash（hex）
 *   nodes: 规范化后 token 数（粗略行数指标）
 *   normalized: 规范化后的字符串（调试用）
 */
export function computeFingerprint(source) {
  const normalized = normalizeSource(source);
  if (!normalized) {
    return { fingerprint: '', nodes: 0, normalized: '' };
  }
  const fingerprint = crypto
    .createHash('sha256')
    .update(normalized, 'utf8')
    .digest('hex');
  // 节点数：粗略按 token 计数（空格分隔）。用于防碰撞辅助判断（hash 相同 + node count 相同 = 几乎肯定重复）
  const nodes = normalized.split(' ').length;
  return { fingerprint, nodes, normalized };
}

/**
 * 批量计算多个方法/函数的 fingerprint，返回附加字段的对象。
 *
 * @param {Array<{ id: string, source: string }>} items
 * @returns {Map<string, { fingerprint: string, nodes: number }>}
 */
export function computeFingerprints(items) {
  const out = new Map();
  for (const { id, source } of items) {
    if (!id) continue;
    out.set(id, computeFingerprint(source));
  }
  return out;
}

/**
 * 提取函数体源码（从完整文件中）。
 * 简化版本：用花括号匹配（适合 C-style 语言：TS/JS/Java/C++/Go/Rust）。
 * 阶段 1.3 仅支持花括号函数体；Python 缩进函数体留到阶段 2 扩展。
 *
 * @param {string} fullSource 完整文件源码
 * @param {number} startIdx 函数声明起点（function/const/let 关键字处）
 * @returns {string} 函数体（含外层花括号，不含签名）
 */
export function extractFunctionBody(fullSource, startIdx) {
  if (!fullSource || startIdx < 0) return '';
  // 从 startIdx 找第一个 { 开始
  const openIdx = fullSource.indexOf('{', startIdx);
  if (openIdx < 0) return '';
  // 匹配花括号（不考虑字符串内的 {，但简化版本忽略——call site 通常是源码不会写 {{ 在字符串里）
  let depth = 1;
  let i = openIdx + 1;
  while (i < fullSource.length && depth > 0) {
    const c = fullSource[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    i += 1;
  }
  if (depth !== 0) return ''; // 未闭合
  return fullSource.slice(openIdx, i);
}

/**
 * 按 fingerprint 分组（O(n) groupBy）。
 * 借鉴 code-graph-rag 的 "group all functions by fingerprint and see which ones share one" 模式。
 *
 * @param {Map<string, { fingerprint: string, nodes: number }>} fingerprints
 * @param {Array<{ id: string, name: string, filePath: string, startLine: number, endLine: number }>} meta
 *   同一索引序的元数据（按 id 查找）
 * @returns {Array<{
 *   fingerprint: string,
 *   kind: 'exact',
 *   similarity: 1.0,
 *   nodeCount: number,
 *   members: Array<{ id, name, filePath, startLine, endLine }>
 * }>} 重复组（仅返回 ≥ 2 个成员）
 */
export function groupByFingerprint(fingerprints, meta) {
  const metaById = new Map(meta.map((m) => [m.id, m]));
  const groups = new Map(); // fingerprint → members[]

  for (const [id, fp] of fingerprints) {
    if (!fp.fingerprint) continue; // 跳过空函数体
    if (!groups.has(fp.fingerprint)) {
      groups.set(fp.fingerprint, []);
    }
    const m = metaById.get(id);
    if (m) groups.get(fp.fingerprint).push(m);
  }

  const out = [];
  for (const [fp, members] of groups) {
    if (members.length < 2) continue; // 单例不报
    out.push({
      fingerprint: fp,
      kind: 'exact',
      similarity: 1.0,
      nodeCount: fingerprints.get(members[0].id)?.nodes ?? 0,
      members,
    });
  }

  // 按成员数降序，再按 nodeCount 降序
  out.sort((a, b) => {
    if (b.members.length !== a.members.length) return b.members.length - a.members.length;
    return b.nodeCount - a.nodeCount;
  });
  return out;
}
