import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { loadPlanningSnapshot, savePlanningSnapshot } from '../../planning/docsSnapshot.js';
import { scanPlanningModel } from '../../planning/docsScanner.js';
import { buildPlanningViewerModel, renderPlanningBlueprintHtml } from '../../planning/docsViewer.js';
import { auditHealth } from '../../planning/docsAuditor.js';
import { parseWhere, matchesWhere, outputJson, outputPretty, succeed, fail } from '../shared.js';
import { listThemeNames } from '../../themes/index.js';

const QUERY_TYPES = 'features | modules | releases | milestones | themes | dependencies | distribution | stats';

export const planningCommand = new Command('planning')
  .description('产品规划 / PRD 文档蓝图：扫描项目规划管理库（特性 PRD / 模块 / 迭代发布 / Roadmap 文档）→ 规划模型 → 分析 JSON / 自包含蓝图 planning-overview HTML（总览/特性/模块/图谱/迭代发布/战略/审计，内嵌 planning-viewer-data 供油猴问答）');

// ---------- build ----------
planningCommand
  .command('build')
  .description('扫描产品规划 / PRD 文档目录，构建规划模型快照 planning-snapshot.json')
  .requiredOption('--docs <path>', '规划/PRD 文档目录（含 planning/ 与 Feat/ 等）')
  .action((opts) => {
    const docsDir = path.resolve(opts.docs);
    if (!fs.existsSync(docsDir)) fail(`路径不存在: ${docsDir}`);
    if (!fs.statSync(docsDir).isDirectory()) fail(`路径不是目录: ${docsDir}`);
    const model = scanPlanningModel(docsDir);
    const snapshotPath = savePlanningSnapshot(model);
    const meta = model._meta;
    succeed({
      ok: true,
      message: `已分析 ${meta.fileCount} 个文档，${meta.featureCount} 个特性，${meta.moduleCount} 个模块，${meta.dependencyCount} 条依赖，${meta.releaseCount} 个发布，${meta.milestoneCount} 个里程碑，${meta.themeCount} 个战略主题`,
      snapshot: snapshotPath,
      stats: {
        files: meta.fileCount,
        features: meta.featureCount,
        modules: meta.moduleCount,
        dependencies: meta.dependencyCount,
        releases: meta.releaseCount,
        milestones: meta.milestoneCount,
        themes: meta.themeCount,
      },
      durationMs: meta.durationMs,
    });
  });

// ---------- export ----------
planningCommand
  .command('export')
  .description('导出规划蓝图（json | viewmodel | markdown | html；--docs 一步构建，否则读快照）')
  .option('--docs <path>', '规划/PRD 文档目录（指定则跳过 build 直接构建）')
  .option('--snapshot <path>', '直接指定规划快照 JSON 路径')
  .option('--format <format>', '导出格式: json | viewmodel | markdown | html', 'json')
  .option('--output <path>', '写入文件（默认输出到 stdout）')
  .option('--theme <name>', `HTML 主题风格（默认 deep-blue，可选: ${listThemeNames().join(' / ')}）`, 'deep-blue')
  .action((opts) => {
    let model;
    if (opts.snapshot) {
      const p = path.resolve(opts.snapshot);
      if (!fs.existsSync(p)) fail(`快照不存在: ${p}`);
      model = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } else if (opts.docs) {
      const docsDir = path.resolve(opts.docs);
      if (!fs.existsSync(docsDir)) fail(`路径不存在: ${docsDir}`);
      if (!fs.statSync(docsDir).isDirectory()) fail(`路径不是目录: ${docsDir}`);
      model = scanPlanningModel(docsDir);
    } else {
      model = loadPlanningSnapshot();
    }

    let content;
    if (opts.format === 'json') {
      content = JSON.stringify(model, null, 2);
    } else if (opts.format === 'viewmodel') {
      content = JSON.stringify(buildPlanningViewerModel(model), null, 2);
    } else if (opts.format === 'html') {
      let theme = opts.theme;
      if (!listThemeNames().includes(theme)) fail(`未知主题: ${theme}（可选: ${listThemeNames().join(' / ')}）`);
      content = renderPlanningBlueprintHtml(buildPlanningViewerModel(model), { theme });
    } else if (opts.format === 'markdown') {
      content = renderPlanningMarkdown(model);
    } else {
      fail(`未知格式: ${opts.format}（支持 json / viewmodel / markdown / html）`);
    }
    if (opts.output) {
      fs.writeFileSync(opts.output, content, 'utf-8');
      console.error(`已写入: ${opts.output}`);
    } else {
      console.log(content);
    }
  });

// ---------- query ----------
planningCommand
  .command('query')
  .description(`查询规划模型（${QUERY_TYPES}）`)
  .argument('<type>', '对象类型')
  .option('--where <conditions>', '过滤条件 (k=v 精确, k~v 模糊)')
  .option('--all', '返回全部（默认仅前 50 条）')
  .option('--limit <n>', '限制返回条数')
  .option('--pretty', '人类可读表格输出')
  .action((type, opts) => {
    const model = loadPlanningSnapshot();
    let objects;
    if (type === 'stats' || type === 'distribution') {
      outputJson(model[type]);
      return;
    }
    const prod = (items, map) => (items || []).map(map);
    switch (type) {
      case 'features': objects = model.features; break;
      case 'modules': objects = prod(model.modules, (m) => ({ key: m.key, label: m.label, description: m.description, featureCount: (m.featureIds || []).length })); break;
      case 'releases': objects = model.releases; break;
      case 'milestones': objects = model.milestones; break;
      case 'themes': objects = prod(model.themes, (t) => ({ id: t.id, title: t.title, summary: t.summary, kind: t.kind })); break;
      case 'dependencies': objects = model.dependencies; break;
      default:
        fail(`未知类型: ${type}（支持 ${QUERY_TYPES}）`);
    }
    const conditions = parseWhere(opts.where);
    let result = conditions ? objects.filter((o) => matchesWhere(o, conditions)) : objects;
    const total = result.length;
    if (!opts.all) {
      const limit = opts.limit ? parseInt(opts.limit, 10) : 50;
      result = result.slice(0, limit);
    }
    if (opts.pretty) outputPretty(result);
    else outputJson(result);
    if (total > result.length) console.error(`# 共 ${total} 条，当前返回 ${result.length} 条（--all 查看全部）`);
  });

// ---------- audit ----------
const auditCommand = new Command('audit')
  .description('产品规划健康审计（coverage / statusHealth / dependencyRisk / releasePlanning）');

auditCommand
  .command('health')
  .description('综合健康评分（聚合覆盖完整性 / 状态健康 / 依赖风险 / 版本规划四维）')
  .action(() => {
    const model = loadPlanningSnapshot();
    outputJson(auditHealth(model));
  });

auditCommand
  .command('all')
  .description('运行全部 4 个审计维度，输出汇总结果')
  .action(() => {
    const model = loadPlanningSnapshot();
    outputJson(auditHealth(model));
  });

planningCommand.addCommand(auditCommand);

// markdown 摘要导出
function renderPlanningMarkdown(model) {
  const meta = model._meta || {};
  const dist = model.distribution || {};
  const lines = [];
  lines.push(`# ${meta.name || '产品规划'} 摘要`);
  lines.push('');
  lines.push(`> 来源 ${meta.sourceDir || ''} ｜ 扫描 ${meta.scannedAt || ''} ｜ ${meta.fileCount || 0} 个文档`);
  lines.push('');
  lines.push('## 统计');
  lines.push('');
  lines.push(`- 特性: **${(model.features || []).length}**`);
  lines.push(`- 模块: **${(model.modules || []).length}**`);
  lines.push(`- 依赖边: **${(model.dependencies || []).length}**`);
  lines.push(`- 发布: **${(model.releases || []).length}** ／ 里程碑: **${(model.milestones || []).length}** ／ 战略主题: **${(model.themes || []).length}**`);
  lines.push('');
  lines.push('## 状态分布');
  lines.push('');
  for (const [k, v] of Object.entries(dist.status || {})) lines.push(`- ${k}: ${v}`);
  lines.push('');
  lines.push('## 特性清单');
  lines.push('');
  lines.push('| ID | 特性 | 优先级 | 版本 | 负责人 | 状态 | 描述 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const f of model.features || []) {
    lines.push(`| ${f.id} | ${String(f.title).replace(/\|/g, '\\|')} | ${f.priority} | ${f.targetVersion} | ${f.owner} | ${f.statusEmoji} ${f.status} | ${String(f.description).replace(/\|/g, '\\|').slice(0, 120)} |`);
  }
  return lines.join('\n');
}