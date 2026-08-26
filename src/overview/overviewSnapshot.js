// 全景架构模型快照：多项目 code-ontology 快照聚合（overview-snapshot.json）
// 借鉴 deploySnapshot / dbSnapshot / serviceSnapshot 模式，扩展支持"多目录"——
//
// 输入：nice-aos 一次分析单个项目后产出的 <projectDir>/snapshot.json
//   多项目场景（如 asdm 18 项目）由调用方提前逐个扫描，再由 overview 聚合
//
// 概览快照形态（输出 JSON）：
//   {
//     _meta: { generatedAt, scannerVersion, projectCount, ... },
//     projects: [...],         // 每个项目的精简画像（framework / fileCount / lines / techStack / crossDeps）
//     languages: [...],        // 按 ext 聚合的文件/行
//     architecture: {          // 5 层架构 + 跨项目依赖矩阵
//       layers: { client, gateway, application, integration, tool, repo },
//       crossMatrix: { from: [to, ...] },
//       portAllocations: [...],
//     },
//     humanKnowledge: {         // 来自 cict-asdm 辅助文档的设计意图 / 资源需求
//       intent: [...],
//       resources: [...],
//       sources: [...],
//     },
//   }
//
// 调用方：
//   nice-aos overview scan   --projects-dir <root>   [--out-dir <root>]
//   nice-aos overview export --format html           --output overview.html
//   nice-aos overview query  <type>                  --where k=v

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const OVERVIEW_SNAPSHOT_FILE = 'overview-snapshot.json';
const OVERVIEW_ENV_VAR = 'NICE_AOS_OVERVIEW_SNAPSHOT_DIR';

let overviewSnapshotDirOverride = null;

export function setOverviewSnapshotDir(dir) {
  overviewSnapshotDirOverride = dir;
}

export function getOverviewSnapshotDir() {
  if (overviewSnapshotDirOverride) return overviewSnapshotDirOverride;
  if (process.env[OVERVIEW_ENV_VAR]) return process.env[OVERVIEW_ENV_VAR];
  const candidates = [
    path.join(process.cwd(), '.nice-aos', 'data'),
    path.join(os.homedir(), '.nice-aos', 'data'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, OVERVIEW_SNAPSHOT_FILE))) return dir;
  }
  return candidates[0];
}

export function getOverviewSnapshotPath() {
  return path.join(getOverviewSnapshotDir(), OVERVIEW_SNAPSHOT_FILE);
}

export function saveOverviewSnapshot(overviewModel) {
  const dir = getOverviewSnapshotDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, OVERVIEW_SNAPSHOT_FILE);
  fs.writeFileSync(filePath, JSON.stringify(overviewModel, null, 2), 'utf-8');

  // 同步镜像到 SQLite（v0.31 双写，Phase A）
  // overview 模型是自定义形态（projects/languages/architecture 顶层键，非 OBJECT_TYPES 类型且无 id），
  // metaOnly 只写元数据行；对象级存储待 Phase C 设计 overview 专用 type 集合
  try {
    if (isAvailable()) {
      const r = sqlSave({ kind: 'overview', snapshotDir: dir, dataMap: overviewModel, metaOnly: true });
      if (!r?.ok && r?.reason && r.reason !== 'sqlite-unavailable') {
        console.warn(`⚠️  SQLite 镜像失败 (overview): ${r.reason}`);
      }
    }
  } catch (err) {
    console.warn(`⚠️  SQLite 镜像抛错 (overview): ${err.message}`);
  }

  return filePath;
}

export function loadOverviewSnapshot() {
  const filePath = getOverviewSnapshotPath();
  if (!fs.existsSync(filePath)) {
    const err = new Error(
      `未找到全景架构快照。\n  快照目录: ${getOverviewSnapshotDir()}\n` +
      `  请先执行: nice-aos overview scan --projects-dir <path> --layout <layout.json>\n` +
      `  或指定: nice-aos --overview-snapshot-dir <path>`,
    );
    err.code = 'NO_OVERVIEW_SNAPSHOT';
    throw err;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function hasOverviewSnapshot() {
  return fs.existsSync(getOverviewSnapshotPath());
}

// 加载单个 code-ontology snapshot（来自 nice-aos action refreshRepo 输出）
export function loadProjectSnapshot(snapshotFilePath) {
  if (!fs.existsSync(snapshotFilePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(snapshotFilePath, 'utf-8'));
  } catch (err) {
    return null;
  }
}

// 收集目录下所有 snapshot.json（直接子目录或一级 .nice-aos/data）
// 形态约定：每个项目独立目录 <root>/<projectName>/snapshot.json
export function discoverSnapshots(rootDir) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  const stat = fs.statSync(rootDir);
  if (!stat.isDirectory()) return out;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    const snapPath = path.join(rootDir, entry.name, 'snapshot.json');
    if (fs.existsSync(snapPath)) {
      out.push({ name: entry.name, snapshotPath: snapPath });
    }
  }
  return out;
}

// storage 层双写依赖（v0.31）
import { saveSnapshot as sqlSave, isAvailable } from '../storage/index.js';
