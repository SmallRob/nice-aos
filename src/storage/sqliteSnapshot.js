// 本地 SQLite 快照：loadSnapshot / saveSnapshot / loadType / loadObject / queryWhere
// 借鉴 asdm-aos StorageFacade + content-hash 设计，v0.31 单版本简化版
//
// 关键约定：
//   - 5 种 snapshot_kind（code/db/deploy/planning/service/overview）共用同一 db 文件
//   - v0.31 单版本：snapshot_id = `<kind>:default`，写时 UPSERT + DELETE all + INSERT all（事务）
//   - 写通道②（markReviewed / addNote）：单写 SQL（aos_overlays），不碰 JSON
//   - 读路径：JSON.parse（snapshot 形态）+ LEFT JOIN overlays 应用 props_patch
//
// 公开 API：
//   - loadSnapshot({ kind, snapshotDir, jsonFile })  → DataMap
//   - saveSnapshot({ kind, snapshotDir, jsonFile, dataMap })
//   - loadType({ kind, snapshotDir, type })          → Array<Object>
//   - loadObject({ kind, snapshotDir, type, id })    → Object | null
//   - queryWhere({ kind, snapshotDir, type, where }) → Array<Object>
//   - applyOverlay({ kind, snapshotDir, type, id, patch }) → void
//   - buildAskContextFromSql({ snapshotDir, question }) → string
//
// 错误处理：
//   - SQLite 不可用时所有方法返回 null（调用方负责回退 JSON）
//   - snapshot 缺失时返回 undefined（区别于"不可用"，调用方可走 JSON）

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb, getSqlitePath } from './db.js';
import { seedOntologyCatalog } from './seed.js';

// snapshot_kind → DataMap 顶层键名映射（除 _meta 外的所有键都按对象类型存）
// 实际上各 kind 的对象类型集合是它自己的 OBJECT_TYPES 子集（由各模块自己决定哪些类型写到 snapshot）
// 这里仅定义 kind → 默认 fallback 目录的解析

const DEFAULT_SNAPSHOT_FILE = {
  code: 'snapshot.json',
  db: 'db-snapshot.json',
  deploy: 'deploy-snapshot.json',
  planning: 'planning-snapshot.json',
  service: 'service-snapshot.json',
  overview: 'overview-snapshot.json',
};

function resolveSnapshotId(kind, dataMap) {
  // v0.31 单版本：固定 `<kind>:default`
  // v0.32+ 多版本：code 用 `${kind}:${commit_hash || 'unknown'}:${analyzer_version || 'unknown'}`
  return `${kind}:default`;
}

function resolveSnapshotDir(snapshotDir) {
  if (snapshotDir) return snapshotDir;
  const candidates = [
    path.join(process.cwd(), '.nice-aos', 'data'),
    path.join(os.homedir(), '.nice-aos', 'data'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[0];
}

// stale 镜像防护：JSON 是主数据源。saveSnapshot / applyOverlay 成功时在
// aos_mirror_state 记录当时 JSON 的 mtime（同步水位）；读路径发现 JSON mtime
// 新于水位（镜像写失败 / 外部改写 JSON）→ 镜像视为过期 → 回退 JSON。
// 不用 aos.sqlite 文件 mtime 比较：closeDb 的 WAL checkpoint 也会更新它，只读
// 运行会"洗白"过期镜像。
const MIRROR_FRESH_TOLERANCE_MS = 100;

function jsonMtimeMs(kind) {
  const dbPath = getSqlitePath();
  const jsonPath = path.join(path.dirname(dbPath), DEFAULT_SNAPSHOT_FILE[kind]);
  return fs.existsSync(jsonPath) ? fs.statSync(jsonPath).mtimeMs : null;
}

function updateMirrorMarker(db, kind) {
  try {
    const mtime = jsonMtimeMs(kind);
    if (mtime === null) return;
    db.prepare(`
      INSERT INTO aos_mirror_state (snapshot_kind, mirrored_json_mtime_ms) VALUES (?, ?)
      ON CONFLICT(snapshot_kind) DO UPDATE SET mirrored_json_mtime_ms = excluded.mirrored_json_mtime_ms
    `).run(kind, mtime);
  } catch { /* best-effort：水位缺失只是退化为无防护 */ }
}

function isMirrorFresh(db, kind) {
  try {
    const row = db.prepare('SELECT mirrored_json_mtime_ms FROM aos_mirror_state WHERE snapshot_kind = ?').get(kind);
    if (!row) return true; // 旧版镜像无水位（或 kind 未镜像过）：信任，下次写路径补齐
    const mtime = jsonMtimeMs(kind);
    if (mtime === null) return true;
    return mtime <= row.mirrored_json_mtime_ms + MIRROR_FRESH_TOLERANCE_MS;
  } catch {
    return true; // 异常不拦截，交由后续查询逻辑
  }
}

export function ensureSeed(db) {
  if (!db) return;
  // 查 aos_types 行数；0 行才种子化（首次启动）
  const row = db.prepare('SELECT COUNT(*) AS n FROM aos_types').get();
  if (row.n === 0) {
    // 延迟读取 blueprint（由 storage/index.js 启动时 setBlueprint 注入，避免 db.js→blueprint.js 循环依赖）
    const { OBJECT_TYPES, LINK_TYPES } = loadBlueprint();
    seedOntologyCatalog(db, { OBJECT_TYPES, LINK_TYPES });
  }
}

// blueprint 由 CLI 启动时经 setBlueprint 注入（sqliteSnapshot 不静态依赖 ontology 模块）
let _blueprintCache = null;
function loadBlueprint() {
  if (!_blueprintCache) {
    throw new Error('blueprint 未注入。请通过 setBlueprint({OBJECT_TYPES, LINK_TYPES}) 注入。');
  }
  return _blueprintCache;
}

export function setBlueprint(bp) {
  _blueprintCache = bp;
}

// 1) 保存快照（事务：upsert snapshot row + delete old objects + insert new objects + 写链接）
//    metaOnly=true：只写 aos_snapshots 元数据行（overview 等自定义形态模型，对象非 DataMap 类型且无 id，Phase A/B 不做对象级存储）
export function saveSnapshot({ kind, snapshotDir, dataMap, metaOnly = false }) {
  if (!dataMap) throw new Error('saveSnapshot: dataMap 必填');
  const db = openDb();
  if (!db) return { ok: false, reason: 'sqlite-unavailable' };

  ensureSeed(db);

  const dir = resolveSnapshotDir(snapshotDir);
  const snapshotId = resolveSnapshotId(kind, dataMap);
  const meta = dataMap._meta || {};
  const objectCounts = meta.objectCounts || {};
  const metaExtra = {
    cycles: meta.cycles || [],
    orphanCandidates: meta.orphanCandidates || [],
    deadExportCandidates: meta.deadExportCandidates || [],
    unmatchedFrontendCalls: meta.unmatchedFrontendCalls || [],
    durationMs: meta.durationMs ?? null,
  };
  const project = dataMap.Project?.[0] || {};

  const tx = db.transaction(() => {
    // 旧版本标记非当前（如果有同 kind 的其他 snapshot_id，标 is_current=0）
    db.prepare('UPDATE aos_snapshots SET is_current = 0 WHERE snapshot_kind = ? AND snapshot_id != ? AND is_current = 1')
      .run(kind, snapshotId);

    // UPSERT snapshot row
    db.prepare(`
      INSERT INTO aos_snapshots (
        snapshot_id, snapshot_kind, project_name, commit_hash, branch, analyzer_version,
        generated_at, duration_ms, is_current, object_counts, meta_extra
      ) VALUES (
        @snapshot_id, @snapshot_kind, @project_name, @commit_hash, @branch, @analyzer_version,
        @generated_at, @duration_ms, 1, @object_counts, @meta_extra
      )
      ON CONFLICT(snapshot_id) DO UPDATE SET
        project_name = excluded.project_name,
        commit_hash = excluded.commit_hash,
        branch = excluded.branch,
        analyzer_version = excluded.analyzer_version,
        generated_at = excluded.generated_at,
        duration_ms = excluded.duration_ms,
        is_current = 1,
        object_counts = excluded.object_counts,
        meta_extra = excluded.meta_extra
    `).run({
      snapshot_id: snapshotId,
      snapshot_kind: kind,
      project_name: project.name ?? meta.projectName ?? null,
      commit_hash: project.commitHash ?? null,
      branch: project.branch ?? null,
      analyzer_version: meta.analyzerVersion ?? 'unknown',
      generated_at: meta.generatedAt ?? new Date().toISOString(),
      duration_ms: meta.durationMs ?? null,
      object_counts: JSON.stringify(objectCounts),
      meta_extra: JSON.stringify(metaExtra),
    });

    // 删旧 objects / links（仅本 snapshot_id）
    db.prepare('DELETE FROM aos_objects WHERE snapshot_id = ?').run(snapshotId);
    db.prepare('DELETE FROM aos_links WHERE snapshot_id = ?').run(snapshotId);

    let insertedCount = 0;
    if (!metaOnly) {
      // 插新 objects（按 dataMap 顶层每个数组键，_meta 跳过）
      const insertObj = db.prepare(`
        INSERT INTO aos_objects (snapshot_id, type, id, content_hash, props_json)
        VALUES (?, ?, ?, NULL, ?)
        ON CONFLICT(snapshot_id, type, id) DO UPDATE SET
          props_json = excluded.props_json
      `);
      for (const [type, list] of Object.entries(dataMap)) {
        if (type === '_meta') continue;
        if (!Array.isArray(list)) continue;
        for (const obj of list) {
          if (!obj || typeof obj !== 'object' || !obj.id) continue; // 跳过无 id 的（防御）
          insertObj.run(snapshotId, type, obj.id, JSON.stringify(obj));
          insertedCount += 1;
        }
      }
    }
    return { insertedCount };
  });

  try {
    const { insertedCount } = tx();
    updateMirrorMarker(db, kind); // 镜像同步成功 → 记录 JSON 水位
    return { ok: true, snapshotId, dir, objects: insertedCount };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// 2) 加载快照（DataMap 形态）
export function loadSnapshot({ kind, snapshotDir } = {}) {
  const db = openDb();
  if (!db) return null;
  ensureSeed(db);

  // 找当前版本的 snapshot_id
  const snap = db.prepare('SELECT * FROM aos_snapshots WHERE snapshot_kind = ? AND is_current = 1 ORDER BY generated_at DESC LIMIT 1')
    .get(kind);
  if (!snap) return undefined; // 与 null 区分：null=SQLite 不可用；undefined=无 snapshot

  const objectRows = db.prepare('SELECT type, id, props_json FROM aos_objects WHERE snapshot_id = ?')
    .all(snap.snapshot_id);
  const overlayRows = db.prepare('SELECT object_type, object_id, props_patch, updated_at FROM aos_overlays WHERE snapshot_id = ?')
    .all(snap.snapshot_id);

  // 构造 overlay 索引
  const overlayByKey = new Map();
  for (const ov of overlayRows) {
    overlayByKey.set(`${ov.object_type}:${ov.object_id}`, ov);
  }

  // 重建 DataMap
  const dataMap = { _meta: rebuildMeta(snap) };
  for (const row of objectRows) {
    if (!Array.isArray(dataMap[row.type])) dataMap[row.type] = [];
    let obj;
    try { obj = JSON.parse(row.props_json); } catch { obj = { id: row.id, _corrupt: true }; }
    // 应用 overlay（如果存在）
    const ov = overlayByKey.get(`${row.type}:${row.id}`);
    if (ov) {
      try {
        const patch = JSON.parse(ov.props_patch);
        obj = applyJsonMergePatch(obj, patch);
        obj._overlayUpdatedAt = ov.updated_at;
      } catch { /* 损坏 overlay 跳过 */ }
    }
    dataMap[row.type].push(obj);
  }

  return dataMap;
}

// 3) 加载单类型（数组）
export function loadType({ kind, type }) {
  const db = openDb();
  if (!db) return null;
  ensureSeed(db);

  const snap = db.prepare('SELECT snapshot_id FROM aos_snapshots WHERE snapshot_kind = ? AND is_current = 1 ORDER BY generated_at DESC LIMIT 1')
    .get(kind);
  if (!snap) return undefined;

  const rows = db.prepare('SELECT id, props_json FROM aos_objects WHERE snapshot_id = ? AND type = ?')
    .all(snap.snapshot_id, type);

  const ids = rows.map((r) => r.id);
  const overlayRows = ids.length
    ? db.prepare(`SELECT object_type, object_id, props_patch, updated_at FROM aos_overlays
                  WHERE snapshot_id = ? AND object_type = ? AND object_id IN (${ids.map(() => '?').join(',')})`)
        .all(snap.snapshot_id, type, ...ids)
    : [];
  const overlayById = new Map(overlayRows.map((o) => [o.object_id, o]));

  const result = [];
  for (const row of rows) {
    let obj;
    try { obj = JSON.parse(row.props_json); } catch { obj = { id: row.id, _corrupt: true }; }
    const ov = overlayById.get(row.id);
    if (ov) {
      try {
        const patch = JSON.parse(ov.props_patch);
        obj = applyJsonMergePatch(obj, patch);
        obj._overlayUpdatedAt = ov.updated_at;
      } catch { /* skip */ }
    }
    result.push(obj);
  }
  return result;
}

// 4) 加载单对象
export function loadObject({ kind, type, id }) {
  const db = openDb();
  if (!db) return null;
  ensureSeed(db);

  const snap = db.prepare('SELECT snapshot_id FROM aos_snapshots WHERE snapshot_kind = ? AND is_current = 1 ORDER BY generated_at DESC LIMIT 1')
    .get(kind);
  if (!snap) return undefined;

  const row = db.prepare('SELECT props_json FROM aos_objects WHERE snapshot_id = ? AND type = ? AND id = ?')
    .get(snap.snapshot_id, type, id);
  if (!row) return null;

  let obj;
  try { obj = JSON.parse(row.props_json); } catch { return { id, _corrupt: true }; }

  const ov = db.prepare('SELECT props_patch, updated_at FROM aos_overlays WHERE snapshot_id = ? AND object_type = ? AND object_id = ?')
    .get(snap.snapshot_id, type, id);
  if (ov) {
    try {
      const patch = JSON.parse(ov.props_patch);
      obj = applyJsonMergePatch(obj, patch);
      obj._overlayUpdatedAt = ov.updated_at;
    } catch { /* skip */ }
  }
  return obj;
}

// 5) 条件查询（where: { key: value | [v1,v2] | { $gt: n } }）
//   v0.31 简化版：仅支持等值与 IN；不实现 $gt/$lt（query.js 现有 matchesWhere 是同限制）
export function queryWhere({ kind, type, where = {} } = {}) {
  const db = openDb();
  if (!db) return null;
  ensureSeed(db);

  const snap = db.prepare('SELECT snapshot_id FROM aos_snapshots WHERE snapshot_kind = ? AND is_current = 1 ORDER BY generated_at DESC LIMIT 1')
    .get(kind);
  if (!snap) return undefined;
  if (!isMirrorFresh(db, kind)) return undefined; // 镜像落后于 JSON → 调用方回退 JSON

  // 动态拼 WHERE（用 json_extract）
  const conds = [];
  const params = [snap.snapshot_id, type];
  for (const [k, v] of Object.entries(where)) {
    if (Array.isArray(v)) {
      const placeholders = v.map(() => '?').join(',');
      conds.push(`json_extract(props_json, '$.${k}') IN (${placeholders})`);
      params.push(...v);
    } else {
      conds.push(`json_extract(props_json, '$.${k}') = ?`);
      params.push(v);
    }
  }
  const whereClause = conds.length ? `AND ${conds.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT id, props_json FROM aos_objects WHERE snapshot_id = ? AND type = ? ${whereClause}`)
    .all(...params);
  return rows.map((r) => {
    try { return JSON.parse(r.props_json); } catch { return { id: r.id, _corrupt: true }; }
  });
}

// 6) 写标注（markReviewed / addNote）→ upsert overlay
export function applyOverlay({ kind, type, id, patch }) {
  if (!patch || typeof patch !== 'object') throw new Error('applyOverlay: patch 必填且为对象');
  const db = openDb();
  if (!db) return { ok: false, reason: 'sqlite-unavailable' };
  ensureSeed(db);

  const snap = db.prepare('SELECT snapshot_id FROM aos_snapshots WHERE snapshot_kind = ? AND is_current = 1 ORDER BY generated_at DESC LIMIT 1')
    .get(kind);
  if (!snap) return { ok: false, reason: 'no-snapshot' };

  const ts = new Date().toISOString();
  // 读旧 overlay（如有），merge
  const existing = db.prepare('SELECT props_patch FROM aos_overlays WHERE snapshot_id = ? AND object_type = ? AND object_id = ?')
    .get(snap.snapshot_id, type, id);
  let merged = patch;
  if (existing) {
    try {
      const old = JSON.parse(existing.props_patch);
      merged = applyJsonMergePatch(old, patch);
    } catch { /* 用新 patch 覆盖 */ }
  }

  db.prepare(`
    INSERT INTO aos_overlays (snapshot_id, object_type, object_id, props_patch, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_id, object_type, object_id) DO UPDATE SET
      props_patch = excluded.props_patch,
      updated_at = excluded.updated_at
  `).run(snap.snapshot_id, type, id, JSON.stringify(merged), ts);
  updateMirrorMarker(db, kind); // overlay 落库成功 → 水位跟上 JSON

  return { ok: true, snapshotId: snap.snapshot_id, updatedAt: ts };
}

// 7) 重建 _meta 对象（与原 DataMap._meta 字段对齐）
function rebuildMeta(snap) {
  const objectCounts = safeParse(snap.object_counts, {});
  const metaExtra = safeParse(snap.meta_extra, {});
  return {
    generatedAt: snap.generated_at,
    durationMs: snap.duration_ms ?? metaExtra.durationMs ?? null,
    analyzerVersion: snap.analyzer_version,
    cycles: metaExtra.cycles || [],
    orphanCandidates: metaExtra.orphanCandidates || [],
    deadExportCandidates: metaExtra.deadExportCandidates || [],
    unmatchedFrontendCalls: metaExtra.unmatchedFrontendCalls || [],
    objectCounts,
  };
}

function safeParse(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

// JSON Merge Patch (RFC 7396) 极简实现
//   - patch 里的 null 表示删除该 key
//   - 其他值是覆盖
//   - 嵌套对象递归合并
export function applyJsonMergePatch(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  if (!target || typeof target !== 'object' || Array.isArray(target)) target = {};
  const result = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete result[k];
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      result[k] = applyJsonMergePatch(result[k] || {}, v);
    } else {
      result[k] = v;
    }
  }
  return result;
}

// 8) ask 上下文 SQL 预过滤（与 buildAskContext.js 行为一致）
//    4 次 SQL：Project + Top10 Module + objectCounts 摘要 + 健康指标
//    不读任何 JSON 文件；不需要 12MB 全量解析
export function buildAskContextFromSql({ kind = 'code', snapshotDir, question } = {}) {
  const db = openDb();
  if (!db) return null;
  ensureSeed(db);

  const snap = db.prepare('SELECT * FROM aos_snapshots WHERE snapshot_kind = ? AND is_current = 1 ORDER BY generated_at DESC LIMIT 1')
    .get(kind);
  if (!snap) return null;
  if (!isMirrorFresh(db, kind)) return null; // 镜像落后于 JSON → 回退 JSON

  const lines = [];
  lines.push('## 项目本体快照（SQL 预过滤）');

  // Project
  const projectRow = db.prepare('SELECT props_json FROM aos_objects WHERE snapshot_id = ? AND type = ? LIMIT 1')
    .get(snap.snapshot_id, 'Project');
  let project = null;
  if (projectRow) {
    try { project = JSON.parse(projectRow.props_json); } catch { /* ignore */ }
  }
  if (project) {
    lines.push(`- 名称: ${project.name ?? '未知'}`);
    lines.push(`- 框架: ${project.frameworkLabel ?? project.framework ?? '未知'}`);
    lines.push(`- 语言: ${project.language ?? '未知'}`);
    lines.push(`- 源文件数: ${project.fileCount ?? 0}`);
    lines.push(`- Commit: ${project.commitHash ?? '无'}`);
  } else {
    lines.push('- 名称: 未知（无 Project 记录）');
  }

  // 架构分层（从 Project.architecture.layers 读）
  if (project?.architecture?.layers) {
    lines.push('\n## 架构分层');
    for (const layer of project.architecture.layers) {
      lines.push(`- ${layer.label}: ${layer.fileCount} 文件 (${layer.share}%)`);
    }
  }

  // 功能域
  const domainRows = db.prepare('SELECT props_json FROM aos_objects WHERE snapshot_id = ? AND type = ?')
    .all(snap.snapshot_id, 'Domain');
  if (domainRows.length) {
    lines.push('\n## 功能域');
    for (const row of domainRows) {
      try {
        const dom = JSON.parse(row.props_json);
        lines.push(`- ${dom.name}: ${dom.fileCount} 文件, ${dom.lineCount ?? '?'} 行`);
      } catch { /* skip */ }
    }
  }

  // Module Top 10
  const moduleRows = db.prepare(`
    SELECT props_json FROM aos_objects
    WHERE snapshot_id = ? AND type = 'Module'
    ORDER BY CAST(json_extract(props_json, '$.fileCount') AS INTEGER) DESC
    LIMIT 10
  `).all(snap.snapshot_id);
  if (moduleRows.length) {
    lines.push('\n## 模块 Top 10');
    for (const row of moduleRows) {
      try {
        const mod = JSON.parse(row.props_json);
        lines.push(`- ${mod.path} (${mod.fileCount} 文件, ${mod.archLayerLabel ?? mod.layer})`);
      } catch { /* skip */ }
    }
  }

  // 声明依赖（聚合 Dependency）
  const depRows = db.prepare(`SELECT DISTINCT json_extract(props_json, '$.name') AS name FROM aos_objects WHERE snapshot_id = ? AND type = 'Dependency' LIMIT 50`)
    .all(snap.snapshot_id);
  lines.push('\n## 声明依赖');
  lines.push(depRows.map((d) => d.name).filter(Boolean).join(', ') || '无');

  // 健康指标
  if (project?.health) {
    const h = project.health;
    lines.push('\n## 健康指标');
    lines.push(`- 循环依赖: ${h.cycleCount ?? 0}`);
    lines.push(`- 孤儿文件: ${h.orphanFileCount ?? 0}`);
    lines.push(`- 死代码候选: ${(h.deadTypeCount ?? 0) + (h.deadFunctionCount ?? 0) + (h.deadExportCount ?? 0)}`);
    lines.push(`- 未声明依赖: ${h.undeclaredDependencyCount ?? 0}`);
  }

  // objectCounts 摘要
  const counts = safeParse(snap.object_counts, {});
  const countKeys = Object.entries(counts).filter(([, v]) => v > 0);
  if (countKeys.length) {
    lines.push('\n## 对象统计');
    for (const [type, count] of countKeys) {
      lines.push(`- ${type}: ${count}`);
    }
  }

  if (question) lines.push(`\n## 问题\n${question}`);
  return lines.join('\n');
}

// 9) 列出当前所有 snapshot（供 status / history 使用）
export function listSnapshots({ kind } = {}) {
  const db = openDb();
  if (!db) return [];
  ensureSeed(db);
  const sql = kind
    ? 'SELECT * FROM aos_snapshots WHERE snapshot_kind = ? ORDER BY generated_at DESC'
    : 'SELECT * FROM aos_snapshots ORDER BY generated_at DESC';
  return db.prepare(sql).all(kind ? [kind] : []);
}
