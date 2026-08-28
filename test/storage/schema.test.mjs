// Schema 迁移测试：v0.37 v1→v2 升级路径
//   覆盖：
//   1. 全新 v0.37 库：账本 v2 + 10 张表 + 索引齐全
//   2. v0.31 风格老库（无 pk_hash / 无 type_properties）→ 自动迁移到 v2
//   3. 老库 backfill content_hash / pk_hash 正确性
//   4. type_properties 种子化数量
//   5. import_jobs 表结构可写
//   6. link_types 4 字段扩列已就位
//   7. pk_hash 在跨 snapshot 时一致（v0.38 基础）
//   8. content_hash 一致（同一对象跨两次 save）

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  setStorageMode,
  setSqlitePath,
  openDb,
  closeDb,
  ensureSeed,
  saveSnapshot,
  loadSnapshot,
  loadType,
  computeContentHash,
  computePkHash,
  applyPendingMigrations,
  getStatus,
  SCHEMA_VERSION,
} from '../../src/storage/index.js';
import { setSnapshotDir } from '../../src/paths.js';
import { OBJECT_TYPES, LINK_TYPES } from '../../src/ontology/blueprint.js';
import { setBlueprint } from '../../src/storage/index.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

setBlueprint({ OBJECT_TYPES, LINK_TYPES });

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aos-schema-'));
}

function setupTempStorage() {
  const dir = makeTempDir();
  setSnapshotDir(dir);
  setStorageMode('on');
  setSqlitePath(path.join(dir, 'aos.sqlite'));
  closeDb();
  return dir;
}

function makeFixture() {
  return {
    _meta: { generatedAt: '2026-08-28T08:00:00.000Z', analyzerVersion: '0.37.0', objectCounts: { Module: 2, SourceFile: 3 } },
    Module: [
      { id: 'mod:src',     path: 'src',     fileCount: 2, archLayer: 'shared' },
      { id: 'mod:src/hooks', path: 'src/hooks', fileCount: 1, archLayer: 'shared' },
    ],
    SourceFile: [
      { id: 'file:src/a.ts',   path: 'src/a.ts',   lineCount: 10, moduleId: 'mod:src', archLayer: 'shared' },
      { id: 'file:src/b.ts',   path: 'src/b.ts',   lineCount: 20, moduleId: 'mod:src', archLayer: 'shared' },
      { id: 'file:src/hooks/x.ts', path: 'src/hooks/x.ts', lineCount: 5, moduleId: 'mod:src/hooks', archLayer: 'shared' },
    ],
  };
}

test('全新安装：账本 v2 + 10 张表 + 索引齐全', () => {
  const dir = setupTempStorage();
  openDb();

  const tables = openDb().prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'aos_%' ORDER BY name"
  ).all().map((r) => r.name);
  assert.equal(tables.length, 10, `应 10 张表，实际 ${tables.length}：${tables.join(', ')}`);

  // 索引
  const indexes = openDb().prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_aos_%' ORDER BY name"
  ).all().map((r) => r.name);
  assert.ok(indexes.includes('idx_aos_objects_pk_hash'), '应含 pk_hash 索引（v0.37 非 UNIQUE，v0.38 拆 manifest 时升 PK）');
  assert.ok(indexes.includes('idx_aos_objects_content_hash'), '应含 content_hash 索引');
  assert.ok(indexes.includes('idx_aos_type_properties_type'), '应含 type_properties type 索引');
  assert.ok(indexes.includes('idx_aos_import_jobs_status'), '应含 import_jobs status 索引');

  // 账本
  const ver = openDb().prepare('SELECT MAX(version) AS v FROM aos_schema_history').get().v;
  assert.equal(ver, SCHEMA_VERSION, `账本应为 v${SCHEMA_VERSION}，实际 v${ver}`);

  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('v0.31 老库 (无 pk_hash 列) → 自动升级到 v2 + backfill', () => {
  const dir = setupTempStorage();
  const dbPath = path.join(dir, 'aos.sqlite');

  // 1) 用 better-sqlite3 手工建 v0.31 风格库
  fs.mkdirSync(dir, { recursive: true });
  const oldDb = new Database(dbPath);
  oldDb.exec(`
    CREATE TABLE aos_schema_history (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, description TEXT NOT NULL, checksum TEXT NOT NULL);
    CREATE TABLE aos_types (type_name TEXT PRIMARY KEY, category TEXT NOT NULL, level TEXT NOT NULL, prefix TEXT NOT NULL, description TEXT);
    CREATE TABLE aos_link_types (link_type TEXT PRIMARY KEY, inverse_of TEXT, is_transitive INTEGER NOT NULL DEFAULT 0, description TEXT);
    CREATE TABLE aos_snapshots (snapshot_id TEXT PRIMARY KEY, snapshot_kind TEXT NOT NULL, project_name TEXT, commit_hash TEXT, branch TEXT, analyzer_version TEXT NOT NULL, generated_at TEXT NOT NULL, duration_ms INTEGER, is_current INTEGER NOT NULL DEFAULT 1, object_counts TEXT NOT NULL, meta_extra TEXT, CHECK (is_current IN (0, 1)));
    CREATE TABLE aos_objects (snapshot_id TEXT NOT NULL, type TEXT NOT NULL, id TEXT NOT NULL, content_hash TEXT, props_json TEXT NOT NULL, PRIMARY KEY (snapshot_id, type, id));
    CREATE TABLE aos_links (snapshot_id TEXT NOT NULL, link_type TEXT NOT NULL, src_type TEXT NOT NULL, src_id TEXT NOT NULL, tgt_type TEXT NOT NULL, tgt_id TEXT NOT NULL, PRIMARY KEY (snapshot_id, link_type, src_type, src_id, tgt_type, tgt_id));
    CREATE TABLE aos_overlays (snapshot_id TEXT NOT NULL, object_type TEXT NOT NULL, object_id TEXT NOT NULL, props_patch TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (snapshot_id, object_type, object_id));
    CREATE TABLE aos_mirror_state (snapshot_kind TEXT PRIMARY KEY, mirrored_json_mtime_ms INTEGER NOT NULL);
  `);
  // 写 v0.31 账本
  oldDb.prepare('INSERT INTO aos_schema_history (version, applied_at, description, checksum) VALUES (?, ?, ?, ?)')
    .run(1, '2026-08-26T00:00:00.000Z', 'Phase A baseline v1', 'oldlibcchecksum0');
  // 插 v0.31 风格对象（content_hash=NULL，pk_hash 列不存在）
  oldDb.prepare('INSERT INTO aos_snapshots (snapshot_id, snapshot_kind, analyzer_version, generated_at, object_counts) VALUES (?, ?, ?, ?, ?)')
    .run('code:default', 'code', '0.31.0', '2026-08-26T00:00:00.000Z', '{"Module": 2}');
  const projJson = JSON.stringify({ id: 'proj:old', name: 'old-lib' });
  const modJson = JSON.stringify({ id: 'mod:src', path: 'src' });
  oldDb.prepare('INSERT INTO aos_objects (snapshot_id, type, id, content_hash, props_json) VALUES (?, ?, ?, NULL, ?)')
    .run('code:default', 'Project', 'proj:old', projJson);
  oldDb.prepare('INSERT INTO aos_objects (snapshot_id, type, id, content_hash, props_json) VALUES (?, ?, ?, NULL, ?)')
    .run('code:default', 'Module', 'mod:src', modJson);
  oldDb.close();

  // 2) 用 v0.37 启动 → 应自动跑 v2 migration + backfill
  setStorageMode('on');
  setSqlitePath(dbPath);
  const db = openDb();
  assert.ok(db, 'v0.37 应能打开老库');
  ensureSeed(db);

  // 账本已升级到 v2
  const v = db.prepare('SELECT MAX(version) AS v FROM aos_schema_history').get().v;
  assert.equal(v, 2, '账本应升级到 v2');

  // pk_hash 列已加 + 已 backfill
  const rows = db.prepare("SELECT type, id, content_hash, pk_hash FROM aos_objects WHERE snapshot_id = 'code:default' ORDER BY type").all();
  assert.equal(rows.length, 2, `应 2 行老对象，实际 ${rows.length}`);
  for (const row of rows) {
    assert.ok(row.content_hash && row.content_hash.length === 64, `content_hash 应 64 字符：${row.content_hash}`);
    assert.ok(row.pk_hash && row.pk_hash.length === 64, `pk_hash 应 64 字符：${row.pk_hash}`);
    // 验证 hash 与应用层一致
    const originalJson = row.type === 'Project' ? projJson : modJson;
    const expectedContent = computeContentHash(originalJson);
    assert.equal(row.content_hash, expectedContent, `${row.type} content_hash 应与重新计算一致`);
    const expectedPk = computePkHash(row.type, row.id, row.content_hash);
    assert.equal(row.pk_hash, expectedPk, `${row.type} pk_hash 应与重新计算一致`);
  }

  // 新表已建
  const tableNames = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'aos_%' ORDER BY name"
  ).all().map((r) => r.name);
  assert.ok(tableNames.includes('aos_type_properties'), 'aos_type_properties 应已建');
  assert.ok(tableNames.includes('aos_import_jobs'), 'aos_import_jobs 应已建');

  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backfill：content_hash 和 pk_hash 跨 snapshot 一致（同对象去重基线）', () => {
  const dir = setupTempStorage();
  const db = openDb();

  // 1) 写 snapshot A（含 obj1 / obj2）
  const a = makeFixture();
  saveSnapshot({ kind: 'code', snapshotDir: dir, dataMap: a });

  // 2) 写 snapshot B（含 obj1 / obj2 同源 + obj3 新增）
  const b = makeFixture();
  b._meta = { ...a._meta, generatedAt: '2026-08-28T09:00:00.000Z', objectCounts: { Module: 1, SourceFile: 1 } };
  b.Module = a.Module.slice(0, 1);
  b.SourceFile = [a.SourceFile[0]];
  // 改写 snapshotId 让其与 a 不同
  saveSnapshot({ kind: 'db', snapshotDir: dir, dataMap: b });

  // 验证：同 (type, id, content_hash) 的对象 pk_hash 一致
  const codeObj = db.prepare("SELECT type, id, content_hash, pk_hash FROM aos_objects WHERE snapshot_id = 'code:default' AND type = 'Module'").get();
  const dbObj = db.prepare("SELECT type, id, content_hash, pk_hash FROM aos_objects WHERE snapshot_id = 'db:default' AND type = 'Module'").get();
  assert.ok(codeObj && dbObj);
  // 不同 kind 用不同 snapshot_id，但同 Module 对象如果 props 相同，pk_hash 应一致（v0.38 跨 snapshot 去重基线）
  assert.equal(codeObj.content_hash, dbObj.content_hash, '相同 props 跨 snapshot 的 content_hash 应一致');
  assert.equal(codeObj.pk_hash, dbObj.pk_hash, '相同 (type,id,content_hash) 的 pk_hash 应一致');

  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('aos_type_properties 种子化覆盖主要对象类型', () => {
  const dir = setupTempStorage();
  const db = openDb();
  ensureSeed(db);

  const propCount = db.prepare('SELECT COUNT(*) AS n FROM aos_type_properties').get().n;
  assert.ok(propCount > 50, `应 > 50 条属性，实际 ${propCount}`);

  // Project 应至少有 id / name / framework / fileCount / commitHash
  const projectProps = db.prepare(
    "SELECT `key`, wire_type FROM aos_type_properties WHERE type_name = 'Project' ORDER BY `key`"
  ).all();
  const keys = projectProps.map((r) => r.key);
  assert.ok(keys.includes('id'));
  assert.ok(keys.includes('name'));
  assert.ok(keys.includes('framework'));
  assert.ok(keys.includes('fileCount'));

  // SourceFile 应有 path / lineCount / moduleId / archLayer
  const sfProps = db.prepare(
    "SELECT `key` FROM aos_type_properties WHERE type_name = 'SourceFile' ORDER BY `key`"
  ).all().map((r) => r.key);
  assert.ok(sfProps.includes('path'));
  assert.ok(sfProps.includes('lineCount'));
  assert.ok(sfProps.includes('moduleId'));

  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('aos_link_types 4 字段扩列已就位 + axiom 种子化', () => {
  const dir = setupTempStorage();
  const db = openDb();
  ensureSeed(db);

  const cols = db.prepare("PRAGMA table_info(aos_link_types)").all().map((c) => c.name);
  assert.ok(cols.includes('label'), '应含 label');
  assert.ok(cols.includes('src_type'), '应含 src_type');
  assert.ok(cols.includes('tgt_type'), '应含 tgt_type');
  assert.ok(cols.includes('cardinality'), '应含 cardinality');

  // contains / calls 链接类型应有 axiom
  const contains = db.prepare("SELECT * FROM aos_link_types WHERE link_type = 'contains'").get();
  assert.ok(contains);
  assert.equal(contains.label, '包含');
  assert.equal(contains.src_type, 'Container');
  assert.equal(contains.tgt_type, 'CodeUnit');
  assert.equal(contains.cardinality, '1..*');

  const calls = db.prepare("SELECT * FROM aos_link_types WHERE link_type = 'calls'").get();
  assert.ok(calls);
  assert.equal(calls.src_type, 'Method');
  assert.equal(calls.tgt_type, 'Method');

  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('aos_import_jobs 表结构可写（占位表不接 parser 也能 CRUD）', () => {
  const dir = setupTempStorage();
  const db = openDb();

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO aos_import_jobs (job_id, job_kind, steps, \`cursor\`, status, started_at)
    VALUES (?, 'refreshRepo', '[]', '{}', 'running', ?)
  `).run('job-test-001', now);

  const row = db.prepare("SELECT * FROM aos_import_jobs WHERE job_id = 'job-test-001'").get();
  assert.ok(row);
  assert.equal(row.job_kind, 'refreshRepo');
  assert.equal(row.status, 'running');

  // 状态 CHECK 约束：非法值应报错
  assert.throws(() => {
    db.prepare("UPDATE aos_import_jobs SET status = 'bogus' WHERE job_id = 'job-test-001'").run();
  }, /CHECK constraint failed/);

  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveSnapshot 后 content_hash / pk_hash 落地且 hash 稳定', () => {
  const dir = setupTempStorage();
  const db = openDb();
  saveSnapshot({ kind: 'code', snapshotDir: dir, dataMap: makeFixture() });

  const rows = db.prepare(
    "SELECT type, id, content_hash, pk_hash, props_json FROM aos_objects WHERE snapshot_id = 'code:default' ORDER BY type, id"
  ).all();

  for (const row of rows) {
    // 应用层重算应一致
    assert.equal(row.content_hash, computeContentHash(row.props_json), `${row.id} content_hash 应稳定`);
    assert.equal(row.pk_hash, computePkHash(row.type, row.id, row.content_hash), `${row.id} pk_hash 应稳定`);
  }

  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('二次 saveSnapshot 后 content_hash 复用（对象未变）', () => {
  const dir = setupTempStorage();
  const db = openDb();
  saveSnapshot({ kind: 'code', snapshotDir: dir, dataMap: makeFixture() });
  const first = db.prepare(
    "SELECT type, id, content_hash FROM aos_objects WHERE snapshot_id = 'code:default' AND type = 'Module' ORDER BY id"
  ).all();

  // 立即重写同一 fixture
  saveSnapshot({ kind: 'code', snapshotDir: dir, dataMap: makeFixture() });
  const second = db.prepare(
    "SELECT type, id, content_hash FROM aos_objects WHERE snapshot_id = 'code:default' AND type = 'Module' ORDER BY id"
  ).all();

  assert.deepEqual(first, second, '同 fixture 二次写 hash 应一致');

  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('computePkHash 公式：5 字段顺序敏感（tenant|domain|type|id|content_hash）', () => {
  const h1 = computePkHash('Module', 'mod:src', 'abc123');
  const h2 = computePkHash('Module', 'mod:src', 'abc123');
  const h3 = computePkHash('Module', 'mod:dst', 'abc123');    // id 不同
  const h4 = computePkHash('Class', 'mod:src', 'abc123');     // type 不同
  const h5 = computePkHash('Module', 'mod:src', 'abc124');    // content 不同

  assert.equal(h1, h2, '同输入应得同 hash');
  assert.notEqual(h1, h3, 'id 不同应得不同 hash');
  assert.notEqual(h1, h4, 'type 不同应得不同 hash');
  assert.notEqual(h1, h5, 'content 不同应得不同 hash');
  assert.equal(h1.length, 64, 'sha256 hex 64 字符');
});

test('getStatus 报告 schemaVersion=2 + 10 张表', () => {
  const dir = setupTempStorage();
  openDb();
  const status = getStatus();
  assert.equal(status.schemaVersion, 2);
  assert.equal(status.tables.length, 10);
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadSnapshot 走新表仍正确返回 DataMap（无 hash 字段泄漏到对象）', () => {
  const dir = setupTempStorage();
  const db = openDb();
  saveSnapshot({ kind: 'code', snapshotDir: dir, dataMap: makeFixture() });
  const loaded = loadSnapshot({ kind: 'code', snapshotDir: dir });
  assert.ok(loaded);
  assert.equal(loaded.Module.length, 2);
  // 业务对象不应有 content_hash / pk_hash 字段（内部存储元数据）
  for (const m of loaded.Module) {
    assert.equal(m.content_hash, undefined, 'Module 不应泄漏 content_hash');
    assert.equal(m.pk_hash, undefined, 'Module 不应泄漏 pk_hash');
  }
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});
