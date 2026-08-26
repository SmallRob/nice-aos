// deadcode 子命令：基于 entry-point BFS 找出"导出但不可达"的 class。
// 借鉴 code-graph-rag 的 `cgr dead-code` 模式（docs/guide/dead-code.md）。
// 阶段 1.2 范围：仅 class dead（method / interface 留 v0.34.0 扩展——method 误报风险高，FC default export BFS 找不到 framework 调用）。
//
// 用法：
//   nice-aos deadcode                              # 读 <root>/.nice-aos/data
//   nice-aos deadcode --dir path/to/data          # 自定义快照目录
//   nice-aos deadcode -e route.main -e util.foo   # 显式 entry point
//   nice-aos deadcode --format json              # JSON envelope

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { getSnapshotDirOverride } from '../../paths.js';
import { findDeadExported, markDeadCandidates } from '../../analyzers/deadCode.js';

function resolveDirs(opts) {
  const root = path.resolve(opts.root || process.cwd());
  const explicitDir = opts.dir || getSnapshotDirOverride() || process.env.NICE_AOS_SNAPSHOT_DIR;
  const dataDir = explicitDir ? path.resolve(explicitDir) : path.join(root, '.nice-aos', 'data');
  return { root, dataDir };
}

function loadSnapshot(snapPath) {
  if (!fs.existsSync(snapPath)) return { ok: false, error: 'NOT_FOUND' };
  try {
    return { ok: true, snap: JSON.parse(fs.readFileSync(snapPath, 'utf-8')) };
  } catch (err) {
    return { ok: false, error: `PARSE_FAILED: ${err?.message ?? err}` };
  }
}

export const deadcodeCommand = new Command('deadcode')
  .description('基于 entry-point BFS 找出"导出但不可达"的 class（借鉴 code-graph-rag 的 cgr dead-code 算法）')
  .option('--root <dir>', '项目根目录（默认当前目录）', process.cwd())
  .option('--dir <path>', '快照目录（默认 <root>/.nice-aos/data）')
  .option('-e, --entry-point <id>', '显式声明入口（可多次，repeatable）', (v, prev) => [...(prev || []), v], [])
  .option('--entry-file <rel>', '显式声明额外入口文件（repeatable）', (v, prev) => [...(prev || []), v], [])
  .option('--format <fmt>', '输出格式：table（默认） / json', 'table')
  .option('--output <file>', '写入文件（默认 stdout）')
  .option('--write-back', '把 dead 信息写回到 snapshot（标记 deadCandidate 字段）', false)
  .action((opts) => {
    const { root, dataDir } = resolveDirs(opts);
    const snapPath = path.join(dataDir, 'snapshot.json');

    const loaded = loadSnapshot(snapPath);
    if (!loaded.ok) {
      if (loaded.error === 'NOT_FOUND') {
        console.error(`[错误] 快照未找到: ${snapPath}`);
        console.error('[提示] 请先执行: nice-aos action refreshRepo');
        process.exit(1);
      }
      console.error(`[错误] 快照加载失败: ${loaded.error}`);
      process.exit(1);
    }

    let snap = loaded.snap;
    let writeBackResult = null;
    if (opts.writeBack) {
      // 写回前先深拷贝（避免在 readonly JSON.parse 结果上修改失败）
      snap = JSON.parse(JSON.stringify(snap));
      const marked = markDeadCandidates(snap, {
        extraEntryIds: opts.entryPoint,
        entryFiles: opts.entryFile,
      });
      writeBackResult = { marked, outputPath: snapPath };
      fs.writeFileSync(snapPath, JSON.stringify(snap, null, 2), 'utf-8');
    }

    const result = findDeadExported(snap, {
      extraEntryIds: opts.entryPoint,
      entryFiles: opts.entryFile,
    });

    if (opts.format === 'json') {
      const out = {
        stats: result.stats,
        deadClasses: result.deadClasses,
        ...(writeBackResult ? { writeBack: writeBackResult } : {}),
        timestamp: new Date().toISOString(),
        dataDir,
        projectRoot: root,
      };
      const text = JSON.stringify(out, null, 2);
      if (opts.output) fs.writeFileSync(opts.output, text, 'utf-8');
      else process.stdout.write(text + '\n');
      return;
    }

    // table 输出
    const lines = [];
    lines.push(`nice-aos deadcode —— 死代码检测（entry-point BFS）`);
    lines.push(`  数据源: ${dataDir}`);
    lines.push(`  节点总数: ${result.stats.nodesTotal}  可达: ${result.stats.nodesReachable}  根: ${result.stats.rootsCount}`);
    lines.push(`  死代码: ${result.deadClasses.length} 个 exported class`);
    lines.push('');
    if (opts.entryPoint.length) lines.push(`  显式 entry-points: ${opts.entryPoint.join(', ')}`);
    if (opts.entryFile.length) lines.push(`  显式 entry-files: ${opts.entryFile.join(', ')}`);
    if (writeBackResult) lines.push(`  已写回: ${writeBackResult.marked} 个 class 标 deadCandidate=${true} → ${writeBackResult.outputPath}`);
    lines.push('');

    if (result.deadClasses.length === 0) {
      lines.push('  ✓ 没有发现 dead exported class。');
    } else {
      for (let i = 0; i < result.deadClasses.length; i += 1) {
        const c = result.deadClasses[i];
        lines.push(`  [${i + 1}] ${c.id}`);
        lines.push(`      ${c.filePath}:${c.line}  class ${c.name}`);
        lines.push(`      原因: ${c.reason}`);
        lines.push('');
      }
    }
    lines.push(`  提示: 加 --write-back 把 dead 信息写回 snapshot 供下游消费；--format json 输出结构化报告。`);
    const text = lines.join('\n');
    if (opts.output) fs.writeFileSync(opts.output, text, 'utf-8');
    else process.stdout.write(text + '\n');
  });
