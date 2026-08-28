// 迁移管理器（D14 简化版，单进程内账本）
// 启动时调用：openDb() 内部已用 schema.sql + aos_schema_history 完成基础账本。
// v0.37+：v2 块负责 aos_objects 加 pk_hash / 2 索引、aos_link_types 加 4 字段、
// 新增 aos_type_properties / aos_import_jobs，并 backfill 老库 content_hash / pk_hash

import crypto from 'node:crypto';

// 计算 content_hash（与 sqliteSnapshot.js saveSnapshot 同形）
//   注意：无 sort-key 规范化，直接对 JSON.stringify 原始串做 sha256（key 顺序敏感，
//   依赖 analyzer 构造对象字段顺序稳定）；caller 传入的须是存储时的 props_json 字符串
function computeContentHash(propsJson) {
  return crypto.createHash('sha256').update(String(propsJson || '')).digest('hex');
}

// 计算 pk_hash：sha256(`default|default|${type}|${id}|${content_hash}`)
//   借鉴 asdm-aos 决策 2b：pk_hash = sha256(tenant_id|domain_id|type|id|content_hash)
//   nice-aos 单进程单用户：tenant/domain 固定 'default' 占位，保留未来扩展位
function computePkHash(type, id, contentHash) {
  return crypto.createHash('sha256')
    .update(`default|default|${type}|${id}|${contentHash}`)
    .digest('hex');
}

// v1 → v2 backfill：对 aos_objects 已有行（content_hash=NULL）回填
//   分批 SELECT 500 行/批，但整个 backfill 在单个事务内提交（本地 CLI 规模可接受；
//   持锁时长 ∝ 待回填行数，超大库如需分批提交再演进）
//   不存在老表 / 无行时秒返回
function backfillContentAndPkHash(db) {
  // 检测：aos_objects 表是否存在
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='aos_objects'"
  ).get();
  if (!exists) return { backfilled: 0 };

  // 检测：是否仍有 content_hash 为 NULL 的行（v0.31 老库状态）
  const pending = db.prepare(
    "SELECT COUNT(*) AS n FROM aos_objects WHERE content_hash IS NULL OR pk_hash IS NULL"
  ).get().n;
  if (pending === 0) return { backfilled: 0 };

  const select = db.prepare(
    "SELECT rowid, type, id, props_json FROM aos_objects WHERE content_hash IS NULL OR pk_hash IS NULL LIMIT 500"
  );
  const update = db.prepare(
    "UPDATE aos_objects SET content_hash = ?, pk_hash = ? WHERE rowid = ?"
  );

  const tx = db.transaction(() => {
    let total = 0;
    while (true) {
      const rows = select.all();
      if (rows.length === 0) break;
      for (const row of rows) {
        const contentHash = computeContentHash(row.props_json);
        const pkHash = computePkHash(row.type, row.id, contentHash);
        update.run(contentHash, pkHash, row.rowid);
        total += 1;
      }
    }
    return total;
  });
  const backfilled = tx();
  return { backfilled };
}

// 迁移脚本注册表（演进式加，Phase A 暂只有 v1；v0.37+ 加 v2）
// 格式：{ version, description, up(db): void }
const MIGRATIONS = [
  // v1 已通过 schema.sql 完成初始化；这里登记便于账本追溯
  {
    version: 1,
    description: 'Phase A baseline: 8 张核心表（账本+类型目录+链接类型目录+冷层4+镜像水位）',
    up: () => {}, // 实际 DDL 在 schema.sql
  },
  // v2：Phase B v0.37 演进——加 pk_hash / 类型属性表 / 导入任务表 / link_types 公理字段
  {
    version: 2,
    description: 'Phase B v0.37: aos_objects 加 pk_hash + 2 索引；aos_link_types 加 label/src_type/tgt_type/cardinality；新增 aos_type_properties 与 aos_import_jobs；backfill content_hash/pk_hash',
    up: (db) => {
      // 1. aos_objects 加 pk_hash 列（content_hash 在 v0.31 schema 已存在）
      const hasContentHash = db.prepare(
        "SELECT 1 FROM pragma_table_info('aos_objects') WHERE name='content_hash'"
      ).get();
      if (!hasContentHash) {
        db.exec('ALTER TABLE aos_objects ADD COLUMN content_hash TEXT');
      }
      const hasPkHash = db.prepare(
        "SELECT 1 FROM pragma_table_info('aos_objects') WHERE name='pk_hash'"
      ).get();
      if (!hasPkHash) {
        db.exec('ALTER TABLE aos_objects ADD COLUMN pk_hash TEXT');
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_aos_objects_content_hash ON aos_objects(content_hash)');
      // pk_hash 普通索引（非 UNIQUE）：必须在 ALTER ADD COLUMN pk_hash 之后
      // 原因：pk_hash = sha256(default|default|type|id|content_hash) 不含 snapshot_id，跨 snapshot 同对象
      //      pk_hash 一致——v0.38 拆 manifest 时 pk_hash 才升为 PK（UNIQUE 由 PK 天然保证）
      //      v0.37 阶段加 UNIQUE 会让"同对象多 snapshot"用例直接报错
      db.exec('CREATE INDEX IF NOT EXISTS idx_aos_objects_pk_hash ON aos_objects(pk_hash)');

      // 2. aos_link_types 扩 4 字段
      const addCol = (name, def) => {
        const exists = db.prepare(
          `SELECT 1 FROM pragma_table_info('aos_link_types') WHERE name=?`
        ).get(name);
        if (!exists) db.exec(`ALTER TABLE aos_link_types ADD COLUMN ${name} ${def}`);
      };
      addCol('label', 'TEXT');
      addCol('src_type', 'TEXT');
      addCol('tgt_type', 'TEXT');
      // CHECK 与 schema.sql 新库口径一致（SQLite 的 ADD COLUMN 允许带 CHECK；
      // 老库已有行由 DEFAULT '*' 填充，满足约束）
      addCol('cardinality', "TEXT NOT NULL DEFAULT '*' CHECK (cardinality IN ('1','0..1','*','1..*'))");

      // 3. 新增 aos_type_properties
      db.exec(`
        CREATE TABLE IF NOT EXISTS aos_type_properties (
          type_name    TEXT NOT NULL REFERENCES aos_types(type_name) ON DELETE CASCADE,
          \`key\`        TEXT NOT NULL,
          label        TEXT NOT NULL,
          wire_type    TEXT NOT NULL,
          storage_hint TEXT NOT NULL DEFAULT 'jsonb'
                       CHECK (storage_hint IN ('promoted','jsonb')),
          index_hint   TEXT NOT NULL DEFAULT 'none'
                       CHECK (index_hint IN ('none','btree','fulltext','vector')),
          PRIMARY KEY (type_name, \`key\`)
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_aos_type_properties_type ON aos_type_properties(type_name)');

      // 4. 新增 aos_import_jobs
      db.exec(`
        CREATE TABLE IF NOT EXISTS aos_import_jobs (
          job_id       TEXT NOT NULL PRIMARY KEY,
          job_kind     TEXT NOT NULL
                       CHECK (job_kind IN ('refreshRepo','analyzeFile','export')),
          snapshot_id  TEXT,
          steps        TEXT NOT NULL,
          current_step TEXT,
          \`cursor\`     TEXT NOT NULL,
          status       TEXT NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running','paused','completed','failed')),
          error        TEXT,
          started_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          FOREIGN KEY (snapshot_id) REFERENCES aos_snapshots(snapshot_id) ON DELETE CASCADE
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_aos_import_jobs_status ON aos_import_jobs(status, updated_at)');

      // 5. backfill 老库 content_hash / pk_hash（走 stderr 不污染 stdout JSON）
      const r = backfillContentAndPkHash(db);
      if (r.backfilled > 0) {
        // eslint-disable-next-line no-console
        console.error(`✓ backfill: ${r.backfilled} objects 已回填 content_hash / pk_hash`);
      }
    },
  },
];

// 应用所有未应用的迁移
//   - v0.31/v0.36 用户库：账本里只有 v1 → 自动跑 v2
//   - 已 v2 用户：跳过
//   - 升级失败：better-sqlite3 自动回滚（事务性 DDL）
export function applyPendingMigrations(db) {
  if (!db) return { applied: 0, current: null };
  const row = db.prepare('SELECT MAX(version) AS v FROM aos_schema_history').get();
  const current = row?.v ?? 0;
  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (pending.length === 0) return { applied: 0, current };

  const tx = db.transaction(() => {
    for (const mig of pending) {
      mig.up(db);
      const ts = new Date().toISOString();
      const checksum = crypto.createHash('sha256').update(`${mig.version}:${mig.description}`).digest('hex').slice(0, 16);
      db.prepare('INSERT INTO aos_schema_history (version, applied_at, description, checksum) VALUES (?, ?, ?, ?)')
        .run(mig.version, ts, mig.description, checksum);
    }
  });
  tx();
  return { applied: pending.length, current: pending[pending.length - 1].version };
}

// 导出 hash 计算函数（让 sqliteSnapshot.js 与 seed.js / backfill 共享同一实现）
export { computeContentHash, computePkHash };
