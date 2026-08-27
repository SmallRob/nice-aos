// 领域快照文件 kit：db / deploy / planning / service / overview 五类快照模块的
// 共享底座——目录解析链、读写、存在性判断与文件哈希的单一实现。
//
// 背景（自扫描 duplicates 检测发现）：五个领域模块各自维护了一份模板级复制的
// getXxxSnapshotDir / loadXxxSnapshot / saveXxxSnapshot / hasXxxSnapshot，
// 目录解析 bug 与写入策略的修需要同步改 5 处。本 kit 收敛为一份。
//
// 目录解析链（各领域一致，仅环境变量名不同）：
//   setXxxSnapshotDir 覆盖 > NICE_AOS_XXX_SNAPSHOT_DIR 环境变量 >
//   cwd/.nice-aos/data（含快照文件探测）> ~/.nice-aos/data

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/**
 * @param {{
 *   snapshotFile: string,
 *   envVar?: string,
 *   errCode: string,
 *   missingHint: (dir: string) => string,
 *   indent?: number,
 * }} spec
 */
export function createSnapshotFileKit({ snapshotFile, envVar = null, errCode, missingHint, indent = 0 }) {
  let dirOverride = null;

  const getDir = () => {
    if (dirOverride) return dirOverride;
    if (envVar && process.env[envVar]) return process.env[envVar];
    const candidates = [
      path.join(process.cwd(), '.nice-aos', 'data'),
      path.join(os.homedir(), '.nice-aos', 'data'),
    ];
    for (const dir of candidates) {
      if (fs.existsSync(path.join(dir, snapshotFile))) return dir;
    }
    return candidates[0];
  };

  const getPath = () => path.join(getDir(), snapshotFile);

  const has = () => fs.existsSync(getPath());

  /** @param {string} dir 显式覆盖快照目录（CLI --xxx-snapshot-dir 参数） */
  const setDirOverride = (dir) => { dirOverride = dir; };

  /**
   * 原子性同 JSON.stringify 直写（与历史行为一致；跨进程并发写保护由 storage 层负责）
   * @returns {string} 写入文件的绝对路径
   */
  const save = (model) => {
    const dir = getDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, snapshotFile);
    fs.writeFileSync(filePath, JSON.stringify(model, null, indent), 'utf-8');
    return filePath;
  };

  const load = () => {
    const filePath = getPath();
    if (!has()) {
      const err = new Error(missingHint(getDir()));
      err.code = errCode;
      throw err;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  };

  return { getDir, getPath, has, save, load, setDirOverride };
}

/** 文件内容 sha256 前 16 位（增量扫描的变更探测哈希，五领域同构） */
export function snapshotFileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}
