// 数据库对象模型定义：对象类型、链接类型、领域规则、模式检测规则
// 与 ontology/blueprint.js 对应，但针对数据库分析子系统独立建模

export const DB_MODEL_META = {
  version: '1.0',
  subsystem: 'database',
  description: 'MySQL 迁移脚本数据库模型',
};

export const DB_OBJECT_TYPES = [
  { type: 'Table',      prefix: 'table:', description: '数据库表（含列/主键/外键/索引/注释/迁移版本/模式特征）' },
  { type: 'Column',     prefix: 'col:',   description: '表列（名称/类型/可空/默认值/约束/注释）' },
  { type: 'ForeignKey', prefix: 'fk:',    description: '外键约束（源表/源列 → 目标表/目标列 + ON DELETE/UPDATE）' },
  { type: 'Index',      prefix: 'idx:',   description: '索引（名称/列/唯一性）' },
  { type: 'Migration',  prefix: 'mig:',   description: '迁移脚本（版本/描述/文件名/操作统计）' },
  { type: 'DbDomain',   prefix: 'dbdom:', description: '数据库领域（按表名前缀自动分组）' },
  { type: 'View',       prefix: 'view:',  description: '数据库视图（名称/定义/依赖表）' },
  { type: 'Trigger',    prefix: 'trig:',  description: '数据库触发器（名称/关联表/时机/事件）' },
  { type: 'Procedure',  prefix: 'proc:',  description: '存储过程/函数（名称/参数/体）' },
];

export const DB_LINK_TYPES = [
  'containsColumn', 'hasForeignKey', 'hasIndex', 'references',
  'migratedBy', 'belongsToDomain', 'dependsOn', 'triggersOn',
];

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
