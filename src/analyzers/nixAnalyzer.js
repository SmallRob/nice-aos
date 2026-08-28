// Nix 包管理（flake.nix / *.nix）专用解析器
// 与 tsAnalyzer / userScriptAnalyzer / shellScriptAnalyzer / cmakeAnalyzer / pkgbuildAnalyzer 平级共存、逻辑完全独立。
//
// 设计要点：
//   - 实体:NixFlake（顶层 flake.nix）+ NixPackage（mkDerivation / callPackage 产物）
//   - 字段(inputs 列表 / outputs.packages / description / system 维度)
//   - 边:
//       declaresInput        inputs.<name>.url  形式
//       outputsPackage       outputs.packages.<system>.<name> = ...
//       buildsWith           buildInputs / nativeBuildInputs
//       callsPackage         callPackage(./x.nix) / pkgs.callPackage
//       fetchesFrom          fetchurl / fetchgit / fetchFromGitHub / fetchTarball
//       dependsOnSystem      <system> 维度
//   - 风险:
//       - 高:fetchFromGitHub/fetchgit 缺 sha256/rev(虽不致命但 Nix 会 hash mismatch)
//       - 中:未固定 nixpkgs commit 而是浮动的 channel
//       - 低:overlays.default 写法(对调用方有副作用)
//   - 形态:Nix 表达式语法（attribute set {a=b; c=d;} / let bindings / 字符串 / 列表 / 函数 / 注释 # 开头 / /* */）
//   - 候选:*.nix 强匹配；flake.lock 跳过（锁定文件，不解析）

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 候选检测
// ---------------------------------------------------------------------------

export function isNixCandidate(absFilePath) {
  const base = path.basename(absFilePath);
  if (base === 'flake.lock') return false; // 锁定文件,不解析
  return base.toLowerCase().endsWith('.nix');
}

// ---------------------------------------------------------------------------
// 噪声剥离
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
    // 块注释 /* ... */  (Nix 不支持嵌套,简化)
    if (c === '/' && nx === '*') {
      i += 2;
      while (i < n && !(content[i] === '*' && content[i + 1] === '/')) { out += content[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    // 普通字符串 "..."（允许 ${} 插值；插值内的 { } 不能进入 main skip 状态）
    if (c === '"') {
      out += c; i++;
      while (i < n && content[i] !== '"') {
        if (content[i] === '\\' && i + 1 < n) { out += '  '; i += 2; continue; }
        if (content[i] === '$' && content[i + 1] === '{') {
          // 找到匹配的 } 视为内嵌(简单实现,假设无嵌套 ${})
          out += '${';
          i += 2;
          let d = 1;
          while (i < n && d > 0) {
            if (content[i] === '{') d++;
            else if (content[i] === '}') d--;
            out += content[i] === '\n' ? '\n' : ' ';
            i++;
          }
          continue;
        }
        out += content[i] === '\n' ? '\n' : ' '; i++;
      }
      if (i < n) { out += '"'; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

// 括号配对 ( ) / { } / [ ]
function findMatch(content, start, open, close) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < content.length; i++) {
    const c = content[i];
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function lineOf(stripped, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < stripped.length; i++) if (stripped[i] === '\n') line++;
  return line;
}

// 在 stripped 中找所有顶层 { ... } 块（深度 0 → 0 的配对）
function findTopLevelBlocks(stripped) {
  const out = [];
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === '{') {
      const end = findMatch(stripped, i, '{', '}');
      if (end > 0) { out.push({ start: i, end, body: stripped.slice(i + 1, end) }); i = end; }
    }
  }
  return out;
}

// 抽 attribute set 内的 name = value 形式（顶层 ; 分割）
function findAttributes(body) {
  const out = {};
  // 简化:对 body 按顶层 ; 切分,然后匹配 name = value
  const parts = [];
  let buf = '';
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') { inStr = !inStr; buf += c; continue; }
    if (inStr) { buf += c; continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; buf += c; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; buf += c; continue; }
    if (c === ';' && depth === 0) { if (buf.trim()) parts.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) parts.push(buf.trim());
  for (const part of parts) {
    const m = part.match(/^([A-Za-z_][\w.-]*)\s*=\s*([\s\S]+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// 抽 inputs 块（嵌套 inputs = { ... } 与扁平 inputs.<name>.<key> = ... 两种写法）
function findInputs(attrs, content, stripped) {
  const out = [];
  // 统一归一为 `name.key` 键集合：嵌套块展开 + 顶层扁平键（inputs.nixpkgs.url 等）合成；
  // 字符串值统一从原 content 回查（stripped 已把字面量置白）
  const innerAttrs = {};
  if (attrs.inputs) Object.assign(innerAttrs, extractNestedAttributes(attrs.inputs));
  for (const k of Object.keys(attrs)) {
    const fm = k.match(/^inputs\.([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)$/);
    if (fm) innerAttrs[`${fm[1]}.${fm[2]}`] = '';
  }
  for (const [name] of Object.entries(innerAttrs)) {
    // 形态 1:nixpkgs.url = "..." (扁平)
    const dotMatch = name.match(/^([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)$/);
    if (dotMatch) {
      const inputName = dotMatch[1];
      const subKey = dotMatch[2];
      // 从 content 中回查完整字符串值
      const re = new RegExp(`${inputName}\\.${subKey}\\s*=\\s*"([^"]+)"`);
      const m = (typeof content === 'string' ? content : stripped).match(re);
      const val = m ? m[1] : null;
      if (subKey === 'url') {
        // 同名 input 可能已由 flake 键先建条目（键序无关），合并而非重复 push
        const existing = out.find((i) => i.name === inputName);
        if (existing) existing.url = val;
        else out.push({ name: inputName, url: val, hasFlakeAttr: false });
      } else if (subKey === 'flake') {
        // hasFlakeAttr 语义 = 是否显式声明了 flake 属性（与嵌套形态分支一致）
        const existing = out.find((i) => i.name === inputName);
        if (existing) existing.hasFlakeAttr = true;
        else out.push({ name: inputName, url: null, hasFlakeAttr: true });
      }
      continue;
    }
    // 形态 2:name = { url = "..."; flake = false; }(嵌套)
    // 从 content 中回查
    let url = null;
    let hasFlakeAttr = false;
    const blockRe = new RegExp(`${name}\\s*=\\s*\\{([\\s\\S]*?)\\}`, 's');
    const blockMatch = (typeof content === 'string' ? content : stripped).match(blockRe);
    if (blockMatch) {
      const innerBody = blockMatch[1];
      const urlM = innerBody.match(/url\s*=\s*"([^"]+)"/);
      if (urlM) url = urlM[1];
      hasFlakeAttr = /\bflake\s*=/.test(innerBody);
    }
    out.push({ name, url, hasFlakeAttr });
  }
  return out;
}

function extractNestedAttributes(s) {
  const out = {};
  // 找到首个 { 与匹配 }(用 { } depth 跟踪)
  const firstBrace = s.indexOf('{');
  if (firstBrace < 0) return out;
  const end = findMatch(s, firstBrace, '{', '}');
  if (end < 0) return out;
  const body = s.slice(firstBrace + 1, end);
  const parts = [];
  let buf = '';
  let depth = 0;
  let inStr = false;
  // Nix 用 { } 嵌套,这里同时跟踪 { 和 ( 的 depth,以避免被内层 ; 错误切分
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') { inStr = !inStr; buf += c; continue; }
    if (inStr) { buf += c; continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; buf += c; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; buf += c; continue; }
    if (c === ';' && depth === 0) { if (buf.trim()) parts.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) parts.push(buf.trim());
  for (const part of parts) {
    const m = part.match(/^([A-Za-z_][\w.-]*)\s*=\s*([\s\S]+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// 抽 outputs.packages.<system>.<name> 列表
// 支持三种等价形态：
//   A. packages = { <system> = { <name> = expr; }; }        （嵌套 attribute set）
//   B. packages.<system> = { <name> = expr; } / = let ... in { ... };  （属性路径 + 结果 attrset）
//   C. packages.<system>.<name> = expr;                      （属性路径直达包名）
function findOutputsPackages(attrs) {
  const out = [];
  if (!attrs.outputs) return out;
  // outputs 是函数 { self, nixpkgs, ... }: { ... }
  // 从 attrs.outputs 中找函数体（: 之后的 result attrset）
  const outBody = attrs.outputs;
  const arrowIdx = outBody.indexOf(':');
  const body = arrowIdx >= 0 ? outBody.slice(arrowIdx + 1) : outBody;
  const seen = new Set();
  const push = (system, name, line) => {
    const key = `${system}#${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ system, name, line });
  };
  // 形态 A: packages = { ... }
  const pkgsMatch = body.match(/packages\s*=\s*\{/);
  if (pkgsMatch) {
    const start = pkgsMatch.index + pkgsMatch[0].length - 1;
    const end = findMatch(body, start, '{', '}');
    if (end >= 0) {
      const inner = body.slice(start + 1, end);
      // inner 形如: x86_64-linux = { default = ...; foo = ...; }; aarch64-linux = ...;
      const systemAttrs = extractNestedAttributes('{' + inner + '}');
      for (const [system, sysValue] of Object.entries(systemAttrs)) {
        const sysInner = extractNestedAttributes(sysValue);
        for (const pkgName of Object.keys(sysInner)) {
          push(system, pkgName, lineOf(body, body.indexOf(pkgName)));
        }
      }
    }
  }
  // 形态 B/C: packages.<system>[.<name>] = expr
  // 逐个匹配属性路径,值域到下一个 packages.<system> 段或 body 末尾;
  // 形态 B 的结果 attrset 取值域内最后一个顶层配平 { ... } 块（let ... in { ... } 取 in 之后的块）
  const re = /\bpackages\.([A-Za-z_][\w-]*)(?:\.([A-Za-z_][\w-]*))?\s*=/g;
  let m;
  const ranges = [];
  while ((m = re.exec(body)) !== null) {
    ranges.push({ system: m[1], directName: m[2] ?? null, valueStart: m.index + m[0].length, matchEnd: m.index + m[0].length });
  }
  for (let r = 0; r < ranges.length; r++) {
    const { system, directName, valueStart } = ranges[r];
    if (directName) {
      // 形态 C: 属性路径直达包名
      push(system, directName, lineOf(body, valueStart - directName.length));
      continue;
    }
    const valueEnd = r + 1 < ranges.length ? body.lastIndexOf(';', ranges[r + 1].valueStart) : body.length;
    const value = body.slice(valueStart, valueEnd > valueStart ? valueEnd : body.length);
    const block = findLastTopLevelBraceBlock(value);
    if (!block) continue;
    const inner = extractNestedAttributes('{' + block + '}');
    for (const pkgName of Object.keys(inner)) {
      push(system, pkgName, lineOf(body, valueStart));
    }
  }
  return out;
}

// 找 expr 中最后一个顶层配平的 { ... } 块内容（引号内的 { } 已被 stripNoise 置白,不参与配平）
function findLastTopLevelBraceBlock(expr) {
  let depth = 0;
  let best = null;
  let start = -1;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) best = expr.slice(start + 1, i);
      }
    }
  }
  return best;
}

// 抽 mkDerivation / callPackage 出现位置
function findDerivations(stripped) {
  const out = [];
  const re = /\b(mkDerivation|callPackage|fetchurl|fetchgit|fetchFromGitHub|fetchTarball|buildPythonPackage|stdenv\.mkDerivation)\s*\(/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    out.push({ name: m[1], line: lineOf(stripped, m.index) });
  }
  return out;
}

// 抽 buildInputs / nativeBuildInputs
function findBuildInputs(stripped) {
  const out = { buildInputs: [], nativeBuildInputs: [] };
  const re = /\b(buildInputs|nativeBuildInputs)\s*=\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const key = m[1];
    const inner = m[2];
    // 提取 [ ... ] 内的标识符(简单:匹配 identifier.list)
    const items = [];
    const tokRe = /\b([A-Za-z_][\w.-]*)\b/g;
    let tm;
    const blacklist = new Set(['with', 'import', 'inherit', 'let', 'in', 'if', 'then', 'else', 'true', 'false', 'null']);
    while ((tm = tokRe.exec(inner)) !== null) {
      const name = tm[1];
      if (blacklist.has(name)) continue;
      if (name === key) continue;
      if (name === 'lib' || name === 'pkgs' || name === 'stdenv') continue;
      items.push(name);
    }
    if (key === 'buildInputs') out.buildInputs = items;
    else out.nativeBuildInputs = items;
  }
  return out;
}

// 抽 fetchFromGitHub 是否指定了 sha256/rev
function findFetcherSecurity(stripped) {
  const out = [];
  // 抽 fetchFromGitHub/fetchgit/fetchurl { ... } 块
  const re = /\b(fetchurl|fetchgit|fetchFromGitHub|fetchTarball)\s*\{/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const name = m[1];
    const start = m.index + m[0].length - 1;
    const end = findMatch(stripped, start, '{', '}');
    if (end < 0) continue;
    const body = stripped.slice(start + 1, end);
    const attrs = extractNestedAttributes('{' + body + '}');
    const hasHash = !!attrs.sha256;
    const hasRev = !!attrs.rev;
    const url = attrs.url ?? null;
    out.push({ name, hasHash, hasRev, url, line: lineOf(stripped, m.index) });
    re.lastIndex = end + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 风险检测
// ---------------------------------------------------------------------------

function detectRisks({ fetchers, inputs, packages }) {
  const risks = [];
  for (const f of fetchers) {
    if ((f.name === 'fetchFromGitHub' || f.name === 'fetchgit') && !f.hasHash) {
      risks.push({ severity: 'medium', kind: 'fetcher-no-hash', detail: `${f.name} 缺 sha256,Nix 会因 purity 检查失败或 fetch 行为不可预测` });
    }
  }
  for (const i of inputs) {
    if (i.url && /nixpkgs\/[a-f0-9]{40}/.test(i.url) === false && /nixos\/nixpkgs\/(nixos-|nixpkgs-)/.test(i.url)) {
      risks.push({ severity: 'low', kind: 'nixpkgs-channel', detail: `${i.name} 用 channel 形式,未固定 commit(${i.url})` });
    }
  }
  return risks;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function analyzeNix(filePath, content) {
  const stripped = stripNoise(content);
  const lineCount = content.split('\n').length;
  const blocks = findTopLevelBlocks(stripped);

  let description = null;
  let inputs = [];
  let outputsPackages = [];
  let derivations = [];
  let buildInputs = { buildInputs: [], nativeBuildInputs: [] };
  let fetchers = [];

  if (blocks.length > 0) {
    // 顶层通常是一个 { ... } 或 let ... in ...
    // 对每个顶层块的 body 做属性抽取
    for (const block of blocks) {
      const attrs = findAttributes(block.body);
      // description 是字符串字面量(可能从 stripped 中提取,但 stripNoise 后只剩引号位置)
      if (attrs.description) {
        // 简单:从原 content 中找 description = "...";
        const m = content.match(/description\s*=\s*"([^"]+)"/);
        if (m) description = m[1];
      }
      if (attrs.inputs || Object.keys(attrs).some((k) => k.startsWith('inputs.'))) {
        // inputs 段从 stripped 拿到结构(嵌套 key 列表),但 url/flake 字符串值需从 content 拿到完整内容
        // 在 stripped 上用 line/col 定位,再回 content 取对应段
        inputs = findInputs(attrs, content, stripped);
      }
      if (attrs.outputs) {
        outputsPackages = findOutputsPackages(attrs);
      }
    }
  }

  // 全局扫描(对 outputs 中的 callPackage 形式 / fetchers / buildInputs 也覆盖)
  derivations = findDerivations(stripped);
  buildInputs = findBuildInputs(stripped);
  fetchers = findFetcherSecurity(stripped);

  const risks = detectRisks({ fetchers, inputs, packages: outputsPackages });
  const riskLevel = risks.length === 0
    ? 'none'
    : risks.reduce((max, r) => ({ low: 1, medium: 2, high: 3 })[r.severity] > ({ low: 1, medium: 2, high: 3 })[max] ? r.severity : max, 'low');

  return {
    // 与其他 analyzer 同 shape(空壳)
    path: filePath, ext: 'nix', lineCount,
    imports: [], exportSymbols: [], exportNames: [], jsxTags: new Set(),
    useCalls: [], overlayOpens: [], stores: [], lazyWrappers: [],
    components: [], hooks: [],
    primaryComponentName: null, hasSingletonClass: false, hasClassExport: false,
    importMap: new Map(), vueRoutes: [], vueRouteMeta: null,
    interfaces: [], classes: [], traits: [], routes: [], moduleFunctions: [],
    // ---- Nix 专有 ----
    isNix: true,
    isFlake: path.basename(filePath) === 'flake.nix',
    description,
    inputs,
    inputCount: inputs.length,
    outputsPackages,
    packageCount: outputsPackages.length,
    derivations,
    derivationCount: derivations.length,
    buildInputs,
    fetchers,
    risks,
    riskLevel,
  };
}

export function analyzeNixFromDisk(relPath, projectRoot) {
  const content = fs.readFileSync(path.join(projectRoot, relPath), 'utf-8');
  return analyzeNix(relPath, content);
}
