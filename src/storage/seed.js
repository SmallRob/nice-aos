// 本体目录种子化（D6 本体目录化）
// 启动时把 blueprint.js 的 OBJECT_TYPES / LINK_TYPES 灌入 aos_types / aos_link_types / aos_type_properties（UPSERT 幂等）
// 也把 5 种 snapshot_kind 注册到 aos_snapshots（确保新建时 kind 值合法）
//
// v0.37+ 演进：
//   - 新增 aos_type_properties 灌入（投影层 DDL 输入）
//   - aos_link_types 加 label / src_type / tgt_type / cardinality 同步

import { openDb } from './db.js';

// snapshot_kind 白名单：与各 *-snapshot.json 文件名对齐
export const SNAPSHOT_KINDS = [
  { kind: 'code',     file: 'snapshot.json',          module: 'ontology' },
  { kind: 'db',       file: 'db-snapshot.json',       module: 'database' },
  { kind: 'deploy',   file: 'deploy-snapshot.json',   module: 'deployment' },
  { kind: 'planning', file: 'planning-snapshot.json', module: 'planning' },
  { kind: 'service',  file: 'service-snapshot.json',  module: 'service' },
  { kind: 'overview', file: 'overview-snapshot.json', module: 'overview' },
];

// 链接类型端点类型与基数公理（与 linkMeta.js / viewer.js 对齐；v0.37 入表）
//   借鉴 asdm-aos：src_type / tgt_type / cardinality 是写边校验的元数据
//   端点取值约定：类型名（如 SourceFile/Module）或 category 名（Container/CodeUnit/Script/AuditFact，
//   如 contains = Container→CodeUnit 为泛化约束）；Table 属 database 模块对象，不在 code blueprint 目录
//   nice-aos v0.37 暂不强制约束（按 Q4 决策：加字段存元数据，不强制）
const LINK_AXIOMS = {
  contains:       { label: '包含',         src: 'Container', tgt: 'CodeUnit',  cardinality: '1..*' },
  imports:        { label: '导入',         src: 'SourceFile', tgt: 'Module',   cardinality: '*' },
  importedBy:     { label: '被导入',       src: 'Module',    tgt: 'SourceFile', cardinality: '*' },
  renders:        { label: '渲染',         src: 'Component', tgt: 'Component', cardinality: '*' },
  renderedBy:     { label: '被渲染',       src: 'Component', tgt: 'Component', cardinality: '*' },
  passesProps:    { label: '传递属性',     src: 'Component', tgt: 'Component', cardinality: '*' },
  navigatesTo:    { label: '路由跳转',     src: 'Component', tgt: 'Route',     cardinality: '*' },
  registers:      { label: '注册路由',     src: 'Module',    tgt: 'Route',     cardinality: '1..*' },
  usesStore:      { label: '使用 Store',    src: 'CodeUnit',  tgt: 'Store',     cardinality: '*' },
  usesHook:       { label: '使用 Hook',     src: 'CodeUnit',  tgt: 'Hook',      cardinality: '*' },
  implements:     { label: '实现接口',     src: 'Class',     tgt: 'Interface', cardinality: '*' },
  implementedBy:  { label: '被实现',       src: 'Interface', tgt: 'Class',     cardinality: '*' },
  extends:        { label: '继承',         src: 'Class',     tgt: 'Class',     cardinality: '0..1' },
  extendedBy:     { label: '被继承',       src: 'Class',     tgt: 'Class',     cardinality: '*' },
  overrides:      { label: '重写',         src: 'Method',    tgt: 'Method',    cardinality: '0..1' },
  overriddenBy:   { label: '被重写',       src: 'Method',    tgt: 'Method',    cardinality: '*' },
  usesGmApi:      { label: '使用 GM API',  src: 'ScriptFunction', tgt: 'GmApiUsage', cardinality: '*' },
  injectsInto:    { label: '注入到',       src: 'InjectionPoint', tgt: 'SourceFile', cardinality: '*' },
  requestsTo:     { label: '请求到',       src: 'NetworkEndpoint', tgt: 'SourceFile', cardinality: '*' },
  calls:          { label: '调用',         src: 'Method',    tgt: 'Method',    cardinality: '*' },
  calledBy:       { label: '被调用',       src: 'Method',    tgt: 'Method',    cardinality: '*' },
  belongsTo:      { label: '归属',         src: 'CodeUnit',  tgt: 'Module',    cardinality: '1' },
  usesTrait:      { label: '使用 Trait',   src: 'Class',     tgt: 'Trait',     cardinality: '*' },
  usedByTrait:    { label: '被 Trait 使用', src: 'Trait',    tgt: 'Class',     cardinality: '*' },
  mapsToTable:    { label: '映射到表',     src: 'CodeUnit',  tgt: 'Table',     cardinality: '0..1' },
  mappedFromCode: { label: '由代码映射',   src: 'Table',     tgt: 'CodeUnit',  cardinality: '0..1' },
};

// 类型属性定义（v0.37 新增；投影层 DDL 输入）
//   字段语义：
//     wire_type    — JS / JSON 形态（string / number / boolean / object / array / ref）
//     storage_hint — 投影层是否提到列（promoted vs 存 jsonb；nice-aos 暂都存 jsonb）
//     index_hint   — 是否值得建索引（btree / fulltext / vector / none）
//   设计原则：先只入"通用属性 + 几个高频查询字段"，避免一次性铺满所有字段
const TYPE_PROPERTIES = {
  Project: [
    { key: 'id',          label: '项目 ID', wire_type: 'string',  storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'name',        label: '项目名', wire_type: 'string',  storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'framework',   label: '框架',   wire_type: 'string',  storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'frameworkLabel', label: '框架标签', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'language',    label: '语言',   wire_type: 'string',  storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'fileCount',   label: '文件数', wire_type: 'number',  storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'commitHash',  label: 'Commit', wire_type: 'string',  storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'branch',      label: '分支',   wire_type: 'string',  storage_hint: 'jsonb', index_hint: 'none' },
  ],
  Module: [
    { key: 'id',           label: '模块 ID', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'path',         label: '路径',    wire_type: 'string', storage_hint: 'jsonb', index_hint: 'btree' },
    { key: 'fileCount',    label: '文件数',  wire_type: 'number', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'archLayer',    label: '架构层',  wire_type: 'string', storage_hint: 'jsonb', index_hint: 'btree' },
    { key: 'archLayerLabel', label: '架构层标签', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
  ],
  SourceFile: [
    { key: 'id',         label: '文件 ID', wire_type: 'string',  storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'path',       label: '文件路径', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'btree' },
    { key: 'lineCount',  label: '行数',    wire_type: 'number',  storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'moduleId',   label: '模块 ID', wire_type: 'ref',     storage_hint: 'jsonb', index_hint: 'btree' },
    { key: 'archLayer',  label: '架构层',  wire_type: 'string',  storage_hint: 'jsonb', index_hint: 'btree' },
    { key: 'domainId',   label: '域 ID',   wire_type: 'ref',     storage_hint: 'jsonb', index_hint: 'btree' },
  ],
  Component: [
    { key: 'id',     label: '组件 ID', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'name',   label: '组件名',  wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'fileId', label: '文件 ID', wire_type: 'ref',    storage_hint: 'jsonb', index_hint: 'none' },
  ],
  Hook: [
    { key: 'id',     label: 'Hook ID', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'name',   label: 'Hook 名', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'fileId', label: '文件 ID', wire_type: 'ref',    storage_hint: 'jsonb', index_hint: 'none' },
  ],
  Store: [
    { key: 'id',     label: 'Store ID', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'name',   label: 'Store 名', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'fileId', label: '文件 ID',  wire_type: 'ref',    storage_hint: 'jsonb', index_hint: 'none' },
  ],
  Method: [
    { key: 'id',           label: '方法 ID', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'name',         label: '方法名',  wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'ownerId',      label: '所属类 ID', wire_type: 'ref',  storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'fileId',       label: '文件 ID', wire_type: 'ref',    storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'isAsync',      label: '是否异步', wire_type: 'boolean', storage_hint: 'jsonb', index_hint: 'none' },
  ],
  Interface: [
    { key: 'id',     label: '接口 ID', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'name',   label: '接口名',  wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'fileId', label: '文件 ID', wire_type: 'ref',    storage_hint: 'jsonb', index_hint: 'none' },
  ],
  Class: [
    { key: 'id',     label: '类 ID', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'name',   label: '类名',  wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'fileId', label: '文件 ID', wire_type: 'ref',    storage_hint: 'jsonb', index_hint: 'none' },
  ],
  Trait: [
    { key: 'id',         label: 'Trait ID', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'name',       label: 'Trait 名',  wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'fileId',     label: '文件 ID',   wire_type: 'ref',    storage_hint: 'jsonb', index_hint: 'none' },
  ],
  Dependency: [
    { key: 'id',      label: '依赖 ID',  wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'name',    label: '包名',     wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'version', label: '版本',     wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
  ],
  Domain: [
    { key: 'id',        label: '域 ID',   wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'name',      label: '域名',    wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'fileCount', label: '文件数',  wire_type: 'number', storage_hint: 'jsonb', index_hint: 'none' },
  ],
  Route: [
    { key: 'id',   label: '路由 ID', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'path', label: '路由路径', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'btree' },
  ],
  GmApiUsage: [
    { key: 'id',   label: 'GM API ID', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'name', label: 'GM API 名',  wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
  ],
  InjectionPoint: [
    { key: 'id',   label: '注入点 ID', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
  ],
  NetworkEndpoint: [
    { key: 'id',   label: '网络端点 ID', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
  ],
  UserScript: [
    { key: 'id',   label: '脚本 ID', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'name', label: '脚本名',  wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
  ],
  Service: [
    { key: 'id',     label: '服务 ID', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'name',   label: '服务名',  wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
  ],
  PropEdge: [
    { key: 'id',     label: 'Props 边 ID', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
  ],
  ScriptFunction: [
    { key: 'id',   label: '脚本函数 ID', wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
    { key: 'name', label: '函数名',     wire_type: 'string', storage_hint: 'jsonb', index_hint: 'none' },
  ],
  // 注意：Table 不在 OBJECT_TYPES 中（属于 database 模块的对象），不入 aos_type_properties
};

// 启动时种子化本体目录
//   - 同步 OBJECT_TYPES → aos_types（type_name / category / level / prefix / description）
//   - 同步 LINK_TYPES → aos_link_types（含 label / src_type / tgt_type / cardinality）
//   - 同步 TYPE_PROPERTIES → aos_type_properties（v0.37 新增）
//   - 幂等：ON CONFLICT DO UPDATE（同名则更新元数据）
export function seedOntologyCatalog(db, { OBJECT_TYPES, LINK_TYPES }) {
  if (!db) return { types: 0, linkTypes: 0, typeProperties: 0 };

  const upsertType = db.prepare(`
    INSERT INTO aos_types (type_name, category, level, prefix, description)
    VALUES (@type, @category, @level, @prefix, @description)
    ON CONFLICT(type_name) DO UPDATE SET
      category = excluded.category,
      level = excluded.level,
      prefix = excluded.prefix,
      description = excluded.description
  `);
  const upsertLink = db.prepare(`
    INSERT INTO aos_link_types (link_type, label, inverse_of, is_transitive, src_type, tgt_type, cardinality, description)
    VALUES (@link, @label, NULL, 0, @src_type, @tgt_type, @cardinality, NULL)
    ON CONFLICT(link_type) DO UPDATE SET
      label = excluded.label,
      src_type = excluded.src_type,
      tgt_type = excluded.tgt_type,
      cardinality = excluded.cardinality
  `);
  const upsertProp = db.prepare(`
    INSERT INTO aos_type_properties (type_name, \`key\`, label, wire_type, storage_hint, index_hint)
    VALUES (@type_name, @key, @label, @wire_type, @storage_hint, @index_hint)
    ON CONFLICT(type_name, \`key\`) DO UPDATE SET
      label = excluded.label,
      wire_type = excluded.wire_type,
      storage_hint = excluded.storage_hint,
      index_hint = excluded.index_hint
  `);

  const tx = db.transaction(() => {
    let typeCount = 0;
    for (const t of OBJECT_TYPES) {
      upsertType.run({
        type: t.type,
        category: t.category,
        level: t.level,
        prefix: t.prefix,
        description: t.description ?? null,
      });
      typeCount += 1;
    }
    let linkCount = 0;
    for (const link of LINK_TYPES) {
      const axiom = LINK_AXIOMS[link] || {};
      upsertLink.run({
        link,
        label: axiom.label || link,
        src_type: axiom.src || null,
        tgt_type: axiom.tgt || null,
        cardinality: axiom.cardinality || '*',
      });
      linkCount += 1;
    }
    let propCount = 0;
    // 防御：只入 aos_types 已注册的类型属性（FK 约束 + 防止幽灵属性）
    const typeNamesInDb = new Set(
      db.prepare('SELECT type_name FROM aos_types').all().map((r) => r.type_name)
    );
    for (const [typeName, props] of Object.entries(TYPE_PROPERTIES)) {
      if (!typeNamesInDb.has(typeName)) continue;
      for (const p of props) {
        upsertProp.run({
          type_name: typeName,
          key: p.key,
          label: p.label,
          wire_type: p.wire_type,
          storage_hint: p.storage_hint,
          index_hint: p.index_hint,
        });
        propCount += 1;
      }
    }
    return { typeCount, linkCount, propCount };
  });
  const { typeCount, linkCount, propCount } = tx();
  return { types: typeCount, linkTypes: linkCount, typeProperties: propCount };
}
