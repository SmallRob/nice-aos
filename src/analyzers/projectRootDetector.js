// 项目根自动检测：借鉴 asdm-aos v0.0.12 projectDetector.ts
// 允许不传 repoPath 或传文件路径时自动向上查找
//
// 借鉴要点（src/server/analyzers/shared/projectDetector.ts:1-60）：
//   - PROJECT_MARKERS 优先级表（高 → 低）
//   - 从任意路径（文件/目录/空）向上递归
//   - 命中 marker 后返回项目根 + 命中的 marker
//
// nice-aos 扩展：
//   - 多语言 marker（pubspec.yaml / package.json / Cargo.toml / go.mod / pyproject.toml）
//   - Flutter pair 强信号（pubspec.yaml + lib/ 联合判定）
//   - monorepo 多根发现（命中 package.json 时检测 apps/* / packages/* 子包）
//   - 软链处理（realpath 解析）

import fs from 'node:fs';
import path from 'node:path';

/**
 * 项目 marker 优先级表（高 → 低）。
 * 借鉴 aos 的 PROJECT_MARKERS 数组 + 扩展多语言。
 *
 * 元素结构：
 *   { files: [string], description: string, requires?: string[] }
 *   - files: 必须存在的文件名
 *   - requires: 联合判定的其他文件（全部存在才算命中）
 */
export const PROJECT_MARKERS = [
  // Flutter（pair 强信号：pubspec.yaml + lib 联合判定）
  { files: ['pubspec.yaml'], requires: ['lib'], description: 'Flutter/Dart 项目' },
  { files: ['pubspec.yaml'], description: 'Dart 包（无 lib 目录）' },
  // Node.js / npm / pnpm / yarn
  { files: ['package.json'], description: 'Node.js 项目' },
  // Rust
  { files: ['Cargo.toml'], description: 'Rust 项目' },
  // Go
  { files: ['go.mod'], description: 'Go 模块' },
  // Python
  { files: ['pyproject.toml'], description: 'Python 现代项目' },
  { files: ['setup.py'], description: 'Python setup.py' },
  { files: ['requirements.txt'], description: 'Python 依赖文件（弱信号）' },
  // Java（nice-aos 可解析 Java 但非主推）
  { files: ['pom.xml'], description: 'Java Maven' },
  { files: ['build.gradle', 'build.gradle.kts'], description: 'Java Gradle' },
  // 兜底：Git 仓库根
  { files: ['.git'], description: 'Git 仓库根' },
];

/**
 * monorepo 子包目录名（命中这些目录名视为子包根）。
 * 借鉴 npm workspaces 约定。
 */
const MONOREPO_DIRS = ['apps', 'packages', 'modules', 'services', 'libs', 'tools'];

/**
 * 检测项目根。
 *
 * @param {string} [inputPath] 文件路径 / 目录路径 / 空字符串 / undefined
 * @param {object} [opts]
 * @param {string} [opts.cwd] 起始 cwd（inputPath 为空时使用）
 * @param {number} [opts.maxDepth=10] 向上递归最大层数（起始目录计为第 0 层，向上最多再查 maxDepth 层，共 maxDepth+1 次检查。防软链死循环）
 * @param {boolean} [opts.findMonorepo=false] 是否检测 monorepo 子包
 * @returns {{
 *   root: string,        // 命中 marker 的目录（绝对路径）
 *   marker: string,      // 命中的 marker 文件名
 *   description: string, // 命中 marker 的描述
 *   fromPath: string,    // 起始路径
 *   isFile: boolean,     // 起始路径是否为文件
 *   monorepoRoots: string[] | null, // 命中的 monorepo 子包根（仅 findMonorepo=true 时）
 * } | null} 找不到返回 null
 */
export function detectProjectRoot(inputPath, opts = {}) {
  const maxDepth = opts.maxDepth ?? 10;
  const findMonorepo = opts.findMonorepo ?? false;

  // 1. 解析起始路径
  let startPath;
  let isFile = false;
  if (!inputPath) {
    startPath = path.resolve(opts.cwd ?? process.cwd());
  } else {
    startPath = path.resolve(inputPath);
    try {
      const stat = fs.statSync(startPath);
      isFile = stat.isFile();
      if (isFile) startPath = path.dirname(startPath);
    } catch {
      // 路径不存在 / 软链解析失败：尝试逐级向上
      // 不立即返回 null，给 detectUpward 一次机会
    }
  }

  // 2. 软链解析：realpath 防止软链死循环
  let realPath;
  try {
    realPath = fs.realpathSync(startPath);
  } catch {
    realPath = startPath;
  }

  // 3. 从 startPath 向上递归查找 marker
  const result = detectUpward(realPath, maxDepth);
  if (!result) return null;

  // 4. 可选：monorepo 子包根发现
  let monorepoRoots = null;
  if (findMonorepo && result.marker === 'package.json') {
    monorepoRoots = detectMonorepoSubPackages(result.root, MONOREPO_DIRS);
  }

  return {
    root: result.root,
    marker: result.marker,
    description: result.description,
    fromPath: inputPath || (opts.cwd ?? process.cwd()),
    isFile,
    monorepoRoots,
  };
}

/**
 * 从 startDir 向上递归查找 marker。
 * @param {string} startDir
 * @param {number} maxDepth
 * @returns {{root: string, marker: string, description: string} | null}
 */
function detectUpward(startDir, maxDepth) {
  let cur = startDir;
  const visited = new Set();
  for (let i = 0; i <= maxDepth; i++) {
    // 软链防护：解析当前层 realpath，防止递归中遇软链回环
    let resolved;
    try {
      resolved = fs.realpathSync(cur);
    } catch {
      resolved = cur;
    }
    if (visited.has(resolved)) break;
    visited.add(resolved);
    cur = resolved;
    // 在当前目录查找 marker（按 PROJECT_MARKERS 优先级）
    for (const marker of PROJECT_MARKERS) {
      // files 字段用 some 语义：多个文件名只需任一存在即命中（如 Gradle 的 build.gradle / build.gradle.kts）
      const anyFileExists = marker.files.some((f) => fileExists(path.join(cur, f)));
      if (!anyFileExists) continue;
      // requires 联合判定
      if (marker.requires) {
        const allRequiresExist = marker.requires.every((f) => fileExists(path.join(cur, f)));
        if (!allRequiresExist) continue;
      }
      return { root: cur, marker: marker.files[0], description: marker.description };
    }
    // 向上
    const parent = path.dirname(cur);
    if (parent === cur) break; // 到达文件系统根
    cur = parent;
  }
  return null;
}

/**
 * 检测 monorepo 子包根（apps/* / packages/* 等）。
 * @param {string} root
 * @param {string[]} monorepoDirs
 * @returns {string[]} 子包根路径列表（绝对路径）
 */
function detectMonorepoSubPackages(root, monorepoDirs) {
  const subs = [];
  for (const dir of monorepoDirs) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    let entries;
    try {
      entries = fs.readdirSync(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sub = path.join(full, e.name);
      // 子包根：包含 package.json
      if (fs.existsSync(path.join(sub, 'package.json'))) {
        subs.push(sub);
      }
    }
  }
  return subs.length > 0 ? subs : null;
}

/**
 * 文件存在性检查（含软链解析失败回退）。
 * @param {string} p
 * @returns {boolean}
 */
function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * 抛出友好错误信息：未找到项目根时调用。
 * @param {string} [inputPath]
 * @returns {Error}
 */
export function projectRootNotFoundError(inputPath) {
  const hint = inputPath
    ? `从 "${inputPath}" 向上未找到任何项目 marker（package.json / pubspec.yaml / Cargo.toml / go.mod / pyproject.toml / .git 等）`
    : '当前目录及上级目录均未找到任何项目 marker（package.json / pubspec.yaml / Cargo.toml / go.mod / pyproject.toml / .git 等）';
  return new Error(
    `${hint}。请在项目根目录内执行命令，或显式传 --repoPath <项目根>`,
  );
}
