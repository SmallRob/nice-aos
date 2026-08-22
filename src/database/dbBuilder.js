// 数据库模型构建器：编排 sqlAnalyzer 分析，按迁移版本有序 apply DDL，构建最终数据库模型
// 支持：全量扫描、增量扫描（末尾追加式）、单文件分析
// 布局模式：flyway（标准 Vxx__desc.sql） / sprint（sprintXX_Y/incrementsql/ 风格） / auto（自动检测）

import fs from 'node:fs';
import path from 'node:path';
import {
  analyzeSqlFile,
  analyzeSqlFileFromDisk,
  parseSprintFilePath,
} from '../analyzers/sqlAnalyzer.js';
import { detectDomain, detectPatterns, versionCompare, DOMAIN_COLORS } from './dbModel.js';
import { fileHash } from './dbSnapshot.js';

// 默认排除目录（不扫描 SQL）
const DEFAULT_EXCLUDE_DIRS = [
  'testdata', 'backup', 'template', '0_sql_template',
  '.git', 'node_modules', '.nice-aos',
];

// DDL 文件命名模式（只分析可能包含 DDL 的文件，跳过纯数据脚本）
const DDL_FILE_PATTERNS = [
  /-db\.sql$/i,         // *-db.sql
  /-all\.sql$/i,        // *-all.sql
  /core-all\.sql$/i,    // core-all.sql
  /include\.sql$/i,     // include.sql
  /schema\.sql$/i,      // schema.sql
  /ddl\.sql$/i,         // *ddl.sql
  /^V\d+.*\.sql$/i,     // Flyway Vxx*.sql
];

function isDdlFile(fileName) {
  return DDL_FILE_PATTERNS.some((p) => p.test(fileName));
}

function isExcludedDir(dirName) {
  return DEFAULT_EXCLUDE_DIRS.some((d) => dirName.toLowerCase() === d.toLowerCase());
}

// 递归扫描目录，收集所有 SQL 文件
function walkSqlFiles(dir, options = {}) {
  const results = [];
  const excludeDirs = options.excludeDirs || DEFAULT_EXCLUDE_DIRS;

  function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        // 跳过排除目录
        if (excludeDirs.some((d) => entry.name.toLowerCase() === d.toLowerCase())) continue;
        walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.sql')) {
        // 只包含 DDL 文件（除非指定 dataOnly 或 allFiles）
        if (options.allFiles || isDdlFile(entry.name)) {
          results.push({
            fileName: entry.name,
            filePath: fullPath,
            relativePath: path.relative(dir, fullPath).replace(/\\/g, '/'),
          });
        }
      }
    }
  }

  walk(dir);
  return results;
}

// 检测目录布局模式
function detectLayout(dir) {
  // 检查顶级是否有 Flyway 风格文件
  let topFiles = [];
  try {
    topFiles = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.sql'));
  } catch {
    return 'flyway';
  }
  const flywayFiles = topFiles.filter((f) => /^V\d+\.\d+\.\d+/.test(f));
  if (flywayFiles.length > 0) return 'flyway';

  // 检查是否有 sprint 风格子目录
  function hasSprintDir(d) {
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && /^sprint\d+/i.test(e.name)) return true;
        if (e.isDirectory()) {
          if (hasSprintDir(path.join(d, e.name))) return true;
        }
      }
    } catch { /* empty */ }
    return false;
  }
  if (hasSprintDir(dir)) return 'sprint';

  return 'flyway'; // 默认
}

// 根据布局模式排序文件并提取版本
function prepareFiles(files, layout, rootDir) {
  const enriched = files.map((f) => {
    let version;
    let description;
    let isEmptyTemplate = false;

    if (layout === 'sprint') {
      const parsed = parseSprintFilePath(f.filePath, rootDir);
      version = parsed.version;
      description = parsed.description;
    } else {
      // flyway 模式：从文件名提取
      const m = f.fileName.match(/^V(\d+\.\d+\.\d+)_{1,2}(.+?)\.sql$/i);
      if (m) {
        version = `V${m[1]}`;
        description = m[2].replace(/_/g, ' ');
      } else {
        version = f.fileName.replace(/\.sql$/i, '');
        description = f.fileName.replace(/\.sql$/i, '');
      }
    }

    return { ...f, version, description, isEmptyTemplate };
  });

  // 按版本排序，版本相同按文件路径排序
  return enriched.sort((a, b) => {
    const cmp = versionCompare(a.version, b.version);
    if (cmp !== 0) return cmp;
    return a.filePath.localeCompare(b.filePath);
  });
}

function applyCreateTable(model, op, version, database) {
  const tableKey = database ? `${database}.${op.tableName}` : op.tableName;
  const existingIdx = model.tables.findIndex((t) => t.name === op.tableName && (!database || t.database === database));
  if (existingIdx >= 0) return;
  const domain = detectDomain(op.tableName);
  const table = {
    id: `table:${tableKey}`,
    name: op.tableName,
    database: database || null,
    comment: op.comment,
    domain: domain.key,
    domainLabel: domain.label,
    engine: op.engine,
    charset: op.charset,
    collate: op.collate,
    columns: op.columns.map((c) => ({ ...c })),
    primaryKey: [...(op.primaryKey || [])],
    foreignKeys: (op.foreignKeys || []).map((fk) => ({ ...fk })),
    indexes: (op.indexes || []).map((idx) => ({ ...idx })),
    createdAt: version,
    modifiedAt: version,
    migrationVersions: [version],
  };
  table.patterns = detectPatterns(table);
  model.tables.push(table);
}

function applyAlterTable(model, op, version, database) {
  const table = model.tables.find((t) => t.name === op.tableName && (!database || t.database === database));
  if (!table) return;
  table.modifiedAt = version;
  if (!table.migrationVersions.includes(version)) table.migrationVersions.push(version);

  for (const action of op.actions) {
    switch (action.type) {
      case 'addColumn':
        table.columns.push({ ...action.column });
        break;
      case 'dropColumn':
        table.columns = table.columns.filter((c) => c.name !== action.columnName);
        table.foreignKeys = table.foreignKeys.filter((fk) => !fk.columns.includes(action.columnName));
        table.indexes = table.indexes.filter((idx) => !idx.columns.includes(action.columnName));
        break;
      case 'modifyColumn': {
        const oldName = action.oldColumnName || action.column.name;
        const idx = table.columns.findIndex((c) => c.name === oldName);
        if (idx >= 0) table.columns[idx] = { ...action.column };
        else table.columns.push({ ...action.column });
        break;
      }
      case 'addIndex':
        if (!table.indexes.find((i) => i.name === action.index.name)) {
          table.indexes.push({ ...action.index });
        }
        break;
      case 'dropIndex':
        table.indexes = table.indexes.filter((i) => i.name !== action.name);
        break;
      case 'addForeignKey':
        if (!table.foreignKeys.find((fk) => fk.name === action.foreignKey.name)) {
          table.foreignKeys.push({ ...action.foreignKey });
        }
        break;
      case 'dropForeignKey':
        table.foreignKeys = table.foreignKeys.filter((fk) => fk.name !== action.name);
        break;
    }
  }
  table.patterns = detectPatterns(table);
}

function applyCreateIndex(model, op, version, database) {
  const table = model.tables.find((t) => t.name === op.tableName && (!database || t.database === database));
  if (table) {
    if (!table.indexes.find((i) => i.name === op.indexName)) {
      table.indexes.push({ name: op.indexName, columns: op.columns, unique: op.unique, indexType: op.indexType || 'NORMAL' });
      if (!table.migrationVersions.includes(version)) table.migrationVersions.push(version);
      table.modifiedAt = version;
    }
  }
}

function applyDropTable(model, op, database) {
  model.tables = model.tables.filter((t) => !(t.name === op.tableName && (!database || t.database === database)));
  model.foreignKeys = model.foreignKeys.filter(
    (fk) => !(fk.fromTable === op.tableName && (!database || fk.fromDatabase === database))
      && !(fk.toTable === op.tableName && (!database || fk.toDatabase === database)),
  );
}

function buildForeignKeysArray(tables) {
  const fks = [];
  for (const table of tables) {
    for (const fk of table.foreignKeys) {
      fks.push({
        id: `fk:${table.database ? table.database + '.' : ''}${table.name}.${fk.columns.join(',')}→${fk.refTable}.${fk.refColumns.join(',')}`,
        name: fk.name,
        fromTable: table.name,
        fromDatabase: table.database,
        fromColumns: fk.columns,
        toTable: fk.refTable,
        toDatabase: table.database, // 默认与源表同库
        toColumns: fk.refColumns,
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      });
    }
  }
  return fks;
}

function buildDomainsArray(tables) {
  const domainMap = new Map();
  for (const table of tables) {
    const key = table.database ? `${table.database}:${table.domain}` : table.domain;
    const label = table.database ? `${table.database} · ${table.domainLabel}` : table.domainLabel;
    if (!domainMap.has(key)) {
      const color = DOMAIN_COLORS[table.domain] || DOMAIN_COLORS.other;
      domainMap.set(key, { key, label, color, tableCount: 0, tableNames: [], database: table.database });
    }
    const d = domainMap.get(key);
    d.tableCount++;
    d.tableNames.push(table.name);
  }
  return [...domainMap.values()];
}

function buildDatabasesArray(tables) {
  const dbMap = new Map();
  for (const table of tables) {
    const db = table.database || '(default)';
    if (!dbMap.has(db)) dbMap.set(db, { name: db, tableCount: 0, tables: [] });
    const d = dbMap.get(db);
    d.tableCount++;
    d.tables.push(table.name);
  }
  return [...dbMap.values()];
}

function buildMeta(migrationDir, files, model, durationMs, incremental, fileManifest, layout) {
  const totalIndexCount = model.tables.reduce((sum, t) => sum + t.indexes.length, 0);
  return {
    version: '1.0',
    subsystem: 'database',
    scannedAt: new Date().toISOString(),
    sourceDir: migrationDir,
    layout,
    fileCount: files.length,
    tableCount: model.tables.length,
    fkCount: model.foreignKeys.length,
    indexCount: totalIndexCount,
    viewCount: model.views.length,
    triggerCount: model.triggers.length,
    procedureCount: model.procedures.length,
    migrationCount: model.migrations.length,
    domainCount: model.domains.length,
    databaseCount: (model.databases || []).length,
    durationMs,
    incremental,
    fileManifest,
  };
}

// 处理单个文件的 apply 逻辑（共享给全量和增量）
function applySqlFile(model, file, content, options = {}) {
  const analyzeOpts = {
    version: file.version,
    description: file.description,
    extractTemplate: options.layout === 'sprint',
  };

  const result = analyzeSqlFile(file.filePath, content, analyzeOpts);

  // 空模板文件跳过
  if (result.isEmptyTemplate) return { skipped: true, result };

  const migration = {
    id: `mig:${result.version}_${file.relativePath || file.fileName}`,
    version: result.version,
    description: result.description,
    fileName: result.fileName,
    filePath: file.filePath,
    relativePath: file.relativePath,
    fileSize: result.fileSize,
    operationSummary: result.operationSummary,
    tableNames: result.tableNames,
    hasIdempotentDdl: result.hasIdempotentDdl,
    databases: result.databases,
  };
  model.migrations.push(migration);

  // 注意：每个操作对象都有 database 字段（由 sqlAnalyzer 按语句顺序追踪 USE 得到）
  // apply 函数使用操作上的 database 字段
  // 顺序：先 DROP 再 CREATE，适配 mysqldump 格式（DROP TABLE IF EXISTS + CREATE TABLE 成对）
  for (const op of result.operations.dropTable) applyDropTable(model, op, op.database);
  for (const op of result.operations.createTable) applyCreateTable(model, op, result.version, op.database);
  for (const op of result.operations.alterTable) applyAlterTable(model, op, result.version, op.database);
  for (const op of result.operations.createIndex) applyCreateIndex(model, op, result.version, op.database);
  for (const op of result.operations.createView) model.views.push({ id: `view:${op.database ? op.database + '.' : ''}${op.viewName}`, database: op.database, ...op });
  for (const op of result.operations.createTrigger) model.triggers.push({ id: `trig:${op.database ? op.database + '.' : ''}${op.triggerName}`, database: op.database, ...op });
  for (const op of result.operations.createProcedure) model.procedures.push({ id: `proc:${op.database ? op.database + '.' : ''}${op.procedureName}`, database: op.database, ...op });

  return { skipped: false, result };
}

export async function buildDatabaseModel(migrationDir, options = {}) {
  const startTime = Date.now();

  // 确定布局模式
  let layout = options.layout || 'auto';
  if (layout === 'auto') {
    layout = detectLayout(migrationDir);
  }

  // 扫描文件
  const scanOptions = {
    excludeDirs: options.excludeDirs,
    allFiles: options.allFiles,
  };
  const rawFiles = walkSqlFiles(migrationDir, scanOptions);
  const sortedFiles = prepareFiles(rawFiles, layout, migrationDir);

  const model = {
    tables: [],
    foreignKeys: [],
    migrations: [],
    domains: [],
    databases: [],
    views: [],
    triggers: [],
    procedures: [],
    layout,
  };

  const fileManifest = [];
  let skippedEmpty = 0;

  for (const file of sortedFiles) {
    const content = fs.readFileSync(file.filePath, 'utf-8');
    const hash = fileHash(file.filePath);
    fileManifest.push({
      fileName: file.fileName,
      relativePath: file.relativePath,
      version: file.version,
      hash,
    });

    const { skipped } = applySqlFile(model, file, content, { layout });
    if (skipped) skippedEmpty++;
  }

  model.foreignKeys = buildForeignKeysArray(model.tables);
  model.domains = buildDomainsArray(model.tables);
  model.databases = buildDatabasesArray(model.tables);

  const durationMs = Date.now() - startTime;
  model._meta = buildMeta(migrationDir, sortedFiles, model, durationMs, false, fileManifest, layout);
  model._meta.skippedEmptyTemplates = skippedEmpty;

  return model;
}

export async function buildDatabaseModelIncremental(migrationDir, existingModel, options = {}) {
  const layout = existingModel.layout || options.layout || 'flyway';
  const existingManifest = existingModel._meta?.fileManifest || [];
  const existingHashes = new Map(existingManifest.map((m) => [m.relativePath || m.fileName, m.hash]));
  const existingMaxVersion = existingManifest.length > 0
    ? existingManifest.map((m) => m.version).sort(versionCompare).at(-1)
    : null;

  const scanOptions = {
    excludeDirs: options.excludeDirs,
    allFiles: options.allFiles,
  };
  const currentFiles = walkSqlFiles(migrationDir, scanOptions);
  const sortedFiles = prepareFiles(currentFiles, layout, migrationDir);

  const newFiles = [];
  let middleModified = false;
  for (const file of sortedFiles) {
    const hash = fileHash(file.filePath);
    const key = file.relativePath || file.fileName;
    const existing = existingHashes.get(key);
    if (!existing || existing !== hash) {
      newFiles.push(file);
      if (existingMaxVersion && versionCompare(file.version, existingMaxVersion) <= 0) {
        middleModified = true;
      }
    }
  }

  if (middleModified || newFiles.length === 0) {
    if (middleModified) return buildDatabaseModel(migrationDir, options);
    return existingModel;
  }

  const startTime = Date.now();
  const model = {
    tables: existingModel.tables.map((t) => ({ ...t, columns: [...t.columns], foreignKeys: [...t.foreignKeys], indexes: [...t.indexes], migrationVersions: [...t.migrationVersions] })),
    foreignKeys: [],
    migrations: [...(existingModel.migrations || [])],
    domains: [],
    databases: [],
    views: [...(existingModel.views || [])],
    triggers: [...(existingModel.triggers || [])],
    procedures: [...(existingModel.procedures || [])],
    layout,
  };

  const newManifest = [...existingManifest];
  for (const file of newFiles) {
    const hash = fileHash(file.filePath);
    const key = file.relativePath || file.fileName;
    const existingIdx = newManifest.findIndex((m) => (m.relativePath || m.fileName) === key);
    const entry = { fileName: file.fileName, relativePath: file.relativePath, version: file.version, hash };
    if (existingIdx >= 0) newManifest[existingIdx] = entry;
    else newManifest.push(entry);

    const content = fs.readFileSync(file.filePath, 'utf-8');
    applySqlFile(model, file, content, { layout });
  }

  model.migrations.sort((a, b) => {
    const cmp = versionCompare(a.version, b.version);
    if (cmp !== 0) return cmp;
    return (a.relativePath || a.fileName).localeCompare(b.relativePath || b.fileName);
  });
  model.foreignKeys = buildForeignKeysArray(model.tables);
  model.domains = buildDomainsArray(model.tables);
  model.databases = buildDatabasesArray(model.tables);

  const durationMs = Date.now() - startTime;
  model._meta = buildMeta(migrationDir, sortedFiles, model, durationMs, true, newManifest, layout);

  return model;
}

export function analyzeSingleSqlFile(filePath) {
  return analyzeSqlFileFromDisk(filePath);
}

export { walkSqlFiles, detectLayout, prepareFiles, buildDatabasesArray };
