// 本地 SQLite 存储 · 连接管理
// 借鉴 asdm-aos StorageFacade：单例、懒加载、探测降级
//
// 启动探测顺序（与 plan D-SQLite-2 / 启动探测顺序对齐）：
//   1. require('better-sqlite3')    失败 → 返回 null（降级到纯 JSON 路径）
//   2. fs.existsSync(SQLITE_PATH)  不存在 → 自动 migrate + seed
//   3. PRAGMA journal_mode = WAL
//   4. PRAGMA synchronous = NORMAL
//   5. PRAGMA foreign_keys = ON
//   6. SELECT MAX(version) FROM aos_schema_history  → 与 code 期望比对
//
// 跨进程并发：
//   - 同进程：better-sqlite3 天然线程安全
//   - 跨进程：用 advisory lock 文件（<.aos.sqlite.lock>），冲突时退出 1
//
// 模式（storageMode）：
//   - 'auto'（默认）：better-sqlite3 可用即用，否则降级 JSON
//   - 'on'   ：强制启用；better-sqlite3 不可用则 throw
//   - 'off'  ：强制禁用，永远走 JSON 路径
//
// 路径：
//   - 默认 <snapshotDir>/aos.sqlite（所有 kind 共用一个文件，简化迁移）
//   - 可通过 setSqlitePath() 或 NICE_AOS_SQLITE_PATH 覆盖

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getSnapshotDir } from '../paths.js';
import { applyPendingMigrations } from './migrate.js';

const require = createRequire(import.meta.url);

let storageModeOverride = 'auto'; // 'auto' | 'on' | 'off'
let sqlitePathOverride = null;
let cachedDb = null;              // 缓存的 Database 实例
let cachedLoadFailed = false;     // 本次进程内 better-sqlite3 加载失败标记
let lockFd = null;                // 跨进程 lock 文件 fd
let lockPath = null;              // lock 文件路径（acquire 时记录，release 时清理）
let initInProgress = false;       // 防并发 init

const LOCK_FILE_NAME = '.aos.sqlite.lock';
const DEFAULT_DB_FILE = 'aos.sqlite';
const ENV_PATH = 'NICE_AOS_SQLITE_PATH';
const ENV_MODE = 'NICE_AOS_SQLITE_MODE';

// Code-side 期望 schema 版本：每次 DDL 升级 +1（描述见 migrate.js MIGRATIONS 各块）
export const SCHEMA_VERSION = 2;

export function setStorageMode(mode) {
  if (!['auto', 'on', 'off'].includes(mode)) {
    throw new Error(`无效 storage 模式: ${mode}（auto | on | off）`);
  }
  storageModeOverride = mode;
  // 模式变更后让缓存失效（避免 on→off 后仍用旧 db）
  if (cachedDb) {
    try { cachedDb.close(); } catch { /* ignore */ }
    cachedDb = null;
  }
}

export function getStorageMode() {
  if (storageModeOverride) return storageModeOverride;
  const env = process.env[ENV_MODE];
  if (env === 'on' || env === 'off' || env === 'auto') return env;
  return 'auto';
}

export function setSqlitePath(p) {
  sqlitePathOverride = p;
  if (cachedDb) {
    try { cachedDb.close(); } catch { /* ignore */ }
    cachedDb = null;
  }
}

export function getSqlitePath() {
  if (sqlitePathOverride) return path.resolve(sqlitePathOverride);
  if (process.env[ENV_PATH]) return path.resolve(process.env[ENV_PATH]);
  // 默认：<snapshotDir>/aos.sqlite
  // snapshotDir 来自 ontology/snapshot.js（与所有 *-snapshot.json 共用同一目录），
  // 优先级：setSnapshotDir() override > NICE_AOS_SNAPSHOT_DIR > cwd/.nice-aos/data > ~/.nice-aos/data
  const dir = getSnapshotDir();
  return path.join(dir, DEFAULT_DB_FILE);
}

export function getStorageDir() {
  return path.dirname(getSqlitePath());
}

// 加载 better-sqlite3，失败返回 null（同步 API）
function loadDriver() {
  if (cachedLoadFailed) return null;
  try {
    // better-sqlite3 是 CJS module；ESM 中通过 createRequire 引入
    const Database = require('better-sqlite3');
    return Database;
  } catch (err) {
    cachedLoadFailed = true;
    // 一次性降级提示（optionalDependencies 下 postinstall 失败不阻塞安装，但用户需要知道）
    console.error('⚠️ better-sqlite3 不可用（未安装或编译失败），SQLite 存储已降级到 JSON 模式。可尝试: npm install -g nice-aos --force 或 npm rebuild better-sqlite3');
    return null;
  }
}

// 判断 PID 对应进程是否存活（signal 0 仅探测不发送）
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // 无权限发信号但进程存在
  }
}

// 跨进程 lock 文件（O_EXCL 互斥 + PID stale 检测）
function acquireLock(dbPath, retried = false) {
  lockPath = path.join(path.dirname(dbPath), LOCK_FILE_NAME);
  try {
    // 'wx' = O_CREAT|O_EXCL：已存在则抛 EEXIST，真正的互斥语义
    lockFd = fs.openSync(lockPath, 'wx');
    fs.writeSync(lockFd, `${process.pid}\n`);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') return true; // 非冲突错误（如权限）best-effort 继续
    // 已存在：检查持有者是否存活
    let pid = NaN;
    try {
      pid = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10);
    } catch { /* lock 文件不可读 → 视为 stale */ }
    if (Number.isInteger(pid) && isProcessAlive(pid)) {
      return false; // 真冲突：另一进程持有
    }
    if (retried) return false; // 只重试一次，防竞态死循环
    // stale lock（持有者已死）→ 接管并重试
    fs.rmSync(lockPath, { force: true });
    return acquireLock(dbPath, true);
  }
}

function releaseLock() {
  if (lockFd !== null) {
    try {
      fs.closeSync(lockFd);
      fs.rmSync(lockPath, { force: true });
    } catch { /* ignore */ }
    lockFd = null;
    lockPath = null;
  }
}

// 初始化：建表 + 种子化 + 增量迁移
//   流程：
//   1) 读 schema.sql 并执行（CREATE IF NOT EXISTS）—— 新表/新列自动建
//   2) 统一走 applyPendingMigrations() 跑所有 pending 块的 up(db)
//      - 首次安装：v1 + v2 都会跑（v2 含幂等 ALTER/INDEX，CREATE IF NOT EXISTS 跳过已建表）
//      - 升级（如 v0.31 → v0.37）：v2 跑 ALTER + backfill
//      - 库已 SCHEMA_VERSION：no-op
//   3) 降级（库版本比 code 新）：只读模式
function initialize(db) {
  // 1) 读 schema.sql 并执行（CREATE IF NOT EXISTS，幂等）
  const schemaPath = new URL('./schema.sql', import.meta.url);
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  // 2) 账本检查
  const applied = db.prepare('SELECT MAX(version) AS v FROM aos_schema_history').get();
  if (applied && applied.v > SCHEMA_VERSION) {
    // 库 schema 比 code 新（用户降级 nice-aos 版本）→ 降级警告 + 只读
    console.warn(`⚠️  SQLite schema version (${applied.v}) 高于当前 nice-aos 期望 (${SCHEMA_VERSION})，进入只读模式。`);
    storageModeOverride = 'off';
    return;
  }

  // 3) 跑 pending migrations（首次安装 + 老库升级都走这里）
  //    只在「真升级」时打印日志（避免污染 JSON stdout 路径——ask 等 CLI 命令的 JSON 输出）
  //    首次安装时 v1 + v2 都会跑但 history 表之前无行，不打日志
  //    日志走 stderr 不走 stdout：JSON 模式（ask --json 等）下 stdout 是合同输出，不能混入诊断
  //    注：migrate.js 经顶部静态 import 引入（createRequire 的 require(esm) 需 Node ≥ 20.19，
  //    与 engines >= 18 冲突；migrate.js 不依赖本模块，无循环引用）
  const result = applyPendingMigrations(db);
  if (result.applied > 0 && applied && applied.v > 0) {
    // eslint-disable-next-line no-console
    console.error(`✓ schema migration: applied ${result.applied} version(s), now at v${result.current}`);
  }
}

// 打开 SQLite 连接（单例）
export function openDb() {
  if (cachedDb) return cachedDb;
  const mode = getStorageMode();
  if (mode === 'off') return null;

  const Database = loadDriver();
  if (!Database) {
    if (mode === 'on') {
      throw new Error('better-sqlite3 不可用，但 storage 模式为 on。请安装 better-sqlite3 或设置 NICE_AOS_SQLITE_MODE=auto/off。');
    }
    // auto + 不可用：静默降级
    return null;
  }

  const dbPath = getSqlitePath();
  const dbDir = path.dirname(dbPath);
  fs.mkdirSync(dbDir, { recursive: true });

  // 跨进程 lock（best-effort）
  if (!acquireLock(dbPath)) {
    if (mode === 'on') {
      throw new Error(`已有 nice-aos 进程在写 SQLite (${dbPath})。请等待其完成。`);
    }
    // auto + 锁定冲突：降级 JSON
    console.warn(`⚠️  SQLite lock 冲突 (${dbPath})，降级到 JSON 路径。`);
    return null;
  }

  let db;
  try {
    db = new Database(dbPath);
  } catch (err) {
    releaseLock();
    if (mode === 'on') {
      throw new Error(`SQLite 打开失败: ${err.message}（${dbPath}）`);
    }
    console.warn(`⚠️  SQLite 打开失败 (${err.message})，降级到 JSON 路径。`);
    return null;
  }

  try {
    // PRAGMA 设置
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
  } catch (err) {
    db.close();
    releaseLock();
    if (mode === 'on') throw err;
    console.warn(`⚠️  SQLite PRAGMA 失败 (${err.message})，降级到 JSON 路径。`);
    return null;
  }

  // 初始化 / 迁移
  try {
    initialize(db);
  } catch (err) {
    db.close();
    releaseLock();
    if (mode === 'on') throw err;
    console.warn(`⚠️  SQLite 初始化失败 (${err.message})，降级到 JSON 路径。`);
    return null;
  }

  // 种子化本体目录（aos_types / aos_link_types）— 延迟到 sqliteSnapshot.js 通过 seedOntologyCatalog() 调用，
  // 因为需要 import blueprint.js，db.js 保持低层不依赖 ontology。

  cachedDb = db;
  return db;
}

// 关闭连接（CLI 退出前调用；正常情况 Node 进程退出自动释放）
export function closeDb() {
  if (cachedDb) {
    try { cachedDb.close(); } catch { /* ignore */ }
    cachedDb = null;
  }
  releaseLock();
}

// 是否当前进程内可用（auto 模式下探测 + 缓存）
export function isAvailable() {
  const mode = getStorageMode();
  if (mode === 'off') return false;
  const Database = loadDriver();
  return Database !== null;
}

// 健康状态（供 storage status 命令）
export function getStatus() {
  const mode = getStorageMode();
  const dbPath = getSqlitePath();
  const dbExists = fs.existsSync(dbPath);
  const driverLoaded = loadDriver() !== null;

  if (!driverLoaded) {
    return {
      mode,
      available: false,
      driver: null,
      path: dbPath,
      pathExists: dbExists,
      schemaVersion: null,
      tables: [],
      fileSize: dbExists ? fs.statSync(dbPath).size : null,
      reason: 'better-sqlite3 不可用（未安装或 postinstall 失败）',
    };
  }

  if (!dbExists) {
    return {
      mode,
      available: false,
      driver: 'better-sqlite3',
      path: dbPath,
      pathExists: false,
      schemaVersion: null,
      tables: [],
      fileSize: null,
      reason: 'SQLite 文件未初始化。运行: nice-aos storage init',
    };
  }

  let db = null;
  try {
    db = openDb();
    if (!db) {
      return {
        mode,
        available: false,
        driver: 'better-sqlite3',
        path: dbPath,
        pathExists: true,
        schemaVersion: null,
        tables: [],
        fileSize: fs.statSync(dbPath).size,
        reason: 'openDb() 失败（已降级）',
      };
    }
    const ver = db.prepare('SELECT MAX(version) AS v FROM aos_schema_history').get();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'aos_%' ORDER BY name").all().map((r) => r.name);
    return {
      mode,
      available: true,
      driver: 'better-sqlite3',
      path: dbPath,
      pathExists: true,
      schemaVersion: ver?.v ?? null,
      tables,
      fileSize: fs.statSync(dbPath).size,
    };
  } catch (err) {
    return {
      mode,
      available: false,
      driver: 'better-sqlite3',
      path: dbPath,
      pathExists: true,
      schemaVersion: null,
      tables: [],
      fileSize: fs.statSync(dbPath).size,
      reason: `状态查询失败: ${err.message}`,
    };
  } finally {
    // 注意：不要 close，因为 openDb() 是单例
  }
}
