// SQLite 快照模块测试：save / load / overlay / queryWhere / buildAskContext
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  setStorageMode,
  setSqlitePath,
  getStatus,
  openDb,
  closeDb,
  ensureSeed,
  saveSnapshot,
  loadSnapshot,
  loadType,
  loadObject,
  queryWhere,
  applyOverlay,
  buildAskContextFromSql,
  listSnapshots,
  setBlueprint,
  seedOntologyCatalog,
} from '../../src/storage/index.js';
import { setSnapshotDir } from '../../src/paths.js';
import { OBJECT_TYPES, LINK_TYPES } from '../../src/ontology/blueprint.js';

setBlueprint({ OBJECT_TYPES, LINK_TYPES });

// 每个 test 用独立 temp 目录（避免互相污染）
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aos-storage-'));
}

function makeFixture() {
  return {
    _meta: {
      generatedAt: '2026-08-26T08:00:00.000Z',
      durationMs: 100,
      analyzerVersion: '0.31.0',
      objectCounts: { Project: 1, Module: 3, SourceFile: 5, Component: 2, Hook: 1, Dependency: 2 },
      cycles: [['file:src/a.ts', 'file:src/b.ts']],
      orphanCandidates: ['file:src/orphan.ts'],
      deadExportCandidates: [],
      unmatchedFrontendCalls: [],
    },
    Project: [
      {
        id: 'proj:test', name: 'test', framework: 'react', fileCount: 5, commitHash: 'abc123', branch: 'main',
        language: 'TypeScript', frameworkLabel: 'React 19',
        architecture: { layers: [
          { key: 'shared', label: '共享层', fileCount: 4, share: 80 },
          { key: 'pages', label: '页面层', fileCount: 1, share: 20 },
        ] },
        health: { cycleCount: 1, orphanFileCount: 1, deadTypeCount: 0, deadFunctionCount: 0, deadExportCount: 0, undeclaredDependencyCount: 0 },
        capabilities: [], summary: 'test project',
      },
    ],
    Module: [
      { id: 'mod:src', path: 'src', fileCount: 4, archLayer: 'shared', archLayerLabel: '共享层' },
      { id: 'mod:src/hooks', path: 'src/hooks', fileCount: 1, archLayer: 'shared', archLayerLabel: '共享层' },
      { id: 'mod:src/pages', path: 'src/pages', fileCount: 1, archLayer: 'pages', archLayerLabel: '页面层' },
    ],
    SourceFile: [
      { id: 'file:src/index.ts', path: 'src/index.ts', lineCount: 30, moduleId: 'mod:src', layer: 'src', archLayer: 'shared' },
      { id: 'file:src/a.ts', path: 'src/a.ts', lineCount: 50, moduleId: 'mod:src', layer: 'src', archLayer: 'shared' },
      { id: 'file:src/b.ts', path: 'src/b.ts', lineCount: 40, moduleId: 'mod:src', layer: 'src', archLayer: 'shared' },
      { id: 'file:src/hooks/useX.ts', path: 'src/hooks/useX.ts', lineCount: 20, moduleId: 'mod:src/hooks', layer: 'src/hooks', archLayer: 'shared' },
      { id: 'file:src/pages/Home.tsx', path: 'src/pages/Home.tsx', lineCount: 60, moduleId: 'mod:src/pages', layer: 'src/pages', archLayer: 'pages' },
    ],
    Component: [
      { id: 'comp:Home', name: 'Home', fileId: 'file:src/pages/Home.tsx' },
      { id: 'comp:Card', name: 'Card', fileId: 'file:src/a.ts' },
    ],
    Hook: [
      { id: 'hook:useX', name: 'useX', fileId: 'file:src/hooks/useX.ts' },
    ],
    Dependency: [
      { id: 'dep:react', name: 'react', version: '^19.0.0' },
      { id: 'dep:zustand', name: 'zustand', version: '^5.0.0' },
    ],
    Domain: [],
    Store: [],
    Service: [],
    Interface: [],
    Class: [],
    Method: [],
    PropEdge: [],
    ScriptFunction: [],
    Route: [],
    UserScript: [],
    GmApiUsage: [],
    InjectionPoint: [],
    NetworkEndpoint: [],
  };
}

function setupTempStorage() {
  const dir = makeTempDir();
  setSnapshotDir(dir);
  setStorageMode('on');
  setSqlitePath(path.join(dir, 'aos.sqlite'));
  // 重置 in-memory 缓存
  closeDb();
  return dir;
}

test('storage init: 8 张表 + 账本 v1 + 本体目录种子化', () => {
  const dir = setupTempStorage();
  const db = openDb();
  assert.ok(db, 'openDb 应该返回实例');
  // 种子化是刻意延迟的（openDb 保持低层不依赖 ontology，由 ensureSeed 注入 blueprint 后执行）
  ensureSeed(db);

  // 表数量
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'aos_%' ORDER BY name").all().map((r) => r.name);
  assert.equal(tables.length, 8);
  assert.ok(tables.includes('aos_schema_history'));
  assert.ok(tables.includes('aos_types'));
  assert.ok(tables.includes('aos_link_types'));
  assert.ok(tables.includes('aos_snapshots'));
  assert.ok(tables.includes('aos_objects'));
  assert.ok(tables.includes('aos_links'));
  assert.ok(tables.includes('aos_overlays'));
  assert.ok(tables.includes('aos_mirror_state'));

  // 账本
  const v = db.prepare('SELECT * FROM aos_schema_history').get();
  assert.equal(v.version, 1);

  // 本体目录种子化
  const typeCount = db.prepare('SELECT COUNT(*) AS n FROM aos_types').get().n;
  const linkCount = db.prepare('SELECT COUNT(*) AS n FROM aos_link_types').get().n;
  assert.equal(typeCount, OBJECT_TYPES.length, `aos_types 应有 ${OBJECT_TYPES.length} 行，实际 ${typeCount}`);
  assert.equal(linkCount, LINK_TYPES.length, `aos_link_types 应有 ${LINK_TYPES.length} 行，实际 ${linkCount}`);

  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveSnapshot + loadSnapshot: roundtrip 一致', () => {
  const dir = setupTempStorage();
  // 触发种子化
  openDb();
  const dataMap = makeFixture();
  const r = saveSnapshot({ kind: 'code', snapshotDir: dir, dataMap });
  assert.equal(r.ok, true);
  assert.equal(r.snapshotId, 'code:default');

  const loaded = loadSnapshot({ kind: 'code', snapshotDir: dir });
  assert.ok(loaded, 'loadSnapshot 不应返回 null');
  // 顶层 _meta 与对象类型集合一致
  assert.equal(loaded._meta.objectCounts.Project, 1);
  assert.equal(loaded._meta.objectCounts.Module, 3);
  assert.equal(loaded._meta.cycles.length, 1);
  assert.equal(loaded.Project.length, 1);
  assert.equal(loaded.Module.length, 3);
  assert.equal(loaded.SourceFile.length, 5);
  assert.equal(loaded.Component.length, 2);
  assert.equal(loaded.Hook.length, 1);
  assert.equal(loaded.Dependency.length, 2);

  // 字段对等
  assert.equal(loaded.Project[0].name, 'test');
  assert.equal(loaded.Project[0].commitHash, 'abc123');
  assert.equal(loaded.Project[0].architecture.layers.length, 2);
  assert.equal(loaded.Module[0].path, 'src');
  assert.equal(loaded.SourceFile[0].lineCount, 30);

  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadType: 单类型查询', () => {
  const dir = setupTempStorage();
  openDb();
  saveSnapshot({ kind: 'code', snapshotDir: dir, dataMap: makeFixture() });
  const modules = loadType({ kind: 'code', snapshotDir: dir, type: 'Module' });
  assert.equal(modules.length, 3);
  assert.equal(modules[0].path, 'src');

  const deps = loadType({ kind: 'code', snapshotDir: dir, type: 'Dependency' });
  assert.equal(deps.length, 2);
  assert.deepEqual(deps.map((d) => d.name).sort(), ['react', 'zustand']);

  // 不存在的类型返回空数组
  const none = loadType({ kind: 'code', snapshotDir: dir, type: 'Method' });
  assert.ok(Array.isArray(none));
  assert.equal(none.length, 0);

  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadObject: 单对象查询（按 type+id）', () => {
  const dir = setupTempStorage();
  openDb();
  saveSnapshot({ kind: 'code', snapshotDir: dir, dataMap: makeFixture() });

  const obj = loadObject({ kind: 'code', snapshotDir: dir, type: 'SourceFile', id: 'file:src/index.ts' });
  assert.ok(obj);
  assert.equal(obj.path, 'src/index.ts');
  assert.equal(obj.lineCount, 30);

  const missing = loadObject({ kind: 'code', snapshotDir: dir, type: 'SourceFile', id: 'file:notfound.ts' });
  assert.equal(missing, null);

  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('queryWhere: 等值 / IN 条件', () => {
  const dir = setupTempStorage();
  openDb();
  saveSnapshot({ kind: 'code', snapshotDir: dir, dataMap: makeFixture() });

  // 等值
  const shared = queryWhere({ kind: 'code', snapshotDir: dir, type: 'SourceFile', where: { archLayer: 'shared' } });
  assert.equal(shared.length, 4, 'shared 层应有 4 个文件');

  // IN
  const twoModules = queryWhere({ kind: 'code', snapshotDir: dir, type: 'SourceFile', where: { moduleId: ['mod:src', 'mod:src/pages'] } });
  assert.equal(twoModules.length, 4, 'mod:src + mod:src/pages 共 4 个文件');

  // 复合条件
  const sharedHooks = queryWhere({ kind: 'code', snapshotDir: dir, type: 'SourceFile', where: { archLayer: 'shared', layer: 'src/hooks' } });
  assert.equal(sharedHooks.length, 1);
  assert.equal(sharedHooks[0].path, 'src/hooks/useX.ts');

  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('applyOverlay: 写标注 + 读路径合并', () => {
  const dir = setupTempStorage();
  openDb();
  saveSnapshot({ kind: 'code', snapshotDir: dir, dataMap: makeFixture() });

  // 写第一个 overlay
  const r1 = applyOverlay({ kind: 'code', snapshotDir: dir, type: 'SourceFile', id: 'file:src/a.ts', patch: { reviewed: true, reviewedAt: '2026-08-26T08:00:00.000Z' } });
  assert.equal(r1.ok, true);

  // 读回，overlay 应合并到对象
  const obj = loadObject({ kind: 'code', snapshotDir: dir, type: 'SourceFile', id: 'file:src/a.ts' });
  assert.equal(obj.reviewed, true);
  assert.equal(obj.reviewedAt, '2026-08-26T08:00:00.000Z');
  assert.ok(obj._overlayUpdatedAt, '应有 _overlayUpdatedAt 字段');

  // 二次 patch（增量更新；JSON Merge Patch 合并）
  const r2 = applyOverlay({ kind: 'code', snapshotDir: dir, type: 'SourceFile', id: 'file:src/a.ts', patch: { notes: '已修复循环依赖' } });
  assert.equal(r2.ok, true);
  const obj2 = loadObject({ kind: 'code', snapshotDir: dir, type: 'SourceFile', id: 'file:src/a.ts' });
  assert.equal(obj2.reviewed, true, '旧字段保留');
  assert.equal(obj2.notes, '已修复循环依赖', '新字段合并');

  // patch 中 null 表示删除
  applyOverlay({ kind: 'code', snapshotDir: dir, type: 'SourceFile', id: 'file:src/a.ts', patch: { reviewed: null } });
  const obj3 = loadObject({ kind: 'code', snapshotDir: dir, type: 'SourceFile', id: 'file:src/a.ts' });
  assert.equal(obj3.reviewed, undefined, 'null 应删除该字段');
  assert.equal(obj3.notes, '已修复循环依赖', '其他字段不受影响');

  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('applyJsonMergePatch: RFC 7396 行为', () => {
  // 改 storage/index.js 的 re-export 用法
  const { applyJsonMergePatch } = require('../../src/storage/sqliteSnapshot.js');

  // null 删除
  assert.deepEqual(applyJsonMergePatch({ a: 1, b: 2 }, { b: null }), { a: 1 });
  // 嵌套合并
  assert.deepEqual(
    applyJsonMergePatch({ a: { x: 1, y: 2 } }, { a: { y: null, z: 3 } }),
    { a: { x: 1, z: 3 } }
  );
  // 标量覆盖
  assert.deepEqual(applyJsonMergePatch({ a: 'old' }, { a: 'new' }), { a: 'new' });
  // 空对象 / 数组（数组按标量处理，不递归）
  assert.deepEqual(applyJsonMergePatch({ a: [1, 2, 3] }, { a: [4] }), { a: [4] });
  // patch 非对象
  assert.equal(applyJsonMergePatch({ a: 1 }, null), null);
  assert.deepEqual(applyJsonMergePatch(null, { a: 1 }), { a: 1 });
});

test('buildAskContextFromSql: 4 次 SQL 出精简摘要', () => {
  const dir = setupTempStorage();
  openDb();
  saveSnapshot({ kind: 'code', snapshotDir: dir, dataMap: makeFixture() });

  const ctx = buildAskContextFromSql({ kind: 'code', snapshotDir: dir, question: '架构?' });
  assert.ok(ctx);
  assert.match(ctx, /项目本体快照/);
  assert.match(ctx, /名称: test/);
  assert.match(ctx, /Commit: abc123/);
  assert.match(ctx, /共享层/);
  assert.match(ctx, /Top 10/);
  assert.match(ctx, /循环依赖: 1/);
  assert.match(ctx, /问题/);
  assert.match(ctx, /架构\?/);

  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listSnapshots: 按 kind 过滤', () => {
  const dir = setupTempStorage();
  openDb();
  saveSnapshot({ kind: 'code', snapshotDir: dir, dataMap: makeFixture() });
  saveSnapshot({ kind: 'db', snapshotDir: dir, dataMap: { _meta: {}, repositories: [{ id: 'db:1', name: 'r1' }] } });

  const all = listSnapshots({ snapshotDir: dir });
  assert.ok(all.length >= 2);
  const codeOnly = listSnapshots({ kind: 'code', snapshotDir: dir });
  assert.equal(codeOnly.length, 1);
  assert.equal(codeOnly[0].snapshot_kind, 'code');

  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveSnapshot: 二次写替换 objects（不重复）', () => {
  const dir = setupTempStorage();
  openDb();
  saveSnapshot({ kind: 'code', snapshotDir: dir, dataMap: makeFixture() });
  const first = loadType({ kind: 'code', snapshotDir: dir, type: 'Module' });
  assert.equal(first.length, 3);

  // 改 fixture 再写
  const m2 = makeFixture();
  m2.Module = [{ id: 'mod:src2', path: 'src2', fileCount: 1, archLayer: 'shared', archLayerLabel: '共享层' }];
  m2._meta.objectCounts.Module = 1;
  saveSnapshot({ kind: 'code', snapshotDir: dir, dataMap: m2 });
  const second = loadType({ kind: 'code', snapshotDir: dir, type: 'Module' });
  assert.equal(second.length, 1, '应替换而非追加');
  assert.equal(second[0].path, 'src2');

  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getStatus: 报告 driver/schema/tables/fileSize', () => {
  const dir = setupTempStorage();
  openDb();
  saveSnapshot({ kind: 'code', snapshotDir: dir, dataMap: makeFixture() });
  const status = getStatus();
  assert.equal(status.available, true);
  assert.equal(status.driver, 'better-sqlite3');
  assert.equal(status.schemaVersion, 1);
  assert.ok(status.tables.length >= 7);
  assert.ok(status.fileSize > 0);
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

// 兜底：require() 工具（applyJsonMergePatch 测试用）
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
