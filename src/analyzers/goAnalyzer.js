// Go 实体分析器（Go CLI / agent 代理 / Gin 后端）：轻量语法级解析（深度状态机 + 等长噪声剥离），
// 与 tsAnalyzer / vueAnalyzer / rustAnalyzer / dartAnalyzer 平级共存、逻辑完全独立。
// 实体映射（对齐 TS/Rust/Dart 语义）：
//   type X struct → Class（kind: struct，字段含 json/gorm tag；匿名内嵌字段名取类型末段）；
//   type X interface → Interface（嵌入接口 → extendsNames，方法签名 → methods）；
//   func (r T) M() → Method（ownerKind=class；接收者类型不在本文件时进 goOrphanMethods，
//     由 builder 按「同目录同包」合并到声明文件——Go 允许同包跨文件定义方法）；
//   func M() → Method（ownerKind=module；Go 可见性：首字母大写 = exported；init/main 恒为入口不判死）；
//   import → imports（URL 风格路径 + 别名，module 前缀判定 internal/external 由 builder 统一做）；
//   cobra 命令 → goCommands/goCommandEdges（var x = &cobra.Command{Use/Short} + AddCommand 树 + Flags）；
//   gin/标准库路由 → goRoutes（Group 前缀链累积、动态段 :x / *x、中间件与 handler 分离）；
//   方法体内调用 → callEdges（pkg 跨包调用 / local 本文件调用 / method 接收者类型推断）。
// 双通道设计：stripGoNoise（全剥离：字符串+rune+注释）供块状态机与调用提取；
// stripCommentsOnly（仅剥注释，保留字符串）供 import / 路由路径 / 命令 Use/Short / struct tag 提取
// ——Go 的这些内容均为字符串字面量，全剥离会丢失内容。两通道等长，偏移量对齐。
// 死代码判定契约：nameReferences（全文标识符位置）+ 实体 pos/end（声明范围），
// 由 collectTypeEntities 统一消费——Go 标识符引用即使用。

import fs from 'node:fs';
import path from 'node:path';

export function isGoCandidate(relPath) {
  return relPath.endsWith('.go');
}

export function analyzeGoFileFromDisk(relPath, projectRoot) {
  const abs = path.join(projectRoot, relPath);
  const content = fs.readFileSync(abs, 'utf-8');
  return analyzeGoFile(relPath, content);
}

// 方法体内调用提取时排除的关键字 / 内建函数 / 预声明类型（裸调用名匹配用）
const CALL_EXCLUDE = new Set([
  'if', 'for', 'while', 'switch', 'return', 'defer', 'go', 'select', 'range', 'func',
  'var', 'const', 'type', 'map', 'chan', 'interface', 'struct', 'package', 'import',
  'case', 'default', 'else', 'break', 'continue', 'goto', 'fallthrough', 'do',
  'make', 'new', 'len', 'cap', 'append', 'copy', 'delete', 'panic', 'recover',
  'print', 'println', 'close', 'min', 'max', 'clear',
  'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32',
  'uint64', 'uintptr', 'float32', 'float64', 'complex64', 'complex128',
  'string', 'bool', 'byte', 'rune', 'error', 'any', 'true', 'false', 'nil', 'iota',
]);

// ---------- 噪声剥离 ----------
// 全剥离：等长替换字符串/rune/注释为空格（保留换行与偏移量不变），供块结构状态机使用
function stripGoNoise(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (i) => { if (src[i] !== '\n') out[i] = ' '; };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
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
    if (c === '"') {
      out[i] = ' '; i += 1;
      while (i < n) {
        if (src[i] === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
        if (src[i] === '"') { out[i] = ' '; i += 1; break; }
        blank(i); i += 1;
      }
      continue;
    }
    if (c === '`') {
      out[i] = ' '; i += 1;
      while (i < n) {
        if (src[i] === '`') { out[i] = ' '; i += 1; break; }
        blank(i); i += 1;
      }
      continue;
    }
    if (c === "'") {
      const m = /^'(?:\\.|[^'\\])'/.exec(src.slice(i, i + 10));
      if (m) { for (let k = 0; k < m[0].length; k++) out[i + k] = ' '; i += m[0].length; continue; }
      i += 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

// 仅剥注释（保留字符串/rune 内容）：import 路径、路由 path、命令 Use/Short、struct tag 提取用
function stripCommentsOnly(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i += 1; }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n) {
        if (src[i] === '*' && src[i + 1] === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; break; }
        if (src[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (c === '"' || c === '`') {
      const q = c;
      i += 1;
      while (i < n) {
        if (q === '"' && src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === "'") {
      const m = /^'(?:\\.|[^'\\])'/.exec(src.slice(i, i + 10));
      if (m) { i += m[0].length; continue; }
      i += 1;
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

// ---------- import 提取（commentsOnly 通道） ----------
function extractImports(clean) {
  const imports = [];
  const push = (specifier, alias, pos) => {
    const local = alias || specifier.split('/').pop();
    imports.push({
      specifier,
      alias,
      isTypeOnly: false,
      isDynamic: false,
      names: [{ local, imported: '*' }], // Go 整包导入，local = 别名或路径末段
      pos,
    });
  };
  // 分组 import ( ... )：括号平衡扫描（字符串内括号不干扰——clean 通道字符串内容保留，
  // 但 import 路径不含括号，且组内行级正则足够）
  const groupRe = /import\s*\(/g;
  let m;
  while ((m = groupRe.exec(clean))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < clean.length && depth > 0) {
      if (clean[i] === '(') depth += 1;
      else if (clean[i] === ')') depth -= 1;
      i += 1;
    }
    const body = clean.slice(m.index + m[0].length, i - 1);
    for (const line of body.split('\n')) {
      const t = line.trim();
      const lm = /^(?:([A-Za-z_]\w*)\s+)?"([^"]+)"$/.exec(t);
      if (lm) push(lm[2], lm[1] ?? null, m.index);
    }
    groupRe.lastIndex = i;
  }
  // 单行 import "path" / import alias "path"（`import (` 后是 '('，不会命中单行正则）
  const singleRe = /(?:^|\n)[ \t]*import\s+(?:([A-Za-z_]\w*)\s+)?"([^"]+)"/g;
  while ((m = singleRe.exec(clean))) {
    push(m[2], m[1] ?? null, m.index);
  }
  return imports;
}

// ---------- struct 字段解析（commentsOnly 通道，含 tag 与匿名内嵌） ----------
function parseStructFields(body, bodyStart, lineStarts) {
  const fields = [];
  let depth = 0;
  let offset = 0;
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (depth === 0 && t) {
      let m;
      if ((m = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+([^`]*?)\s*(?:`([^`]*)`\s*)?$/.exec(t))) {
        // 具名字段：Name Type `tag`（可能多名字段 A, B int）
        const names = m[1].split(',').map((s) => s.trim());
        let type = m[2].replace(/\s*\{\s*$/, '').trim();
        const tag = m[3] ?? null;
        for (const name of names) {
          if (!name) continue;
          fields.push({ name, type: type || 'struct', tag });
        }
      } else if ((m = /^(\*?[A-Za-z_][\w.]*)\s*(?:`([^`]*)`\s*)?$/.exec(t))) {
        // 匿名内嵌字段：sync.Mutex / *Base（名取类型末段）
        const typeName = m[1];
        fields.push({ name: typeName.replace(/^\*/, '').split('.').pop(), type: typeName, tag: m[2] ?? null });
      }
    }
    for (const ch of t) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    offset += line.length + 1;
  }
  return fields;
}

// ---------- interface 方法与嵌入接口解析（commentsOnly 通道） ----------
function parseInterfaceBody(body, bodyStart, lineStarts) {
  const methods = [];
  const extendsNames = [];
  let offset = 0;
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t) {
      const m = /^([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(t);
      if (m) {
        methods.push({
          name: m[1],
          line: lineAt(lineStarts, bodyStart + offset),
          isStatic: false,
          isAsync: false,
          isOverride: false,
          signature: t.replace(/\s+/g, ' ').slice(0, 140),
        });
      } else if (/^[A-Za-z_]\w*$/.test(t)) {
        // 嵌入接口：type A interface { B; M() }
        extendsNames.push(t);
      }
    }
    offset += line.length + 1;
  }
  return { methods, extendsNames };
}

// ---------- 方法体内调用提取（逻辑调用链，stripped 通道） ----------
// varTypes：接收者 + 参数 + 体内构造字面量推断的变量类型表（词法近似）
// 类型文本归一：[]*User / map[string]User / *pkg.Request → User（取末段，仅保留大写开头类型）
function baseTypeName(text) {
  const t = text.replace(/(?:\[\]|\*)|map\[[^\]]*\]/g, '').trim();
  const last = t.split('.').pop() ?? '';
  return /^[A-Z]/.test(last) ? last : null;
}
function extractGoCalls(bodyText, bodyStart, lineStarts, importMap, localClassNames, varTypes, varChains) {
  const calls = [];
  const lineOf = (rel) => lineAt(lineStarts, bodyStart + rel);
  // 体内变量类型推断：x := &T{...} / x := T{...} / var x T / var x *pkg.T
  for (const vm of bodyText.matchAll(/([A-Za-z_]\w*)\s*:?=\s*&?([A-Z][A-Za-z0-9_]*)\s*\{/g)) {
    varTypes.set(vm[1], vm[2]);
  }
  for (const vm of bodyText.matchAll(/\bvar\s+([A-Za-z_]\w*)\s+((?:\[\]|\*)*[\w.]+(?:\[[^\]]*\])?[\w.]*)/g)) {
    const ty = baseTypeName(vm[2]);
    if (ty) varTypes.set(vm[1], ty);
  }
  // 限定链赋值：x := pkg.Var.Chain（链首为包别名；后随非 '(' 非 '{' 排除调用与复合字面量）。
  // gin-vue-admin 惯例：baseApi := v1.ApiGroupApp.SystemApiGroup.BaseApi 后经 baseApi.Register 引用
  for (const vm of bodyText.matchAll(/([A-Za-z_]\w*)\s*:?=\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)(?![\w.\[]*[(])/g)) {
    if (varChains && !varChains.has(vm[1])) varChains.set(vm[1], vm[2]);
  }
  const seen = new Set();
  // 深链调用 pkg.Var.Chain.Method(：链长≥3 且链首是 import 包别名 → 目标包子树内按末段名搜索
  for (const m of bodyText.matchAll(/(?<![A-Za-z0-9_.])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*){2,})\s*\(/g)) {
    const parts = m[1].split('.');
    const spec = importMap.get(parts[0]);
    if (!spec) continue;
    const to = parts[parts.length - 1];
    const key = `pkgchain:${spec}#${to}`;
    if (!seen.has(key)) { seen.add(key); calls.push({ kind: 'pkgchain', toPkg: spec, to, line: lineOf(m.index) }); }
  }
  // 两段式调用 pkg.Func( / var.Method( / Type.Method(（前导边界排除链式后半段）
  for (const m of bodyText.matchAll(/(?<![A-Za-z0-9_.])([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/g)) {
    const seg1 = m[1];
    const seg2 = m[2];
    const pkgPath = importMap.get(seg1);
    if (pkgPath) {
      const key = `pkg:${pkgPath}#${seg2}`;
      if (!seen.has(key)) { seen.add(key); calls.push({ kind: 'pkg', toPkg: pkgPath, to: seg2, line: lineOf(m.index) }); }
      continue;
    }
    const chain = varChains?.get(seg1);
    if (chain) {
      const head = chain.split('.')[0];
      const spec = importMap.get(head);
      if (spec) {
        const key = `pkgchain:${spec}#${seg2}`;
        if (!seen.has(key)) { seen.add(key); calls.push({ kind: 'pkgchain', toPkg: spec, to: seg2, line: lineOf(m.index) }); }
        continue;
      }
    }
    const recvType = varTypes.get(seg1);
    if (recvType) {
      const key = `method:${recvType}#${seg2}`;
      if (!seen.has(key)) { seen.add(key); calls.push({ kind: 'method', receiverType: recvType, to: seg2, line: lineOf(m.index) }); }
      continue;
    }
    if (localClassNames.has(seg1)) {
      // 方法表达式 T.Method（值接收者方法的显式引用形态）
      const key = `method:${seg1}#${seg2}`;
      if (!seen.has(key)) { seen.add(key); calls.push({ kind: 'method', receiverType: seg1, to: seg2, line: lineOf(m.index) }); }
    }
    // 其余（链式 x.Field.Method / 包级变量成员）不可静态解析，跳过
  }
  // 裸调用 Name(：本文件顶层函数 / 同类其他方法 / 同包函数
  for (const m of bodyText.matchAll(/(?<![A-Za-z0-9_.])([A-Za-z_]\w*)\s*\(/g)) {
    const name = m[1];
    if (CALL_EXCLUDE.has(name)) continue;
    const key = `local:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push({ kind: 'local', to: name, line: lineOf(m.index) });
  }
  return calls;
}

// ---------- cobra CLI 命令提取（结构扫描用 stripped，内容提取用 clean，偏移对齐） ----------
function extractCobraCommands(stripped, clean, lineStarts) {
  const commands = [];
  const edges = [];
  const flagsByVar = new Map();
  const lineOf = (pos) => lineAt(lineStarts, pos);
  // var xxxCmd = &cobra.Command{ ... }：平衡花括号扫描块体（stripped 通道防字符串内花括号干扰）
  const cmdRe = /([A-Za-z_]\w*)\s*:?=\s*&cobra\.Command\s*\{/g;
  let m;
  while ((m = cmdRe.exec(stripped))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < stripped.length && depth > 0) {
      if (stripped[i] === '{') depth += 1;
      else if (stripped[i] === '}') depth -= 1;
      i += 1;
    }
    const body = clean.slice(m.index + m[0].length, i - 1);
    const useM = /Use\s*:\s*"([^"]*)"/.exec(body);
    const shortM = /Short\s*:\s*"([^"]*)"/.exec(body);
    const use = useM ? useM[1] : null;
    commands.push({
      varName: m[1],
      use: use ? use.split(/\s+/)[0] : m[1],
      useFull: use,
      short: shortM ? shortM[1].slice(0, 80) : null,
      line: lineOf(m.index),
      flags: [],
    });
    cmdRe.lastIndex = i;
  }
  // AddCommand 注册边（含多参数形式；跨包限定子命令 k8s.ApplySSHCmd 由 builder 经 importMap 归一）
  const addRe = /([A-Za-z_]\w*)\.AddCommand\s*\(([^()]*)\)/g;
  while ((m = addRe.exec(stripped))) {
    for (const part of m[2].split(',')) {
      const t = part.trim();
      const qm = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(t);
      if (qm) {
        edges.push({ parentVar: m[1], childVar: t, childPkg: qm[1], childName: qm[2] });
      } else if (/^[A-Za-z_]\w*$/.test(t)) {
        edges.push({ parentVar: m[1], childVar: t });
      }
    }
  }
  // Flags 注册：xxxCmd.Flags().StringP("type", "T", ...)（clean 通道：flag 名为字符串字面量）
  const flagRe = /([A-Za-z_]\w*)\.(?:PersistentFlags|Flags)\(\)\.\w+\(\s*"([^"]*)"\s*(?:,\s*"([^"]*)")?/g;
  while ((m = flagRe.exec(clean))) {
    const varName = m[1];
    const cmd = commands.find((c) => c.varName === varName);
    if (cmd) cmd.flags.push({ name: m[2], shorthand: m[3] ?? null });
  }
  return { commands, edges };
}

// ---------- gin / 标准库 HTTP 路由提取 ----------
function joinPath(prefix, p) {
  if (!prefix) return p.startsWith('/') ? p : `/${p}`;
  if (p === '' || p === '/') return prefix.endsWith('/') ? prefix : `${prefix}/`;
  const base = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return base + (p.startsWith('/') ? p.slice(1) : p);
}

// 顶层逗号分割（括号/花括号/方括号深度感知）
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

function extractGinRoutes(stripped, clean, lineStarts, varChains) {
  const routes = [];
  const lineOf = (pos) => lineAt(lineStarts, pos);
  // router 变量白名单：engine 变量（gin.New/Default）+ group 变量 + 函数参数（*gin.RouterGroup / *gin.Engine）。
  // 注册方法必须挂在白名单变量上——排除 zap.Any("error", err) 等日志/上下文调用的同名方法误报
  const routerVars = new Set();
  for (const em of stripped.matchAll(/([A-Za-z_]\w*)\s*:?=\s*gin\.(?:New|Default)\s*\(/g)) {
    routerVars.add(em[1]);
  }
  for (const pm of clean.matchAll(/func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s*)?\w+\s*\(([^)]*)\)/g)) {
    for (const am of pm[1].matchAll(/(?:^|,)\s*(\w+)\s+\*?gin\.(?:RouterGroup|Engine)\b/g)) {
      routerVars.add(am[1]);
    }
  }
  // Group 前缀变量表：apiRouter := router.Group("/api") → 前缀链累积
  const groupPrefix = new Map();
  const groupOwnMw = new Map(); // 变量 → 自身 Use() 注册的中间件（engine 变量亦有）
  const groupMw = new Map(); // 变量 → 含父组继承的有效中间件链
  const groupRe = /([A-Za-z_]\w*)\s*:?=\s*([A-Za-z_]\w*)\.Group\s*\(/g;
  let m;
  const groups = [];
  while ((m = groupRe.exec(stripped))) {
    const pathM = /^\s*"([^"]*)"/.exec(clean.slice(groupRe.lastIndex));
    if (pathM) {
      groups.push({ varName: m[1], parentVar: m[2], path: pathM[1] });
      // gin-vue-admin 链式中间件：PrivateGroup := Router.Group("").Use(middleware.JWTAuth()).Use(...)
      // Group 参数区结束（括号平衡）后连续的 .Use(...) 链一并归入本组中间件（stripped/clean 等长，绝对偏移对齐）
      let depth = 1;
      let i = groupRe.lastIndex;
      while (i < stripped.length && depth > 0) {
        if (stripped[i] === '(') depth += 1;
        else if (stripped[i] === ')') depth -= 1;
        i += 1;
      }
      const mwList = [];
      let cursor = i;
      for (let guard = 0; guard < 8; guard += 1) {
        const rm = /^\s*\.\s*Use\s*\(/.exec(stripped.slice(cursor));
        if (!rm) break;
        const argsStart = cursor + rm[0].length;
        let d = 1;
        let j = argsStart;
        while (j < stripped.length && d > 0) {
          if (stripped[j] === '(') d += 1;
          else if (stripped[j] === ')') d -= 1;
          j += 1;
        }
        for (const part of splitTopLevel(clean.slice(argsStart, j - 1))) {
          const callM = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/.exec(part.trim());
          if (callM) {
            const mw = callM[1].split('.').pop();
            if (!mwList.includes(mw)) mwList.push(mw);
          }
        }
        cursor = j;
      }
      if (mwList.length) groupOwnMw.set(m[1], mwList);
    }
  }
  // group 变量本身也是合法注册接收者（Router.Group("user") 直接 .POST）
  for (const g of groups) routerVars.add(g.varName);
  // 组级/引擎级中间件：xxx.Use(middleware.Auth())（平衡括号扫描参数区，clean 通道取函数名）
  const useRe = /([A-Za-z_]\w*)\.Use\s*\(/g;
  while ((m = useRe.exec(stripped))) {
    let depth = 1;
    let i = useRe.lastIndex;
    while (i < stripped.length && depth > 0) {
      if (stripped[i] === '(') depth += 1;
      else if (stripped[i] === ')') depth -= 1;
      i += 1;
    }
    const argsText = clean.slice(useRe.lastIndex, i - 1);
    for (const part of splitTopLevel(argsText)) {
      const callM = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/.exec(part.trim());
      if (callM) {
        if (!groupOwnMw.has(m[1])) groupOwnMw.set(m[1], []);
        const mw = callM[1].split('.').pop();
        if (!groupOwnMw.get(m[1]).includes(mw)) groupOwnMw.get(m[1]).push(mw);
      }
    }
  }
  // 前缀链 + 中间件继承：子组 = 父组前缀/中间件 + 自身（源序：父组声明先于子组）
  for (const g of groups) {
    const parentPrefix = groupPrefix.get(g.parentVar) ?? '';
    groupPrefix.set(g.varName, joinPath(parentPrefix, g.path));
    const parentMw = groupMw.get(g.parentVar) ?? [];
    groupMw.set(g.varName, [...parentMw, ...(groupOwnMw.get(g.varName) ?? [])]);
  }
  // 路由注册：apiRouter.GET("/path", middleware.X(), handler)（平衡括号扫描取完整参数区）
  const regRe = /([A-Za-z_]\w*)\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any)\s*\(/g;
  while ((m = regRe.exec(stripped))) {
    const varName = m[1];
    if (!routerVars.has(varName)) continue; // zap.Any("error") / c.Any(...) 等非 router 变量不产路由
    const method = m[2] === 'Any' ? 'ANY' : m[2].toUpperCase();
    let depth = 1;
    let i = regRe.lastIndex;
    while (i < stripped.length && depth > 0) {
      if (stripped[i] === '(') depth += 1;
      else if (stripped[i] === ')') depth -= 1;
      i += 1;
    }
    const argsText = clean.slice(regRe.lastIndex, i - 1);
    const pathM = /^\s*"([^"]*)"/.exec(argsText);
    if (!pathM) continue;
    const prefix = groupPrefix.get(varName) ?? '';
    const fullPath = joinPath(prefix, pathM[1]);
    const handlers = [];
    let handlerChain = null;
    const middlewares = [...(groupMw.get(varName) ?? [])];
    for (const part of splitTopLevel(argsText.slice(pathM[0].length))) {
      const t = part.trim();
      if (!t) continue;
      const refM = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(t);
      if (refM) {
        // 无括号引用 = handler 函数值（gin 惯例：最后一个无括号参数是最终 handler）
        handlers.push(`${refM[1]}.${refM[2]}`);
        // 字段链变量间接引用：baseApi.Register → varChains 展开为 v1.ApiGroupApp...BaseApi.Register
        // （gin-vue-admin 惯例，builder 按链首 import 别名定位包目录并在子树内搜索方法）
        const chain = varChains?.get(refM[1]);
        if (chain && !handlerChain) handlerChain = `${chain}.${refM[2]}`;
      } else {
        const callM = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/.exec(t);
        if (callM) middlewares.push(callM[1].split('.').pop());
      }
    }
    routes.push({
      method,
      path: fullPath,
      handlers,
      handlerChain,
      middlewares,
      line: lineOf(m.index),
    });
  }
  // gin Handle("GET", "/path", ...) 形式
  const handleRe = /([A-Za-z_]\w*)\.Handle\s*\(\s*"(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|ANY)"\s*,\s*"([^"]*)"/g;
  while ((m = handleRe.exec(clean))) {
    if (!routerVars.has(m[1])) continue;
    const prefix = groupPrefix.get(m[1]) ?? '';
    routes.push({
      method: m[2] === 'ANY' ? 'ANY' : m[2],
      path: joinPath(prefix, m[3]),
      handlers: [],
      middlewares: [],
      line: lineOf(m.index),
    });
  }
  // 标准库兜底：http.HandleFunc("/path", handler) / mux.Handle("/path", h)（方法无关 → ANY）
  const stdRe = /(?:^|[^.\w])(?:[A-Za-z_]\w*)?\.HandleFunc\s*\(\s*"([^"]*)"/g;
  while ((m = stdRe.exec(clean))) {
    routes.push({ method: 'ANY', path: m[1], handlers: [], middlewares: [], line: lineOf(m.index) });
  }
  const stdHandleRe = /(?:^|[^.\w])http\.Handle\s*\(\s*"([^"]*)"/g;
  while ((m = stdHandleRe.exec(clean))) {
    routes.push({ method: 'ANY', path: m[1], handlers: [], middlewares: [], line: lineOf(m.index) });
  }
  return routes;
}

// ---------- 声明头分类：head 内取最后一个声明匹配（Go ASI 多语句头容错） ----------
function classifyGoHead(head) {
  let m;
  let typeMatch = null;
  const typeRe = /type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(struct|interface)\b/g;
  while ((m = typeRe.exec(head))) typeMatch = m;
  if (typeMatch) {
    return { kind: typeMatch[2], name: typeMatch[1], sigStart: typeMatch.index };
  }
  let funcMatch = null;
  // func\s+ 后必须跟名字（或接收者+名字）；func( 直接跟括号 = 匿名函数字面量，不匹配
  const funcRe = /func\s+(?:\(\s*\w+\s+\*?([A-Za-z_]\w*)\s*\)\s*)?([A-Za-z_]\w*)\s*\(/g;
  while ((m = funcRe.exec(head))) funcMatch = m;
  if (funcMatch) {
    return {
      kind: 'func',
      name: funcMatch[2],
      receiverType: funcMatch[1] ?? null,
      sigStart: funcMatch.index,
    };
  }
  return { kind: 'other', name: null };
}

// ---------- 主解析 ----------
export function analyzeGoFile(relPath, content) {
  const lineStarts = computeLineStarts(content);
  const stripped = stripGoNoise(content);
  const clean = stripCommentsOnly(content);
  const lineOf = (pos) => lineAt(lineStarts, pos);

  const facts = {
    ext: 'go',
    lineCount: lineStarts.length,
    isUserScript: false,
    language: 'go',
    packageName: null,
    interfaces: [],
    classes: [],
    moduleFunctions: [],
    goOrphanMethods: [],
    exportSymbols: [],
    exportNames: [],
    imports: [],
    importMap: new Map(),
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
    callEdges: [],
    goCommands: [],
    goCommandEdges: [],
    goRoutes: [],
  };

  // package 声明（Go 目录级包名）
  const pkgM = /^[ \t]*package\s+([A-Za-z_]\w*)/m.exec(clean);
  facts.packageName = pkgM ? pkgM[1] : null;

  // nameReferences：全文标识符出现位置（Go 标识符引用即使用）
  for (const m of stripped.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const arr = facts.nameReferences.get(m[1]);
    if (arr) arr.push(m.index);
    else facts.nameReferences.set(m[1], [m.index]);
  }

  // import（commentsOnly 通道：路径为字符串字面量）
  for (const imp of extractImports(clean)) {
    facts.imports.push(imp);
    if (imp.names[0].local) facts.importMap.set(imp.names[0].local, imp.specifier);
  }

  const interfaces = facts.interfaces;
  const classes = facts.classes;
  const blockStack = []; // { kind, name, headStart, bodyStart, sigStart, receiverType, head }
  let currentHead = '';
  let headStart = 0;

  const classByName = new Map();
  // 文件级限定链变量表：baseApi := v1.ApiGroupApp.SystemApiGroup.BaseApi（函数体内提取，跨函数共享；
  // gin-vue-admin 的链式 handler 引用与调用链提取共用）
  const varChains = new Map();

  const finalizeBlock = (frame, closePos) => {
    switch (frame.kind) {
      case 'struct': {
        const fields = parseStructFields(clean.slice(frame.bodyStart, closePos), frame.bodyStart, lineStarts);
        const exported = /^[A-Z]/.test(frame.name);
        classes.push({
          name: frame.name,
          line: lineOf(frame.headStart + frame.sigStart),
          exported,
          isSingleton: false,
          kind: 'struct',
          derives: [],
          fields,
          variants: [],
          implementsNames: [],
          extendsName: null,
          methods: [],
          pos: frame.headStart + frame.sigStart,
          end: closePos + 1,
          language: 'go',
        });
        classByName.set(frame.name, classes[classes.length - 1]);
        if (exported) {
          facts.exportSymbols.push({ name: frame.name, kind: 'type', line: lineOf(frame.headStart + frame.sigStart), isDefault: false, isExported: true });
        }
        break;
      }
      case 'interface': {
        const { methods, extendsNames } = parseInterfaceBody(clean.slice(frame.bodyStart, closePos), frame.bodyStart, lineStarts);
        const exported = /^[A-Z]/.test(frame.name);
        interfaces.push({
          name: frame.name,
          line: lineOf(frame.headStart + frame.sigStart),
          exported,
          extendsNames,
          methods,
          pos: frame.headStart + frame.sigStart,
          end: closePos + 1,
          language: 'go',
        });
        if (exported) {
          facts.exportSymbols.push({ name: frame.name, kind: 'type', line: lineOf(frame.headStart + frame.sigStart), isDefault: false, isExported: true });
        }
        break;
      }
      case 'func': {
        // Go 具名 func 只能出现在顶层（块内 func 均为字面量，不会进 func 帧）——防御性忽略嵌套帧
        if (blockStack.length > 0) break;
        const sig = frame.head.slice(frame.sigStart);
        const sigText = sig.replace(/\s+/g, ' ').trim().slice(0, 140);
        const name = frame.name;
        const exported = /^[A-Z]/.test(name) || name === 'init' || name === 'main';
        const pos = frame.headStart + frame.sigStart;
        const bodyText = stripped.slice(frame.bodyStart, closePos);
        // 变量类型表：接收者 + 参数签名推断（词法近似；sig 从 func 关键字起，首个括号组即接收者）
        const varTypes = new Map();
        if (frame.receiverType) {
          const rm = /\(\s*(\w+)\s+\*?[A-Za-z_]\w*\s*\)/.exec(sig);
          if (rm) varTypes.set(rm[1], frame.receiverType);
        }
        for (const pm of sig.matchAll(/(?:\(|,)\s*(\w+)\s+((?:\[\]|\*)*(?:map\[[^\]]*\])*(?:[\w.]+))/g)) {
          const ty = baseTypeName(pm[2]);
          if (ty) varTypes.set(pm[1], ty);
        }
        const localClassNames = new Set(classes.map((c) => c.name));
        const calls = extractGoCalls(bodyText, frame.bodyStart, lineStarts, facts.importMap, localClassNames, varTypes, varChains);
        if (frame.receiverType) {
          const method = {
            name,
            line: lineOf(pos),
            isStatic: false,
            isAsync: false,
            isOverride: false,
            signature: sigText,
            pos,
            end: closePos + 1,
          };
          const cls = classByName.get(frame.receiverType);
          if (cls) {
            cls.methods.push(method);
          } else {
            // 接收者类型声明在同包其他文件：builder 按目录合并
            facts.goOrphanMethods.push({ receiverType: frame.receiverType, ...method });
          }
          if (calls.length) facts.callEdges.push({ from: `${frame.receiverType}.${name}`, to: calls });
        } else {
          facts.moduleFunctions.push({
            name,
            line: lineOf(pos),
            exported,
            isAsync: false,
            signature: sigText,
            pos,
            end: closePos + 1,
          });
          if (exported && name !== 'init' && name !== 'main') {
            facts.exportSymbols.push({ name, kind: 'function', line: lineOf(pos), isDefault: false, isExported: true });
          }
          if (calls.length) facts.callEdges.push({ from: name, to: calls });
        }
        break;
      }
      default:
        break;
    }
  };

  for (let i = 0; i < stripped.length; i += 1) {
    const c = stripped[i];
    if (c === '{') {
      const cls = classifyGoHead(currentHead);
      blockStack.push({ ...cls, head: currentHead, headStart, bodyStart: i + 1 });
      currentHead = '';
      headStart = i + 1;
    } else if (c === '}') {
      const frame = blockStack.pop();
      if (frame) finalizeBlock(frame, i);
      currentHead = '';
      headStart = i + 1;
    } else {
      currentHead += c;
    }
  }

  // cobra 命令与 gin 路由（结构扫描 stripped + 内容提取 clean）
  const cobra = extractCobraCommands(stripped, clean, lineStarts);
  facts.goCommands = cobra.commands;
  facts.goCommandEdges = cobra.edges;
  facts.goRoutes = extractGinRoutes(stripped, clean, lineStarts, varChains);

  facts.exportNames = facts.exportSymbols.map((s) => s.name);
  return facts;
}
