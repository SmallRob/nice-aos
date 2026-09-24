// 分析器注册表（v0.47，借鉴 asdm-aos registry.ts 的进程内简化版——协议级 stdio 插件留待需要时演进）：
//   此前"扩展名/谓词 → 分析器"的分发链在 builderScanPhase（集合/扩展名判定，FromDisk 签名）
//   与 buildSingleFileOntology（文件名谓词判定，fileName/content 签名）重复维护两份，
//   新增语言要改两处（arch-review F2 类问题）。收敛到单一注册表：
//     - match({ diskPath, ext, scan })：scan 为 null 表示单文件模式（谓词判定），否则走扫描集合判定
//     - fromDisk(diskPath, projectRoot, ext)：全量扫描路径（relPath 相对 projectRoot）
//     - single(absFilePath, fileName, dir)：单文件模式路径（保持既有 fileName/content 形态，行为零变化）
//   顺序敏感：与既有两处分发链的判定顺序逐一对应（rust → go → dart → py → kt → php → vue →
//   userScript → shell → cmake → pkgbuild → nix → config → ts 默认）。
//   registerAnalyzer(entry) 追加到默认项之前，作为进程内扩展点（测试/下游项目注入新语言分析器）。

import fs from 'node:fs';
import { analyzeFileFromDisk } from './tsAnalyzer.js';
import { analyzeVueFileFromDisk } from './vueAnalyzer.js';
import { analyzeUserScriptFromDisk, isUserScriptCandidate } from './userScriptAnalyzer.js';
import { analyzeRustFile, analyzeRustFileFromDisk } from './rustAnalyzer.js';
import { analyzeDartFile, analyzeDartFileFromDisk } from './dartAnalyzer.js';
import { analyzeGoFile, analyzeGoFileFromDisk } from './goAnalyzer.js';
import { analyzePythonFile, analyzePythonFileFromDisk } from './pythonAnalyzer.js';
import { analyzeKotlinFile, analyzeKotlinFileFromDisk } from './kotlinAnalyzer.js';
import { analyzePhpFile, analyzePhpFileFromDisk } from './phpAnalyzer.js';
import { analyzeShellScriptFromDisk, isShellScriptCandidate } from './shellScriptAnalyzer.js';
import { analyzeCMakeFromDisk, isCMakeCandidate } from './cmakeAnalyzer.js';
import { analyzePkgbuildFromDisk, isPkgbuildCandidate } from './pkgbuildAnalyzer.js';
import { analyzeNixFromDisk, isNixCandidate } from './nixAnalyzer.js';
import { analyzeConfigFileFromDisk } from './configAnalyzer.js';
import { CONFIG_EXTS } from '../ontology/builderUtils.js';

const BUILTIN_ENTRIES = [
  {
    name: 'rust',
    match: ({ diskPath }) => diskPath.endsWith('.rs'),
    fromDisk: (p, root) => analyzeRustFileFromDisk(p, root),
    single: (abs, name) => analyzeRustFile(name, fs.readFileSync(abs, 'utf-8')),
  },
  {
    name: 'go',
    match: ({ diskPath }) => diskPath.endsWith('.go'),
    fromDisk: (p, root) => analyzeGoFileFromDisk(p, root),
    single: (abs, name) => analyzeGoFile(name, fs.readFileSync(abs, 'utf-8')),
  },
  {
    name: 'dart',
    match: ({ diskPath }) => diskPath.endsWith('.dart'),
    fromDisk: (p, root) => analyzeDartFileFromDisk(p, root),
    single: (abs, name) => analyzeDartFile(name, fs.readFileSync(abs, 'utf-8')),
  },
  {
    name: 'python',
    match: ({ diskPath }) => diskPath.endsWith('.py'),
    fromDisk: (p, root) => analyzePythonFileFromDisk(p, root),
    single: (abs, name) => analyzePythonFile(name, fs.readFileSync(abs, 'utf-8')),
  },
  {
    name: 'kotlin',
    match: ({ diskPath }) => diskPath.endsWith('.kt') || diskPath.endsWith('.kts'),
    fromDisk: (p, root) => analyzeKotlinFileFromDisk(p, root),
    single: (abs, name) => analyzeKotlinFile(name, fs.readFileSync(abs, 'utf-8')),
  },
  {
    name: 'php',
    match: ({ diskPath }) => diskPath.endsWith('.php'),
    fromDisk: (p, root) => analyzePhpFileFromDisk(p, root),
    single: (abs, name) => analyzePhpFile(name, fs.readFileSync(abs, 'utf-8')),
  },
  {
    name: 'vue',
    match: ({ diskPath }) => diskPath.endsWith('.vue'),
    fromDisk: (p, root) => analyzeVueFileFromDisk(p, root),
    single: (abs, name, dir) => analyzeVueFileFromDisk(name, dir),
  },
  {
    name: 'user-script',
    match: ({ diskPath, scan }) => (scan ? scan.userScriptFiles?.has(diskPath) : isUserScriptCandidate(diskPath)),
    fromDisk: (p, root) => analyzeUserScriptFromDisk(p, root),
    single: (abs, name, dir) => analyzeUserScriptFromDisk(name, dir),
  },
  {
    name: 'shell',
    match: ({ diskPath, scan }) => (scan ? scan.shellScriptFiles?.has(diskPath) : isShellScriptCandidate(diskPath)),
    fromDisk: (p, root) => analyzeShellScriptFromDisk(p, root),
    single: (abs, name, dir) => analyzeShellScriptFromDisk(name, dir),
  },
  {
    name: 'cmake',
    match: ({ diskPath, scan }) => (scan ? scan.cmakeFiles?.has(diskPath) : isCMakeCandidate(diskPath)),
    fromDisk: (p, root) => analyzeCMakeFromDisk(p, root),
    single: (abs, name, dir) => analyzeCMakeFromDisk(name, dir),
  },
  {
    name: 'pkgbuild',
    match: ({ diskPath, scan }) => (scan ? scan.pkgbuildFiles?.has(diskPath) : isPkgbuildCandidate(diskPath)),
    fromDisk: (p, root) => analyzePkgbuildFromDisk(p, root),
    single: (abs, name, dir) => analyzePkgbuildFromDisk(name, dir),
  },
  {
    name: 'nix',
    match: ({ diskPath, scan }) => (scan ? scan.nixFiles?.has(diskPath) : isNixCandidate(diskPath)),
    fromDisk: (p, root) => analyzeNixFromDisk(p, root),
    single: (abs, name, dir) => analyzeNixFromDisk(name, dir),
  },
  {
    // config 仅在全量扫描链生效（.env.* 的规范化 ext 由 builderScan 传入）；
    // 单文件模式保持历史行为走 tsAnalyzer 默认路径
    name: 'config',
    match: ({ ext, scan }) => scan != null && CONFIG_EXTS.has(ext),
    fromDisk: (p, root, ext) => analyzeConfigFileFromDisk(p, root, ext),
    single: (abs, name, dir, ext) => analyzeConfigFileFromDisk(name, dir, ext),
  },
];

// 追加扩展（进程内扩展点）：新条目插在 config 之后、ts 默认之前。
// 约定：entry = { name, match(ctx), fromDisk(diskPath, projectRoot, ext), single?(absFilePath, fileName, dir, ext) }
const extraEntries = [];

export function registerAnalyzer(entry) {
  if (!entry || typeof entry.match !== 'function' || typeof entry.fromDisk !== 'function') {
    throw new Error('registerAnalyzer 需要 { name, match, fromDisk }');
  }
  extraEntries.push(entry);
  return () => { const i = extraEntries.indexOf(entry); if (i >= 0) extraEntries.splice(i, 1); };
}

export function resetRegisteredAnalyzers() {
  extraEntries.length = 0;
}

export function listAnalyzers() {
  return [...BUILTIN_ENTRIES, ...extraEntries].map((e) => e.name).concat(['ts(default)']);
}

// 按序判定返回首个命中的条目；未命中返回 null（tsAnalyzer 默认路径，由调用方兜底）
export function resolveAnalyzer({ diskPath, ext, scan }) {
  const ctx = { diskPath, ext, scan };
  for (const entry of [...BUILTIN_ENTRIES, ...extraEntries]) {
    try {
      if (entry.match(ctx)) return entry;
    } catch { /* 谓词异常视同未命中，交由默认路径 */ }
  }
  return null;
}
