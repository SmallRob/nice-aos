// Kotlin 实体分析器（Android/JVM/KMP 项目）：轻量语法级解析（深度状态机 + 等长噪声剥离），
// 与 tsAnalyzer / rustAnalyzer / dartAnalyzer / goAnalyzer / pythonAnalyzer 平级共存、逻辑完全独立。
//
// 实体映射（对齐 TS/Rust/Dart/Go 语义；okhttp/Compose/Ktor 真实样本验证）：
//   class Foo : Bar, Baz → Class（kind: class，bases 来自 supertype list；含主构造器和类体摘要）
//   data class Foo(...) → Class（kind: data_class，fields 来自主构造器参数）
//   sealed class Foo → Class（kind: sealed_class）
//   enum class Foo { ... } → Class（kind: enum，variants 来自枚举常量）
//   object Foo → Class（kind: object，isSingleton: true）
//   internal object Foo / object Foo : Bar → 同样 object，前缀修饰不影响 kind
//   interface Foo : Bar → Interface（extendsNames 来自 supertype list）
//   fun Foo.bar() → Method（ownerKind=class，接收者类型名支持点号语法）
//   fun bar() → Method（ownerKind=module，对应 exported=true）
//   suspend fun / inline fun / operator fun / infix fun → Modifiers 标注，不影响归属
//   val foo: T = ... → Property（ownerKind=class|module；isMutable 区分 var）
//   class 体内 companion object { fun x() {} val y } → 嵌套为独立 Class（kind=companion_object）
//   import foo.Bar → imports（specifier = 'foo.Bar' 或 'foo.*'）
//   package foo.bar → module 归一
//
// 噪声剥离：等长替换字符串字面量（"…" 含转义、"""…""" 含 ${} 插值）、字符字面量、'a' 生命周期混淆、
// 行注释 //、块注释 /* */、KDoc /** */。通道与 rustAnalyzer / goAnalyzer 同形。
//
// 死代码判定契约：nameReferences（全文标识符位置）+ 实体 pos/end（声明范围），
// 由 collectTypeEntities 统一消费——Kotlin 类型引用即使用（Vec<Game> / -> Game / impl Game 均计引用）。
// 块结构状态机以 stripped 内容为输入，findbraces/pos 计算基于 src（保留偏移）。

import fs from 'node:fs';
import path from 'node:path';

export function isKotlinCandidate(relPath) {
  return relPath.endsWith('.kt') || relPath.endsWith('.kts');
}

export function analyzeKotlinFileFromDisk(relPath, projectRoot) {
  const abs = path.join(projectRoot, relPath);
  const content = fs.readFileSync(abs, 'utf-8');
  return analyzeKotlinFile(relPath, content);
}

// ---------- 噪声剥离 ----------
function stripKotlinNoise(src) {
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
    // KDoc / 块注释（Kotlin 不嵌套）
    if (c === '/' && src[i + 1] === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n) {
        if (src[i] === '*' && src[i + 1] === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; break; }
        blank(i); i += 1;
      }
      continue;
    }
    // 三引号字符串（含 ${} 插值）
    if (c === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      for (let k = 0; k < 3; k++) out[i + k] = ' ';
      i += 3;
      let depth = 0;
      while (i < n) {
        if (depth === 0 && src[i] === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
          for (let k = 0; k < 3; k++) out[i + k] = ' ';
          i += 3; break;
        }
        if (src[i] === '$' && src[i + 1] === '{') { depth += 1; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
        if (depth > 0 && src[i] === '}') { depth -= 1; blank(i); i += 1; continue; }
        blank(i); i += 1;
      }
      continue;
    }
    // 普通字符串
    if (c === '"') {
      out[i] = ' '; i += 1;
      while (i < n) {
        if (src[i] === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
        if (src[i] === '"') { out[i] = ' '; i += 1; break; }
        blank(i); i += 1;
      }
      continue;
    }
    // 字符字面量：3-4 字符的 'x'，避免与生命周期冲突
    if (c === "'") {
      const m = /^'(?:\\.|[^'\\\n])'/.exec(src.slice(i, i + 6));
      if (m) {
        for (let k = 0; k < m[0].length; k++) out[i + k] = ' ';
        i += m[0].length;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

// ---------- 工具 ----------
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

function findMatchingBrace(cleaned, openIdx) {
  let depth = 0;
  const n = cleaned.length;
  for (let i = openIdx; i < n; i += 1) {
    const ch = cleaned[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function findMatchingParen(cleaned, openIdx) {
  let depth = 0;
  const n = cleaned.length;
  for (let i = openIdx; i < n; i += 1) {
    const ch = cleaned[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function findMatchingAngle(cleaned, openIdx) {
  let depth = 0;
  const n = cleaned.length;
  for (let i = openIdx; i < n; i += 1) {
    const ch = cleaned[i];
    if (ch === '<') depth += 1;
    else if (ch === '>') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function readIdent(cleaned, pos) {
  const n = cleaned.length;
  if (pos >= n) return { name: '', end: pos };
  const ch = cleaned[pos];
  if (!/[A-Za-z_]/.test(ch)) return { name: '', end: pos };
  let i = pos + 1;
  while (i < n && /[A-Za-z0-9_]/.test(cleaned[i])) i += 1;
  return { name: cleaned.slice(pos, i), end: i };
}

// 消耗表达式体（= expr）或抽象声明到语句边界：
//   - 括号/泛型深度 > 0 时跨行继续（多行链式调用）
//   - 深度 0 时遇 ';' 或 '\n' 停止（无分号的单行表达式体以换行收束）
//   - 遇 '{' / '}' 时停止（防吞下一个声明或类体结束）
function skipExpressionBody(cleaned, start, limit) {
  let depth = 0;
  let i = start;
  while (i < limit) {
    const c = cleaned[i];
    if (c === '(' || c === '{' || c === '<' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === '>' || c === ']') {
      if (depth === 0) return i; // 类体结束 '}'：停在原地，由外层处理
      depth -= 1;
    } else if (depth === 0 && (c === ';' || c === '\n')) {
      return c === ';' ? i + 1 : i;
    }
    i += 1;
  }
  return limit;
}

// 跳过空白 + 一段注解（含合法 '@' 起始；注解标识符允许小写，允许 '.'，允许 ':' 用于命名空间）。
// 用于：type 头与 class body 顶部。
function skipAnnotationsAndSpaces(cleaned, pos) {
  const n = cleaned.length;
  while (pos < n) {
    while (pos < n && /[ \t\n\r]/.test(cleaned[pos])) pos += 1;
    if (pos < n && cleaned[pos] !== '@') return pos;
    let j = pos + 1;
    while (j < n && /[A-Za-z0-9_]/.test(cleaned[j])) j += 1;
    while (j < n && /[.:]/.test(cleaned[j])) {
      const c = cleaned[j];
      j += 1;
      while (j < n && /[A-Za-z0-9_]/.test(cleaned[j])) j += 1;
      // 仅在可继续时使用 last seen separator
      if (j < n && /[A-Za-z0-9_]/.test(cleaned[j])) {
        // 还有 ident；继续
        continue;
      }
      break;
    }
    if (j < n && cleaned[j] === '(') {
      const close = findMatchingParen(cleaned, j);
      if (close === -1) return pos;
      j = close + 1;
    }
    pos = j;
  }
  return pos;
}

// 解析冒号后的 supertype 列表。`class Foo : Bar, Baz.K, Baz2(...) {`
// 支持嵌套标识符（含 `.` 分割的命名空间）、泛型 <>、构造参数 ()。
// 遇到第一个 { 或 ; 或文件末尾时停止。
function parseSupertypeList(cleaned, start) {
  const out = [];
  const n = cleaned.length;
  let i = start;
  while (i < n) {
    // 跳过空白
    while (i < n && /[ \t\n\r]/.test(cleaned[i])) i += 1;
    if (i >= n) break;
    if (cleaned[i] === '{' || cleaned[i] === ';') break;
    // 读取标识符（允许一次 . 续接，如 Call.Factory → "Call.Factory"）
    const probe = skipAnnotationsAndSpaces(cleaned, i);
    if (probe >= n || !/[A-Za-z_]/.test(cleaned[probe])) break;
    const { name, end } = readIdent(cleaned, probe);
    if (!name) break;
    let lastEnd = end;
    // 允许 . 续接
    while (lastEnd < n) {
      while (lastEnd < n && /[ \t\n\r]/.test(cleaned[lastEnd])) lastEnd += 1;
      if (lastEnd < n && cleaned[lastEnd] === '.') {
        const next2 = lastEnd + 1;
        if (next2 < n && /[A-Za-z_]/.test(cleaned[next2])) {
          const id2 = readIdent(cleaned, next2);
          if (!id2.name) break;
          lastEnd = id2.end;
          continue;
        }
      }
      break;
    }
    out.push(cleaned.slice(probe, lastEnd).trim());
    i = lastEnd;
    // 跳过泛型 <...>
    while (i < n && /[ \t\n\r]/.test(cleaned[i])) i += 1;
    if (i < n && cleaned[i] === '<') {
      const close = findMatchingAngle(cleaned, i);
      if (close === -1) return out;
      i = close + 1;
    }
    // 跳过构造参数 (...)
    while (i < n && /[ \t\n\r]/.test(cleaned[i])) i += 1;
    if (i < n && cleaned[i] === '(') {
      const close = findMatchingParen(cleaned, i);
      if (close === -1) return out;
      i = close + 1;
    }
    // 跳过空白后看是否有逗号分隔的下一个
    while (i < n && /[ \t\n\r]/.test(cleaned[i])) i += 1;
    if (i < n && cleaned[i] === ',') { i += 1; continue; }
    break;
  }
  return out;
}

// 解析 fun 头直到 bodyOpensAt 上限（不含）。
// 返回 { name, ownerKind, ownerName, receiverType, modifiers, signature, hasBody, bodyStart }。
function parseFunHeader(cleaned, funPos, endLimit) {
  const KW_FUN = 'fun';
  const MODS = new Set([
    'public', 'private', 'protected', 'internal',
    'open', 'final', 'abstract',
    'override',
    'suspend', 'inline', 'infix', 'operator', 'tailrec', 'external',
    'lateinit', 'const', 'noinline', 'crossinline', 'expect', 'actual',
  ]);
  let i = funPos + KW_FUN.length;
  const n = endLimit;
  // 修饰词
  const modifiers = [];
  while (i < n) {
    const next = skipAnnotationsAndSpaces(cleaned, i);
    if (next >= n) break;
    if (!/[A-Za-z_]/.test(cleaned[next])) break;
    const { name, end: idEnd } = readIdent(cleaned, next);
    if (!name) break;
    if (MODS.has(name)) {
      modifiers.push(name);
      i = idEnd;
      continue;
    }
    break;
  }
  // 跳过空白
  while (i < n && /[ \t\n\r]/.test(cleaned[i])) i += 1;
  if (i >= n) return null;
  // 接收者 + 方法名
  const first = readIdent(cleaned, i);
  if (!first.name) return null;
  let probe = first.end;
  while (probe < n && /[ \t\n\r]/.test(cleaned[probe])) probe += 1;
  let receiverType = null;
  let methodName;
  let nameEnd;
  if (probe < n && cleaned[probe] === '.') {
    receiverType = first.name;
    probe += 1;
    while (probe < n && /[ \t\n\r]/.test(cleaned[probe])) probe += 1;
    const id2 = readIdent(cleaned, probe);
    if (!id2.name) return null;
    methodName = id2.name;
    nameEnd = id2.end;
  } else {
    methodName = first.name;
    nameEnd = first.end;
  }
  i = nameEnd;
  // 跳过泛型 <...>
  while (i < n && /[ \t\n\r]/.test(cleaned[i])) i += 1;
  if (i < n && cleaned[i] === '<') {
    const close = findMatchingAngle(cleaned, i);
    if (close !== -1) i = close + 1;
    else return null;
  }
  // 跳过空白
  while (i < n && /[ \t\n\r]/.test(cleaned[i])) i += 1;
  // 参数 (...)
  let signature = `${methodName}(`;
  if (i < n && cleaned[i] === '(') {
    const close = findMatchingParen(cleaned, i);
    if (close !== -1) {
      signature += cleaned.slice(i + 1, close).replace(/\s+/g, ' ').trim();
      i = close + 1;
    }
  }
  signature += ')';
  // 返回类型
  while (i < n && /[ \t\n\r]/.test(cleaned[i])) i += 1;
  if (i < n && cleaned[i] === ':') {
    i += 1;
    while (i < n && /[ \t]/.test(cleaned[i])) i += 1;
    let rtStart = i;
    while (i < n && cleaned[i] !== '{' && cleaned[i] !== '\n') {
      if (cleaned[i] === '<') {
        const close = findMatchingAngle(cleaned, i);
        if (close === -1) { i = n; break; }
        i = close + 1;
        continue;
      }
      i += 1;
    }
    const rt = cleaned.slice(rtStart, i).trim();
    if (rt) signature += `: ${rt}`;
  }
  // 是否带 body / 等号
  let hasBody = false;
  let bodyStart = -1;
  while (i < n && /[ \t\n\r]/.test(cleaned[i])) i += 1;
  if (i < n) {
    if (cleaned[i] === '{') { hasBody = true; bodyStart = i; }
    else if (cleaned[i] === '=') {
      hasBody = true; bodyStart = i;
    }
  }
  return {
    modifiers,
    name: methodName,
    receiverType,
    signature,
    hasBody,
    bodyStart,
    end: n,
  };
}

// 收集类体中的方法、属性与嵌套类型（companion object 也作为嵌套 Class）
function collectClassMembers(bodyStart, bodyEnd, cleaned, ownerName) {
  const methods = [];
  const properties = [];
  const nestedClasses = [];
  const n = bodyEnd;
  let i = bodyStart + 1; // 跳过 '{'
  const KW_DECL = new Set(['class', 'interface', 'object']);
  const KW_MOD = new Set([
    'public', 'private', 'protected', 'internal',
    'open', 'final', 'abstract', 'sealed', 'data', 'inner', 'enum',
    'override',
    'suspend', 'inline', 'infix', 'operator', 'tailrec', 'external',
    'lateinit', 'const', 'noinline', 'crossinline', 'expect', 'actual',
    'annotation',
  ]);
  while (i < n) {
    i = skipAnnotationsAndSpaces(cleaned, i);
    if (i >= n) break;
    if (!/[A-Za-z_]/.test(cleaned[i])) { i += 1; continue; }
    const kw = readIdent(cleaned, i);
    if (!kw.name) { i += 1; continue; }
    let bodyStmtStart = i; // 用于 fun/val/var 报告 start
    // companion object { ... }
    if (kw.name === 'companion') {
      let k = skipAnnotationsAndSpaces(cleaned, kw.end);
      const objIdent = readIdent(cleaned, k);
      let compName = 'Companion';
      let compBodyStart = -1;
      let compBodyEnd = -1;
      if (objIdent.name === 'object') {
        let p = skipAnnotationsAndSpaces(cleaned, objIdent.end);
        const named = readIdent(cleaned, p);
        if (named.name) {
          compName = named.name;
          p = named.end;
        }
        p = skipAnnotationsAndSpaces(cleaned, p);
        if (p < n && cleaned[p] === '{') {
          compBodyStart = p;
          compBodyEnd = findMatchingBrace(cleaned, p);
        }
      } else if (objIdent.name === '{') {
        // companion object { ... } — 但 readIdent 不接受 '{'；这分支不会进入
      }
      if (compBodyStart === -1) {
        // 没有 {} 时 fall back：跳过到下一个 '}' 位置
        i = n; break;
      }
      const compOwner = `${ownerName}.${compName}`;
      nestedClasses.push({
        name: compName,
        ownerName,
        qualifiedName: compOwner,
        kind: 'companion_object',
        isSingleton: true,
        bodyStart: compBodyStart,
        bodyEnd: compBodyEnd,
      });
      const sub = collectClassMembers(compBodyStart, compBodyEnd, cleaned, compOwner);
      methods.push(...sub.methods);
      properties.push(...sub.properties);
      nestedClasses.push(...sub.nestedClasses);
      i = compBodyEnd + 1;
      continue;
    }
    // 嵌套类型（class / interface / object）
    if (kw.name === 'class' || kw.name === 'interface' || kw.name === 'object') {
      let realKw = kw;
      let modifiers = [];
      let typeKwPos = i;
      i = kw.end;
      // 收集修饰
      while (true) {
        const next = skipAnnotationsAndSpaces(cleaned, i);
        if (next >= n) break;
        if (!/[A-Za-z_]/.test(cleaned[next])) break;
        const id = readIdent(cleaned, next);
        if (!id.name) break;
        if (KW_DECL.has(id.name)) { realKw = id; typeKwPos = next; i = id.end; break; }
        if (KW_MOD.has(id.name)) { modifiers.push(id.name); i = id.end; continue; }
        if (id.name === 'fun') { i = next; break; }
        break;
      }
      // 名
      const namePos = skipAnnotationsAndSpaces(cleaned, i);
      const nameId = readIdent(cleaned, namePos);
      if (!nameId.name) { i = nameId.end; continue; }
      let p = nameId.end;
      // 跳过泛型
      while (p < n && /[ \t\n\r]/.test(cleaned[p])) p += 1;
      if (p < n && cleaned[p] === '<') {
        const close = findMatchingAngle(cleaned, p);
        if (close === -1) { i = n; break; }
        p = close + 1;
      }
      // 主构造器 (可空)
      while (p < n && /[ \t\n\r]/.test(cleaned[p])) p += 1;
      if (p < n && cleaned[p] === '(') {
        const close = findMatchingParen(cleaned, p);
        if (close === -1) { i = n; break; }
        p = close + 1;
      }
      // 跳过 : 超类型，到 { 或 文件末尾
      while (p < n && /[ \t\n\r]/.test(cleaned[p])) p += 1;
      if (p < n && cleaned[p] === ':') {
        let depth = 0;
        while (p < n) {
          const c = cleaned[p];
          if (c === '<' || c === '(' || c === '[' || c === '{') depth += 1;
          else if (c === '>' || c === ')' || c === ']' || c === '}') depth -= 1;
          else if (depth === 0 && c === ';') break;
          p += 1;
        }
      }
      while (p < n && /[ \t\n\r]/.test(cleaned[p])) p += 1;
      let bodyStart2 = -1, bodyEnd2 = -1;
      if (p < n && cleaned[p] === '{') {
        bodyStart2 = p;
        bodyEnd2 = findMatchingBrace(cleaned, p);
      }
      let entityKind = realKw.name;
      if (modifiers.includes('sealed')) entityKind = 'sealed_class';
      if (modifiers.includes('data')) entityKind = 'data_class';
      if (modifiers.includes('enum')) entityKind = 'enum_class';
      nestedClasses.push({
        name: nameId.name,
        ownerName,
        qualifiedName: `${ownerName}.${nameId.name}`,
        kind: entityKind,
        isSingleton: entityKind === 'object',
        bodyStart: bodyStart2,
        bodyEnd: bodyEnd2,
      });
      i = bodyEnd2 !== -1 ? bodyEnd2 + 1 : Math.min(p, n);
      continue;
    }
    // fun
    if (kw.name === 'fun') {
      const header = parseFunHeader(cleaned, i, n);
      if (!header) { i = kw.end; continue; }
      methods.push({
        name: header.name,
        modifiers: header.modifiers,
        receiverType: header.receiverType,
        signature: header.signature,
        hasBody: header.hasBody,
        bodyStart: header.bodyStart,
        start: i,
        end: header.hasBody && header.bodyStart !== -1 && cleaned[header.bodyStart] === '{'
          ? (findMatchingBrace(cleaned, header.bodyStart) + 1)
          : (header.hasBody ? n : n),
      });
      if (header.hasBody && header.bodyStart !== -1 && cleaned[header.bodyStart] === '{') {
        const close = findMatchingBrace(cleaned, header.bodyStart);
        if (close === -1) break;
        i = close + 1;
      } else {
        // 表达式体 = expr 或抽象声明：消耗到语句边界（skipExpressionBody 对 '\n' 安全）
        i = skipExpressionBody(cleaned, i, n);
      }
      continue;
    }
    // [modifier]+ fun / val / var：open fun / public suspend fun / private val 等带修饰前缀的成员
    if (KW_MOD.has(kw.name)) {
      const preMods = [kw.name];
      let probe = kw.end;
      let hitFun = false;
      let hitProp = false;
      while (probe < n) {
        probe = skipAnnotationsAndSpaces(cleaned, probe);
        if (probe >= n) break;
        const id = readIdent(cleaned, probe);
        if (!id.name) break;
        if (id.name === 'fun') { hitFun = true; break; }
        if (id.name === 'val' || id.name === 'var') { hitProp = true; break; }
        if (KW_MOD.has(id.name)) { preMods.push(id.name); probe = id.end; continue; }
        break;
      }
      if (hitFun) {
        // 修饰前缀的 fun：parseFunHeader 从 'fun' 关键字位置（probe）开始解析，
        // 前置修饰（preMods）手动合并进 modifiers
        const header = parseFunHeader(cleaned, probe, n);
        if (header) {
          for (const pm of preMods) if (!header.modifiers.includes(pm)) header.modifiers.push(pm);
          methods.push({
            name: header.name,
            modifiers: header.modifiers,
            receiverType: header.receiverType,
            signature: header.signature,
            hasBody: header.hasBody,
            bodyStart: header.bodyStart,
            start: i,
            end: header.hasBody && header.bodyStart !== -1 && cleaned[header.bodyStart] === '{'
              ? (findMatchingBrace(cleaned, header.bodyStart) + 1)
              : (header.hasBody ? n : n),
          });
          if (header.hasBody && header.bodyStart !== -1 && cleaned[header.bodyStart] === '{') {
            const close = findMatchingBrace(cleaned, header.bodyStart);
            if (close === -1) break;
            i = close + 1;
          } else {
            i = skipExpressionBody(cleaned, i, n);
          }
          continue;
        }
      } else if (hitProp) {
        // 修饰前缀的 val/var：跳过修饰词，i 推进到 val/var 处让下方分支处理
        i = probe;
        continue;
      }
      // 未命中 fun/val/var：落入未知 token fallback
    }
    // val / var
    if (kw.name === 'val' || kw.name === 'var') {
      let k = skipAnnotationsAndSpaces(cleaned, kw.end);
      const pid = readIdent(cleaned, k);
      const propName = pid.name || '';
      let endK = pid.end;
      while (endK < n && /[ \t\n\r]/.test(cleaned[endK])) endK += 1;
      let propType = '';
      if (endK < n && cleaned[endK] === ':') {
        endK += 1;
        while (endK < n && /[ \t]/.test(cleaned[endK])) endK += 1;
        const ts = endK;
        while (endK < n && cleaned[endK] !== '=' && cleaned[endK] !== '{' && cleaned[endK] !== ';' && cleaned[endK] !== '\n') {
          if (cleaned[endK] === '<') { const c = findMatchingAngle(cleaned, endK); if (c === -1) { endK = n; break; } endK = c + 1; continue; }
          endK += 1;
        }
        propType = cleaned.slice(ts, endK).trim();
      }
      while (endK < n && /[ \t\n\r]/.test(cleaned[endK])) endK += 1;
      if (endK < n && cleaned[endK] === '=') {
        endK += 1;
        let depth = 0;
        while (endK < n) {
          const c = cleaned[endK];
          if (c === '(' || c === '{' || c === '<' || c === '[') depth += 1;
          else if (c === ')' || c === '}' || c === '>' || c === ']') depth -= 1;
          else if (depth === 0 && (c === ';' || c === '\n')) break;
          endK += 1;
        }
      }
      properties.push({ name: propName, type: propType, isMutable: kw.name === 'var', start: i, end: endK });
      i = endK;
      continue;
    }
    // init { ... } / 其它语句块：消费到下一对匹配 '}'
    if (kw.name === 'init') {
      let k = skipAnnotationsAndSpaces(cleaned, kw.end);
      if (k < n && cleaned[k] === '{') {
        const close = findMatchingBrace(cleaned, k);
        if (close === -1) break;
        i = close + 1;
        continue;
      }
    }
    // 未知 token / 语句：消耗到下一个 ; 或配对 }
    while (i < n && cleaned[i] !== ';' && cleaned[i] !== '{' && cleaned[i] !== '}') i += 1;
    if (i >= n) break;
    if (cleaned[i] === '{') {
      const close = findMatchingBrace(cleaned, i);
      if (close === -1) break;
      i = close + 1;
    } else if (cleaned[i] === ';') {
      i += 1;
    } else {
      i += 1;
    }
  }
  return { methods, properties, nestedClasses };
}

// ---------- 解析器主体 ----------
export function analyzeKotlinFile(relPath, content) {
  const src = content;
  const cleaned = stripKotlinNoise(src);
  const lineStarts = computeLineStarts(src);
  const exports = [];
  const importMap = new Map();
  const imports = [];
  const nameReferences = new Map();

  function recordRef(name, pos) {
    if (!name) return;
    const cur = nameReferences.get(name) ?? [];
    cur.push(pos);
    nameReferences.set(name, cur);
  }
  for (let i = 0; i < cleaned.length; i += 1) {
    const c = cleaned[i];
    if (/[A-Za-z_]/.test(c)) {
      const id = readIdent(cleaned, i);
      if (id.name) { recordRef(id.name, i); i = id.end - 1; }
    }
  }

  // package
  let moduleName = null;
  const packageMatch = /^[ \t]*package\s+([A-Za-z_][\w.]*)/m.exec(cleaned);
  if (packageMatch) moduleName = packageMatch[1];

  // imports
  const importRe = /^[ \t]*import\s+([A-Za-z_][\w.*]*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/gm;
  let im;
  while ((im = importRe.exec(cleaned))) {
    const specifier = im[1];
    const alias = im[2] ?? null;
    let local = specifier.endsWith('.*') ? '*' : (alias ?? specifier.split('.').pop());
    imports.push({ specifier, alias, isTypeOnly: false, isDynamic: false, names: [{ local, imported: '*' }], pos: im.index });
    if (local && local !== '*') importMap.set(local, specifier);
  }
  // import foo.{ A, B, C } 处理：找 { ... } 跟在 import 之后的行
  const groupImportRe = /^[ \t]*import\s+([A-Za-z_][\w.]*)\.\{([^}]+)\}\s*$/gm;
  let gim;
  while ((gim = groupImportRe.exec(cleaned))) {
    const prefix = gim[1];
    const inner = gim[2];
    for (const part of inner.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const m = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(trimmed);
      if (!m) continue;
      const imported = m[1];
      const alias = m[2] ?? null;
      const local = alias ?? imported;
      const specifier = `${prefix}.${imported}`;
      imports.push({ specifier, alias, isTypeOnly: false, isDynamic: false, names: [{ local, imported: '*' }], pos: gim.index });
      if (local !== '*') importMap.set(local, specifier);
    }
  }

  // 顶层声明：跳过 file-level 注解 + package + import 行
  const KW_DECL_REAL = new Set(['class', 'interface', 'object']);
  const KW_FUN = 'fun';
  const KW_PROP = new Set(['val', 'var']);
  const KW_MOD = new Set([
    'public', 'private', 'protected', 'internal',
    'open', 'final', 'abstract', 'sealed', 'data', 'inner', 'enum',
    'override',
    'suspend', 'inline', 'infix', 'operator', 'tailrec', 'external',
    'lateinit', 'const', 'noinline', 'crossinline', 'expect', 'actual',
    'annotation',
  ]);

  const n = cleaned.length;
  let i = 0;
  while (i < n) {
    i = skipAnnotationsAndSpaces(cleaned, i);
    if (i >= n) break;
    if (!/[A-Za-z_]/.test(cleaned[i])) { i += 1; continue; }
    break;
  }

  const moduleFunctions = [];
  const fileClasses = [];

  while (i < n) {
    i = skipAnnotationsAndSpaces(cleaned, i);
    if (i >= n) break;
    if (!/[A-Za-z_]/.test(cleaned[i])) { i += 1; continue; }
    const firstId = readIdent(cleaned, i);
    if (!firstId.name) { i += 1; continue; }
    // 关键字分类
    if (firstId.name === 'package') {
      // 跳到下一个换行
      while (i < n && cleaned[i] !== '\n') i += 1;
      continue;
    }
    if (firstId.name === 'import') {
      while (i < n && cleaned[i] !== '\n') i += 1;
      continue;
    }
    if (firstId.name === KW_FUN) {
      // fun interface Foo<T> { fun create(): T }：SAM 接口，按 interface 类型收集
      let probe = skipAnnotationsAndSpaces(cleaned, firstId.end);
      const nextId = readIdent(cleaned, probe);
      if (nextId.name === 'interface') {
        // 回退到 interface 关键字位置，让类型声明分支（KW_DECL_REAL）接手收集
        i = probe;
        continue;
      }
      // 普通顶层 fun
      const header = parseFunHeader(cleaned, i, n);
      if (!header) { i = firstId.end; continue; }
      moduleFunctions.push({
        name: header.name,
        modifiers: header.modifiers,
        receiverType: header.receiverType,
        signature: header.signature,
        hasBody: header.hasBody,
        bodyStart: header.bodyStart,
        start: i,
        end: header.hasBody && header.bodyStart !== -1 && cleaned[header.bodyStart] === '{'
          ? (findMatchingBrace(cleaned, header.bodyStart) + 1)
          : (header.hasBody ? n : n),
      });
      if (header.hasBody && header.bodyStart !== -1 && cleaned[header.bodyStart] === '{') {
        const close = findMatchingBrace(cleaned, header.bodyStart);
        if (close === -1) break;
        i = close + 1;
      } else {
        i = skipExpressionBody(cleaned, i, n);
      }
      continue;
    }
    if (KW_DECL_REAL.has(firstId.name) || KW_MOD.has(firstId.name)) {
      // 类型声明：先收集前置修饰 + 真正类型关键字（class / interface / object）
      const modifiers = [];
      let visibility = null;
      let typeKw = null;
      let typeKwPos = -1;
      let jPos = i;
      // 如果 firstId 本身就是 typeKw，直接接受
      if (KW_DECL_REAL.has(firstId.name)) {
        typeKw = firstId.name;
        typeKwPos = i;
        jPos = firstId.end;
      }
      while (!typeKw) {
        const probe = skipAnnotationsAndSpaces(cleaned, jPos);
        if (probe >= n) break;
        if (!/[A-Za-z_]/.test(cleaned[probe])) break;
        const id = readIdent(cleaned, probe);
        if (!id.name) break;
        if (KW_DECL_REAL.has(id.name)) {
          typeKw = id.name;
          typeKwPos = probe;
          jPos = id.end;
          break;
        }
        if (KW_MOD.has(id.name)) {
          modifiers.push(id.name);
          if (!visibility && ['public', 'private', 'protected', 'internal'].includes(id.name)) visibility = id.name;
          jPos = id.end;
          continue;
        }
        // 注解（已 strip）/ 其它
        break;
      }
      if (!typeKw) { i = firstId.end; continue; }
      // 名
      const namePos = skipAnnotationsAndSpaces(cleaned, jPos);
      const nameId = readIdent(cleaned, namePos);
      if (!nameId.name) { i = n; break; }
      const typeName = nameId.name;
      let p = nameId.end;
      // 跳过泛型 <T : Bound>
      while (p < n && /[ \t\n\r]/.test(cleaned[p])) p += 1;
      if (p < n && cleaned[p] === '<') {
        const close = findMatchingAngle(cleaned, p);
        if (close === -1) { i = n; break; }
        p = close + 1;
      }
      // 跳过空白 + 注解 + visibilityModifier + constructor + ( ... )
      while (p < n && /[ \t\n\r]/.test(cleaned[p])) p += 1;
      // 跳过 [modifier*] [constructor] ( 之间的关键字
      {
        let probeP = skipAnnotationsAndSpaces(cleaned, p);
        // 消费可见性修饰词堆叠（public/private/protected/internal）
        const KW_VIS = new Set(['public', 'private', 'protected', 'internal']);
        while (probeP < n) {
          const id = readIdent(cleaned, probeP);
          if (!id.name) break;
          if (KW_VIS.has(id.name) || id.name === 'inline' || id.name === 'expect' || id.name === 'actual') {
            probeP = id.end;
            probeP = skipAnnotationsAndSpaces(cleaned, probeP);
            continue;
          }
          if (id.name === 'constructor') {
            probeP = skipAnnotationsAndSpaces(cleaned, id.end);
          }
          break;
        }
        p = probeP;
      }
      let primaryConstructor = '';
      if (p < n && cleaned[p] === '(') {
        const close = findMatchingParen(cleaned, p);
        if (close !== -1) {
          primaryConstructor = cleaned.slice(p + 1, close).trim();
          p = close + 1;
        }
      }
      while (p < n && /[ \t\n\r]/.test(cleaned[p])) p += 1;
      // : 超类型（使用第一个紧邻的 colon）
      let supertypes = [];
      if (p < n && cleaned[p] === ':') {
        supertypes = parseSupertypeList(cleaned, p + 1);
        // 把 p 推进到 '{' 或 ';' 或 文件末尾
        let depth = 0;
        while (p < n) {
          const c = cleaned[p];
          if (depth === 0 && (c === '{' || c === ';')) break;
          if (c === '<' || c === '(' || c === '[' || c === '{') depth += 1;
          else if (c === '>' || c === ')' || c === ']' || c === '}') depth -= 1;
          p += 1;
        }
      }
      while (p < n && /[ \t\n\r]/.test(cleaned[p])) p += 1;
      let bodyStart = -1, bodyEnd = -1;
      if (p < n && cleaned[p] === '{') {
        bodyStart = p;
        bodyEnd = findMatchingBrace(cleaned, p);
      }

      let entityKind = typeKw;
      if (modifiers.includes('sealed')) entityKind = 'sealed_class';
      if (modifiers.includes('data')) entityKind = 'data_class';
      if (modifiers.includes('enum')) entityKind = 'enum_class';
      if (typeKw === 'annotation') entityKind = 'annotation_class';
      const isSingleton = entityKind === 'object';
      const exported = visibility !== 'private';

      let members = { methods: [], properties: [], nestedClasses: [] };
      if (bodyStart !== -1 && bodyEnd !== -1) {
        members = collectClassMembers(bodyStart, bodyEnd, cleaned, typeName);
      }
      const qualifiedName = moduleName ? `${moduleName}.${typeName}` : typeName;
      fileClasses.push({
        name: typeName,
        qualifiedName,
        modifiers,
        visibility,
        primaryConstructor: primaryConstructor || null,
        supertypes,
        bases: supertypes,
        kind: entityKind,
        isSingleton,
        members,
        bodyStart,
        bodyEnd,
        start: typeKwPos,
        end: bodyEnd !== -1 ? bodyEnd + 1 : p,
      });

      i = bodyEnd !== -1 ? bodyEnd + 1 : p;
      continue;
    }
    if (KW_PROP.has(firstId.name)) {
      // 顶层 val / var
      let endK = firstId.end;
      while (endK < n && cleaned[endK] !== ';' && cleaned[endK] !== '\n') endK += 1;
      i = endK;
      continue;
    }
    // 其它顶层 keyword（typealias/extension/operator/...）：跳到 '{' 或 ';' 或换行
    while (i < n && cleaned[i] !== ';' && cleaned[i] !== '{' && cleaned[i] !== '}') i += 1;
    if (i >= n) break;
    if (cleaned[i] === '{') {
      const close = findMatchingBrace(cleaned, i);
      if (close === -1) break;
      i = close + 1;
    } else if (cleaned[i] === ';') {
      i += 1;
    } else {
      i += 1;
    }
  }

  // 顶层 moduleFunctions → 顶层 Method 数组（ownerKind=module）
  const moduleFnRecords = moduleFunctions.filter((fn) => fn.name).map((fn) => ({
    name: fn.name,
    line: lineAt(lineStarts, fn.start),
    pos: fn.start, end: fn.end,
    signature: fn.signature,
    modifiers: fn.modifiers,
    isStatic: false,
    isAsync: (fn.modifiers ?? []).includes('suspend'),
    isOverride: false,
    exported: !(fn.modifiers ?? []).includes('private'),
    receiverType: fn.receiverType,
  }));

  const classes = [];
  const interfaces = [];
  for (const c of fileClasses) {
    if (c.kind === 'interface') {
      interfaces.push({
        kind: 'interface',
        name: c.name,
        qualifiedName: c.qualifiedName,
        language: 'kotlin',
        line: lineAt(lineStarts, c.start),
        pos: c.start,
        end: c.end,
        exported: c.visibility !== 'private',
        extendsNames: c.supertypes,
        bases: c.supertypes,
        modifiers: c.modifiers,
        methods: c.members.methods.filter((m) => m.name).map((m) => ({
          name: m.name,
          line: lineAt(lineStarts, m.start),
          pos: m.start, end: m.end,
          signature: m.signature,
          modifiers: m.modifiers,
          receiverType: m.receiverType,
        })),
      });
    } else {
      classes.push({
        kind: c.kind,
        name: c.name,
        qualifiedName: c.qualifiedName,
        language: 'kotlin',
        line: lineAt(lineStarts, c.start),
        pos: c.start,
        end: c.end,
        exported: c.visibility !== 'private',
        modifiers: c.modifiers,
        visibility: c.visibility,
        supertypes: c.supertypes,
        bases: c.supertypes,
        primaryConstructor: c.primaryConstructor,
        fields: extractPrimaryConstructorFields(c.primaryConstructor),
        variants: c.kind === 'enum_class' ? extractEnumVariants(cleaned, c.bodyStart, c.bodyEnd) : [],
        isSingleton: c.isSingleton,
        methods: c.members.methods.filter((m) => m.name).map((m) => ({
          name: m.name,
          line: lineAt(lineStarts, m.start),
          pos: m.start,
          end: m.end,
          signature: m.signature,
          modifiers: m.modifiers,
          isStatic: m.modifiers.includes('companion') || false,
          isAsync: m.modifiers.includes('suspend'),
          isOverride: m.modifiers.includes('override'),
          receiverType: m.receiverType,
          exported: !m.modifiers.includes('private'),
        })),
        properties: c.members.properties.filter((p) => p.name).map((p) => ({
          name: p.name,
          type: p.type || null,
          isMutable: !!p.isMutable,
        })),
        nestedClasses: c.members.nestedClasses.filter((nc) => nc.name).map((nc) => ({
          name: nc.name,
          qualifiedName: nc.qualifiedName,
          kind: nc.kind,
          isSingleton: nc.isSingleton,
        })),
      });
    }
  }

  const exportNames = [];
  for (const c of fileClasses) {
    if (c.visibility !== 'private') exportNames.push(c.name);
  }
  for (const fn of moduleFunctions) {
    if (!(fn.modifiers ?? []).includes('private')) exportNames.push(fn.name);
  }

  let lineCount = 1;
  for (let k = 0; k < src.length; k += 1) if (src.charCodeAt(k) === 10) lineCount += 1;

  return {
    path: relPath,
    ext: relPath.endsWith('.kts') ? 'kts' : 'kt',
    language: 'kotlin',
    lineCount,
    exports,
    exportSymbols: [],
    exportNames,
    imports,
    importMap,
    nameReferences,
    classes,
    interfaces,
    moduleFunctions: moduleFnRecords,
    moduleName,
    // 与 tsAnalyzer 契约对齐（builder 消费的字段；Kotlin 无组件/overlay 语义，全部为空）
    traits: [],
    routes: [],
    jsxTags: new Set(),
    useCalls: [], overlayOpens: [], stores: [], lazyWrappers: [], components: [], hooks: [],
    primaryComponentName: null, hasSingletonClass: false, hasClassExport: false,
    vueRoutes: [], vueRouteMeta: null,
  };
}

function extractPrimaryConstructorFields(text) {
  if (!text) return [];
  const fields = [];
  // 截取到 ',' 或 '=' 或 end（greedy）
  const re = /(val|var)\s+([A-Za-z_]\w*)\s*(?::\s*([^,=\n]+))?(?:\s*=\s*([^,\n]+))?/g;
  let m;
  while ((m = re.exec(text))) {
    fields.push({
      name: m[2],
      type: (m[3] ?? '').trim() || null,
      defaultValue: (m[4] ?? '').trim() || null,
      isMutable: m[1] === 'var',
      kind: 'property',
    });
  }
  return fields;
}

function extractEnumVariants(cleaned, bodyStart, bodyEnd) {
  if (bodyStart === -1 || bodyEnd === -1) return [];
  const inner = cleaned.slice(bodyStart + 1, bodyEnd);
  const out = [];
  let depth = 0;
  let parenDepth = 0;
  let buf = '';
  const flush = () => {
    const trimmed = buf.trim();
    if (trimmed && !/^[\s;]*$/.test(trimmed)) {
      const first = /^[A-Za-z_]\w*/.exec(trimmed);
      if (first) out.push({ name: first[0], signature: trimmed });
    }
    buf = '';
  };
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (c === '(') { parenDepth += 1; buf += c; continue; }
    if (c === ')') { parenDepth -= 1; buf += c; continue; }
    if (parenDepth > 0) { buf += c; continue; }
    if (c === '{' || c === '}') {
      if (c === '{') depth += 1;
      else { depth -= 1; buf += c; }
      continue;
    }
    if (c === ';' || c === ',') { flush(); continue; }
    buf += c;
  }
  flush();
  return out;
}
