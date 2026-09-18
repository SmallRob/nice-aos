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
//   6. nice-aos overview watch ...                  # 代码库变更后自动重扫 + 导出 + 通知 serve（v0.45.0）

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import {
  setOverviewSnapshotDir, saveOverviewSnapshot, loadOverviewSnapshot, hasOverviewSnapshot,
  getOverviewSnapshotPath, getOverviewSnapshotDir,
} from '../../overview/overviewSnapshot.js';
import { scanOverview } from '../../overview/overviewScanner.js';
import { buildOverviewViewerModel, renderOverviewHtml } from '../../overview/overviewViewer.js';
import { createWatcher } from '../../overview/fileWatcher.js';
import { parseWhere, matchesWhere, outputJson, outputPretty, succeed, fail } from '../shared.js';
import { buildOverviewCanvas } from '../../canvas/canvasBuilder.js';
import { notifyServe } from './notifyServe.js';
import { getSnapshotDir } from '../../paths.js';

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
  .description('导出全景架构分析（json | html | viewmodel | canvas）')
  .option('--format <format>', '导出格式: json | html | viewmodel | canvas', 'json')
  .option('--output <path>', '写入文件（默认输出到 stdout）；--format canvas 时必须是 .html 路径')
  .action((opts) => {
    const model = loadOverviewSnapshot();
    let content;
    if (opts.format === 'json') {
      content = JSON.stringify(model, null, 2);
    } else if (opts.format === 'html') {
      content = renderOverviewHtml(buildOverviewViewerModel(model));
    } else if (opts.format === 'viewmodel') {
      content = JSON.stringify(buildOverviewViewerModel(model), null, 2);
    } else if (opts.format === 'canvas') {
      try {
        content = buildOverviewCanvas(model).html;
      } catch (err) {
        fail(`画布生成失败: ${err.message}`);
      }
      if (!opts.output) {
        fail(`--format canvas 必须配合 --output 指定 .html 路径`);
      }
    } else {
      fail(`未知格式: ${opts.format}（支持 json / html / viewmodel / canvas）`);
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

// ============================================================================
// watch —— 代码库变更后自动重扫 + 导出 + 通知 serve（v0.45.0）
//
// 工作流：
//   1. fs.watch 递归监听 --projects-dir + 关键文件（layout-file / human-knowledge）
//   2. 防抖窗口（默认 1500ms）内合并所有事件，单次扫描
//   3. burst 检测：连续触发间隔 < interval/4 时延后 2× interval，吸收 git pull / IDE 批量改动
//   4. 触发回调：scanOverview → saveOverviewSnapshot → 导出指定格式 → notifyServe('overview:changed')
//   5. SIGINT/SIGTERM 优雅退出（清 watcher + 关闭 SQLite）
//
// 与现有 export / scan 子命令不冲突：watch 只在监听期循环触发相同的 scan+export 流水线；
// 用户 Ctrl+C 后下次想跑仍可用 `overview scan` / `overview export`。
// ============================================================================
overviewCommand
  .command('watch')
  .description('监听代码库变更（防抖 + burst 检测 + 去重 baseline），触发时自动 scan + 导出 + 通知 serve 广播 overview:changed')
  .requiredOption('--projects-dir <path>', '多项目根目录（与 scan 一致；含多个项目子目录或 layout-file 声明的项目源根）')
  .option('--layout-file <path>', '布局声明 JSON（与 scan 一致）', null)
  .option('--human-knowledge <path>', '人类架构知识 JSON（与 scan 一致）', null)
  .option('--interval <ms>', '防抖窗口毫秒（默认 1500；下限 200；编辑器保存/git pull 突发会在窗口内合并）', '1500')
  .option('--export-formats <list>', '触发时要导出的格式列表，逗号分隔（默认 html；可选 html,viewmodel,canvas,json）', 'html')
  .option('--output-dir <path>', '导出目录（默认 <overview-snapshot-dir>）；html 写 <dir>/overview.html，canvas 写 <dir>/overview-canvas.html')
  .option('--no-notify', '不通知 serve（纯本地调试用）')
  .option('--quiet', '抑制每次触发时的日志（仅打印启动与退出）')
  .option('--once', '运行一次后立即退出（不进入监听循环；用作 smoke test）')
  .action(async (opts) => {
    const projectsRoot = path.resolve(opts.projectsDir);
    if (!fs.existsSync(projectsRoot)) fail(`项目根不存在: ${projectsRoot}`);
    if (!fs.statSync(projectsRoot).isDirectory()) fail(`项目根不是目录: ${projectsRoot}`);

    const layoutFile = opts.layoutFile ? path.resolve(opts.layoutFile) : null;
    const humanKnowledgeFile = opts.humanKnowledge ? path.resolve(opts.humanKnowledge) : null;
    const interval = Math.max(200, parseInt(opts.interval, 10) || 1500);
    const exportFormats = String(opts.exportFormats)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const validFormats = new Set(['html', 'viewmodel', 'canvas', 'json']);
    for (const f of exportFormats) {
      if (!validFormats.has(f)) fail(`未知导出格式: ${f}（支持 html / viewmodel / canvas / json）`);
    }

    const outDir = opts.outputDir ? path.resolve(opts.outputDir) : getOverviewSnapshotDir();
    fs.mkdirSync(outDir, { recursive: true });

    // 监听目标：projects-dir 目录树 + 两个外部声明文件（若存在）
    const watchTargets = [projectsRoot];
    if (layoutFile && fs.existsSync(layoutFile)) watchTargets.push(layoutFile);
    if (humanKnowledgeFile && fs.existsSync(humanKnowledgeFile)) watchTargets.push(humanKnowledgeFile);

    // 拿 nice-aos 版本（与 scan 一致）
    let niceAosVersion = '0.31.0';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'package.json'), 'utf-8'));
      niceAosVersion = pkg.version || niceAosVersion;
    } catch { /* fallback */ }

    let scanning = false; // 防重入：回调尚未完成时新事件只标记 dirty
    let pendingDirty = false;
    let totalScans = 0;
    let lastError = null;

    async function runOnce(changedPaths) {
      if (scanning) {
        pendingDirty = true;
        return;
      }
      scanning = true;
      const startedAt = Date.now();
      if (!opts.quiet) {
        const sample = changedPaths.slice(0, 3).map((p) => path.relative(projectsRoot, p) || path.basename(p)).join(', ');
        const more = changedPaths.length > 3 ? ` 等 ${changedPaths.length} 项` : '';
        console.error(`\n🔄 检测到变更 (${changedPaths.length}): ${sample}${more}`);
      }
      try {
        // 1) scan
        const model = await scanOverview({
          projectsRoot,
          layoutFile,
          humanKnowledgeFile,
          niceAosVersion,
        });
        const snapPath = saveOverviewSnapshot(model);
        const written = [snapPath];

        // 2) export 各格式
        for (const fmt of exportFormats) {
          try {
            if (fmt === 'html') {
              const p = path.join(outDir, 'overview.html');
              fs.writeFileSync(p, renderOverviewHtml(buildOverviewViewerModel(model)), 'utf-8');
              written.push(p);
            } else if (fmt === 'viewmodel') {
              const p = path.join(outDir, 'overview-viewmodel.json');
              fs.writeFileSync(p, JSON.stringify(buildOverviewViewerModel(model), null, 2), 'utf-8');
              written.push(p);
            } else if (fmt === 'canvas') {
              const p = path.join(outDir, 'overview-canvas.html');
              fs.writeFileSync(p, buildOverviewCanvas(model).html, 'utf-8');
              written.push(p);
            } else if (fmt === 'json') {
              const p = path.join(outDir, 'overview-snapshot.json');
              // 注：snapPath 与 json 写同一份文件，dedupe
              if (p !== snapPath) {
                fs.writeFileSync(p, JSON.stringify(model, null, 2), 'utf-8');
                written.push(p);
              }
            }
          } catch (err) {
            lastError = err;
            console.error(`⚠️  导出 ${fmt} 失败: ${err?.message ?? err}`);
          }
        }

        // 3) notify serve（运行中才生效；内部静默降级）
        if (opts.notify !== false) {
          notifyServe({ dataDir: getSnapshotDir(), event: 'overview:changed', paths: written.slice(0, 20) })
            .then((r) => { if (r.notified && !opts.quiet) console.error(`ℹ️  已通知 serve 广播 overview:changed（${r.notified ? `${written.length} 个文件` : ''}）`); })
            .catch(() => { /* 静默 */ });
        }

        totalScans += 1;
        const t = model.totals || {};
        if (!opts.quiet) {
          console.error(`✓ #${totalScans} 重扫完成: ${t.projects} 项目 / ${t.javaServices} Java 服务 / ${(t.grandTotalLines || 0).toLocaleString()} 行 / ${written.length} 文件 / ${Date.now() - startedAt}ms`);
        }
      } catch (err) {
        lastError = err;
        console.error(`❌ 重扫失败: ${err?.message ?? err}`);
      } finally {
        scanning = false;
        if (pendingDirty) {
          pendingDirty = false;
          // 触发期间又来一波事件，立刻重跑（典型场景：扫描过程改文件）
          setImmediate(() => runOnce(['pending-dirty-rescan']));
        }
      }
    }

    // 一次性模式（smoke test / CI）：只跑一次就退出
    if (opts.once) {
      console.error(`🔄 一次性扫描 (--once): ${projectsRoot}`);
      await runOnce(['once-mode']);
      succeed({ ok: true, message: '一次性扫描完成', totalScans: 1 });
      return;
    }

    // 进入长驻模式
    console.error(`👀 监听中（防抖 ${interval}ms）：`);
    console.error(`   projects-dir     ${projectsRoot}`);
    if (layoutFile) console.error(`   layout-file      ${layoutFile}`);
    if (humanKnowledgeFile) console.error(`   human-knowledge  ${humanKnowledgeFile}`);
    console.error(`   output-dir       ${outDir}`);
    console.error(`   export-formats   ${exportFormats.join(', ')}`);
    console.error(`   notify-serve     ${opts.notify !== false ? 'on' : 'off'}（事件 overview:changed）`);
    console.error(`   按 Ctrl+C 退出`);

    const watcher = createWatcher({
      targets: watchTargets,
      interval,
      onChange: runOnce,
      onError: (err) => console.error(`⚠️  watcher 错误: ${err?.message ?? err}`),
    });

    const { baselineFiles, watching } = await watcher.start();
    console.error(`✓ 监听启动：baseline ${baselineFiles} 个文件，${watching} 个 fs.watch handle`);

    // 首次启动立即跑一次（baseline 状态下仍可能用户期望先有一份产出 + 让 serve 知道 overview 已就绪）
    await runOnce(['initial-baseline']);

    // 优雅退出
    let exiting = false;
    function shutdown(signal) {
      if (exiting) return;
      exiting = true;
      console.error(`\n👋 收到 ${signal}，清理资源并退出…`);
      watcher.close();
      succeed({
        ok: true,
        message: `watch 已停止（${totalScans} 次扫描${lastError ? `，最后一次错误: ${lastError.message}` : ''}）`,
        totalScans,
      });
    }
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    // SIGHUP（终端关闭）也兜底
    process.on('SIGHUP', () => shutdown('SIGHUP'));
  });
