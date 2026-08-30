// CMake 构建脚本（.cmake + CMakeLists.txt）专用解析器
// 与 tsAnalyzer / vueAnalyzer / userScriptAnalyzer / shellScriptAnalyzer 平级共存、逻辑完全独立。
//
// 设计要点：
//   - 实体类型:CMakeTarget（add_executable / add_library / add_custom_target）、
//               CMakeFunction（function / macro）、CMakeOption（option NAME "desc" DEFAULT）、
//               CMakeModule（被 include() 的 .cmake 文件；当前文件本体也算一个 CMakeModule）
//   - 边类型:
//       subdirIncludes      add_subdirectory(<dir>)
//       includesModule      include(<module>)  / include_guard()
//       declaresOption      option(...)
//       linksTo             target_link_libraries(<tgt> ...)
//       addsDependency      add_dependencies(<tgt> <tgt>)
//       targetsInclude      target_include_directories(<tgt> ...)
//       fetchesDep          FetchContent_Declare(<name> ...)
//       findsPackage        find_package(<name>)
//       callsFunction       CMakeFunction 之间的调用
//   - 文件候选:.cmake 强匹配；CMakeLists.txt（无扩展名）
//   - 噪声剥离:# 行注释 / [[...]] 跨行注释 / "..." 字符串 / [=[...]=] 跨行字符串
//   - 输出 shape 与 userScriptAnalyzer / shellScriptAnalyzer 同形（imports / classes / routes 等置空壳供 builder 复用）

import path from 'node:path';
import { lineOf, analyzeFileFromDisk, findMatchingParen } from './textUtils.js';

// ---------------------------------------------------------------------------
// 候选检测
// ---------------------------------------------------------------------------

export function isCMakeCandidate(absFilePath) {
  const base = path.basename(absFilePath);
  if (base === 'CMakeLists.txt') return true;
  if (base.toLowerCase().endsWith('.cmake')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 噪声剥离（保留行号、列号）
// ---------------------------------------------------------------------------

function stripNoise(content) {
  let out = '';
  let i = 0;
  const n = content.length;
  while (i < n) {
    const c = content[i];
    const nx = content[i + 1];
    // 行注释
    if (c === '#') {
      while (i < n && content[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    // [[ ... ]] 跨行注释（CMake 3.19+）
    if (c === '[' && nx === '[') {
      // 区分 [[...]] 注释与数组起始；CMake 数组终止是 ]](配对)
      // 简化:任何 [[ 都视为注释开始(数组用 cmake_parse_arguments 模式,很少出现裸 [[)
      // 但 set(VAR [[...]] 实际合法,需要看是否为裸 [[ (不在括号内)
      // 启发:如果 [[ 后续不是 =,认为是注释
      const nn = content[i + 2];
      if (nn !== '=') {
        i += 2;
        while (i < n && !(content[i] === ']' && content[i + 1] === ']')) {
          out += content[i] === '\n' ? '\n' : ' '; i++;
        }
        if (i < n) { out += '  '; i += 2; }
        continue;
      }
    }
    // [=[ ... ]=] 跨行注释 / 字符串
    if (c === '[' && nx === '=') {
      let eq = 1;
      while (i + 1 + eq < n && content[i + 1 + eq] === '=') eq++;
      const endMark = ']'.padEnd(eq + 1, '=');
      i += 1 + eq;
      while (i < n && !content.startsWith(endMark, i)) {
        out += content[i] === '\n' ? '\n' : ' '; i++;
      }
      if (i < n) { out += ' '.repeat(endMark.length); i += endMark.length; }
      continue;
    }
    // 字符串(双引号)
    if (c === '"') {
      out += c; i++;
      while (i < n && content[i] !== '"') {
        if (content[i] === '\\' && i + 1 < n) { out += '  '; i += 2; continue; }
        out += content[i] === '\n' ? '\n' : ' '; i++;
      }
      if (i < n) { out += '"'; i++; }
      continue;
    }
    // 变量引用 ${...} / $ENV{...} 替换为空(避免误识别内部字符)
    if (c === '$' && (nx === '{' || (nx === '<' && content[i + 2] !== '<'))) {
      const end = nx === '{' ? '}' : '>';
      out += c; i++;
      out += nx; i++;
      while (i < n && content[i] !== end) { out += content[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += end; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 括号配对（findMatchingParen 收敛于 textUtils；CMake 用 ( ) 作为函数调用边界）
// 解析参数列表
// ---------------------------------------------------------------------------

// 给定 ( ... ) 内部字符串,按顶层逗号切分;支持嵌套 ( ) / " " / [=[ ]=]
function splitArgs(inner) {
  const out = [];
  let buf = '';
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"') { inStr = !inStr; buf += c; continue; }
    if (inStr) { buf += c; continue; }
    if (c === '(' || c === '[') { depth++; buf += c; continue; }
    if (c === ')' || c === ']') { depth--; buf += c; continue; }
    if (c === ',' && depth === 0) { out.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// 去掉最外层引号
function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// 抽所有形如 NAME( ... ) 的顶层调用
// 返回 [{name, args: [...], start, end, line}]
function findTopLevelCalls(stripped) {
  const calls = [];
  const re = /([A-Za-z_][\w]*)\s*\(/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const name = m[1];
    const start = m.index;
    const parenStart = m.index + m[0].length - 1;
    const parenEnd = findMatchingParen(stripped, parenStart);
    if (parenEnd < 0) continue;
    const inner = stripped.slice(parenStart + 1, parenEnd);
    const args = splitArgs(inner);
    calls.push({ name, args, start, end: parenEnd + 1, line: lineOf(stripped, start) });
    re.lastIndex = parenEnd + 1;
  }
  return calls;
}

// ---------------------------------------------------------------------------
// 实体抽取
// ---------------------------------------------------------------------------

// 抽 add_executable / add_library / add_custom_target
// CMake 语法:函数调用参数用空格分隔,不是逗号。c.args[0] 可能是整段空格分隔
function findTargets(calls) {
  const out = [];
  for (const c of calls) {
    if (c.name === 'add_executable' && c.args[0]) {
      const name = unquote(c.args[0].split(/\s+/)[0]);
      out.push({ name, kind: 'executable', line: c.line });
    } else if (c.name === 'add_library' && c.args[0]) {
      // 形如 add_library(<name> [STATIC|SHARED|MODULE|OBJECT|INTERFACE] [source...])
      const tokens = c.args[0].split(/\s+/).map(unquote);
      const name = tokens[0];
      const second = tokens[1] ?? '';
      const kind = /^(STATIC|SHARED|MODULE|OBJECT|INTERFACE|UNKNOWN)$/i.test(second) ? second.toUpperCase() : 'STATIC';
      out.push({ name, kind, line: c.line });
    } else if (c.name === 'add_custom_target' && c.args[0]) {
      const name = unquote(c.args[0].split(/\s+/)[0]);
      out.push({ name, kind: 'custom', line: c.line });
    }
  }
  return out;
}

// 抽 function / macro
function findFunctions(calls) {
  const out = [];
  for (const c of calls) {
    if ((c.name === 'function' || c.name === 'macro') && c.args[0]) {
      // function (name arg1 arg2 ...) 允许空格或 () 包裹
      const tokens = c.args[0].split(/\s+/).map(unquote);
      const name = tokens[0];
      const params = tokens.slice(1);
      out.push({ name, kind: c.name === 'function' ? 'function' : 'macro', params, line: c.line });
    }
  }
  return out;
}

// 抽 option(NAME "description" DEFAULT) - 直接从 content 解析(更稳)
// option 的 args 用空白分隔,不是逗号。description 仅按引号形态识别——
// 无引号布尔默认值（option(X ON)）不再被误作 description；description 整体可省略
function findOptionsFromContent(content) {
  const out = [];
  const re = /^\s*option\s*\(\s*([A-Za-z_][\w]*)\s*(?:"([^"]*)"\s*)?([A-Za-z_][\w-]*)?\s*\)/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    out.push({
      name: m[1],
      description: m[2] ?? null,
      default: m[3] ?? null,
      line: lineOf(content, m.index),
    });
  }
  return out;
}

// 抽 set(NAME VALUE) 顶层 - 从 content 抽(去字符串破坏)
function findSetsFromContent(content) {
  const out = [];
  const re = /^\s*set\s*\(\s*([A-Za-z_][\w]*)\s+("[^"]+"|[A-Za-z_][\w]*)/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    if (name.startsWith('CMAKE_') || name.startsWith('_')) continue;
    const value = (m[2] || '').replace(/^"|"$/g, '');
    if (/^(ON|OFF|TRUE|FALSE)$/i.test(value)) {
      out.push({ name, value: value.toUpperCase(), line: lineOf(content, m.index) });
    }
  }
  return out;
}

// 抽 set(NAME VALUE) 顶层有意义的(忽略 CMAKE_* / _saved_* 临时变量)
// 注意:findSets 在主入口已改用 findSetsFromContent,这里删除 findOptions/findSets 旧实现

// 抽 include(<module>) / include_guard(GLOBAL)
function findIncludes(calls) {
  const out = [];
  for (const c of calls) {
    if (c.name === 'include' && c.args[0]) {
      out.push({ module: unquote(c.args[0]), line: c.line });
    } else if (c.name === 'include_guard') {
      out.push({ module: 'GLOBAL', line: c.line, kind: 'guard' });
    }
  }
  return out;
}

// 抽 add_subdirectory(<dir>)
function findSubdirectories(calls) {
  const out = [];
  for (const c of calls) {
    if (c.name === 'add_subdirectory' && c.args[0]) {
      out.push({ dir: unquote(c.args[0]), line: c.line });
    }
  }
  return out;
}

// 抽 target_link_libraries(<tgt> <lib1> <lib2> ...)
function findTargetLinkLibraries(calls) {
  const out = [];
  for (const c of calls) {
    if (c.name === 'target_link_libraries' && c.args[0]) {
      const target = unquote(c.args[0]);
      // 跳过 PUBLIC/PRIVATE/INTERFACE 修饰
      const libs = c.args.slice(1).map(unquote).filter((x) => !/^(PUBLIC|PRIVATE|INTERFACE)$/i.test(x));
      out.push({ target, libs, line: c.line });
    }
  }
  return out;
}

// 抽 add_dependencies(<tgt> <dep> ...)
function findDependencies(calls) {
  const out = [];
  for (const c of calls) {
    if (c.name === 'add_dependencies' && c.args[0]) {
      const target = unquote(c.args[0]);
      const deps = c.args.slice(1).map(unquote);
      out.push({ target, deps, line: c.line });
    }
  }
  return out;
}

// 抽 target_include_directories(<tgt> [SYSTEM] [BEFORE] <dir1> <dir2> ...)
function findTargetIncludes(calls) {
  const out = [];
  for (const c of calls) {
    if (c.name === 'target_include_directories' && c.args[0]) {
      const target = unquote(c.args[0]);
      const dirs = c.args.slice(1).map(unquote).filter((x) => !/^(SYSTEM|BEFORE|AFTER|PUBLIC|PRIVATE|INTERFACE)$/i.test(x));
      out.push({ target, dirs, line: c.line });
    }
  }
  return out;
}

// 抽 FetchContent_Declare(<name> [URL <url>] [GIT_REPOSITORY <repo>] [GIT_TAG <tag>] [SOURCE_DIR <dir>])
// CMake FetchContent_Declare 是多行调用,需要从 content 抽取而非 splitArgs
function findFetchContent(content) {
  const out = [];
  // 找 FetchContent_Declare( ... ) 块(支持跨行)
  const re = /FetchContent_Declare\s*\(\s*([A-Za-z_][\w]*)\s*([\s\S]*?)\)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    const body = m[2];
    const decl = { name, line: lineOf(content, m.index), url: null, gitRepository: null, gitTag: null, sourceDir: null };
    // 抽 URL / GIT_REPOSITORY / GIT_TAG / SOURCE_DIR 键值
    const urlMatch = body.match(/\bURL\s+("[^"]+"|[^\s)]+)/);
    if (urlMatch) decl.url = urlMatch[1].replace(/^"|"$/g, '');
    const gitRepoMatch = body.match(/\bGIT_REPOSITORY\s+("[^"]+"|[^\s)]+)/);
    if (gitRepoMatch) decl.gitRepository = gitRepoMatch[1].replace(/^"|"$/g, '');
    const gitTagMatch = body.match(/\bGIT_TAG\s+("[^"]+"|[^\s)]+)/);
    if (gitTagMatch) decl.gitTag = gitTagMatch[1].replace(/^"|"$/g, '');
    const sourceDirMatch = body.match(/\bSOURCE_DIR\s+("[^"]+"|[^\s)]+)/);
    if (sourceDirMatch) decl.sourceDir = sourceDirMatch[1].replace(/^"|"$/g, '');
    out.push(decl);
  }
  return out;
}

// 抽 find_package(<name> [REQUIRED] [QUIET] ...)
// find_package 用空格分隔:find_package(CURL REQUIRED)
function findPackages(calls) {
  const out = [];
  for (const c of calls) {
    if (c.name === 'find_package' && c.args[0]) {
      const tokens = c.args[0].split(/\s+/).map(unquote);
      const name = tokens[0];
      out.push({
        name,
        required: tokens.some((t) => /^REQUIRED$/i.test(t)),
        quiet: tokens.some((t) => /^QUIET$/i.test(t)),
        line: c.line,
      });
    }
  }
  return out;
}

// 抽 function / macro 之间的调用
// 依据：findTopLevelCalls 已扫出全文件所有 NAME( 调用（含函数体内）；函数体行范围 =
// [声明行, 对应 endfunction()/endmacro() 行)（与下一函数声明行取近者兜底）。
// 落在某函数体范围内、且名字是本文件 function/macro 的调用 → 该函数的一条调用边（去重）；
// 顶层对函数的直接调用（如 entry()）不属于任何函数体,不产生边。
function findCallEdges(functions, calls) {
  const out = new Map();
  if (functions.length === 0) return out;
  const fnNames = new Set(functions.map((f) => f.name));
  const sorted = [...functions].sort((a, b) => a.line - b.line);
  const endLines = calls
    .filter((c) => c.name === 'endfunction' || c.name === 'endmacro')
    .map((c) => c.line)
    .sort((a, b) => a - b);
  const bodyEnd = (fn) => {
    const own = endLines.find((l) => l >= fn.line);
    const nextFn = sorted.find((f) => f.line > fn.line)?.line ?? Infinity;
    return Math.min(own ?? Infinity, nextFn);
  };
  for (const c of calls) {
    if (!fnNames.has(c.name)) continue;
    let owner = null;
    for (const fn of sorted) {
      if (c.line > fn.line && c.line < bodyEnd(fn)) { owner = fn; break; }
    }
    if (!owner || owner.name === c.name) continue;
    if (!out.has(owner.name)) out.set(owner.name, new Set());
    out.get(owner.name).add(c.name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 风险检测
// ---------------------------------------------------------------------------

function detectRisks({ fetchContent, content }) {
  const risks = [];
  // 中:可执行目标被 set_target_properties 指向 Steam 路径(写用户系统目录)
  if (/\bRUNTIME_OUTPUT_DIRECTORY\b[\s\S]{0,200}Steam/i.test(content) ||
      /\bset_target_properties\([^)]*Steam/i.test(content)) {
    risks.push({ severity: 'medium', kind: 'steam-dir-write', detail: '目标输出目录指向 Steam 安装路径' });
  }
  // 中:registry read (Windows 平台检测)
  // 兼容单/双反斜杠:.cmake 字符串字面里 \\ = 1 个 \,PowerShell 字面里 \\ = 1 个 \
  if (/reg\s+query\s+["']?HKCU:\\\\?Software\\\\?Valve/i.test(content)) {
    risks.push({ severity: 'low', kind: 'registry-read', detail: '读取注册表 HKCU\\Software\\Valve\\Steam' });
  }
  // 中:download URL 但无 SHA / 无 fetchcontent 校验
  const urlDeps = fetchContent.filter((f) => f.url);
  if (urlDeps.length > 0) {
    const hasHash = /\bURL_HASH\b/i.test(content);
    if (!hasHash) {
      risks.push({ severity: 'medium', kind: 'fetch-no-hash', detail: `${urlDeps.length} 个 FetchContent_Declare 使用 URL 但未指定 URL_HASH 校验` });
    }
  }
  return risks;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function analyzeCMake(filePath, content) {
  // CMake 关键抽取(target/function/option)用 content 而非 stripped
  // stripped 仍用于 findTopLevelCalls(保留 stripped 来跑)
  const stripped = stripNoise(content);
  const lineCount = content.split('\n').length;
  const calls = findTopLevelCalls(stripped);
  const targets = findTargets(calls);
  const functions = findFunctions(calls);
  const options = findOptionsFromContent(content);
  const sets = findSetsFromContent(content);
  const includes = findIncludes(calls);
  const subdirs = findSubdirectories(calls);
  const linkLibs = findTargetLinkLibraries(calls);
  const dependencies = findDependencies(calls);
  const targetIncludes = findTargetIncludes(calls);
  const fetchContent = findFetchContent(content);
  const packages = findPackages(calls);
  const callEdges = findCallEdges(functions, calls);

  const risks = detectRisks({ fetchContent, content });
  const riskLevel = risks.length === 0
    ? 'none'
    : risks.reduce((max, r) => ({ low: 1, medium: 2, high: 3 })[r.severity] > ({ low: 1, medium: 2, high: 3 })[max] ? r.severity : max, 'low');

  return {
    // 与其他 analyzer 同 shape(空壳)
    path: filePath, ext: path.extname(filePath).slice(1) || 'cmake', lineCount,
    imports: [], exportSymbols: [], exportNames: [], jsxTags: new Set(),
    useCalls: [], overlayOpens: [], stores: [], lazyWrappers: [],
    components: [], hooks: [],
    primaryComponentName: null, hasSingletonClass: false, hasClassExport: false,
    importMap: new Map(), vueRoutes: [], vueRouteMeta: null,
    interfaces: [], classes: [], traits: [], routes: [], moduleFunctions: [],
    // ---- CMake 专有 ----
    isCMake: true,
    isCMakeLists: path.basename(filePath) === 'CMakeLists.txt',
    isCMakeModule: path.extname(filePath).toLowerCase() === '.cmake',
    targets,
    targetCount: targets.length,
    functions,
    functionCount: functions.length,
    options,
    optionCount: options.length,
    sets,
    includes,
    subdirectories: subdirs,
    linkLibraries: linkLibs,
    targetDependencies: dependencies,
    targetIncludes,
    fetchContent,
    fetchContentCount: fetchContent.length,
    packages,
    packageCount: packages.length,
    callEdges: [...callEdges.entries()].map(([from, set]) => ({ from, to: [...set] })),
    risks,
    riskLevel,
  };
}

export function analyzeCMakeFromDisk(relPath, projectRoot) {
  return analyzeFileFromDisk(relPath, projectRoot, analyzeCMake);
}
