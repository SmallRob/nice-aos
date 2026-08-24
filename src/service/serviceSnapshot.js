// 后端服务模型快照持久化：service-snapshot.json 读写

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const SERVICE_SNAPSHOT_FILE = 'service-snapshot.json';
const SERVICE_ENV_VAR = 'NICE_AOS_SERVICE_SNAPSHOT_DIR';
const SERVICE_MODULE_CONFIG_FILE = 'service-modules.json';

let serviceSnapshotDirOverride = null;

export function setServiceSnapshotDir(dir) {
  serviceSnapshotDirOverride = dir;
}

export function getServiceSnapshotDir() {
  if (serviceSnapshotDirOverride) return serviceSnapshotDirOverride;
  if (process.env[SERVICE_ENV_VAR]) return process.env[SERVICE_ENV_VAR];
  const candidates = [
    path.join(process.cwd(), '.nice-aos', 'data'),
    path.join(os.homedir(), '.nice-aos', 'data'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, SERVICE_SNAPSHOT_FILE))) return dir;
  }
  return candidates[0];
}

export function getServiceSnapshotPath() {
  return path.join(getServiceSnapshotDir(), SERVICE_SNAPSHOT_FILE);
}

// 模块配置文件路径（默认与服务快照同目录）：动态推导的模块规则落盘位置，构建时加载
export function getServiceModuleConfigPath() {
  return path.join(getServiceSnapshotDir(), SERVICE_MODULE_CONFIG_FILE);
}

export function saveServiceSnapshot(serviceModel) {
  const dir = getServiceSnapshotDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, SERVICE_SNAPSHOT_FILE);
  fs.writeFileSync(filePath, JSON.stringify(serviceModel), 'utf-8');
  return filePath;
}

export function loadServiceSnapshot() {
  const filePath = getServiceSnapshotPath();
  if (!fs.existsSync(filePath)) {
    const err = new Error(`未找到服务快照。\n  快照目录: ${getServiceSnapshotDir()}\n  请先执行: nice-aos service build --snapshot <path>\n  或指定: nice-aos --service-snapshot-dir <path>`);
    err.code = 'NO_SERVICE_SNAPSHOT';
    throw err;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function hasServiceSnapshot() {
  return fs.existsSync(getServiceSnapshotPath());
}

export function fileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}
