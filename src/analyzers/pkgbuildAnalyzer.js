// Arch Linux PKGBUILD 专用解析器
// 与 tsAnalyzer / userScriptAnalyzer / shellScriptAnalyzer / cmakeAnalyzer 平级共存、逻辑完全独立。
//
// 设计要点：
//   - 实体:ArchPackage（PKGBUILD 顶层描述）+ ArchFunction（build() / package() / check() 等函数体）
//   - 字段:pkgname / pkgver / pkgrel / pkgdesc / arch / url / license / depends / makedepends / checkdepends / optdepends / provides / conflicts / replaces / source / sha256sums / install
//   - 风险:
//       - 极高:sha256sums=('SKIP') 且 source 来自网络 → 下载未校验
//       - 高:depends 包含 steam 等会触发大型安装的包
//       - 中:package() 体内有 sudo / rm -rf / 写入 /usr/lib 等系统路径
//   - 形态:Bash 语法（变量赋值 / 函数 / 数组括号 () / 双引号 / here-doc 注释）
//   - 候选:文件名严格匹配 PKGBUILD（区分大小写）

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 候选检测
// ---------------------------------------------------------------------------

export function isPkgbuildCandidate(absFilePath) {
  return path.basename(absFilePath) === 'PKGBUILD';
}

// ---------------------------------------------------------------------------
// 噪声剥离（PKGBUILD 用 Bash 语法，注释以 # 开头，here-doc <<EOF 可保留）
// ---------------------------------------------------------------------------

function stripNoise(content) {
  let out = '';
  let i = 0;
  const n = content.length;
  let inHereDoc = null;
  while (i < n) {
    if (inHereDoc) {
      if (content.startsWith(inHereDoc, i) && (content[i + inHereDoc.length] === '\n' || i + inHereDoc.length === n)) {
        out += ' '.repeat(inHereDoc.length);
        i += inHereDoc.length;
        inHereDoc = null;
        continue;
      }
      out += content[i] === '\n' ? '\n' : ' ';
      i++;
      continue;
    }
    const c = content[i];
    const nx = content[i + 1];
    if (c === '#') {
      while (i < n && content[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      out += c; i++;
      while (i < n && content[i] !== q) {
        if (content[i] === '\\' && i + 1 < n) { out += '  '; i += 2; continue; }
        out += content[i] === '\n' ? '\n' : ' '; i++;
      }
      if (i < n) { out += q; i++; }
      continue;
    }
    // here-doc 起始(只识别 <<EOF / <<-EOF 不带引号)
    if (c === '<' && nx === '<' && /[A-Za-z]/.test(content[i + 2] ?? '')) {
      const m = content.slice(i).match(/^<<-?\s*([A-Za-z_][\w]*)/);
      if (m) { inHereDoc = m[1]; out += ' '.repeat(m[0].length); i += m[0].length; continue; }
    }
    out += c; i++;
  }
  return out;
}

// 给定 ( 起点，返回匹配的 )
function findMatchingParen(content, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < content.length; i++) {
    const c = content[i];
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function lineOf(stripped, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < stripped.length; i++) if (stripped[i] === '\n') line++;
  return line;
}

// 抽 array 名( ... ) 的内容,返回 trim 后的数组元素
// 支持单行多元素(depends=('steam' 'libxtst'))与多行元素(arch=('x86_64' ...))
function extractArray(content, arrayStart) {
  const end = findMatchingParen(content, arrayStart);
  if (end < 0) return { elements: [], end: -1 };
  const inner = content.slice(arrayStart + 1, end);
  // 顶层 split:换行 OR 行内连续空白(被字符串/括号包含的内容除外)
  const elements = [];
  let buf = '';
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' || c === "'") { inStr = !inStr; buf += c; continue; }
    if (inStr) { buf += c; continue; }
    if (c === '(') { depth++; buf += c; continue; }
    if (c === ')') { depth--; buf += c; continue; }
    if (c === '\n' && depth === 0) { if (buf.trim()) elements.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) elements.push(buf.trim());
  // 单行内多元素:按空白进一步切分(忽略已用引号/括号包裹的)
  const splitElements = [];
  for (const el of elements) {
    // 如果元素看起来是单行多元素(用空白分隔且不含括号嵌套),则切分
    if (el.length > 0 && !el.startsWith('(')) {
      // 简单策略:在不被引号/括号包裹的空白处切,且切分时跳过引号字符本身
      const subs = [];
      let sub = '';
      let sd = 0;
      let ss = false;
      for (let i = 0; i < el.length; i++) {
        const ch = el[i];
        if (ch === '"' || ch === "'") { ss = !ss; continue; } // 跳过引号字符
        if (ss) { sub += ch; continue; }
        if (ch === '(') { sd++; sub += ch; continue; }
        if (ch === ')') { sd--; sub += ch; continue; }
        if ((ch === ' ' || ch === '\t') && sd === 0) {
          if (sub.trim()) subs.push(sub.trim());
          sub = '';
          continue;
        }
        sub += ch;
      }
      if (sub.trim()) subs.push(sub.trim());
      splitElements.push(...subs);
    } else {
      splitElements.push(el);
    }
  }
  return { elements: splitElements.map((s) => s.replace(/^["']|["']$/g, '')), end };
}

// 抽 NAME=( ... ) 数组赋值(用 content,处理 'x86_64' / "https://..." / ${var} 等字面)
function findArrays(content) {
  const out = {};
  // 找 NAME=( 起点(允许 ( 后立即接元素,或换行)
  const re = /^([A-Za-z_][\w]*)\s*=\s*\(/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    const parenStart = m.index + m[0].length - 1;
    // 快速跳过:如果 `(` 后紧跟 `)`,这是空调用,不是数组(可能是函数定义 build() )
    if (content[parenStart + 1] === ')') { re.lastIndex = parenStart + 2; continue; }
    const { elements, end } = extractArray(content, parenStart);
    if (end > 0 && elements.length > 0) {
      out[name] = elements;
      re.lastIndex = end + 1;
    }
  }
  return out;
}

// 抽 NAME=value 顶层标量赋值(用 content 而非 stripped:stripNoise 会破坏 "x86_64" / 'steam' 等字符串字面)
function findScalars(content) {
  const out = {};
  // 简单形式:NAME="value" 或 NAME='value' 或 NAME=value
  // 但要避免注释行(# 开头)被错误解析(注释可能含 =)
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z_][\w]*)\s*=\s*(.+)$/);
    if (!m) continue;
    const name = m[1];
    let value = m[2].trim();
    // 去行尾注释(# 前面必须有空白)
    const commentIdx = value.search(/\s+#/);
    if (commentIdx >= 0) value = value.slice(0, commentIdx).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[name] = value;
  }
  return out;
}

// 抽函数定义:build() { ... } / package() { ... } / check() { ... } / prepare()
// 用 content 但避开行注释:跳过以 # 开头的行
function findFunctions(content) {
  const out = [];
  // 先去掉行注释(只在行首 # 时去掉)
  const cleaned = content.split('\n').map((line) => {
    // 简化:只在行首空白后第一个非空字符是 # 时,视为注释行
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#')) return '';
    return line;
  }).join('\n');
  const re = /^([A-Za-z_][\w]*)\s*\(\s*\)\s*\{/gm;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const name = m[1];
    const start = m.index;
    const braceStart = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < cleaned.length; i++) {
      if (cleaned[i] === '{') depth++;
      else if (cleaned[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) end = cleaned.length - 1;
    out.push({
      name,
      body: cleaned.slice(braceStart + 1, end),
      startLine: lineOf(cleaned, start),
      endLine: lineOf(cleaned, end),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 风险检测
// ---------------------------------------------------------------------------

function detectRisks({ scalars, arrays, functions, sourceIsRemote, sha256Skip }) {
  const risks = [];
  // 极高:source 来自网络(github/git+/url 形式)但 sha256sums=('SKIP')
  if (sourceIsRemote && sha256Skip) {
    risks.push({ severity: 'high', kind: 'remote-source-no-checksum', detail: 'PKGBUILD 从远程下载 source 但 sha256sums=SKIP,构建时不做校验' });
  }
  // 中:package() 内 sudo / rm -rf
  const pkgFn = functions.find((f) => f.name === 'package');
  if (pkgFn) {
    if (/\bsudo\b/.test(pkgFn.body)) {
      risks.push({ severity: 'medium', kind: 'sudo-in-package', detail: 'package() 体内出现 sudo 调用' });
    }
    if (/\brm\s+-rf?\b/.test(pkgFn.body)) {
      risks.push({ severity: 'medium', kind: 'rm-rf-in-package', detail: 'package() 体内出现 rm -rf' });
    }
  }
  // 低:依赖包含 steam / wine 等大包(注意:依赖 steam 的项目属于此类,这里用 'low' 不阻塞)
  const heavyDeps = ['wine', 'wine-staging', 'nvidia-dkms'];
  for (const dep of (arrays.depends ?? [])) {
    if (heavyDeps.includes(dep)) {
      risks.push({ severity: 'low', kind: 'heavy-depend', detail: `依赖 ${dep} 体积较大` });
    }
  }
  // 高:package() 内 pkgdir 解析为根路径(覆盖 $pkgdir / ${pkgdir} / pkgdir 三种写法;单函数至多记一条)
  for (const fn of functions) {
    if (fn.name !== 'package') continue;
    // 形如:pkgdir="/" / $pkgdir="/" / ${pkgdir}="/"
    if (/(?:\$\{?pkgdir\}?|pkgdir)\s*=\s*["']\//.test(fn.body)) {
      risks.push({ severity: 'high', kind: 'pkgdir-root', detail: '$pkgdir/pkgdir 解析为根路径 /,package() 会直接写入系统根' });
    }
  }
  return risks;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function analyzePkgbuild(filePath, content) {
  const lineCount = content.split('\n').length;
  // 注意:findScalars / findArrays / findFunctions 直接用 content
  // (stripNoise 会破坏 'x86_64' / "https://..." / ${pkgver} 等字面)
  const scalars = findScalars(content);
  const arrays = findArrays(content);
  const functions = findFunctions(content);

  const sourceList = arrays.source ?? [];
  const sourceIsRemote = sourceList.some((s) => /^(https?:\/\/|git\+|git:\/\/|svn\+|hg\+)/.test(s));
  const sha256List = arrays.sha256sums ?? [];
  const sha256Skip = sha256List.length === 1 && sha256List[0] === 'SKIP';

  // 常用数组型字段(可空)
  const arrayFields = ['arch', 'license', 'depends', 'makedepends', 'checkdepends', 'optdepends', 'provides', 'conflicts', 'replaces', 'source', 'sha256sums', 'md5sums'];

  const risks = detectRisks({ scalars, arrays, functions, sourceIsRemote, sha256Skip });
  const riskLevel = risks.length === 0
    ? 'none'
    : risks.reduce((max, r) => ({ low: 1, medium: 2, high: 3 })[r.severity] > ({ low: 1, medium: 2, high: 3 })[max] ? r.severity : max, 'low');

  return {
    // 与其他 analyzer 同 shape(空壳)
    path: filePath, ext: 'pkgbuild', lineCount,
    imports: [], exportSymbols: [], exportNames: [], jsxTags: new Set(),
    useCalls: [], overlayOpens: [], stores: [], lazyWrappers: [],
    components: [], hooks: [],
    primaryComponentName: null, hasSingletonClass: false, hasClassExport: false,
    importMap: new Map(), vueRoutes: [], vueRouteMeta: null,
    interfaces: [], classes: [], traits: [], routes: [], moduleFunctions: [],
    // ---- PKGBUILD 专有 ----
    isPkgbuild: true,
    pkgname: scalars.pkgname ?? null,
    pkgver: scalars.pkgver ?? null,
    pkgrel: scalars.pkgrel ?? null,
    pkgdesc: scalars.pkgdesc ?? null,
    url: scalars.url ?? null,
    maintainer: scalars.maintainer ?? null,
    install: scalars.install ?? null,
    license: arrays.license ?? (scalars.license ? [scalars.license] : []),
    arch: arrays.arch ?? [],
    depends: arrays.depends ?? [],
    makedepends: arrays.makedepends ?? [],
    checkdepends: arrays.checkdepends ?? [],
    optdepends: arrays.optdepends ?? [],
    provides: arrays.provides ?? [],
    conflicts: arrays.conflicts ?? [],
    replaces: arrays.replaces ?? [],
    source: sourceList,
    sha256sums: sha256List,
    functions: functions.map((f) => ({ name: f.name, startLine: f.startLine, endLine: f.endLine, bodyLineCount: f.body.split('\n').length })),
    functionCount: functions.length,
    sourceIsRemote,
    sha256Skip,
    risks,
    riskLevel,
  };
}

export function analyzePkgbuildFromDisk(relPath, projectRoot) {
  const content = fs.readFileSync(path.join(projectRoot, relPath), 'utf-8');
  return analyzePkgbuild(relPath, content);
}
