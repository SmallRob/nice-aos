import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { loadDeploySnapshot, saveDeploySnapshot } from '../../deployment/deploySnapshot.js';
import { buildDeployModel, buildDeployModelIncremental } from '../../deployment/deployBuilder.js';
import { buildDeployViewerModel, renderDeployOverviewHtml } from '../../deployment/deployViewer.js';
import {
  auditSecurity, auditResilience, auditConfigConsistency, auditDependency, auditHealth,
} from '../../deployment/deployAuditor.js';
import { parseWhere, matchesWhere, outputJson, outputPretty, succeed, fail } from '../shared.js';

export const deployCommand = new Command('deploy')
  .description('部署配置目录分析：扫描 Dockerfile / docker-compose / K8s manifest / nginx.conf / .env → 部署架构模型 → 分析 JSON / 部署蓝图 deployoverview HTML');

deployCommand
  .command('scan')
  .description('扫描部署配置目录（yaml / Dockerfile / nginx.conf / .env / shell），构建部署架构模型快照')
  .requiredOption('--dir <path>', '部署配置目录（如 ./deploy）')
  .option('--incremental', '增量扫描（无文件变化时直接复用快照）')
  .option('--exclude <dirs>', '排除的子目录名（逗号分隔），如 deploy-docs,data', '')
  .action((opts) => {
    const deployDir = path.resolve(opts.dir);
    if (!fs.existsSync(deployDir)) {
      fail(`路径不存在: ${deployDir}`);
    }
    if (!fs.statSync(deployDir).isDirectory()) {
      fail(`路径不是目录: ${deployDir}`);
    }

    const buildOpts = {
      excludeDirs: opts.exclude ? opts.exclude.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    };

    let model;
    if (opts.incremental) {
      let existing = null;
      try {
        existing = loadDeploySnapshot();
      } catch {
        // 无快照则全量
      }
      model = existing
        ? buildDeployModelIncremental(deployDir, existing, buildOpts)
        : buildDeployModel(deployDir, buildOpts);
    } else {
      model = buildDeployModel(deployDir, buildOpts);
    }

    const snapshotPath = saveDeploySnapshot(model);
    const meta = model._meta;
    succeed({
      ok: true,
      message: `已分析 ${meta.fileCount} 个部署文件，${meta.serviceCount} 个服务，${meta.routeCount} 条路由，${meta.upstreamCount} 个上游，${meta.dependencyCount} 条依赖，${meta.middlewareCount} 个中间件，${meta.environmentCount} 个环境文件，${meta.layerCount} 个分层`,
      snapshot: snapshotPath,
      stats: {
        files: meta.fileCount,
        services: meta.serviceCount,
        routes: meta.routeCount,
        upstreams: meta.upstreamCount,
        dependencies: meta.dependencyCount,
        middleware: meta.middlewareCount,
        environments: meta.environmentCount,
        layers: meta.layerCount,
        parseErrors: meta.parseErrors,
      },
      incremental: meta.incremental,
      changedFiles: meta.changedFiles || [],
      durationMs: meta.durationMs,
    });
  });

deployCommand
  .command('export')
  .description('导出部署架构分析结果（json | html | viewmodel）')
  .option('--format <format>', '导出格式: json | html | viewmodel', 'json')
  .option('--output <path>', '写入文件（默认输出到 stdout）')
  .action((opts) => {
    const model = loadDeploySnapshot();
    let content;
    if (opts.format === 'json') {
      content = JSON.stringify(model, null, 2);
    } else if (opts.format === 'html') {
      content = renderDeployOverviewHtml(buildDeployViewerModel(model));
    } else if (opts.format === 'viewmodel') {
      content = JSON.stringify(buildDeployViewerModel(model), null, 2);
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

deployCommand
  .command('query')
  .description('查询部署快照（services | routes | upstreams | dependencies | middleware | environments | files | layers）')
  .argument('<type>', '对象类型')
  .option('--where <conditions>', '过滤条件 (k=v 精确, k~v 模糊)')
  .option('--pretty', '人类可读表格输出')
  .action((type, opts) => {
    const model = loadDeploySnapshot();
    const typeMap = {
      services: model.services,
      routes: model.routes,
      upstreams: model.upstreams,
      dependencies: model.dependencies,
      middleware: model.middleware,
      environments: model.environments.map((e) => ({
        ...e,
        variableCount: (e.variables || []).length,
        variables: undefined,
      })),
      files: model.files,
      layers: model.layers,
    };
    const objects = typeMap[type];
    if (!objects) {
      fail(`未知类型: ${type}（支持 services / routes / upstreams / dependencies / middleware / environments / files / layers）`);
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

// ---------- deploy audit 子命令 ----------

const auditCommand = new Command('audit')
  .description('部署架构审计：5 大场景（health / security / resilience / consistency / dependency / all）');

auditCommand
  .command('health')
  .description('综合健康评分（聚合安全 / 高可用 / 配置一致性 / 依赖四维）')
  .action(() => {
    const model = loadDeploySnapshot();
    outputJson(auditHealth(model));
  });

auditCommand
  .command('security')
  .description('安全审计：latest 镜像 / 明文敏感值 / 端口暴露 / 无鉴权路由')
  .action(() => {
    const model = loadDeploySnapshot();
    outputJson(auditSecurity(model));
  });

auditCommand
  .command('resilience')
  .description('高可用审计：健康检查 / 就绪探针 / 重启策略 / 副本数 / 资源限额')
  .action(() => {
    const model = loadDeploySnapshot();
    outputJson(auditResilience(model));
  });

auditCommand
  .command('consistency')
  .description('配置一致性审计：多环境变量漂移 / 环境引用未知服务')
  .action(() => {
    const model = loadDeploySnapshot();
    outputJson(auditConfigConsistency(model));
  });

auditCommand
  .command('dependency')
  .description('依赖审计：路由未解析 / 上游断链 / 循环依赖 / 中间件无消费方')
  .action(() => {
    const model = loadDeploySnapshot();
    outputJson(auditDependency(model));
  });

auditCommand
  .command('all')
  .description('运行全部 5 个审计场景，输出汇总结果')
  .action(() => {
    const model = loadDeploySnapshot();
    outputJson({
      health: auditHealth(model),
      security: auditSecurity(model),
      resilience: auditResilience(model),
      configConsistency: auditConfigConsistency(model),
      dependency: auditDependency(model),
    });
  });

deployCommand.addCommand(auditCommand);
