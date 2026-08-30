// io 子命令：扫描快照中所有 method 的 IO 敏感 API 使用（数据流追踪的轻量版）。
// 借鉴 code-graph-rag 的 IO_SINKS 数据驱动注册表（src/ontology/ioRegistry.js）。
// 阶段 2.1 范围：JS/TS 静态扫描（油猴 GM_* + 浏览器 fetch/cookie/...），不做完整 taint propagation。
//
// 用法：
//   nice-aos io                              # 全部 IO 报告（low 以上）
//   nice-aos io --min-danger medium          # 只看 medium 以上
//   nice-aos io --kinds NETWORK               # 只看网络类
//   nice-aos io --format json

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { resolveSnapshotDirs, loadSnapshotFile } from '../shared.js';
import { scanSnapshotIOWithContent } from '../../analyzers/ioScanner.js';

export const ioCommand = new Command('io')
  .description('扫描快照中所有 method 的 IO 敏感 API 使用（借鉴 code-graph-rag 的 IO_SINKS 数据驱动注册表，v0.32.0 静态扫描版）')
  .option('--root <dir>', '项目根目录（默认当前目录）', process.cwd())
  .option('--dir <path>', '快照目录（默认 <root>/.nice-aos/data）')
  .option('--min-danger <level>', '最低危险等级：critical/high/medium/low/info（默认 low）', 'low')
  .option('--kinds <list>', '只看这些 ResourceKind（逗号分隔：STORAGE,NETWORK,DOM,STDOUT,SCRIPT）', (v) => v.split(','))
  .option('--format <fmt>', '输出格式：table / json', 'table')
  .option('--output <file>', '写入文件（默认 stdout）')
  .option('--limit <n>', '最大显示 method 数（默认 50）', (v) => Number(v), 50)
  .action((opts) => {
    const { root, dataDir } = resolveSnapshotDirs(opts);
    const snapPath = path.join(dataDir, 'snapshot.json');

    const loaded = loadSnapshotFile(snapPath);
    if (!loaded.ok) {
      if (loaded.error === 'NOT_FOUND') {
        console.error(`[错误] 快照未找到: ${snapPath}`);
        console.error('[提示] 请先执行: nice-aos action refreshRepo');
        process.exit(1);
      }
      console.error(`[错误] 快照加载失败: ${loaded.error}`);
      process.exit(1);
    }

    // 收集 fileContent（从 projectRoot 读；用 filePath 和 file:id 两种 key 都缓存）
    const fileContentCache = new Map();
    for (const f of loaded.snap.SourceFile ?? []) {
      const relPath = f.path || f.id.replace('file:', '');
      try {
        const content = fs.readFileSync(path.join(root, relPath), 'utf-8');
        fileContentCache.set(relPath, content);
        // 兼容 method.filePath 含 "src/x.ts" 而 SourceFile.id 是 "file:src/x.ts" 的情况
        if (f.id && !fileContentCache.has(f.id)) fileContentCache.set(f.id, content);
      } catch { /* skip */ }
    }

    const result = scanSnapshotIOWithContent(loaded.snap, fileContentCache, {
      minDanger: opts.minDanger,
      kinds: opts.kinds,
    });

    if (opts.format === 'json') {
      const out = {
        summary: result.summary,
        hits: [...result.byMethod.entries()].map(([methodId, hits]) => ({
          methodId,
          hits: hits.map((h) => ({
            callee: h.sink.callee,
            kind: h.sink.kind,
            direction: h.sink.direction,
            danger: h.sink.danger,
            desc: h.sink.desc,
            line: h.line,
            callText: h.callText,
          })),
        })),
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
    lines.push(`nice-aos io —— 敏感 API 使用扫描（IO_SINKS 数据驱动）`);
    lines.push(`  数据源: ${dataDir}`);
    lines.push(`  扫描方法: ${result.summary.totalMethodsScanned} 个`);
    lines.push(`  找到 IO 使用的方法: ${result.summary.methodsWithIO} 个  共 ${result.summary.totalIO} 次调用`);
    lines.push(`  按危险: critical=${result.summary.byDanger.critical}  high=${result.summary.byDanger.high}  medium=${result.summary.byDanger.medium}  low=${result.summary.byDanger.low}  info=${result.summary.byDanger.info}`);
    lines.push(`  按种类: STORAGE=${result.summary.byKind.STORAGE}  NETWORK=${result.summary.byKind.NETWORK}  DOM=${result.summary.byKind.DOM}  SCRIPT=${result.summary.byKind.SCRIPT}  STDOUT=${result.summary.byKind.STDOUT}`);
    if (opts.kinds) lines.push(`  过滤 kinds: ${opts.kinds.join(', ')}`);
    if (opts.minDanger !== 'low') lines.push(`  过滤 minDanger: ${opts.minDanger}`);
    lines.push('');

    // 按危险等级排序 method 列表
    const methodDangers = [...result.byMethod.entries()].map(([methodId, hits]) => {
      const maxDanger = hits.reduce((max, h) => {
        const r = h.sink.danger === 'critical' ? 4 : h.sink.danger === 'high' ? 3 : h.sink.danger === 'medium' ? 2 : h.sink.danger === 'low' ? 1 : 0;
        return r > max ? r : max;
      }, 0);
      return { methodId, hits, maxDanger };
    }).sort((a, b) => b.maxDanger - a.maxDanger).slice(0, opts.limit);

    if (methodDangers.length === 0) {
      lines.push('  ✓ 没有发现敏感 API 使用。');
    } else {
      for (const { methodId, hits } of methodDangers) {
        const method = loaded.snap.Method?.find((m) => m.id === methodId);
        lines.push(`  [${methodId}]`);
        if (method) {
          lines.push(`    ${method.filePath}:${method.line}  ${method.name}  (${method.ownerKind})`);
        }
        for (const h of hits) {
          lines.push(`      L${h.line}  ${h.sink.danger.padEnd(8)}  ${h.sink.kind.padEnd(7)}  ${h.sink.direction.padEnd(11)}  ${h.sink.callee}  — ${h.sink.desc}`);
        }
        lines.push('');
      }
      if (result.summary.methodsWithIO > opts.limit) {
        lines.push(`  ... 还有 ${result.summary.methodsWithIO - opts.limit} 个 method 超出 --limit ${opts.limit}，用 --format json 拿全量。`);
      }
    }
    const text = lines.join('\n');
    if (opts.output) fs.writeFileSync(opts.output, text, 'utf-8');
    else process.stdout.write(text + '\n');
  });
