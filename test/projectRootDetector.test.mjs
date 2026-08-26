// 项目根自动检测单测：借鉴 asdm-aos v0.0.12 projectDetector 思路
// 覆盖：目录 / 文件 / 空 / 软链 / 不存在 / 多 marker 优先级 / Flutter pair / monorepo / 跨平台路径
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectProjectRoot,
  projectRootNotFoundError,
  PROJECT_MARKERS,
} from '../src/analyzers/projectRootDetector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 临时项目工厂：创建目录 + 写 marker
function mkProject(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-proot-'));
  if (opts.marker) {
    fs.writeFileSync(path.join(dir, opts.marker), opts.markerContent ?? '{}');
  }
  if (opts.extra) {
    for (const [rel, content] of Object.entries(opts.extra)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content ?? '');
    }
  }
  if (opts.requires) {
    for (const f of opts.requires) {
      fs.mkdirSync(path.join(dir, f), { recursive: true });
    }
  }
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

// =============================================================================
// 1. 基础：目录 + marker
// =============================================================================

test('目录 + package.json → 命中 Node.js 项目', () => {
  const dir = mkProject({ marker: 'package.json', markerContent: '{"name":"x"}' });
  try {
    const r = detectProjectRoot(dir);
    assert.ok(r);
    assert.equal(r.root, fs.realpathSync(dir));
    assert.equal(r.marker, 'package.json');
    assert.match(r.description, /Node\.js/);
  } finally { cleanup(dir); }
});

test('目录 + Cargo.toml → 命中 Rust 项目', () => {
  const dir = mkProject({ marker: 'Cargo.toml', markerContent: '[package]\nname="x"' });
  try {
    const r = detectProjectRoot(dir);
    assert.equal(r.marker, 'Cargo.toml');
    assert.match(r.description, /Rust/);
  } finally { cleanup(dir); }
});

test('目录 + go.mod → 命中 Go 项目', () => {
  const dir = mkProject({ marker: 'go.mod', markerContent: 'module x' });
  try {
    const r = detectProjectRoot(dir);
    assert.equal(r.marker, 'go.mod');
    assert.match(r.description, /Go/);
  } finally { cleanup(dir); }
});

test('目录 + pyproject.toml → 命中 Python 现代项目', () => {
  const dir = mkProject({ marker: 'pyproject.toml', markerContent: '[project]\nname="x"' });
  try {
    const r = detectProjectRoot(dir);
    assert.equal(r.marker, 'pyproject.toml');
    assert.match(r.description, /Python/);
  } finally { cleanup(dir); }
});

test('目录 + pom.xml → 命中 Java Maven', () => {
  const dir = mkProject({ marker: 'pom.xml' });
  try {
    const r = detectProjectRoot(dir);
    assert.equal(r.marker, 'pom.xml');
    assert.match(r.description, /Java/);
  } finally { cleanup(dir); }
});

// =============================================================================
// 2. Flutter pair 强信号：pubspec.yaml + lib/ 同时存在才算 Flutter
// =============================================================================

test('Flutter: pubspec.yaml + lib/ → 命中 Flutter', () => {
  const dir = mkProject({ marker: 'pubspec.yaml', requires: ['lib'] });
  try {
    const r = detectProjectRoot(dir);
    assert.equal(r.marker, 'pubspec.yaml');
    assert.match(r.description, /Flutter/);
  } finally { cleanup(dir); }
});

test('Dart 包（仅 pubspec.yaml 无 lib/）→ 命中 Dart 包（描述不同）', () => {
  const dir = mkProject({ marker: 'pubspec.yaml' }); // 无 lib/
  try {
    const r = detectProjectRoot(dir);
    assert.equal(r.marker, 'pubspec.yaml');
    assert.match(r.description, /Dart 包/);
  } finally { cleanup(dir); }
});

// =============================================================================
// 3. 优先级：多 marker 同时存在时取优先级最高者
// =============================================================================

test('多 marker: pubspec.yaml + package.json → Flutter 优先（因 lib/ requires）', () => {
  const dir = mkProject({
    marker: 'package.json',
    extra: { 'pubspec.yaml': '' },
    requires: ['lib'],
  });
  try {
    const r = detectProjectRoot(dir);
    // PROJECT_MARKERS 顺序：Flutter pair → Dart → Node → ...
    // 目录中 pubspec.yaml + lib/ 都在，命中 Flutter pair
    assert.equal(r.marker, 'pubspec.yaml');
    assert.match(r.description, /Flutter/);
  } finally { cleanup(dir); }
});

test('多 marker: package.json + Cargo.toml → Node 优先', () => {
  const dir = mkProject({
    marker: 'package.json',
    extra: { 'Cargo.toml': '' },
  });
  try {
    const r = detectProjectRoot(dir);
    assert.equal(r.marker, 'package.json');
  } finally { cleanup(dir); }
});

test('多 marker: .git + package.json → 命中 Node（package.json 优先级高于 .git）', () => {
  const dir = mkProject({ marker: 'package.json', extra: { '.git': '' } });
  try {
    const r = detectProjectRoot(dir);
    assert.equal(r.marker, 'package.json');
  } finally { cleanup(dir); }
});

// =============================================================================
// 4. 向上递归：文件路径 → 找所在项目的根
// =============================================================================

test('文件路径 → 向上找 package.json', () => {
  const dir = mkProject({
    marker: 'package.json',
    extra: { 'src/components/Foo.tsx': 'export function Foo() {}' },
  });
  try {
    const file = path.join(dir, 'src/components/Foo.tsx');
    const r = detectProjectRoot(file);
    assert.equal(r.root, fs.realpathSync(dir));
    assert.equal(r.marker, 'package.json');
    assert.equal(r.isFile, true);
  } finally { cleanup(dir); }
});

test('文件路径：深层嵌套 + 跨多级目录', () => {
  const dir = mkProject({
    marker: 'Cargo.toml',
    extra: { 'a/b/c/d/e/main.rs': 'fn main() {}' },
  });
  try {
    const file = path.join(dir, 'a/b/c/d/e/main.rs');
    const r = detectProjectRoot(file);
    assert.equal(r.root, fs.realpathSync(dir));
    assert.equal(r.marker, 'Cargo.toml');
  } finally { cleanup(dir); }
});

// =============================================================================
// 5. 空路径 + cwd
// =============================================================================

test('空 inputPath + cwd 指向项目 → 自动定位', () => {
  const dir = mkProject({ marker: 'go.mod' });
  try {
    const r = detectProjectRoot('', { cwd: dir });
    assert.equal(r.root, fs.realpathSync(dir));
  } finally { cleanup(dir); }
});

test('空 inputPath + cwd 在项目子目录 → 向上找到根', () => {
  const dir = mkProject({
    marker: 'package.json',
    extra: { 'src/index.js': '' },
  });
  try {
    const r = detectProjectRoot('', { cwd: path.join(dir, 'src') });
    assert.equal(r.root, fs.realpathSync(dir));
  } finally { cleanup(dir); }
});

test('空 inputPath + 无 cwd → 退到 process.cwd()', () => {
  // 测一个不可能命中 marker 的临时目录
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-proot-cwd-'));
  try {
    const r = detectProjectRoot('', { cwd: dir });
    // 临时目录的 /var/folders/.../aos-proot-cwd-XXX/ 向上找（mac 上 /var 是真实存在但 /var/folders 上有 .git? 不会）
    // 通常返回 null
    assert.equal(r, null);
  } finally { cleanup(dir); }
});

// =============================================================================
// 6. 软链：realpath 解析
// =============================================================================

test('软链 → realpath 解析后定位到目标项目', () => {
  const target = mkProject({ marker: 'package.json' });
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-proot-link-'));
  const linkPath = path.join(linkDir, 'link-to-project');
  try {
    fs.symlinkSync(target, linkPath, 'dir');
    const r = detectProjectRoot(linkPath);
    // macOS 上 /var 是 /private/var 的软链，比较时用 realpath
    assert.equal(r.root, fs.realpathSync(target), 'realpath 后应定位到 target');
  } finally {
    cleanup(target);
    cleanup(linkDir);
  }
});

// =============================================================================
// 7. 不存在 / 找不到 marker
// =============================================================================

test('路径不存在 → 返回 null', () => {
  const fake = path.join(os.tmpdir(), 'aos-proot-nonexistent-' + Date.now());
  const r = detectProjectRoot(fake);
  assert.equal(r, null);
});

test('目录无 marker → 向上递归到文件系统根仍找不到 → null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-proot-no-marker-'));
  try {
    // maxDepth 限制：避免向上走到 /var/ 等有奇怪 marker 的地方
    const r = detectProjectRoot(dir, { maxDepth: 3 });
    assert.equal(r, null);
  } finally { cleanup(dir); }
});

test('projectRootNotFoundError 输出友好错误', () => {
  const e1 = projectRootNotFoundError('/tmp/foo');
  assert.match(e1.message, /未找到任何项目 marker/);
  assert.match(e1.message, /package\.json/);
  assert.match(e1.message, /pubspec\.yaml/);
  const e2 = projectRootNotFoundError();
  assert.match(e2.message, /当前目录及上级目录/);
});

// =============================================================================
// 8. maxDepth 限制
// =============================================================================

test('maxDepth=1 时只检查当前目录与上一级', () => {
  const dir = mkProject({
    marker: 'package.json',
    extra: { 'a/b/c/deep.ts': '' },
  });
  try {
    // 位于 a/b/c/deep.ts，向上 1 层到 a/b/c 仍无 marker，maxDepth=1 找不到
    const r = detectProjectRoot(path.join(dir, 'a/b/c/deep.ts'), { maxDepth: 1 });
    assert.equal(r, null);
  } finally { cleanup(dir); }
});

test('maxDepth=10 时足够覆盖典型项目深度', () => {
  const dir = mkProject({ marker: 'Cargo.toml' });
  try {
    // 在 /tmp/aos-proot-XXX/a/b/c/d/e/f/g/h/main.rs（8 层深）
    const deep = path.join(dir, 'a/b/c/d/e/f/g/h');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'main.rs'), 'fn main() {}');
    const r = detectProjectRoot(path.join(deep, 'main.rs'), { maxDepth: 10 });
    assert.equal(r.root, fs.realpathSync(dir));
  } finally { cleanup(dir); }
});

// =============================================================================
// 9. monorepo 子包发现
// =============================================================================

test('monorepo: apps/* 子包根检测', () => {
  const dir = mkProject({
    marker: 'package.json',
    extra: {
      'apps/web/package.json': '{"name":"@x/web"}',
      'apps/api/package.json': '{"name":"@x/api"}',
      'packages/ui/package.json': '{"name":"@x/ui"}',
    },
  });
  try {
    const r = detectProjectRoot(dir, { findMonorepo: true });
    assert.equal(r.marker, 'package.json');
    assert.ok(r.monorepoRoots);
    assert.equal(r.monorepoRoots.length, 3);
    assert.ok(r.monorepoRoots.some((p) => p.endsWith('apps/web')));
    assert.ok(r.monorepoRoots.some((p) => p.endsWith('apps/api')));
    assert.ok(r.monorepoRoots.some((p) => p.endsWith('packages/ui')));
  } finally { cleanup(dir); }
});

test('monorepo: findMonorepo=false 时不检测子包', () => {
  const dir = mkProject({
    marker: 'package.json',
    extra: { 'apps/web/package.json': '{}' },
  });
  try {
    const r = detectProjectRoot(dir);
    assert.equal(r.monorepoRoots, null);
  } finally { cleanup(dir); }
});

test('非 Node 项目（Rust）→ monorepo 检测无意义（不返回子包）', () => {
  const dir = mkProject({
    marker: 'Cargo.toml',
    extra: { 'apps/web/Cargo.toml': '[package]\nname="web"' },
  });
  try {
    const r = detectProjectRoot(dir, { findMonorepo: true });
    assert.equal(r.marker, 'Cargo.toml');
    assert.equal(r.monorepoRoots, null, 'Rust 项目的 apps/* 不应被识别为子包');
  } finally { cleanup(dir); }
});

// =============================================================================
// 10. PROJECT_MARKERS 元数据校验
// =============================================================================

test('PROJECT_MARKERS 至少含 6 种 marker（Node/Rust/Go/Python/Flutter/Java/Git）', () => {
  const names = PROJECT_MARKERS.map((m) => m.files[0]);
  for (const expected of ['package.json', 'Cargo.toml', 'go.mod', 'pubspec.yaml', 'pom.xml', '.git']) {
    assert.ok(names.includes(expected), `PROJECT_MARKERS 应包含 ${expected}`);
  }
});

test('PROJECT_MARKERS 顺序：Flutter pair 在 Dart 单 marker 之前', () => {
  const idx = PROJECT_MARKERS.findIndex((m) => m.files[0] === 'pubspec.yaml' && m.requires);
  const idx2 = PROJECT_MARKERS.findIndex((m) => m.files[0] === 'pubspec.yaml' && !m.requires);
  assert.ok(idx >= 0, '应有 Flutter pair marker');
  assert.ok(idx2 >= 0, '应有 Dart 单 marker');
  assert.ok(idx < idx2, 'Flutter pair 优先级应高于 Dart 单 marker');
});
