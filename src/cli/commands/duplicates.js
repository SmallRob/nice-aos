// duplicates 子命令：扫描快照中的 method 重复（结构相同的函数）。
// 借鉴 code-graph-rag 的 `cgr duplicates` 模式（docs/guide/duplicates.md）：
//   - 输入：snapshot.json
//   - 算法：group-by astFingerprint（O(n) 分组，零 pairwise）
//   - 报告：克隆组（exact match + 节点数辅助判断）
//   - JSON envelope：{ groups, skippedMethods, truncated }
//   - 阶段 1.3 仅实现 exact 模式；v0.33.0 扩展 similarity 阈值（基于 branch fingerprint）
//
// 用法：
//   nice-aos duplicates                       # 读 <root>/.nice-aos/data
//   nice-aos duplicates --dir path/to/data   # 自定义快照目录
//   nice-aos duplicates --min-size 30         # 只报告 ≥30 节点（默认 15）
//   nice-aos duplicates --format json         # JSON 输出（供 agent 消费）

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { resolveSnapshotDirs, loadSnapshotFile } from '../shared.js';
import { groupByFingerprint } from '../../ontology/fingerprint.js';

/**
 * 从 snapshot 收集 method 元数据 + fingerprint。
 * 仅 ownerKind in {class, module} 的 method（interface signature 无 body，跳过）。
 */
function collectMethods(snap) {
  const methods = snap.Method ?? [];
  const items = [];
  let skippedNoFingerprint = 0;
  for (const m of methods) {
    if (!m.astFingerprint) {
      skippedNoFingerprint += 1;
      continue;
    }
    items.push({
      id: m.id,
      name: m.name,
      filePath: m.filePath,
      startLine: m.line,
      endLine: m.line, // method entity 没存 end line; 暂用 line 占位
      fingerprint: m.astFingerprint,
      nodes: m.astFingerprintNodes ?? 0,
    });
  }
  return { items, skippedNoFingerprint };
}

export const duplicatesCommand = new Command('duplicates')
  .description('扫描本体快照中的结构重复函数（AST fingerprint 群组分析）—— 借鉴 code-graph-rag 的 cgr duplicates 算法')
  .option('--root <dir>', '项目根目录（默认当前目录）', process.cwd())
  .option('--dir <path>', '快照目录（默认 <root>/.nice-aos/data）')
  .option('--min-size <n>', '最小方法节点数（默认 15，过滤 trivial getter/wrapper）', (v) => Number(v), 15)
  .option('--format <fmt>', '输出格式：table（默认） / json', 'table')
  .option('--output <file>', '写入文件（默认 stdout）')
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

    // 收集
    const { items, skippedNoFingerprint } = collectMethods(loaded.snap);

    // min-size 过滤
    const filtered = items.filter((m) => m.nodes >= opts.minSize);

    // group-by
    const fpMap = new Map();
    const meta = [];
    for (const m of filtered) {
      fpMap.set(m.id, { fingerprint: m.fingerprint, nodes: m.nodes });
      meta.push({ id: m.id, name: m.name, filePath: m.filePath, startLine: m.startLine, endLine: m.endLine });
    }
    const groups = groupByFingerprint(fpMap, meta);

    // 输出
    if (opts.format === 'json') {
      const out = {
        scannedMethods: items.length,
        skippedNoFingerprint,
        minSize: opts.minSize,
        groups,
        truncated: false, // v0.32.0 无截断（规模小）
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
    lines.push(`nice-aos duplicates —— 重复代码检测`);
    lines.push(`  数据源: ${dataDir}`);
    lines.push(`  扫描方法: ${items.length} 个（跳过 ${skippedNoFingerprint} 个无 fingerprint）`);
    lines.push(`  过滤: 节点数 ≥ ${opts.minSize}（剩 ${filtered.length} 个）`);
    lines.push(`  找到重复组: ${groups.length} 个`);
    lines.push('');

    if (groups.length === 0) {
      lines.push('  ✓ 没有发现重复函数。');
    } else {
      for (let i = 0; i < groups.length; i += 1) {
        const g = groups[i];
        lines.push(`  组 #${i + 1}  fingerprint=${g.fingerprint.slice(0, 12)}…  ${g.members.length} 个成员（节点数 ${g.nodeCount}）`);
        for (const m of g.members) {
          lines.push(`    ${m.filePath}:${m.startLine}  ${m.name}  (id: ${m.id})`);
        }
        lines.push('');
      }
    }
    lines.push(`  提示: 加入 --min-size 调整阈值；--format json 输出结构化报告。`);
    const text = lines.join('\n');
    if (opts.output) fs.writeFileSync(opts.output, text, 'utf-8');
    else process.stdout.write(text + '\n');
  });
