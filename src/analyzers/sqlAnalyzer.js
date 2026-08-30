// SQL 迁移脚本解析器：解析单个 .sql 文件，提取结构化 SQL 操作
// 与 tsAnalyzer/goAnalyzer 等并列，遵循分析器分层约定：纯函数模块，无副作用
// 支持 MySQL DDL/DML：CREATE TABLE, ALTER TABLE, CREATE INDEX, DROP TABLE,
//   INSERT, UPDATE + CREATE VIEW/TRIGGER/PROCEDURE/FUNCTION（扩展支持）
// 处理幂等 DDL 模式：SET @col_exists := ...; PREPARE stmt FROM @sql; EXECUTE stmt;

import path from 'node:path';

// 从文件名提取 Flyway 版本信息
export function parseMigrationFileName(fileName) {
  const base = path.basename(fileName);
  const match = base.match(/^V(\d+\.\d+\.\d+)_{1,2}(.+?)\.sql$/i);
  if (match) {
    return { version: `V${match[1]}`, description: match[2].replace(/_/g, ' ') };
  }
  const fallback = base.match(/^V(\d+\.\d+\.\d+)_(.+?)\.sql$/i);
  if (fallback) {
    return { version: `V${fallback[1]}`, description: fallback[2].replace(/_/g, ' ') };
  }
  return { version: base.replace(/\.sql$/i, ''), description: base.replace(/\.sql$/i, '') };
}

// 从 sprint 风格目录路径提取版本信息
// 例: sqls/sprint14_2/incrementsql/1-aise-all-db.sql → { version: 'V14.2', description: 'sprint14_2 incrementsql 1-aise-all-db' }
export function parseSprintFilePath(filePath, rootDir) {
  const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/');
  const parts = relPath.split('/');
  // 找 sprintXX_Y 目录
  let sprintDir = '';
  let sprintIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^sprint(\d+)(?:[_\-.](\d+))?/i);
    if (m) {
      sprintDir = parts[i];
      sprintIdx = i;
      break;
    }
  }
  if (sprintIdx < 0) {
    // 非 sprint 目录，用文件名作为版本
    const base = path.basename(filePath);
    return { version: base.replace(/\.sql$/i, ''), description: base.replace(/\.sql$/i, ''), sprint: null };
  }
  const m = sprintDir.match(/^sprint(\d+)(?:[_\-.](\d+))?/i);
  const major = m[1];
  const minor = m[2] || '0';
  const version = `V${major}.${minor}`;
  // 描述 = sprint名 + 子目录 + 文件名前缀
  const subParts = parts.slice(sprintIdx + 1, -1); // 排除 sprint 目录和文件名
  const fileName = path.basename(filePath);
  const filePrefix = fileName.replace(/\.sql$/i, '');
  const description = [sprintDir, ...subParts, filePrefix].filter(Boolean).join(' / ');
  return { version, description, sprint: sprintDir, subPath: subParts.join('/') };
}

// 提取 SQL 模板中的有效内容（"执行脚本开始{" 和 "}执行脚本结束" 之间）
// 如果找不到标记，返回原始内容
// 同时保留每个模板块之前最近的 USE 语句，以维持数据库上下文
export function extractTemplateContent(content) {
  const results = [];
  const re = /执行脚本开始\s*\{[\s\S]*?\}执行脚本结束/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    // 查找这个模板块之前最近的 USE 语句
    const beforeMatch = content.slice(0, match.index);
    const useMatches = [...beforeMatch.matchAll(/USE\s+`?([\w-]+)`?\s*;/gi)];
    const lastUse = useMatches.length > 0 ? useMatches[useMatches.length - 1][0] : null;

    // 去掉首尾的标记
    let inner = match[0];
    inner = inner.replace(/^执行脚本开始\s*\{\s*/, '');
    inner = inner.replace(/\s*\}\s*执行脚本结束$/, '');

    // 如果有 USE 语句，加在内容前面
    if (lastUse && inner.trim()) {
      results.push(lastUse + '\n' + inner);
    } else if (inner.trim()) {
      results.push(inner);
    }
  }
  if (results.length === 0) return content;
  return results.join('\n');
}

// 从 SQL 内容中提取所有 USE 语句切换的数据库
// 返回 { databases: string[], currentDb: string|null }
export function extractDatabases(content) {
  const databases = [];
  let currentDb = null;
  const useRe = /USE\s+`?([\w-]+)`?\s*;/gi;
  let m;
  while ((m = useRe.exec(content)) !== null) {
    if (!databases.includes(m[1])) databases.push(m[1]);
    currentDb = m[1]; // 最后一个
  }
  // 也从 CREATE DATABASE 提取
  const createDbRe = /CREATE\s+DATABASE\s+(?:\/\*!\d+\s+IF\s+NOT\s+EXISTS\s*\*\/\s+)?`?([\w-]+)`?/gi;
  while ((m = createDbRe.exec(content)) !== null) {
    if (!databases.includes(m[1])) databases.push(m[1]);
  }
  return { databases, currentDb };
}

// 预处理：移除 SQL 注释，保留字符串内容
function stripComments(content) {
  let result = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1];
    if (inString) {
      result += ch;
      if (ch === '\\' && i + 1 < content.length) {
        result += next;
        i += 2;
        continue;
      }
      if (ch === stringChar) inString = false;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      result += ch;
      i++;
      continue;
    }
    if (ch === '-' && next === '-') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

// 语句分割：按 ; 分割，但跳过字符串内的 ; 和 BEGIN...END 块
function splitStatements(content) {
  const statements = [];
  let current = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  let beginDepth = 0;

  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1];

    if (inString) {
      current += ch;
      if (ch === '\\' && i + 1 < content.length) {
        current += next;
        i += 2;
        continue;
      }
      if (ch === stringChar) inString = false;
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      current += ch;
      i++;
      continue;
    }

    const upperRest = content.slice(i, i + 10).toUpperCase();
    if (upperRest.startsWith('BEGIN') && !content[i + 5]?.match(/[A-Z_]/i)) {
      beginDepth++;
      current += content.slice(i, i + 5);
      i += 5;
      continue;
    }
    if (upperRest.startsWith('END') && !content[i + 3]?.match(/[A-Z_]/i)) {
      if (beginDepth > 0) beginDepth--;
      current += content.slice(i, i + 3);
      i += 3;
      continue;
    }

    if (ch === ';' && beginDepth === 0) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }
  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);
  return statements;
}

// 提取反引号或裸名
function extractName(str) {
  const m = str.match(/`([^`]+)`/);
  return m ? m[1] : str.trim().split(/\s+/)[0];
}

// 解析列列表 (col1, col2, `col3`)
function parseColumnList(str) {
  return str.split(',').map((c) => extractName(c.trim())).filter(Boolean);
}

// 解析 CREATE TABLE
function parseCreateTable(stmt) {
  const headerMatch = stmt.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)/i);
  if (!headerMatch) return null;
  const tableName = extractName(headerMatch[1]);

  const bodyStart = stmt.indexOf('(');
  const bodyEnd = stmt.lastIndexOf(')');
  if (bodyStart === -1 || bodyEnd === -1) return null;
  const body = stmt.slice(bodyStart + 1, bodyEnd);

  const tableOptions = stmt.slice(bodyEnd + 1);
  const columns = [];
  const foreignKeys = [];
  const indexes = [];
  let primaryKey = [];

  const parts = splitTableBody(body);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const upper = trimmed.toUpperCase();

    if (upper.startsWith('PRIMARY KEY')) {
      const colsMatch = trimmed.match(/\(([^)]+)\)/);
      if (colsMatch) primaryKey = parseColumnList(colsMatch[1]);
      continue;
    }

    if (upper.startsWith('FOREIGN KEY') || upper.startsWith('CONSTRAINT')) {
      const fk = parseForeignKeyClause(trimmed);
      if (fk) {
        foreignKeys.push(fk);
        continue;
      }
    }

    if (upper.startsWith('UNIQUE') || upper.startsWith('INDEX') || upper.startsWith('KEY') || upper.startsWith('FULLTEXT')) {
      const idx = parseIndexClause(trimmed);
      if (idx) {
        indexes.push(idx);
        continue;
      }
    }

    const col = parseColumnDef(trimmed);
    if (col) columns.push(col);
  }

  const engine = tableOptions.match(/ENGINE\s*=\s*(\w+)/i)?.[1] || 'InnoDB';
  const charset = tableOptions.match(/(?:DEFAULT\s+)?CHARSET\s*=\s*(\w+)/i)?.[1] || 'utf8mb4';
  const collate = tableOptions.match(/COLLATE\s*=\s*(\w+)/i)?.[1] || null;
  const comment = tableOptions.match(/COMMENT\s*=\s*'([^']*)'/i)?.[1] || null;

  return { tableName, columns, primaryKey, foreignKeys, indexes, comment, engine, charset, collate };
}

function splitTableBody(body) {
  const parts = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let stringChar = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      current += ch;
      if (ch === '\\' && i + 1 < body.length) { current += body[i + 1]; i++; continue; }
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === "'" || ch === '"') { inString = true; stringChar = ch; current += ch; continue; }
    if (ch === '(') { depth++; current += ch; continue; }
    if (ch === ')') { depth--; current += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function parseColumnDef(def) {
  const m = def.match(/^(`?\w+`?)\s+(.+)$/);
  if (!m) return null;
  const name = extractName(m[1]);
  const rest = m[2].trim();
  const typeMatch = rest.match(/^([A-Z]+\s*(?:\([^)]+\))?(?:\s+UNSIGNED)?)\s*(.*)$/i);
  const type = typeMatch ? typeMatch[1].trim().replace(/\s+/g, ' ') : rest.split(/\s+/)[0];
  const modifiers = typeMatch ? typeMatch[2] : rest;

  const nullable = !/NOT\s+NULL/i.test(modifiers);
  const autoIncrement = /AUTO_INCREMENT/i.test(modifiers);
  const defaultMatch = modifiers.match(/DEFAULT\s+('([^']*)'|NULL|CURRENT_TIMESTAMP|\d+|[A-Z_]+)/i);
  const defaultValue = defaultMatch ? (defaultMatch[2] !== undefined ? defaultMatch[2] : defaultMatch[1]) : null;
  const commentMatch = modifiers.match(/COMMENT\s+'([^']*)'/i);
  const comment = commentMatch ? commentMatch[1] : null;

  let key = null;
  if (/\bPRIMARY\s+KEY\b/i.test(modifiers)) key = 'PK';
  else if (/\bUNIQUE\b/i.test(modifiers)) key = 'UNIQUE';

  return { name, type, nullable, key, default: defaultValue, autoIncrement, comment };
}

function parseForeignKeyClause(clause) {
  const fkMatch = clause.match(/(?:CONSTRAINT\s+`?(\w+)`?\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+`?(\w+)`?\s*\(([^)]+)\)(.*)/i);
  if (!fkMatch) return null;
  const name = fkMatch[1] || null;
  const columns = parseColumnList(fkMatch[2]);
  const refTable = fkMatch[3];
  const refColumns = parseColumnList(fkMatch[4]);
  const rest = fkMatch[5] || '';
  const onDelete = rest.match(/ON\s+DELETE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION|SET\s+DEFAULT)/i)?.[1]?.toUpperCase().replace(/\s+/g, ' ') || null;
  const onUpdate = rest.match(/ON\s+UPDATE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION|SET\s+DEFAULT)/i)?.[1]?.toUpperCase().replace(/\s+/g, ' ') || null;
  return { name, columns, refTable, refColumns, onDelete, onUpdate };
}

function parseIndexClause(clause) {
  const m = clause.match(/^(UNIQUE|FULLTEXT|SPATIAL)?\s*(?:INDEX|KEY)\s+`?(\w+)`?\s*\(([^)]+)\)/i);
  if (!m) return null;
  const typePrefix = m[1]?.toUpperCase();
  const indexType = typePrefix === 'UNIQUE' ? 'UNIQUE'
    : typePrefix === 'FULLTEXT' ? 'FULLTEXT'
    : typePrefix === 'SPATIAL' ? 'SPATIAL'
    : 'NORMAL';
  return { name: m[2], columns: parseColumnList(m[3]), unique: indexType === 'UNIQUE', indexType };
}

// 解析 ALTER TABLE
function parseAlterTable(stmt) {
  const m = stmt.match(/^ALTER\s+TABLE\s+`?(\w+)`?\s+(.*)$/is);
  if (!m) return null;
  const tableName = m[1];
  const actionsStr = m[2].trim();
  const actionParts = splitAlterActions(actionsStr);
  const actions = [];
  for (const part of actionParts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const action = parseAlterAction(trimmed);
    if (action) actions.push(action);
  }
  return { tableName, actions };
}

function splitAlterActions(str) {
  const parts = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let stringChar = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      current += ch;
      if (ch === '\\' && i + 1 < str.length) { current += str[i + 1]; i++; continue; }
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === "'" || ch === '"') { inString = true; stringChar = ch; current += ch; continue; }
    if (ch === '(') { depth++; current += ch; continue; }
    if (ch === ')') { depth--; current += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function parseAlterAction(actionStr) {
  const upper = actionStr.toUpperCase();

  const addCol = actionStr.match(/^ADD\s+(?:COLUMN\s+)?(`?\w+`?)\s+(.+)$/i);
  if (addCol && !upper.includes('CONSTRAINT') && !upper.includes('INDEX') && !upper.includes('KEY') && !upper.includes('FOREIGN')) {
    const name = extractName(addCol[1]);
    const col = parseColumnDef(`${name} ${addCol[2]}`);
    if (col) return { type: 'addColumn', column: col };
  }

  const dropCol = actionStr.match(/^DROP\s+(?:COLUMN\s+)?`?(\w+)`?/i);
  if (dropCol) return { type: 'dropColumn', columnName: dropCol[1] };

  const modifyCol = actionStr.match(/^MODIFY\s+(?:COLUMN\s+)?(`?\w+`?)\s+(.+)$/i);
  if (modifyCol) {
    const name = extractName(modifyCol[1]);
    const col = parseColumnDef(`${name} ${modifyCol[2]}`);
    if (col) return { type: 'modifyColumn', column: col };
  }

  const changeCol = actionStr.match(/^CHANGE\s+(?:COLUMN\s+)?(`?\w+`?)\s+(`?\w+`?)\s+(.+)$/i);
  if (changeCol) {
    const oldName = extractName(changeCol[1]);
    const newName = extractName(changeCol[2]);
    const col = parseColumnDef(`${newName} ${changeCol[3]}`);
    if (col) return { type: 'modifyColumn', column: col, oldColumnName: oldName };
  }

  const addFk = actionStr.match(/^ADD\s+(?:CONSTRAINT\s+`?(\w+)`?\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+`?(\w+)`?\s*\(([^)]+)\)(.*)/i);
  if (addFk) {
    return {
      type: 'addForeignKey',
      foreignKey: {
        name: addFk[1] || null,
        columns: parseColumnList(addFk[2]),
        refTable: addFk[3],
        refColumns: parseColumnList(addFk[4]),
        onDelete: addFk[5]?.match(/ON\s+DELETE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION|SET\s+DEFAULT)/i)?.[1]?.toUpperCase().replace(/\s+/g, ' ') || null,
        onUpdate: addFk[5]?.match(/ON\s+UPDATE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION|SET\s+DEFAULT)/i)?.[1]?.toUpperCase().replace(/\s+/g, ' ') || null,
      },
    };
  }

  const addIdx = actionStr.match(/^ADD\s+(UNIQUE|FULLTEXT|SPATIAL)?\s*(?:INDEX|KEY)\s+`?(\w+)`?\s*\(([^)]+)\)/i);
  if (addIdx) {
    const typePrefix = addIdx[1]?.toUpperCase();
    const indexType = typePrefix === 'UNIQUE' ? 'UNIQUE'
      : typePrefix === 'FULLTEXT' ? 'FULLTEXT'
      : typePrefix === 'SPATIAL' ? 'SPATIAL'
      : 'NORMAL';
    return { type: 'addIndex', index: { name: addIdx[2], columns: parseColumnList(addIdx[3]), unique: indexType === 'UNIQUE', indexType } };
  }

  const dropIdx = actionStr.match(/^DROP\s+(?:INDEX|KEY|FOREIGN\s+KEY)\s+`?(\w+)`?/i);
  if (dropIdx) {
    const kw = dropIdx[0].toUpperCase();
    if (kw.includes('FOREIGN')) return { type: 'dropForeignKey', name: dropIdx[1] };
    return { type: 'dropIndex', name: dropIdx[1] };
  }

  return null;
}

// 解析 CREATE INDEX
function parseCreateIndex(stmt) {
  const m = stmt.match(/^CREATE\s+(UNIQUE|FULLTEXT|SPATIAL)?\s*INDEX\s+`?(\w+)`?\s+ON\s+`?(\w+)`?\s*\(([^)]+)\)/i);
  if (!m) return null;
  const typePrefix = m[1]?.toUpperCase();
  const indexType = typePrefix === 'UNIQUE' ? 'UNIQUE'
    : typePrefix === 'FULLTEXT' ? 'FULLTEXT'
    : typePrefix === 'SPATIAL' ? 'SPATIAL'
    : 'NORMAL';
  return { indexName: m[2], tableName: m[3], columns: parseColumnList(m[4]), unique: indexType === 'UNIQUE', indexType };
}

// 解析 DROP TABLE
function parseDropTable(stmt) {
  const m = stmt.match(/^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?`?(\w+)`?/i);
  if (!m) return null;
  return { tableName: m[1] };
}

// 解析 CREATE VIEW
function parseCreateView(stmt) {
  const m = stmt.match(/^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+`?(\w+)`?\s*(?:\(([^)]+)\))?\s+AS\s+(.*)$/is);
  if (!m) return null;
  return { viewName: m[1], columns: m[2] ? parseColumnList(m[2]) : [], definition: m[3].trim() };
}

// 解析 CREATE TRIGGER
function parseCreateTrigger(stmt) {
  const m = stmt.match(/^CREATE\s+TRIGGER\s+`?(\w+)`?\s+(BEFORE|AFTER)\s+(INSERT|UPDATE|DELETE)\s+ON\s+`?(\w+)`?\s+FOR\s+EACH\s+ROW\s*(.*)$/is);
  if (!m) return null;
  return { triggerName: m[1], timing: m[2].toUpperCase(), event: m[3].toUpperCase(), tableName: m[4], statement: m[5].trim() };
}

// 解析 CREATE PROCEDURE / FUNCTION
function parseCreateProcedure(stmt) {
  const m = stmt.match(/^CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(PROCEDURE|FUNCTION)\s+`?(\w+)`?\s*\(([^)]*)\)\s*(.*)$/is);
  if (!m) return null;
  return {
    type: m[1].toUpperCase(),
    procedureName: m[2],
    parameters: m[3].trim(),
    body: m[4].trim(),
  };
}

// 从幂等 DDL 模式提取实际 DDL 语句
function extractIdempotentDdl(content) {
  const results = [];
  const pattern = /SET\s+@sql\s*:=\s*IF\s*\(\s*[^,]+,\s*'([^']+)',\s*'[^']*'\s*\)/gi;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const ddl = match[1].trim();
    if (ddl && ddl.toUpperCase() !== 'SELECT 1') {
      results.push(ddl);
    }
  }
  return results;
}

// 解析单个 SQL 文件
export function analyzeSqlFile(filePath, content, options = {}) {
  const fileName = path.basename(filePath);
  const fileSize = Buffer.byteLength(content, 'utf-8');

  // 版本信息：优先从 options 传入（由调用方根据布局模式决定）
  let version = options.version;
  let description = options.description;
  if (!version) {
    const parsed = parseMigrationFileName(fileName);
    version = parsed.version;
    description = parsed.description;
  }

  // 模板内容提取（sprint 风格模板）
  let effectiveContent = content;
  if (options.extractTemplate) {
    const extracted = extractTemplateContent(content);
    // 如果提取后内容很少且没有 DDL，可能是空模板，保留原始内容
    if (extracted.trim().length > 20 || /CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+INDEX/i.test(extracted)) {
      effectiveContent = extracted;
    }
  }

  // 检测数据库上下文
  const dbInfo = extractDatabases(effectiveContent);

  const cleaned = stripComments(effectiveContent);
  const statements = splitStatements(cleaned);

  const idempotentDdls = extractIdempotentDdl(cleaned);
  const allStatements = [...statements];
  for (const ddl of idempotentDdls) {
    const ddlStmts = splitStatements(ddl);
    allStatements.push(...ddlStmts);
  }

  const operations = {
    createTable: [],
    alterTable: [],
    createIndex: [],
    dropTable: [],
    createView: [],
    createTrigger: [],
    createProcedure: [],
    insert: [],
    update: [],
  };

  const tableNames = new Set();
  let hasIdempotentDdl = idempotentDdls.length > 0;
  let currentDatabase = dbInfo.currentDb; // 初始为最后一个 USE 的数据库（或 null）

  // 由于语句是按顺序处理的，我们需要从头追踪 USE 切换
  // 所以重置 currentDatabase，按语句顺序追踪
  currentDatabase = null;

  for (const stmt of allStatements) {
    const upper = stmt.toUpperCase().trim();

    // 检测 USE 语句，切换当前数据库
    const useMatch = stmt.match(/^USE\s+`?([\w-]+)`?\s*;?\s*$/i);
    if (useMatch) {
      currentDatabase = useMatch[1];
      continue;
    }

    if (upper.startsWith('CREATE TABLE') || upper.startsWith('CREATE  TABLE')) {
      const table = parseCreateTable(stmt);
      if (table) {
        table.database = currentDatabase;
        operations.createTable.push(table);
        tableNames.add(table.tableName);
      }
      continue;
    }

    if (upper.startsWith('ALTER TABLE')) {
      const alter = parseAlterTable(stmt);
      if (alter) {
        alter.database = currentDatabase;
        operations.alterTable.push(alter);
        tableNames.add(alter.tableName);
      }
      continue;
    }

    if (upper.startsWith('CREATE') && upper.includes('INDEX') && !upper.includes('TABLE')) {
      const idx = parseCreateIndex(stmt);
      if (idx) {
        idx.database = currentDatabase;
        operations.createIndex.push(idx);
        tableNames.add(idx.tableName);
      }
      continue;
    }

    if (upper.startsWith('DROP TABLE')) {
      const drop = parseDropTable(stmt);
      if (drop) {
        drop.database = currentDatabase;
        operations.dropTable.push(drop);
        tableNames.add(drop.tableName);
      }
      continue;
    }

    if (upper.startsWith('CREATE') && upper.includes('VIEW')) {
      const view = parseCreateView(stmt);
      if (view) {
        view.database = currentDatabase;
        operations.createView.push(view);
      }
      continue;
    }

    if (upper.startsWith('CREATE') && upper.includes('TRIGGER')) {
      const trigger = parseCreateTrigger(stmt);
      if (trigger) {
        trigger.database = currentDatabase;
        operations.createTrigger.push(trigger);
      }
      continue;
    }

    if (upper.startsWith('CREATE') && (upper.includes('PROCEDURE') || upper.includes('FUNCTION'))) {
      const proc = parseCreateProcedure(stmt);
      if (proc) {
        proc.database = currentDatabase;
        operations.createProcedure.push(proc);
      }
      continue;
    }

    if (upper.startsWith('INSERT')) {
      const m = stmt.match(/INSERT\s+(?:IGNORE\s+)?INTO\s+`?([\w-]+)`?/i);
      if (m) {
        operations.insert.push({ tableName: m[1], database: currentDatabase, rowCount: 1 });
        tableNames.add(m[1]);
      }
      continue;
    }

    if (upper.startsWith('UPDATE')) {
      const m = stmt.match(/^UPDATE\s+`?([\w-]+)`?\s+SET\s+(.*)$/is);
      if (m) {
        const whereMatch = m[2].match(/WHERE\s+(.*)$/is);
        operations.update.push({ tableName: m[1], database: currentDatabase, whereClause: whereMatch ? whereMatch[1].trim() : null });
        tableNames.add(m[1]);
      }
      continue;
    }
  }

  const operationSummary = {
    createTable: operations.createTable.length,
    alterTable: operations.alterTable.length,
    createIndex: operations.createIndex.length,
    dropTable: operations.dropTable.length,
    insert: operations.insert.length,
    update: operations.update.length,
    createView: operations.createView.length,
    createTrigger: operations.createTrigger.length,
    createProcedure: operations.createProcedure.length,
  };

  return {
    fileName,
    version,
    description,
    fileSize,
    operations,
    tableNames: [...tableNames],
    hasIdempotentDdl,
    rawStatementCount: allStatements.length,
    operationSummary,
    databases: dbInfo.databases,
    currentDatabase: dbInfo.currentDb,
    isEmptyTemplate: options.extractTemplate && effectiveContent.trim().length <= 20 && !/CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+INDEX/i.test(effectiveContent),
  };
}
