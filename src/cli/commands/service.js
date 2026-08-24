import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { buildServiceModelFromFile } from '../../service/serviceBuilder.js';
import { loadServiceSnapshot, saveServiceSnapshot } from '../../service/serviceSnapshot.js';
import { buildServiceViewerModel, renderServiceBlueprintHtml } from '../../service/serviceViewer.js';
import { auditHealth, runAllServiceAudits } from '../../service/serviceAuditor.js';
import { parseModulePrefixJson } from '../../service/serviceModel.js';
import { parseWhere, matchesWhere, outputJson, outputPretty, succeed, fail } from '../shared.js';
import { listThemeNames } from '../../themes/index.js';

// 模块规则解析参数（--module-prefix 显式规则 / --module-config 配置文件，均作用于 --snapshot 路径）
function moduleOpts(opts) {
  const o = {};
  if (opts.modulePrefix) o.modulePrefixes = parseModulePrefixJson(opts.modulePrefix);
  if (opts.moduleConfig) o.moduleConfigPath = path.resolve(opts.moduleConfig);
  return o;
}

// --snapshot 存在时直接从 asdm-aos 快照构建（不落盘 service-snapshot.json）；否则读取已构建的服务快照
function resolveServiceModel(opts) {
  if (opts.snapshot) {
    return buildServiceModelFromFile(path.resolve(opts.snapshot), moduleOpts(opts));
  }
  return loadServiceSnapshot();
}

export const serviceCommand = new Command('service')
  .description('Java 后端服务蓝图：基于 asdm-aos 本体快照（snapshot.json）构建后端服务模型 → 分析 JSON / 服务蓝图 HTML（模块/分层/API/数据层/依赖/质量/健康度）');

// ---------- build ----------
serviceCommand
  .command('build')
  .description('从 asdm-aos Java 后端本体快照构建服务模型，保存 service-snapshot.json')
  .requiredOption('--snapshot <path>', 'asdm-aos 本体快照路径（snapshot.json）')
  .option('--module-prefix <json>', '自定义模块规则 JSON: {"core":{"label":"核心","prefixes":["ai.asdm.admin.core"]}}')
  .option('--module-config <path>', '模块配置文件路径（默认与 service-snapshot.json 同目录 service-modules.json）；存在则加载，否则动态推导并写入')
  .action((opts) => {
    const snapshotPath = path.resolve(opts.snapshot);
    if (!fs.existsSync(snapshotPath)) fail(`asdm-aos 快照不存在: ${snapshotPath}`);
    const model = buildServiceModelFromFile(snapshotPath, moduleOpts(opts));
    if (model._meta.moduleConfigWarning) console.error(`⚠️  ${model._meta.moduleConfigWarning}`);
    const snapshotFile = saveServiceSnapshot(model);
    const s = model.stats;
    succeed({
      ok: true,
      message: `已从 ${snapshotPath} 构建后端服务模型：${s.fileCount} 个文件，${s.packageCount} 个包，${s.classCount + s.enumCount} 个类（含 ${s.enumCount} 枚举），${s.interfaceCount} 个接口，${s.methodCount} 个方法，${s.endpointCount} 个 API 端点，${s.tableCount} 张表，${s.dependencyCount} 项依赖`,
      snapshot: snapshotFile,
      moduleConfig: model._meta.moduleConfigFile || null,
      stats: {
        files: s.fileCount,
        packages: s.packageCount,
        classes: s.classCount,
        enums: s.enumCount,
        interfaces: s.interfaceCount,
        methods: s.methodCount,
        endpoints: s.endpointCount,
        tables: s.tableCount,
        dependencies: s.dependencyCount,
        modules: s.moduleCount,
        layers: s.layerCount,
        tests: s.testMethodCount,
        analysisErrors: s.analysisErrorCount,
      },
      modulePrefixSource: model._meta.modulePrefixSource,
      durationMs: model._meta.durationMs,
    });
  });

// ---------- export ----------
serviceCommand
  .command('export')
  .description('导出后端服务分析结果（json | html | viewmodel；--snapshot 直接指定 asdm-aos 快照路径生成蓝图）')
  .option('--format <format>', '导出格式: json | html | viewmodel', 'json')
  .option('--output <path>', '写入文件（默认输出到 stdout）')
  .option('--theme <name>', `HTML 主题风格（默认 elegant-purple，可选: ${listThemeNames().join(' / ')}）`, 'elegant-purple')
  .option('--snapshot <path>', 'asdm-aos 本体快照路径（snapshot.json），构建后直接出图，不保存 service-snapshot.json')
  .option('--module-prefix <json>', '自定义模块规则 JSON（与 --snapshot 配合使用）')
  .option('--module-config <path>', '模块配置文件路径（与 --snapshot 配合使用）')
  .action((opts) => {
    const model = resolveServiceModel(opts);
    let content;
    if (opts.format === 'json') {
      content = JSON.stringify(model, null, 2);
    } else if (opts.format === 'html') {
      let theme = opts.theme;
      if (!listThemeNames().includes(theme)) {
        fail(`未知主题: ${theme}（可选: ${listThemeNames().join(' / ')}）`);
      }
      content = renderServiceBlueprintHtml(buildServiceViewerModel(model), { theme });
    } else if (opts.format === 'viewmodel') {
      content = JSON.stringify(buildServiceViewerModel(model), null, 2);
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

// ---------- query ----------
serviceCommand
  .command('query')
  .description('查询后端服务模型（repositories | modules | layers | moduleGraph | classes | interfaces | methods | endpoints | tables | foreignKeys | dependencies | mappers | dataModels | complexityHotspots | techStack | testStats）')
  .argument('<type>', '对象类型')
  .option('--where <conditions>', '过滤条件 (k=v 精确, k~v 模糊)')
  .option('--pretty', '人类可读表格输出')
  .option('--snapshot <path>', 'asdm-aos 本体快照路径（不读取已保存的 service-snapshot.json）')
  .option('--module-prefix <json>', '自定义模块规则 JSON（与 --snapshot 配合使用）')
  .option('--module-config <path>', '模块配置文件路径（与 --snapshot 配合使用）')
  .action((type, opts) => {
    const model = resolveServiceModel(opts);
    const typeMap = {
      repositories: model.repositories,
      modules: model.modules,
      layers: model.layers,
      moduleGraph: model.moduleGraph ? [model.moduleGraph] : [],
      classes: model.classes,
      interfaces: model.interfaces,
      methods: model.methods,
      endpoints: model.endpoints,
      tables: model.tables,
      foreignKeys: model.foreignKeys,
      dependencies: model.dependencies,
      mappers: model.mappers,
      dataModels: model.dataModels,
      complexityHotspots: model.complexityHotspots,
      techStack: model.techStack,
      testStats: [model.testStats],
    };
    const objects = typeMap[type];
    if (!objects) {
      fail(`未知类型: ${type}（支持 repositories / modules / layers / moduleGraph / classes / interfaces / methods / endpoints / tables / foreignKeys / dependencies / mappers / dataModels / complexityHotspots / techStack / testStats）`);
    }
    const conditions = parseWhere(opts.where);
    const result = conditions
      ? objects.filter((o) => matchesWhere(o, conditions))
      : objects;
    if (opts.pretty) {
      outputPretty(result);
    } else {
      outputJson(result);
    }
  });

// ---------- service audit 子命令 ----------
const auditCommand = new Command('audit')
  .description('后端服务健康审计：五维健康度（complexity / dataHealth / testCoverage / analysisQuality / dependencyHealth / all）');

auditCommand
  .command('health')
  .description('综合健康评分（聚合复杂度 / 数据层 / 测试覆盖率 / 分析质量 / 依赖五维加权）')
  .option('--snapshot <path>', 'asdm-aos 本体快照路径（不读取已保存的 service-snapshot.json）')
  .option('--module-prefix <json>', '自定义模块规则 JSON（与 --snapshot 配合使用）')
  .option('--module-config <path>', '模块配置文件路径（与 --snapshot 配合使用）')
  .action((opts) => {
    const model = resolveServiceModel(opts);
    outputJson(auditHealth(model));
  });

auditCommand
  .command('all')
  .description('运行全部 5 个健康审计维度，输出汇总结果')
  .option('--snapshot <path>', 'asdm-aos 本体快照路径（不读取已保存的 service-snapshot.json）')
  .option('--module-prefix <json>', '自定义模块规则 JSON（与 --snapshot 配合使用）')
  .option('--module-config <path>', '模块配置文件路径（与 --snapshot 配合使用）')
  .action((opts) => {
    const model = resolveServiceModel(opts);
    outputJson(runAllServiceAudits(model));
  });

serviceCommand.addCommand(auditCommand);
