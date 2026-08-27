// 数据库模型快照持久化：db-snapshot.json 读写与文件哈希
// 目录解析/读写/存在性判断统一走共享 kit（src/storage/snapshotFileKit.js），消除领域间模板复制

import { createSnapshotFileKit, snapshotFileHash } from '../storage/snapshotFileKit.js';

const kit = createSnapshotFileKit({
  snapshotFile: 'db-snapshot.json',
  envVar: 'NICE_AOS_DB_SNAPSHOT_DIR',
  errCode: 'NO_DB_SNAPSHOT',
  missingHint: (dir) => `未找到数据库快照。\n  快照目录: ${dir}\n  请先执行: nice-aos db scan --dir <path>\n  或指定: nice-aos --db-snapshot-dir <path>`,
});

export const setDbSnapshotDir = kit.setDirOverride;
export const getDbSnapshotDir = kit.getDir;
export const getDbSnapshotPath = kit.getPath;
export const saveDbSnapshot = kit.save;
export const loadDbSnapshot = kit.load;
export const hasDbSnapshot = kit.has;

export function fileHash(filePath) {
  return snapshotFileHash(filePath);
}
