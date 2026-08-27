// 产品规划模型快照持久化：planning-snapshot.json 读写
// 目录解析/读写/存在性判断统一走共享 kit（src/storage/snapshotFileKit.js），消除领域间模板复制

import { createSnapshotFileKit } from '../storage/snapshotFileKit.js';

const kit = createSnapshotFileKit({
  snapshotFile: 'planning-snapshot.json',
  envVar: 'NICE_AOS_PLANNING_SNAPSHOT_DIR',
  errCode: 'NO_PLANNING_SNAPSHOT',
  missingHint: (dir) => `未找到产品规划快照。\n  快照目录: ${dir}\n  请先执行: nice-aos planning build --docs <目录>\n  或指定: nice-aos --planning-snapshot-dir <path>`,
});

export const setPlanningSnapshotDir = kit.setDirOverride;
export const getPlanningSnapshotDir = kit.getDir;
export const getPlanningSnapshotPath = kit.getPath;
export const savePlanningSnapshot = kit.save;
export const loadPlanningSnapshot = kit.load;
export const hasPlanningSnapshot = kit.has;
