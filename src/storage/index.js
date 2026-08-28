// 统一导出 + 蓝图注入入口
// CLI 启动时由 src/cli/index.js 调用 setBlueprint() 注入 blueprint.js 的 OBJECT_TYPES / LINK_TYPES
// 避免 sqliteSnapshot.js 直接 import blueprint.js 造成循环（blueprint.js → ... → storage/）

export * from './db.js';
export * from './migrate.js';
export * from './seed.js';
export * from './sqliteSnapshot.js';
export { setStorageMode, getStorageMode, setSqlitePath, getSqlitePath, openDb, closeDb, isAvailable, getStatus, SCHEMA_VERSION } from './db.js';
export { saveSnapshot, loadSnapshot, loadType, loadObject, queryWhere, applyOverlay, buildAskContextFromSql, listSnapshots, setBlueprint } from './sqliteSnapshot.js';
export { seedOntologyCatalog, SNAPSHOT_KINDS } from './seed.js';
export { applyPendingMigrations, computeContentHash, computePkHash } from './migrate.js';
