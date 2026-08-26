-- nice-aos 本地 SQLite 存储 schema（v0.31，Phase A）
-- 借鉴 asdm-aos 存储架构（个人用户剪裁版）
-- 8 张表：1 账本 + 2 目录（类型/链接类型）+ 4 冷层（snapshots/objects/links/overlays）+ 1 镜像水位（mirror_state）
-- 演进式建表（D15）：v0.32+ 加 serving/object_counts；v0.33+ 加 content_hash 索引；Part03/04 后续

-- 1. 账本：版本化迁移追踪（D14 简化版，无 Flyway 双通道）
CREATE TABLE IF NOT EXISTS aos_schema_history (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL,
  description TEXT NOT NULL,
  checksum    TEXT NOT NULL
);

-- 2. 目录层：本体类型（D6 启动种子化，从 blueprint.js OBJECT_TYPES 读入）
CREATE TABLE IF NOT EXISTS aos_types (
  type_name   TEXT PRIMARY KEY,
  category    TEXT NOT NULL,
  level       TEXT NOT NULL,
  prefix      TEXT NOT NULL,
  description TEXT
);
CREATE INDEX IF NOT EXISTS idx_aos_types_category ON aos_types(category);

-- 3. 目录层：链接类型（D8 公理降维：inverse_of / is_transitive）
CREATE TABLE IF NOT EXISTS aos_link_types (
  link_type     TEXT PRIMARY KEY,
  inverse_of    TEXT,
  is_transitive INTEGER NOT NULL DEFAULT 0,
  description   TEXT
);
CREATE INDEX IF NOT EXISTS idx_aos_link_types_inverse ON aos_link_types(inverse_of);

-- 4. 冷层 · 身份与版本
CREATE TABLE IF NOT EXISTS aos_snapshots (
  snapshot_id      TEXT PRIMARY KEY,            -- v0.31 = '<kind>:default'；v0.32+ = '<kind>:<commit_hash>:<analyzer_version>'
  snapshot_kind    TEXT NOT NULL,               -- 'code' | 'db' | 'deploy' | 'planning' | 'service' | 'overview'
  project_name     TEXT,
  commit_hash      TEXT,
  branch           TEXT,
  analyzer_version TEXT NOT NULL,
  generated_at     TEXT NOT NULL,
  duration_ms      INTEGER,
  is_current       INTEGER NOT NULL DEFAULT 1,
  object_counts    TEXT NOT NULL,               -- JSON: _meta.objectCounts
  meta_extra       TEXT,                         -- JSON: _meta 其余字段（cycles / orphanCandidates / deadExportCandidates）
  CHECK (is_current IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_aos_snapshots_current ON aos_snapshots(snapshot_kind, is_current);
CREATE INDEX IF NOT EXISTS idx_aos_snapshots_kind ON aos_snapshots(snapshot_kind);

-- 5. 冷层 · 对象（v0.31 单版本；v0.32+ 加 content_hash 去重）
CREATE TABLE IF NOT EXISTS aos_objects (
  snapshot_id   TEXT NOT NULL REFERENCES aos_snapshots(snapshot_id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  id            TEXT NOT NULL,
  content_hash  TEXT,                            -- v0.31 留空，v0.32+ 启用
  props_json    TEXT NOT NULL,                   -- 完整对象 JSON（业务字段）
  PRIMARY KEY (snapshot_id, type, id)
);
CREATE INDEX IF NOT EXISTS idx_aos_objects_type_id     ON aos_objects(snapshot_id, type, id);
CREATE INDEX IF NOT EXISTS idx_aos_objects_path        ON aos_objects(snapshot_id, type, json_extract(props_json, '$.path'));
CREATE INDEX IF NOT EXISTS idx_aos_objects_module      ON aos_objects(snapshot_id, type, json_extract(props_json, '$.moduleId'));
CREATE INDEX IF NOT EXISTS idx_aos_objects_arch_layer  ON aos_objects(snapshot_id, type, json_extract(props_json, '$.archLayer'));
CREATE INDEX IF NOT EXISTS idx_aos_objects_domain      ON aos_objects(snapshot_id, type, json_extract(props_json, '$.domainId'));

-- 6. 冷层 · 链接（per-snapshot 物化边；D12 双向索引，不引入图数据库）
CREATE TABLE IF NOT EXISTS aos_links (
  snapshot_id TEXT NOT NULL REFERENCES aos_snapshots(snapshot_id) ON DELETE CASCADE,
  link_type   TEXT NOT NULL,
  src_type    TEXT NOT NULL,
  src_id      TEXT NOT NULL,
  tgt_type    TEXT NOT NULL,
  tgt_id      TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, link_type, src_type, src_id, tgt_type, tgt_id)
);
CREATE INDEX IF NOT EXISTS idx_aos_links_out  ON aos_links(snapshot_id, link_type, src_type, src_id);
CREATE INDEX IF NOT EXISTS idx_aos_links_in   ON aos_links(snapshot_id, link_type, tgt_type, tgt_id);
CREATE INDEX IF NOT EXISTS idx_aos_links_type ON aos_links(snapshot_id, link_type);

-- 7. 冷层 · 标注（写通道②，markReviewed / addNote 走这里）
CREATE TABLE IF NOT EXISTS aos_overlays (
  snapshot_id  TEXT NOT NULL REFERENCES aos_snapshots(snapshot_id) ON DELETE CASCADE,
  object_type  TEXT NOT NULL,
  object_id    TEXT NOT NULL,
  props_patch  TEXT NOT NULL,                    -- JSON Merge Patch
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, object_type, object_id)
);

-- 8. 镜像新鲜度水位（JSON 主源 → SQLite 镜像的同步水位）
--    saveSnapshot / applyOverlay 成功后记录当时 JSON 文件 mtime；
--    读路径发现 JSON mtime 新于水位（镜像写失败 / 外部改写 JSON）→ 回退 JSON
CREATE TABLE IF NOT EXISTS aos_mirror_state (
  snapshot_kind           TEXT PRIMARY KEY,
  mirrored_json_mtime_ms  INTEGER NOT NULL
);
