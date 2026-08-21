// Rust 实体测试：rustAnalyzer 事实提取（struct/enum/trait/impl/use/mod/fn）、
// use 路径跨文件解析、Tauri/Electron 客户端组件自动发现、架构层语义、实体类图视图模型
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeRustFile, resolveRustUse } from '../src/analyzers/rustAnalyzer.js';
import { scanProject } from '../src/analyzers/projectScanner.js';
import { buildOntologyData } from '../src/ontology/builder.js';
import { buildViewerModel } from '../src/ontology/viewer.js';

// ---- 单元级：rustAnalyzer 事实提取 ----

const STRUCT_FILE = [
  '#[derive(Debug, Clone, serde::Serialize)]',
  'pub struct GameInfo {',
  '    pub name: String,',
  '    pub appid: u64,',
  '}',
  '',
  'impl GameInfo {',
  '    pub fn new(name: String) -> GameInfo {',
  '        GameInfo { name, appid: 0 }',
  '    }',
  '    async fn fetch(&self) -> u64 {',
  '        self.appid',
  '    }',
  '}',
].join('\n');

test('rustAnalyzer：struct（derives/字段/impl 方法合并/语言标记）', () => {
  const facts = analyzeRustFile('src-tauri/src/models.rs', STRUCT_FILE);
  assert.equal(facts.classes.length, 1);
  const cls = facts.classes[0];
  assert.equal(cls.name, 'GameInfo');
  assert.equal(cls.exported, true);
  assert.equal(cls.kind, 'struct');
  assert.equal(cls.language, 'rust');
  assert.deepEqual(cls.derives, ['Debug', 'Clone', 'Serialize']); // serde::Serialize 取末段
  assert.deepEqual(cls.fields.map((f) => f.name), ['name', 'appid']);
  assert.equal(cls.fields[0].type, 'String');
  // impl 块方法合并进 struct
  assert.deepEqual(cls.methods.map((m) => m.name), ['new', 'fetch']);
  assert.equal(cls.methods.find((m) => m.name === 'fetch').isAsync, true);
  assert.equal(facts.exportNames.includes('GameInfo'), true);
});

test('rustAnalyzer：enum 变体 + trait 方法签名 → Interface', () => {
  const content = [
    'pub enum GameStatus {',
    '    Installed,',
    '    Running,',
    '    Uninstalled(u64),',
    '}',
    '',
    'pub trait StorageProvider: Send {',
    '    fn get(&self, key: &str) -> String;',
    '    fn put(&mut self, key: &str, value: String);',
    '}',
  ].join('\n');
  const facts = analyzeRustFile('src-tauri/src/models.rs', content);
  const enumCls = facts.classes.find((c) => c.name === 'GameStatus');
  assert.equal(enumCls.kind, 'enum');
  assert.deepEqual(enumCls.variants, ['Installed', 'Running', 'Uninstalled']);
  assert.equal(enumCls.fields.length, 0);
  // trait → Interface（含 supertrait extendsNames）
  const iface = facts.interfaces.find((i) => i.name === 'StorageProvider');
  assert.ok(iface);
  assert.equal(iface.language, 'rust');
  assert.deepEqual(iface.extendsNames, ['Send']);
  assert.deepEqual(iface.methods.map((m) => m.name), ['get', 'put']);
  assert.match(iface.methods[0].signature, /fn get\(&self, key: &str\) -> String/);
});

test('rustAnalyzer：impl Trait for Struct → implementsNames；跨文件 impl 不归属', () => {
  const content = [
    'use crate::models::StorageProvider;',
    '',
    'pub struct CacheService {',
    '    pub size: usize,',
    '}',
    '',
    'impl StorageProvider for CacheService {',
    '    fn get(&self, key: &str) -> String { String::new() }',
    '    fn put(&mut self, key: &str, value: String) {}',
    '}',
    '',
    'impl OtherCrateTrait for ForeignStruct {',
    '    fn m(&self) {}',
    '}',
  ].join('\n');
  const facts = analyzeRustFile('src-tauri/src/services.rs', content);
  const cache = facts.classes.find((c) => c.name === 'CacheService');
  assert.ok(cache);
  assert.deepEqual(cache.implementsNames, ['StorageProvider']);
  assert.deepEqual(cache.methods.map((m) => m.name), ['get', 'put']);
  // ForeignStruct 不在本文件声明 → 跨文件 impl 方法不归属任何类
  const foreign = facts.classes.find((c) => c.name === 'ForeignStruct');
  assert.equal(foreign, undefined);
  // use 声明进 importMap（crate::models::StorageProvider）
  assert.equal(facts.importMap.get('StorageProvider'), 'crate::models::StorageProvider');
  assert.equal(facts.imports.length, 1);
});

test('rustAnalyzer：use 语句（具名/花括组/别名/通配）与模块函数', () => {
  const content = [
    'use crate::models::GameInfo;',
    'use crate::models::{GameStatus, GameTag as Tag};',
    'use crate::db::*;',
    'mod models;',
    '',
    'pub fn load_game() -> GameInfo { todo!() }',
    'fn private_helper() {}',
  ].join('\n');
  const facts = analyzeRustFile('src-tauri/src/main.rs', content);
  assert.equal(facts.importMap.get('GameInfo'), 'crate::models::GameInfo');
  assert.equal(facts.importMap.get('GameStatus'), 'crate::models::GameStatus');
  assert.equal(facts.importMap.get('Tag'), 'crate::models::GameTag');
  assert.equal(facts.importMap.get('*'), 'crate::db::*');
  assert.deepEqual(facts.rustMods, ['models']);
  assert.deepEqual(facts.moduleFunctions.map((f) => f.name), ['load_game', 'private_helper']);
  assert.equal(facts.moduleFunctions.find((f) => f.name === 'load_game').exported, true);
  assert.equal(facts.moduleFunctions.find((f) => f.name === 'private_helper').exported, false);
});

// ---- 单元级：resolveRustUse（use 路径 → 目标文件）----

test('resolveRustUse：crate 路径 / super 相对路径 / 外部 crate', () => {
  const rustFiles = new Set([
    'src-tauri/src/models.rs',
    'src-tauri/src/db/schema.rs',
    'src-tauri/src/services.rs',
  ]);
  // crate::models::GameInfo → models.rs（末段是类型名）
  assert.deepEqual(resolveRustUse('src-tauri/src/services.rs', 'crate::models::GameInfo', rustFiles), {
    kind: 'internal', file: 'src-tauri/src/models.rs', importedName: 'GameInfo',
  });
  // crate::db::schema → 模块路径文件（无类型名段 → 通配语义）
  assert.deepEqual(resolveRustUse('src-tauri/src/services.rs', 'crate::db::schema', rustFiles), {
    kind: 'internal', file: 'src-tauri/src/db/schema.rs', importedName: '*',
  });
  // crate::services → 文件自身（无剩余名段）
  assert.deepEqual(resolveRustUse('src-tauri/src/services.rs', 'crate::services', rustFiles), {
    kind: 'internal', file: 'src-tauri/src/services.rs', importedName: '*',
  });
  // super 相对路径：db/schema.rs（模块 db::schema）中 super::super::models::GameInfo → crate 根下 models.rs
  assert.deepEqual(resolveRustUse('src-tauri/src/db/schema.rs', 'super::super::models::GameInfo', rustFiles), {
    kind: 'internal', file: 'src-tauri/src/models.rs', importedName: 'GameInfo',
  });
  // 非 crate/super/self 前缀 → 外部 crate（serde 等，不进 npm 依赖体系）
  assert.deepEqual(resolveRustUse('src-tauri/src/services.rs', 'serde::Serialize', rustFiles), {
    kind: 'external', package: 'serde',
  });
});

// ---- 端到端：Tauri + Electron 客户端组件自动发现与实体构建 ----

const MODELS_RS = [
  '#[derive(Debug, Clone)]',
  'pub struct GameInfo {',
  '    pub name: String,',
  '    pub appid: u64,',
  '}',
  '',
  'pub enum GameStatus {',
  '    Installed,',
  '    Running,',
  '}',
  '',
  'pub trait StorageProvider {',
  '    fn get(&self, key: &str) -> String;',
  '    fn put(&mut self, key: &str, value: String);',
  '}',
  '',
  'struct UnusedStruct {',
  '    x: i32,',
  '}',
].join('\n');

const SERVICES_RS = [
  'use crate::models::StorageProvider;',
  'use crate::models::{GameInfo, GameStatus};',
  '',
  'pub struct CacheService {',
  '    pub game: GameInfo,',
  '    pub status: GameStatus,',
  '}',
  '',
  'impl CacheService {',
  '    pub fn new() -> CacheService {',
  '        CacheService { game: GameInfo { name: String::new(), appid: 0 }, status: GameStatus::Installed }',
  '    }',
  '}',
  '',
  'impl StorageProvider for CacheService {',
  '    fn get(&self, key: &str) -> String { String::new() }',
  '    fn put(&mut self, key: &str, value: String) {}',
  '}',
].join('\n');

const MAIN_RS = [
  'mod models;',
  'mod services;',
  '',
  'use crate::services::CacheService;',
  '',
  'fn main() {',
  '    let svc = CacheService::new();',
  '    println!("{}", svc.get("k"));',
  '}',
].join('\n');

const STORAGE_TS = [
  'export interface IStorage {',
  '  get(key: string): string | null;',
  '  set(key: string, value: string): void;',
  '}',
  'export class LocalStorage implements IStorage {',
  '  get(key: string): string | null { return null; }',
  '  set(key: string, value: string): void {}',
  '}',
  'export const storage: LocalStorage = new LocalStorage();',
].join('\n');

const MAIN_TSX = [
  "import { storage } from './storage';",
  'console.log(storage);',
].join('\n');

const ELECTRON_MAIN_TS = [
  'export class WindowManager {',
  '  createWindow(): void {}',
  '}',
  'export const wm = new WindowManager();',
].join('\n');

async function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-rust-'));
  fs.mkdirSync(path.join(dir, 'src-tauri/src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'electron'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tauri-demo', dependencies: { react: '^18.0.0' } }));
  fs.writeFileSync(path.join(dir, 'src-tauri/tauri.conf.json'), JSON.stringify({ productName: 'demo' }));
  fs.writeFileSync(path.join(dir, 'src-tauri/src/main.rs'), MAIN_RS);
  fs.writeFileSync(path.join(dir, 'src-tauri/src/models.rs'), MODELS_RS);
  fs.writeFileSync(path.join(dir, 'src-tauri/src/services.rs'), SERVICES_RS);
  fs.writeFileSync(path.join(dir, 'src/storage.ts'), STORAGE_TS);
  fs.writeFileSync(path.join(dir, 'src/main.tsx'), MAIN_TSX);
  fs.writeFileSync(path.join(dir, 'electron/main.ts'), ELECTRON_MAIN_TS);
  const dataMap = await buildOntologyData(dir);
  return { dir, dataMap };
}

test('扫描：Tauri/Electron 客户端组件自动发现（src-tauri/src + electron 纳入扫描）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-scan-'));
  fs.mkdirSync(path.join(dir, 'src-tauri/src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'electron'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src-tauri/tauri.conf.json'), '{}');
  fs.writeFileSync(path.join(dir, 'src-tauri/src/main.rs'), 'fn main() {}');
  fs.writeFileSync(path.join(dir, 'src/app.ts'), 'export const x = 1;');
  fs.writeFileSync(path.join(dir, 'electron/main.ts'), 'export const y = 2;');
  const scan = scanProject(dir);
  assert.ok(scan.files.includes('src-tauri/src/main.rs'));
  assert.ok(scan.files.includes('electron/main.ts'));
  assert.ok(scan.files.includes('src/app.ts'));
  assert.equal(scan.rustFileCount, 1);
  assert.equal(scan.tauriDetected, true);
  assert.equal(scan.electronDetected, true);
  assert.ok(scan.frameworkVariants.includes('tauri'));
  assert.ok(scan.frameworkVariants.includes('electron'));
});

test('端到端：Rust 实体入快照（kind/language/fields/variants/derives）', async () => {
  const { dataMap } = await buildFixture();
  const gameInfo = dataMap.Class.find((c) => c.name === 'GameInfo');
  assert.ok(gameInfo, 'GameInfo 应被提取为 Class 实体');
  assert.equal(gameInfo.kind, 'struct');
  assert.equal(gameInfo.language, 'rust');
  assert.deepEqual(gameInfo.derives, ['Debug', 'Clone']);
  assert.equal(gameInfo.fields.length, 2);
  assert.equal(gameInfo.archLayer, 'tauri');
  const gameStatus = dataMap.Class.find((c) => c.name === 'GameStatus');
  assert.equal(gameStatus.kind, 'enum');
  assert.deepEqual(gameStatus.variants, ['Installed', 'Running']);
  const provider = dataMap.Interface.find((i) => i.name === 'StorageProvider');
  assert.equal(provider.language, 'rust');
  assert.equal(provider.methodIds.length, 2);
  assert.equal(provider.archLayer, 'tauri');
  // Rust impl fn → Method（owner 为 CacheService）
  const cacheGet = dataMap.Method.find((m) => m.id === 'method:src-tauri/src/services.rs#CacheService#get');
  assert.ok(cacheGet);
  // Electron 组件：archLayer = electron
  const wm = dataMap.Class.find((c) => c.name === 'WindowManager');
  assert.equal(wm.language, 'ts');
  assert.equal(wm.archLayer, 'electron');
  // 项目画像：Rust 文件计数与语言标注
  const proj = dataMap.Project[0];
  assert.equal(proj.rustFileCount, 3);
  assert.ok(proj.frameworkVariants.includes('tauri'));
  assert.ok(proj.frameworkVariants.includes('electron'));
});

test('端到端：跨文件 implements 解析（use 路径为主 + 接口方法 overrides）', async () => {
  const { dataMap } = await buildFixture();
  const cache = dataMap.Class.find((c) => c.name === 'CacheService');
  const providerId = 'iface:src-tauri/src/models.rs#StorageProvider';
  assert.deepEqual(cache.implementsNames, ['StorageProvider']);
  assert.deepEqual(cache.implementsIds, [providerId]); // use crate::models::StorageProvider 解析
  // 方法级 overrides：CacheService.get ↔ StorageProvider.get
  const implGet = dataMap.Method.find((m) => m.id === 'method:src-tauri/src/services.rs#CacheService#get');
  const ifaceGet = dataMap.Method.find((m) => m.id === 'method:src-tauri/src/models.rs#StorageProvider#get');
  assert.equal(implGet.overridesId, ifaceGet.id);
  assert.deepEqual(ifaceGet.overriddenByIds, [implGet.id]);
});

test('端到端：Rust 死代码候选（本文件零引用）与活实体豁免', async () => {
  const { dataMap } = await buildFixture();
  const unused = dataMap.Class.find((c) => c.name === 'UnusedStruct');
  assert.equal(unused.deadCandidate, true);
  assert.equal(unused.deadReason, '本文件内零引用');
  // 被跨文件 use 引用 + impl 块引用的实体不判死
  const gameInfo = dataMap.Class.find((c) => c.name === 'GameInfo');
  assert.equal(gameInfo.deadCandidate, false);
  const cache = dataMap.Class.find((c) => c.name === 'CacheService');
  assert.equal(cache.deadCandidate, false);
  const provider = dataMap.Interface.find((i) => i.name === 'StorageProvider');
  assert.equal(provider.deadCandidate, false);
});

test('端到端：实体类图视图模型（跨语言 nodes/edges + 语言分布）', async () => {
  const { dataMap } = await buildFixture();
  const model = buildViewerModel(dataMap);
  const E = model.entities;
  assert.ok(E, 'entities 视图模型应存在');
  assert.ok(E.totalCount >= 8);
  assert.ok(E.graph.nodes.length > 0);
  // 跨语言两类边：TS LocalStorage→IStorage 与 Rust CacheService→StorageProvider
  const edgeKeys = E.graph.edges.map((e) => e.kind + ':' + e.from + '>' + e.to);
  assert.ok(edgeKeys.includes('implements:class:src-tauri/src/services.rs#CacheService>iface:src-tauri/src/models.rs#StorageProvider'));
  assert.ok(edgeKeys.includes('implements:class:src/storage.ts#LocalStorage>iface:src/storage.ts#IStorage'));
  // 语言分布：ts 与 rust 并存
  const langs = Object.fromEntries(E.byLanguage.map((l) => [l.key, l.count]));
  assert.ok(langs.rust >= 4, 'Rust 实体（GameInfo/GameStatus/CacheService/UnusedStruct + trait）');
  assert.ok(langs.ts >= 2);
  // 图节点携带成员明细；清单行携带计数
  const cacheNode = E.graph.nodes.find((n) => n.name === 'CacheService');
  assert.ok(cacheNode);
  assert.equal(cacheNode.language, 'rust');
  assert.equal(cacheNode.kind, 'struct');
  assert.ok(cacheNode.methods.length > 0);
  const row = E.table.find((r) => r.name === 'GameInfo');
  assert.equal(row.kind, 'struct');
  assert.equal(row.fieldCount, 2);
});
