import fs from 'node:fs';
import { Command } from 'commander';
import { loadSnapshot } from '../../ontology/snapshot.js';
import { exportToMarkdown } from '../../ontology/exporter.js';
import { buildViewerModel, renderViewerHtml } from '../../ontology/viewer.js';
import { fail } from '../shared.js';

export const exportCommand = new Command('export')
  .description('导出本体快照为 Markdown / JSON / HTML 蓝图 / 视图模型 JSON')
  .option('--format <format>', '导出格式: markdown | json | html | viewmodel', 'markdown')
  .option('--output <path>', '写入文件（默认输出到 stdout）')
  .action((opts) => {
    const dataMap = loadSnapshot();
    let content;
    if (opts.format === 'json') {
      content = JSON.stringify(dataMap, null, 2);
    } else if (opts.format === 'markdown') {
      content = exportToMarkdown(dataMap);
    } else if (opts.format === 'html') {
      // 本体蓝图查看器：数据聚合 → 自包含 HTML（领域蓝图 / 业务数据图 / 业务逻辑流向）
      content = renderViewerHtml(buildViewerModel(dataMap));
    } else if (opts.format === 'viewmodel') {
      // 视图模型 JSON（供 agent / 其他前端直接消费的聚合数据）
      content = JSON.stringify(buildViewerModel(dataMap), null, 2);
    } else {
      fail(`未知格式: ${opts.format}（支持 markdown / json / html / viewmodel）`);
    }
    if (opts.output) {
      fs.writeFileSync(opts.output, content, 'utf-8');
      console.error(`已写入: ${opts.output}`);
    } else {
      console.log(content);
    }
  });
