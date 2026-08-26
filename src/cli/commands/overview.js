// nice-aos overview 子命令：多项目 code-ontology 聚合 → 全景架构快照 → HTML 蓝图
// 借鉴 db / deploy / service 子命令结构，扩展支持多 snapshot 目录聚合 + 5 层架构推断 + 人类知识融入
//
// 使用流程：
//   1. nice-aos --snapshot-dir <root> action refreshRepo  （单项目扫描）
//      重复对每个项目跑 → 每个项目目录产出 snapshot.json
//   2. nice-aos overview scan \
//        --projects-dir <multi-project-root> \      # 含多个项目子目录
//        --layout-file <layout.json> \               # 5 层架构 + 角色 hint（可选）
//        --human-knowledge <hk.json>                # 人类架构知识（可选）
//   3. nice-aos overview export --format html --output overview.html
//   4. nice-aos overview query <type> [--where k=v]
//   5. nice-aos overview summary                    # 关键指标文本输出

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import {
  setOverviewSnapshotDir, saveOverviewSnapshot, loadOverviewSnapshot, hasOverviewSnapshot,
  getOverviewSnapshotPath, getOverviewSnapshotDir,
} from '../../overview/overviewSnapshot.js';
import { scanOverview } from '../../overview/overviewScanner.js';
import { buildOverviewViewerModel, renderOverviewHtml } from '../../overview/overviewViewer.js';
import { parseWhere, matchesWhere, outputJson, outputPretty, succeed, fail } from '../shared.js';

export const overviewCommand = new Command('overview')
  .description('全景架构：多项目 code-ontology 快照聚合 + 5 层架构图 + 跨项目依赖矩阵 + 人类架构知识（设计意图 / 资源需求）');

overviewCommand
  .command('scan')
  .description('扫描多项目根目录，聚合各项目 snapshot.json + Java 解析 + 布局声明 + 人类架构知识 → 全景架构快照')
  .requiredOption('--projects-dir <path>', '多项目根目录（每个项目一个子目录，含 snapshot.json）')
  .option('--layout-file <path>', '布局声明 JSON（5 层架构 + 角色 hint）', null)
  .option('--human-knowledge <path>', '人类架构知识 JSON（设计意图 / 资源需求）', null)
  .option('--out-dir <path>', '快照输出目录（默认与 --overview-snapshot-dir 同）', null)
  .action(async (opts) => {
    const projectsRoot = path.resolve(opts.projectsDir);
    if (!fs.existsSync(projectsRoot)) {
      fail(`项目根不存在: ${projectsRoot}`);
    }
    if (!fs.statSync(projectsRoot).isDirectory()) {
      fail(`项目根不是目录: ${projectsRoot}`);
    }

    if (opts.outDir) {
      setOverviewSnapshotDir(path.resolve(opts.outDir));
    }

    // 拿 nice-aos 版本
    let niceAosVersion = '0.31.0';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'package.json'), 'utf-8'));
      niceAosVersion = pkg.version || niceAosVersion;
    } catch { /* fallback */ }

    const model = await scanOverview({
      projectsRoot,
      layoutFile: opts.layoutFile ? path.resolve(opts.layoutFile) : null,
      humanKnowledgeFile: opts.humanKnowledge ? path.resolve(opts.humanKnowledge) : null,
      niceAosVersion,
    });

    const snapshotPath = saveOverviewSnapshot(model);
    const t = model.totals || {};
    succeed({
      ok: true,
      message: `已聚合 ${t.projects} 个项目（含 ${t.javaServices} 个 Java 微服务），共 ${(t.grandTotalLines || 0).toLocaleString()} 行代码 / ${(t.grandTotalFiles || 0).toLocaleString()} 个文件`,
      snapshot: snapshotPath,
      stats: t,
    });
  });

overviewCommand
  .command('export')
  .description('导出全景架构分析（json | html | viewmodel）')
  .option('--format <format>', '导出格式: json | html | viewmodel', 'json')
  .option('--output <path>', '写入文件（默认输出到 stdout）')
  .action((opts) => {
    const model = loadOverviewSnapshot();
    let content;
    if (opts.format === 'json') {
      content = JSON.stringify(model, null, 2);
    } else if (opts.format === 'html') {
      content = renderOverviewHtml(buildOverviewViewerModel(model));
    } else if (opts.format === 'viewmodel') {
      content = JSON.stringify(buildOverviewViewerModel(model), null, 2);
    } else {
      fail(`未知格式: ${opts.format}（支持 json / html / viewmodel）`);
    }
    if (opts.output) {
      fs.writeFileSync(opts.output, content, 'utf-8');
      console.error(`已写入: ${opts.output}`);
    } else {
      console.log(content);
    }
  });

overviewCommand
  .command('query')
  .description('查询概览快照（projects | services | languages | crossDeps | composeRelations | nginxRelations | ports | intent | resources）')
  .argument('<type>', '对象类型')
  .option('--where <conditions>', '过滤条件 (k=v 精确, k~v 模糊)')
  .option('--pretty', '人类可读表格输出')
  .action((type, opts) => {
    const model = loadOverviewSnapshot();
    let objects;
    switch (type) {
      case 'projects':
        objects = model.projects || [];
        break;
      case 'services':
        objects = model.applicationServices || [];
        break;
      case 'languages':
        objects = Object.entries(model.languages || {}).map(([ext, info]) => ({ ext, ...info }));
        break;
      case 'crossDeps':
        objects = Object.entries(model.architecture?.crossMatrix || {}).map(([from, deps]) => ({
          from, to: deps.join(', '), count: deps.length,
        }));
        break;
      case 'composeRelations':
        objects = model.architecture?.composeRelations || [];
        break;
      case 'nginxRelations':
        objects = model.architecture?.nginxRelations || [];
        break;
      case 'ports':
        objects = model.architecture?.portAllocations || [];
        break;
      case 'intent':
        objects = model.humanKnowledge?.intent || [];
        break;
      case 'resources':
        objects = model.humanKnowledge?.resources || [];
        break;
      default:
        fail(`未知类型: ${type}（支持 projects / services / languages / crossDeps / composeRelations / nginxRelations / ports / intent / resources）`);
    }
    const conditions = parseWhere(opts.where);
    const result = conditions ? objects.filter((o) => matchesWhere(o, conditions)) : objects;
    if (opts.pretty) {
      outputPretty(result);
    } else {
      outputJson(result);
    }
  });

overviewCommand
  .command('summary')
  .description('打印关键指标汇总（文本）')
  .action(() => {
    const model = loadOverviewSnapshot();
    const t = model.totals || {};
    const m = model._meta || {};
    console.log('════════════════════════════════════════════════════');
    console.log('  全景架构概览');
    console.log('════════════════════════════════════════════════════');
    console.log(`  生成时间        ${m.generatedAt || '—'}`);
    console.log(`  扫描工具        nice-aos v${m.scannerVersion || '0.31.0'}`);
    console.log(`  项目根          ${m.projectsRoot || '—'}`);
    console.log(`  项目总数        ${t.projects}`);
    console.log(`  有源码项目      ${t.withSource}`);
    console.log(`  Java 微服务     ${t.javaServices}`);
    console.log(`  Java 文件 / 行  ${t.javaFiles?.toLocaleString() || 0} / ${t.javaLines?.toLocaleString() || 0}`);
    console.log(`  总源文件 / 行   ${t.grandTotalFiles?.toLocaleString() || 0} / ${t.grandTotalLines?.toLocaleString() || 0}`);
    console.log(`  架构分层        ${t.layers} 层`);
    console.log(`  跨项目依赖      ${t.crossProjectDeps || 0} 条`);
    console.log(`  API 控制器      ${t.apiControllers || 0} 个 @RestController`);
    console.log(`  业务服务        ${t.businessServices || 0} 个 @Service/@Component`);
    if (model.humanKnowledge?.intent?.length) {
      console.log(`  设计意图        ${model.humanKnowledge.intent.length} 条（来自人类架构知识）`);
    }
    if (model.humanKnowledge?.resources?.length) {
      console.log(`  资源需求        ${model.humanKnowledge.resources.length} 条`);
    }
    console.log('════════════════════════════════════════════════════');
  });
