// export / output 命令：导出本体快照为 Markdown / JSON / HTML 蓝图 / 视图模型 JSON / 画布 HTML
// 增量模式（--since <ref>）：git diff 解析 + 末尾追加"增量变更摘要"节
//
// v0.34.0 升级：
//   - out-3 `--merge <paths...>` 多快照合并（见 src/ontology/merge.js；冲突策略 first-wins / rename）
//   - out-4 `--include <types>` / `--exclude <types>` 类型过滤（作用于全部格式）
//   - out-5 theme 子命令组：add/list/remove 管理用户自定义主题（~/.nice-aos/themes/）
//   - out-6 `--format all`：一条命令产出 markdown + html + viewmodel 三件套
// v0.43.0 升级：
//   - out-7 `--format canvas` 输出架构图画布（自包含 HTML+SVG），自动检测可用的
//     deploy / overview 蓝图快照；对应 nice-aos-canvas-skill 的程序化入口。
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { loadSnapshot } from '../../ontology/snapshot.js';
import { exportToMarkdown, filterObjectTypes, renderAll } from '../../ontology/exporter.js';
import { buildViewerModel, renderViewerHtml } from '../../ontology/viewer.js';
import { fail } from '../shared.js';
import { listThemeNames, resolveTheme, registerTheme, syncUserThemes } from '../../themes/index.js';
import { saveUserTheme, listUserThemes, removeUserTheme, readUserTheme, isValidThemeName } from './themeStore.js';
import { listChangedFiles, listChangedFilesSince, filterObjectsByFiles, isValidRangeSpec, findGitRoot } from '../../analyzers/gitDiff.js';
import { renderTemplate } from '../../ontology/template.js';
import { mergeSnapshots } from '../../ontology/merge.js';
import { buildContextDocs } from '../../ontology/contextDocs.js';
import { renderDocsHtml } from '../../ontology/docsViewer.js';
import { notifyServe } from './notifyServe.js';
import { getSnapshotDir } from '../../paths.js';
import { buildCanvasAuto } from '../../canvas/canvasBuilder.js';
import { loadDeploySnapshot, hasDeploySnapshot } from '../../deployment/deploySnapshot.js';
import { loadOverviewSnapshot, hasOverviewSnapshot } from '../../overview/overviewSnapshot.js';

function parseTypeList(raw) {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const exportCommand = new Command('export')
  .description('导出本体快照为 Markdown / JSON / HTML 蓝图 / 视图模型 JSON / 架构图画布（亦名 output：作为三大核心命令之一，对应用户视角的"产出报告"）')
  .option('--format <format>', '导出格式: markdown | json | html | viewmodel | canvas | all（all = md+html+viewmodel 三件套，需 --output；canvas 自动检测 deploy/overview 快照）', 'markdown')
  .option('--output <path>', '写入文件（默认输出到 stdout）；--format all 时作为基准路径派生 .md/.html/.viewmodel.json；--format canvas 时必须是 .html 路径')
  .option('--theme <name>', `HTML 主题风格（默认 deep-blue，内置与用户主题可用: 见 nice-aos output theme list）`, 'deep-blue')
  .option('--since <ref>', '增量导出：仅列出 ref 以来变更涉及的对象（git diff --name-only <ref>..HEAD；含未跟踪文件）；末尾追加"增量变更摘要"节。ref 语法：HEAD / HEAD~1 / abc..def / abc123')
  .option('--staged', '配合 --since：只列已暂存变更（git diff --staged）；用于"pre-commit 体检"')
  .option('--template <path>', '自定义 Markdown 模板：使用 {{Project.name}} / {{stats.Component}} / {{ObjectCounts.Module}} 等占位符；模板文件不存在时报错。详见 docs/plan/aos-three-core-roadmap.md 与 src/ontology/template.js 注释')
  .option('--merge <paths...>', '多快照合并导出：2 份及以上领域快照文件路径（空格分隔），合并为一份总览后再渲染。冲突策略 --merge-strategy first-wins(默认) | rename')
  .option('--merge-strategy <strategy>', '合并冲突策略: first-wins（保留先出现者并计数上报）| rename（后到冲突对象重前缀 + 引用字段泛键回填）', 'first-wins')
  .option('--include <types>', '类型白名单（逗号分隔，如 Component,Hook）：仅导出这些类型的对象（作用于全部格式）')
  .option('--exclude <types>', '类型黑名单（逗号分隔）：从导出中剔除这些类型（include 应用后再剔除）')
  .action((opts) => {
    // out-7 canvas 格式：跳过 dataMap 加载与过滤，直接消费 deploy / overview 快照
    if (opts.format === 'canvas') {
      if (!opts.output) {
        fail('--format canvas 必须配合 --output 指定 .html 路径（避免大量 HTML 刷屏）');
      }
      let deployModel = null;
      let overviewModel = null;
      if (hasDeploySnapshot()) {
        try { deployModel = loadDeploySnapshot(); } catch { /* 单项失败不阻塞 overview 探测 */ }
      }
      if (hasOverviewSnapshot()) {
        try { overviewModel = loadOverviewSnapshot(); } catch { /* 同上 */ }
      }
      let canvas;
      try {
        canvas = buildCanvasAuto({ deployModel, overviewModel });
      } catch (err) {
        fail(err.message);
      }
      fs.writeFileSync(opts.output, canvas.html, 'utf-8');
      console.error(`已写入: ${opts.output}`);
      console.error(`   画布类型: ${canvas.kind} · 数据源: ${canvas.source}`);
      console.error(`   ${JSON.stringify(canvas.stats)}`);
      // 通知 serve（运行中才生效）
      notifyServe({ dataDir: getSnapshotDir(), event: 'report:changed', paths: [opts.output] })
        .then((r) => { if (r.notified) console.error('ℹ️  已通知运行中的 serve 广播 report:changed'); })
        .catch(() => {});
      return;
    }

    // out-3 合并：多快照路径 → 合成 dataMap（在 dataMap 层合成，全格式自然复用）
    let dataMap;
    if (opts.merge?.length) {
      if (opts.merge.length < 2) {
        fail(`--merge 需要至少 2 份快照路径（收到 ${opts.merge.length} 个）。示例: --merge a/snapshot.json b/snapshot.json`);
      }
      if (!['first-wins', 'rename'].includes(opts.mergeStrategy)) {
        fail(`未知合并策略: ${opts.mergeStrategy}（可选 first-wins | rename）`);
      }
      const merged = mergeSnapshotFiles(opts.merge, opts.mergeStrategy);
      dataMap = merged.dataMap;
      console.error(`ℹ️  合并 ${merged.meta.sources.length} 份快照: ${merged.meta.sources.map((s) => s.name).join(' + ')}`);
      if (merged.meta.conflicts > 0) {
        console.error(`   id 冲突 ${merged.meta.conflicts} 处（策略=${opts.mergeStrategy}${opts.mergeStrategy === 'rename' ? `，重命名 ${merged.meta.renamedCount} 个对象` : '，first-wins 丢弃后者'}）`);
      }
    } else {
      dataMap = loadSnapshot();
    }

    // out-4 类型过滤（先于 since 过滤计算，保证 byType 计数口径一致）
    if (opts.include || opts.exclude) {
      try {
        const r = filterObjectTypes(dataMap, { include: parseTypeList(opts.include), exclude: parseTypeList(opts.exclude) });
        dataMap = r.dataMap;
        if (r.removed > 0) console.error(`ℹ️  类型过滤: 剔除 ${r.removed} 个对象（保留 ${r.kept}）`);
      } catch (err) {
        fail(err.message);
      }
    }

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

    let templateStr = null;
    if (opts.template) {
      if (!fs.existsSync(opts.template)) {
        fail(`--template 模板文件不存在: ${opts.template}`);
      }
      try {
        templateStr = fs.readFileSync(opts.template, 'utf-8');
      } catch (err) {
        fail(`--template 读取失败: ${err.message}`);
      }
    }

    const writtenPaths = [];
    const writeOut = (filePath, content) => {
      fs.writeFileSync(filePath, content, 'utf-8');
      writtenPaths.push(filePath);
      console.error(`已写入: ${filePath}`);
    };

    if (opts.format === 'all') {
      // out-6 三件套：--output 为基准路径 → 派生 .md/.html/.viewmodel.json；无 --output 时 fail（避免三份内容刷屏）
      if (!opts.output) {
        fail('--format all 需要 --output 指定输出基准路径（将派生 <base>.md / <base>.html / <base>.viewmodel.json）');
      }
      const base = stripKnownExt(opts.output);
      let theme;
      try {
        theme = resolveTheme(opts.theme).vars ? opts.theme : opts.theme; // resolveTheme 兼做存在性校验
      } catch (err) {
        fail(err.message);
      }
      const renders = renderAll(dataMap, { theme, templateStr, sinceCtx });
      writeOut(`${base}.md`, renders.markdown);
      writeOut(`${base}.html`, renders.html);
      writeOut(`${base}.viewmodel.json`, renders.viewmodel);
    } else if (opts.format === 'json') {
      emit(opts, JSON.stringify(dataMap, null, 2), writeOut);
    } else if (opts.format === 'markdown') {
      const content = templateStr != null
        ? renderTemplate(templateStr, dataMap)
        : exportToMarkdown(dataMap, sinceCtx ? { since: sinceCtx } : undefined);
      emit(opts, content, writeOut);
    } else if (opts.format === 'html') {
      // 本体蓝图查看器：数据聚合 → 自包含 HTML（领域蓝图 / 业务数据图 / 业务逻辑流向）
      try {
        resolveTheme(opts.theme);
      } catch (err) {
        fail(err.message);
      }
      emit(opts, renderViewerHtml(buildViewerModel(dataMap), { theme: opts.theme }), writeOut);
    } else if (opts.format === 'viewmodel') {
      // 视图模型 JSON（供 agent / 其他前端直接消费的聚合数据）
      emit(opts, JSON.stringify(buildViewerModel(dataMap), null, 2), writeOut);
    } else {
      fail(`未知格式: ${opts.format}（支持 markdown / json / html / viewmodel / canvas / all）`);
    }

    if (writtenPaths.length > 0 && sinceCtx) {
      const objCount = Object.values(sinceCtx.byType).reduce((s, a) => s + a.length, 0);
      console.error(`  since=${sinceCtx.spec}${opts.staged ? ' (staged)' : ''} 涉及 ${sinceCtx.files.length} 文件 / ${objCount} 对象`);
    }
    if (writtenPaths.length > 0) {
      // x-3 导出完成广播（serve 运行中才生效；内部静默降级不阻塞导出主流程）
      notifyServe({ dataDir: getSnapshotDir(), event: 'report:changed', paths: writtenPaths })
        .then((r) => {
          if (r.notified) console.error('ℹ️  已通知运行中的 serve 广播 report:changed');
        })
        .catch(() => { /* 网络层异常静默 */ });
    }
  });

function emit(opts, content, writeOut) {
  if (opts.output) writeOut(opts.output, content);
  else console.log(content);
}

function stripKnownExt(p) {
  return p.replace(/\.(md|markdown|html?|viewmodel\.json|json)$/i, '');
}

// ---------- out-3 多快照合并接入 ----------

function mergeSnapshotFiles(paths, strategy) {
  const snapshots = paths.map((p) => {
    if (!fs.existsSync(p)) fail(`--merge 快照不存在: ${p}`);
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (err) {
      fail(`--merge 快照解析失败 ${p}: ${err.message}`);
    }
  });
  return mergeSnapshots(snapshots, {
    strategy,
    sources: paths.map((p, i) => ({ name: inferSourceName(p, i), path: p })),
  });
}

// 源名推断：<proj>/snapshot.json → proj；<proj>/.nice-aos/data/snapshot.json → proj；兜底文件所在目录名
function inferSourceName(filePath, idx) {
  const base = path.basename(filePath);
  if (base === 'snapshot.json') return path.basename(path.dirname(filePath)) || `snap-${idx}`;
  return path.basename(path.dirname(filePath)) || `snap-${idx}`;
}

// ---------- x-3 广播通知已由 notifyServe.js 提供（见 action 尾部调用） ----------

// ---------- out-5 主题管理子命令组 ----------

const themeCmd = exportCommand.command('theme')
  .description('管理用户自定义蓝图主题（HTML 变量 token 集），落盘 ~/.nice-aos/themes/，add 后即刻可用于 --theme');

themeCmd.command('add')
  .description('注册/覆盖用户主题：--name midnight-teal --file theme.json（JSON 形态 {"label","dark","vars"}，vars 至少含 --bg/--fg）')
  .requiredOption('--name <name>', '主题名（小写字母数字中划线，≤40 字符）')
  .requiredOption('--file <path>', '主题定义 JSON 文件路径')
  .action((opts) => {
    if (!fs.existsSync(opts.file)) fail(`主题定义文件不存在: ${opts.file}`);
    let definition;
    try {
      definition = JSON.parse(fs.readFileSync(opts.file, 'utf-8'));
    } catch (err) {
      fail(`主题定义不是合法 JSON: ${err.message}`);
    }
    if (!isValidThemeName(opts.name)) {
      fail(`非法主题名: ${opts.name}（仅允许小写字母数字与中划线，≤40 字符）`);
    }
    // 先经语义校验（失败即中止且不落盘），再持久化
    const reg = (() => {
      try {
        return registerTheme(opts.name, definition);
      } catch (err) {
        fail(err.message);
      }
    })();
    const { filePath } = saveUserTheme(opts.name, definition);
    console.log(JSON.stringify({
      ok: true,
      name: opts.name,
      saved: filePath,
      overriddenBuiltin: reg.overridden,
      usage: `nice-aos output --theme ${opts.name} --format html`,
    }, null, 2));
  });

themeCmd.command('list')
  .description('列出全部可用主题（内置 + 用户；用户主题标注 [user]，损坏文件标注 [broken]）')
  .action(() => {
    syncUserThemes();
    const rows = listThemeNames().map((n) => ({ name: n }));
    for (const u of listUserThemes()) {
      const row = rows.find((r) => r.name === u.name);
      if (row) Object.assign(row, u, { user: true });
      else rows.push({ ...u, user: true });
    }
    for (const r of rows) {
      if (r.error) console.log(`${r.name}\t[broken]\t${r.error}`);
      else console.log(`${r.name}\t${r.user ? '[user]' : '[builtin]'}\t${r.label ?? ''}${r.dark === false ? '（浅色）' : ''}`);
    }
  });

themeCmd.command('remove')
  .description('删除用户主题定义文件（内置主题不可删）')
  .argument('<name>', '主题名')
  .action((name) => {
    try {
      const { filePath } = removeUserTheme(name);
      console.error(`已删除: ${filePath}（下次调用 resolveTheme 时不再出现）`);
    } catch (err) {
      fail(err.message);
    }
  });

// ---------- v0.38 docs 子命令：三明治上下文文档树（context-builder skill 的 CLI 支撑） ----------
//
// nice-aos output docs
//   → .nice-aos/context/：L1 index.md / architecture.md / modules.md / domains/_index.md
//     + L2 domains/<slug>.md + L3 domains/<slug>/{components,routes,state,services}.md
//     + tree.json（目录树索引）+ docs.html（自包含浏览器，--format all）
// `nice-aos serve` 后访问 /docs 在线浏览。

const docsCmd = exportCommand.command('docs')
  .description('生成分层上下文文档树到 .nice-aos/context/（L1 顶层索引 / L2 领域索引 / L3 领域详情 + tree.json 索引；--format all 附自包含 docs.html 浏览器，配合 serve 的 /docs 在线浏览）')
  .option('--format <format>', '输出内容: all（默认；md 文档树 + tree.json + docs.html 浏览器）| md（仅 md 文档树 + tree.json，供 agent 消费）', 'all')
  .option('--output <dir>', '输出目录（默认 .nice-aos/context，相对当前目录）', path.join('.nice-aos', 'context'))
  .action((opts) => {
    // commander 限制：子命令与父命令（export）同名选项时，用户传参会落在父命令 opts
    // （与 serve.js 不重复定义 --snapshot-dir 同一类问题）——此处从两级 opts 中取有效值
    const parentOpts = exportCommand.opts();
    const format = [parentOpts.format, opts.format].find((v) => v === 'md' || v === 'all') ?? 'all';
    const outRaw = parentOpts.output ?? opts.output;
    const t0 = Date.now();
    const dataMap = loadSnapshot();
    const { files, tree, generated } = buildContextDocs(dataMap);
    const outDir = path.resolve(outRaw);
    fs.mkdirSync(outDir, { recursive: true });

    const written = [];
    for (const f of files) {
      const target = path.join(outDir, f.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.content, 'utf-8');
      written.push(target);
    }
    const treePath = path.join(outDir, 'tree.json');
    fs.writeFileSync(treePath, JSON.stringify(tree, null, 2), 'utf-8');
    written.push(treePath);

    if (format === 'all') {
      const docsPath = path.join(outDir, 'docs.html');
      fs.writeFileSync(docsPath, renderDocsHtml({ projectName: dataMap.Project?.[0]?.name ?? '' }), 'utf-8');
      written.push(docsPath);
    }

    for (const p of written) console.error(`已写入: ${p}`);
    const domains = (dataMap.Domain || []).length;
    const summary = {
      ok: true,
      outputDir: outDir,
      format,
      mdFiles: files.length,
      domains,
      treeFiles: tree.totalFiles,
      generated,
      elapsedMs: Date.now() - t0,
    };
    if (format === 'all') {
      summary.browse = 'nice-aos serve  # 启动后访问 /docs 在线浏览';
    }
    console.log(JSON.stringify(summary, null, 2));

    // 与 export 主命令一致：写盘后广播 serve（运行中才生效，静默降级）
    notifyServe({ dataDir: getSnapshotDir(), event: 'docs:changed', paths: written.slice(0, 20) })
      .then((r) => {
        if (r.notified) console.error('ℹ️  已通知运行中的 serve 广播 docs:changed');
      })
      .catch(() => { /* 网络层异常静默 */ });
  });
