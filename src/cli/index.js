#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { setSnapshotDir } from '../ontology/snapshot.js';
import { queryCommand } from './commands/query.js';
import { linkCommand } from './commands/link.js';
import { actionCommand } from './commands/action.js';
import { exportCommand } from './commands/export.js';

// 版本号取自 package.json，避免与发布版本脱节
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf-8')).version ?? '0.0.0';

const program = new Command();
program
  .name('nice-aos')
  .description('nice-aos —— 通用 React 前端代码本体分析 CLI：扫描 React/TypeScript 源码生成结构化本体快照（模块/文件/组件/Hook/Store/Service/路由/依赖 + import/render/导航关系图谱），供 AI agent 与开发者毫秒级查询')
  .version(VERSION)
  .option('--snapshot-dir <path>', '快照目录（默认 ./.nice-aos/data 或环境变量 NICE_AOS_SNAPSHOT_DIR）')
  .hook('preAction', (thisCommand) => {
    const dir = thisCommand.opts().snapshotDir;
    if (dir) setSnapshotDir(dir);
  });

program.addCommand(queryCommand);
program.addCommand(linkCommand);
program.addCommand(actionCommand);
program.addCommand(exportCommand);

program.parseAsync().catch((err) => {
  if (err.code === 'NO_SNAPSHOT') {
    console.error(`\n⚠️  ${err.message}\n`);
  } else {
    console.error(`\n❌ ${err.message ?? err}\n`);
  }
  process.exit(1);
});
