// 数据库审计纯函数模块
// 7 大审计场景：健康度 / 迁移影响 / 领域依赖 / 索引优化 / 模型演进 / 外键链路 / 命名规范
// 全部基于 dbDataMap 输入，无副作用，便于测试和复用

import { DOMAIN_RULES, versionCompare } from './dbModel.js';

// ============================================================
//  1. auditHealth — Schema 健康度总审计
// ============================================================

export function auditHealth(dbDataMap) {
  const tables = dbDataMap.tables || [];
  const foreignKeys = dbDataMap.foreignKeys || [];
  const tableNames = new Set(tables.map((t) => t.name));

  const dimensions = {};

  // ---- 完整性 ----
  const noPkTables = tables.filter((t) => (t.primaryKey || []).length === 0).map((t) => t.name);
  const danglingFks = foreignKeys.filter((fk) => !tableNames.has(fk.toTable)).map((fk) => fk.name);
  const completenessScore = Math.round(
    100 - (noPkTables.length / Math.max(tables.length, 1)) * 30 - (danglingFks.length / Math.max(foreignKeys.length, 1)) * 20,
  );
  dimensions.completeness = {
    score: Math.max(0, Math.min(100, completenessScore)),
    issues: [
      ...noPkTables.map((name) => ({ severity: 'high', type: 'no_primary_key', table: name, message: `${name} 表无主键` })),
      ...danglingFks.map((name) => ({ severity: 'high', type: 'dangling_fk', fk: name, message: `外键 ${name} 指向不存在的表` })),
    ],
  };

  // ---- 一致性（命名 + 注释）----
  const mixedNaming = tables.filter((t) => /[A-Z]/.test(t.name) && t.name.includes('_')).map((t) => t.name);
  const tablesWithoutComment = tables.filter((t) => !t.comment).map((t) => t.name);
  const colsWithoutComment = tables.reduce((sum, t) => {
    return sum + (t.columns || []).filter((c) => !c.comment).length;
  }, 0);
  const totalCols = tables.reduce((sum, t) => sum + (t.columns || []).length, 0);
  const consistencyScore = Math.round(
    100 - (mixedNaming.length / Math.max(tables.length, 1)) * 20 - (tablesWithoutComment.length / Math.max(tables.length, 1)) * 25 - (colsWithoutComment / Math.max(totalCols, 1)) * 15,
  );
  dimensions.consistency = {
    score: Math.max(0, Math.min(100, consistencyScore)),
    issues: [
      ...mixedNaming.slice(0, 10).map((name) => ({ severity: 'medium', type: 'mixed_naming', table: name, message: `${name} 命名风格混合（大小写+下划线）` })),
      ...tablesWithoutComment.slice(0, 10).map((name) => ({ severity: 'low', type: 'no_table_comment', table: name, message: `${name} 表无注释` })),
    ],
    stats: { tablesWithoutComment: tablesWithoutComment.length, colsWithoutComment, totalCols },
  };

  // ---- 索引质量 ----
  const idxResult = computeIndexStats(tables, foreignKeys);
  const indexScore = Math.round(
    100 - (idxResult.unindexedFkRatio) * 30 - (idxResult.redundantIndexCount / Math.max(idxResult.totalIndexCount, 1)) * 20 - (idxResult.noSecondaryIndexTables / Math.max(tables.length, 1)) * 15,
  );
  dimensions.indexQuality = {
    score: Math.max(0, Math.min(100, indexScore)),
    issues: [
      ...idxResult.unindexedFks.slice(0, 10).map((item) => ({ severity: 'medium', type: 'fk_no_index', table: item.table, column: item.column, message: `${item.table}.${item.column} 外键列无索引` })),
      ...idxResult.redundantIndexes.slice(0, 5).map((item) => ({ severity: 'low', type: 'redundant_index', table: item.table, index: item.index, redundantWith: item.redundantWith, message: `${item.table} 的 ${item.index} 是 ${item.redundantWith} 的左前缀冗余` })),
    ],
    stats: {
      totalIndexCount: idxResult.totalIndexCount,
      unindexedFkCount: idxResult.unindexedFks.length,
      unindexedFkRatio: idxResult.unindexedFkRatio,
      redundantIndexCount: idxResult.redundantIndexCount,
      noSecondaryIndexTables: idxResult.noSecondaryIndexTables,
    },
  };

  // ---- 模式健康 ----
  const softDeleteTables = tables.filter((t) => (t.patterns || []).includes('soft_delete'));
  const auditColTables = tables.filter((t) => (t.patterns || []).includes('audit_columns'));
  const multiTenantTables = tables.filter((t) => (t.patterns || []).includes('multi_tenant'));
  // 模式一致性：有软删除的表中 deleted_at 命名是否统一
  const softDeleteInconsistent = softDeleteTables.filter((t) => {
    const col = (t.columns || []).find((c) => c.name === 'delete_flag' || c.name === 'deleted_at');
    return col && col.name !== 'deleted_at';
  }).map((t) => t.name);
  const patternScore = Math.round(
    100 - (softDeleteInconsistent.length / Math.max(softDeleteTables.length, 1)) * 15,
  );
  dimensions.patternHealth = {
    score: Math.max(0, Math.min(100, patternScore)),
    issues: [
      ...softDeleteInconsistent.slice(0, 5).map((name) => ({ severity: 'low', type: 'soft_delete_inconsistent', table: name, message: `${name} 软删除列命名不统一（建议统一为 deleted_at）` })),
    ],
    stats: {
      softDeleteCount: softDeleteTables.length,
      auditColumnsCount: auditColTables.length,
      multiTenantCount: multiTenantTables.length,
    },
  };

  // ---- 综合评分 ----
  const weights = { completeness: 0.3, consistency: 0.25, indexQuality: 0.3, patternHealth: 0.15 };
  const totalScore = Math.round(
    dimensions.completeness.score * weights.completeness +
    dimensions.consistency.score * weights.consistency +
    dimensions.indexQuality.score * weights.indexQuality +
    dimensions.patternHealth.score * weights.patternHealth,
  );
  const grade = totalScore >= 90 ? 'A' : totalScore >= 75 ? 'B' : totalScore >= 60 ? 'C' : 'D';

  // ---- Top Issues（按严重程度排序）----
  const allIssues = [];
  for (const dim of Object.values(dimensions)) {
    allIssues.push(...(dim.issues || []));
  }
  const severityRank = { high: 0, medium: 1, low: 2 };
  allIssues.sort((a, b) => (severityRank[a.severity] ?? 99) - (severityRank[b.severity] ?? 99));

  // ---- 建议 ----
  const recommendations = [];
  if (noPkTables.length) recommendations.push(`为 ${noPkTables.length} 张无主键表添加主键（推荐自增 ID 或 UUID）`);
  if (danglingFks.length) recommendations.push(`修复 ${danglingFks.length} 个悬挂外键（指向不存在的表）`);
  if (idxResult.unindexedFks.length) recommendations.push(`为 ${idxResult.unindexedFks.length} 个外键列添加索引，提升 JOIN 性能`);
  if (tablesWithoutComment.length > 3) recommendations.push('为表和列补充 COMMENT 注释，提升可维护性');
  if (softDeleteInconsistent.length) recommendations.push('统一软删除列命名为 deleted_at（DATETIME 类型）');

  return {
    score: totalScore,
    grade,
    dimensions,
    topIssues: allIssues.slice(0, 15),
    recommendations,
    totalIssues: allIssues.length,
  };
}

// ============================================================
//  2. auditImpact — 迁移影响分析
// ============================================================

export function auditImpact(dbDataMap, version) {
  const migrations = dbDataMap.migrations || [];
  const tables = dbDataMap.tables || [];
  const foreignKeys = dbDataMap.foreignKeys || [];

  // 匹配所有版本前缀相同的迁移（如 V2.1 匹配 V2.1.0, V2.1.1, V2.1.19...）
  const matched = migrations.filter((m) => {
    const v = m.version || '';
    return v === version || v.startsWith(version + '.') || v.startsWith(version + '__') || v.startsWith(version + '_');
  });
  if (!matched.length) {
    // 宽松匹配：版本号包含
    const loose = migrations.filter((m) => (m.version || '').includes(version));
    if (!loose.length) return { error: `未找到迁移版本: ${version}`, found: false };
    matched.push(...loose.slice(0, 20));
  }

  // 汇总受影响表（使用 tableNames 字段）
  const affectedTables = new Set();
  const createdTables = [];
  const alteredTables = [];
  const droppedTables = [];
  let totalOperations = 0;
  const totalOperationSummary = {};

  for (const mig of matched) {
    const summary = mig.operationSummary || {};
    for (const [k, v] of Object.entries(summary)) {
      totalOperationSummary[k] = (totalOperationSummary[k] || 0) + v;
      totalOperations += v;
    }
    const tbls = mig.tableNames || [];
    for (const t of tbls) affectedTables.add(t);
    // 判断是新建表还是修改表（通过 migrationVersion 匹配）
    for (const t of tbls) {
      const tbl = tables.find((x) => x.name === t);
      if (tbl) {
        if (tbl.migrationVersion === mig.version && summary.createTable && summary.createTable > 0) {
          if (!createdTables.includes(t)) createdTables.push(t);
        } else {
          if (!alteredTables.includes(t) && !createdTables.includes(t)) alteredTables.push(t);
        }
      }
    }
  }

  // 级联影响：外键引用了被修改表的其他表
  const cascadeAffected = [];
  for (const fk of foreignKeys) {
    if (affectedTables.has(fk.toTable) && !affectedTables.has(fk.fromTable)) {
      cascadeAffected.push({ fromTable: fk.fromTable, fkName: fk.name, toTable: fk.toTable });
    }
  }

  // 风险等级（基于操作类型权重）
  const riskWeights = {
    dropTable: 10, dropColumn: 9, alterColumn: 7, renameTable: 8,
    addColumn: 3, createIndex: 2, createTable: 1, insert: 1, update: 2,
    alterTable: 5, createView: 2, dropIndex: 4,
  };
  let maxRisk = 0;
  let totalRisk = 0;
  for (const [opType, count] of Object.entries(totalOperationSummary)) {
    const w = riskWeights[opType] || 3;
    maxRisk = Math.max(maxRisk, w);
    totalRisk += w * count;
  }
  const riskLevel = maxRisk >= 9 ? 'high' : maxRisk >= 6 ? 'medium' : 'low';

  return {
    found: true,
    version,
    matchedMigrations: matched.length,
    migrationList: matched.map((m) => ({
      version: m.version, description: m.description, fileName: m.fileName,
      operationSummary: m.operationSummary || {},
    })),
    affectedTableCount: affectedTables.size,
    affectedTables: Array.from(affectedTables),
    createdTables,
    alteredTables,
    cascadeImpactCount: cascadeAffected.length,
    cascadeImpact: cascadeAffected.slice(0, 30),
    riskLevel,
    riskScore: maxRisk,
    totalRiskScore: totalRisk,
    totalOperations,
    operationSummary: totalOperationSummary,
  };
}

// ============================================================
//  3. auditDomains — 领域依赖图谱
// ============================================================

export function auditDomains(dbDataMap) {
  const tables = dbDataMap.tables || [];
  const foreignKeys = dbDataMap.foreignKeys || [];
  const domains = dbDataMap.domains || [];

  const tableDomainMap = new Map(tables.map((t) => [t.name, t.domain || 'other']));
  const domainKeys = domains.map((d) => d.key);
  if (!domainKeys.includes('other')) domainKeys.push('other');

  // 构建依赖矩阵
  const matrix = {};
  for (const from of domainKeys) {
    matrix[from] = {};
    for (const to of domainKeys) {
      matrix[from][to] = 0;
    }
  }

  for (const fk of foreignKeys) {
    const fromDom = tableDomainMap.get(fk.fromTable) || 'other';
    const toDom = tableDomainMap.get(fk.toTable) || 'other';
    if (matrix[fromDom] && matrix[fromDom][toDom] !== undefined) {
      matrix[fromDom][toDom] += 1;
    }
  }

  // 耦合度排名
  const coupling = domainKeys.map((key) => {
    let outDegree = 0;
    let inDegree = 0;
    for (const other of domainKeys) {
      if (other === key) continue;
      outDegree += matrix[key]?.[other] || 0;
      inDegree += matrix[other]?.[key] || 0;
    }
    const domain = domains.find((d) => d.key === key) || { key, label: key, tableCount: 0 };
    return {
      key,
      label: domain.label || key,
      tableCount: domain.tableCount || 0,
      outDegree,
      inDegree,
      totalDegree: outDegree + inDegree,
    };
  }).sort((a, b) => b.totalDegree - a.totalDegree);

  // 核心领域（被依赖最多的 Top 3，排除自引用）
  const coreDomains = [...coupling].sort((a, b) => b.inDegree - a.inDegree).slice(0, 3).map((d) => ({ key: d.key, label: d.label, inDegree: d.inDegree }));

  // 循环依赖检测（双向依赖即为循环）
  const circularDeps = [];
  for (let i = 0; i < domainKeys.length; i++) {
    for (let j = i + 1; j < domainKeys.length; j++) {
      const a = domainKeys[i];
      const b = domainKeys[j];
      if ((matrix[a]?.[b] || 0) > 0 && (matrix[b]?.[a] || 0) > 0) {
        circularDeps.push({ a, b, aToB: matrix[a][b], bToA: matrix[b][a] });
      }
    }
  }

  // 桑基图数据
  const sankeyLinks = [];
  for (const from of domainKeys) {
    for (const to of domainKeys) {
      if (from === to) continue;
      const count = matrix[from]?.[to] || 0;
      if (count > 0) sankeyLinks.push({ source: from, target: to, value: count });
    }
  }

  return {
    domains: domainKeys,
    matrix,
    coupling,
    coreDomains,
    circularDeps,
    sankeyLinks,
  };
}

// ============================================================
//  4. auditIndexes — 索引优化分析
// ============================================================

export function auditIndexes(dbDataMap) {
  const tables = dbDataMap.tables || [];
  const foreignKeys = dbDataMap.foreignKeys || [];
  const result = computeIndexStats(tables, foreignKeys);

  // 主键类型分布
  const pkTypeDistribution = { autoIncrementInt: 0, uuid: 0, composite: 0, other: 0 };
  for (const t of tables) {
    const pk = t.primaryKey || [];
    if (pk.length === 0) continue;
    if (pk.length > 1) { pkTypeDistribution.composite++; continue; }
    const pkCol = (t.columns || []).find((c) => c.name === pk[0]);
    if (!pkCol) { pkTypeDistribution.other++; continue; }
    const type = (pkCol.type || '').toUpperCase();
    if (pkCol.autoIncrement) pkTypeDistribution.autoIncrementInt++;
    else if (type.includes('CHAR') || type.includes('UUID')) pkTypeDistribution.uuid++;
    else pkTypeDistribution.other++;
  }

  // 宽索引（>4 列）
  const wideIndexes = [];
  for (const t of tables) {
    for (const idx of (t.indexes || [])) {
      if ((idx.columns || []).length > 4) {
        wideIndexes.push({ table: t.name, index: idx.name, columns: idx.columns, columnCount: idx.columns.length });
      }
    }
  }

  // 无二级索引表
  const noSecondaryIndexTables = tables.filter((t) => (t.indexes || []).length === 0).map((t) => t.name);

  const recommendations = [];
  if (result.unindexedFks.length) recommendations.push(`为 ${result.unindexedFks.length} 个外键列添加索引，提升 JOIN 查询性能`);
  if (result.redundantIndexCount) recommendations.push(`清理 ${result.redundantIndexCount} 个冗余索引（左前缀包含关系），减少写入开销`);
  if (wideIndexes.length) recommendations.push(`评估 ${wideIndexes.length} 个宽索引（>4列）是否必要，考虑拆分或精简`);
  if (pkTypeDistribution.uuid > 5) recommendations.push('UUID 主键的表较多，评估是否影响插入性能和索引大小');

  return {
    totalIndexCount: result.totalIndexCount,
    perTableAvg: Math.round((result.totalIndexCount / Math.max(tables.length, 1)) * 10) / 10,
    unindexedFkCount: result.unindexedFks.length,
    unindexedFkRatio: result.unindexedFkRatio,
    unindexedFks: result.unindexedFks.slice(0, 20),
    redundantIndexCount: result.redundantIndexCount,
    redundantIndexes: result.redundantIndexes.slice(0, 10),
    wideIndexCount: wideIndexes.length,
    wideIndexes: wideIndexes.slice(0, 10),
    noSecondaryIndexTables,
    pkTypeDistribution,
    recommendations,
  };
}

// ============================================================
//  5. auditEvolution — 模型演进分析
// ============================================================

export function auditEvolution(dbDataMap) {
  const migrations = [...(dbDataMap.migrations || [])].sort((a, b) => versionCompare(a.version, b.version));
  const tables = dbDataMap.tables || [];

  // 按版本的表数量增长
  let cumulativeTables = 0;
  const timeline = [];
  const domainFirstVersions = {};

  for (const m of migrations) {
    const created = m.tableCount || (m.operations || []).filter((o) => o.type === 'createTable').length;
    const dropped = (m.operations || []).filter((o) => o.type === 'dropTable').length;
    cumulativeTables += created - dropped;

    // 操作类型分布
    const opTypes = {};
    for (const op of (m.operations || [])) {
      const cat = op.type.includes('createTable') ? 'create'
        : op.type.includes('alter') ? 'alter'
        : op.type.includes('index') ? 'index'
        : op.type.includes('drop') ? 'drop'
        : op.type.includes('insert') || op.type.includes('update') ? 'dml'
        : 'other';
      opTypes[cat] = (opTypes[cat] || 0) + 1;
    }

    // 领域首版出现
    for (const tableName of (m.tableNames || [])) {
      const t = tables.find((x) => x.name === tableName);
      if (t && t.domain && !domainFirstVersions[t.domain]) {
        domainFirstVersions[t.domain] = m.version;
      }
    }

    timeline.push({
      version: m.version,
      description: m.description,
      cumulativeTables: Math.max(0, cumulativeTables),
      tableCount: m.tableCount || created,
      operationCount: (m.operations || []).length,
      opTypes,
    });
  }

  // 重大里程碑（表数变化较大的版本）
  const milestones = timeline
    .filter((t) => (t.tableCount || 0) >= 3)
    .map((t) => ({ version: t.version, description: t.description, tableCount: t.tableCount }));

  // 趋势描述
  const earlyCreate = timeline.slice(0, Math.ceil(timeline.length / 3));
  const lateAlter = timeline.slice(-Math.ceil(timeline.length / 3));
  const earlyCreateRatio = earlyCreate.reduce((s, t) => s + (t.opTypes?.create || 0), 0) / Math.max(earlyCreate.reduce((s, t) => s + t.operationCount, 0), 1);
  const lateAlterRatio = lateAlter.reduce((s, t) => s + (t.opTypes?.alter || 0), 0) / Math.max(lateAlter.reduce((s, t) => s + t.operationCount, 0), 1);

  return {
    totalVersions: migrations.length,
    finalTableCount: tables.length,
    timeline,
    milestones,
    domainFirstVersions,
    trends: {
      earlyCreateRatio: Math.round(earlyCreateRatio * 100) / 100,
      lateAlterRatio: Math.round(lateAlterRatio * 100) / 100,
      description: earlyCreateRatio > 0.5 && lateAlterRatio > 0.4
        ? '典型的演进模式：早期集中建表，后期以 ALTER 调整为主'
        : '演进模式混合，CREATE 和 ALTER 分布相对均匀',
    },
  };
}

// ============================================================
//  6. auditFkChain — 外键链路分析
// ============================================================

export function auditFkChain(dbDataMap, tableName) {
  const tables = dbDataMap.tables || [];
  const foreignKeys = dbDataMap.foreignKeys || [];

  const tableNames = new Set(tables.map((t) => t.name));
  if (!tableNames.has(tableName)) {
    return { error: `未找到表: ${tableName}`, found: false };
  }

  // 构建邻接表
  const outgoing = new Map(); // table -> [{ toTable, fkName, columns, onDelete }]
  const incoming = new Map(); // table -> [{ fromTable, fkName, columns, onDelete }]
  for (const fk of foreignKeys) {
    if (!outgoing.has(fk.fromTable)) outgoing.set(fk.fromTable, []);
    outgoing.get(fk.fromTable).push({
      toTable: fk.toTable, fkName: fk.name,
      columns: fk.fromColumns || fk.columns || [],
      onDelete: fk.onDelete, onUpdate: fk.onUpdate,
    });
    if (!incoming.has(fk.toTable)) incoming.set(fk.toTable, []);
    incoming.get(fk.toTable).push({
      fromTable: fk.fromTable, fkName: fk.name,
      columns: fk.fromColumns || fk.columns || [],
      onDelete: fk.onDelete,
    });
  }

  // BFS 下游（哪些表引用了它 → 即它被谁引用，incoming 方向）
  const downstream = bfs(tableName, incoming, 'fromTable');
  // BFS 上游（它引用了哪些表 → outgoing 方向）
  const upstream = bfs(tableName, outgoing, 'toTable');

  // 级联删除路径（ON DELETE CASCADE）
  const cascadePaths = findCascadePaths(tableName, incoming);

  // 循环引用检测
  const circularRefs = findCircularRefs(tableName, outgoing, incoming);

  // 扇入/扇出
  const fanIn = (incoming.get(tableName) || []).length;
  const fanOut = (outgoing.get(tableName) || []).length;

  return {
    found: true,
    tableName,
    downstream: downstream.visited,
    downstreamDepth: downstream.maxDepth,
    upstream: upstream.visited,
    upstreamDepth: upstream.maxDepth,
    fanIn,
    fanOut,
    cascadePaths,
    circularRefs,
  };
}

// ============================================================
//  7. auditNaming — 命名规范审计
// ============================================================

export function auditNaming(dbDataMap) {
  const tables = dbDataMap.tables || [];
  const foreignKeys = dbDataMap.foreignKeys || [];
  const issues = [];

  for (const t of tables) {
    // 表名检查
    if (/[A-Z]/.test(t.name)) {
      issues.push({ severity: 'medium', type: 'table_camel_case', table: t.name, message: `${t.name} 表名含大写字母，建议全小写下划线` });
    }

    // 主键检查
    const pk = t.primaryKey || [];
    if (pk.length === 1 && pk[0] !== 'id') {
      issues.push({ severity: 'low', type: 'pk_naming', table: t.name, pkName: pk[0], message: `${t.name} 主键列名为 ${pk[0]}，建议统一为 id` });
    }

    // 外键列命名
    for (const fk of (t.foreignKeys || [])) {
      const cols = fk.columns || fk.fromColumns || [];
      for (const col of cols) {
        if (!col.endsWith('_id')) {
          issues.push({ severity: 'low', type: 'fk_col_naming', table: t.name, column: col, message: `${t.name}.${col} 外键列不以 _id 结尾` });
        }
      }
    }

    // 时间戳命名
    const hasCreated = (t.columns || []).some((c) => c.name === 'created_at' || c.name === 'create_time');
    const hasUpdated = (t.columns || []).some((c) => c.name === 'updated_at' || c.name === 'update_time');
    if (hasCreated && hasUpdated) {
      const createCol = (t.columns || []).find((c) => c.name === 'created_at' || c.name === 'create_time');
      const updateCol = (t.columns || []).find((c) => c.name === 'updated_at' || c.name === 'update_time');
      if (createCol.name !== 'created_at' || updateCol.name !== 'updated_at') {
        issues.push({ severity: 'low', type: 'timestamp_naming', table: t.name, message: `${t.name} 时间戳列命名不统一（建议 created_at / updated_at）` });
      }
    }

    // 软删除命名
    const softDelCol = (t.columns || []).find((c) => c.name === 'delete_flag' || c.name === 'is_deleted');
    if (softDelCol) {
      issues.push({ severity: 'low', type: 'soft_delete_naming', table: t.name, column: softDelCol.name, message: `${t.name} 软删除列名为 ${softDelCol.name}，建议统一为 deleted_at` });
    }

    // 索引命名
    for (const idx of (t.indexes || [])) {
      if (!idx.name.startsWith('idx_') && !idx.name.startsWith('uk_') && !idx.name.startsWith('fk_') && idx.name !== 'PRIMARY') {
        issues.push({ severity: 'low', type: 'index_naming', table: t.name, index: idx.name, message: `${t.name}.${idx.name} 索引命名不符合规范（建议 idx_ / uk_ 前缀）` });
      }
    }
  }

  // 缩写一致性检测
  const abbreviationMap = {};
  for (const t of tables) {
    const parts = t.name.split('_');
    for (const part of parts) {
      if (part.length < 3) continue;
      if (!abbreviationMap[part]) abbreviationMap[part] = [];
      abbreviationMap[part].push(t.name);
    }
  }

  const recommendations = [];
  const tableNamingIssueCount = issues.filter((i) => i.type === 'table_camel_case').length;
  const fkNamingIssueCount = issues.filter((i) => i.type === 'fk_col_naming').length;
  if (tableNamingIssueCount) recommendations.push(`统一 ${tableNamingIssueCount} 张表的命名为全小写下划线风格`);
  if (fkNamingIssueCount) recommendations.push(`统一 ${fkNamingIssueCount} 个外键列命名以 _id 结尾`);
  recommendations.push('主键列统一命名为 id（自增 INT 或 CHAR(36) UUID）');
  recommendations.push('时间戳列统一命名为 created_at / updated_at（DATETIME 类型）');
  recommendations.push('软删除列统一命名为 deleted_at（DATETIME 类型，可空）');
  recommendations.push('索引命名统一前缀：普通索引 idx_，唯一索引 uk_');

  // 按严重程度排序
  const severityRank = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => (severityRank[a.severity] ?? 99) - (severityRank[b.severity] ?? 99));

  const stats = {
    total: issues.length,
    high: issues.filter((i) => i.severity === 'high').length,
    medium: issues.filter((i) => i.severity === 'medium').length,
    low: issues.filter((i) => i.severity === 'low').length,
  };

  return {
    issues: issues.slice(0, 50),
    stats,
    recommendations,
  };
}

// ============================================================
//  辅助函数
// ============================================================

function computeIndexStats(tables, foreignKeys) {
  const totalIndexCount = tables.reduce((sum, t) => sum + (t.indexes || []).length, 0);

  // 外键索引覆盖率
  const unindexedFks = [];
  for (const fk of foreignKeys) {
    const table = tables.find((t) => t.name === fk.fromTable);
    if (!table) continue;
    const fkCols = fk.fromColumns || fk.columns || [];
    if (!fkCols.length) continue;
    // 检查是否有索引以这些列作为左前缀
    const hasIndex = (table.indexes || []).some((idx) => {
      const idxCols = idx.columns || [];
      if (idxCols.length < fkCols.length) return false;
      return fkCols.every((c, i) => idxCols[i] === c);
    });
    if (!hasIndex) {
      unindexedFks.push({ table: fk.fromTable, column: fkCols.join(','), fkName: fk.name });
    }
  }

  // 冗余索引检测（左前缀包含）
  const redundantIndexes = [];
  for (const t of tables) {
    const indexes = t.indexes || [];
    for (let i = 0; i < indexes.length; i++) {
      for (let j = 0; j < indexes.length; j++) {
        if (i === j) continue;
        const a = indexes[i];
        const b = indexes[j];
        const aCols = a.columns || [];
        const bCols = b.columns || [];
        // a 是否是 b 的左前缀（即 b 冗余了 a）
        if (aCols.length < bCols.length && aCols.every((c, k) => bCols[k] === c)) {
          if (!redundantIndexes.some((r) => r.table === t.name && r.index === a.name)) {
            redundantIndexes.push({ table: t.name, index: a.name, redundantWith: b.name });
          }
        }
      }
    }
  }

  // 无二级索引表
  const noSecondaryIndexTables = tables.filter((t) => (t.indexes || []).length === 0).length;

  const totalFkCount = foreignKeys.length;
  const unindexedFkRatio = totalFkCount > 0 ? unindexedFks.length / totalFkCount : 0;

  return {
    totalIndexCount,
    unindexedFks,
    unindexedFkRatio,
    redundantIndexCount: redundantIndexes.length,
    redundantIndexes,
    noSecondaryIndexTables,
  };
}

function bfs(start, adjMap, neighborKey) {
  const visited = [];
  const depthMap = new Map([[start, 0]]);
  const queue = [start];
  let maxDepth = 0;

  while (queue.length) {
    const current = queue.shift();
    const depth = depthMap.get(current) || 0;
    const neighbors = adjMap.get(current) || [];
    for (const edge of neighbors) {
      const next = edge[neighborKey];
      if (next === start) continue;
      if (depthMap.has(next)) continue;
      depthMap.set(next, depth + 1);
      maxDepth = Math.max(maxDepth, depth + 1);
      visited.push({ table: next, depth: depth + 1, viaFk: edge.fkName });
      queue.push(next);
    }
  }

  return { visited, maxDepth };
}

function findCascadePaths(start, incoming) {
  const paths = [];
  function dfs(current, path, visited) {
    if (visited.has(current)) return;
    visited.add(current);
    const edges = incoming.get(current) || [];
    for (const edge of edges) {
      if (edge.onDelete && edge.onDelete.toUpperCase() === 'CASCADE') {
        const next = edge.fromTable;
        const newPath = [...path, { table: next, fkName: edge.fkName }];
        paths.push(newPath);
        dfs(next, newPath, new Set(visited));
      }
    }
  }
  dfs(start, [], new Set());
  return paths.slice(0, 20);
}

function findCircularRefs(start, outgoing, incoming) {
  const circular = [];
  // 检查从 start 出发是否能回到自己（通过 outgoing 方向）
  const visited = new Set();
  const stack = [{ table: start, path: [] }];

  while (stack.length) {
    const { table, path } = stack.pop();
    if (table === start && path.length > 0) {
      circular.push(path);
      continue;
    }
    if (visited.has(table) && path.length > 1) continue;
    visited.add(table);
    const edges = outgoing.get(table) || [];
    for (const edge of edges) {
      if (path.length > 10) continue; // 避免太深
      stack.push({ table: edge.toTable, path: [...path, { table, fkName: edge.fkName, toTable: edge.toTable }] });
    }
  }

  return circular.slice(0, 10);
}
