// 统一 snapshot 目录解析（ontology/snapshot.js + storage/db.js 共用）
// 优先级：setSnapshotDir() override > NICE_AOS_SNAPSHOT_DIR > cwd/.nice-aos/data > ~/.nice-aos/data

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let snapshotDirOverride = null;
export const ENV_VAR = 'NICE_AOS_SNAPSHOT_DIR';

export function setSnapshotDir(dir) {
  snapshotDirOverride = dir;
}

export function getSnapshotDirOverride() {
  return snapshotDirOverride;
}

export function getSnapshotDir() {
  if (snapshotDirOverride) return snapshotDirOverride;
  if (process.env[ENV_VAR]) return process.env[ENV_VAR];
  const candidates = [
    path.join(process.cwd(), '.nice-aos', 'data'),
    path.join(os.homedir(), '.nice-aos', 'data'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'snapshot.json'))) return dir;
  }
  return candidates[0];
}
