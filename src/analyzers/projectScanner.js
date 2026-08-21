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

// HTML 入口探测：收集扫描根及其所在项目目录顶层 *.html 的 <script src="/src/xxx.tsx"> 引用
// （Vite 多页应用，如与 src 同级的 managed-agent.html），指向的源码文件为硬证据入口
// （嵌套 main.tsx 等文件名启发式覆盖不到的场景）
function collectHtmlEntryFiles(projectRoot, roots) {
  const searchDirs = new Map(); // dir -> true
  for (const root of roots) {
    const rootDir = path.resolve(projectRoot, root);
    searchDirs.set(rootDir, true);
    searchDirs.set(path.dirname(rootDir), true); // 扫描 src/ 时宿主根顶层的 HTML（Vite 约定位置）
  }
  const htmlFiles = [];
  for (const dir of searchDirs.keys()) {
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch { continue; }
    for (const n of names) {
      if (n.isFile() && n.name.endsWith('.html')) htmlFiles.push(path.join(dir, n.name));
    }
  }
  const entries = new Set();
  for (const htmlPath of htmlFiles) {
    let text = '';
    try {
      text = fs.readFileSync(htmlPath, 'utf-8');
    } catch { continue; }
    for (const m of text.matchAll(/<script[^>]*\ssrc=["']([^"']+\.[cm]?[jt]sx?)["']/g)) {
      const src = m[1];
      if (!src.startsWith('/')) continue; // 仅处理根绝对路径引用（Vite 约定）
      const rel = src.slice(1);
      if (fs.existsSync(path.join(projectRoot, rel))) entries.add(rel);
    }
  }
  return [...entries];
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

// tsconfig paths 解析：solution 风格 tsconfig（根文件仅含 references）时合并引用的子配置 paths，
// 子配置相对 tsconfig 所在目录解析；引用不存在或读取失败时静默跳过
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
  const baseDir = path.dirname(tsconfigPath);
  for (const ref of tsconfig?.references ?? []) {
    if (!ref?.path) continue;
    const refPath = ref.path.endsWith('.json')
      ? path.resolve(baseDir, ref.path)
      : path.resolve(baseDir, ref.path, 'tsconfig.json');
    if (refPath === path.resolve(tsconfigPath)) continue; // 自引用防御
    for (const [pattern, target] of Object.entries(parseTsconfigPaths(refPath))) {
      if (!(pattern in paths)) paths[pattern] = target; // 根 paths 优先
    }
  }
  return paths;
}

// tsconfig 别名目标重定基：宿主 tsconfig 的 targets（如 "./src/*"）相对宿主根，
// 扫描根嵌在其内（如 host/src）时剥离扫描根前缀，使 "@/services" 在扫描 src 时正确映射到 "services"
function rebaseTsconfigPaths(paths, scanRelInHost) {
  if (!scanRelInHost || scanRelInHost === '.' || scanRelInHost.startsWith('..')) return paths;
  const prefix = `${scanRelInHost}/`;
  const out = {};
  for (const [pattern, target] of Object.entries(paths)) {
    let t = target;
    while (t.startsWith('./')) t = t.slice(2);
    if (t === scanRelInHost) {
      out[pattern] = '.';
    } else if (t.startsWith(prefix)) {
      // "./src/*" → "./*"（保持相对形态，由 importResolver 归一）
      out[pattern] = `./${t.slice(prefix.length)}`;
    } else {
      out[pattern] = t;
    }
  }
  return out;
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

// 宿主项目定位：扫描目录（如 src/ 子目录）自身无 package.json 时，向上查找最近的宿主项目根，
// 用于框架识别、依赖清单与项目名回退。上限 4 层且不越过用户 home（避免误吸附无关的祖先 package.json）
function findHostProjectDir(startDir) {
  let dir = path.resolve(startDir);
  const home = process.env.HOME ? path.resolve(process.env.HOME) : null;
  for (let i = 0; i < 4; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // 已到文件系统根
    if (home && (dir === home || parent === home)) break; // 不越过用户 home
    dir = parent;
  }
  return null;
}

// 宿主配置文件探测（src 同级）：框架识别的旁证信号 + Project.hostConfigs 证据清单
const HOST_CONFIG_FILES = [
  'capacitor.config.ts', 'capacitor.config.js', 'capacitor.config.json',
  'app.json', 'app.config.js', 'app.config.ts',
  'react-native.config.js',
  'next.config.js', 'next.config.ts', 'next.config.mjs',
  'nuxt.config.ts', 'nuxt.config.js',
  'vite.config.ts', 'vite.config.js', 'vite.config.mjs',
  'electron-builder.yml', 'electron-builder.json',
];

function detectHostConfigs(hostDir) {
  if (!hostDir) return [];
  const found = [];
  try {
    for (const name of fs.readdirSync(hostDir)) {
      if (HOST_CONFIG_FILES.includes(name)) found.push(name);
      if (name === 'electron' && fs.statSync(path.join(hostDir, name)).isDirectory()) found.push('electron/');
    }
  } catch { /* 宿主目录不可读时忽略 */ }
  return found.sort();
}

// Expo 旁证：app.json 含 expo 键（Expo 项目约定），弥补仅依赖 package.json 时扫描子目录的盲区
function isExpoAppJson(hostDir, configs) {
  if (!hostDir || !configs.includes('app.json')) return false;
  const appJson = readJson(path.join(hostDir, 'app.json'));
  return Boolean(appJson?.expo);
}

function detectFramework({ deps, configs, hostDir, userScriptCount, codeSignals }) {
  // 元框架优先（依赖更具体的信号，react/vue 基座只作兜底）
  if (deps.expo) return 'expo';
  if (deps['react-native']) return 'react-native';
  if (deps.nuxt) return 'nuxt';
  if (deps.next) return 'next';
  if (deps.vue) return 'vue';
  if (deps.react) return 'react';
  // 无 package.json（或无框架依赖）时用宿主配置文件旁证
  if (isExpoAppJson(hostDir, configs)) return 'expo';
  // 代码信号兜底：.vue 文件 → vue；tsx/jsx 组件文件 → react（扫描目录无任何清单时的启发式）
  if (codeSignals.vueFileCount > 0) return 'vue';
  if (codeSignals.tsxFileCount + codeSignals.jsxFileCount > 0) return 'react';
  if (userScriptCount > 0) return 'userscript';
  return 'unknown';
}

// 构建工具 / 跨端容器变体（不改变主框架语义，作为画像补充）
function detectFrameworkVariants({ deps, configs }) {
  const variants = [];
  if (deps['@capacitor/core'] || configs.some((c) => c.startsWith('capacitor.config'))) variants.push('capacitor');
  if (deps.electron || configs.includes('electron/') || configs.some((c) => c.startsWith('electron-builder'))) variants.push('electron');
  if (deps.vite || configs.some((c) => c.startsWith('vite.config'))) variants.push('vite');
  if (deps.webpack || configs.some((c) => c.startsWith('webpack.config'))) variants.push('webpack');
  return variants;
}

const FRAMEWORK_LABELS_FULL = {
  expo: 'React Native（Expo）',
  'react-native': 'React Native 应用',
  nuxt: 'Nuxt 应用',
  next: 'Next.js 应用',
  vue: 'Vue 单页应用',
  react: 'React 单页应用',
  userscript: '油猴脚本集合',
  unknown: '前端项目',
};
const VARIANT_LABELS = {
  capacitor: 'Capacitor 跨端',
  electron: 'Electron 桌面端',
  vite: 'Vite 构建',
  webpack: 'Webpack 构建',
};

// 组合展示标签：React 单页应用 + Capacitor 跨端（Vite 构建）
function composeFrameworkLabel(framework, variants) {
  const base = FRAMEWORK_LABELS_FULL[framework] ?? framework;
  if (!variants.length) return base;
  const labels = variants.map((v) => VARIANT_LABELS[v] ?? v);
  return `${base} + ${labels[0]}${labels.length > 1 ? `（${labels.slice(1).join('、')}）` : ''}`;
}

export function scanProject(projectRoot, options = {}) {
  const roots = resolveRoots(projectRoot, options);
  const files = [];
  for (const root of roots) {
    walk(path.join(projectRoot, root), projectRoot, files);
  }
  files.sort();
  const htmlEntryFiles = collectHtmlEntryFiles(projectRoot, roots);

  // 油猴脚本探测：.user.js 扩展名，或 .js 文件头部含 ==UserScript== 元数据块（仅读首 4KB）
  const userScriptFiles = new Set();
  for (const f of files) {
    if (!/\.m?js$/.test(f)) continue;
    if (isUserScriptCandidate(path.join(projectRoot, f))) userScriptFiles.add(f);
  }

  // 宿主项目定位：扫描目录自身有 package.json 优先（monorepo 子包）；
  // 否则向上查找宿主根（如扫描 src/ 时定位项目根），读取 src 同级配置文件辅助框架识别
  const ownPackageJson = readJson(path.join(projectRoot, 'package.json'));
  const hostDir = ownPackageJson ? projectRoot : findHostProjectDir(projectRoot);
  const packageJson = ownPackageJson ?? (hostDir ? readJson(path.join(hostDir, 'package.json')) : null);
  const hostConfigs = detectHostConfigs(hostDir);

  // tsconfig 路径别名：扫描目录自身优先，缺失时回退宿主根（src/ 子目录扫描场景，@/ 别名依赖宿主 tsconfig）
  const ownTsconfigPath = path.join(projectRoot, 'tsconfig.json');
  let tsconfigPaths = {};
  let tsconfigBase = projectRoot;
  if (fs.existsSync(ownTsconfigPath)) {
    tsconfigPaths = parseTsconfigPaths(ownTsconfigPath);
  } else if (hostDir && fs.existsSync(path.join(hostDir, 'tsconfig.json'))) {
    tsconfigPaths = parseTsconfigPaths(path.join(hostDir, 'tsconfig.json'));
    tsconfigBase = hostDir;
  }
  if (tsconfigBase !== projectRoot) {
    const rel = path.relative(tsconfigBase, projectRoot).split(path.sep).join('/');
    tsconfigPaths = rebaseTsconfigPaths(tsconfigPaths, rel);
  }
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

  const allDeps = { ...(packageJson?.dependencies ?? {}), ...(packageJson?.devDependencies ?? {}) };
  const framework = detectFramework({
    deps: allDeps,
    configs: hostConfigs,
    hostDir,
    userScriptCount: userScriptFiles.size,
    codeSignals: { vueFileCount: counts.vue, tsxFileCount: counts.tsx, jsxFileCount: counts.jsx },
  });
  const frameworkVariants = detectFrameworkVariants({ deps: allDeps, configs: hostConfigs });

  return {
    root: projectRoot,
    roots,
    name: packageJson?.name ?? path.basename(projectRoot),
    version: packageJson?.version ?? null,
    framework,
    frameworkVariants,
    frameworkLabel: composeFrameworkLabel(framework, frameworkVariants),
    hostRoot: hostDir && hostDir !== projectRoot ? hostDir : null,
    hostConfigs,
    files,
    fileCount: files.length,
    htmlEntryFiles,
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
