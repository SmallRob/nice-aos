// 数据库对象模型定义：对象类型、链接类型、领域规则、模式检测规则
// 与 ontology/blueprint.js 对应，但针对数据库分析子系统独立建模

export const DOMAIN_RULES = [
  { key: 'auth',   label: '用户与权限',   prefixes: ['user', 'role', 'personal_access', 'invitation', 'notification', 'org_create', 'org_inheritance', 'org_audit', 'super_admin', 'sso_user', 'bank_user', 'user_managed'] },
  { key: 'proj',   label: '项目与仓库',   prefixes: ['project', 'project_collection', 'global_repositor', 'asset_repositor', 'pipeline'] },
  { key: 'ws',     label: '工作空间',     prefixes: ['workspace'] },
  { key: 'ctx',    label: '上下文空间',   prefixes: ['library_context', 'context_', 'context_sync'] },
  { key: 'file',   label: '文件服务',     prefixes: ['asdm_file', 'business_file'] },
  { key: 'agent',  label: 'Agent / AI',  prefixes: ['agentorbit', 'mcp_', 'reporting_', 'collection_agent', 'project_agent', 'organization_agent', 'user_agent'] },
  { key: 'asset',  label: '资产注册',     prefixes: ['asset_'] },
  { key: 'intg',   label: '集成',         prefixes: ['adapter_', 'integration_', 'repository_project'] },
  { key: 'portal', label: 'Portal 门户', prefixes: ['article', 'categor', 'browse_history', 'sync_failure'] },
  { key: 'ff',     label: 'Feature Flag', prefixes: ['feature_flag'] },
  { key: 'log',    label: '日志审计',     prefixes: ['log_', 'audit_log'] },
  { key: 'job',    label: '任务调度',     prefixes: ['job_', 'task_', 'schedule_'] },
  { key: 'config', label: '系统配置',     prefixes: ['config_'] },
  { key: 'sys',    label: '系统工具',     prefixes: ['sys_', 'flyway_', 'cli_', 'install_', 'shedlock', 'one_time', 'controlled_resource', 'digidev'] },
];

export const DOMAIN_COLORS = {
  auth: '#a78bfa', proj: '#38bdf8', ws: '#4ade80', ctx: '#22d3ee', file: '#fb923c',
  agent: '#f472b6', asset: '#fbbf24', intg: '#2dd4bf', portal: '#f87171', ff: '#94a3b8',
  log: '#6b7280', job: '#8b5cf6', config: '#64748b', sys: '#475569',
  other: '#94a3b8',
};

export function detectDomain(tableName) {
  const lower = tableName.toLowerCase();
  for (const rule of DOMAIN_RULES) {
    for (const prefix of rule.prefixes) {
      if (lower.startsWith(prefix)) return { key: rule.key, label: rule.label };
    }
  }
  return { key: 'other', label: '其他' };
}

export const SCHEMA_PATTERN_RULES = [
  { key: 'soft_delete',    label: '软删除',    detector: (t) => t.columns.some((c) => c.name === 'deleted_at' || c.name === 'delete_flag' || c.name === 'is_deleted') },
  { key: 'self_reference', label: '自引用外键', detector: (t) => (t.foreignKeys || []).some((fk) => fk.refTable === t.name) },
  { key: 'audit_columns',  label: '审计字段',   detector: (t) => ['created_at', 'updated_at'].every((f) => t.columns.some((c) => c.name === f)) || ['create_time', 'update_time'].every((f) => t.columns.some((c) => c.name === f)) },
  { key: 'multi_tenant',   label: '多租户',     detector: (t) => t.columns.some((c) => c.name === 'org_id' || c.name === 'collection_id') },
  { key: 'uuid_primary',   label: 'UUID 主键',  detector: (t) => t.primaryKey.length === 1 && (t.columns.find((c) => c.name === t.primaryKey[0])?.type || '').toUpperCase().includes('CHAR') },
  { key: 'composite_pk',   label: '复合主键',   detector: (t) => t.primaryKey.length > 1 },
  { key: 'json_columns',   label: 'JSON 列',    detector: (t) => t.columns.some((c) => /JSON/i.test(c.type)) },
  { key: 'enum_columns',   label: '枚举列',     detector: (t) => t.columns.some((c) => /ENUM/i.test(c.type)) },
  { key: 'no_primary_key', label: '无主键',     detector: (t) => t.primaryKey.length === 0 },
  { key: 'large_table',    label: '宽表(>20列)',detector: (t) => t.columns.length > 20 },
];

export function detectPatterns(table) {
  return SCHEMA_PATTERN_RULES.filter((r) => r.detector(table)).map((r) => r.key);
}

// ============================================================
//  业务实体层（DDD 实体聚合）：表 → 实体/关联/链接的分类与聚合
//  参考领域驱动设计的分析链：识别业务领域边界 → 划分模块（实体聚合）→ 猜测进化方向 → 验证
// ============================================================

// 技术列（非业务属性）：主键/外键列之外，这些列不参与"实体是否有独立业务属性"的判定
export const TECHNICAL_COLUMN_NAMES = new Set([
  'id', 'created_at', 'updated_at', 'create_time', 'update_time', 'created_by', 'updated_by',
  'deleted_at', 'delete_flag', 'is_deleted', 'version', 'lock_version', 'tenant_id', 'org_id', 'collection_id',
]);

// 表的业务属性列：排除主键列、外键列、技术列之后的列
export function businessColumnsOf(table) {
  const pkCols = new Set(table.primaryKey || []);
  const fkCols = new Set((table.foreignKeys || []).flatMap((fk) => fk.columns || []));
  return (table.columns || []).filter((c) => !pkCols.has(c.name) && !fkCols.has(c.name) && !TECHNICAL_COLUMN_NAMES.has(c.name.toLowerCase()));
}

// 表在实体模型中的角色分类：
//   link        纯链接表（多对多junction）：无业务属性列且外键数 ≥ 2 —— 不是独立实体，归入两侧实体的关系
//   association 关联表：外键数 ≥ 2 且业务属性列 1~3 个（如带排序/状态的关系表）—— 弱实体
//   entity      主实体：其余（独立业务属性）—— 领域的核心聚合根候选
export function classifyTableKind(table) {
  const fkCount = (table.foreignKeys || []).length;
  const bizCols = businessColumnsOf(table).length;
  if (fkCount >= 2 && bizCols === 0) return 'link';
  if (fkCount >= 2 && bizCols <= 3) return 'association';
  return 'entity';
}

export const TABLE_KIND_LABELS = {
  entity: '主实体',
  association: '关联表',
  link: '链接表',
};

// 实体聚合：以"主实体表"为锚，吸收指向它的链接表（link）构成聚合；
// 关联表（association）保留为独立弱实体（有自身属性，值得单独审视）
export function buildEntities(tables, foreignKeys = []) {
  if (!tables || !tables.length) return [];
  const byName = new Map(tables.map((t) => [t.name, t]));
  const kinds = new Map(tables.map((t) => [t.name, classifyTableKind(t)]));

  // 链接表归属：链接表通常命名 A_B 或 AB，取其外键指向的"主实体"表中业务列数最多者；
  // 无法判定时归属到第一个 entity 目标
  const linkOwner = new Map(); // linkTable -> ownerEntityTable
  const incomingFks = new Map(); // toTable -> [fk]
  for (const fk of foreignKeys) {
    if (!incomingFks.has(fk.toTable)) incomingFks.set(fk.toTable, []);
    incomingFks.get(fk.toTable).push(fk);
  }

  const entities = [];
  const entityIndexByName = new Map();
  for (const t of tables) {
    const kind = kinds.get(t.name);
    if (kind !== 'entity') continue;
    const e = {
      name: t.name,
      domain: t.domain,
      domainLabel: t.domainLabel,
      kind: 'aggregate',
      tableNames: [t.name],
      linkTables: [],
      associationTables: [],
      columnCount: (t.columns || []).length,
      businessColumnCount: businessColumnsOf(t).length,
      fkOutCount: (t.foreignKeys || []).length,
      fkInCount: (incomingFks.get(t.name) || []).length,
      patterns: t.patterns || [],
      createdAt: t.createdAt ?? null,
      modifiedAt: t.modifiedAt ?? null,
    };
    entities.push(e);
    entityIndexByName.set(t.name, e);
  }

  for (const t of tables) {
    const kind = kinds.get(t.name);
    if (kind === 'entity') continue;
    if (kind === 'link') {
      // 归属目标：外键指向的实体表里，业务列最多者（次选命名包含关系）
      const targets = [...new Set((t.foreignKeys || []).map((fk) => fk.refTable))]
        .map((n) => byName.get(n))
        .filter((tt) => tt && kinds.get(tt.name) === 'entity');
      let owner = null;
      if (targets.length) {
        owner = targets.slice().sort((a, b) => businessColumnsOf(b).length - businessColumnsOf(a).length
          || (b.name.includes(t.name.split('_')[0]) ? 1 : 0) - (a.name.includes(t.name.split('_')[0]) ? 1 : 0))[0];
      }
      if (owner && entityIndexByName.has(owner.name)) {
        entityIndexByName.get(owner.name).linkTables.push(t.name);
      }
      // 无实体目标（如指向字典表/悬挂）则丢弃为游离链接表，由审计披露
    } else {
      // association：挂到领域下作为独立弱实体
      entities.push({
        name: t.name,
        domain: t.domain,
        domainLabel: t.domainLabel,
        kind: 'association',
        tableNames: [t.name],
        linkTables: [],
        associationTables: [],
        columnCount: (t.columns || []).length,
        businessColumnCount: businessColumnsOf(t).length,
        fkOutCount: (t.foreignKeys || []).length,
        fkInCount: (incomingFks.get(t.name) || []).length,
        patterns: t.patterns || [],
        createdAt: t.createdAt ?? null,
        modifiedAt: t.modifiedAt ?? null,
      });
    }
  }

  return entities;
}

export function versionCompare(a, b) {
  const pa = a.replace(/^V/, '').split('.').map(Number);
  const pb = b.replace(/^V/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

// ============================================================
//  跨层引用模型（借鉴 asdm-aos 的代码↔数据库融合思路）
//  前端场景：TypeScript Interface/Class ↔ 数据库 Table 通过命名约定匹配
//  匹配策略：snake_case 表名 ↔ PascalCase 接口名 / camelCase 服务名
// ============================================================

// 表名 → 候选代码名（snake_case → PascalCase 单数）
// user → User, user_roles → UserRole, project_collection → ProjectCollection
export function tableNameToCandidateNames(tableName) {
  const names = [];
  const pascal = tableName
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  names.push(pascal);
  // 尝试去 s（简单复数还原）
  if (pascal.endsWith('s') && pascal.length > 2) {
    names.push(pascal.slice(0, -1));
  }
  // 尝试 ies → y（如 Policies → Policy）
  if (pascal.endsWith('ies') && pascal.length > 4) {
    names.push(pascal.slice(0, -3) + 'y');
  }
  return names;
}

// 代码名 → 候选表名（PascalCase/camelCase → snake_case）
export function codeNameToCandidateNames(codeName) {
  const snake = codeName
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
  const names = [snake];
  // 尝试加 s（单数 → 复数表名）
  if (!snake.endsWith('s')) names.push(snake + 's');
  return names;
}

// 在代码实体列表中为每张表查找匹配项
// codeEntities: [{ name, type, id, filePath }] —— type 为 Interface/Class/Store 等
// 返回 Map<tableName, [{ codeEntityId, codeEntityName, codeEntityType, matchStrategy }]>
export function matchTablesToCodeEntities(tables, codeEntities) {
  if (!tables?.length || !codeEntities?.length) return new Map();
  const result = new Map();

  // 预建代码名 → 实体索引（多种命名形式）
  const codeIndex = new Map(); // candidateName → [entity]
  for (const e of codeEntities) {
    const candidates = codeNameToCandidateNames(e.name);
    for (const c of candidates) {
      if (!codeIndex.has(c)) codeIndex.set(c, []);
      codeIndex.get(c).push(e);
    }
    // 也按原名（小写）索引
    const lower = e.name.toLowerCase();
    if (!codeIndex.has(lower)) codeIndex.set(lower, []);
    codeIndex.get(lower).push(e);
  }

  for (const table of tables) {
    const candidates = tableNameToCandidateNames(table.name);
    const matches = [];
    const seen = new Set();

    for (const candidate of candidates) {
      const entities = codeIndex.get(candidate) || [];
      for (const e of entities) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        matches.push({
          codeEntityId: e.id,
          codeEntityName: e.name,
          codeEntityType: e.type,
          matchStrategy: candidate === e.name ? 'exact' : 'naming-convention',
        });
      }
    }

    // 宽松匹配：表名包含代码名或代码名包含表名（前缀/子串）
    if (matches.length === 0) {
      const tableLower = table.name.toLowerCase();
      for (const e of codeEntities) {
        const codeLower = e.name.toLowerCase();
        if (codeLower.length < 3) continue;
        if (tableLower.includes(codeLower) || codeLower.includes(tableLower)) {
          if (!seen.has(e.id)) {
            seen.add(e.id);
            matches.push({
              codeEntityId: e.id,
              codeEntityName: e.name,
              codeEntityType: e.type,
              matchStrategy: 'substring',
            });
          }
        }
      }
    }

    if (matches.length > 0) result.set(table.name, matches);
  }

  return result;
}
