import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isUserScriptCandidate } from './userScriptAnalyzer.js';

// 代码本体扫描的扩展名白名单：
//   - 9 种"主语言"（深度解析：组件/类/方法/路由/依赖）
//   - 9 种"配置/视图/SQL/部署"（轻量级：行数 + 顶层 key/标签/对象名）
// 后者由 configAnalyzer.js 处理；不进 import 解析、不进主 analyzer 的 AST 路径
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.vue', '.rs', '.dart', '.go', '.py', '.kt', '.kts', '.php',
  '.css', '.html', '.sql', '.yml', '.yaml',
  '.conf', '.toml', '.ini', '.env',
]);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-ssr', 'build', 'out',
  'coverage', '.next', '.nuxt', 'public', 'docs',
  '.codebuddy', '.codegraph', '.asdm', '.trae', '.claude',
  '.cursor', '.kiro', '.sisyphus', '.vscode', '.idea', '__pycache__',
  'android', 'ios', 'target', '.dart_tool', 'linux', 'macos', 'windows',
  'vendor', 'testdata', 'bin',
]);
// 产物目录名可能被业务用作源码目录名（如 RuoYi 的 src/views/tool/build/）：
// 位于 src/ 源码树内时不跳过；node_modules/.git 等其余跳过项恒跳过
const NAME_COLLISION_DIRS = new Set(['build']);

// 扫描根解析：显式 roots 优先；Flutter/Dart 项目（pubspec.yaml + lib/）优先扫 lib/；
// 否则 src/ 存在则扫 src/（同时把顶层几个高频配置文件加入扫描：.env* / Dockerfile* / index.html / *.config.{ts,js,mjs} / *.conf / *.yaml / *.yml）；
// 否则扫项目根（排除 SKIP_DIRS）
function resolveRoots(projectRoot, options) {
  if (Array.isArray(options.roots) && options.roots.length > 0) {
    return options.roots.filter((r) => fs.existsSync(path.join(projectRoot, r)));
  }
  if (fs.existsSync(path.join(projectRoot, 'pubspec.yaml')) && fs.existsSync(path.join(projectRoot, 'lib'))) {
    return ['lib'];
  }
  if (fs.existsSync(path.join(projectRoot, 'src'))) {
    // 默认 src/ 优先；同时把顶层几个高频配置文件 / 构建入口加入扫描——
    // 这些文件不在 src/ 内但是项目运行时/构建时的关键配置，缺它们会让 .env / Dockerfile / nginx.conf / 顶层 index.html / vite.config.ts 等漏统计
    return ['src', '.'];
  }
  return ['.'];
}

function walk(dir, projectRoot, files, seen = new Set()) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        const relDir = path.relative(projectRoot, full).split(path.sep).join('/');
        const inSourceTree = relDir.startsWith('src/');
        if (!(inSourceTree && NAME_COLLISION_DIRS.has(entry.name))) continue;
      }
      walk(full, projectRoot, files, seen);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      // .env / .env.development / .env.local 等点文件无标准扩展名（path.extname 对 ".env" 返回空，对 ".env.development" 返回 ".development"），
      // 单独按文件名匹配；统一加 "#env" 后缀，builder 据此规范化 ext 并路由到 configAnalyzer
      const lowerName = entry.name.toLowerCase();
      const isEnvFile = lowerName === '.env' || lowerName.startsWith('.env.');
      if (!isEnvFile && !SOURCE_EXTENSIONS.has(ext)) continue;
      if (entry.name.endsWith('.backup')) continue;
      const rel = path.relative(projectRoot, full).split(path.sep).join('/');
      const finalRel = isEnvFile ? `${rel}#env` : rel;
      if (seen.has(finalRel)) continue;
      seen.add(finalRel);
      files.push(finalRel);
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

// vue.config.js 的 configureWebpack.resolve.alias 文本解析（不 require，避免执行副作用/缺失依赖）：
// 支持 '@': resolve('src') / '@': path.resolve(__dirname, 'src') / '@': 'src' 三种值形式
function parseVueConfigAliases(vueConfigPath) {
  let text;
  try {
    text = fs.readFileSync(vueConfigPath, 'utf-8');
  } catch {
    return {};
  }
  const aliases = {};
  const valueRe = /^(?:resolve|path\.resolve)\(\s*(?:__dirname\s*,\s*)?['"]([^'"]+)['"]\s*\)$|^['"]([^'"]+)['"]$/;
  const aliasRe = /alias\s*:\s*\{/g;
  let m;
  while ((m = aliasRe.exec(text)) !== null) {
    let depth = 1;
    let end = m.index + m[0].length;
    while (end < text.length && depth > 0) {
      if (text[end] === '{') depth += 1;
      else if (text[end] === '}') depth -= 1;
      end += 1;
    }
    const block = text.slice(m.index + m[0].length, end - 1);
    const pairRe = /['"]([^'"]+)['"]\s*:\s*([^,\n}]+)/g;
    let p;
    while ((p = pairRe.exec(block)) !== null) {
      const hit = valueRe.exec(p[2].trim());
      if (!hit) continue;
      const target = hit[1] ?? hit[2];
      if (!target) continue;
      const key = p[1].endsWith('/*') ? p[1] : `${p[1]}/*`;
      const val = target.endsWith('/*') ? target : `${target}/*`;
      if (!(key in aliases)) aliases[key] = val;
    }
    aliasRe.lastIndex = end;
  }
  return aliases;
}

// unplugin-vue-components / unplugin-auto-import 的 dirs 自动注册目录解析（vite.config 词法解析，不 require）：
// Components({ dirs: [r('src/components'), './src/components/HomeCard'] })、AutoImport({ dirs: ['./src/utils/permission'] })
// 这些目录的组件/导出被模板与代码直接使用且无 import 记录（编译期自动注入），builder 豁免其孤儿候选
function parseViteUnpluginDirs(projectRoot, hostDir) {
  const configDirs = [projectRoot, hostDir].filter(Boolean);
  let text = null;
  let baseDir = projectRoot;
  for (const dir of configDirs) {
    for (const name of ['vite.config.mjs', 'vite.config.js', 'vite.config.ts']) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) {
        text = fs.readFileSync(p, 'utf-8');
        baseDir = dir;
        break;
      }
    }
    if (text !== null) break;
  }
  const result = { componentDirs: null, autoImportDirs: [] };
  if (text === null) return result;
  // 从 plugin 调用的选项对象中提取 dirs 数组（平衡大括号截取后正则）
  const extractDirs = (callName) => {
    const callRe = new RegExp(`\\b${callName}\\s*\\(\\s*\\{`);
    const m = callRe.exec(text);
    if (!m) return null;
    let depth = 1;
    let end = m.index + m[0].length;
    while (end < text.length && depth > 0) {
      if (text[end] === '{') depth += 1;
      else if (text[end] === '}') depth -= 1;
      end += 1;
    }
    const block = text.slice(m.index + m[0].length, end - 1);
    const dirsM = /\bdirs\s*:\s*\[/.exec(block);
    if (!dirsM) return null; // 未配置 dirs（Components 用默认 src/components；AutoImport 默认不扫目录）
    let bDepth = 1;
    let bEnd = dirsM.index + dirsM[0].length;
    while (bEnd < block.length && bDepth > 0) {
      if (block[bEnd] === '[') bDepth += 1;
      else if (block[bEnd] === ']') bDepth -= 1;
      bEnd += 1;
    }
    const arrText = block.slice(dirsM.index + dirsM[0].length, bEnd - 1);
    const dirs = [];
    const elRe = /(?:\br\(|\bresolve\(\s*__dirname\s*,\s*)?['"]([^'"]+)['"]/g;
    let e;
    while ((e = elRe.exec(arrText)) !== null) {
      let p = e[1].replace(/^\.\//, '');
      if (!p) continue;
      // 归一为扫描根相对路径（配置文件在宿主根、扫描根为其子目录时加前缀）
      if (baseDir !== projectRoot) {
        const rel = path.relative(projectRoot, baseDir).split(path.sep).join('/');
        if (rel && !rel.startsWith('..')) p = `${rel}/${p}`;
      }
      dirs.push(p.replace(/\/+$/, ''));
    }
    return dirs;
  };
  result.componentDirs = extractDirs('Components');
  result.autoImportDirs = extractDirs('AutoImport') ?? [];
  return result;
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

// go.mod 轻量文本解析：module 名、go 版本、require 依赖（分组块与单行形式；exclude/retract 块跳过）
function parseGoMod(goModPath) {
  const text = fs.readFileSync(goModPath, 'utf-8');
  let name = null;
  let goVersion = null;
  const deps = [];
  let section = null; // 'require' | 'exclude' | 'retract' | null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;
    if (line === 'require (') { section = 'require'; continue; }
    if (line === 'exclude (' || line === 'retract (') { section = line.slice(0, -2); continue; }
    if (line === ')') { section = null; continue; }
    if (section === 'require') {
      const m = /^(\S+)\s+(\S+)/.exec(line.replace(/\/\/.*$/, '').trim());
      if (m) deps.push({ name: m[1], version: m[2] });
      continue;
    }
    if (section) continue;
    if (line.startsWith('module ')) { name = line.slice(7).trim(); continue; }
    if (line.startsWith('go ')) { goVersion = line.slice(3).trim(); continue; }
    const m = /^require\s+(\S+)\s+(\S+)/.exec(line);
    if (m) deps.push({ name: m[1], version: m[2] });
  }
  return { name, goVersion, deps };
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
    if (fs.existsSync(path.join(dir, 'package.json')) || fs.existsSync(path.join(dir, 'pubspec.yaml')) || fs.existsSync(path.join(dir, 'go.mod'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // 已到文件系统根
    if (home && (dir === home || parent === home)) break; // 不越过用户 home
    dir = parent;
  }
  return null;
}

// go.mod 发现：根目录优先；否则从 .go 文件所在目录逐级向上（不越过 projectRoot）收集。
// 融合仓库（server/go.mod + web/ 前端）场景：go.mod 不在根也能识别为 Go 模块。
// projectRoot 树内无 go.mod 时再向上探测（上限 4 层、不越过 home）——用户定位到
// Go module 子目录（如 server/api）时 module 基准在上级，dir 以相对 projectRoot 路径表达（可含 '../'）
function discoverGoModuleDirs(projectRoot, goFiles) {
  const dirs = new Set();
  const addDir = (dir) => {
    if (fs.existsSync(path.join(projectRoot, dir === '' ? '.' : dir, 'go.mod'))) dirs.add(dir);
  };
  addDir('');
  for (const f of goFiles) {
    let dir = path.posix.dirname(f);
    for (let i = 0; i < 12; i += 1) {
      addDir(dir === '.' ? '' : dir);
      if (dir === '.' || dir === '') break;
      dir = path.posix.dirname(dir);
    }
  }
  if (dirs.size === 0) {
    let abs = path.resolve(projectRoot);
    const home = process.env.HOME ? path.resolve(process.env.HOME) : null;
    for (let i = 0; i < 4; i += 1) {
      const parent = path.dirname(abs);
      if (parent === abs) break;
      if (home && parent === home) break;
      abs = parent;
      if (fs.existsSync(path.join(abs, 'go.mod'))) {
        const rel = path.relative(path.resolve(projectRoot), abs).split(path.sep).join('/');
        if (rel) dirs.add(rel);
        break;
      }
    }
  }
  return [...dirs];
}

// 子项目发现：projectRoot 一级子目录含项目清单（package.json/go.mod/pubspec.yaml）且含源码。
// 融合仓库 / monorepo 场景：识别同级子项目（不自动并入扫描范围——显式 roots 仍是用户意图边界）
function discoverSubProjects(projectRoot) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(projectRoot, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const dir = path.join(projectRoot, e.name);
    const kind = fs.existsSync(path.join(dir, 'go.mod')) ? 'go'
      : fs.existsSync(path.join(dir, 'pubspec.yaml')) ? 'dart'
        : fs.existsSync(path.join(dir, 'package.json')) ? 'npm' : null;
    if (!kind) continue;
    const pkg = kind === 'npm' ? readJson(path.join(dir, 'package.json')) : null;
    out.push({ name: pkg?.name ?? e.name, path: e.name, kind });
  }
  return out;
}

// 仓库根定位：向上找 .git / monorepo 工作区清单（上限 4 层、不越过 home）。
// 普通目录（如代码集合目录）无这些标记 → null，防止误吸附无关邻居项目
function findRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  const home = process.env.HOME ? path.resolve(process.env.HOME) : null;
  for (let i = 0; i < 4; i += 1) {
    if (fs.existsSync(path.join(dir, '.git'))
      || fs.existsSync(path.join(dir, 'go.work'))
      || fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))
      || fs.existsSync(path.join(dir, 'lerna.json'))
      || fs.existsSync(path.join(dir, 'nx.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (home && (dir === home || parent === home)) break;
    dir = parent;
  }
  return null;
}

// 兄弟项目发现：定位仓库根后在其一级子目录中发现子项目，排除扫描目录自身与其祖先。
// 用户定位子项目（融合仓库 web/）或代码子目录（web/src）时，同级项目（server/）被识别报告；
// 不并入扫描范围与依赖清单——显式定位仍是用户意图边界
function discoverSiblingProjects(projectRoot) {
  const repoRoot = findRepoRoot(projectRoot);
  if (!repoRoot) return [];
  const absRoot = path.resolve(projectRoot);
  if (repoRoot === absRoot) return [];
  return discoverSubProjects(repoRoot).filter((sp) => {
    const spAbs = path.resolve(repoRoot, sp.path);
    return spAbs !== absRoot && !absRoot.startsWith(`${spAbs}${path.sep}`);
  });
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

// Node 入口识别：package.json bin/main 字段指向的文件（CLI / 工具库形态的真实入口）。
// 仅保留位于扫描根内的路径——bin 指向构建产物或根外文件时不在 fileObjects 中，标 entry 无意义
function resolveNodeEntryFiles(projectRoot, roots, packageJson) {
  const specs = [];
  const bin = packageJson?.bin;
  if (typeof bin === 'string') specs.push(bin);
  else if (bin && typeof bin === 'object') specs.push(...Object.values(bin).filter((v) => typeof v === 'string'));
  if (typeof packageJson?.main === 'string') specs.push(packageJson.main);
  const rootPrefixes = roots.map((r) => {
    const norm = String(r).replace(/\/+$/, '');
    return !norm || norm === '.' ? '' : `${norm}/`;
  });
  const out = new Set();
  for (const spec of specs) {
    if (!spec) continue;
    const rel = path.relative(projectRoot, path.resolve(projectRoot, spec)).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) continue;
    if (!rootPrefixes.some((p) => rel.startsWith(p))) continue;
    out.add(rel);
  }
  return [...out];
}

// 扫描根之外的测试引用收集：test/tests/__tests__/spec 等根级测试目录不在默认扫描范围，
// 其 import 对死代码判定不可见 → 轻量词法提取补充"真实使用"证据，
// 消除「仅被测试使用的导出/函数被判死」的误报（自扫描验证：42 个死导出中可证伪）
const EXTERNAL_TEST_DIRS = ['test', 'tests', '__tests__', 'spec'];
const EXTERNAL_TEST_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__', 'fixtures', 'snapshots']);
// 命名组：1 默认导入名 | 2 具名花括号 | 3 混合形式花括号 | 4 from specifier | 5 动态 import specifier | 6 require specifier
// 注意：specifier 字符类必须排除换行，否则正则会跨语句贪婪吞并（多行 import 场景下把后续代码当成路径）
const TEST_IMPORT_RE = /import\s+(?:([\w$]+)|(?:\{([^}]*)\})|(?:(?:[\w$]+)\s*,\s*(?:\{([^}]*)\}|\*\s+as\s+[\w$]+)))\s*from\s*['"]([^\n'"]+)['"]|import\s*\(\s*['"]([^\n'"]+)['"]\s*\)|require\s*\(\s*['"]([^\n'"]+)['"]\s*\)/g;

export function collectExternalTestImports(projectRoot, scannedFiles) {
  const scanned = new Set(scannedFiles);
  const probeExts = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '/index.ts', '/index.js'];
  const resolveSpecToScanned = (tFileRel, spec) => {
    if (!spec || !(spec.startsWith('./') || spec.startsWith('../'))) return [];
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(tFileRel), spec));
    const hits = [];
    for (const ext of probeExts) {
      const cand = `${base}${ext}`;
      if (scanned.has(cand)) hits.push(cand);
    }
    return hits;
  };

  // 递归收集外部测试目录下的 JS/TS 测试文件（相对 projectRoot 路径）
  function walkTestDir(absDir, dirRel, acc) {
    let list;
    try { list = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (e.name.startsWith('.') || EXTERNAL_TEST_SKIP.has(e.name)) continue;
      const absChild = path.join(absDir, e.name);
      const relChild = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isDirectory()) walkTestDir(absChild, relChild, acc);
      else if (/\.(m|c)?[jt]sx?$/.test(e.name)) acc.push(relChild);
    }
  }

  const extTestFiles = [];
  for (const dirName of EXTERNAL_TEST_DIRS) {
    // rel 必须带目录名前缀（如 'test/x.test.mjs'），specifier 才能以测试文件位置为基准解析
    walkTestDir(path.join(projectRoot, dirName), dirName, extTestFiles);
  }

  const importedFiles = new Set();
  const namedRefs = new Set();
  for (const tFile of extTestFiles) {
    let content;
    try { content = fs.readFileSync(path.join(projectRoot, tFile), 'utf-8'); } catch { continue; }
    TEST_IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = TEST_IMPORT_RE.exec(content))) {
      const spec = m[4] ?? m[5] ?? m[6];
      const hits = resolveSpecToScanned(tFile, spec);
      if (!hits.length) continue;
      for (const h of hits) importedFiles.add(h);
      // 具名导入 → 符号级引用证据（relPath#name），供导出符号/方法的死判定豁免
      for (const g of [m[2], m[3]]) {
        if (!g) continue;
        for (let part of g.split(',')) {
          part = part.trim().replace(/^\{|\}$/g, '').trim();
          if (!part) continue;
          const name = part.split(/\s+as\s+/)[0].split(/[:\s]/)[0].trim();
          if (!name) continue;
          for (const h of hits) namedRefs.add(`${h}#${name}`);
        }
      }
    }
  }

  return {
    testFileCount: extTestFiles.length,
    importedFiles: [...importedFiles],
    namedRefs: [...namedRefs],
  };
}

function detectFramework({ deps, configs, hostDir, packageJson, userScriptCount, codeSignals, flutterDetected, dartDetected, goDetected, phpDetected, kotlinDetected }) {
  // Flutter/Dart 客户端（pubspec.yaml + lib/）优先
  if (flutterDetected) return 'flutter';
  if (dartDetected) return 'dart';
  // Go 项目（go.mod + .go 源码）：CLI / agent / Gin 后端，混合仓库时 Go 后端为主体
  if (goDetected) return 'go';
  // PHP 项目（composer.json + .php 源码）：zentaopms / Laravel / Symfony 后端
  if (phpDetected) return 'php';
  // Kotlin 项目（build.gradle.kts + .kt 源码）：Android/JVM/KMP
  if (kotlinDetected) return 'kotlin';
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
  // Node.js CLI / 工具库：package.json 声明 bin 入口且无任何前端框架信号。
  // 必须先于 userscript 判定——CLI 仓库可能混入油猴脚本（如 contrib/ 示例），不应劫持整个仓库画像
  if (packageJson?.bin) return 'node-cli';
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
  // Go 框架变体（go.mod require）
  if (deps['github.com/gin-gonic/gin']) variants.push('gin');
  if (deps['github.com/spf13/cobra']) variants.push('cobra');
  return variants;
}

const FRAMEWORK_LABELS_FULL = {
  flutter: 'Flutter 应用',
  dart: 'Dart 应用',
  go: 'Go 应用',
  expo: 'React Native（Expo）',
  'react-native': 'React Native 应用',
  nuxt: 'Nuxt 应用',
  next: 'Next.js 应用',
  vue: 'Vue 单页应用',
  react: 'React 单页应用',
  'node-cli': 'Node.js CLI 工具',
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
  gin: 'Gin Web 框架',
  cobra: 'Cobra CLI',
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
  // walk 按 relPath 去重：resolveRoots 可能同时返回 'src' 和 '.'（. 包含 src），
  // 同一个文件被扫两次会污染统计与实体去重
  const seen = new Set();
  for (const root of roots) {
    walk(path.join(projectRoot, root), projectRoot, files, seen);
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
  // Vue CLI 项目补充：jsconfig.json paths 与 vue.config.js 的 configureWebpack.resolve.alias
  // （Vue CLI 项目常无 tsconfig，@ 别名仅存在于 vue.config.js / jsconfig.json）
  const ownVueConfig = path.join(projectRoot, 'vue.config.js');
  if (fs.existsSync(ownVueConfig)) {
    const jsconfigPath = path.join(projectRoot, 'jsconfig.json');
    const jsconfigPaths = fs.existsSync(jsconfigPath) ? parseTsconfigPaths(jsconfigPath) : {};
    const vueAliases = parseVueConfigAliases(ownVueConfig);
    for (const [k, v] of Object.entries(jsconfigPaths)) {
      if (!(k in tsconfigPaths)) tsconfigPaths[k] = v;
    }
    for (const [k, v] of Object.entries(vueAliases)) {
      if (!(k in tsconfigPaths)) tsconfigPaths[k] = v;
    }
    // vue-cli 兜底：有 vue.config.js 与 src/ 但仍未解析出 @ 别名时按惯例补默认值
    if (!('@/*' in tsconfigPaths) && fs.existsSync(path.join(projectRoot, 'src'))) {
      tsconfigPaths['@/*'] = 'src/*';
    }
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
  // 子项目发现：一级子目录的项目清单（package.json/go.mod/pubspec.yaml）。
  // npm 子项目的依赖并入画像（融合仓库 web/ 前端的 vue/pinia/element 等对框架判定与依赖清单有价值；
  // 名称冲突时主清单优先）。误吸附防护：无 .git、无根清单且子项目 >4 个视为代码集合目录，只报告不并入
  const subProjects = discoverSubProjects(projectRoot);
  const mergeSubDeps = fs.existsSync(path.join(projectRoot, '.git'))
    || Boolean(ownPackageJson) || hasOwnPubspec || fs.existsSync(path.join(projectRoot, 'go.mod'))
    || subProjects.length <= 4;
  if (mergeSubDeps) {
    for (const sp of subProjects) {
      if (sp.kind !== 'npm') continue;
      const pkg = readJson(path.join(projectRoot, sp.path, 'package.json'));
      for (const scope of ['dependencies', 'devDependencies']) {
        for (const [name, version] of Object.entries(pkg?.[scope] ?? {})) {
          if (!dependencies[name]) dependencies[name] = { version: String(version), scope, registry: 'npm', from: sp.path };
        }
      }
    }
  }
  // 兄弟项目发现：定位仓库根后识别同级项目（用户定位子项目/代码子目录场景）
  const siblingProjects = discoverSiblingProjects(projectRoot);

  const counts = { ts: 0, tsx: 0, js: 0, jsx: 0, vue: 0, rs: 0, dart: 0, go: 0, py: 0, kt: 0, kts: 0, php: 0, css: 0, html: 0, sql: 0, yml: 0, yaml: 0, conf: 0, toml: 0, ini: 0, env: 0 };
  for (const f of files) {
    const ext = path.extname(f).slice(1);
    if (counts[ext] !== undefined) counts[ext] += 1;
  }

  // go.mod（Go 项目）：根目录优先，否则从 .go 文件目录向上发现（融合仓库 server/go.mod 场景）。
  // 多模块并存时全部 require 并入依赖，主模块取 .go 文件数最多者（module 名供 import internal 判定）
  const goFilesList = files.filter((f) => f.endsWith('.go'));
  const goModuleDirs = discoverGoModuleDirs(projectRoot, goFilesList);
  let goModule = null;
  let goModuleDirCount = -1;
  const goAllDeps = [];
  for (const dir of goModuleDirs) {
    const mod = parseGoMod(path.join(projectRoot, dir === '' ? '.' : dir, 'go.mod'));
    const dirCount = dir === ''
      ? goFilesList.filter((f) => !f.includes('/')).length
      : goFilesList.filter((f) => f.startsWith(`${dir}/`)).length;
    goAllDeps.push(...mod.deps);
    if (dirCount > goModuleDirCount) {
      goModuleDirCount = dirCount;
      goModule = { ...mod, dir };
    }
  }
  for (const dep of goAllDeps) {
    if (!dependencies[dep.name]) dependencies[dep.name] = { version: dep.version, scope: 'require', registry: 'go' };
  }

  const allDeps = { ...(packageJson?.dependencies ?? {}), ...(packageJson?.devDependencies ?? {}), ...Object.keys(pubspecDeps).reduce((a, k) => { a[k] = pubspecDeps[k].version; return a; }, {}), ...Object.fromEntries(goAllDeps.map((d) => [d.name, d.version])) };
  // PHP / Kotlin 探测（composer.json / build.gradle.kts + 对应源码计数）
  const phpDetected = fs.existsSync(path.join(projectRoot, 'composer.json')) && counts.php > 0;
  const kotlinDetected = (fs.existsSync(path.join(projectRoot, 'build.gradle.kts'))
    || fs.existsSync(path.join(projectRoot, 'settings.gradle.kts'))) && (counts.kt + counts.kts) > 0;
  const framework = detectFramework({
    deps: allDeps,
    configs: hostConfigs,
    hostDir,
    packageJson,
    userScriptCount: userScriptFiles.size,
    codeSignals: { vueFileCount: counts.vue, tsxFileCount: counts.tsx, jsxFileCount: counts.jsx },
    flutterDetected: flutterDetected && Object.keys(pubspecDeps).includes('flutter'),
    dartDetected: flutterDetected && !Object.keys(pubspecDeps).includes('flutter'),
    goDetected: goModule !== null && counts.go > 0,
    phpDetected,
    kotlinDetected,
  });
  // unplugin-vue-components / unplugin-auto-import 自动注册目录（vite.config 词法解析）：
  // 依赖存在但未显式配置 dirs 时，unplugin-vue-components 默认扫描 src/components
  const unpluginDirs = parseViteUnpluginDirs(projectRoot, hostDir);
  const autoComponentDirs = !('unplugin-vue-components' in dependencies)
    ? []
    : (unpluginDirs.componentDirs ?? ['src/components']);
  const frameworkVariants = detectFrameworkVariants({ deps: allDeps, configs: hostConfigs });
  // 客户端组件发现结果并入变体（Tauri/Electron 桌面端）
  if (tauriDetected && !frameworkVariants.includes('tauri')) frameworkVariants.push('tauri');
  if (electronDetected && !frameworkVariants.includes('electron')) frameworkVariants.push('electron');

  // Node 入口（package.json bin/main，供 builder 判 isEntry）与外部测试引用（供死代码判定豁免）
  const nodeEntryFiles = resolveNodeEntryFiles(projectRoot, roots, packageJson);
  const testImports = collectExternalTestImports(projectRoot, files);

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
    nodeEntryFiles,
    testImports,
    tsFileCount: counts.ts,
    tsxFileCount: counts.tsx,
    jsFileCount: counts.js + counts.jsx,
    vueFileCount: counts.vue,
    rustFileCount: counts.rs,
    dartFileCount: counts.dart,
    goFileCount: counts.go,
    goDetected: goModule !== null && counts.go > 0,
    goModule: goModule ? { name: goModule.name, goVersion: goModule.goVersion, dir: goModule.dir } : null,
    goModuleDirs: goModuleDirs,
    pyFileCount: counts.py,
    kotlinFileCount: counts.kt + counts.kts,
    phpFileCount: counts.php,
    subProjects,
    siblingProjects,
    tauriDetected,
    electronDetected,
    flutterDetected,
    userScriptFiles,
    userScriptFileCount: userScriptFiles.size,
    tsconfigPaths,
    autoComponentDirs,
    autoImportDirs: unpluginDirs.autoImportDirs,
    dependencies,
    ...gitInfo(projectRoot),
  };
}
