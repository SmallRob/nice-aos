// 迁移管理器（D14 简化版，单进程内账本）
// 启动时调用：openDb() 内部已用 schema.sql + aos_schema_history 完成基础账本。
// 本文件保留供 v0.32+ 增量迁移脚本注册（每个 version 一段 SQL + description + checksum）。

import crypto from 'node:crypto';

// 迁移脚本注册表（演进式加，Phase A 暂只有 v1）
// 格式：{ version, description, up(db): void }
const MIGRATIONS = [
  // v1 已通过 schema.sql 完成初始化；这里登记便于账本追溯
  {
    version: 1,
    description: 'Phase A baseline: 7 张核心表（账本+类型目录+链接类型目录+冷层4）',
    up: () => {}, // 实际 DDL 在 schema.sql
  },
];

// 应用所有未应用的迁移（v0.31 已是最新，无需执行）
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
