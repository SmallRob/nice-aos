// 快照体检入口。deadcode / duplicates / io 收成子命令；顶层同名命令仍可用（帮助里隐藏）。

import { Command } from 'commander';
import { createDeadcodeCommand } from './deadcode.js';
import { createDuplicatesCommand } from './duplicates.js';
import { createIoCommand } from './io.js';

export const checkCommand = new Command('check')
  .description('快照体检：deadcode 不可达导出 / duplicates 结构重复 / io 敏感 API。顶层同名命令仍可用')
  .addCommand(createDeadcodeCommand())
  .addCommand(createDuplicatesCommand())
  .addCommand(createIoCommand());
