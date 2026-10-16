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
import { setOverviewSnapshotDir } from '../overview/overviewSnapshot.js';
import { setStorageMode, setSqlitePath, setBlueprint, closeDb } from '../storage/index.js';
import { OBJECT_TYPES, LINK_TYPES } from '../ontology/blueprint.js';
import { queryCommand } from './commands/query.js';
import { countCommand } from './commands/count.js';
import { linkCommand } from './commands/link.js';
import { actionCommand } from './commands/action.js';
import { exportCommand } from './commands/export.js';
import { serveCommand } from './commands/serve.js';
import { mcpCommand } from './commands/mcp.js';
import { checkCommand } from './commands/check.js';
import { duplicatesCommand } from './commands/duplicates.js';
import { deadcodeCommand } from './commands/deadcode.js';
import { ioCommand } from './commands/io.js';
import { updateCommand } from './commands/update.js';
import { dbCommand } from './commands/db.js';
import { deployCommand } from './commands/deploy.js';
import { serviceCommand } from './commands/service.js';
import { planningCommand } from './commands/planning.js';
import { overviewCommand } from './commands/overview.js';
import { askCommand } from './commands/ask.js';
import { storageCommand } from '../storage/storageCommand.js';

// 蓝图注入到 storage 模块（避免 sqliteSnapshot.js 顶层 import blueprint.js 造成循环）
setBlueprint({ OBJECT_TYPES, LINK_TYPES });

// 版本号取自 package.json，避免与发布版本脱节
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf-8')).version ?? '0.0.0';

const program = new Command();
program
  .name('nice-aos')
  .description('把代码仓库扫成可查询的本体快照。核心：ask / output / serve；体检：check')
  .version(VERSION)
  // 三大核心命令提示（顶层 --help 顶部显示，让 ask / output / serve 显眼）
  .addHelpText('beforeAll', () => {
    return [
      '★ 三大核心命令（输入 / 输出 / 服务）',
      '  ask       基于本体快照向 AI 提问（默认：nice-aos ask "问题"）',
      '  output    导出报告与蓝图（output = export 别名）',
      '  serve     启动本地 HTTP 数据源（快照、蓝图、/api/*）',
      '  check     快照体检：deadcode / duplicates / io',
      '',
      '对象类型与链接以 get_schema 为准。详细说明见 docs/guide.md。',
      '',
    ].join('\n');
  })
  .option('--snapshot-dir <path>', '快照目录（默认 ./.nice-aos/data 或环境变量 NICE_AOS_SNAPSHOT_DIR）')
  .option('--db-snapshot-dir <path>', '数据库快照目录（默认与代码快照同目录，文件名 db-snapshot.json）')
  .option('--deploy-snapshot-dir <path>', '部署快照目录（默认与代码快照同目录，文件名 deploy-snapshot.json）')
  .option('--service-snapshot-dir <path>', '后端服务快照目录（默认与代码快照同目录，文件名 service-snapshot.json）')
  .option('--planning-snapshot-dir <path>', '产品规划快照目录（默认与代码快照同目录，文件名 planning-snapshot.json）')
  .option('--overview-snapshot-dir <path>', '全景架构快照目录（默认与代码快照同目录，文件名 overview-snapshot.json）')
  .option('--sqlite <mode>', 'SQLite 存储模式: auto | on | off（默认 auto，better-sqlite3 不可用时自动降级到 JSON）')
  .option('--sqlite-path <path>', 'SQLite 文件路径（默认 <snapshot-dir>/aos.sqlite）')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    const dir = opts.snapshotDir;
    if (dir) setSnapshotDir(dir);
    const dbDir = opts.dbSnapshotDir;
    if (dbDir) setDbSnapshotDir(dbDir);
    const deployDir = opts.deploySnapshotDir;
    if (deployDir) setDeploySnapshotDir(deployDir);
    const serviceDir = opts.serviceSnapshotDir;
    if (serviceDir) setServiceSnapshotDir(serviceDir);
    const planningDir = opts.planningSnapshotDir;
    if (planningDir) setPlanningSnapshotDir(planningDir);
    const overviewDir = opts.overviewSnapshotDir;
    if (overviewDir) setOverviewSnapshotDir(overviewDir);
    if (opts.sqlite) setStorageMode(opts.sqlite);
    if (opts.sqlitePath) setSqlitePath(opts.sqlitePath);
  });

program.addCommand(queryCommand);
program.addCommand(countCommand); // ADR 0012 D2：按类型计数（单行 JSON，agent 聚合用）
program.addCommand(linkCommand);
program.addCommand(actionCommand);
program.addCommand(exportCommand);
exportCommand.alias('output'); // 三大核心命令：output 是 export 的顶层别名（用户视角"产出报告"）
program.addCommand(serveCommand);
program.addCommand(mcpCommand);
program.addCommand(checkCommand);
program.addCommand(duplicatesCommand, { hidden: true });
program.addCommand(deadcodeCommand, { hidden: true });
program.addCommand(ioCommand, { hidden: true });
program.addCommand(updateCommand);
program.addCommand(dbCommand);
program.addCommand(deployCommand);
program.addCommand(serviceCommand);
program.addCommand(planningCommand);
program.addCommand(overviewCommand);
program.addCommand(askCommand);
program.addCommand(storageCommand);

program.parseAsync()
  .catch((err) => {
    if (err.code === 'NO_SNAPSHOT' || err.code === 'NO_DB_SNAPSHOT' || err.code === 'NO_DEPLOY_SNAPSHOT' || err.code === 'NO_SERVICE_SNAPSHOT' || err.code === 'NO_PLANNING_SNAPSHOT') {
      console.error(`\n⚠️  ${err.message}\n`);
    } else {
      console.error(`\n❌ ${err.message ?? err}\n`);
    }
    closeDb(); // process.exit 会跳过 finally，这里显式关闭
    process.exit(1);
  })
  .finally(() => {
    // CLI 退出前关闭 SQLite（清理 WAL/SHM 与 lock 文件；serve 长驻进程不受影响，parseAsync 不返回）
    closeDb();
  });
