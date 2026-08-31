// 部署模型快照持久化：deploy-snapshot.json 读写与文件哈希
// 目录解析/读写/存在性判断统一走共享 kit（src/storage/snapshotFileKit.js），消除领域间模板复制

import { createSnapshotFileKit, snapshotFileHash } from '../storage/snapshotFileKit.js';

const kit = createSnapshotFileKit({
  snapshotFile: 'deploy-snapshot.json',
  envVar: 'NICE_AOS_DEPLOY_SNAPSHOT_DIR',
  errCode: 'NO_DEPLOY_SNAPSHOT',
  missingHint: (dir) => `未找到部署快照。\n  快照目录: ${dir}\n  请先执行: nice-aos deploy scan --dir <path>\n  或指定: nice-aos --deploy-snapshot-dir <path>`,
});

export const setDeploySnapshotDir = kit.setDirOverride;
export const getDeploySnapshotPath = kit.getPath;
export const saveDeploySnapshot = kit.save;
export const loadDeploySnapshot = kit.load;
export const hasDeploySnapshot = kit.has;

export function fileHash(filePath) {
  return snapshotFileHash(filePath);
}
