import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isUserScriptCandidate } from './userScriptAnalyzer.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.vue', '.rs', '.dart']);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-ssr', 'build', 'out',
  'coverage', '.next', '.nuxt', 'public', 'docs',
  '.codebuddy', '.codegraph', '.asdm', '.trae', '.claude',
  '.cursor', '.kiro', '.sisyphus', '.vscode', '.idea', '__pycache__',
  'android', 'ios', 'target', '.dart_tool', 'linux', 'macos', 'windows',
]);

// 扫描根解析：显式 roots 优先；Flutter/Dart 项目（pubspec.yaml + lib/）优先扫 lib/；
// 否则 src/ 存在则扫 src/；否则扫项目根（排除 SKIP_DIRS）
function resolveRoots(projectRoot, options) {
  if (Array.isArray(options.roots) && options.roots.length > 0) {
    return options.roots.filter((r) => fs.existsSync(path.join(projectRoot, r)));
  }
  if (fs.existsSync(path.join(projectRoot, 'pubspec.yaml')) && fs.existsSync(path.join(projectRoot, 'lib'))) {
    return ['lib'];
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
      if (entry.name.endsWith('.backup')) continue;
      files.push(path.relative(projectRoot, full).split(path.sep).join('/'));
    }
  }
}

// 客户端组件自动发现：Tauri（src-tauri/tauri.conf.json → 追加 src-tauri/src）、
// Electron（electron/ 目录含 ts/js 源码 → 追加 electron）与 Flutter（pubspec.yaml + lib/ 含 .dart 源码 → 追加 lib）。
// 显式 roots 传参时同样自动追加——这些配置是构建工具约定的强信号，用户期望客户端组件随扫描自动包含
function discoverClientComponentRoots(projectRoot, baseRoots) {
  const extras = new Set();
  const pushRel = (absDir) => {
    const rel = path.relative(projectRoot, absDir).split(path.sep).join('/');
    if (rel && !rel.startsWith('..')) extras.add(rel);
  };
  const hasSourceFiles = (dir) => {
    const stack = [[dir, 0]];
    while (stack.length) {
      const [d, depth] = stack.pop();
      if (depth > 3) continue;
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) stack.push([path.join(d, e.name), depth + 1]);
        } else if (/\.(tsx?|jsx?)$/.test(e.name) && !e.name.endsWith('.d.ts')) return true;
      }
    }
    return false;
  };
  const findTauri = (dir, depth) => {
    if (depth > 3) return;
    if (fs.existsSync(path.join(dir, 'src-tauri', 'tauri.conf.json'))) {
      pushRel(path.join(dir, 'src-tauri', 'src'));
      return;
    }
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      findTauri(path.join(dir, e.name), depth + 1);
    }
  };
  const findElectron = (dir, depth) => {
    if (depth > 2) return;
    const eDir = path.join(dir, 'electron');
    try {
      if (fs.statSync(eDir).isDirectory() && hasSourceFiles(eDir)) pushRel(eDir);
    } catch { /* 不存在则跳过 */ }
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      findElectron(path.join(dir, e.name), depth + 1);
    }
  };
  // Flutter/Dart 包：pubspec.yaml + lib/（monorepo 多包时递归发现每个子包）
  const hasDartFiles = (dir) => {
    const stack = [[dir, 0]];
    while (stack.length) {
      const [d, depth] = stack.pop();
      if (depth > 4) continue;
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) stack.push([path.join(d, e.name), depth + 1]);
        } else if (e.name.endsWith('.dart')) return true;
      }
    }
    return false;
  };
  const findFlutter = (dir, depth) => {
    if (depth > 3) return;
    if (fs.existsSync(path.join(dir, 'pubspec.yaml')) && fs.existsSync(path.join(dir, 'lib'))) {
      if (hasDartFiles(path.join(dir, 'lib'))) pushRel(path.join(dir, 'lib'));
      return;
    }
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      findFlutter(path.join(dir, e.name), depth + 1);
    }
  };
  const bases = new Set([projectRoot, ...baseRoots.map((r) => path.resolve(projectRoot, r))]);
  for (const base of bases) {
    findTauri(base, 0);
    findElectron(base, 0);
    findFlutter(base, 0);
  }
  return [...extras];
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

// pubspec.yaml 依赖解析（行级解析，避免引入 yaml 依赖）：
// dependencies / dev_dependencies 下的缩进键值对；无值键 + 子键行（flutter: sdk: flutter）拼接为版本
function parsePubspecDeps(pubspecPath) {
  const text = fs.readFileSync(pubspecPath, 'utf-8');
  const deps = {};
  let current = null;
  let pending = null; // 无值键（如 flutter:），等子键行（sdk: flutter）拼接版本
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine; // CRLF 行尾归一
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const sectionM = /^([A-Za-z_][A-Za-z0-9_]*):\s*$/.exec(line);
    if (sectionM) {
      current = sectionM[1];
      pending = null;
      continue;
    }
    if (!current || !['dependencies', 'dev_dependencies'].includes(current)) continue;
    const m = /^\s{1,}([A-Za-z_][A-Za-z0-9_]*):\s*(\S.*)?$/.exec(line);
    if (!m) continue;
    const name = m[1];
    const raw = (m[2] ?? '').trim();
    if (pending) {
      // 前一个无值键（flutter:）的子键行：sdk: flutter → version = 'sdk: flutter'
      deps[pending] = { version: raw ? `${name}: ${raw}` : 'sdk', scope: current === 'dependencies' ? 'dependencies' : 'devDependencies', registry: 'pub' };
      pending = null;
      continue;
    }
    if (!raw) { pending = name; continue; }
    let version = raw;
    if ((version.startsWith('"') && version.endsWith('"')) || (version.startsWith("'") && version.endsWith("'"))) {
      version = version.slice(1, -1);
    }
    deps[name] = { version, scope: current === 'dependencies' ? 'dependencies' : 'devDependencies', registry: 'pub' };
  }
  return deps;
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

// 宿主项目定位：扫描目录（如 src/ 或 lib/ 子目录）自身无 package.json/pubspec.yaml 时，
// 向上查找最近的宿主项目根，用于框架识别、依赖清单与项目名回退。
// 上限 4 层且不越过用户 home（避免误吸附无关的祖先清单）
function findHostProjectDir(startDir) {
  let dir = path.resolve(startDir);
  const home = process.env.HOME ? path.resolve(process.env.HOME) : null;
  for (let i = 0; i < 4; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json')) || fs.existsSync(path.join(dir, 'pubspec.yaml'))) return dir;
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

function detectFramework({ deps, configs, hostDir, userScriptCount, codeSignals, flutterDetected, dartDetected }) {
  // Flutter/Dart 客户端（pubspec.yaml + lib/）优先
  if (flutterDetected) return 'flutter';
  if (dartDetected) return 'dart';
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
  // Flutter 状态管理 / 路由库变体（pubspec 依赖）
  if (deps.flutter_riverpod || deps.riverpod || deps.hooks_riverpod) variants.push('riverpod');
  if (deps.provider) variants.push('provider');
  if (deps.flutter_bloc || deps.bloc) variants.push('bloc');
  if (deps.get || deps.getx) variants.push('getx');
  if (deps.go_router) variants.push('go_router');
  return variants;
}

const FRAMEWORK_LABELS_FULL = {
  flutter: 'Flutter 应用',
  dart: 'Dart 应用',
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
  tauri: 'Tauri 桌面端',
  vite: 'Vite 构建',
  webpack: 'Webpack 构建',
  riverpod: 'Riverpod 状态管理',
  provider: 'Provider 状态管理',
  bloc: 'Bloc 状态管理',
  getx: 'GetX 状态管理',
  go_router: 'GoRouter 路由',
};

// 组合展示标签：React 单页应用 + Capacitor 跨端（Vite 构建）
function composeFrameworkLabel(framework, variants) {
  const base = FRAMEWORK_LABELS_FULL[framework] ?? framework;
  if (!variants.length) return base;
  const labels = variants.map((v) => VARIANT_LABELS[v] ?? v);
  return `${base} + ${labels[0]}${labels.length > 1 ? `（${labels.slice(1).join('、')}）` : ''}`;
}

export function scanProject(projectRoot, options = {}) {
  const baseRoots = resolveRoots(projectRoot, options);
  const clientRoots = discoverClientComponentRoots(projectRoot, baseRoots);
  const roots = [...baseRoots];
  for (const r of clientRoots) {
    if (!roots.includes(r)) roots.push(r);
  }
  const tauriDetected = clientRoots.some((r) => r.includes('src-tauri'));
  const electronDetected = clientRoots.some((r) => /(^|\/)electron$/.test(r));
  const pubspecPath = fs.existsSync(path.join(projectRoot, 'pubspec.yaml'))
    ? path.join(projectRoot, 'pubspec.yaml')
    : null;
  const flutterDetected = clientRoots.some((r) => /(^|\/)lib$/.test(r))
    && (pubspecPath !== null || clientRoots.some((r) => fs.existsSync(path.join(projectRoot, path.dirname(r), 'pubspec.yaml'))));
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

  // 宿主项目定位：扫描目录自身有 package.json/pubspec.yaml 优先（monorepo 子包）；
  // 否则向上查找宿主根（如扫描 src/ 时定位项目根），读取 src 同级配置文件辅助框架识别
  const ownPackageJson = readJson(path.join(projectRoot, 'package.json'));
  const hasOwnPubspec = pubspecPath !== null;
  const hostDir = (ownPackageJson || hasOwnPubspec) ? projectRoot : findHostProjectDir(projectRoot);
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
      dependencies[name] = { version: String(version), scope, registry: 'npm' };
    }
  }
  // pubspec.yaml 依赖（Flutter/Dart 项目，pub 源）；pubspecName 用于项目名与 package: 自引用解析
  const pubspecDeps = pubspecPath ? parsePubspecDeps(pubspecPath) : {};
  let pubspecName = null;
  if (pubspecPath) {
    const nameM = /^name:\s*(\S+)/m.exec(fs.readFileSync(pubspecPath, 'utf-8'));
    pubspecName = nameM ? nameM[1].replace(/^['"]|['"]$/g, '') : null;
  }
  for (const [name, info] of Object.entries(pubspecDeps)) {
    if (!dependencies[name]) dependencies[name] = info;
  }

  const counts = { ts: 0, tsx: 0, js: 0, jsx: 0, vue: 0, rs: 0, dart: 0 };
  for (const f of files) {
    const ext = path.extname(f).slice(1);
    if (counts[ext] !== undefined) counts[ext] += 1;
  }

  const allDeps = { ...(packageJson?.dependencies ?? {}), ...(packageJson?.devDependencies ?? {}), ...Object.keys(pubspecDeps).reduce((a, k) => { a[k] = pubspecDeps[k].version; return a; }, {}) };
  const framework = detectFramework({
    deps: allDeps,
    configs: hostConfigs,
    hostDir,
    userScriptCount: userScriptFiles.size,
    codeSignals: { vueFileCount: counts.vue, tsxFileCount: counts.tsx, jsxFileCount: counts.jsx },
    flutterDetected: flutterDetected && Object.keys(pubspecDeps).includes('flutter'),
    dartDetected: flutterDetected && !Object.keys(pubspecDeps).includes('flutter'),
  });
  const frameworkVariants = detectFrameworkVariants({ deps: allDeps, configs: hostConfigs });
  // 客户端组件发现结果并入变体（Tauri/Electron 桌面端）
  if (tauriDetected && !frameworkVariants.includes('tauri')) frameworkVariants.push('tauri');
  if (electronDetected && !frameworkVariants.includes('electron')) frameworkVariants.push('electron');

  return {
    root: projectRoot,
    roots,
    name: packageJson?.name ?? pubspecName ?? path.basename(projectRoot),
    pubspecName,
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
    rustFileCount: counts.rs,
    dartFileCount: counts.dart,
    tauriDetected,
    electronDetected,
    flutterDetected,
    userScriptFiles,
    userScriptFileCount: userScriptFiles.size,
    tsconfigPaths,
    dependencies,
    ...gitInfo(projectRoot),
  };
}
