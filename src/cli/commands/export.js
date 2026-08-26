// export / output 命令：导出本体快照为 Markdown / JSON / HTML 蓝图 / 视图模型 JSON
// 增量模式（--since <ref>）：git diff 解析 + 末尾追加"增量变更摘要"节
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { loadSnapshot } from '../../ontology/snapshot.js';
import { exportToMarkdown } from '../../ontology/exporter.js';
import { buildViewerModel, renderViewerHtml } from '../../ontology/viewer.js';
import { fail } from '../shared.js';
import { listThemeNames } from '../../themes/index.js';
import { listChangedFiles, listChangedFilesSince, filterObjectsByFiles, isValidRangeSpec } from '../../analyzers/gitDiff.js';
import { renderTemplate } from '../../ontology/template.js';

export const exportCommand = new Command('export')
  .description('导出本体快照为 Markdown / JSON / HTML 蓝图 / 视图模型 JSON（亦名 output：作为三大核心命令之一，对应用户视角的"产出报告"）')
  .option('--format <format>', '导出格式: markdown | json | html | viewmodel', 'markdown')
  .option('--output <path>', '写入文件（默认输出到 stdout）')
  .option('--theme <name>', `HTML 主题风格（默认 deep-blue，可选: ${listThemeNames().join(' / ')}）`, 'deep-blue')
  .option('--since <ref>', '增量导出：仅列出 ref 以来变更涉及的对象（git diff --name-only <ref>..HEAD；含未跟踪文件）；末尾追加"增量变更摘要"节。ref 语法：HEAD / HEAD~1 / abc..def / abc123')
  .option('--staged', '配合 --since：只列已暂存变更（git diff --staged）；用于"pre-commit 体检"')
  .option('--template <path>', '自定义 Markdown 模板：使用 {{Project.name}} / {{stats.Component}} / {{ObjectCounts.Module}} 等占位符；模板文件不存在时报错。详见 docs/plan/aos-three-core-roadmap.md 与 src/ontology/template.js 注释')
  .action((opts) => {
    const dataMap = loadSnapshot();
    let content;
    // --since 预处理：解析 git diff → 文件列表 + 按类型分组的涉及对象
    let sinceCtx = null;
    if (opts.since) {
      if (!isValidRangeSpec(opts.since)) {
        fail(`非法的 --since spec（仅允许字母数字 . ~ ^ _ - .. 空白）: ${opts.since}`);
      }
      // 增量需要 git 根；从 cwd 向上找
      const gitRoot = findGitRoot(process.cwd());
      if (!gitRoot) {
        fail(`--since 需要在 git 仓库内运行，但未找到 .git 目录（cwd=${process.cwd()}）`);
      }
      let changedFiles;
      try {
        changedFiles = opts.staged
          ? listChangedFiles(gitRoot, opts.since, { staged: true })
          : listChangedFilesSince(gitRoot, opts.since);
      } catch (err) {
        fail(`--since 解析失败: ${err.message}`);
      }
      sinceCtx = {
        spec: opts.since,
        staged: !!opts.staged,
        files: changedFiles,
        byType: filterObjectsByFiles(dataMap, changedFiles),
        gitRoot,
      };
    }
    if (opts.format === 'json') {
      content = JSON.stringify(dataMap, null, 2);
    } else if (opts.format === 'markdown') {
      if (opts.template) {
        // 自定义模板：读文件 → 渲染占位符
        if (!fs.existsSync(opts.template)) {
          fail(`--template 模板文件不存在: ${opts.template}`);
        }
        let tplStr;
        try {
          tplStr = fs.readFileSync(opts.template, 'utf-8');
        } catch (err) {
          fail(`--template 读取失败: ${err.message}`);
        }
        content = renderTemplate(tplStr, dataMap);
      } else {
        content = exportToMarkdown(dataMap, sinceCtx ? { since: sinceCtx } : undefined);
      }
    } else if (opts.format === 'html') {
      // 本体蓝图查看器：数据聚合 → 自包含 HTML（领域蓝图 / 业务数据图 / 业务逻辑流向）
      let theme = opts.theme;
      if (!listThemeNames().includes(theme)) {
        fail(`未知主题: ${theme}（可选: ${listThemeNames().join(' / ')}）`);
      }
      content = renderViewerHtml(buildViewerModel(dataMap), { theme });
    } else if (opts.format === 'viewmodel') {
      // 视图模型 JSON（供 agent / 其他前端直接消费的聚合数据）
      content = JSON.stringify(buildViewerModel(dataMap), null, 2);
    } else {
      fail(`未知格式: ${opts.format}（支持 markdown / json / html / viewmodel）`);
    }
    if (opts.output) {
      fs.writeFileSync(opts.output, content, 'utf-8');
      console.error(`已写入: ${opts.output}`);
      if (sinceCtx) {
        const objCount = Object.values(sinceCtx.byType).reduce((s, a) => s + a.length, 0);
        console.error(`  since=${sinceCtx.spec}${opts.staged ? ' (staged)' : ''} 涉及 ${sinceCtx.files.length} 文件 / ${objCount} 对象`);
      }
    } else {
      console.log(content);
    }
  });

// 从 cwd 向上找含 .git 的目录（最多 8 层）
function findGitRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
