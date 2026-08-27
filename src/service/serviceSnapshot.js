// 后端服务模型快照持久化：service-snapshot.json 读写
// 目录解析/读写/存在性判断统一走共享 kit（src/storage/snapshotFileKit.js），消除领域间模板复制

import path from 'node:path';
import { createSnapshotFileKit, snapshotFileHash } from '../storage/snapshotFileKit.js';

const SERVICE_MODULE_CONFIG_FILE = 'service-modules.json';

const kit = createSnapshotFileKit({
  snapshotFile: 'service-snapshot.json',
  envVar: 'NICE_AOS_SERVICE_SNAPSHOT_DIR',
  errCode: 'NO_SERVICE_SNAPSHOT',
  missingHint: (dir) => `未找到服务快照。\n  快照目录: ${dir}\n  请先执行: nice-aos service build --snapshot <path>\n  或指定: nice-aos --service-snapshot-dir <path>`,
});

export const setServiceSnapshotDir = kit.setDirOverride;
export const getServiceSnapshotDir = kit.getDir;
export const getServiceSnapshotPath = kit.getPath;
export const saveServiceSnapshot = kit.save;
export const loadServiceSnapshot = kit.load;
export const hasServiceSnapshot = kit.has;

// 模块配置文件路径（默认与服务快照同目录）：动态推导的模块规则落盘位置，构建时加载
export function getServiceModuleConfigPath() {
  return path.join(getServiceSnapshotDir(), SERVICE_MODULE_CONFIG_FILE);
}

export function fileHash(filePath) {
  return snapshotFileHash(filePath);
}
