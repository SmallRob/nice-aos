// 增量解析器：缓存式增量解析（无 tree-sitter）。
// 借鉴 asdm-aos v0.0.12 IncrementalParser 设计（src/server/analyzers/shared/incrementalParser.ts:40-200）：
//   - 结果缓存（FIFO 容量淘汰简化实现，非严格 LRU）：Map<filePath, {code, result}>
//   - parse(filePath, code)：
//     1) 缓存未命中 → 全量重算
//     2) 缓存命中且 code 未变 → 复用旧 result
//     3) code 变更 → 重新分析 + 更新缓存
//   - 配套 invalidate / clear / hasCache 辅助
//
// nice-aos 适配点：
//   - 不引入 tree-sitter（0.30.0 ADR 已决议）；用现有 "正则+手工解析" 为底层
//   - 提供 cachedAnalyze(parser, filePath, code) 包装函数，零侵入集成到 analyzer
//   - parse 函数支持自定义 keyExtractor（如 nice-aos 的 #env 路径规范化）
//   - 提供 git diff 工具函数：listChangedFiles(repoRoot, since) → string[]

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * 增量解析器：通用结果缓存包装。
 * 淘汰策略为 FIFO 简化实现（ADR 允许"不严格 LRU"，命中不更新位置）；见 ensureCacheSpace 注释。
 * 不依赖 tree-sitter；不修改被缓存的 analyzer 实现，仅做"按 filePath 缓存 result"。
 *
 * @template T 解析结果类型
 */
export class IncrementalParser {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxCacheSize=1000] 缓存容量上限（超限按插入序 FIFO 淘汰）
   * @param {(filePath: string) => string} [opts.keyExtractor] 自定义缓存键（默认 filePath 本身）
   * @param {boolean} [opts.debug=false] 调试模式
   */
  constructor(opts = {}) {
    /** @type {Map<string, {code: string, result: T, updatedAt: number}>} */
    this.cache = new Map();
    this.maxCacheSize = opts.maxCacheSize ?? 1000;
    this.keyExtractor = opts.keyExtractor ?? ((p) => p);
    this.debug = opts.debug ?? false;
    /** @type {{hit: number, miss: number, invalidated: number}} */
    this.stats = { hit: 0, miss: 0, invalidated: 0 };
  }

  /**
   * 解析文件。
   *
   * @param {string} filePath 文件相对路径（缓存键）
   * @param {string} code 文件代码内容
   * @param {(filePath: string, code: string) => T} analyzer 实际解析器
   * @returns {T} 解析结果
   */
  parse(filePath, code, analyzer) {
    const key = this.keyExtractor(filePath);
    const cached = this.cache.get(key);

    // 缓存命中且 code 未变：复用旧 result
    if (cached && cached.code === code) {
      this.stats.hit += 1;
      return cached.result;
    }

    // 缓存未命中 / code 变更：全量重算
    this.stats.miss += 1;
    if (cached) this.stats.invalidated += 1;
    const result = analyzer(filePath, code);
    this.ensureCacheSpace();
    this.cache.set(key, { code, result, updatedAt: Date.now() });
    return result;
  }

  /**
   * 使文件缓存失效。
   * @param {string} filePath
   */
  invalidate(filePath) {
    const key = this.keyExtractor(filePath);
    if (this.cache.delete(key)) this.stats.invalidated += 1;
  }

  /**
   * 清除所有缓存。
   */
  clear() {
    const size = this.cache.size;
    this.cache.clear();
    this.stats.invalidated += size;
  }

  /**
   * 检查文件是否已缓存。
   * @param {string} filePath
   * @returns {boolean}
   */
  hasCache(filePath) {
    return this.cache.has(this.keyExtractor(filePath));
  }

  /**
   * 获取已缓存的文件数。
   * @returns {number}
   */
  size() {
    return this.cache.size;
  }

  /**
   * 读取统计信息。
   * @returns {{size: number, hit: number, miss: number, invalidated: number, hitRate: number}}
   */
  getStats() {
    const total = this.stats.hit + this.stats.miss;
    return {
      size: this.cache.size,
      hit: this.stats.hit,
      miss: this.stats.miss,
      invalidated: this.stats.invalidated,
      hitRate: total > 0 ? this.stats.hit / total : 0,
    };
  }

  /**
   * FIFO 淘汰：超过容量时删除最早插入的项。
   * Map 保留插入顺序；缓存命中时不更新位置（简化实现，ADR 允许"不严格 LRU"）。
   */
  ensureCacheSpace() {
    while (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey === undefined) break;
      this.cache.delete(firstKey);
    }
  }
}

/**
 * 单例缓存解析器（按 analyzer 类型隔离）。
 * @type {Map<string, IncrementalParser>}
 */
const _parsers = new Map();

/**
 * 获取或创建某个 analyzer 类型的单例缓存器。
 *
 * @param {string} analyzerName analyzer 名称（如 'ts' / 'vue' / 'dart'）
 * @param {object} [opts]
 * @returns {IncrementalParser}
 */
export function getParser(analyzerName, opts = {}) {
  if (!_parsers.has(analyzerName)) {
    _parsers.set(analyzerName, new IncrementalParser(opts));
  }
  return _parsers.get(analyzerName);
}

/**
 * 重置所有单例缓存（测试用）。
 */
export function resetAllParsers() {
  for (const p of _parsers.values()) p.clear();
  _parsers.clear();
}

/**
 * 包装单个 analyzer 为缓存版本。
 *
 * @param {string} analyzerName
 * @param {(filePath: string, code: string) => any} analyzer
 * @param {object} [opts]
 * @returns {(filePath: string, code: string) => any}
 */
export function cachedAnalyze(analyzerName, analyzer, opts = {}) {
  const parser = getParser(analyzerName, opts);
  return (filePath, code) => parser.parse(filePath, code, analyzer);
}

/**
 * nice-aos 文件路径的缓存键抽取器。
 * nice-aos 的 SOURCE_EXTENSIONS 走 #env 规范化（.env.* 文件），需要保留此标记。
 * @param {string} filePath
 * @returns {string}
 */
export function niceAosKeyExtractor(filePath) {
  // 保留 nice-aos 的 #env 标记（用于还原真实 .env.* 文件名）
  return filePath;
}

// =============================================================================
// Git 集成：列出自 since 以来变动的文件清单
// =============================================================================

/**
 * 通过 git diff 列出自 since 以来变动的文件清单。
 *
 * @param {string} repoRoot 仓库根
 * @param {string} [since] git ref（如 'HEAD~1' / commit hash）；省略则对比 HEAD
 * @param {object} [opts]
 * @param {string[]} [opts.roots] 限制扫描的子目录（默认全仓）
 * @param {string} [opts.gitBin='git'] git 可执行路径
 * @returns {string[]} 相对路径数组
 */
export function listChangedFiles(repoRoot, since, opts = {}) {
  const gitBin = opts.gitBin ?? 'git';
  const args = ['diff', '--name-only'];
  if (since) args.push(since);
  else args.push('HEAD');
  if (opts.roots && opts.roots.length > 0) args.push('--', ...opts.roots);

  let out;
  try {
    out = execFileSync(gitBin, args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    // 非 git 仓库 / git 不可达 → 返回空数组（调用方按全量处理）
    return [];
  }
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 列出 staged 但未提交的文件（增量开发场景）。
 *
 * @param {string} repoRoot
 * @param {object} [opts]
 * @returns {string[]}
 */
export function listStagedFiles(repoRoot, opts = {}) {
  const gitBin = opts.gitBin ?? 'git';
  let out;
  try {
    out = execFileSync(gitBin, ['diff', '--cached', '--name-only'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * 列出工作区未追踪的文件（untracked）。
 *
 * @param {string} repoRoot
 * @param {object} [opts]
 * @returns {string[]}
 */
export function listUntrackedFiles(repoRoot, opts = {}) {
  const gitBin = opts.gitBin ?? 'git';
  let out;
  try {
    out = execFileSync(gitBin, ['ls-files', '--others', '--exclude-standard'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

// =============================================================================
// 高层 API：合并旧 snapshot + 增量分析结果
// =============================================================================

/**
 * 合并旧 snapshot 与增量分析结果（by-id 替换策略）。
 *
 * 策略：
 *   1. 旧 snapshot 中"出现在 changedFiles"的 type 数组 → 全部移除
 *   2. 新分析结果（覆盖 changedFiles）→ 追加到 snapshot
 *   3. 其他对象（没变更的）→ 保留
 *
 * 注意：跨 type 的引用（如 Component 引用 Module）由 builder 在 buildSingleFile* 中处理；
 * 此处只做"按 filePath 局部替换"。
 *
 * @param {Object} oldSnapshot 旧 DataMap
 * @param {string[]} changedFiles 变更文件清单（relPath）
 * @param {Object} newFileAnalyses { [filePath: string]: PartialDataMap } 每文件的部分 DataMap
 * @param {Object} [opts]
 * @param {(filePath: string) => string[]} [opts.typesForFile] 推断文件涉及的对象类型（默认常见类型）
 * @returns {Object} 合并后的 DataMap
 */
export function mergeSnapshotByFiles(oldSnapshot, changedFiles, newFileAnalyses, opts = {}) {
  const typesForFile = opts.typesForFile ?? defaultTypesForFile;
  const changedSet = new Set(changedFiles);

  // 1. 复制旧 snapshot
  const merged = {};
  for (const [k, v] of Object.entries(oldSnapshot)) {
    merged[k] = Array.isArray(v) ? v.slice() : v;
  }

  // 2. 收集要删除的旧对象（出现在 changedFiles 中的所有对象，按多种路径字段匹配）
  const PATH_FIELDS = ['filePath', 'path', 'relPath', 'sourceFile', 'file', 'source'];
  const removedIds = new Set();
  for (const type of Object.keys(merged)) {
    if (!Array.isArray(merged[type])) continue;
    const before = merged[type].length;
    merged[type] = merged[type].filter((obj) => {
      const objFile = PATH_FIELDS.reduce((found, f) => found || obj[f], null);
      if (objFile && changedSet.has(objFile)) {
        if (obj.id) removedIds.add(obj.id);
        return false;
      }
      return true;
    });
    const after = merged[type].length;
    if (before !== after) {
      // 静默跳过；调用方可统计
    }
  }

  // 3. 合并新分析结果
  for (const [filePath, partialMap] of Object.entries(newFileAnalyses)) {
    if (!partialMap || typeof partialMap !== 'object') continue;
    for (const [type, arr] of Object.entries(partialMap)) {
      if (!Array.isArray(arr) || arr.length === 0) continue;
      if (!merged[type]) merged[type] = [];
      // 按 id 去重（防止跨文件重复对象）
      const existingIds = new Set(merged[type].map((o) => o.id));
      for (const obj of arr) {
        if (obj.id && !existingIds.has(obj.id)) {
          merged[type].push(obj);
          existingIds.add(obj.id);
        }
      }
    }
  }

  return merged;
}

/**
 * 默认文件 → 对象类型映射（基于 nice-aos 的 OBJECT_TYPES 与项目惯例）。
 * 推断不出来的文件 → 返回空数组（调用方按 ALL_TYPES 兜底）。
 *
 * @param {string} filePath
 * @returns {string[]} 该文件可能涉及的对象类型
 */
export function defaultTypesForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const base = filePath.split('/').pop() || '';
  const out = ['SourceFile']; // 所有文件都有 SourceFile

  // .ts/.tsx/.js/.jsx/.vue/.svelte/.rs/.dart/.go/.py
  if (['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte', '.rs', '.dart', '.go', '.py'].includes(ext)) {
    out.push('Module', 'Component', 'Hook', 'Store', 'Service', 'Interface', 'Class', 'Method', 'PropEdge', 'ScriptFunction');
  }
  // 油猴脚本
  if (base.endsWith('.user.js')) {
    out.push('UserScript', 'ScriptFunction', 'GmApiUsage', 'InjectionPoint', 'NetworkEndpoint');
  }
  // v0.41.0: Python 的 outbound HTTP 端点（requests / urllib / httpx / aiohttp → NetworkEndpoint）
  if (ext === '.py') {
    out.push('NetworkEndpoint');
  }
  // 路由
  if (filePath.includes('/routes/') || filePath.includes('/pages/') || filePath.includes('router') || filePath.includes('Route.')) {
    out.push('Route');
  }
  // 依赖
  if (base === 'package.json' || base === 'pubspec.yaml' || base === 'Cargo.toml' || base === 'go.mod') {
    out.push('Dependency');
  }
  return out;
}
