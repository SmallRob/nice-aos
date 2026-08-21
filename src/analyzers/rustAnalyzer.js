// Rust 实体分析器（Tauri src-tauri 组件）：轻量语法级解析（深度状态机 + 等长噪声剥离），
// 与 tsAnalyzer / vueAnalyzer / userScriptAnalyzer 平级共存、逻辑完全独立。
// 实体映射（对齐 TS 语义）：pub struct/enum → Class（kind: struct/enum，fields/derives/variants）；
// pub trait → Interface（supertrait → extendsNames）；impl 内 fn → Method（ownerKind=class）；
// 顶层 fn → Method（ownerKind=module）；use → imports（crate 模块路径，跨文件解析由 builder 统一做）。
// 死代码判定契约：nameReferences（全文标识符位置）+ 实体 pos/end（声明范围），
// 由 collectTypeEntities 统一消费——Rust 类型引用即使用（Vec<Game> / -> Game / impl Game 均计引用）。

import fs from 'node:fs';
import path from 'node:path';

export function isRustCandidate(relPath) {
  return relPath.endsWith('.rs');
}

export function analyzeRustFileFromDisk(relPath, projectRoot) {
  const abs = path.join(projectRoot, relPath);
  const content = fs.readFileSync(abs, 'utf-8');
  return analyzeRustFile(relPath, content);
}

// ---------- 噪声剥离：等长替换字符串/字符字面量/注释为空格（保留换行与偏移量不变） ----------
function stripRustNoise(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (i) => { if (src[i] !== '\n') out[i] = ' '; };
  let i = 0;
  while (i < n) {
    const c = src[i];
    // 行注释
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i += 1; }
      continue;
    }
    // 块注释（Rust 支持嵌套）
    if (c === '/' && src[i + 1] === '*') {
      let depth = 1;
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') { depth += 1; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
        if (src[i] === '*' && src[i + 1] === '/') { depth -= 1; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
        blank(i); i += 1;
      }
      continue;
    }
    // raw string r"..." / r#"..."# / r##"..."##
    if (c === 'r') {
      const m = /^r(#*)"/.exec(src.slice(i, i + 12));
      if (m) {
        const close = '"' + m[1];
        for (let k = 0; k < m[0].length; k++) out[i + k] = ' ';
        i += m[0].length;
        while (i < n) {
          if (src.startsWith(close, i)) { for (let k = 0; k < close.length; k++) out[i + k] = ' '; i += close.length; break; }
          blank(i); i += 1;
        }
        continue;
      }
    }
    // byte string b"..."
    if (c === 'b' && src[i + 1] === '"') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
    // 字符串字面量
    if (c === '"') {
      out[i] = ' '; i += 1;
      while (i < n) {
        if (src[i] === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
        if (src[i] === '"') { out[i] = ' '; i += 1; break; }
        blank(i); i += 1;
      }
      continue;
    }
    // char 字面量（'x' / '\n' / '\''）与生命周期（'a）区分：短闭合才是 char
    if (c === '\'') {
      const m = /^'(?:\\.|[^'\\])'/.exec(src.slice(i, i + 4));
      if (m) { for (let k = 0; k < m[0].length; k++) out[i + k] = ' '; i += m[0].length; continue; }
      i += 1; // lifetime 前缀：保留引号后，ident 照常参与标识符统计
      continue;
    }
    i += 1;
  }
  return out.join('');
}

// ---------- 行号计算 ----------
function computeLineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) {
    if (src.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}
function lineAt(lineStarts, pos) {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// ---------- 声明头解析 ----------
const RE_HEAD_ATTR = /(?:#\[[^\]]*\]\s*)+/;
function stripLeadingAttrs(head) {
  return head.replace(RE_HEAD_ATTR, '');
}
function extractDerives(head) {
  const out = [];
  for (const m of head.matchAll(/#\[\s*derive\s*\(([^)]*)\)\s*\]/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (t) out.push(t.split('<')[0].split('::').pop());
    }
  }
  return out;
}
function isExportedHead(head) {
  return /(?:^|\s)pub(?:\s*\([^)]*\))?\s/.test(head) || /(?:^|\s)pub(?:\s*\([^)]*\))?$/.test(head);
}
// 路径类型取末段标识符：db_v2::Game → Game；Vec<Game> 首标识符 → Vec
function firstNameIdentifier(text) {
  const m = /([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
  return m ? m[1] : null;
}
function lastPathSegment(text) {
  const m = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(text.split('<')[0].trim());
  return m ? m[1] : null;
}
// 剥平衡尖括号泛型段（impl<T: Bound> / HashMap<K, V> 内层嵌套）
function stripLeadingGenerics(text) {
  if (!text.startsWith('<')) return text;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '<') depth += 1;
    else if (text[i] === '>') { depth -= 1; if (depth === 0) return text.slice(i + 1).trim(); }
  }
  return text;
}
function cutAtWhere(text) {
  const idx = text.indexOf(' where ');
  return idx >= 0 ? text.slice(0, idx) : text;
}

function parseImplHead(head) {
  const body = stripLeadingAttrs(head);
  if (!/(?:^|\s)impl\b/.test(body)) return null;
  const m = /(?:^|\s)impl\b/.exec(body);
  let rest = body.slice(m.index + m[0].length).trim();
  rest = stripLeadingGenerics(rest);
  rest = cutAtWhere(rest);
  // for 分割（不在 <> 内的第一个 for）
  let depth = 0, forIdx = -1;
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i];
    if (ch === '<') depth += 1;
    else if (ch === '>') depth -= 1;
    else if (depth === 0 && /\s/.test(ch)) {
      if (rest.slice(i + 1).startsWith('for ') || rest.slice(i + 1).startsWith('for\n')) {
        // 确认是独立 for 关键字
        const before = rest.slice(0, i).trimEnd();
        if (/[A-Za-z0-9_>]$/.test(before)) { forIdx = i; break; }
      }
    }
  }
  let traitPart = null;
  let typePart = rest;
  if (forIdx >= 0) {
    traitPart = rest.slice(0, forIdx).trim();
    typePart = rest.slice(forIdx).replace(/^\s*for\b/, '').trim();
  }
  const implType = firstNameIdentifier(cutAtWhere(typePart));
  const implTrait = traitPart ? lastPathSegment(traitPart) : null;
  if (!implType) return null;
  return { implType, implTrait };
}

// ---------- use 声明解析 ----------
function parseUseStatement(head, pos) {
  const body = stripLeadingAttrs(head);
  const m = /(?:^|\s)use\s+(.+)$/s.exec(body);
  if (!m) return null;
  const stmt = m[1].trim().replace(/;$/, '').trim();
  if (!stmt) return null;
  const names = [];
  let prefix;
  const braceIdx = stmt.indexOf('{');
  if (braceIdx >= 0) {
    prefix = stmt.slice(0, braceIdx).replace(/::\s*$/, '').trim();
    const closeIdx = stmt.lastIndexOf('}');
    const group = stmt.slice(braceIdx + 1, closeIdx);
    for (const part of group.split(',')) {
      const t = part.trim();
      if (!t) continue;
      names.push(parseNameAlias(t));
    }
  } else {
    const segs = stmt.split('::');
    const lastRaw = segs[segs.length - 1].trim();
    prefix = segs.slice(0, -1).join('::').trim();
    const name = parseNameAlias(lastRaw);
    if (name.imported) names.push(name);
  }
  return { prefix, names, pos };
}
function parseNameAlias(text) {
  const asMatch = /^(.+?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(text);
  if (asMatch) return { imported: asMatch[1].trim(), local: asMatch[2] };
  if (text === '*') return { imported: '*', local: '*' };
  const ident = /([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
  return { imported: ident ? ident[1] : text, local: ident ? ident[1] : text };
}

// ---------- struct 字段 / enum 变体 ----------
function parseStructFields(body) {
  const fields = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue; // 属性行（#[serde(rename = ...)] 等）
    const m = /^(?:pub(?:\s*\([^)]*\))?\s+)?([a-z_][a-z0-9_]*)\s*:\s*(.+?),?\s*$/.exec(t);
    if (m) fields.push({ name: m[1], type: m[2].replace(/,\s*$/, '').trim() });
  }
  return fields;
}
function parseEnumVariants(body) {
  const variants = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^([A-Z][A-Za-z0-9_]*)/.exec(t);
    if (m) variants.push(m[1]);
  }
  return variants;
}

// ---------- 主解析 ----------
export function analyzeRustFile(relPath, content) {
  const lineStarts = computeLineStarts(content);
  const stripped = stripRustNoise(content);
  const lineOf = (pos) => lineAt(lineStarts, pos);

  const facts = {
    ext: '.rs',
    lineCount: lineStarts.length,
    isUserScript: false,
    interfaces: [],
    classes: [],
    moduleFunctions: [],
    exportSymbols: [],
    exportNames: [],
    imports: [],
    importMap: new Map(),
    rustUses: [],
    rustMods: [],
    nameReferences: new Map(),
    components: [],
    hooks: [],
    stores: [],
    jsxTags: new Set(),
    useCalls: [],
    overlayOpens: [],
    storeUsages: [],
    hookUsages: [],
    lazyWrappers: [],
    primaryComponentName: null,
    hasSingletonClass: false,
    hasClassExport: false,
    vueRoutes: [],
    vueRouteMeta: null,
  };

  // nameReferences：全文标识符出现位置（含类型位置使用，Rust 类型引用即使用）
  for (const m of stripped.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const arr = facts.nameReferences.get(m[1]);
    if (arr) arr.push(m.index);
    else facts.nameReferences.set(m[1], [m.index]);
  }

  const interfaces = facts.interfaces;
  const classes = facts.classes;
  const impls = []; // { type, trait, methods }（impl 块，同文件 struct 合并；跨文件 impl 不归属）

  const blockStack = []; // { kind, name, head, headStart, bodyStart, exported, derives, implType, implTrait, methods: [] }
  let currentHead = '';
  let headStart = 0;

  const classifyHead = (head, start) => {
    const body = stripLeadingAttrs(head);
    const exported = isExportedHead(body);
    const derives = extractDerives(head);
    let m;
    if ((m = /(?:^|\s)(?:pub(?:\s*\([^)]*\))?\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(body))) {
      // supertrait: trait A: B + C
      const superM = /trait\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>]*>)?\s*:\s*([^{]+)$/.exec(body);
      const extendsNames = superM
        ? superM[1].split('+').map((s) => lastPathSegment(s)).filter(Boolean)
        : [];
      return { kind: 'trait', name: m[1], exported, derives, extendsNames };
    }
    if ((m = /(?:^|\s)(?:pub(?:\s*\([^)]*\))?\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(body))) {
      return { kind: 'struct', name: m[1], exported, derives };
    }
    if ((m = /(?:^|\s)(?:pub(?:\s*\([^)]*\))?\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(body))) {
      return { kind: 'enum', name: m[1], exported, derives };
    }
    if ((m = /(?:^|\s)(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(body))) {
      return { kind: 'mod', name: m[1], exported, derives };
    }
    const impl = parseImplHead(head);
    if (impl) return { kind: 'impl', name: null, exported, derives, ...impl };
    if ((m = /(?:^|\s)(?:pub(?:\s*\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+\S+\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(body))) {
      const sigM = /fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\))\s*(->\s*[^{;]+)?/.exec(body);
      const signature = sigM ? `fn ${sigM[1]}${sigM[2]}${sigM[3] ? ' ' + sigM[3].trim() : ''}` : `fn ${m[1]}`;
      return {
        kind: 'fn', name: m[1], exported, derives,
        isAsync: /\basync\b/.test(body), signature,
      };
    }
    return { kind: 'other', name: null, exported, derives };
  };

  const finishFnFrame = (frame, endPos) => {
    const parent = blockStack[blockStack.length - 1];
    if (parent && (parent.kind === 'impl' || parent.kind === 'trait')) {
      parent.methods.push({
        name: frame.name,
        line: lineOf(frame.headStart),
        isStatic: false,
        isAsync: !!frame.isAsync,
        isOverride: false,
        signature: frame.signature,
        pos: frame.headStart,
        end: endPos + 1,
      });
    } else if (blockStack.length === 0) {
      facts.moduleFunctions.push({
        name: frame.name,
        line: lineOf(frame.headStart),
        exported: frame.exported,
        isAsync: !!frame.isAsync,
        signature: frame.signature,
        pos: frame.headStart,
        end: endPos + 1,
      });
      if (frame.exported) {
        facts.exportSymbols.push({ name: frame.name, kind: 'function', line: lineOf(frame.headStart), isDefault: false, isExported: true });
      }
    }
  };

  const handleSemicolon = (head, start, semiPos) => {
    const body = stripLeadingAttrs(head);
    let m;
    // use 声明
    const useStmt = parseUseStatement(head, start);
    if (useStmt) {
      facts.rustUses.push(useStmt);
      for (const n of useStmt.names) {
        facts.importMap.set(n.local, useStmt.prefix ? `${useStmt.prefix}::${n.imported}` : n.imported);
        facts.imports.push({
          specifier: useStmt.prefix ? `${useStmt.prefix}::${n.imported}` : n.imported,
          isTypeOnly: true,
          isDynamic: false,
          names: [n],
          pos: start,
        });
      }
      return;
    }
    // 无体 mod 声明：mod db_v2;
    if ((m = /(?:^|\s)(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(body))) {
      facts.rustMods.push(m[1]);
      return;
    }
    // 单元/元组结构体：struct S; / struct S(i64);
    if ((m = /(?:^|\s)(?:pub(?:\s*\([^)]*\))?\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(body))
      && !/\{/.test(body)) {
      const exported = isExportedHead(body);
      const derives = extractDerives(head);
      classes.push({
        name: m[1],
        line: lineOf(start),
        exported,
        isSingleton: false,
        kind: 'struct',
        derives,
        fields: [],
        variants: [],
        implementsNames: [],
        extendsName: null,
        methods: [],
        pos: start,
        end: semiPos + 1,
        language: 'rust',
      });
      if (exported) facts.exportSymbols.push({ name: m[1], kind: 'rust-struct', line: lineOf(start), isDefault: false, isExported: true });
      return;
    }
    // trait/impl 内无体方法签名：fn method(...) -> X;
    const parent = blockStack[blockStack.length - 1];
    if (parent && (parent.kind === 'trait' || parent.kind === 'impl')) {
      const cls = classifyHead(head, start);
      if (cls.kind === 'fn') {
        parent.methods.push({
          name: cls.name,
          line: lineOf(start),
          isStatic: false,
          isAsync: !!cls.isAsync,
          isOverride: false,
          signature: cls.signature,
          pos: start,
          end: semiPos + 1,
        });
      }
    }
  };

  const finalizeBlock = (frame, closePos) => {
    const body = stripped.slice(frame.bodyStart, closePos);
    switch (frame.kind) {
      case 'struct':
      case 'enum': {
        classes.push({
          name: frame.name,
          line: lineOf(frame.headStart),
          exported: frame.exported,
          isSingleton: false,
          kind: frame.kind,
          derives: frame.derives,
          fields: frame.kind === 'struct' ? parseStructFields(body) : [],
          variants: frame.kind === 'enum' ? parseEnumVariants(body) : [],
          implementsNames: [],
          extendsName: null,
          methods: [],
          pos: frame.headStart,
          end: closePos + 1,
          language: 'rust',
        });
        if (frame.exported) {
          facts.exportSymbols.push({ name: frame.name, kind: `rust-${frame.kind}`, line: lineOf(frame.headStart), isDefault: false, isExported: true });
        }
        break;
      }
      case 'trait': {
        interfaces.push({
          name: frame.name,
          line: lineOf(frame.headStart),
          exported: frame.exported,
          extendsNames: frame.extendsNames ?? [],
          methods: frame.methods,
          pos: frame.headStart,
          end: closePos + 1,
          language: 'rust',
        });
        if (frame.exported) {
          facts.exportSymbols.push({ name: frame.name, kind: 'rust-trait', line: lineOf(frame.headStart), isDefault: false, isExported: true });
        }
        break;
      }
      case 'impl': {
        impls.push({ type: frame.implType, trait: frame.implTrait, methods: frame.methods });
        break;
      }
      case 'fn': {
        finishFnFrame(frame, closePos);
        break;
      }
      case 'mod': {
        facts.rustMods.push(frame.name);
        break;
      }
      default:
        break;
    }
  };

  for (let i = 0; i < stripped.length; i += 1) {
    const c = stripped[i];
    // use 花括组（use crate::a::{B, C}）：花括号属于语句本身，不开代码块；
    // 组内标识符重新拼回语句头，由后续 ';' 触发 handleSemicolon 统一解析（支持嵌套组）
    if (c === '{') {
      const inUseGroup = blockStack.length > 0 && blockStack[blockStack.length - 1].kind === 'usegroup';
      if (inUseGroup || /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?use\s+/.test(currentHead)) {
        blockStack.push({ kind: 'usegroup', head: currentHead, headStart });
        currentHead = '';
        headStart = i + 1;
      } else {
        const cls = classifyHead(currentHead, headStart);
        blockStack.push({ ...cls, head: currentHead, headStart, bodyStart: i + 1, methods: [] });
        currentHead = '';
        headStart = i + 1;
      }
    } else if (c === '}') {
      const frame = blockStack.pop();
      if (frame?.kind === 'usegroup') {
        currentHead = frame.head + '{' + currentHead + '}';
        headStart = frame.headStart;
      } else {
        if (frame) finalizeBlock(frame, i);
        currentHead = '';
        headStart = i + 1;
      }
    } else if (c === ';') {
      handleSemicolon(currentHead, headStart, i);
      currentHead = '';
      headStart = i + 1;
    } else {
      currentHead += c;
    }
  }

  // impl 块合并到同文件类型（Rust 允许跨文件 impl；跨文件 impl 方法不归属，fn 引用仍计入 nameReferences）
  const classByName = new Map(classes.map((c) => [c.name, c]));
  for (const impl of impls) {
    const target = classByName.get(impl.type);
    if (!target) continue;
    if (impl.trait && !target.implementsNames.includes(impl.trait)) {
      target.implementsNames.push(impl.trait);
    }
    target.methods.push(...impl.methods);
  }

  facts.exportNames = facts.exportSymbols.map((s) => s.name);
  return facts;
}

// ---------- Rust use 路径 → 目标文件解析（全仓库层，builder 调用） ----------
// crate::a::b::Name → <crateRoot>/a/b.rs 或 <crateRoot>/a/b/mod.rs
// super::/self:: 相对当前文件模块路径推导；非 crate::/super::/self:: 前缀 → 外部 crate
export function crateRootOf(relPath) {
  // crate 根约定：src-tauri/src/（Tauri）或任意 /src/ 段（普通 Rust crate）或扫描根直挂
  const tauriIdx = relPath.indexOf('src-tauri/src/');
  if (tauriIdx >= 0) return relPath.slice(0, tauriIdx + 'src-tauri/src/'.length);
  const srcIdx = relPath.indexOf('/src/');
  if (srcIdx >= 0) return relPath.slice(0, srcIdx + '/src/'.length);
  return null; // 无法定位 crate 根（文件直挂扫描根）
}

// 当前文件的 crate 内模块路径：src-tauri/src/db_v2/schema.rs → ['db_v2','schema']；
// mod.rs/lib.rs/main.rs → 目录段
export function moduleSegmentsOf(relPath) {
  const root = crateRootOf(relPath);
  if (!root) return null;
  let inner = relPath.slice(root.length).replace(/\.rs$/, '');
  const segs = inner.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  if (last === 'mod' || last === 'lib' || last === 'main') segs.pop();
  return segs;
}

// 解析 use 路径到目标文件（rustFiles: Set<relPath> 全仓库 .rs 清单）
// 返回 { kind: 'external', package } | { kind: 'internal', file, importedName } | { kind: 'unresolved' }
export function resolveRustUse(fromRelPath, usePath, rustFiles) {
  const segs = usePath.split('::').map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0) return { kind: 'unresolved' };
  const first = segs[0];
  let modSegs = null;
  if (first === 'crate') {
    const root = crateRootOf(fromRelPath);
    if (!root) return { kind: 'unresolved' };
    modSegs = { root, rest: segs.slice(1) };
  } else if (first === 'super' || first === 'self') {
    const root = crateRootOf(fromRelPath);
    const cur = moduleSegmentsOf(fromRelPath);
    if (!root || !cur) return { kind: 'unresolved' };
    let base = cur.slice();
    for (const s of segs) {
      if (s === 'super') { if (base.length === 0) return { kind: 'unresolved' }; base.pop(); }
      else if (s === 'self') { /* 当前模块 */ }
      else { base.push(s); }
    }
    modSegs = { root, rest: base };
    // base 含名字段：最后一段可能是类型名，由文件尝试逻辑处理
  } else {
    return { kind: 'external', package: first };
  }
  if (modSegs.rest.length === 0) return { kind: 'unresolved' };
  // 从最长前缀向下尝试文件路径：rest = ['db_v2','schema','Game'] 依次试 db_v2/schema/Game.rs、db_v2/schema.rs
  for (let take = modSegs.rest.length; take >= 1; take -= 1) {
    const prefix = modSegs.rest.slice(0, take);
    const f1 = modSegs.root + prefix.join('/') + '.rs';
    const f2 = modSegs.root + prefix.join('/') + '/mod.rs';
    if (rustFiles.has(f1)) {
      const nameSegs = modSegs.rest.slice(take);
      return { kind: 'internal', file: f1, importedName: nameSegs.length ? nameSegs[0] : '*' };
    }
    if (rustFiles.has(f2)) {
      const nameSegs = modSegs.rest.slice(take);
      return { kind: 'internal', file: f2, importedName: nameSegs.length ? nameSegs[0] : '*' };
    }
  }
  return { kind: 'unresolved' };
}
