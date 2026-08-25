// Python 实体分析器（Python 3 脚本 / FastAPI 后端 / Flask / Django / Chaquopy / 油猴配套脚本）：
// 轻量语法级解析（基于缩进的块结构 + 等长噪声剥离），与 tsAnalyzer / vueAnalyzer / dartAnalyzer / goAnalyzer / rustAnalyzer 平级共存、逻辑完全独立。
// 实体映射（对齐 TS/Rust/Dart 语义）：
//   class X(Base, Mixin, metaclass=Meta): ... → Class（kind: class，bases 含末段类型名；metaclass= 抽到 metaclassName）；
//   含 @abstractmethod 或继承 ABC 且只有抽象方法的 class → Interface；
//   def f(...) / async def f(...) → Method（ownerKind=class）；模块级 def → moduleFunctions；
//   @property / @staticmethod / @classmethod / @abstractmethod / 自定义装饰器 → methods[].decorators[]（含 kind 标签）；
//   import X / from X import Y / from X import Y as Z / from X import * → imports（importMap 含 local→specifier 与 from 子名映射）；
//   __init__ / __str__ / __repr__ / __enter__/__exit__ 等 dunder → methods[].isDunder=true + dunderCategory 语义标签；
//   __all__ = [...] → pythonExports（模块公开符号清单）；
//   if __name__ == "__main__": → pythonEntryPoints（脚本入口）；
//   @app.command / @click.command / @typer.command 装饰器 → pythonEntryPoints（CLI 入口）；
//   方法/函数体内调用 → callEdges（self.method() / cls.method() / Class.method() / pkg.func() / new Class()）；
//   @app.get/post/put/delete/patch + @app.route / @router.get 系列 → pythonRoutes（method/path/handler/target）。
// 双通道设计：stripPythonNoise（全剥离：f-string 插值 + 三引号/单引号/字节串 + 注释）供块状态机与调用提取；
// stripCommentsOnly（仅剥注释，保留字符串内容）供 import / 装饰器字符串 / 路由 path / __all__ 列表 / docstring 提取。
// 死代码判定契约：nameReferences（全文标识符位置）+ 实体 pos/end（声明范围），由 collectTypeEntities 统一消费。
//
// 适配 pr_agent 蓝图：pr_agent 走 "PR diff → token 压缩 → LLM" 链路；本分析器走 "Python 缩进感知 → 实体快照" 离线链路。
// 共享契约：FilePatchInfo(base/head/patch/filename/tokens/editType) → 体现为 PythonFileFacts(bases/decorators/patch/filename/tokens/editType=MODIFIED)。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// 调用提取时排除的关键字 / 内建 / 预声明
const CALL_EXCLUDE = new Set([
  'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'as',
  'return', 'yield', 'raise', 'assert', 'pass', 'break', 'continue', 'del', 'global', 'nonlocal',
  'def', 'class', 'lambda', 'import', 'from', 'in', 'is', 'not', 'and', 'or',
  'async', 'await', 'match', 'case',
  'print', 'len', 'range', 'enumerate', 'zip', 'map', 'filter', 'reversed', 'sorted',
  'min', 'max', 'sum', 'abs', 'round', 'all', 'any', 'bool', 'int', 'float', 'str',
  'list', 'dict', 'set', 'tuple', 'frozenset', 'bytes', 'bytearray', 'memoryview',
  'type', 'isinstance', 'issubclass', 'callable', 'hasattr', 'getattr', 'setattr', 'delattr',
  'open', 'input', 'repr', 'format', 'id', 'hash', 'iter', 'next', 'super',
  'staticmethod', 'classmethod', 'property',
  'True', 'False', 'None',
  'Exception', 'BaseException', 'ValueError', 'TypeError', 'KeyError', 'IndexError',
  'AttributeError', 'RuntimeError', 'IOError', 'OSError', 'StopIteration', 'NotImplementedError',
]);

// CLI 入口装饰器
const ENTRY_DECORATORS = new Set(['app.command', 'cli.command', 'main.command', 'click.command', 'typer.command']);

// 装饰器名 → kind 分类
const DECORATOR_KIND = {
  property: 'property', staticmethod: 'static', classmethod: 'class',
  abstractmethod: 'abstract', abstractclassmethod: 'abstract', abstractstaticmethod: 'abstract',
  final: 'final', override: 'override', dataclasses: 'dataclass',
};

// dunder 分类（语义标签）
const DUNDER_CATEGORIES = {
  __init__: 'init', __new__: 'init', __del__: 'init',
  __str__: 'repr', __repr__: 'repr', __format__: 'repr', __bytes__: 'repr',
  __enter__: 'context', __exit__: 'context', __aenter__: 'context', __aexit__: 'context',
  __eq__: 'compare', __ne__: 'compare', __lt__: 'compare', __le__: 'compare', __gt__: 'compare', __ge__: 'compare', __hash__: 'compare',
  __add__: 'arithmetic', __sub__: 'arithmetic', __mul__: 'arithmetic', __truediv__: 'arithmetic', __floordiv__: 'arithmetic',
  __mod__: 'arithmetic', __pow__: 'arithmetic', __neg__: 'arithmetic', __pos__: 'arithmetic', __abs__: 'arithmetic',
  __getitem__: 'sequence', __setitem__: 'sequence', __delitem__: 'sequence', __len__: 'sequence', __contains__: 'sequence',
  __iter__: 'sequence', __next__: 'sequence', __reversed__: 'sequence',
  __getattr__: 'attr', __getattribute__: 'attr', __setattr__: 'attr', __delattr__: 'attr', __dir__: 'attr',
  __get__: 'descriptor', __set__: 'descriptor', __delete__: 'descriptor', __set_name__: 'descriptor',
  __call__: 'callable',
  __bool__: 'cast', __int__: 'cast', __float__: 'cast', __complex__: 'cast', __index__: 'cast',
};
function dunderCategory(name) { return DUNDER_CATEGORIES[name] ?? null; }

// ---------- 噪声剥离 ----------
function stripPythonNoise(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (i) => { if (src[i] !== '\n') out[i] = ' '; };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '#') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i += 1; }
      continue;
    }
    if ((c === '"' || c === "'") && src[i + 1] === c && src[i + 2] === c) {
      const q = c + c + c;
      for (let k = 0; k < 3; k += 1) out[i + k] = ' ';
      i += 3;
      while (i < n) {
        if (src.startsWith(q, i)) {
          for (let k = 0; k < 3; k += 1) out[i + k] = ' ';
          i += 3;
          break;
        }
        if (src[i] === '\\' && i + 1 < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
        blank(i); i += 1;
      }
      continue;
    }
    // 字符串前缀：b/B/u/U/r/R 单独，或与 f/F 组合（fb/fr/fB/fR/Fb/Fr/...）
    // Python 3.12 允许任意大小写组合，顺序任意。我们简化：前缀为 [fFbBuUrR]+ 后跟 " 或 '
    if (/[fFbBuUrR]/.test(c) && (src[i + 1] === '"' || src[i + 1] === "'")) {
      const start = i;
      // 吃掉所有前缀字符
      i += 1;
      while (i < n && /[fFbBuUrR]/.test(src[i])) i += 1;
      // 现在的 i 指向 " 或 '
      const q = src[i];
      if (src[i + 1] === q && src[i + 2] === q) {
        // 三引号
        for (let k = start; k < i + 3; k += 1) out[k] = ' ';
        i += 3;
        const close = q + q + q;
        while (i < n) {
          if (src.startsWith(close, i)) {
            for (let k = 0; k < 3; k += 1) out[i + k] = ' ';
            i += 3;
            break;
          }
          if (src[i] === '\\' && i + 1 < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
          blank(i); i += 1;
        }
        continue;
      }
      // 单行
      for (let k = start; k < i; k += 1) out[k] = ' ';
      out[i] = ' '; i += 1;
      while (i < n) {
        if (src[i] === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
        if (src[i] === q) { out[i] = ' '; i += 1; break; }
        blank(i); i += 1;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      out[i] = ' '; i += 1;
      let braceDepth = 0;
      while (i < n) {
        if (src[i] === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
        if (q === '"' && src[i] === '{' && src[i + 1] !== '{') {
          braceDepth += 1;
          out[i] = ' '; i += 1;
          while (i < n && braceDepth > 0) {
            if (src[i] === '{') braceDepth += 1;
            else if (src[i] === '}') {
              braceDepth -= 1;
              if (braceDepth === 0) { out[i] = ' '; i += 1; break; }
            }
            blank(i); i += 1;
          }
          continue;
        }
        if (src[i] === q) { out[i] = ' '; i += 1; break; }
        blank(i); i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

function stripCommentsOnly(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '#') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i += 1; }
      continue;
    }
    if ((c === '"' || c === "'") && src[i + 1] === c && src[i + 2] === c) {
      const q = c + c + c;
      i += 3;
      while (i < n) {
        if (src.startsWith(q, i)) { i += 3; break; }
        if (src[i] === '\\' && i + 1 < n) { i += 2; continue; }
        i += 1;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      i += 1;
      while (i < n) {
        if (src[i] === '\\' && i + 1 < n) { i += 2; continue; }
        if (src[i] === q) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

// ---------- 行号 / 缩进辅助 ----------
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
function lineIndent(line) {
  // 跳过空白行
  if (!line.trim()) return -1;
  const m = /^[ \t]*/.exec(line);
  return m[0].replace(/\t/g, '    ').length; // tab 归一为 4 空格
}

// ---------- import 提取 ----------
function extractImports(clean) {
  const imports = [];
  const importRe = /^[ \t]*import\s+([A-Za-z_][\w.]*(?:\s+as\s+[A-Za-z_][\w]*)?)\s*$/gm;
  let m;
  while ((m = importRe.exec(clean))) {
    const spec = m[1].replace(/\s+as\s+[A-Za-z_][\w]*$/, '');
    const aliasMatch = /\s+as\s+([A-Za-z_][\w]*)$/.exec(m[1]);
    const local = aliasMatch ? aliasMatch[1] : spec.split('.').pop();
    imports.push({
      specifier: spec, alias: aliasMatch ? aliasMatch[1] : null,
      isTypeOnly: false, isDynamic: false, isFrom: false,
      names: [{ local, imported: spec.split('.').pop(), isWildcard: false }],
      pos: m.index,
    });
  }
  // 相对导入：from . import x / from .. import x / from ..pkg import x
  // spec 可为：'.' / '..' / '...' / '.pkg' / '..pkg' / '...pkg' / 'pkg' / 'pkg.sub'
  const fromSingleRe = /^[ \t]*from\s+(\.{1,3}(?:[A-Za-z_][\w]*)?|[A-Za-z_][\w.]*)\s+import\s+([^\n]+)$/gm;
  while ((m = fromSingleRe.exec(clean))) {
    const spec = m[1];
    const clause = m[2].trim();
    if (clause.startsWith('(')) continue;
    imports.push(...parseFromClause(spec, clause, m.index));
  }
  const fromMultiRe = /^[ \t]*from\s+(\.{1,3}(?:[A-Za-z_][\w]*)?|[A-Za-z_][\w.]*)\s+import\s*\(([\s\S]*?)\)/gm;
  while ((m = fromMultiRe.exec(clean))) {
    const spec = m[1];
    const body = m[2];
    imports.push(...parseFromClause(spec, body.replace(/\s+/g, ' '), m.index, true));
  }
  return imports;
}
function parseFromClause(spec, clauseText, pos) {
  const items = [];
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < clauseText.length; i += 1) {
    const ch = clauseText[i];
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) { parts.push(clauseText.slice(start, i)); start = i + 1; }
  }
  parts.push(clauseText.slice(start));
  for (const part of parts) {
    const t = part.trim();
    if (!t) continue;
    if (t === '*') {
      items.push({
        specifier: spec, alias: null, isTypeOnly: false, isDynamic: false, isFrom: true,
        names: [{ local: '*', imported: '*', isWildcard: true }], pos,
      });
      continue;
    }
    const aliasM = /^([A-Za-z_][\w]*)\s+as\s+([A-Za-z_][\w]*)$/.exec(t);
    if (aliasM) {
      items.push({
        specifier: spec, alias: null, isTypeOnly: false, isDynamic: false, isFrom: true,
        names: [{ local: aliasM[2], imported: aliasM[1], isWildcard: false }], pos,
      });
    } else {
      const nameM = /^([A-Za-z_][\w]*)$/.exec(t);
      if (nameM) {
        items.push({
          specifier: spec, alias: null, isTypeOnly: false, isDynamic: false, isFrom: true,
          names: [{ local: nameM[1], imported: nameM[1], isWildcard: false }], pos,
        });
      }
    }
  }
  return items;
}

// ---------- 装饰器 / 类继承辅助 ----------
function lastPathSegment(text) {
  const m = /([A-Za-z_][\w]*)\s*$/.exec(text.trim());
  return m ? m[1] : null;
}
function stripGenericParams(text) {
  if (!text.includes('[')) return text;
  let depth = 0;
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '[') { depth += 1; continue; }
    if (ch === ']') { depth -= 1; continue; }
    if (depth === 0) out += ch;
  }
  return out.trim();
}
function parseClassHeader(line) {
  const rel = { bases: [], metaclassName: null, baseClass: null };
  const m = /^class\s+[A-Za-z_][\w]*\s*(?:\[[^\]]*\])?\s*\(([^)]*)\)\s*:/.exec(line.trim());
  if (!m) return rel;
  const args = m[1].trim();
  if (!args) return rel;
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) { parts.push(args.slice(start, i)); start = i + 1; }
  }
  parts.push(args.slice(start));
  for (const part of parts) {
    const t = part.trim();
    if (!t) continue;
    if (t.startsWith('*')) continue;
    const kwM = /^([A-Za-z_][\w]*)\s*=\s*(.+)$/.exec(t);
    if (kwM && kwM[1] === 'metaclass') {
      rel.metaclassName = lastPathSegment(stripGenericParams(kwM[2].trim()));
      continue;
    }
    rel.bases.push(lastPathSegment(stripGenericParams(t)));
  }
  rel.bases = rel.bases.filter(Boolean);
  rel.baseClass = rel.bases[0] ?? null;
  return rel;
}
function parseDefHeader(line) {
  // 异步 / 同步 def
  const m = /^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*(?:->\s*([^:]+?))?\s*:/.exec(line.trim());
  if (!m) return null;
  return { name: m[1], argsText: m[2], returnType: m[3] ? m[3].trim() : null, isAsync: /^\s*async\s+def\b/.test(line) };
}
function parseArgs(argText) {
  const args = [];
  if (!argText.trim()) return args;
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < argText.length; i += 1) {
    const ch = argText[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) { parts.push(argText.slice(start, i)); start = i + 1; }
  }
  parts.push(argText.slice(start));
  for (const part of parts) {
    const t = part.trim();
    if (!t) continue;
    if (t.startsWith('**')) { args.push({ name: t.slice(2), kind: 'kwargs' }); continue; }
    if (t.startsWith('*')) { args.push({ name: t.slice(1), kind: 'vararg' }); continue; }
    const eqIdx = t.indexOf('=');
    const headOnly = eqIdx > 0 ? t.slice(0, eqIdx).trim() : t;
    const colonIdx = headOnly.indexOf(':');
    if (colonIdx > 0) {
      args.push({ name: headOnly.slice(0, colonIdx).trim(), kind: 'positional', type: headOnly.slice(colonIdx + 1).trim() });
    } else {
      args.push({ name: headOnly, kind: 'positional' });
    }
  }
  return args;
}
function decoratorInfo(line) {
  if (!line.startsWith('@')) return null;
  const body = line.slice(1);
  const parenIdx = body.indexOf('(');
  const nameOnly = parenIdx > 0 ? body.slice(0, parenIdx) : body;
  return { raw: line, name: lastPathSegment(nameOnly) ?? '', qualified: nameOnly.trim() };
}

// ---------- docstring 提取（clean 通道；从 bodyStart 行首查找首个字符串字面量） ----------
function extractDocstringFromClean(clean, bodyStart) {
  if (bodyStart >= clean.length) return null;
  let i = bodyStart;
  // 跳过前导空白与换行（兼容 bodyStart=0 与 bodyStart=':' 之后两种场景）
  while (i < clean.length && (clean[i] === ' ' || clean[i] === '\t' || clean[i] === '\n' || clean[i] === '\r')) i += 1;
  if (i >= clean.length) return null;
  const ch = clean[i];
  if (ch !== '"' && ch !== "'") return null;
  if (clean[i + 1] !== ch || clean[i + 2] !== ch) {
    let j = i + 1;
    while (j < clean.length && clean[j] !== ch && clean[j] !== '\n') {
      if (clean[j] === '\\' && j + 1 < clean.length) j += 1;
      j += 1;
    }
    if (clean[j] === ch) return clean.slice(i + 1, j).trim().slice(0, 200);
    return null;
  }
  const q = ch + ch + ch;
  let j = i + 3;
  const end = clean.indexOf(q, j);
  if (end < 0) return null;
  return clean.slice(j, end).replace(/\s+/g, ' ').trim().slice(0, 200);
}

// ---------- 调用链提取 ----------
function extractCalls(bodyText, lineStarts) {
  const calls = [];
  const lineOf = (pos) => lineAt(lineStarts, pos);
  const seen = new Set();
  for (const m of bodyText.matchAll(/(?<![A-Za-z0-9_.])(?:self|cls)\.([A-Za-z_][\w]*)\s*(?:\[[^\]]*\])?\s*\(/g)) {
    const key = `self:${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push({ to: m[1], kind: 'self', line: lineOf(m.index) });
  }
  for (const m of bodyText.matchAll(/(?<![A-Za-z0-9_.])([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)\s*(?:\[[^\]]*\])?\s*\(/g)) {
    const seg1 = m[1];
    const seg2 = m[2];
    if (['self', 'cls'].includes(seg1)) continue;
    const key = `dot:${seg1}.${seg2}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (/^[A-Z]/.test(seg1)) {
      calls.push({ to: seg2, kind: 'static', owner: seg1, line: lineOf(m.index) });
    } else {
      calls.push({ to: seg2, kind: 'pkg', owner: seg1, line: lineOf(m.index) });
    }
  }
  for (const m of bodyText.matchAll(/(?<![A-Za-z0-9_.])([A-Za-z_][\w]*)\s*(?:\[[^\]]*\])?\s*\(/g)) {
    const name = m[1];
    if (CALL_EXCLUDE.has(name)) continue;
    const key = `bare:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push({ to: name, kind: 'local', line: lineOf(m.index) });
  }
  for (const m of bodyText.matchAll(/(?<![A-Za-z0-9_.])([A-Z][\w]*)\s*(?:\[[^\]]*\])?\s*\(/g)) {
    const name = m[1];
    if (CALL_EXCLUDE.has(name)) continue;
    const key = `ctor:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push({ to: name, kind: 'ctor', line: lineOf(m.index) });
  }
  return calls;
}

// ---------- 入口点 / __all__ / 路由 ----------
function extractEntryPoints(clean, lineStarts) {
  const points = [];
  const re = /^[ \t]*if\s+__name__\s*==\s*['"]__main__['"]\s*:/gm;
  let m;
  while ((m = re.exec(clean))) points.push({ kind: '__main__', line: lineAt(lineStarts, m.index) });
  return points;
}
function extractDunderAll(clean, lineStarts) {
  const all = [];
  const re = /^[ \t]*__all__\s*=\s*[\[\(]([^\]\)]*)[\]\)]/gm;
  let m;
  while ((m = re.exec(clean))) {
    for (const item of m[1].split(',')) {
      const t = item.trim();
      // 仅接受字符串字面量（'a' / "a"）；变量名 / 数字 / 函数调用跳过
      if (/^['"][^'"]*['"]$/.test(t)) {
        all.push(t.replace(/^['"]|['"]$/g, ''));
      }
    }
  }
  return all;
}
function extractRoutes(stripped, clean, lineStarts) {
  const routes = [];
  const lineOf = (pos) => lineAt(lineStarts, pos);
  const decoRe = /^[ \t]*@(?<target>[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\.(?<method>get|post|put|delete|patch|head|options|route|add_route|add_get|add_post|add_put|add_delete|add_patch|add_head|add_options)\b[ \t]*(?:\(([^)]*)\))?[ \t]*$/gm;
  let m;
  while ((m = decoRe.exec(clean))) {
    const target = m.groups.target;
    const methodRaw = m.groups.method;
    const argsText = m[3] ?? '';
    let method = methodRaw.toUpperCase();
    let path = null;
    if (methodRaw === 'route') {
      const parts = splitTopLevelArgs(argsText);
      if (parts.length) {
        path = parts[0].trim().replace(/^['"]|['"]$/g, '');
        const methodsM = /methods\s*=\s*\[([^\]]*)\]/.exec(argsText);
        if (methodsM) {
          const ml = methodsM[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '').toUpperCase()).filter(Boolean);
          method = ml[0] ?? 'GET';
        }
      }
    } else if (methodRaw.startsWith('add_')) {
      const parts = splitTopLevelArgs(argsText);
      if (parts.length) path = parts[0].trim().replace(/^['"]|['"]$/g, '');
      method = methodRaw.replace('add_', '').toUpperCase();
    } else if (methodRaw === 'add_route') {
      const parts = splitTopLevelArgs(argsText);
      if (parts.length >= 2) path = parts[1].trim().replace(/^['"]|['"]$/g, '');
      method = 'ANY';
    } else {
      const parts = splitTopLevelArgs(argsText);
      if (parts.length) path = parts[0].trim().replace(/^['"]|['"]$/g, '');
    }
    if (!path) continue;
    const handler = findHandlerAfter(stripped, m.index + m[0].length, lineOf);
    if (!handler) continue;
    routes.push({ method, path, handler: handler.name, target, line: lineOf(m.index) });
  }
  return routes;
}
function splitTopLevelArgs(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let inStr = false;
  let strCh = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\' && i + 1 < text.length) { i += 1; continue; }
      if (ch === strCh) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}
function findHandlerAfter(stripped, fromPos, lineOf) {
  const end = Math.min(stripped.length, fromPos + 1024);
  const re = /^[ \t]*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/gm;
  re.lastIndex = fromPos;
  let m;
  while ((m = re.exec(stripped)) && m.index < end) {
    const prev = stripped[m.index - 1] ?? '';
    if (prev === '\n' || prev === ' ' || prev === '\t') {
      return { name: m[1], line: lineOf(m.index) };
    }
  }
  return null;
}

// ---------- 类字段解析（含 SQLAlchemy 2.0 Mapped[] + 跨行续行） ----------
function parseClassFields(cleanBody) {
  const fields = [];
  // 跨行续行：把多行 wrapped 语句合并为单行
  const lines = cleanBody.split('\n');
  const logicalLines = [];
  let buf = '';
  let depth = 0;
  for (const line of lines) {
    buf += (buf ? '\n' : '') + line;
    for (const ch of line) {
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    }
    if (depth <= 0) {
      logicalLines.push(buf);
      buf = '';
      depth = 0;
    }
  }
  if (buf) logicalLines.push(buf);

  for (const ll of logicalLines) {
    const t = ll.split('\n').map((s) => s.trim()).join(' ').trim();
    if (!t) continue;
    if (/^def\s/.test(t) || /^class\s/.test(t) || t.startsWith('@')) continue;
    // 排除方法体赋值：self.x = ... / cls.x = ...
    if (/^(?:self|cls)\./.test(t)) continue;
    // SQLAlchemy 2.0：name: Mapped[type] = mapped_column(...) / name: Mapped[type] = relationship(...)
    // 处理嵌套括号：typeText 用括号深度匹配而非 [^\]]+（避免 Mapped[list[X]] 提前终止）
    const mappedRe = /^([A-Za-z_][\w]*)\s*:\s*Mapped\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\s*=\s*(mapped_column|relationship)\b/;
    const mappedM = mappedRe.exec(t);
    if (mappedM) {
      const name = mappedM[1];
      const typeText = mappedM[2].trim();
      const kind = mappedM[3] === 'relationship' ? 'relation' : 'column';
      let target = null;
      if (kind === 'relation') {
        const targetM = /['"]([A-Za-z_][\w]*)['"]/.exec(t);
        if (targetM) target = targetM[1];
      }
      if (name.startsWith('_')) continue;
      fields.push({ name, type: `Mapped[${typeText}]`, kind, target });
      continue;
    }
    // Pydantic / dataclass：name: type / name: type = default
    const m1 = /^([A-Za-z_][\w]*)\s*:\s*([^=]+?)\s*(?:=.*)?$/.exec(t);
    if (m1) {
      const name = m1[1];
      const type = m1[2].trim();
      if (name.startsWith('_')) continue;
      if (['ClassVar', 'Optional', 'List', 'Dict', 'Tuple', 'Set', 'FrozenSet', 'Union', 'Any', 'Callable', 'Mapped'].includes(name)) continue;
      const kind = /^Mapped\[/.test(type) ? 'column' : null;
      fields.push({ name, type: type.replace(/\s+/g, ' ').trim(), kind });
      continue;
    }
    // 裸赋值：name = value
    const m2 = /^([A-Za-z_][\w]*)\s*=\s*(.+)$/.exec(t);
    if (m2) {
      const name = m2[1];
      if (name.startsWith('_')) continue;
      if (['True', 'False', 'None', 'self', 'cls'].includes(name)) continue;
      if (CALL_EXCLUDE.has(name)) continue;
      const kind = /relationship\(/.test(t) ? 'relation' : (/mapped_column\(/.test(t) ? 'column' : null);
      fields.push({ name, type: null, kind });
    }
  }
  return fields;
}

// ---------- 主解析：缩进感知的行级状态机 ----------
export function analyzePythonFile(relPath, content) {
  const lineStarts = computeLineStarts(content);
  const stripped = stripPythonNoise(content);
  const clean = stripCommentsOnly(content);
  const lineOf = (pos) => lineAt(lineStarts, pos);

  const facts = {
    ext: 'py',
    lineCount: lineStarts.length,
    isUserScript: false,
    language: 'python',
    pythonVersion: null,
    interfaces: [],
    classes: [],
    moduleFunctions: [],
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
    pythonExports: [],
    pythonEntryPoints: [],
    pythonDecorators: [],
    pythonRoutes: [],
    pythonModuleDocstring: null,
  };

  // nameReferences（全文标识符位置；stripped 通道排除字符串内容）
  for (const m of stripped.matchAll(/[A-Za-z_][\w]*/g)) {
    const arr = facts.nameReferences.get(m[0]);
    if (arr) arr.push(m.index);
    else facts.nameReferences.set(m[0], [m.index]);
  }

  facts.pythonExports = extractDunderAll(clean, lineStarts);
  facts.pythonEntryPoints = extractEntryPoints(clean, lineStarts);
  facts.pythonRoutes = extractRoutes(stripped, clean, lineStarts);

  // 模块 docstring（首条语句）
  facts.pythonModuleDocstring = extractDocstringFromClean(clean, 0);

  // import
  for (const imp of extractImports(clean)) {
    facts.imports.push(imp);
    for (const n of imp.names) {
      if (n.local && n.local !== '*') facts.importMap.set(n.local, imp.specifier);
    }
  }

  // 行级状态机：以 stripped 与 clean 同步行号
  const lines = stripped.split('\n');
  const cleanLines = clean.split('\n');
  const classes = facts.classes;
  const interfaces = facts.interfaces;
  const blockStack = []; // { kind:'class'|'def', name, indent, head, headStart, bodyStart, methods, bases, metaclassName, decoratorLines, returnType, isAsync, argsText, exported }
  let pendingDecorators = []; // 累积的装饰器行（待 class/def 消费）

  const popFrames = (currentIndent, currentPos) => {
    while (blockStack.length > 0 && currentIndent <= blockStack[blockStack.length - 1].indent) {
      const frame = blockStack.pop();
      finalize(frame, currentPos);
    }
  };

  const finalize = (frame, closePos) => {
    if (frame.kind === 'def' && blockStack.length === 0) {
      // 顶层 def：补齐 moduleFunctions
      const exported = !frame.name.startsWith('_');
      const argsList = parseArgs(frame.argsText ?? '');
      const docstring = extractDocstringFromClean(clean, frame.bodyStart);
      const fn = {
        name: frame.name,
        line: lineOf(frame.headStart),
        exported,
        isAsync: frame.isAsync,
        signature: (frame.head || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        args: argsList,
        returnType: frame.returnType,
        decorators: frame.decoratorLines.map(decoratorInfo).filter(Boolean),
        isDunder: /^__[A-Za-z][\w]*__$/.test(frame.name),
        dunderCategory: dunderCategory(frame.name),
        docstring,
        pos: frame.headStart,
      };
      facts.moduleFunctions.push(fn);
      if (exported) {
        facts.exportSymbols.push({ name: frame.name, kind: 'function', line: fn.line, isDefault: false, isExported: true });
      }
      for (const d of fn.decorators) facts.pythonDecorators.push({ ...d, on: frame.name, kind: 'module-function', line: fn.line });
      const isCliEntry = fn.decorators.some((d) => ENTRY_DECORATORS.has(d.qualified));
      if (isCliEntry) facts.pythonEntryPoints.push({ kind: 'cli', handler: frame.name, line: fn.line });
      // 调用链：body 区间 = frame.bodyStart → closePos
      const bodyText = stripped.slice(frame.bodyStart, closePos);
      const calls = extractCalls(bodyText, lineStarts);
      if (calls.length) facts.callEdges.push({ from: frame.name, to: calls });
    } else if (frame.kind === 'def' && blockStack.length > 0) {
      // 类方法：补齐到父 class.methods
      const parent = blockStack[blockStack.length - 1];
      if (parent.kind === 'class') {
        const header = parseDefHeader(frame.head);
        const argsList = parseArgs(header?.argsText ?? '');
        const methodDecos = frame.decoratorLines.map(decoratorInfo).filter(Boolean);
        const isDunder = /^__[A-Za-z][\w]*__$/.test(frame.name);
        const decoKinds = new Set(methodDecos.map((d) => DECORATOR_KIND[d.name]).filter(Boolean));
        const method = {
          name: frame.name,
          line: lineOf(frame.headStart),
          isStatic: decoKinds.has('static'),
          isClass: decoKinds.has('class'),
          isAsync: frame.isAsync,
          isOverride: decoKinds.has('override'),
          isAbstract: decoKinds.has('abstract'),
          isProperty: decoKinds.has('property'),
          isDunder,
          dunderCategory: dunderCategory(frame.name),
          decorators: methodDecos,
          args: argsList,
          returnType: header?.returnType ?? null,
          signature: (frame.head || '').replace(/\s+/g, ' ').trim().slice(0, 200),
          docstring: extractDocstringFromClean(clean, frame.bodyStart),
          pos: frame.headStart,
          end: closePos,
        };
        parent.methods.push(method);
        for (const d of methodDecos) facts.pythonDecorators.push({ ...d, on: `${parent.name}.${frame.name}`, kind: 'method', line: method.line });
        // 类方法调用链：body 区间 = frame.bodyStart → closePos
        const methodBody = stripped.slice(frame.bodyStart, closePos);
        const methodCalls = extractCalls(methodBody, lineStarts);
        if (methodCalls.length) facts.callEdges.push({ from: `${parent.name}.${frame.name}`, to: methodCalls });
      }
    } else if (frame.kind === 'class') {
      // 收尾 class：fields / methods / decorator 聚合 / 决定 Class vs Interface
      const bodyText = clean.slice(frame.bodyStart, closePos);
      const cleanBody = bodyText;
      const hasAbstractMethod = frame.decoratorLines.some((d) => d.startsWith('@') && /abstract/.test(d))
        || /@abstractmethod/.test(cleanBody);
      const inheritsABC = (frame.bases ?? []).some((b) => b === 'ABC' || b === 'ABCMeta');
      const onlyAbstract = frame.methods.length > 0 && frame.methods.every((m) => m.isAbstract);
      const isInterface = (inheritsABC && onlyAbstract) || (hasAbstractMethod && frame.methods.length > 0 && onlyAbstract);
      const fields = parseClassFields(cleanBody);
      // SQLAlchemy __tablename__ 检测
      const tableNameM = /^[ \t]*__tablename__\s*=\s*['"]([^'"]+)['"]/m.exec(cleanBody);
      const tableName = tableNameM ? tableNameM[1] : null;
      // SQLAlchemy __table_args__ 检测（schema/约束）
      const tableArgsM = /^[ \t]*__table_args__\s*=\s*\(([^)]+)\)/m.exec(cleanBody);
      const tableArgs = tableArgsM ? tableArgsM[1].trim() : null;
      // 检测 mixin / abstract 基类（Pydantic BaseModel / SQLAlchemy Base / FastAPI / 等框架基类）
      const ormHints = [];
      if (tableName) ormHints.push('sqlalchemy-table');
      if (tableArgs) ormHints.push('sqlalchemy-table-args');
      const exported = !frame.name.startsWith('_');
      const cls = {
        name: frame.name,
        line: lineOf(frame.headStart),
        exported,
        isSingleton: frame.methods.some((m) => m.name === '__new__' && /\b__new__\s*\(/.test(m.signature ?? ''))
          || /Singleton|MetaSingleton/.test((frame.bases ?? []).join(' ') + (frame.metaclassName ?? '')),
        kind: 'class',
        derives: [],
        fields,
        variants: [],
        implementsNames: [],
        extendsName: frame.bases?.[0] ?? null,
        bases: frame.bases ?? [],
        metaclassName: frame.metaclassName ?? null,
        decorators: frame.decoratorLines.map(decoratorInfo).filter(Boolean),
        methods: frame.methods,
        pos: frame.headStart,
        end: lineOf(closePos) + 1,
        language: 'python',
        // Python 专有扩展字段（builder 可消费）
        tableName,            // SQLAlchemy: __tablename__
        tableArgs,            // SQLAlchemy: __table_args__ 原始文本
        ormHints,             // 框架基类检测（sqlalchemy-table / sqlalchemy-table-args）
      };
      if (isInterface) {
        interfaces.push({
          name: frame.name,
          line: lineOf(frame.headStart),
          exported,
          extendsNames: frame.bases ?? [],
          methods: frame.methods.filter((m) => m.isAbstract),
          pos: frame.headStart,
          end: lineOf(closePos) + 1,
          language: 'python',
        });
      } else {
        classes.push(cls);
      }
      if (exported) {
        facts.exportSymbols.push({ name: frame.name, kind: 'python-class', line: lineOf(frame.headStart), isDefault: false, isExported: true });
      }
      for (const d of cls.decorators) facts.pythonDecorators.push({ ...d, on: frame.name, kind: 'class', line: lineOf(frame.headStart) });
    }
  };

  for (let li = 0; li < lines.length; li += 1) {
    const raw = lines[li];
    const cleanRaw = cleanLines[li] ?? raw;
    const indent = lineIndent(raw);
    const trimmed = raw.trim();
    const lineStart = lineStarts[li];
    if (!trimmed) continue;

    // 装饰器行：累积到 pendingDecorators
    if (trimmed.startsWith('@')) {
      pendingDecorators.push({ line: trimmed, lineStart });
      continue;
    }

    // 缩进 <= 栈顶 indent → 弹栈
    if (indent >= 0) popFrames(indent, lineStart);

    // class 声明
    const classM = /^class\s+([A-Za-z_][\w]*)/.exec(trimmed);
    if (classM) {
      const name = classM[1];
      const rel = parseClassHeader(cleanRaw.trim());
      const headStart = pendingDecorators.length > 0
        ? pendingDecorators[0].lineStart
        : lineStart;
      blockStack.push({
        kind: 'class',
        name,
        indent,
        head: cleanRaw.trim(),
        headStart,
        bodyStart: lineStart + raw.length + 1,
        methods: [],
        bases: rel.bases,
        metaclassName: rel.metaclassName,
        decoratorLines: pendingDecorators.map((d) => d.line),
      });
      pendingDecorators = [];
      continue;
    }

    // def 声明
    const defM = /^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/.exec(trimmed);
    if (defM) {
      const name = defM[1];
      const header = parseDefHeader(cleanRaw.trim());
      const headStart = pendingDecorators.length > 0
        ? pendingDecorators[0].lineStart
        : lineStart;
      blockStack.push({
        kind: 'def',
        name,
        indent,
        head: cleanRaw.trim(),
        headStart,
        bodyStart: lineStart + raw.length + 1,
        isAsync: header?.isAsync ?? false,
        argsText: header?.argsText ?? '',
        returnType: header?.returnType ?? null,
        decoratorLines: pendingDecorators.map((d) => d.line),
      });
      pendingDecorators = [];
      continue;
    }

    // 其他语句：清空 pendingDecorators（避免装饰器被错配给非声明语句）
    pendingDecorators = [];
  }

  // 文件结束：弹光所有栈
  popFrames(-1, stripped.length);

  facts.exportNames = facts.exportSymbols.map((s) => s.name);
  return facts;
}

export function isPythonCandidate(relPath) {
  return relPath.endsWith('.py') && !relPath.endsWith('.pyc');
}

// ---------- Python AST 语法批量校验 ----------
// pythonAnalyzer 是基于缩进的轻量级解析，不真正校验 Python 语法。
// 对包含 SyntaxError 的文件（如 Python 2 风格的 `except X, Y:`），仍会"静默成功"，
// 但产出的实体可能不完整。批量 spawn 一次 python3 调 ast.parse，把失败文件登记到
// pythonSyntaxErrors，analyzePythonFileFromDisk 检测到后 throw，由 builder 写入
// analysisErrors（与其它分析器的 throw 行为一致）。
const pythonSyntaxErrors = new Map(); // relPath -> { line: number, msg: string, source?: string }

function getPythonExecutable() {
  return process.env.NICE_AOS_PYTHON || 'python3';
}

export function checkPythonSyntaxBulk(relPaths, projectRoot) {
  // 清空上次的缓存（每次 refreshRepo 重新校）
  pythonSyntaxErrors.clear();
  if (!relPaths || relPaths.length === 0) return pythonSyntaxErrors;

  const py = getPythonExecutable();
  // 构造一段 Python 脚本：循环调 ast.parse，对失败文件输出 "FILE\tLINE\tMSG"
  // 用 tab 分隔以避免路径/消息里出现换行的歧义；JSON 转义确保安全。
  const lines = [
    'import ast, json, sys',
    'results = []',
    'for p in sys.argv[1:]:',
    '    try:',
    '        ast.parse(open(p, encoding="utf-8", errors="replace").read(), filename=p)',
    '    except (SyntaxError, ValueError) as e:',
    '        msg = getattr(e, "msg", str(e)) or str(e)',
    '        lineno = getattr(e, "lineno", 0) or 0',
    '        results.append({"file": p, "line": lineno, "msg": msg})',
    'print(json.dumps(results, ensure_ascii=False))',
  ];
  const script = lines.join('\n');

  const args = [].concat(['-c', script], relPaths.map((rp) => path.join(projectRoot, rp)));
  let stdout = '';
  try {
    const r = spawnSync(py, args, { encoding: 'utf-8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    if (r.error) {
      // 调不到 python3（极少见），跳过 AST 校验，保留轻量级解析的结果
      return pythonSyntaxErrors;
    }
    if (r.status !== 0) {
      return pythonSyntaxErrors;
    }
    stdout = (r.stdout || '').trim();
    if (!stdout) return pythonSyntaxErrors;
    const arr = JSON.parse(stdout);
    if (!Array.isArray(arr)) return pythonSyntaxErrors;
    for (const e of arr) {
      // 把绝对路径转回相对路径
      let rel = e.file;
      if (projectRoot && rel.startsWith(projectRoot + path.sep)) {
        rel = rel.slice(projectRoot.length + 1);
      } else if (projectRoot && rel.startsWith(projectRoot)) {
        rel = rel.slice(projectRoot.length);
      }
      pythonSyntaxErrors.set(rel, { line: e.line ?? 0, msg: e.msg ?? 'SyntaxError' });
    }
  } catch {
    // 解析 stdout 失败或 spawn 异常，保留原行为（不阻塞主流程）
  }
  return pythonSyntaxErrors;
}

export function getPythonSyntaxErrors() {
  return pythonSyntaxErrors;
}

export function analyzePythonFileFromDisk(relPath, projectRoot) {
  // 若该文件已被批量 AST 校验标记为语法错误，主动 throw 让上层写入 analysisErrors。
  // 这样轻量级解析的结果不会被纳入本体，下游消费方能立刻看到失败。
  const cached = pythonSyntaxErrors.get(relPath);
  if (cached) {
    const where = cached.line ? `:${cached.line}` : '';
    const err = new Error(`Python syntax error${where}: ${cached.msg}`);
    err.code = 'PYTHON_SYNTAX_ERROR';
    err.file = relPath;
    err.line = cached.line;
    throw err;
  }
  const abs = path.join(projectRoot, relPath);
  const content = fs.readFileSync(abs, 'utf-8');
  return analyzePythonFile(relPath, content);
}
