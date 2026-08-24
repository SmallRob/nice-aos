#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { setSnapshotDir } from '../ontology/snapshot.js';
import { setDbSnapshotDir } from '../database/dbSnapshot.js';
import { setDeploySnapshotDir } from '../deployment/deploySnapshot.js';
import { setServiceSnapshotDir } from '../service/serviceSnapshot.js';
import { setPlanningSnapshotDir } from '../planning/docsSnapshot.js';
import { queryCommand } from './commands/query.js';
import { linkCommand } from './commands/link.js';
import { actionCommand } from './commands/action.js';
import { exportCommand } from './commands/export.js';
import { serveCommand } from './commands/serve.js';
import { updateCommand } from './commands/update.js';
import { dbCommand } from './commands/db.js';
import { deployCommand } from './commands/deploy.js';
import { serviceCommand } from './commands/service.js';
import { planningCommand } from './commands/planning.js';

// 版本号取自 package.json，避免与发布版本脱节
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf-8')).version ?? '0.0.0';

const program = new Command();
program
  .name('nice-aos')
  .description('nice-aos —— 通用前端代码本体分析 CLI：扫描 React/TypeScript、Vue 3 SFC 与油猴脚本（Tampermonkey UserScript）生成结构化本体快照（模块/文件/组件/Hook/Store/Service/路由/依赖 + import/render/导航关系图谱；油猴脚本含 GM API/DOM 注入/网络端点/函数调用图），供 AI agent 与开发者毫秒级查询')
  .version(VERSION)
  .option('--snapshot-dir <path>', '快照目录（默认 ./.nice-aos/data 或环境变量 NICE_AOS_SNAPSHOT_DIR）')
  .option('--db-snapshot-dir <path>', '数据库快照目录（默认与代码快照同目录，文件名 db-snapshot.json）')
  .option('--deploy-snapshot-dir <path>', '部署快照目录（默认与代码快照同目录，文件名 deploy-snapshot.json）')
  .option('--service-snapshot-dir <path>', '后端服务快照目录（默认与代码快照同目录，文件名 service-snapshot.json）')
  .option('--planning-snapshot-dir <path>', '产品规划快照目录（默认与代码快照同目录，文件名 planning-snapshot.json）')
  .hook('preAction', (thisCommand) => {
    const dir = thisCommand.opts().snapshotDir;
    if (dir) setSnapshotDir(dir);
    const dbDir = thisCommand.opts().dbSnapshotDir;
    if (dbDir) setDbSnapshotDir(dbDir);
    const deployDir = thisCommand.opts().deploySnapshotDir;
    if (deployDir) setDeploySnapshotDir(deployDir);
    const serviceDir = thisCommand.opts().serviceSnapshotDir;
    if (serviceDir) setServiceSnapshotDir(serviceDir);
    const planningDir = thisCommand.opts().planningSnapshotDir;
    if (planningDir) setPlanningSnapshotDir(planningDir);
  });

program.addCommand(queryCommand);
program.addCommand(linkCommand);
program.addCommand(actionCommand);
program.addCommand(exportCommand);
program.addCommand(serveCommand);
program.addCommand(updateCommand);
program.addCommand(dbCommand);
program.addCommand(deployCommand);
program.addCommand(serviceCommand);
program.addCommand(planningCommand);

program.parseAsync().catch((err) => {
  if (err.code === 'NO_SNAPSHOT' || err.code === 'NO_DB_SNAPSHOT' || err.code === 'NO_DEPLOY_SNAPSHOT' || err.code === 'NO_SERVICE_SNAPSHOT' || err.code === 'NO_PLANNING_SNAPSHOT') {
    console.error(`\n⚠️  ${err.message}\n`);
  } else {
    console.error(`\n❌ ${err.message ?? err}\n`);
  }
  process.exit(1);
});
