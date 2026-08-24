// 产品规划模型快照持久化：planning-snapshot.json 读写

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PLANNING_SNAPSHOT_FILE = 'planning-snapshot.json';
const PLANNING_ENV_VAR = 'NICE_AOS_PLANNING_SNAPSHOT_DIR';

let planningSnapshotDirOverride = null;

export function setPlanningSnapshotDir(dir) {
  planningSnapshotDirOverride = dir;
}

export function getPlanningSnapshotDir() {
  if (planningSnapshotDirOverride) return planningSnapshotDirOverride;
  if (process.env[PLANNING_ENV_VAR]) return process.env[PLANNING_ENV_VAR];
  const candidates = [
    path.join(process.cwd(), '.nice-aos', 'data'),
    path.join(os.homedir(), '.nice-aos', 'data'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, PLANNING_SNAPSHOT_FILE))) return dir;
  }
  return candidates[0];
}

export function getPlanningSnapshotPath() {
  return path.join(getPlanningSnapshotDir(), PLANNING_SNAPSHOT_FILE);
}

export function savePlanningSnapshot(planningModel) {
  const dir = getPlanningSnapshotDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, PLANNING_SNAPSHOT_FILE);
  fs.writeFileSync(filePath, JSON.stringify(planningModel), 'utf-8');
  return filePath;
}

export function loadPlanningSnapshot() {
  const filePath = getPlanningSnapshotPath();
  if (!fs.existsSync(filePath)) {
    const err = new Error(`未找到产品规划快照。\n  快照目录: ${getPlanningSnapshotDir()}\n  请先执行: nice-aos planning build --docs <目录>\n  或指定: nice-aos --planning-snapshot-dir <path>`);
    err.code = 'NO_PLANNING_SNAPSHOT';
    throw err;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function hasPlanningSnapshot() {
  return fs.existsSync(getPlanningSnapshotPath());
}