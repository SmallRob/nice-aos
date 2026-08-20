import fs from 'node:fs';
import { Command } from 'commander';
import { loadSnapshot } from '../../ontology/snapshot.js';
import { exportToMarkdown } from '../../ontology/exporter.js';
import { fail } from '../shared.js';

export const exportCommand = new Command('export')
  .description('导出本体快照为 Markdown / JSON')
  .option('--format <format>', '导出格式: markdown | json', 'markdown')
  .option('--output <path>', '写入文件（默认输出到 stdout）')
  .action((opts) => {
    const dataMap = loadSnapshot();
    let content;
    if (opts.format === 'json') {
      content = JSON.stringify(dataMap, null, 2);
    } else if (opts.format === 'markdown') {
      content = exportToMarkdown(dataMap);
    } else {
      fail(`未知格式: ${opts.format}（支持 markdown / json）`);
    }
    if (opts.output) {
      fs.writeFileSync(opts.output, content, 'utf-8');
      console.error(`已写入: ${opts.output}`);
    } else {
      console.log(content);
    }
  });
