// 死代码三级判定测试：导出级 unusedExports / 函数级（Method + ScriptFunction）/ 单文件分析 analyzeFile
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildOntologyData, buildSingleFileOntology } from '../src/ontology/builder.js';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const CLI = path.join(ROOT, 'src/cli/index.js');

// ---- 导出级 unusedExports：命中与豁免 ----
const MATH_FILE = [
  'export function add(a: number, b: number): number { return a + b; }',
  'export function unusedFn(): number { return 1; }',
  'export function usedLocally(): number { return 2; }',
  'export function reExported(): number { return 3; }',
  'function deadLocal(): number { return 4; }',
  'const local = usedLocally();',
].join('\n');

const MAIN_FILE = [
  "import { add } from './utils/math.js';",
  "setTimeout(() => { import('./lazy.js'); }, 0);",
  'export function entryOnlyExport(): void {}',
  'console.log(add(1, 2));',
].join('\n');

const LAZY_FILE = [
  'export function lazyFn(): number { return 5; }',
].join('\n');

const REEXPORT_FILE = [
  "export { add, reExported } from './utils/math.js';",
].join('\n');

async function buildExportFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-deadexp-'));
  fs.mkdirSync(path.join(dir, 'src/utils'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/utils/math.ts'), MATH_FILE);
  fs.writeFileSync(path.join(dir, 'src/main.ts'), MAIN_FILE);
  fs.writeFileSync(path.join(dir, 'src/lazy.ts'), LAZY_FILE);
  fs.writeFileSync(path.join(dir, 'src/reexport.ts'), REEXPORT_FILE);
  const dataMap = await buildOntologyData(dir);
  return { dir, dataMap };
}

test('导出级：unusedExports 命中（全仓库零导入且本文件零使用）', async () => {
  const { dir, dataMap } = await buildExportFixture();
  try {
    const math = dataMap.SourceFile.find((f) => f.path === 'src/utils/math.ts');
    assert.ok(math);
    assert.deepEqual(math.unusedExports, ['unusedFn']);
    // 汇总进 _meta 与健康度
    assert.deepEqual(dataMap._meta.deadExportCandidates, [{ file: 'src/utils/math.ts', names: ['unusedFn'] }]);
    assert.equal(dataMap.Project[0].health.deadExportCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('导出级：豁免（被导入 / re-export 链 / 本文件使用 / 入口文件 / 动态 import 整体引用）', async () => {
  const { dir, dataMap } = await buildExportFixture();
  try {
    const math = dataMap.SourceFile.find((f) => f.path === 'src/utils/math.ts');
    // add 被 main.ts 导入；reExported 经 reexport.ts 再导出（re-export 链引用，保守不判死）
    // usedLocally 本文件内仍被调用（仅 export 冗余，不判死）
    for (const name of ['add', 'reExported', 'usedLocally']) {
      assert.ok(!math.unusedExports.includes(name), `${name} 不应判为 unused export`);
    }
    // 入口文件导出豁免
    const main = dataMap.SourceFile.find((f) => f.path === 'src/main.ts');
    assert.equal(main.isEntry, true);
    assert.deepEqual(main.unusedExports, []);
    // 动态 import() 无子句解构 → 目标文件整体豁免（无法按名追踪）
    const lazy = dataMap.SourceFile.find((f) => f.path === 'src/lazy.ts');
    assert.deepEqual(lazy.unusedExports, []);
    // reexport.ts 自身零导入 → 文件级 orphan 覆盖，不做导出级重复判定
    const reexport = dataMap.SourceFile.find((f) => f.path === 'src/reexport.ts');
    assert.deepEqual(reexport.unusedExports, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('导出级：同 fixture 中函数级死代码（非导出零引用函数）', async () => {
  const { dir, dataMap } = await buildExportFixture();
  try {
    const deadLocal = dataMap.Method.find((m) => m.id === 'method:src/utils/math.ts#deadLocal');
    assert.equal(deadLocal.deadCandidate, true);
    assert.equal(deadLocal.deadReason, '本文件内零引用');
    // unusedFn 为导出符号：函数级不重复判死（已在导出级报告）
    const unusedFn = dataMap.Method.find((m) => m.id === 'method:src/utils/math.ts#unusedFn');
    assert.equal(unusedFn.deadCandidate, true); // 全仓库零导入且本文件零引用 → 函数级也判死
    assert.equal(unusedFn.deadReason, '导出但全仓库零导入且本文件零引用');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 油猴脚本函数级 deadCandidate（仓库模式） ----
const USERSCRIPT_FILE = [
  '// ==UserScript==',
  '// @name         Demo',
  '// @version      1.0.0',
  '// @match        https://example.com/*',
  '// @grant        GM_getValue',
  '// @connect      api.example.com',
  '// ==/UserScript==',
  '(function () {',
  "  'use strict';",
  '  function usedAtTopLevel() { renderBadge(); }',
  "  function renderBadge() { document.body.innerHTML = '<div>' + GM_getValue('x', '') + '</div>'; }",
  '  function onClickHandler() {}',
  '  function deadFunction() { console.log("never called"); }',
  '  class App {',
  '    constructor() { this.init(); }',
  "    init() { document.addEventListener('click', onClickHandler); }",
  '    unusedMethod() {}',
  '  }',
  '  usedAtTopLevel();',
  '  const app = new App();',
  '})();',
].join('\n');

async function buildUserScriptFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-deadus-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts/demo.user.js'), USERSCRIPT_FILE);
  const dataMap = await buildOntologyData(dir);
  return { dir, dataMap };
}

test('油猴函数级：ScriptFunction deadCandidate 命中与不误报', async () => {
  const { dir, dataMap } = await buildUserScriptFixture();
  try {
    const fn = (name) => dataMap.ScriptFunction.find((f) => f.name === name);
    // 命中：零引用函数与无人调用的类方法
    assert.equal(fn('deadFunction').deadCandidate, true);
    assert.equal(fn('deadFunction').deadReason, '全文零引用（排除声明与自身函数体）');
    assert.equal(fn('App.unusedMethod').deadCandidate, true);
    // 不误报：顶层直调 / 被调用 / 回调传值 / constructor / this.init() 调用链
    assert.equal(fn('usedAtTopLevel').deadCandidate, false);
    assert.equal(fn('renderBadge').deadCandidate, false);
    assert.equal(fn('onClickHandler').deadCandidate, false); // addEventListener 回调传值（引用计数命中）
    assert.equal(fn('App').deadCandidate, false);             // new App() 实例化引用
    assert.equal(fn('App.constructor').deadCandidate, false); // constructor 豁免
    assert.equal(fn('App.init').deadCandidate, false);        // constructor 内 this.init() 调用边
    // UserScript 汇总
    assert.equal(dataMap.UserScript[0].deadFunctionCount, 2);
    assert.equal(dataMap.Project[0].health.deadFunctionCount, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 单文件分析 analyzeFile ----
const TS_SINGLE_FILE = [
  'export interface IStorage {',
  '  get(key: string): string | null;',
  '}',
  'class LocalStore implements IStorage {',
  '  get(key: string): string | null { return null; }',
  '  unused() {}',
  '}',
  'export const store = new LocalStore();',
  'export function exportedFn() {}',
  'function deadLocal() {}',
].join('\n');

test('单文件分析：油猴文件输出 dataMap 形状（不落盘、mode=single-file）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-sf-us-'));
  try {
    const filePath = path.join(dir, 'demo.user.js');
    fs.writeFileSync(filePath, USERSCRIPT_FILE);
    const dataMap = await buildSingleFileOntology(filePath);
    assert.equal(dataMap._meta.mode, 'single-file');
    assert.equal(dataMap._meta.objectCounts.UserScript, 1);
    assert.equal(dataMap._meta.objectCounts.SourceFile, 1);
    assert.equal(dataMap.UserScript[0].name, 'Demo');
    const fn = (name) => dataMap.ScriptFunction.find((f) => f.name === name);
    assert.equal(fn('deadFunction').deadCandidate, true);
    assert.equal(fn('usedAtTopLevel').deadCandidate, false);
    // GM 审计事实同仓库模式可用
    assert.ok(dataMap.GmApiUsage.some((g) => g.name === 'GM_getValue' && g.declared === true));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('单文件分析：TS 文件类型实体 + 本文件内 implements/overrides', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-sf-ts-'));
  try {
    const filePath = path.join(dir, 'store.ts');
    fs.writeFileSync(filePath, TS_SINGLE_FILE);
    const dataMap = await buildSingleFileOntology(filePath);
    assert.equal(dataMap._meta.objectCounts.Interface, 1);
    assert.equal(dataMap._meta.objectCounts.Class, 1);
    // LocalStore 非导出但被 new LocalStore() 引用 → 不判死
    const localStore = dataMap.Class.find((c) => c.name === 'LocalStore');
    assert.equal(localStore.deadCandidate, false);
    assert.deepEqual(localStore.implementsIds, ['iface:store.ts#IStorage']);
    // 方法级 overrides：实现方法 → 接口方法（单文件内按本文件声明解析）
    const implGet = dataMap.Method.find((m) => m.id === 'method:store.ts#LocalStore#get');
    const ifaceGet = dataMap.Method.find((m) => m.id === 'method:store.ts#IStorage#get');
    assert.equal(implGet.overridesId, ifaceGet.id);
    // 非导出零引用函数判死；导出函数单文件模式不判死（无法判定跨文件使用）
    assert.equal(dataMap.Method.find((m) => m.id === 'method:store.ts#deadLocal').deadCandidate, true);
    assert.equal(dataMap.Method.find((m) => m.id === 'method:store.ts#exportedFn').deadCandidate, false);
    assert.equal(dataMap.Method.find((m) => m.id === 'method:store.ts#LocalStore#unused').deadCandidate, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI action analyzeFile：stdout 输出合法 JSON（油猴与 TS 各一）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-sf-cli-'));
  try {
    const usPath = path.join(dir, 'demo.user.js');
    const tsPath = path.join(dir, 'store.ts');
    fs.writeFileSync(usPath, USERSCRIPT_FILE);
    fs.writeFileSync(tsPath, TS_SINGLE_FILE);

    const usOut = await execFileAsync('node', [CLI, 'action', 'analyzeFile', '--params', JSON.stringify({ file: usPath })]);
    const us = JSON.parse(usOut.stdout);
    assert.equal(us._meta.mode, 'single-file');
    assert.ok(us.ScriptFunction.some((f) => f.name === 'deadFunction' && f.deadCandidate === true));

    const tsOut = await execFileAsync('node', [CLI, 'action', 'analyzeFile', '--params', JSON.stringify({ file: tsPath })]);
    const ts = JSON.parse(tsOut.stdout);
    assert.equal(ts._meta.objectCounts.Interface, 1);
    assert.equal(ts._meta.objectCounts.Class, 1);
    // 不落盘：动作目录下未创建快照目录
    assert.equal(fs.readdirSync(dir).includes('.nice-aos'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
