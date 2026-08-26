// gitDiff 单元测试：range spec 校验 + 真 git 仓库下的 listChangedFiles / filterObjectsByFiles
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  isValidRangeSpec,
  listChangedFiles,
  listChangedFilesSince,
  filterObjectsByFiles,
} from '../src/analyzers/gitDiff.js';

// =============================================================================
// 1. isValidRangeSpec
// =============================================================================

test('isValidRangeSpec：合法 spec', () => {
  for (const s of ['HEAD', 'HEAD~1', 'HEAD~10', 'abc123', 'abc..def', 'main..feature/x', 'v1.0.0', 'a b c']) {
    assert.equal(isValidRangeSpec(s), true, `应合法: ${s}`);
  }
});

test('isValidRangeSpec：非法 spec（空 / 注入字符）', () => {
  for (const s of ['', '   ', null, undefined, 123, 'abc;rm -rf /', 'abc|cat', '$(whoami)', '`ls`']) {
    assert.equal(isValidRangeSpec(s), false, `应非法: ${s}`);
  }
});

// =============================================================================
// 2. 真 git 仓库下的 listChangedFiles / listChangedFilesSince
// =============================================================================

function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-git-'));
  const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@test.com']);
  run(['config', 'user.name', 'Test']);
  // 初始 commit
  fs.writeFileSync(path.join(dir, 'README.md'), '# init');
  fs.writeFileSync(path.join(dir, 'src.ts'), 'export const a = 1;');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'init']);
  return { dir, run };
}

test('listChangedFiles：ref..HEAD 返回相对 ref 的变更文件', () => {
  const { dir, run } = makeGitRepo();
  // 新增 + 修改文件
  fs.writeFileSync(path.join(dir, 'NEW.ts'), 'export const b = 2;');
  fs.writeFileSync(path.join(dir, 'src.ts'), 'export const a = 999;');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'second']);
  const files = listChangedFiles(dir, 'HEAD~1');
  assert.deepEqual(files.sort(), ['NEW.ts', 'src.ts']);
});

test('listChangedFilesSince：含未跟踪文件', () => {
  const { dir, run } = makeGitRepo();
  // 改一个 + 新增未跟踪
  fs.writeFileSync(path.join(dir, 'src.ts'), 'export const a = 999;');
  fs.writeFileSync(path.join(dir, 'UNTRACKED.ts'), 'export const c = 3;');
  // 不 add（保持 src.ts 未暂存、UNTRACKED.ts 未跟踪）
  const files = listChangedFilesSince(dir, 'HEAD');
  assert.ok(files.includes('src.ts'), '工作区变更应被捕获');
  assert.ok(files.includes('UNTRACKED.ts'), '未跟踪文件应被捕获');
});

test('listChangedFiles：--staged 模式只列已暂存', () => {
  const { dir, run } = makeGitRepo();
  // 改 src.ts 并 add
  fs.writeFileSync(path.join(dir, 'src.ts'), 'export const a = 999;');
  run(['add', 'src.ts']);
  // 新增未跟踪
  fs.writeFileSync(path.join(dir, 'UNTRACKED.ts'), 'export const c = 3;');
  // --staged 不需要 ref 也能跑（总是 vs HEAD）
  const staged = listChangedFiles(dir, 'HEAD', { staged: true });
  assert.deepEqual(staged, ['src.ts']);
});

test('listChangedFiles：同 ref 范围返回空', () => {
  const { dir } = makeGitRepo();
  // 当前 commit hash 取出来
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
  // abc..abc 应返回空（无差异）
  const files = listChangedFiles(dir, `${head}..${head}`);
  assert.deepEqual(files, []);
});

test('listChangedFiles：非法 spec 抛错', () => {
  const { dir } = makeGitRepo();
  assert.throws(() => listChangedFiles(dir, 'abc;rm'), /非法/);
});

test('listChangedFiles：非 git 目录抛错', () => {
  // 必须完全隔离：git 默认向上找 .git，所以用 GIT_DIR 显式指定空 git 路径
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-nogit-'));
  try {
    // 强制 git 在 dir 里执行，不向上找：把 GIT_CEILING_DIRECTORIES 设为 dir 自身
    // 配合 GIT_DIR 设个不存在的路径，git 找不到 .git 时会报错
    const oldCeil = process.env.GIT_CEILING_DIRECTORIES;
    const oldDir = process.env.GIT_DIR;
    process.env.GIT_CEILING_DIRECTORIES = dir;
    process.env.GIT_DIR = path.join(dir, '.git');
    try {
      assert.throws(() => listChangedFiles(dir, 'HEAD'), /git diff 失败/);
    } finally {
      if (oldCeil === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeil;
      if (oldDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = oldDir;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// 3. filterObjectsByFiles：纯函数
// =============================================================================

test('filterObjectsByFiles：按 filePath 匹配', () => {
  const dataMap = {
    Component: [
      { id: 'c1', name: 'A', filePath: 'src/A.tsx' },
      { id: 'c2', name: 'B', filePath: 'src/B.tsx' },
      { id: 'c3', name: 'C', filePath: 'src/C.tsx' },
    ],
    Method: [
      { id: 'm1', name: 'f', filePath: 'src/A.tsx' },
    ],
  };
  const matched = filterObjectsByFiles(dataMap, ['src/A.tsx', 'src/B.tsx']);
  assert.equal(matched.Component.length, 2);
  assert.equal(matched.Method.length, 1);
  assert.deepEqual(matched.Component.map((c) => c.name).sort(), ['A', 'B']);
});

test('filterObjectsByFiles：path / relPath 兜底匹配', () => {
  const dataMap = {
    Module: [
      { id: 'm1', name: 'M', path: 'src/m.ts' },
      { id: 'm2', name: 'N', relPath: 'src/n.ts' },
    ],
  };
  const matched = filterObjectsByFiles(dataMap, ['src/m.ts', 'src/n.ts']);
  assert.equal(matched.Module.length, 2);
});

test('filterObjectsByFiles：空文件列表返回空', () => {
  const dataMap = { Component: [{ id: 'c1', filePath: 'x' }] };
  assert.deepEqual(filterObjectsByFiles(dataMap, []), {});
  assert.deepEqual(filterObjectsByFiles(dataMap, null), {});
});

test('filterObjectsByFiles：路径前缀 ./ 容忍（绝对路径不可比，正常行为）', () => {
  const dataMap = {
    SourceFile: [
      { id: 'f1', filePath: './src/a.ts' },
      { id: 'f2', filePath: 'src/a.ts' }, // 与 input 一样
    ],
  };
  const matched = filterObjectsByFiles(dataMap, ['src/a.ts']);
  // ./ 与无前缀都归一化为 'src/a.ts'，应同时匹配
  assert.equal(matched.SourceFile.length, 2);
});
