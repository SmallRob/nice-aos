// PHP 实体分析器（zentaopms / Laravel / Symfony 等）：轻量语法级解析（状态机；无 regex 路径）。
// 与 tsAnalyzer / rustAnalyzer / dartAnalyzer / goAnalyzer / pythonAnalyzer / kotlinAnalyzer 平级。
//
// 实体映射（对齐 TS/Rust/Dart/Go/Kotlin；以 zentaopms 真实样本验证）：
//   class bugModel extends model   → Class (extendsName=model, isDataModel=true)
//   class bug extends control      → Class (extendsName=control, isController=true)
//   abstract class Foo extends Bar → Class (modifier=abstract)
//   interface Foo extends Bar, Baz → Interface (extendsNames)
//   trait Foo                     → Trait（新对象类型；方法复用单元）
//   public function bar(...)      → Method
//   public static function bar()  → Method (isStatic=true)
//   function __construct(...)     → Method (isConstructor=true)
//   use Trait1, Trait2;           → usesTraits
//   public $name;                  → Property
//   namespace Foo\Bar;            → module 归一
//   use Some\Other;                → imports
//
// Phase-2 接入说明：DAO / loadModel / createLink 等 抽取由 builder 内 sqlQueries / crossModule
// 通道消费；本 v1 解析器专注结构化实体提取（class/interface/trait/method/property）。

import fs from 'node:fs';
import path from 'node:path';
import { findMatchingPair } from './textUtils.js';

export function isPhpCandidate(relPath) {
  return relPath.endsWith('.php') && !relPath.endsWith('.blade.php');
}

export function analyzePhpFileFromDisk(relPath, projectRoot) {
  const abs = path.join(projectRoot, relPath);
  return analyzePhpFile(relPath, fs.readFileSync(abs, 'utf-8'));
}

function stripPhpNoise(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (i) => { if (src[i] !== '\n') out[i] = ' '; };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if ((c === '/' && src[i + 1] === '/') || c === '#') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i += 1; }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n) {
        if (src[i] === '*' && src[i + 1] === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; break; }
        blank(i); i += 1;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      out[i] = ' '; i += 1;
      while (i < n) {
        if (src[i] === '\\') { out[i] = ' '; if (i + 1 < n) out[i + 1] = ' '; i += 2; continue; }
        if (src[i] === quote) { out[i] = ' '; i += 1; break; }
        blank(i); i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

function computeLineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

// DAO 链 SQL 表名提取（zentaopms `dao` 惯例；复用 pythonAnalyzer/tsAnalyzer sqlQueries 通道）：
//   $this->dao->select('*')->from(TABLE_BUG)->where(...)->fetch()   → { kind:'SELECT', table:'TABLE_BUG', dynamic:true }
//   $this->dao->update(TABLE_BUG)->set(...)->exec()                 → { kind:'UPDATE', ... }
//   $this->dao->insert('zt_bug')->data(...)->exec()                 → { kind:'INSERT', table:'zt_bug', dynamic:false }
//   ->leftJoin(TABLE_USER)                                          → { kind:'JOIN', ... }
// 表参数为 TABLE_X 常量 / $var 时标 dynamic，builder 阶段经 defines 表解析为真实表名。
// 按语句（; 分隔）扫描：zentaopms 每条 DAO 链是单语句，链头与 from() 同句。
function extractDaoQueries(bodyText) {
  if (!bodyText || !bodyText.includes('dao->')) return [];
  const out = [];
  const seen = new Set();
  const push = (kind, argText) => {
    if (!argText) return;
    const a = argText.trim();
    let table = null;
    let dynamic = false;
    if (/^(?:'[^']*'|"[^"]*")$/.test(a)) {
      table = a.slice(1, -1).replace(/`/g, '').trim();
    } else if (/^`[^`]*`$/.test(a)) {
      table = a.slice(1, -1).trim();
    } else if (/^\$[A-Za-z_]\w*$/.test(a)) {
      table = a.slice(1); dynamic = true;
    } else if (/^[A-Z][A-Z0-9_]*$/.test(a)) {
      table = a; dynamic = true;
    } else {
      return;
    }
    if (!table) return;
    const key = `${kind}:${table}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, table, dynamic });
  };
  for (const stmt of bodyText.split(';')) {
    if (!stmt.includes('dao->')) continue;
    const head = /dao\s*->\s*(select|selectAll|update|insert|replace|delete)\b/.exec(stmt);
    if (head) {
      const kind = { select: 'SELECT', selectAll: 'SELECT', update: 'UPDATE', insert: 'INSERT', replace: 'INSERT', delete: 'DELETE' }[head[1]];
      // from(ARG) 优先（select/delete 链），否则链头内联（update/insert/replace）
      const fromM = /->\s*from\s*\(\s*([^()]+?)\s*\)/.exec(stmt);
      if (fromM) push(kind, fromM[1]);
      else {
        const inlineM = new RegExp(`dao\\s*->\\s*${head[1]}\\s*\\(\\s*([^()]+?)\\s*\\)`).exec(stmt);
        if (inlineM) push(kind, inlineM[1]);
      }
    }
    for (const jm of stmt.matchAll(/->\s*(?:leftJoin|innerJoin|rightJoin)\s*\(\s*([^()]+?)\s*\)/g)) {
      push('JOIN', jm[1]);
    }
  }
  return out;
}

// define('TABLE_BUG', '`zt_bug`') 常量表提取（原始文本；值定界符可为引号或反引号，值去反引号）
function extractDefines(src) {
  const defines = {};
  for (const m of src.matchAll(/\bdefine\s*\(\s*['"]([A-Za-z_]\w*)['"]\s*,\s*['"`]([^'"`]*)['"`]/g)) {
    defines[m[1]] = m[2].replace(/`/g, '').trim();
  }
  return defines;
}
function lineAt(ls, pos) {
  if (pos < 0) return 1;
  let lo = 0, hi = ls.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ls[mid] <= pos) lo = mid; else hi = mid - 1; }
  return lo + 1;
}
// 配对查找收敛于 textUtils.findMatchingPair（输入为已剥离注释的文本）
function findMatchingBrace(s, openIdx) { return findMatchingPair(s, openIdx, '{', '}'); }
function findMatchingParen(s, openIdx) { return findMatchingPair(s, openIdx, '(', ')'); }
function readIdent(s, pos) {
  if (pos >= s.length) return { name: '', end: pos };
  if (!/[A-Za-z_]/.test(s[pos])) return { name: '', end: pos };
  let i = pos + 1;
  while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) i += 1;
  return { name: s.slice(pos, i), end: i };
}
function skipSpaces(s, pos) {
  while (pos < s.length && /[ \t\n\r]/.test(s[pos])) pos += 1;
  return pos;
}
function parseNamespacedList(s, p) {
  const out = [];
  const n = s.length;
  while (p < n) {
    p = skipSpaces(s, p);
    if (p >= n) break;
    const c = s[p];
    if (c === ';' || c === '{' || c === '(' || c === ')') break;
    const start = p;
    while (p < n && /[A-Za-z0-9_\\]/.test(s[p])) p += 1;
    const name = s.slice(start, p);
    if (!name) break;
    out.push(name);
    p = skipSpaces(s, p);
    if (p < n && s[p] === ',') { p += 1; continue; }
    break;
  }
  return out;
}
function isVisName(name) { return name === 'public' || name === 'private' || name === 'protected'; }
function isModName(name) { return name === 'static' || name === 'final' || name === 'abstract' || name === 'readonly'; }

function parseMethod(cleaned, startPos, kwEnd, propVis, preMods, lineStarts) {
  const n = cleaned.length;
  let p = skipSpaces(cleaned, kwEnd);
  if (p < n && cleaned[p] === '&') p += 1;
  const nameId = readIdent(cleaned, p);
  if (!nameId.name) return null;
  let ip = nameId.end;
  let signature = `${nameId.name}(`;
  if (ip < n && cleaned[ip] === '(') {
    const close = findMatchingParen(cleaned, ip);
    if (close !== -1) {
      signature += cleaned.slice(ip + 1, close).replace(/\s+/g, ' ').trim();
      ip = close + 1;
    }
  }
  signature += ')';
  ip = skipSpaces(cleaned, ip);
  if (ip < n && cleaned[ip] === ':') {
    ip += 1;
    ip = skipSpaces(cleaned, ip);
    const ts = ip;
    while (ip < n && cleaned[ip] !== '{' && cleaned[ip] !== ';' && cleaned[ip] !== '\n') {
      if (cleaned[ip] === '|') ip += 1;
      ip += 1;
    }
    const rt = cleaned.slice(ts, ip).trim();
    if (rt) signature += `: ${rt}`;
  }
  ip = skipSpaces(cleaned, ip);
  let fnStart = -1, fnEnd = -1;
  if (ip < n && cleaned[ip] === '{') {
    fnStart = ip;
    fnEnd = findMatchingBrace(cleaned, ip);
  }
  const modifiers = preMods.slice();
  return {
    name: nameId.name, visibility: propVis, modifiers,
    isStatic: modifiers.includes('static'),
    isAbstract: modifiers.includes('abstract'),
    isFinal: modifiers.includes('final'),
    signature, hasBody: fnStart !== -1,
    bodyStart: fnStart, bodyEnd: fnEnd,
    start: startPos, end: fnEnd !== -1 ? fnEnd + 1 : ip,
    line: lineAt(lineStarts, startPos),
  };
}

function collectClassMembers(cleaned, bodyStart, bodyEnd, methods, properties, usesTraits, lineStarts) {
  const n = bodyEnd;
  let i = bodyStart + 1;
  let iter = 0;
  const MAX_ITER = 20000;
  while (i < n) {
    if (++iter > MAX_ITER) return;
    i = skipSpaces(cleaned, i);
    if (i >= n) break;
    if (!/[A-Za-z_$]/.test(cleaned[i])) { i += 1; continue; }
    const beforeI = i;
    const kw = readIdent(cleaned, i);
    if (!kw.name) { i += 1; continue; }
    if (kw.name === 'use') {
      let k = skipSpaces(cleaned, kw.end);
      if (k < n && cleaned[k] === '(') {
        const c = findMatchingParen(cleaned, k);
        if (c === -1) return;
        i = c + 1;
        continue;
      }
      const list = parseNamespacedList(cleaned, k);
      for (const t of list) usesTraits.push(t);
      while (i < n && cleaned[i] !== ';' && cleaned[i] !== '\n') i += 1;
      if (i < n && cleaned[i] === ';') i += 1;
      continue;
    }
    if (kw.name === 'const') {
      while (i < n && cleaned[i] !== ';' && cleaned[i] !== '\n') i += 1;
      if (i < n && cleaned[i] === ';') i += 1;
      continue;
    }
    if (kw.name === 'function') {
      const m = parseMethod(cleaned, i, kw.end, null, [], lineStarts);
      if (m) { methods.push(m); i = m.end; continue; }
      i = kw.end;
      while (i < n && cleaned[i] !== ';' && cleaned[i] !== '{' && cleaned[i] !== '}') i += 1;
      if (i < n && cleaned[i] === '{') { const c = findMatchingBrace(cleaned, i); if (c === -1) return; i = c + 1; }
      else if (i < n && cleaned[i] === ';') i += 1;
      continue;
    }
    // vis / mod 交错堆叠（如 abstract protected function / public static function），然后是 function 或 $name
    let propVis = null;
    let propMods = [];
    if (isVisName(kw.name)) { propVis = kw.name; }
    if (isModName(kw.name)) { propMods.push(kw.name); }
    let p = kw.end;
    while (p < n) {
      p = skipSpaces(cleaned, p);
      if (p >= n) break;
      if (!/[A-Za-z_$]/.test(cleaned[p])) break;
      const probeId = readIdent(cleaned, p);
      if (!probeId.name) break;
      if (probeId.name === 'function') break;
      if (isVisName(probeId.name) && !propVis) { propVis = probeId.name; p = probeId.end; continue; }
      if (isModName(probeId.name)) { propMods.push(probeId.name); p = probeId.end; continue; }
      break;
    }
    p = skipSpaces(cleaned, p);
    if (p < n && /[A-Za-z_$]/.test(cleaned[p])) {
      const probeId = readIdent(cleaned, p);
      if (probeId.name === 'function') {
        const m = parseMethod(cleaned, i, probeId.end, propVis, propMods, lineStarts);
        if (m) { methods.push(m); i = m.end; continue; }
      }
    }
    // 属性 $name [= ...]
    while (p < n) {
      p = skipSpaces(cleaned, p);
      if (p < n && cleaned[p] === '$') {
        p += 1;
        const pid = readIdent(cleaned, p);
        if (pid.name) {
          let endK = pid.end;
          endK = skipSpaces(cleaned, endK);
          let typeHint = '';
          if (endK < n && cleaned[endK] === ':') {
            endK += 1;
            endK = skipSpaces(cleaned, endK);
            const ts = endK;
            while (endK < n && cleaned[endK] !== '=' && cleaned[endK] !== ';' && cleaned[endK] !== '\n' && cleaned[endK] !== ',') endK += 1;
            typeHint = cleaned.slice(ts, endK).trim();
          }
          endK = skipSpaces(cleaned, endK);
          if (endK < n && cleaned[endK] === '=') {
            endK += 1;
            let depth = 0;
            while (endK < n) {
              const cc = cleaned[endK];
              if (cc === '(' || cc === '{' || cc === '[' || cc === '<') depth += 1;
              else if (cc === ')' || cc === '}' || cc === ']' || cc === '>') depth -= 1;
              else if (depth === 0 && (cc === ';' || cc === '\n')) break;
              endK += 1;
            }
          }
          properties.push({
            name: pid.name, visibility: propVis, modifiers: propMods,
            isStatic: propMods.includes('static'), type: typeHint || null,
            start: i, end: endK,
          });
          i = endK;
          if (i < n && cleaned[i] === ';') i += 1;
          break;
        }
      }
      if (p < n && /[A-Za-z_]/.test(cleaned[p])) {
        const probeId = readIdent(cleaned, p);
        if (probeId.name && isModName(probeId.name)) { p = probeId.end; continue; }
      }
      break;
    }
    if (i === beforeI) i += 1;
  }
}

export function analyzePhpFile(relPath, content) {
  const src = content;
  const lineStarts = computeLineStarts(src);
  const cleaned = stripPhpNoise(src);
  const importMap = new Map();
  const imports = [];
  const nameReferences = new Map();
  function recordRef(name, pos) { if (!name) return; const cur = nameReferences.get(name) ?? []; cur.push(pos); nameReferences.set(name, cur); }
  for (let i = 0; i < cleaned.length; i += 1) {
    const c = cleaned[i];
    if (/[A-Za-z_$]/.test(c)) { const id = readIdent(cleaned, i); if (id.name) { recordRef(id.name, i); i = id.end - 1; } }
  }
  let moduleName = null;
  const KW_TYPE = new Set(['class', 'interface', 'trait', 'enum']);
  const KW_MOD = new Set(['abstract', 'final', 'readonly']);
  const KW_VIS = new Set(['public', 'private', 'protected']);
  const fileClasses = [];
  const fileInterfaces = [];
  const fileTraits = [];
  const moduleFunctions = [];
  const routes = [];
  const n = cleaned.length;
  let i = 0;
  let iter = 0;
  const MAX_ITER = 50000;
  // 类型声明的前置 modifier 暂存（abstract class Foo 的 'abstract' 在类型关键字之前）
  let pendingModifiers = [];
  while (i < n) {
    if (++iter > MAX_ITER) break;
    i = skipSpaces(cleaned, i);
    if (i >= n) break;
    if (cleaned[i] === '?' && cleaned[i + 1] === '>') { i += 2; continue; }
    if (cleaned[i] === '<' && cleaned[i + 1] === '?' && (cleaned[i + 2] === 'p' || cleaned[i + 2] === '=')) {
      i += 2;
      if (cleaned[i] === 'p' || cleaned[i] === 'P') i += 3;
      i = skipSpaces(cleaned, i);
      continue;
    }
    if (!/[A-Za-z_$]/.test(cleaned[i])) { i += 1; continue; }
    const kw = readIdent(cleaned, i);
    if (!kw.name) { i += 1; continue; }
    const startPos = i;
    i = kw.end;
    if (kw.name === 'namespace') {
      let p = skipSpaces(cleaned, kw.end);
      const idStart = p;
      while (p < n && /[A-Za-z0-9_\\]/.test(cleaned[p])) p += 1;
      const ns = cleaned.slice(idStart, p);
      if (ns) moduleName = ns.replace(/\\/g, '.');
      i = p;
      while (i < n && cleaned[i] !== ';' && cleaned[i] !== '\n') i += 1;
      if (i < n && cleaned[i] === ';') i += 1;
      continue;
    }
    if (kw.name === 'use') {
      let p = skipSpaces(cleaned, kw.end);
      const preStart = p;
      while (p < n && /[A-Za-z0-9_\\]/.test(cleaned[p])) p += 1;
      let prefix = cleaned.slice(preStart, p);
      // 群组 use 的前缀以反斜杠结尾（Baz\{...}）：拼接时去掉尾随反斜杠，避免双反斜杠
      prefix = prefix.replace(/\\+$/, '');
      p = skipSpaces(cleaned, p);
      let processed = false;
      if (p < n && cleaned[p] === '{') {
        let q = p + 1;
        while (q < n) {
          q = skipSpaces(cleaned, q);
          if (q < n && cleaned[q] === '}') { q += 1; break; }
          if (q >= n) break;
          const itemStart = q;
          while (q < n && /[A-Za-z0-9_\\]/.test(cleaned[q])) q += 1;
          const itemName = cleaned.slice(itemStart, q);
          q = skipSpaces(cleaned, q);
          let itemAlias = null;
          if (q + 1 < n && cleaned.slice(q, q + 2) === 'as') {
            q += 2;
            q = skipSpaces(cleaned, q);
            const aStart = q;
            while (q < n && /[A-Za-z0-9_\\]/.test(cleaned[q])) q += 1;
            itemAlias = cleaned.slice(aStart, q);
          }
          if (itemName) {
            const full = `${prefix}\\${itemName}`;
            const local = itemAlias ?? itemName;
            imports.push({ specifier: full, alias: itemAlias, isTypeOnly: false, isDynamic: false, names: [{ local, imported: '*' }] });
            importMap.set(local, full);
            processed = true;
          }
          q = skipSpaces(cleaned, q);
          if (q < n && cleaned[q] === ',') { q += 1; continue; }
        }
        p = q;
      } else if (prefix) {
        let specifier = prefix;
        let alias = null;
        if (p + 1 < n && cleaned.slice(p, p + 2) === 'as') {
          p += 2;
          p = skipSpaces(cleaned, p);
          const aStart = p;
          while (p < n && /[A-Za-z0-9_\\]/.test(cleaned[p])) p += 1;
          alias = cleaned.slice(aStart, p).trim();
        }
        const local = alias ?? specifier.split(/\\/).pop();
        imports.push({ specifier, alias, isTypeOnly: false, isDynamic: false, names: [{ local, imported: '*' }] });
        importMap.set(local, specifier);
        processed = true;
      }
      if (!processed) {
        while (p < n && cleaned[p] !== ';' && cleaned[p] !== '\n') p += 1;
      }
      while (p < n && cleaned[p] !== ';' && cleaned[p] !== '\n') p += 1;
      if (p < n && cleaned[p] === ';') p += 1;
      i = p;
      continue;
    }
    if (kw.name === 'require' || kw.name === 'require_once' || kw.name === 'include' || kw.name === 'include_once' || kw.name === 'const' || kw.name === 'define' || kw.name === 'echo') {
      while (i < n && cleaned[i] !== ';' && cleaned[i] !== '\n') i += 1;
      if (i < n && cleaned[i] === ';') i += 1;
      continue;
    }
    // [abstract|final|readonly]+ class/interface/trait/enum：modifier 前缀回退到类型关键字
    if (KW_MOD.has(kw.name)) {
      const probe = skipSpaces(cleaned, kw.end);
      const probeId = readIdent(cleaned, probe);
      if (probeId.name && KW_TYPE.has(probeId.name)) {
        // modifier 前缀暂存（KW_TYPE 分支内只收集类型关键字之后的 token，看不到前缀）
        pendingModifiers = [kw.name];
        i = probe;
        continue;
      }
      // 非类型声明（abstract function 等顶层罕见场景）：落入下方未知 statement fallback
    }
    if (KW_TYPE.has(kw.name)) {
      const modifiers = pendingModifiers.splice(0);
      let visibility = null;
      let typeKw = kw.name;
      let jPos = i;
      while (jPos < n) {
        jPos = skipSpaces(cleaned, jPos);
        if (jPos >= n) break;
        if (!/[A-Za-z_]/.test(cleaned[jPos])) break;
        const id = readIdent(cleaned, jPos);
        if (!id.name) break;
        if (KW_TYPE.has(id.name)) { typeKw = id.name; jPos = id.end; break; }
        if (KW_VIS.has(id.name)) { visibility = id.name; modifiers.push(id.name); jPos = id.end; continue; }
        if (KW_MOD.has(id.name)) { modifiers.push(id.name); jPos = id.end; continue; }
        break;
      }
      const namePos = skipSpaces(cleaned, jPos);
      const nameId = readIdent(cleaned, namePos);
      if (!nameId.name) { i = n; break; }
      let p = nameId.end;
      const extendsNames = [];
      const implementsNames = [];
      while (p < n) {
        p = skipSpaces(cleaned, p);
        if (p >= n) break;
        if (!/[A-Za-z_]/.test(cleaned[p])) break;
        const kwId = readIdent(cleaned, p);
        if (kwId.name === 'extends') {
          p = skipSpaces(cleaned, kwId.end);
          const list = parseNamespacedList(cleaned, p);
          for (const x of list) extendsNames.push(x);
          let q = p;
          for (let kk = 0; kk < 6; kk += 1) {
            q = skipSpaces(cleaned, q);
            const ns = q;
            while (q < n && /[A-Za-z0-9_\\]/.test(cleaned[q])) q += 1;
            if (q === ns) break;
            q = skipSpaces(cleaned, q);
            if (q < n && cleaned[q] === ',') { q += 1; continue; }
            break;
          }
          p = q;
          continue;
        }
        if (kwId.name === 'implements') {
          p = skipSpaces(cleaned, kwId.end);
          const list = parseNamespacedList(cleaned, p);
          for (const x of list) implementsNames.push(x);
          let q = p;
          for (let kk = 0; kk < 6; kk += 1) {
            q = skipSpaces(cleaned, q);
            const ns = q;
            while (q < n && /[A-Za-z0-9_\\]/.test(cleaned[q])) q += 1;
            if (q === ns) break;
            q = skipSpaces(cleaned, q);
            if (q < n && cleaned[q] === ',') { q += 1; continue; }
            break;
          }
          p = q;
          continue;
        }
        break;
      }
      p = skipSpaces(cleaned, p);
      let bodyStart = -1, bodyEnd = -1;
      if (p < n && cleaned[p] === '{') { bodyStart = p; bodyEnd = findMatchingBrace(cleaned, p); }
      let isDataModel = false, isController = false;
      for (const ext of extendsNames) {
        const lower = ext.toLowerCase().replace(/\\.*$/, '');
        if (lower === 'model') isDataModel = true;
        if (lower === 'control') isController = true;
      }
      const methods = [];
      const properties = [];
      const usesTraits = [];
      if (bodyStart !== -1 && bodyEnd !== -1) {
        collectClassMembers(cleaned, bodyStart, bodyEnd, methods, properties, usesTraits, lineStarts);
      }
      if (isController && /(^|\/)module\//.test(relPath) && /(^|\/)control\.php$/.test(relPath)) {
        const moduleMatch = /module\/([^/]+)\/control\.php$/.exec(relPath.replace(/\\/g, '/'));
        const moduleNameRt = moduleMatch ? moduleMatch[1] : null;
        for (const m of methods) {
          if (m.visibility !== 'private' && !m.isAbstract && !m.name.startsWith('__')) {
            routes.push({
              kind: 'route',
              routeType: 'php',
              module: moduleNameRt,
              handler: m.name,
              path: `/${moduleNameRt}-${m.name}`,
              filePath: relPath,
              language: 'php',
            });
          }
        }
      }
      const entity = {
        name: nameId.name,
        qualifiedName: moduleName ? `${moduleName}.${nameId.name}` : nameId.name,
        language: 'php',
        line: lineAt(lineStarts, startPos),
        pos: startPos,
        end: bodyEnd !== -1 ? bodyEnd + 1 : p,
        modifiers, visibility,
        extendsNames, implementsNames, bases: extendsNames,
        isAbstract: modifiers.includes('abstract'),
        isFinal: modifiers.includes('final'),
        isDataModel, isController,
        isTrait: typeKw === 'trait',
        isInterface: typeKw === 'interface',
        usesTraits, methods, properties,
      };
      if (entity.isInterface) fileInterfaces.push(entity);
      else if (entity.isTrait) fileTraits.push(entity);
      else fileClasses.push(entity);
      i = bodyEnd !== -1 ? bodyEnd + 1 : p;
      continue;
    }
    if (kw.name === 'function') {
      const m = parseMethod(cleaned, startPos, kw.end, null, [], lineStarts);
      if (m) { moduleFunctions.push(m); i = m.end; continue; }
      i = kw.end;
      continue;
    }
    const beforeKI = i;
    while (i < n && cleaned[i] !== ';' && cleaned[i] !== '{' && cleaned[i] !== '}' && cleaned[i] !== '\n') i += 1;
    if (i >= n) break;
    if (cleaned[i] === '{') { const c = findMatchingBrace(cleaned, i); if (c === -1) break; i = c + 1; }
    else if (cleaned[i] === ';') i += 1;
    else i += 1;
    if (i === beforeKI) i += 1;
  }
  const classesOutput = fileClasses.map((c) => ({
    kind: c.isDataModel ? 'data_model' : (c.isController ? 'controller' : 'class'),
    name: c.name, qualifiedName: c.qualifiedName, language: 'php',
    line: c.line, pos: c.pos, end: c.end,
    exported: c.visibility !== 'private',
    visibility: c.visibility, modifiers: c.modifiers,
    extendsNames: c.extendsNames, implementsNames: c.implementsNames, bases: c.extendsNames,
    isAbstract: c.isAbstract, isFinal: c.isFinal,
    isDataModel: c.isDataModel, isController: c.isController,
    usesTraits: c.usesTraits,
    fields: c.properties.filter((p) => p.name).map((p) => ({ name: p.name, type: p.type, isStatic: p.isStatic, kind: 'property' })),
    methods: c.methods.filter((m) => m.name).map((m) => ({
      name: m.name, language: 'php', line: m.line, pos: m.start, end: m.end,
      signature: m.signature, visibility: m.visibility, modifiers: m.modifiers,
      isStatic: !!m.isStatic, isAbstract: !!m.isAbstract, isFinal: !!m.isFinal,
      exported: m.visibility !== 'private', hasBody: m.hasBody,
      isConstructor: m.name === '__construct',
      isMagic: ['__construct', '__destruct', '__call', '__get', '__set', '__isset', '__unset', '__toString', '__invoke', '__clone'].includes(m.name),
      sqlQueries: extractDaoQueries(src.slice(m.start, m.end)),
    })),
    properties: c.properties,
  }));
  const interfacesOutput = fileInterfaces.map((c) => ({
    kind: 'interface',
    name: c.name, qualifiedName: c.qualifiedName, language: 'php',
    line: c.line, pos: c.pos, end: c.end,
    exported: c.visibility !== 'private',
    visibility: c.visibility,
    extendsNames: c.extendsNames, bases: c.extendsNames,
    methods: c.methods.filter((m) => m.name).map((m) => ({
      name: m.name, language: 'php', line: m.line, pos: m.start, end: m.end,
      signature: m.signature, visibility: m.visibility, modifiers: m.modifiers,
      isStatic: !!m.isStatic, isAbstract: !!m.isAbstract,
    })),
  }));
  const traitsOutput = fileTraits.map((t) => ({
    kind: 'trait',
    name: t.name, qualifiedName: t.qualifiedName, language: 'php',
    line: t.line, pos: t.pos, end: t.end, exported: true,
    methods: t.methods.filter((m) => m.name).map((m) => ({
      name: m.name, language: 'php', line: m.line, pos: m.start, end: m.end,
      signature: m.signature, visibility: m.visibility, modifiers: m.modifiers,
      isStatic: !!m.isStatic,
      sqlQueries: extractDaoQueries(src.slice(m.start, m.end)),
    })),
    properties: t.properties,
  }));
  const exportNames = [];
  for (const c of fileClasses) if (c.visibility !== 'private') exportNames.push(c.name);
  for (const c of fileInterfaces) if (c.visibility !== 'private') exportNames.push(c.name);
  for (const t of fileTraits) exportNames.push(t.name);
  for (const fn of moduleFunctions) exportNames.push(fn.name);
  let lineCount = 1;
  for (let k = 0; k < src.length; k += 1) if (src.charCodeAt(k) === 10) lineCount += 1;
  return {
    path: relPath, ext: 'php', language: 'php', lineCount,
    exports: [], exportSymbols: [], exportNames,
    imports, importMap, nameReferences,
    classes: classesOutput, interfaces: interfacesOutput, traits: traitsOutput,
    moduleFunctions: moduleFunctions.filter((m) => m.name).map((m) => ({
      name: m.name, language: 'php', line: m.line,
      pos: m.start, end: m.end, signature: m.signature, hasBody: m.hasBody, exported: true,
      sqlQueries: m.hasBody ? extractDaoQueries(src.slice(m.start, m.end)) : [],
    })),
    moduleName, visibility: null, routes,
    sqlQueries: [], crossModuleImports: [],
    defines: extractDefines(src),
    // 与 tsAnalyzer 契约对齐（builder 消费的字段；PHP 无组件/overlay 语义，全部为空）
    jsxTags: new Set(),
    useCalls: [], overlayOpens: [], stores: [], lazyWrappers: [], components: [], hooks: [],
    primaryComponentName: null, hasSingletonClass: false, hasClassExport: false,
    vueRoutes: [], vueRouteMeta: null,
  };
}
