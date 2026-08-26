// 本体目录种子化（D6 本体目录化）
// 启动时把 blueprint.js 的 OBJECT_TYPES / LINK_TYPES 灌入 aos_types / aos_link_types（UPSERT 幂等）
// 也把 5 种 snapshot_kind 注册到 aos_snapshots（确保新建时 kind 值合法）

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

// 启动时种子化本体目录
//   - 同步 OBJECT_TYPES → aos_types（type_name / category / level / prefix / description）
//   - 同步 LINK_TYPES → aos_link_types（link_type；D8 公理字段 v0.31 留空，v0.32+ 启用）
//   - 幂等：ON CONFLICT DO UPDATE（同名则更新元数据，type_name 不会变）
export function seedOntologyCatalog(db, { OBJECT_TYPES, LINK_TYPES }) {
  if (!db) return { types: 0, linkTypes: 0 };

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
    INSERT INTO aos_link_types (link_type, inverse_of, is_transitive, description)
    VALUES (@link, NULL, 0, NULL)
    ON CONFLICT(link_type) DO UPDATE SET
      link_type = excluded.link_type
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
      upsertLink.run({ link });
      linkCount += 1;
    }
    return { typeCount, linkCount };
  });
  const { typeCount, linkCount } = tx();
  return { types: typeCount, linkTypes: linkCount };
}
