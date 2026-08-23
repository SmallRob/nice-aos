// 部署模型快照持久化：deploy-snapshot.json 读写与文件哈希

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DEPLOY_SNAPSHOT_FILE = 'deploy-snapshot.json';
const DEPLOY_ENV_VAR = 'NICE_AOS_DEPLOY_SNAPSHOT_DIR';

let deploySnapshotDirOverride = null;

export function setDeploySnapshotDir(dir) {
  deploySnapshotDirOverride = dir;
}

export function getDeploySnapshotDir() {
  if (deploySnapshotDirOverride) return deploySnapshotDirOverride;
  if (process.env[DEPLOY_ENV_VAR]) return process.env[DEPLOY_ENV_VAR];
  const candidates = [
    path.join(process.cwd(), '.nice-aos', 'data'),
    path.join(os.homedir(), '.nice-aos', 'data'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, DEPLOY_SNAPSHOT_FILE))) return dir;
  }
  return candidates[0];
}

export function getDeploySnapshotPath() {
  return path.join(getDeploySnapshotDir(), DEPLOY_SNAPSHOT_FILE);
}

export function saveDeploySnapshot(deployModel) {
  const dir = getDeploySnapshotDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, DEPLOY_SNAPSHOT_FILE);
  fs.writeFileSync(filePath, JSON.stringify(deployModel), 'utf-8');
  return filePath;
}

export function loadDeploySnapshot() {
  const filePath = getDeploySnapshotPath();
  if (!fs.existsSync(filePath)) {
    const err = new Error(`未找到部署快照。\n  快照目录: ${getDeploySnapshotDir()}\n  请先执行: nice-aos deploy scan --dir <path>\n  或指定: nice-aos --deploy-snapshot-dir <path>`);
    err.code = 'NO_DEPLOY_SNAPSHOT';
    throw err;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function hasDeploySnapshot() {
  return fs.existsSync(getDeploySnapshotPath());
}

export function fileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}
