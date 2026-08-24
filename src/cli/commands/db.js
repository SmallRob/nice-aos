import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { loadDbSnapshot, saveDbSnapshot } from '../../database/dbSnapshot.js';
import { buildDatabaseModel, buildDatabaseModelIncremental } from '../../database/dbBuilder.js';
import { buildDbViewerModel, renderDbOverviewHtml } from '../../database/dbViewer.js';
import { buildEntities } from '../../database/dbModel.js';
import {
  auditHealth, auditImpact, auditDomains, auditIndexes,
  auditEvolution, auditFkChain, auditNaming, auditEntities,
  auditCrossLayer,
} from '../../database/dbAuditor.js';
import { parseWhere, matchesWhere, outputJson, outputPretty, succeed, fail } from '../shared.js';
import { listThemeNames } from '../../themes/index.js';

export const dbCommand = new Command('db')
  .description('MySQL 数据库脚本目录分析：扫描迁移脚本 → 数据库模型 → 分析 JSON / 数据蓝图 dataoverview HTML');

dbCommand
  .command('scan')
  .description('扫描 MySQL 迁移脚本目录，构建数据库模型快照')
  .requiredOption('--dir <path>', 'MySQL 迁移脚本目录')
  .option('--incremental', '增量扫描（仅处理新增/修改的迁移文件）')
  .option('--layout <mode>', '目录布局模式：auto / flyway / sprint（默认 auto 自动检测）', 'auto')
  .option('--all-files', '扫描所有 .sql 文件（默认只扫描 DDL 文件：*-db.sql / *-all.sql / V*.sql 等）')
  .option('--exclude <dirs>', '排除的子目录名（逗号分隔），如 testdata,backup', '')
  .action(async (opts) => {
    const migrationDir = path.resolve(opts.dir);
    if (!fs.existsSync(migrationDir)) {
      fail(`路径不存在: ${migrationDir}`);
    }
    if (!fs.statSync(migrationDir).isDirectory()) {
      fail(`路径不是目录: ${migrationDir}`);
    }

    const buildOpts = {
      layout: opts.layout,
      allFiles: opts.allFiles,
      excludeDirs: opts.exclude ? opts.exclude.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    };

    let dbDataMap;
    if (opts.incremental) {
      let existing = null;
      try {
        existing = loadDbSnapshot();
      } catch {
        // 无快照则全量
      }
      dbDataMap = existing
        ? await buildDatabaseModelIncremental(migrationDir, existing, buildOpts)
        : await buildDatabaseModel(migrationDir, buildOpts);
    } else {
      dbDataMap = await buildDatabaseModel(migrationDir, buildOpts);
    }

    const snapshotPath = saveDbSnapshot(dbDataMap);
    const meta = dbDataMap._meta;
    const dbInfo = meta.databaseCount > 1 ? `，${meta.databaseCount} 个数据库` : '';
    const layoutInfo = meta.layout ? ` [布局: ${meta.layout}]` : '';
    succeed({
      ok: true,
      message: `已分析 ${meta.fileCount} 个迁移文件，${meta.tableCount} 张表${dbInfo}，${meta.fkCount} 个外键，${meta.indexCount} 个索引${layoutInfo}`,
      snapshot: snapshotPath,
      stats: {
        tables: meta.tableCount,
        foreignKeys: meta.fkCount,
        indexes: meta.indexCount,
        migrations: meta.migrationCount,
        domains: meta.domainCount,
        databases: meta.databaseCount,
        views: meta.viewCount,
        triggers: meta.triggerCount,
        procedures: meta.procedureCount,
        layout: meta.layout,
        skippedEmptyTemplates: meta.skippedEmptyTemplates || 0,
      },
      incremental: meta.incremental,
      durationMs: meta.durationMs,
    });
  });

dbCommand
  .command('export')
  .description('导出数据库分析结果（json | html | viewmodel）')
  .option('--format <format>', '导出格式: json | html | viewmodel', 'json')
  .option('--output <path>', '写入文件（默认输出到 stdout）')
  .option('--theme <name>', `HTML 主题风格（默认 fresh-green，可选: ${listThemeNames().join(' / ')}）`, 'fresh-green')
  .action((opts) => {
    const dbDataMap = loadDbSnapshot();
    let content;
    if (opts.format === 'json') {
      content = JSON.stringify(dbDataMap, null, 2);
    } else if (opts.format === 'html') {
      let theme = opts.theme;
      if (!listThemeNames().includes(theme)) {
        fail(`未知主题: ${theme}（可选: ${listThemeNames().join(' / ')}）`);
      }
      content = renderDbOverviewHtml(buildDbViewerModel(dbDataMap), { theme });
    } else if (opts.format === 'viewmodel') {
      content = JSON.stringify(buildDbViewerModel(dbDataMap), null, 2);
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

dbCommand
  .command('query')
  .description('查询数据库快照（tables | foreignKeys | indexes | migrations | domains | views | triggers | procedures | entities）')
  .argument('<type>', '对象类型')
  .option('--where <conditions>', '过滤条件 (k=v 精确, k~v 模糊)')
  .option('--pretty', '人类可读表格输出')
  .action((type, opts) => {
    const dbDataMap = loadDbSnapshot();
    const typeMap = {
      tables: dbDataMap.tables,
      foreignKeys: dbDataMap.foreignKeys,
      indexes: dbDataMap.tables.flatMap((t) =>
        (t.indexes || []).map((i) => ({ ...i, tableName: t.name })),
      ),
      migrations: dbDataMap.migrations,
      domains: dbDataMap.domains,
      views: dbDataMap.views || [],
      triggers: dbDataMap.triggers || [],
      procedures: dbDataMap.procedures || [],
      entities: buildEntities(dbDataMap.tables || [], dbDataMap.foreignKeys || []),
    };
    const objects = typeMap[type];
    if (!objects) {
      fail(`未知类型: ${type}（支持 tables / foreignKeys / indexes / migrations / domains / views / triggers / procedures / entities）`);
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

// ---------- db audit 子命令 ----------
const auditCommand = new Command('audit')
  .description('数据库审计：9 大审计场景（health / impact / domains / indexes / evolution / fkchain / naming / entities / crosslayer / all）');

auditCommand
  .command('health')
  .description('Schema 健康度总审计（完整性 / 一致性 / 索引质量 / 模式健康）')
  .action(() => {
    const dbDataMap = loadDbSnapshot();
    const result = auditHealth(dbDataMap);
    outputJson(result);
  });

auditCommand
  .command('impact')
  .description('迁移影响分析：指定版本，输出受影响表、级联影响、风险等级')
  .requiredOption('--target-version <version>', '迁移版本号（如 V1.0.1 或前缀匹配）')
  .action((opts) => {
    const dbDataMap = loadDbSnapshot();
    const result = auditImpact(dbDataMap, opts.targetVersion);
    if (result.error) fail(result.error);
    outputJson(result);
  });

auditCommand
  .command('domains')
  .description('领域依赖图谱：依赖矩阵 / 耦合度排名 / 核心领域 / 循环依赖 / 桑基图数据')
  .action(() => {
    const dbDataMap = loadDbSnapshot();
    const result = auditDomains(dbDataMap);
    outputJson(result);
  });

auditCommand
  .command('indexes')
  .description('索引优化分析：外键索引覆盖率 / 冗余索引 / 宽索引 / 主键类型分布')
  .action(() => {
    const dbDataMap = loadDbSnapshot();
    const result = auditIndexes(dbDataMap);
    outputJson(result);
  });

auditCommand
  .command('evolution')
  .description('模型演进分析：表数增长曲线 / 里程碑版本 / 领域首版出现 / DDL 趋势')
  .action(() => {
    const dbDataMap = loadDbSnapshot();
    const result = auditEvolution(dbDataMap);
    outputJson(result);
  });

auditCommand
  .command('fkchain')
  .description('外键链路分析：指定表的上下游依赖链 / 级联删除路径 / 循环引用')
  .requiredOption('--table <tableName>', '表名')
  .action((opts) => {
    const dbDataMap = loadDbSnapshot();
    const result = auditFkChain(dbDataMap, opts.table);
    if (result.error) fail(result.error);
    outputJson(result);
  });

auditCommand
  .command('naming')
  .description('命名规范审计：表名 / 主键 / 外键列 / 时间戳 / 软删除 / 索引命名')
  .action(() => {
    const dbDataMap = loadDbSnapshot();
    const result = auditNaming(dbDataMap);
    outputJson(result);
  });

auditCommand
  .command('entities')
  .description('实体边界审计（DDD）：实体聚合清单 / 跨域外键侵蚀 / 孤立实体 / 领域归属置信度 / 演进方向推测')
  .action(() => {
    const dbDataMap = loadDbSnapshot();
    const result = auditEntities(dbDataMap);
    outputJson(result);
  });

auditCommand
  .command('crosslayer')
  .description('代码↔数据库跨层审计：孤儿表 / 隐式外键 / 代码实体覆盖率 / 幽灵类型检测')
  .option('--code-snapshot <path>', '代码本体快照路径（snapshot.json），用于跨层匹配')
  .action((opts) => {
    const dbDataMap = loadDbSnapshot();
    let codeEntities = null;
    if (opts.codeSnapshot) {
      try {
        const codeSnapshot = JSON.parse(fs.readFileSync(opts.codeSnapshot, 'utf-8'));
        const interfaces = (codeSnapshot.Interface || []).map((e) => ({ name: e.name, type: 'Interface', id: e.id, filePath: e.filePath }));
        const classes = (codeSnapshot.Class || []).map((e) => ({ name: e.name, type: 'Class', id: e.id, filePath: e.filePath }));
        const stores = (codeSnapshot.Store || []).map((e) => ({ name: e.name, type: 'Store', id: e.id, filePath: e.filePath }));
        codeEntities = [...interfaces, ...classes, ...stores];
      } catch (err) {
        fail(`无法加载代码快照: ${err.message}`);
      }
    }
    const result = auditCrossLayer(dbDataMap, codeEntities);
    outputJson(result);
  });

auditCommand
  .command('all')
  .description('运行全部 9 个审计场景，输出汇总结果')
  .option('--table <tableName>', '外键链路分析的目标表名（fkchain）')
  .option('--target-version <version>', '迁移影响分析的版本号（impact）')
  .option('--code-snapshot <path>', '代码本体快照路径（snapshot.json），用于跨层审计')
  .action((opts) => {
    const dbDataMap = loadDbSnapshot();
    const result = {
      health: auditHealth(dbDataMap),
      domains: auditDomains(dbDataMap),
      indexes: auditIndexes(dbDataMap),
      evolution: auditEvolution(dbDataMap),
      naming: auditNaming(dbDataMap),
      entities: auditEntities(dbDataMap),
    };
    if (opts.targetVersion) result.impact = auditImpact(dbDataMap, opts.targetVersion);
    if (opts.table) result.fkchain = auditFkChain(dbDataMap, opts.table);
    // 跨层审计（有代码快照时自动启用）
    if (opts.codeSnapshot) {
      try {
        const codeSnapshot = JSON.parse(fs.readFileSync(opts.codeSnapshot, 'utf-8'));
        const interfaces = (codeSnapshot.Interface || []).map((e) => ({ name: e.name, type: 'Interface', id: e.id, filePath: e.filePath }));
        const classes = (codeSnapshot.Class || []).map((e) => ({ name: e.name, type: 'Class', id: e.id, filePath: e.filePath }));
        const stores = (codeSnapshot.Store || []).map((e) => ({ name: e.name, type: 'Store', id: e.id, filePath: e.filePath }));
        result.crossLayer = auditCrossLayer(dbDataMap, [...interfaces, ...classes, ...stores]);
      } catch { /* 无代码快照则跳过跨层审计 */ }
    }
    outputJson(result);
  });

dbCommand.addCommand(auditCommand);
