import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DB_SNAPSHOT_FILE = 'db-snapshot.json';
const DB_ENV_VAR = 'NICE_AOS_DB_SNAPSHOT_DIR';

let dbSnapshotDirOverride = null;

export function setDbSnapshotDir(dir) {
  dbSnapshotDirOverride = dir;
}

export function getDbSnapshotDir() {
  if (dbSnapshotDirOverride) return dbSnapshotDirOverride;
  if (process.env[DB_ENV_VAR]) return process.env[DB_ENV_VAR];
  const candidates = [
    path.join(process.cwd(), '.nice-aos', 'data'),
    path.join(os.homedir(), '.nice-aos', 'data'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, DB_SNAPSHOT_FILE))) return dir;
  }
  return candidates[0];
}

export function getDbSnapshotPath() {
  return path.join(getDbSnapshotDir(), DB_SNAPSHOT_FILE);
}

export function saveDbSnapshot(dbDataMap) {
  const dir = getDbSnapshotDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, DB_SNAPSHOT_FILE);
  fs.writeFileSync(filePath, JSON.stringify(dbDataMap), 'utf-8');
  return filePath;
}

export function loadDbSnapshot() {
  const filePath = getDbSnapshotPath();
  if (!fs.existsSync(filePath)) {
    const err = new Error(`未找到数据库快照。\n  快照目录: ${getDbSnapshotDir()}\n  请先执行: nice-aos db scan --dir <path>\n  或指定: nice-aos --db-snapshot-dir <path>`);
    err.code = 'NO_DB_SNAPSHOT';
    throw err;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function hasDbSnapshot() {
  return fs.existsSync(getDbSnapshotPath());
}

export function fileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}
