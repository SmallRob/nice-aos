import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SNAPSHOT_FILE = 'snapshot.json';
const ENV_VAR = 'NICE_AOS_SNAPSHOT_DIR';

let snapshotDirOverride = null;

export function setSnapshotDir(dir) {
  snapshotDirOverride = dir;
}

export function getSnapshotDir() {
  if (snapshotDirOverride) return snapshotDirOverride;
  if (process.env[ENV_VAR]) return process.env[ENV_VAR];
  // 回退链：cwd/.nice-aos/data → 用户主目录 ~/.nice-aos/data
  const candidates = [
    path.join(process.cwd(), '.nice-aos', 'data'),
    path.join(os.homedir(), '.nice-aos', 'data'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, SNAPSHOT_FILE))) return dir;
  }
  return candidates[0]; // 均不存在时保持原行为（后续 loadSnapshot 报 NO_SNAPSHOT）
}

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
