import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isUserScriptCandidate } from './userScriptAnalyzer.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.vue']);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-ssr', 'build', 'out',
  'coverage', '.next', '.nuxt', 'public', 'docs',
  '.codebuddy', '.codegraph', '.asdm', '.trae', '.claude',
  '.cursor', '.kiro', '.sisyphus', '.vscode', '.idea', '__pycache__',
  'android', 'ios',
]);

// 扫描根解析：显式 roots 优先；否则 src/ 存在则扫 src/；否则扫项目根（排除 SKIP_DIRS）
function resolveRoots(projectRoot, options) {
  if (Array.isArray(options.roots) && options.roots.length > 0) {
    return options.roots.filter((r) => fs.existsSync(path.join(projectRoot, r)));
  }
  if (fs.existsSync(path.join(projectRoot, 'src'))) return ['src'];
  return ['.'];
}

function walk(dir, projectRoot, files) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, projectRoot, files);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (!SOURCE_EXTENSIONS.has(ext)) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      if (entry.name.endsWith('.backup')) continue;
      files.push(path.relative(projectRoot, full).split(path.sep).join('/'));
    }
  }
}

// 剥离 JSON 文件中的注释（// 行注释与 /* */ 块注释），字符串内的序列已保护
// 部分项目的 tsconfig.json 含注释（如 shadcn-vue CLI 生成的文件），标准 JSON.parse 会失败
function stripJsonComments(text) {
  let out = '';
  let i = 0;
  let inString = false;
  let quote = '';
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function readJson(filePath) {
  try {
    return JSON.parse(stripJsonComments(fs.readFileSync(filePath, 'utf-8')));
  } catch {
    return null;
  }
}

function parseTsconfigPaths(tsconfigPath) {
  const tsconfig = readJson(tsconfigPath);
  const paths = {};
  const compilerOptions = tsconfig?.compilerOptions;
  if (compilerOptions?.paths) {
    for (const [pattern, targets] of Object.entries(compilerOptions.paths)) {
      if (Array.isArray(targets) && targets.length > 0) {
        paths[pattern] = targets[0];
      }
    }
  }
  return paths;
}

function gitInfo(projectRoot) {
  try {
    const commitHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf-8' }).trim();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectRoot, encoding: 'utf-8' }).trim();
    return { commitHash, branch };
  } catch {
    return { commitHash: null, branch: null };
  }
}

function detectFramework(packageJson, userScriptCount) {
  const deps = { ...(packageJson?.dependencies ?? {}), ...(packageJson?.devDependencies ?? {}) };
  if (deps.vue) return 'vue';
  if (deps.nuxt) return 'vue';
  if (deps.react) return 'react';
  // 无前端框架依赖但存在油猴脚本 → 纯脚本仓库（React/Vue 项目与油猴脚本混合时仍以宿主框架为准）
  if (userScriptCount > 0) return 'userscript';
  return 'unknown';
}

export function scanProject(projectRoot, options = {}) {
  const roots = resolveRoots(projectRoot, options);
  const files = [];
  for (const root of roots) {
    walk(path.join(projectRoot, root), projectRoot, files);
  }
  files.sort();

  // 油猴脚本探测：.user.js 扩展名，或 .js 文件头部含 ==UserScript== 元数据块（仅读首 4KB）
  const userScriptFiles = new Set();
  for (const f of files) {
    if (!/\.m?js$/.test(f)) continue;
    if (isUserScriptCandidate(path.join(projectRoot, f))) userScriptFiles.add(f);
  }

  const packageJson = readJson(path.join(projectRoot, 'package.json'));
  const tsconfigPaths = parseTsconfigPaths(path.join(projectRoot, 'tsconfig.json'));
  const dependencies = {};
  for (const scope of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = packageJson?.[scope] ?? {};
    for (const [name, version] of Object.entries(deps)) {
      dependencies[name] = { version: String(version), scope };
    }
  }

  const counts = { ts: 0, tsx: 0, js: 0, jsx: 0, vue: 0 };
  for (const f of files) {
    const ext = path.extname(f).slice(1);
    if (counts[ext] !== undefined) counts[ext] += 1;
  }

  return {
    root: projectRoot,
    roots,
    name: packageJson?.name ?? path.basename(projectRoot),
    version: packageJson?.version ?? null,
    framework: detectFramework(packageJson, userScriptFiles.size),
    files,
    fileCount: files.length,
    tsFileCount: counts.ts,
    tsxFileCount: counts.tsx,
    jsFileCount: counts.js + counts.jsx,
    vueFileCount: counts.vue,
    userScriptFiles,
    userScriptFileCount: userScriptFiles.size,
    tsconfigPaths,
    dependencies,
    ...gitInfo(projectRoot),
  };
}
