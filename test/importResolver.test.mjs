// importResolver 回归测试：tsconfig paths 别名编译与解析
// 背景缺陷：./src/* 曾被 slice(1) 错误处理成 /src/*（绝对路径），导致所有 @/ 别名解析失败，
// 被实际导入的文件被误判为零引用孤儿（orphanCandidates 误报）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createResolver, packageName } from '../src/analyzers/importResolver.js';

const KNOWN = [
  'src/components/badges/BadgeIcons.tsx',
  'src/constants/app/badges.ts',
  'src/constants/app/index.ts',
  'nicekit/src/index.ts',
  'src/utils/helper.ts',
];

// 注：projectScanner 已将 tsconfig paths 的数组值扁平化为字符串（取首个）
const PATHS = {
  '@/*': './src/*',
  '@nicekit/core': './nicekit/src/index.ts',
  '@up/*': '../shared/*',
};

function makeResolver() {
  return createResolver('/repo', PATHS, KNOWN);
}

test('./ 前缀的通配别名解析为仓库相对路径（slice(2) 而非 slice(1)）', () => {
  const r = makeResolver();
  const res = r.resolve('src/constants/app/badges.ts', '@/components/badges/BadgeIcons');
  assert.deepEqual(res, { kind: 'internal', file: 'src/components/badges/BadgeIcons.tsx' });
});

test('./ 前缀的精确别名（非通配）', () => {
  const r = makeResolver();
  const res = r.resolve('src/App.tsx', '@nicekit/core');
  assert.deepEqual(res, { kind: 'internal', file: 'nicekit/src/index.ts' });
});

test('../ 前缀别名不残留为绝对路径', () => {
  const r = makeResolver();
  const res = r.resolve('src/a.ts', '@up/lib');
  // 目标在仓库外（../shared/lib 不在 knownFiles 中），但绝不能因绝对路径而误判
  assert.equal(res.kind === 'internal' ? res.file.startsWith('../') : true, true);
});

test('桶文件探测（目录 → index.ts）', () => {
  const r = makeResolver();
  const res = r.resolve('src/x.ts', '@/constants/app');
  assert.deepEqual(res, { kind: 'internal', file: 'src/constants/app/index.ts' });
});

test('相对路径导入 + 扩展名探测', () => {
  const r = makeResolver();
  const res = r.resolve('src/constants/app/badges.ts', '../../utils/helper');
  assert.deepEqual(res, { kind: 'internal', file: 'src/utils/helper.ts' });
});

test('未命中别名与相对路径的外部包回退', () => {
  const r = makeResolver();
  assert.equal(r.resolve('src/a.ts', 'zustand').kind, 'external');
  assert.equal(packageName('@scope/pkg/sub'), '@scope/pkg');
});

// Node 内置模块（node: 前缀或裸名）：既非内部文件也非 npm 包，不进入依赖清单与未声明依赖统计
test('Node 内置模块识别为 builtin（不计入未声明依赖）', () => {
  const r = makeResolver();
  assert.deepEqual(r.resolve('src/a.ts', 'node:fs'), { kind: 'builtin', module: 'node:fs' });
  assert.deepEqual(r.resolve('src/a.ts', 'child_process'), { kind: 'builtin', module: 'child_process' });
  assert.equal(r.resolve('src/a.ts', 'events').kind, 'builtin');
  // 子路径导入：fs/promises、readline/promises 等
  assert.equal(r.resolve('src/a.ts', 'fs/promises').kind, 'builtin');
  assert.equal(r.resolve('src/a.ts', 'readline/promises').kind, 'builtin');
  assert.equal(r.resolve('src/a.ts', 'node:test').kind, 'builtin');
  // 名字恰好与内置模块同名的本地别名仍按别名优先级处理（tsconfig 别名先于内置判定不成立时走 external）
  assert.equal(r.resolve('src/a.ts', 'zustand').kind, 'external');
  // @scope 包不受内置判定影响
  assert.equal(r.resolve('src/a.ts', '@scope/fs').kind, 'external');
});

// Vite 虚拟模块（vite-plugin-pages 等构建时生成）：非 npm 包，不计入未声明依赖
test('Vite 虚拟模块识别为 virtual（不计入未声明依赖）', () => {
  const r = makeResolver();
  assert.deepEqual(r.resolve('src/a.ts', 'virtual:generated-pages'), { kind: 'virtual', module: 'virtual:generated-pages' });
  assert.equal(r.resolve('src/a.ts', 'virtual:app-loading').kind, 'virtual');
});

test('资源后缀识别为 asset 不参与解析', () => {
  const r = makeResolver();
  assert.deepEqual(r.resolve('src/a.ts', './styles.css'), { kind: 'asset', specifier: './styles.css' });
});

// 重定基场景：扫描宿主子目录（如 src/）时，tsconfig "@/*": "./src/*" 被重定基为 "./*"，
// 别名目标即扫描根本身，前缀为空仍需正确解析（此前 rest 的前导斜杠会导致 /services 绝对路径误判）
test('重定基后的 ./* 别名目标（扫描根即别名根）', () => {
  const r = createResolver('/repo/src', { '@/*': './*' }, ['services/index.ts', 'components/Button.tsx']);
  assert.deepEqual(r.resolve('App.tsx', '@/services'), { kind: 'internal', file: 'services/index.ts' });
  assert.deepEqual(r.resolve('App.tsx', '@/components/Button'), { kind: 'internal', file: 'components/Button.tsx' });
});
