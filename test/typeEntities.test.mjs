// 类型实体测试：Interface / Class / Method 提取、跨文件 implements/extends/overrides 关系、函数级死代码候选
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeFile } from '../src/analyzers/tsAnalyzer.js';
import { buildOntologyData } from '../src/ontology/builder.js';
import { createBlueprint, OBJECT_TYPES, LINK_TYPES } from '../src/ontology/blueprint.js';
import { parseWhere, matchesWhere } from '../src/cli/shared.js';

const ROOT = process.cwd();

// ---- tsAnalyzer 单元级：接口/类/模块函数事实提取 ----
test('tsAnalyzer：接口事实（导出/继承/方法签名）', () => {
  const content = [
    'export interface IStorage extends IBase {',
    '  get(key: string): string | null;',
    '  set(key: string, value: string): void;',
    '}',
    'interface IBase { clear(): void; }',
  ].join('\n');
  const facts = analyzeFile('src/types/storage.ts', content, ROOT);
  assert.equal(facts.interfaces.length, 2);
  const storage = facts.interfaces.find((i) => i.name === 'IStorage');
  assert.ok(storage);
  assert.equal(storage.exported, true);
  assert.deepEqual(storage.extendsNames, ['IBase']);
  assert.equal(storage.methods.length, 2);
  assert.equal(storage.methods[0].name, 'get');
  assert.match(storage.methods[0].signature, /\(key: string\): string \| null/);
  const base = facts.interfaces.find((i) => i.name === 'IBase');
  assert.equal(base.exported, false);
});

test('tsAnalyzer：类事实（implements/extends/方法修饰符）', () => {
  const content = [
    'import type { IStorage } from "./storage";',
    'export class LocalStorage implements IStorage {',
    '  async get(key: string): Promise<string | null> { return null; }',
    '  static getInstance(): LocalStorage { return new LocalStorage(); }',
    '  set(key: string, value: string): void {}',
    '}',
  ].join('\n');
  const facts = analyzeFile('src/impl/localStorage.ts', content, ROOT);
  assert.equal(facts.classes.length, 1);
  const cls = facts.classes[0];
  assert.equal(cls.name, 'LocalStorage');
  assert.equal(cls.exported, true);
  assert.equal(cls.isSingleton, true);
  assert.deepEqual(cls.implementsNames, ['IStorage']);
  assert.equal(cls.methods.length, 3);
  const get = cls.methods.find((m) => m.name === 'get');
  assert.equal(get.isAsync, true);
  const getInstance = cls.methods.find((m) => m.name === 'getInstance');
  assert.equal(getInstance.isStatic, true);
});

test('tsAnalyzer：模块函数（顶层声明 + const 箭头函数）与引用计数', () => {
  const content = [
    'function helper() { return 1; }',
    'export const makeThing = () => helper();',
    'const unusedArrow = () => 2;',
    'function selfRecursive() { return selfRecursive(); }',
  ].join('\n');
  const facts = analyzeFile('src/utils/fns.ts', content, ROOT);
  assert.deepEqual(facts.moduleFunctions.map((f) => f.name), ['helper', 'makeThing', 'unusedArrow', 'selfRecursive']);
  assert.equal(facts.moduleFunctions.find((f) => f.name === 'makeThing').exported, true);
  assert.equal(facts.moduleFunctions.find((f) => f.name === 'helper').exported, false);
  // 引用计数：helper 在 makeThing 内被调用；unusedArrow 仅声明处出现
  const helperRefs = facts.nameReferences.get('helper') ?? [];
  assert.equal(helperRefs.length, 2); // 声明 + 调用
  const unusedRefs = facts.nameReferences.get('unusedArrow') ?? [];
  assert.equal(unusedRefs.length, 1); // 仅声明
});

// ---- 端到端：buildOntologyData 构建类型实体与关系 ----
const TYPES_FILE = [
  'export interface IStorage {',
  '  get(key: string): string | null;',
  '  set(key: string, value: string): void;',
  '}',
].join('\n');

const LOCAL_IMPL_FILE = [
  'import type { IStorage } from "../types/storage";',
  'export class LocalStorage implements IStorage {',
  '  get(key: string): string | null { return null; }',
  '  set(key: string, value: string): void {}',
  '}',
  'export const storage: LocalStorage = new LocalStorage();',
].join('\n');

const ALIASED_IMPL_FILE = [
  'import { IStorage as StorageContract } from "../types/storage";',
  'export class AliasedStorage implements StorageContract {',
  '  get(key: string): string | null { return null; }',
  '  set(key: string, value: string): void {}',
  '}',
  'export const aliased: AliasedStorage = new AliasedStorage();',
].join('\n');

const BASE_FILE = [
  'export class BaseRepo {',
  '  find(id: string): string { return id; }',
  '  remove(id: string): void {}',
  '}',
].join('\n');

const REPO_FILE = [
  'import { BaseRepo } from "./base";',
  'export class UserRepo extends BaseRepo {',
  '  find(id: string): string { return `u-${id}`; }',
  '  getUser(id: string): string { return this.find(id); }',
  '}',
  'export const repo: UserRepo = new UserRepo();',
].join('\n');

const DEAD_FILE = [
  'class DeadClass {',
  '  neverCalled(): void {}',
  '}',
  'class AliveClass {',
  '  methodA(): void {}',
  '  methodB(): void { this.methodA(); }',
  '}',
  'const alive = new AliveClass();',
  'function orphanHelper(): void {}',
  'function caller(): void { alive.methodB(); }',
  'export function exportedButUnimported(): void { caller(); }',
].join('\n');

async function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-types-'));
  fs.mkdirSync(path.join(dir, 'src/types'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/impl'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/core'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/utils'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/types/storage.ts'), TYPES_FILE);
  fs.writeFileSync(path.join(dir, 'src/impl/localStorage.ts'), LOCAL_IMPL_FILE);
  fs.writeFileSync(path.join(dir, 'src/impl/aliased.ts'), ALIASED_IMPL_FILE);
  fs.writeFileSync(path.join(dir, 'src/core/base.ts'), BASE_FILE);
  fs.writeFileSync(path.join(dir, 'src/core/repo.ts'), REPO_FILE);
  fs.writeFileSync(path.join(dir, 'src/utils/dead.ts'), DEAD_FILE);
  const dataMap = await buildOntologyData(dir);
  return { dir, dataMap };
}

test('端到端：Interface/Class/Method 实体入快照与 objectCounts', async () => {
  const { dataMap } = await buildFixture();
  assert.equal(dataMap.Interface.length, 1);
  assert.equal(dataMap.Class.length, 6);
  // 方法数：IStorage 2 + LocalStorage 2 + AliasedStorage 2 + BaseRepo 2 + UserRepo 2 + DeadClass 1 + AliveClass 2
  // + 模块函数 dead.ts 3（orphanHelper/caller/exportedButUnimported）+ repo.ts 0 + storage.ts 0
  assert.equal(dataMap.Method.length, 16);
  assert.equal(dataMap._meta.objectCounts.Interface, 1);
  assert.equal(dataMap._meta.objectCounts.Class, 6);
  assert.equal(dataMap._meta.objectCounts.Method, 16);
  const storage = dataMap.Interface[0];
  assert.equal(storage.id, 'iface:src/types/storage.ts#IStorage');
  assert.equal(storage.methodIds.length, 2);
  assert.equal(storage.deadCandidate, false); // 被 impl 文件导入
});

test('端到端：跨文件 implements 解析（含 type-only 与别名导入）', async () => {
  const { dataMap } = await buildFixture();
  const local = dataMap.Class.find((c) => c.name === 'LocalStorage');
  const aliased = dataMap.Class.find((c) => c.name === 'AliasedStorage');
  const ifaceId = 'iface:src/types/storage.ts#IStorage';
  assert.deepEqual(local.implementsIds, [ifaceId]);
  assert.deepEqual(local.implementsNames, ['IStorage']);
  assert.deepEqual(aliased.implementsIds, [ifaceId]); // 别名 StorageContract → IStorage
  assert.deepEqual(aliased.implementsNames, ['StorageContract']);
  assert.equal(local.deadCandidate, false); // 同文件被 new LocalStorage() 引用
});

test('端到端：类继承 extends 解析与方法级 overrides 双向链接', async () => {
  const { dataMap } = await buildFixture();
  const userRepo = dataMap.Class.find((c) => c.name === 'UserRepo');
  assert.equal(userRepo.extendsId, 'class:src/core/base.ts#BaseRepo');
  const userRepoFind = dataMap.Method.find((m) => m.id === 'method:src/core/repo.ts#UserRepo#find');
  const baseFind = dataMap.Method.find((m) => m.id === 'method:src/core/base.ts#BaseRepo#find');
  assert.equal(userRepoFind.overridesId, baseFind.id);
  assert.deepEqual(baseFind.overriddenByIds, [userRepoFind.id]);
  // BaseRepo.remove 未被覆盖
  const baseRemove = dataMap.Method.find((m) => m.id === 'method:src/core/base.ts#BaseRepo#remove');
  assert.deepEqual(baseRemove.overriddenByIds, []);
});

test('端到端：接口方法 → 实现方法（overrides / overriddenBy）', async () => {
  const { dataMap } = await buildFixture();
  const ifaceGet = dataMap.Method.find((m) => m.id === 'method:src/types/storage.ts#IStorage#get');
  const localGet = dataMap.Method.find((m) => m.id === 'method:src/impl/localStorage.ts#LocalStorage#get');
  const aliasedGet = dataMap.Method.find((m) => m.id === 'method:src/impl/aliased.ts#AliasedStorage#get');
  assert.equal(localGet.overridesId, ifaceGet.id);
  assert.equal(aliasedGet.overridesId, ifaceGet.id);
  assert.deepEqual(ifaceGet.overriddenByIds.sort(), [aliasedGet.id, localGet.id].sort());
});

test('端到端：blueprint 链接（implements/implementedBy/extends/extendedBy/overrides/overriddenBy/contains）', async () => {
  const { dataMap } = await buildFixture();
  const bp = createBlueprint(dataMap);
  const ifaceId = 'iface:src/types/storage.ts#IStorage';
  // 正向：类实现了哪些接口
  const impls = bp.link('implements', 'class:src/impl/localStorage.ts#LocalStorage');
  assert.deepEqual(impls.map((i) => i.id), [ifaceId]);
  // 反向：接口被哪些类实现（此前"正向 query 不到"的痛点）
  const implementers = bp.link('implementedBy', ifaceId);
  assert.deepEqual(implementers.map((c) => c.name).sort(), ['AliasedStorage', 'LocalStorage']);
  // 继承
  const parent = bp.link('extends', 'class:src/core/repo.ts#UserRepo');
  assert.deepEqual(parent.map((c) => c.id), ['class:src/core/base.ts#BaseRepo']);
  const children = bp.link('extendedBy', 'class:src/core/base.ts#BaseRepo');
  assert.deepEqual(children.map((c) => c.name), ['UserRepo']);
  // 方法覆盖双向
  const ifaceGet = 'method:src/types/storage.ts#IStorage#get';
  const overridden = bp.link('overriddenBy', ifaceGet);
  assert.equal(overridden.length, 2);
  const localGet = bp.link('overrides', 'method:src/impl/localStorage.ts#LocalStorage#get');
  assert.deepEqual(localGet.map((m) => m.id), [ifaceGet]);
  // contains：文件 → 类型实体；接口 → 方法
  const fileChildren = bp.link('contains', 'file:src/types/storage.ts');
  assert.ok(fileChildren.some((o) => o.id === ifaceId));
  const ifaceMethods = bp.link('contains', ifaceId);
  assert.equal(ifaceMethods.length, 2);
});

test('端到端：函数级死代码候选（保守判定，不误报）', async () => {
  const { dataMap } = await buildFixture();
  const byId = (id) => dataMap.Method.find((m) => m.id === id);
  // DeadClass（非导出、零引用）与其方法 → 死
  const deadClass = dataMap.Class.find((c) => c.name === 'DeadClass');
  assert.equal(deadClass.deadCandidate, true);
  assert.equal(deadClass.deadReason, '本文件内零引用');
  assert.equal(byId('method:src/utils/dead.ts#DeadClass#neverCalled').deadCandidate, true);
  // AliveClass 及其方法（this.methodA() 计为引用）→ 活
  const aliveClass = dataMap.Class.find((c) => c.name === 'AliveClass');
  assert.equal(aliveClass.deadCandidate, false);
  assert.equal(byId('method:src/utils/dead.ts#AliveClass#methodA').deadCandidate, false);
  assert.equal(byId('method:src/utils/dead.ts#AliveClass#methodB').deadCandidate, false);
  // orphanHelper：无人调用 → 死；caller：被 exportedButUnimported 调用 → 活
  assert.equal(byId('method:src/utils/dead.ts#orphanHelper').deadCandidate, true);
  assert.equal(byId('method:src/utils/dead.ts#caller').deadCandidate, false);
  // exportedButUnimported：导出但全仓库零导入且本文件零引用 → 死（导出级判定）
  const exportedFn = byId('method:src/utils/dead.ts#exportedButUnimported');
  assert.equal(exportedFn.deadCandidate, true);
  assert.equal(exportedFn.deadReason, '导出但全仓库零导入且本文件零引用');
  // 接口方法永不判死
  assert.equal(byId('method:src/types/storage.ts#IStorage#get').deadCandidate, false);
});

test('端到端：query --where 过滤 Method（用户场景 query method --all | findstr）', async () => {
  const { dataMap } = await buildFixture();
  // aos query Method --where "name~get,ownerKind=class" 等价的过滤逻辑
  // ~ 为子串匹配（与 findstr 语义一致）：getUser 同样命中 name~get
  const conditions = parseWhere('name~get,ownerKind=class');
  const result = dataMap.Method.filter((m) => matchesWhere(m, conditions));
  assert.deepEqual(result.map((m) => m.name).sort(), ['get', 'get', 'getUser']);
  // 模糊匹配接口方法 + 实现方法 + 子串命中一次全查
  const byName = parseWhere('name~get');
  const all = dataMap.Method.filter((m) => matchesWhere(m, byName));
  assert.equal(all.length, 4); // IStorage.get + LocalStorage.get + AliasedStorage.get + UserRepo.getUser
});

test('类型注册：Interface/Class/Method 已注册为 CodeUnit/L1，链接已注册', () => {
  for (const type of ['Interface', 'Class', 'Method']) {
    const meta = OBJECT_TYPES.find((t) => t.type === type);
    assert.ok(meta, `${type} 未注册`);
    assert.equal(meta.category, 'CodeUnit');
    assert.equal(meta.level, 'L1');
  }
  for (const link of ['implements', 'implementedBy', 'extends', 'extendedBy', 'overrides', 'overriddenBy']) {
    assert.ok(LINK_TYPES.includes(link), `${link} 未注册`);
  }
});
