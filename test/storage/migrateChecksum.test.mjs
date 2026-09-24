// v0.47 迁移校验和测试（借鉴 Flyway checksum：已应用的迁移被改过即硬错）：
// 用假 db 覆盖校验/采纳/报错路径，不依赖 better-sqlite3（optionalDependency 环境可跑）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPendingMigrations, checksumOf, legacyChecksumOf, MIGRATIONS,
} from '../../src/storage/migrate.js';

// 最小假 db：aos_schema_history 查询返回注入行；其余 SQL（v2 的 up/backfill）走安全空集
function fakeDb(historyRows) {
  const ops = [];
  const db = {
    transaction: (fn) => () => fn(),
    exec: (sql) => ops.push(['exec', sql]),
    prepare: (sql) => ({
      all: () => (sql.includes('aos_schema_history') ? historyRows.map((r) => ({ ...r })) : []),
      get: (/* args */) => (sql.includes('aos_schema_history') ? { v: historyRows.at(-1)?.version ?? 0 } : {}),
      run: (...args) => ops.push(['run', sql, args]),
    }),
    ops,
  };
  return db;
}

test('checksumOf 绑定 up 源码；legacy 绑定描述；up 变化 → 校验和变化', () => {
  const mig = MIGRATIONS[0];
  assert.equal(checksumOf(mig).length, 16);
  assert.notEqual(checksumOf(mig), legacyChecksumOf(mig));
  const edited = { ...mig, up: () => { /* changed */ } };
  assert.notEqual(checksumOf(edited), checksumOf(mig));
  const renamed = { ...mig, description: 'other' };
  assert.equal(checksumOf(renamed), checksumOf(mig), '描述变化不影响新口径');
});

test('空账本：应用全部迁移并按新口径写入 checksum', () => {
  const db = fakeDb([]);
  const r = applyPendingMigrations(db);
  assert.equal(r.applied, MIGRATIONS.length);
  const inserts = db.ops.filter(([kind, sql]) => kind === 'run' && sql.includes('INSERT INTO aos_schema_history'));
  assert.equal(inserts.length, MIGRATIONS.length);
  // 每条 INSERT 的 checksum 实参 = checksumOf(对应迁移)
  MIGRATIONS.forEach((mig, i) => {
    assert.equal(inserts[i][2][3], checksumOf(mig), `v${mig.version} checksum`);
  });
});

test('新口径账本：校验通过，零更新', () => {
  const rows = MIGRATIONS.map((m) => ({ version: m.version, checksum: checksumOf(m) }));
  const db = fakeDb(rows);
  const r = applyPendingMigrations(db);
  assert.equal(r.applied, 0);
  assert.equal(db.ops.length, 0, '不应有任何写操作');
});

test('旧口径账本（v0.31-v0.46）：一次性采纳新口径，不报错', () => {
  const rows = MIGRATIONS.map((m) => ({ version: m.version, checksum: legacyChecksumOf(m) }));
  const db = fakeDb(rows);
  const r = applyPendingMigrations(db);
  assert.equal(r.applied, 0);
  const updates = db.ops.filter(([kind, sql]) => kind === 'run' && sql.includes('UPDATE aos_schema_history'));
  assert.equal(updates.length, MIGRATIONS.length, '每行账本采纳一次');
  MIGRATIONS.forEach((mig, i) => {
    assert.equal(updates[i][2][0], checksumOf(mig));
  });
});

test('账本损坏（up 被改过）：硬错并给出修复指引', () => {
  const rows = MIGRATIONS.map((m) => ({ version: m.version, checksum: checksumOf(m) }));
  rows[0].checksum = 'deadbeefdeadbeef';
  const db = fakeDb(rows);
  assert.throws(
    () => applyPendingMigrations(db),
    (err) => err.message.includes('校验和不匹配') && err.message.includes('storage rebuild'),
  );
});
