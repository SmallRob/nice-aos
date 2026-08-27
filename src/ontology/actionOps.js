// 动作共享操作层（v0.35.0，E-3 技术债收敛）：refreshRepo / analyzeFile 的核心实现。
//
// 消费方：
//   - blueprint.js createBlueprintV2().actionImpls —— 动态 import 本模块（保持蓝图模块轻量、
//     规避 ontology ↔ analyzers/builder 链路上的静态循环依赖）
//   - src/cli/commands/serve.js POST /action —— 传 opts.saveTo 把快照落到 serve 自己的数据源目录
//   （src/cli/commands/action.js 保持自带实现不变：其版本含步骤化进度输出与 projectRoot 元数据，
//    属于 CLI 专属形态，两处注释互指防漂移）
//
// 设计要点：
//   - builder.js 重量级（引全部 analyzer）：本模块作为唯一静态加载点，供多消费方共享模块缓存
//   - 落盘策略可注入：默认走全局快照目录链（ontology/snapshot.js saveSnapshot）；serve 场景传 saveTo

import fs from 'node:fs';
import path from 'node:path';
import { detectProjectRoot } from '../analyzers/projectRootDetector.js';
import { buildOntologyData, buildSingleFileOntology } from './builder.js';
import { saveSnapshot } from './snapshot.js';

/**
 * 解析 refreshRepo 动作的项目根。
 * 与 src/cli/commands/action.js 的优先级一致：
 *   显式 repoPath/projectPath > 文件路径所在目录向上检测 / 目录直接检测 > cwd 向上检测 > cwd 兜底
 * 无 marker 的目录仍允许（纯油猴脚本场景，同 action.js fallback 语义）。
 *
 * @param {object} [params] 动作参数（取 repoPath / projectPath）
 * @returns {{ ok: true, projectPath: string } | { ok: false, message: string }}
 */
export function resolveActionProjectRoot(params = {}) {
  const explicitPath = params.repoPath ?? params.projectPath ?? null;
  let startPath;
  if (explicitPath) {
    startPath = path.resolve(String(explicitPath));
    if (!fs.existsSync(startPath)) return { ok: false, message: `路径不存在: ${startPath}` };
    startPath = fs.statSync(startPath).isFile() ? path.dirname(startPath) : startPath;
  } else {
    startPath = process.cwd();
  }
  const detected = detectProjectRoot(startPath);
  const projectPath = detected ? detected.root : startPath;
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    return { ok: false, message: `项目路径不是目录: ${projectPath}` };
  }
  return { ok: true, projectPath };
}

function summarizeCounts(dataMap) {
  return Object.fromEntries(
    Object.entries(dataMap).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]),
  );
}

/**
 * refreshRepo 核心：重新分析项目并产出本体快照。
 *
 * @param {object} [input] 动作参数（repoPath/projectPath + buildOntologyData 扫描选项透传）
 * @param {object} [opts]
 * @param {string} [opts.saveTo] 显式落盘文件路径（serve 数据源目录场景）；缺省走全局快照目录链
 * @returns {Promise<{ok:boolean, message:string, snapshot?:string, stats?:Object, cycles?:number, orphanCandidates?:number}>}
 */
export async function runRefreshRepo(input = {}, opts = {}) {
  const rootCheck = resolveActionProjectRoot(input);
  if (!rootCheck.ok) return rootCheck;
  const dataMap = await buildOntologyData(rootCheck.projectPath, { ...input });
  let snapFile;
  if (opts.saveTo) {
    fs.mkdirSync(path.dirname(opts.saveTo), { recursive: true });
    fs.writeFileSync(opts.saveTo, JSON.stringify(dataMap), 'utf-8');
    snapFile = opts.saveTo;
  } else {
    snapFile = saveSnapshot(dataMap);
  }
  const meta = dataMap._meta ?? {};
  const project = dataMap.Project?.[0];
  return {
    ok: true,
    message: `已重新分析 ${project?.name ?? path.basename(rootCheck.projectPath)}（${project?.fileCount ?? '?'} 个源文件，${meta.durationMs ?? '?'}ms）`,
    snapshot: snapFile,
    stats: meta.objectCounts ?? {},
    cycles: Array.isArray(meta.cycles) ? meta.cycles.length : 0,
    orphanCandidates: Array.isArray(meta.orphanCandidates) ? meta.orphanCandidates.length : 0,
  };
}

/**
 * analyzeFile 核心：单文件本体分析（纯只读，不落盘）。
 *
 * @param {{file?: string, path?: string}} [input] file 或 path 二选一
 * @returns {Promise<{ok:boolean, message:string, file?:string, stats?:Object}>}
 */
export async function runAnalyzeFile(input = {}) {
  const file = input.file ?? input.path;
  if (!file) return { ok: false, message: '缺少参数 file（相对 cwd 或绝对路径）' };
  const filePath = path.resolve(String(file));
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return { ok: false, message: `文件不存在或不是普通文件: ${filePath}` };
  }
  const dataMap = await buildSingleFileOntology(filePath);
  return {
    ok: true,
    message: `已完成单文件分析: ${path.basename(filePath)}`,
    file: filePath,
    stats: summarizeCounts(dataMap),
  };
}
