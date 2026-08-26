import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 目录解析统一走 paths.js（单一状态源；CLI --snapshot-dir 与 storage 层 SQLite 路径共用同一覆盖链）
import { setSnapshotDir, getSnapshotDirOverride, getSnapshotDir, ENV_VAR } from '../paths.js';
export { setSnapshotDir, getSnapshotDirOverride, getSnapshotDir };

const SNAPSHOT_FILE = 'snapshot.json';

export function getSnapshotPath() {
  return path.join(getSnapshotDir(), SNAPSHOT_FILE);
}

export function saveSnapshot(dataMap) {
  const dir = getSnapshotDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, SNAPSHOT_FILE);
  fs.writeFileSync(filePath, JSON.stringify(dataMap), 'utf-8');
  return filePath;
}

export function loadSnapshot() {
  const filePath = getSnapshotPath();
  if (!fs.existsSync(filePath)) {
    const err = new Error(`未找到本体快照。
  快照目录: ${getSnapshotDir()}
  请先执行构建: nice-aos action refreshRepo
  或指定快照目录: nice-aos --snapshot-dir <path> ...
  或设置环境变量: export ${ENV_VAR}=<path>`);
    err.code = 'NO_SNAPSHOT';
    throw err;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function hasSnapshot() {
  return fs.existsSync(getSnapshotPath());
}
