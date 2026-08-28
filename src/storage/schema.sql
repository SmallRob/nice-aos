-- nice-aos 本地 SQLite 存储 schema（v0.37，Phase B 演进版）
-- 借鉴 asdm-aos 存储架构（个人用户剪裁版）
-- 实建 10 张表：1 账本 + 3 目录（types/type_properties/link_types）+ 5 冷层（snapshots/objects/links/overlays/import_jobs）+ 1 镜像水位（mirror_state）
-- 另有 2 张 v0.38+ 预留占位（ontology_versions / snapshot_inputs），尚未建表
-- 与 v0.31 (8 张) 的差异：
--   - aos_objects 加 content_hash / pk_hash 字段 + 2 索引（v0.37 P0 跨快照去重基础设施）
--   - aos_link_types 加 label / src_type / tgt_type / cardinality 4 字段（v0.37 P1 公理声明）
--   - 新增 aos_type_properties（v0.37 P0 投影层 DDL 输入）
--   - 新增 aos_import_jobs（v0.37 P1 步进游标落表）
-- 演进路线：v0.38 拆 manifest（aos_snapshot_objects）+ 重构 objects PK 为 pk_hash

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

-- 3. 目录层：链接类型（D8 公理声明：inverse_of / is_transitive / cardinality / 端点类型）
CREATE TABLE IF NOT EXISTS aos_link_types (
  link_type     TEXT PRIMARY KEY,
  label         TEXT,                                       -- v0.37+ 加入
  inverse_of    TEXT,
  is_transitive INTEGER NOT NULL DEFAULT 0,
  src_type      TEXT,                                       -- v0.37+ 加入：源端点约束（类型名，或 category 名 Container/CodeUnit/Script/AuditFact；仅元数据不强制）
  tgt_type      TEXT,                                       -- v0.37+ 加入：目标端点约束（同上）
  cardinality   TEXT NOT NULL DEFAULT '*'                   -- v0.37+ 加入：公理基数
                 CHECK (cardinality IN ('1','0..1','*','1..*')),
  description   TEXT
);
CREATE INDEX IF NOT EXISTS idx_aos_link_types_inverse ON aos_link_types(inverse_of);

-- 4. 目录层：类型属性定义（v0.37 新增；投影层 DDL 输入）
--    借鉴 asdm-aos aos_type_properties：决定 viewmodel 字段裁剪 / HTTP API 字段过滤 / JSON schema 生成
CREATE TABLE IF NOT EXISTS aos_type_properties (
  type_name    TEXT NOT NULL REFERENCES aos_types(type_name) ON DELETE CASCADE,
  `key`        TEXT NOT NULL,
  label        TEXT NOT NULL,
  wire_type    TEXT NOT NULL,
  storage_hint TEXT NOT NULL DEFAULT 'jsonb'
               CHECK (storage_hint IN ('promoted','jsonb')),
  index_hint   TEXT NOT NULL DEFAULT 'none'
               CHECK (index_hint IN ('none','btree','fulltext','vector')),
  PRIMARY KEY (type_name, `key`)
);
CREATE INDEX IF NOT EXISTS idx_aos_type_properties_type ON aos_type_properties(type_name);

-- 5. 冷层 · 身份与版本
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

-- 6. 冷层 · 对象（v0.37 加 content_hash / pk_hash 字段；PK 仍按 (snapshot_id,type,id)，v0.38 拆 manifest 时切到 pk_hash）
--    - content_hash = sha256(props_json 原始字符串)  应用层计算（JSON.stringify 直出，key 顺序敏感；未做 sort-key 规范化，
--      依赖 analyzer 构造对象的字段顺序稳定 —— 若未来引入规范化需全量重算，勿局部混用）
--    - pk_hash      = sha256(`default|default|${type}|${id}|${content_hash}`)  借鉴 asdm-aos 决策 2b
--      刻意不含 snapshot_id：跨 snapshot 同 (type,id,content_hash) 的对象 pk_hash 相同，是 v0.38 拆 manifest 去重的基础；
--      因此 v0.37 阶段 pk_hash 索引非 UNIQUE（同对象多 snapshot 共存），v0.38 PK 化时唯一性由 PK 天然保证
--    - 两列 nullable：v0.31 老库的 content_hash 列为空（"v0.32+ 启用"），迁移路径不能 NOT NULL；应用层 INSERT 永远非空
CREATE TABLE IF NOT EXISTS aos_objects (
  snapshot_id   TEXT NOT NULL REFERENCES aos_snapshots(snapshot_id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  id            TEXT NOT NULL,
  content_hash  TEXT,                           -- v0.37 启用：跨快照对象去重 / 增量扫描探测（应用层保证非空）
  pk_hash       TEXT,                           -- v0.37 启用：代理主键（v0.38 拆 manifest 时切换为 PK；应用层保证非空）
  props_json    TEXT NOT NULL,                  -- 完整对象 JSON（业务字段）
  PRIMARY KEY (snapshot_id, type, id)
);
CREATE INDEX IF NOT EXISTS idx_aos_objects_content_hash ON aos_objects(content_hash);
-- idx_aos_objects_pk_hash 在 migrate.js v2 块中创建（v0.31 老库 pk_hash 列不存在时不能在 schema.sql 建）
CREATE INDEX IF NOT EXISTS idx_aos_objects_type_id     ON aos_objects(snapshot_id, type, id);
CREATE INDEX IF NOT EXISTS idx_aos_objects_path        ON aos_objects(snapshot_id, type, json_extract(props_json, '$.path'));
CREATE INDEX IF NOT EXISTS idx_aos_objects_module      ON aos_objects(snapshot_id, type, json_extract(props_json, '$.moduleId'));
CREATE INDEX IF NOT EXISTS idx_aos_objects_arch_layer  ON aos_objects(snapshot_id, type, json_extract(props_json, '$.archLayer'));
CREATE INDEX IF NOT EXISTS idx_aos_objects_domain      ON aos_objects(snapshot_id, type, json_extract(props_json, '$.domainId'));

-- 7. 冷层 · 链接（per-snapshot 物化边；D12 双向索引，不引入图数据库）
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

-- 8. 冷层 · 标注（写通道②，markReviewed / addNote 走这里）
CREATE TABLE IF NOT EXISTS aos_overlays (
  snapshot_id  TEXT NOT NULL REFERENCES aos_snapshots(snapshot_id) ON DELETE CASCADE,
  object_type  TEXT NOT NULL,
  object_id    TEXT NOT NULL,
  props_patch  TEXT NOT NULL,                   -- JSON Merge Patch
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, object_type, object_id)
);

-- 9. 冷层 · 步进导入任务（v0.37 新增；游标落表，崩溃可续扫）
--    tenant_id 字段暂未引入：单进程单用户 CLI，加注释预留 v0.40+ 多用户 SaaS 化
CREATE TABLE IF NOT EXISTS aos_import_jobs (
  job_id       TEXT NOT NULL PRIMARY KEY,
  job_kind     TEXT NOT NULL
               CHECK (job_kind IN ('refreshRepo','analyzeFile','export')),
  snapshot_id  TEXT,
  steps        TEXT NOT NULL,                   -- JSON: [{name, status, count, durationMs}]
  current_step TEXT,
  `cursor`     TEXT NOT NULL,                   -- JSON: {repoPath, scannedFiles[], modifiedFiles[], ...}
  status       TEXT NOT NULL DEFAULT 'running'
               CHECK (status IN ('running','paused','completed','failed')),
  error        TEXT,
  started_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (snapshot_id) REFERENCES aos_snapshots(snapshot_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aos_import_jobs_status ON aos_import_jobs(status, updated_at);

-- 10. 镜像新鲜度水位（JSON 主源 → SQLite 镜像的同步水位）
--     saveSnapshot / applyOverlay 成功后记录当时 JSON 文件 mtime；
--     读路径发现 JSON mtime 新于水位（镜像写失败 / 外部改写 JSON）→ 回退 JSON
CREATE TABLE IF NOT EXISTS aos_mirror_state (
  snapshot_kind           TEXT PRIMARY KEY,
  mirrored_json_mtime_ms  INTEGER NOT NULL
);
