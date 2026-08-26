// 解析 git diff 范围，给出变更的文件列表
// 借鉴 code-graph-rag 范式 9 "Parser fingerprint 缓存 key" 的简单数据驱动风格（输入 → 输出，无副作用）
//
// 范围语法（与 git 标准一致）：
//   HEAD             → 工作区与 HEAD 的差异（含未暂存）
//   HEAD --staged    → 已暂存与 HEAD 的差异
//   abc123           → ref 与 HEAD 的差异
//   HEAD~1           → HEAD~1 与 HEAD 的差异
//   abc..def         → abc 与 def 的差异
//   abc...def        → merge base of abc,def 与 def 的差异（暂不支持，简单化为 ..）
//
// 安全：纯 execFile，无 shell 拼接；git 命令在指定 gitRoot 下执行

import { execFileSync } from 'node:child_process';

// 校验范围 spec 合法性（防注入：仅允许字母数字 / . ~ ^ _ - / .. 与空白）
const SAFE_RE = /^[A-Za-z0-9._~^/\-\s]{1,128}$/;

export function isValidRangeSpec(spec) {
  return typeof spec === 'string' && SAFE_RE.test(spec) && !/^\s*$/.test(spec);
}

// 解析 spec 为 git diff 接受的左右引用
// 简化：a..b 通过；a...b（merge-base）暂不支持，提前 fail 让用户明确
// 单 ref（无 ..）→ to 标记为 working tree（git diff <ref> 与工作区比，等价 <ref>..{worktree}）
function splitRange(spec) {
  if (spec.includes('...')) {
    throw new Error(`暂不支持三点语法 a...b（merge-base）。请用 a..b，或单 ref 表示与工作区的差异: ${spec}`);
  }
  if (spec.includes('..')) {
    const [a, b] = spec.split('..');
    return { from: a.trim(), to: b.trim(), toIsWorktree: false };
  }
  // 单 ref → to 是 working tree（不传 ..）→ git diff <ref>
  return { from: spec.trim(), to: null, toIsWorktree: true };
}

// 在指定 gitRoot 下，调 `git diff --name-only [--staged]` 拿到变更文件列表（相对 git 根）
// opts.staged：true 时用 --staged（已暂存 vs HEAD）
// opts.fromRef / opts.toRef：覆盖 spec 解析结果
// 返回：字符串数组（文件路径，相对 gitRoot）
// 异常：不在 git 仓库 / git 不可用 / spec 非法 → 抛错
export function listChangedFiles(gitRoot, spec, opts = {}) {
  if (!isValidRangeSpec(spec)) {
    throw new Error(`非法的范围 spec（仅允许字母数字 . ~ ^ _ - .. 空白）: ${spec}`);
  }
  let from, to, toIsWorktree;
  if (opts.fromRef || opts.toRef) {
    from = opts.fromRef ?? 'HEAD';
    to = opts.toRef ?? 'HEAD';
    toIsWorktree = false;
  } else {
    ({ from, to, toIsWorktree } = splitRange(spec));
  }
  const args = ['diff', '--name-only'];
  if (opts.staged) {
    args.push('--staged');
    // --staged 不需要 ref（总是 vs HEAD）
  } else if (toIsWorktree) {
    // 单 ref：与 working tree 比
    args.push(from);
  } else {
    args.push(`${from}..${to}`);
  }
  let stdout;
  try {
    stdout = execFileSync('git', args, { cwd: gitRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const stderr = err.stderr?.toString?.()?.trim() || err.message;
    throw new Error(`git diff 失败（cwd=${gitRoot}）: ${stderr}`);
  }
  return stdout.split('\n').map((p) => p.trim()).filter(Boolean);
}

// 在指定 gitRoot 下，列出所有"自某 ref 以来"变更的文件（含工作区未暂存）
// 等价于：git diff --name-only <ref>..HEAD 加 git ls-files --others --exclude-standard
export function listChangedFilesSince(gitRoot, ref) {
  const tracked = listChangedFiles(gitRoot, ref);
  let untracked = [];
  try {
    const out = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: gitRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    untracked = out.split('\n').map((p) => p.trim()).filter(Boolean);
  } catch { /* 忽略：可能是 detached HEAD / fresh repo */ }
  return [...tracked, ...untracked];
}

// 找出 dataMap 中 filePath 在 fileList 里的对象（按类型分组）
// fileList 是相对 git 根的路径；dataMap 对象的 filePath 是项目内绝对或相对路径
// 比较时归一化（去前导 ./ 与绝对化）
function normalizePath(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export function filterObjectsByFiles(dataMap, fileList) {
  if (!Array.isArray(fileList) || fileList.length === 0) return {};
  const norm = new Set(fileList.map(normalizePath));
  const byType = {};
  for (const [type, arr] of Object.entries(dataMap)) {
    if (!Array.isArray(arr) || type === '_meta') continue;
    const matched = arr.filter((o) => {
      const fp = o.filePath || o.path || o.relPath;
      if (!fp) return false;
      return norm.has(normalizePath(fp));
    });
    if (matched.length > 0) byType[type] = matched;
  }
  return byType;
}
