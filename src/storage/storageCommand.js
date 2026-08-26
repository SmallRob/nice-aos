// nice-aos storage 子命令：init / status / rebuild / vacuum
// 借鉴 asdm-aos StorageFacade 暴露的运维接口

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import {
  openDb,
  closeDb,
  getStatus,
  setStorageMode,
  isAvailable,
  getSqlitePath,
  setSqlitePath,
  saveSnapshot,
  loadSnapshot,
  seedOntologyCatalog,
  applyPendingMigrations,
  SNAPSHOT_KINDS,
} from './index.js';
import { OBJECT_TYPES, LINK_TYPES } from '../ontology/blueprint.js';
import { loadDbSnapshot, getDbSnapshotPath } from '../database/dbSnapshot.js';
import { loadDeploySnapshot, getDeploySnapshotPath } from '../deployment/deploySnapshot.js';
import { loadPlanningSnapshot, getPlanningSnapshotPath } from '../planning/docsSnapshot.js';
import { loadServiceSnapshot, getServiceSnapshotPath } from '../service/serviceSnapshot.js';

function readJsonSafe(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

function kindLoaders() {
  return [
    { kind: 'code',     load: () => readJsonSafe(path.join(path.dirname(getSqlitePath()), SNAPSHOT_KINDS.find((k) => k.kind === 'code').file)) },
    { kind: 'db',       load: () => { try { return loadDbSnapshot(); } catch { return null; } } },
    { kind: 'deploy',   load: () => { try { return loadDeploySnapshot(); } catch { return null; } } },
    { kind: 'planning', load: () => { try { return loadPlanningSnapshot(); } catch { return null; } } },
    { kind: 'service',  load: () => { try { return loadServiceSnapshot(); } catch { return null; } } },
    { kind: 'overview', load: () => readJsonSafe(path.join(path.dirname(getSqlitePath()), SNAPSHOT_KINDS.find((k) => k.kind === 'overview').file)) },
  ];
}

function fmtSize(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export const storageCommand = new Command('storage')
  .description('管理本地 SQLite 存储层（账本/类型目录/冷层对象/链接/标注）')
  .option('--mode <mode>', '存储模式: auto | on | off', 'auto')
  .option('--path <p>', 'SQLite 文件路径（默认 <snapshot-dir>/aos.sqlite）')
  .hook('preAction', (cmd) => {
    if (cmd.opts().mode) setStorageMode(cmd.opts().mode);
    if (cmd.opts().path) setSqlitePath(cmd.opts().path);
  });

// storage init
storageCommand
  .command('init')
  .description('初始化 SQLite（建表 + 种子化本体目录）')
  .option('--force', '若已存在则删除重建')
  .action((opts) => {
    const dbPath = getSqlitePath();
    if (fs.existsSync(dbPath) && opts.force) {
      fs.unlinkSync(dbPath);
      console.log(`已删除旧 SQLite: ${dbPath}`);
    }
    setStorageMode('on'); // 强制启用
    const db = openDb();
    if (!db) {
      console.error('❌ SQLite 不可用（better-sqlite3 未安装或 postinstall 失败）');
      process.exit(1);
    }
    const seeded = seedOntologyCatalog(db, { OBJECT_TYPES, LINK_TYPES });
    const mig = applyPendingMigrations(db);
    console.log('✓ SQLite 已初始化');
    console.log(`  path        ${dbPath}`);
    console.log(`  schema v${mig.current ?? 1}（${SNAPSHOT_KINDS.length} 种 snapshot_kind 已注册到 aos_snapshots 的预期）`);
    console.log(`  本体目录    ${seeded.types} 个类型 / ${seeded.linkTypes} 个链接类型`);
    closeDb();
  });

// storage status
storageCommand
  .command('status')
  .description('查看 SQLite 健康状态 / 各 kind 行数 / 文件大小')
  .option('--json', 'JSON 格式输出')
  .action((opts) => {
    const status = getStatus();
    if (!status.available) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, ...status }, null, 2));
      } else {
        console.log('SQLite 不可用');
        console.log(`  mode:    ${status.mode}`);
        console.log(`  path:    ${status.path}`);
        console.log(`  reason:  ${status.reason ?? '未知'}`);
      }
      process.exit(1);
    }

    const db = openDb();
    const dbPath = getSqlitePath();
    const snapDir = path.dirname(dbPath);
    const counts = db.prepare(`
      SELECT snapshot_kind,
             COUNT(*) AS n,
             SUM(CASE WHEN is_current = 1 THEN 1 ELSE 0 END) AS n_current
      FROM aos_snapshots GROUP BY snapshot_kind
    `).all();
    const objectTotals = db.prepare(`
      SELECT s.snapshot_kind, COUNT(o.rowid) AS n
      FROM aos_snapshots s LEFT JOIN aos_objects o ON o.snapshot_id = s.snapshot_id
      WHERE s.is_current = 1
      GROUP BY s.snapshot_kind
    `).all();
    const linkTotals = db.prepare(`
      SELECT s.snapshot_kind, COUNT(l.rowid) AS n
      FROM aos_snapshots s LEFT JOIN aos_links l ON l.snapshot_id = s.snapshot_id
      WHERE s.is_current = 1
      GROUP BY s.snapshot_kind
    `).all();
    const overlayTotals = db.prepare(`
      SELECT s.snapshot_kind, COUNT(o.rowid) AS n
      FROM aos_snapshots s LEFT JOIN aos_overlays o ON o.snapshot_id = s.snapshot_id
      WHERE s.is_current = 1
      GROUP BY s.snapshot_kind
    `).all();

    if (opts.json) {
      const result = {
        ok: true,
        ...status,
        snapshotDir: snapDir,
        kinds: SNAPSHOT_KINDS.map((k) => {
          const c = counts.find((x) => x.snapshot_kind === k.kind) || { n: 0, n_current: 0 };
          const o = objectTotals.find((x) => x.snapshot_kind === k.kind) || { n: 0 };
          const l = linkTotals.find((x) => x.snapshot_kind === k.kind) || { n: 0 };
          const ov = overlayTotals.find((x) => x.snapshot_kind === k.kind) || { n: 0 };
          const jsonPath = path.join(snapDir, k.file);
          return {
            kind: k.kind,
            snapshots: c.n,
            current: c.n_current === 1,
            objects: o.n,
            links: l.n,
            overlays: ov.n,
            jsonFile: k.file,
            jsonSize: fs.existsSync(jsonPath) ? fs.statSync(jsonPath).size : null,
          };
        }),
      };
      console.log(JSON.stringify(result, null, 2));
      closeDb();
      return;
    }

    console.log(`SQLite OK  (${status.path})`);
    console.log(`  driver     better-sqlite3`);
    console.log(`  schema     v${status.schemaVersion}`);
    console.log(`  size       ${fmtSize(status.fileSize)}`);
    console.log(`  tables     ${status.tables.length} (${status.tables.join(', ')})`);
    console.log('');
    console.log('  snapshot_kind        snapshots  objects   links   overlays  json-file');
    for (const k of SNAPSHOT_KINDS) {
      const c = counts.find((x) => x.snapshot_kind === k.kind) || { n: 0, n_current: 0 };
      const o = objectTotals.find((x) => x.snapshot_kind === k.kind) || { n: 0 };
      const l = linkTotals.find((x) => x.snapshot_kind === k.kind) || { n: 0 };
      const ov = overlayTotals.find((x) => x.snapshot_kind === k.kind) || { n: 0 };
      const jsonPath = path.join(snapDir, k.file);
      const jsonSize = fs.existsSync(jsonPath) ? fmtSize(fs.statSync(jsonPath).size) : '—';
      console.log(`  ${k.kind.padEnd(20)} ${String(c.n_current).padStart(2)}/${String(c.n).padStart(2)}     ${String(o.n).padStart(7)} ${String(l.n).padStart(7)}  ${String(ov.n).padStart(7)}  ${k.file} (${jsonSize})`);
    }
    closeDb();
  });

// storage rebuild —— 从 JSON 重建 SQLite
storageCommand
  .command('rebuild')
  .description('强制从 JSON 文件重建 SQLite（崩溃恢复 / 升级 schema 后）')
  .option('--kind <kind>', '仅重建指定 kind（code/db/deploy/planning/service/overview）')
  .option('--force', '删除旧 SQLite 后重建')
  .action((opts) => {
    const dbPath = getSqlitePath();
    if (fs.existsSync(dbPath) && opts.force) {
      fs.unlinkSync(dbPath);
      console.log(`已删除旧 SQLite: ${dbPath}`);
    }
    setStorageMode('on');
    const db = openDb();
    if (!db) {
      console.error('❌ SQLite 不可用');
      process.exit(1);
    }
    seedOntologyCatalog(db, { OBJECT_TYPES, LINK_TYPES });

    const targets = opts.kind
      ? kindLoaders().filter((k) => k.kind === opts.kind)
      : kindLoaders();
    let total = 0;
    for (const t of targets) {
      const dataMap = t.load();
      if (!dataMap) {
        console.log(`  - ${t.kind}: 无 JSON 快照（跳过）`);
        continue;
      }
      const r = saveSnapshot({ kind: t.kind, dataMap, metaOnly: t.kind === 'overview' });
      if (r.ok) {
        console.log(`  ✓ ${t.kind}: ${r.objects ?? 0} 个对象 → ${r.snapshotId}`);
        total += 1;
      } else {
        console.error(`  ✗ ${t.kind}: 写入失败 (${r.reason})`);
      }
    }
    console.log(`\n完成：${total} 个 kind 已重建`);
    closeDb();
  });

// storage vacuum —— VACUUM + ANALYZE
storageCommand
  .command('vacuum')
  .description('VACUUM + ANALYZE（性能维护）')
  .action(() => {
    const db = openDb();
    if (!db) {
      console.error('❌ SQLite 不可用');
      process.exit(1);
    }
    const before = fs.statSync(getSqlitePath()).size;
    db.exec('VACUUM');
    db.exec('ANALYZE');
    const after = fs.statSync(getSqlitePath()).size;
    console.log(`✓ VACUUM + ANALYZE 完成`);
    console.log(`  before    ${fmtSize(before)}`);
    console.log(`  after     ${fmtSize(after)}`);
    console.log(`  delta     ${fmtSize(after - before)}`);
    closeDb();
  });

// storage drop —— 删除 SQLite（危险操作，需确认）
storageCommand
  .command('drop')
  .description('删除 SQLite 文件（危险；需 --yes 确认）')
  .option('--yes', '跳过确认')
  .action((opts) => {
    const dbPath = getSqlitePath();
    if (!fs.existsSync(dbPath)) {
      console.log(`SQLite 不存在: ${dbPath}`);
      return;
    }
    if (!opts.yes) {
      console.error('⚠️  危险操作！删除 SQLite 文件。需 --yes 确认。');
      process.exit(1);
    }
    closeDb();
    fs.unlinkSync(dbPath);
    console.log(`✓ 已删除: ${dbPath}`);
  });
