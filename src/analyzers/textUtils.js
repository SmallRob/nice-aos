// 分析器共享文本工具：行号计算（computeLineStarts/lineAt 原为
// dart/go/kotlin/python/rust 五个分析器逐字重复的副本，收敛于此）。

import fs from 'node:fs';
import path from 'node:path';

export function computeLineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) {
    if (src.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

export function lineAt(lineStarts, pos) {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// 剥离文本中按偏移定位行号（线性扫描版）：原为 cmake/nix/pkgbuild
// 三个分析器逐字重复的副本，语义与 computeLineStarts+lineAt 等价但无需预建索引。
export function lineOf(stripped, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < stripped.length; i++) if (stripped[i] === '\n') line++;
  return line;
}

// 读盘分析骨架：原为 dart/go/kotlin/rust/cmake/nix/pkgbuild 七个分析器
// 逐字重复的 analyzeXFromDisk 副本（读文件 → 委托纯函数分析）。
// Python 侧因需前置语法错误挂钩而不套用本骨架。
export function analyzeFileFromDisk(relPath, projectRoot, analyzeFn) {
  const content = fs.readFileSync(path.join(projectRoot, relPath), 'utf-8');
  return analyzeFn(relPath, content);
}

// 配对查找通用版：给定 open 起点返回匹配 close 的索引。
// 输入必须是已剥离噪声的文本（字符串/注释已去除），调用方负责。
// 收敛前同族副本：kotlin 的 brace/paren/angle ×3、php 的 brace/paren ×2、
// cmake/pkgbuild 的 paren（带字符串跳过）×2、nix 的通用匹配器。
export function findMatchingPair(content, start, open, close) {
  let depth = 0;
  for (let i = start; i < content.length; i += 1) {
    const c = content[i];
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// 括号配对（跳过双引号字符串内部）：原为 cmake/pkgbuild 逐字重复的副本。
export function findMatchingParen(content, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < content.length; i++) {
    const c = content[i];
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
