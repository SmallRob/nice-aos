// Python 实体分析器（Python 3 脚本 / FastAPI 后端 / Flask / Django / Chaquopy / 油猴配套脚本 / ROS 2 rclpy 节点 / ROS 2 launch 文件）：
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
//   顶层 def main() → pythonEntryPoints（main 入口，无需 __main__ 守卫）；
//   @app.command / @click.command / @typer.command 装饰器 → pythonEntryPoints（CLI 入口）；
//   方法/函数体内调用 → callEdges（self.method() / cls.method() / Class.method() / pkg.func() / new Class()）；
//   @app.get/post/put/delete/patch + @app.route / @router.get 系列 → pythonRoutes（method/path/handler/target）。
// v0.39.0 ROS 2 维度：
//   class X(rclpy.node.Node | LifecycleNode | ComposableNode) → ormHints += ros2-node|ros2-lifecycle-node|ros2-composable-node；
//   class body 内 self.create_publisher / create_subscription / create_service / create_client / create_timer /
//   create_action_server / ActionClient / declare_parameter → channels.{publishers|subscribers|services|clients|timers|actions|parameters}；
//   *.launch.py 中 def generate_launch_description() → pythonLaunch.{isLaunch, entry, args, nodes, executeProcess, includeLaunch, actions}；
//   顶层 Node(package=..., executable=..., name=...) / ExecuteProcess / DeclareLaunchArgument /
//   IncludeLaunchDescription / GroupAction / SetEnvironmentVariable / TimerAction 等抽到 launch 实体。
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

// v0.39.0 ROS 2 框架基类（rclpy 主流 API；LifecycleNode / ComposableNode / ActionServer 等扩展）
// 检测 class X(Base): 中任一基类为 ROS 2 节点基类时，标记为对应 rosHint
const ROS2_NODE_BASES = new Set([
  'Node', 'LifecycleNode', 'ComposableNode', 'Node as rclpy_Node',  // 兼容别名
]);
const ROS2_NODE_FQN_BASES = new Set([
  'rclpy.node.Node', 'rclpy.lifecycle.node.LifecycleNode',
]);
const ROS2_BASE_HINT = {
  Node: 'ros2-node',
  'rclpy.node.Node': 'ros2-node',
  LifecycleNode: 'ros2-lifecycle-node',
  'rclpy.lifecycle.node.LifecycleNode': 'ros2-lifecycle-node',
  ComposableNode: 'ros2-composable-node',
};

// v0.39.0 ROS 2 通信通道模式
// create_publisher / create_subscription / create_service / create_client / create_timer /
// create_action_server / create_action_client / declare_parameter / get_parameter / set_parameters
// 在 stripped 通道上提取（已剥离字符串，避免误判）
const ROS2_CHANNEL_PATTERNS = [
  { kind: 'publisher',    re: /\bself\.create_publisher\s*\(/g,        args: ['msgType', 'topic', 'qos'] },
  { kind: 'subscription', re: /\bself\.create_subscription\s*\(/g,   args: ['msgType', 'topic', 'callback', 'qos'] },
  { kind: 'service',      re: /\bself\.create_service\s*\(/g,        args: ['srvType', 'name', 'callback'] },
  { kind: 'client',       re: /\bself\.create_client\s*\(/g,         args: ['srvType', 'name'] },
  { kind: 'timer',        re: /\bself\.create_timer\s*\(/g,          args: ['period', 'callback'] },
  { kind: 'action-server',re: /\bself\.create_action_server\s*\(/g,  args: ['actionType', 'name', 'callback'] },
  { kind: 'action-client',re: /\bActionClient\s*\(/g,                args: ['node', 'actionType', 'name'] },
  { kind: 'parameter',    re: /\bself\.declare_parameter\s*\(/g,     args: ['name', 'default'] },
];

// v0.39.0 launch 文件入口
//   .launch.py 文件中存在 def generate_launch_description(): 即为 ROS 2 launch 文件
//   返回值是 LaunchDescription([...]) 列表里的元素会按以下类型分类
const LAUNCH_ENTRY_FUNC = 'generate_launch_description';
const LAUNCH_ACTIONS = new Set([
  'Node', 'ExecuteProcess', 'DeclareLaunchArgument', 'IncludeLaunchDescription',
  'GroupAction', 'OpaqueFunction', 'SetLaunchConfiguration', 'SetEnvironmentVariable',
  'TimerAction', 'RegisterEventHandler', 'UnregisterEventHandler',
  'ComposableNodeContainer', 'LoadComposableNodes', 'PushRosNamespace',
  'RosTimer', 'Shutdown',
]);

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

// ---------- 类字段解析（缩进感知 + SQLAlchemy 2.0 Mapped[] + 跨行续行） ----------
// v0.39.0 修复：原实现把方法体里的局部变量也当成类字段（测试 dock_trigger.py 一度 341 个伪字段）。
// 关键修正：维护一个 blockStack（def/class/复合语句 if/try/for/with），仅当语句不被任何块包裹时
// 才认作"类直接体"（class-body level）字段。compound 块（if/try/for/with）因为不带 indent 上升
// 也用最小 indent 比较来推进/弹出。
function parseClassFields(cleanBody) {
  const fields = [];
  // 跨行续行：把多行 wrapped 语句合并为单行（带 indent 取首行）
  const lines = cleanBody.split('\n');
  const logical = []; // { indent, text, line }
  let buf = '';
  let bufIndent = -1;
  let depth = 0;
  let bufLine = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!buf) {
      bufIndent = lineIndent(line);
      bufLine = i;
    }
    buf += (buf ? '\n' : '') + line;
    for (const ch of line) {
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    }
    if (depth <= 0) {
      logical.push({ indent: bufIndent, text: buf.split('\n').map((s) => s.trim()).join(' ').trim(), line: bufLine });
      buf = '';
      bufIndent = -1;
    }
  }
  if (buf) logical.push({ indent: bufIndent, text: buf.split('\n').map((s) => s.trim()).join(' ').trim(), line: bufLine });

  // blockStack 跟踪 def / class（也包括装饰器行所在的"待定 def/class"占位）
  // indent 退到 <= 栈顶时弹栈，栈空时即类直接体语句。
  const blockStack = []; // [{ indent, kind: 'def'|'class'|'pending-def'|'pending-class' }]
  for (const { indent, text } of logical) {
    if (!text) continue;
    // 装饰器行：累积到"待定"栈帧，下一行必须是 def/class
    if (text.startsWith('@')) {
      if (indent >= 0) {
        // 同 indent 才视为待定（避免错配）
        blockStack.push({ indent, kind: /^@\s*(?:\w+\.)*(?:def|class)\b/.test(text) ? 'pending' : 'skip' });
      }
      continue;
    }
    // 弹栈：缩进 <= 栈顶 indent 时全部弹出
    while (blockStack.length > 0 && indent >= 0 && indent <= blockStack[blockStack.length - 1].indent) {
      blockStack.pop();
    }
    // 仍在某个块内部 → 不是类直接体
    if (blockStack.length > 0) continue;
    if (indent < 0) continue; // 空白行

    // def / async def / class → 进入新块
    if (/^(?:async\s+)?def\s/.test(text) || /^class\s/.test(text)) {
      blockStack.push({ indent, kind: /^class\s/.test(text) ? 'class' : 'def' });
      continue;
    }
    // 复合语句（if/elif/else/try/except/finally/with/for/while/match/case）以冒号结尾：
    // 进入块 → 内部语句被吃掉。复合语句本身不参与字段检测。
    if (text.endsWith(':') && /^(?:if|elif|else|try|except|finally|with|for|while|match|case)\b/.test(text)) {
      blockStack.push({ indent, kind: 'compound' });
      continue;
    }
    // 排除方法体赋值：self.x = ... / cls.x = ...（在类直接体中出现也属合法属性，但 SQLAlchemy/ORM
    // 通常用 : 注解形式而非 self.x 形式；这里保留 self.x 的过滤逻辑，仅作显式类属性时进入实体）。
    if (/^(?:self|cls)\./.test(text)) continue;
    // SQLAlchemy 2.0：name: Mapped[type] = mapped_column(...) / name: Mapped[type] = relationship(...)
    // 处理嵌套括号：typeText 用括号深度匹配而非 [^\]]+（避免 Mapped[list[X]] 提前终止）
    const mappedRe = /^([A-Za-z_][\w]*)\s*:\s*Mapped\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\s*=\s*(mapped_column|relationship)\b/;
    const mappedM = mappedRe.exec(text);
    if (mappedM) {
      const name = mappedM[1];
      const typeText = mappedM[2].trim();
      const kind = mappedM[3] === 'relationship' ? 'relation' : 'column';
      let target = null;
      if (kind === 'relation') {
        const targetM = /['"]([A-Za-z_][\w]*)['"]/.exec(text);
        if (targetM) target = targetM[1];
      }
      if (name.startsWith('_')) continue;
      fields.push({ name, type: `Mapped[${typeText}]`, kind, target });
      continue;
    }
    // Pydantic / dataclass：name: type / name: type = default
    const m1 = /^([A-Za-z_][\w]*)\s*:\s*([^=]+?)\s*(?:=.*)?$/.exec(text);
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
    const m2 = /^([A-Za-z_][\w]*)\s*=\s*(.+)$/.exec(text);
    if (m2) {
      const name = m2[1];
      if (name.startsWith('_')) continue;
      if (['True', 'False', 'None', 'self', 'cls'].includes(name)) continue;
      if (CALL_EXCLUDE.has(name)) continue;
      const kind = /relationship\(/.test(text) ? 'relation' : (/mapped_column\(/.test(text) ? 'column' : null);
      fields.push({ name, type: null, kind });
    }
  }
  return fields;
}

// ---------- v0.39.0 ROS 2 通信通道抽取 ----------
// 在 class body 整体上扫描 self.create_publisher / create_subscription / ... / declare_parameter。
// 第一个参数通常是类引用（LaserScan / PoseStamped / SetBool 等），第二个是 topic/name 字面量。
// callback 参数通常是 self.xxx / class.method 字面，无法静态解析，保留原文本。
// 字符串内容已通过 stripped 通道剥离，不会误判 f-string 里的伪调用。
function extractRos2Channels(cleanBody, lineStarts) {
  const lineOf = (pos) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  const channels = { publishers: [], subscribers: [], services: [], clients: [], timers: [], actions: [], parameters: [] };
  for (const pat of ROS2_CHANNEL_PATTERNS) {
    pat.re.lastIndex = 0;
    let m;
    while ((m = pat.re.exec(cleanBody))) {
      const callStart = m.index + m[0].length - 1; // 指向 '('
      const callEnd = findMatchingParen(cleanBody, callStart);
      if (callEnd < 0) continue;
      const argsText = cleanBody.slice(callStart + 1, callEnd);
      const args = splitCallArgs(argsText);
      const channel = { kind: pat.kind, line: 0 };
      for (let i = 0; i < pat.args.length && i < args.length; i += 1) {
        const v = args[i].trim().replace(/^['"]|['"]$/g, '');
        channel[pat.args[i]] = v;
      }
      channel.line = lineOf(m.index);
      // bucket 命名修正：subscription→subscribers、action-server/action-client→actions、parameter→parameters、其余 kind+'s'
      const bucket = pat.kind === 'action-server' || pat.kind === 'action-client' ? 'actions'
        : pat.kind === 'parameter' ? 'parameters'
        : pat.kind === 'subscription' ? 'subscribers'
        : pat.kind + 's';
      if (!channels[bucket]) {
        // 兜底：未知 pat.kind 不应崩溃，落入 publishers 便于 agent 定位
        channels.publishers.push({ ...channel, bucketFallback: true });
        continue;
      }
      channels[bucket].push(channel);
    }
  }
  return channels;
}
function findMatchingParen(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function splitCallArgs(text) {
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
// 注：channel.line 由主解析处的 lineOf(pos) 闭包填入（基于完整 lineStarts）
// 这里不再需要 lineAtFromText 占位函数

// ---------- v0.39.0 ROS 2 Node 类基类识别 ----------
// bases 已经末段剥离（'rclpy.node.Node' → 'Node'），但我们额外兼容完整 FQN 的元组
function detectRos2NodeHint(bases) {
  for (const b of bases) {
    if (ROS2_BASE_HINT[b]) return ROS2_BASE_HINT[b];
  }
  return null;
}

// ---------- v0.39.0 ROS 2 launch 文件抽取 ----------
// 检测 .launch.py 文件中：
//   1. def generate_launch_description() → entry 函数
//   2. LaunchDescription([...]) 列表里的动作（Node / ExecuteProcess / DeclareLaunchArgument /
//      IncludeLaunchDescription / GroupAction 等）
//   3. 顶层 Node(package=..., executable=..., name=..., parameters=..., remappings=...) 实例
//   4. 顶层 DeclareLaunchArgument(name=..., default_value=..., description=...)
// 字符串内容走 stripped 通道（避免 f-string 里的伪构造）。
function extractLaunch(cleanBody, lineStarts) {
  const lineOf = (pos) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  const out = {
    isLaunch: false,
    entry: null,           // 入口函数名（通常 'generate_launch_description'）
    args: [],              // DeclareLaunchArgument 列表
    nodes: [],             // Node(...) 实例
    executeProcess: [],    // ExecuteProcess(cmd=...)
    includeLaunch: [],     // IncludeLaunchDescription(...)
    actions: [],           // 其它动作（GroupAction / SetEnvironmentVariable / TimerAction ...）
  };
  // 入口函数
  const entryM = /^[ \t]*def\s+(generate_launch_description|generate_launch_file)\s*\(/m.exec(cleanBody);
  if (!entryM) return out;
  out.isLaunch = true;
  out.entry = entryM[1];

  // 抽取 Node(package=..., executable=..., name=...)
  const nodeRe = /\bNode\s*\(/g;
  let m;
  while ((m = nodeRe.exec(cleanBody))) {
    const open = m.index + m[0].length - 1;
    const close = findMatchingParen(cleanBody, open);
    if (close < 0) continue;
    const argsText = cleanBody.slice(open + 1, close);
    const node = {
      package: extractKwarg(argsText, 'package'),
      executable: extractKwarg(argsText, 'executable'),
      name: extractKwarg(argsText, 'name'),
      namespace: extractKwarg(argsText, 'namespace'),
      line: lineOf(m.index),
      isComposable: /\bComposableNode\s*\(/.test(cleanBody.slice(Math.max(0, m.index - 32), m.index)),
    };
    if (node.package || node.executable || node.name) out.nodes.push(node);
  }

  // 抽取 ExecuteProcess(cmd=...)
  const execRe = /\bExecuteProcess\s*\(/g;
  while ((m = execRe.exec(cleanBody))) {
    const open = m.index + m[0].length - 1;
    const close = findMatchingParen(cleanBody, open);
    if (close < 0) continue;
    const argsText = cleanBody.slice(open + 1, close);
    const cmd = extractListArg(argsText, 'cmd');
    out.executeProcess.push({ cmd, line: lineOf(m.index) });
  }

  // 抽取 DeclareLaunchArgument(name=..., default_value=..., description=...)
  const argRe = /\bDeclareLaunchArgument\s*\(/g;
  while ((m = argRe.exec(cleanBody))) {
    const open = m.index + m[0].length - 1;
    const close = findMatchingParen(cleanBody, open);
    if (close < 0) continue;
    const argsText = cleanBody.slice(open + 1, close);
    out.args.push({
      name: extractKwarg(argsText, 'name') ?? extractBareStr(argsText, 0),
      defaultValue: extractKwarg(argsText, 'default_value') ?? extractKwarg(argsText, 'default'),
      description: extractKwarg(argsText, 'description'),
      line: lineOf(m.index),
    });
  }

  // 抽取 IncludeLaunchDescription(...)
  const incRe = /\bIncludeLaunchDescription\s*\(/g;
  while ((m = incRe.exec(cleanBody))) {
    const open = m.index + m[0].length - 1;
    const close = findMatchingParen(cleanBody, open);
    if (close < 0) continue;
    const argsText = cleanBody.slice(open + 1, close);
    // PythonLaunchDescriptionSource(os.path.join(...)) 路径信息在内层表达式
    const srcM = /PythonLaunchDescriptionSource\s*\(([^)]+)\)/.exec(argsText);
    out.includeLaunch.push({
      path: srcM ? srcM[1].trim() : null,
      line: lineOf(m.index),
    });
  }

  // 其它动作（GroupAction / SetEnvironmentVariable / TimerAction / ComposableNodeContainer ...）
  const actionKindRe = /\b(GroupAction|OpaqueFunction|SetLaunchConfiguration|SetEnvironmentVariable|TimerAction|RegisterEventHandler|ComposableNodeContainer|LoadComposableNodes|PushRosNamespace|RosTimer|Shutdown)\s*\(/g;
  while ((m = actionKindRe.exec(cleanBody))) {
    out.actions.push({ kind: m[1], line: lineOf(m.index) });
  }
  return out;
}

// 从 Node(package='x', executable='y') 之类 kwargs 文本里抽 keyword=value
// value 允许 'str' / "str" / True / False / None / 123 / 3.14 / 简单变量名（保留原文本）
function extractKwarg(argsText, name) {
  const re = new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*([^,]+?)(?=,|\\)|$)`, 'm');
  const m = re.exec(argsText);
  if (!m) return null;
  return normalizeArgValue(m[1].trim());
}
function extractListArg(argsText, name) {
  // cmd=[...] 形式：抽整个 list 字面量（去除 [ ] 后保留原文本）
  const re = new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*\\[([^\\]]*)\\]`, 'm');
  const m = re.exec(argsText);
  if (!m) return null;
  return m[1].trim();
}
function extractBareStr(argsText, idx) {
  const parts = splitCallArgs(argsText);
  if (idx >= parts.length) return null;
  const v = parts[idx].trim();
  return normalizeArgValue(v);
}
function normalizeArgValue(v) {
  if (!v) return v;
  if (/^['"][^'"]*['"]$/.test(v)) return v.replace(/^['"]|['"]$/g, '');
  return v;
}

// ---------- v0.40.0 argparse / Click / Typer CLI 参数抽取 ----------
// 模式：parser = argparse.ArgumentParser(...) 后接 N 行 parser.add_argument(...)。
// 同一 parser 变量上多次 add_argument 复用同一组；Click @click.command 已在 v0.35+ 的
// pythonRoutes 路径处理（kind: cli）。
// 抽取的每个参数：{ flag, name, dest, type, required, default, action, help, line }
// 字符串内已通过 clean 通道剥离（不会误判 f-string 里的伪参数）。
function extractCliParams(clean, lineStarts) {
  const out = [];
  const lineOf = (pos) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  // argparse：匹配 "<var>.add_argument(...)"
  const re = /([A-Za-z_][\w]*)\.add_argument\s*\(/g;
  let m;
  while ((m = re.exec(clean))) {
    const open = m.index + m[0].length - 1;
    const close = findMatchingParen(clean, open);
    if (close < 0) continue;
    const argsText = clean.slice(open + 1, close);
    const args = splitCallArgs(argsText);
    if (args.length === 0) continue;
    const flagRaw = args[0].trim().replace(/^['"]|['"]$/g, '');
    if (!flagRaw) continue;
    // flag 形式：'-ip' / '--ip' / 'ip'（位置参数） / '-ip, --ip-address'（长写+短写）
    const flagParts = flagRaw.split(',').map((s) => s.trim()).filter(Boolean);
    const short = flagParts.find((p) => p.startsWith('-') && !p.startsWith('--')) ?? null;
    const long = flagParts.find((p) => p.startsWith('--')) ?? flagParts[flagParts.length - 1];
    const positional = !flagRaw.startsWith('-');
    // name 解析：优先 dest（kebab→snake 形式），否则取长写去前缀，否则取短写去前缀，否则位置参数名
    const stripDash = (s) => s ? s.replace(/^-+/, '').replace(/-/g, '_') : null;
    const name = positional ? flagRaw
      : (long ? stripDash(long)
      : (short ? stripDash(short) : null));
    if (!name) continue;
    // kwargs 抽取
    const dest = extractKwarg(argsText, 'dest');
    const typeRaw = extractKwarg(argsText, 'type');
    const required = /^True$/i.test(extractKwarg(argsText, 'required') ?? 'False');
    const defaultVal = extractKwarg(argsText, 'default');
    const action = extractKwarg(argsText, 'action');
    const help = extractKwarg(argsText, 'help');
    out.push({
      flag: flagRaw,
      short: short ? short.replace(/^-+/, '') : null,
      long: long ? long.replace(/^-+/, '') : null,
      name: dest ?? name,
      positional,
      type: typeRaw,
      required,
      default: defaultVal,
      action,
      help,
      line: lineOf(m.index),
    });
  }
  // Click：@click.command 类已在 v0.35+ 的 pythonRoutes 路径（@app.command / @click.command）
  // 这里不再重复抽取。
  return out;
}

// ---------- v0.40.0 HTTP 客户端调用抽取（requests / urllib / httpx / aiohttp） ----------
// 把 requests.get/post/patch/put/delete('URL', ...) 抽到 NetworkEndpoint 候选。
// URL 形式支持：'https://example.com/x' / "..." / f-string 变量插值（占位符原样保留）
// 跨行续行：用 findMatchingParen 拿整个调用。
function extractHttpClientCalls(clean, lineStarts) {
  const out = [];
  const lineOf = (pos) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  const pats = [
    { lib: 'requests', re: /\brequests\.(get|post|put|patch|delete|head|options|request)\s*\(/g },
    { lib: 'urllib',  re: /\burllib\.request\.(urlopen|Request)\s*\(/g },
    { lib: 'httpx',   re: /\bhttpx\.(get|post|put|patch|delete|head|options|request)\s*\(/g },
    { lib: 'aiohttp', re: /\b(?:self\.)?(?:session|client|Session|ClientSession)\.(get|post|put|patch|delete|head|options|request)\s*\(/g },
  ];
  for (const pat of pats) {
    pat.re.lastIndex = 0;
    let m;
    const seen = new Set(); // 去重：同一 (lib, method, url) 只记首次
    while ((m = pat.re.exec(clean))) {
      const methodRaw = m[1];
      const method = methodRaw === 'request' || methodRaw === 'urlopen' || methodRaw === 'Request' ? 'MIXED' : methodRaw.toUpperCase();
      const open = m.index + m[0].length - 1;
      const close = findMatchingParen(clean, open);
      if (close < 0) continue;
      const argsText = clean.slice(open + 1, close);
      const args = splitCallArgs(argsText);
      if (args.length === 0) continue;
      // url 可能是字面量或 f-string / 变量；保留原文本
      const urlRaw = args[0].trim();
      // v0.41.0 修复：`"https://%s/x" % idrac_ip` 一类格式化表达式，只取首个字符串字面量。
      // v0.40.0 用 replace 去首尾引号，会把 `" % idrac_ip` 一并留在 url 里（iDRAC 大量此模式）。
      // 前缀 [a-zA-Z]* 兼容 f"" / rf"" / b"" 字面量。
      const firstStr = /^[a-zA-Z]*(['"])((?:(?!\1).)*)\1/.exec(urlRaw);
      const url = firstStr ? firstStr[2] : urlRaw.replace(/^['"]|['"]$/g, '');
      const key = `${pat.lib}|${method}|${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        lib: pat.lib,
        method,
        url,
        urlRaw,
        hasAuth: /\bauth\s*=/.test(argsText),
        hasJson: /\bjson\s*=/.test(argsText),
        hasData: /\bdata\s*=/.test(argsText),
        line: lineOf(m.index),
      });
    }
  }
  return out;
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
    // v0.39.0 ROS 2 维度
    pythonLaunch: null,           // 仅 .launch.py 且含 generate_launch_description() 时非 null
    ros2NodeClasses: [],          // [{ name, line, baseClass, rosHint, channels, pos }] — 顶层 ROS 2 Node 子类索引
    // v0.40.0 通用 CLI 脚本能力
    pythonCliParams: [],          // argparse / Click / Typer CLI 参数（file-level，与 Bash/PS 的 cliParams 同构）
    httpClientCalls: [],          // requests.get/post/patch/put/delete + urllib / httpx / aiohttp 调用抽到 NetworkEndpoint
    crossLangKey: null,           // 跨语言脚本匹配键：文件基名（无 .py 后缀，与 PowerShell 函数 Noun 对齐）
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
  // v0.40.0 argparse / Click / Typer CLI 参数（与 Bash/PS 的 cliParams 同构）
  facts.pythonCliParams = extractCliParams(clean, lineStarts);
  // v0.40.0 HTTP 客户端调用（requests/urllib/httpx/aiohttp）→ NetworkEndpoint 候选
  facts.httpClientCalls = extractHttpClientCalls(clean, lineStarts);

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
      // v0.39.0 顶层 def main() → 标记为 main 入口（即便没有 if __name__ == '__main__' 守卫）
      if (frame.name === 'main' && frame.decoratorLines.length === 0) {
        const sig = (frame.head || '').trim();
        if (/^def\s+main\s*\(\s*\)/.test(sig)) {
          // 已存在 __main__ 入口时不重复（避免 __main__ 守卫 + def main 重复计数）
          const hasMainGuard = facts.pythonEntryPoints.some((e) => e.kind === '__main__');
          if (!hasMainGuard) facts.pythonEntryPoints.push({ kind: 'main', handler: frame.name, line: fn.line });
        }
      }
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
      // v0.39.0 ROS 2 节点检测
      const rosHint = detectRos2NodeHint(frame.bases ?? []);
      if (rosHint) {
        ormHints.push(rosHint);
        // 节点名：super().__init__('name') → 抽第一个字符串字面量
        const initM = /super\s*\(\s*\)\s*\.\s*__init__\s*\(\s*['"]([^'"]+)['"]/.exec(cleanBody)
          || /super\s*\(\s*\)\s*\.\s*__init__\s*\(\s*['"]([^'"]+)['"]/.exec(stripped.slice(frame.bodyStart, closePos));
        if (initM) ormHints.push(`ros2-node-name:${initM[1]}`);
      }
      const exported = !frame.name.startsWith('_');
      // v0.39.0 ROS 2 通信通道抽取
      const channels = rosHint ? extractRos2Channels(cleanBody, lineStarts) : null;
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
        ormHints,             // 框架基类检测（sqlalchemy-table / sqlalchemy-table-args / ros2-node / ros2-lifecycle-node / ros2-composable-node / ros2-node-name:X）
        rosHint,              // v0.39.0 ROS 2 节点 hint（独立字段，builder 易于判定）
        channels,             // v0.39.0 ROS 2 通信通道（publishers/subscribers/services/clients/timers/actions/parameters）
      };
      if (rosHint) {
        facts.ros2NodeClasses.push({
          name: frame.name,
          line: lineOf(frame.headStart),
          baseClass: frame.bases?.[0] ?? null,
          bases: frame.bases ?? [],
          rosHint,
          channels: channels ?? { publishers: [], subscribers: [], services: [], clients: [], timers: [], actions: [], parameters: [] },
          pos: frame.headStart,
        });
      }
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

  // v0.39.0 ROS 2 launch 文件检测（.launch.py）
  if (relPath.endsWith('.launch.py')) {
    const launch = extractLaunch(clean, lineStarts);
    if (launch.isLaunch) {
      facts.pythonLaunch = launch;
      // 入口函数也加入 entryPoints（与 if __name__ 平级）
      facts.pythonEntryPoints.push({ kind: 'launch', handler: launch.entry, line: 0 });
    }
  }

  // v0.40.0 跨语言脚本匹配键：取文件基名（去 .py 后缀） + 归一化 PS Verb 前缀
  // iDRAC 命名规律：Python `GetIdracLifecycleLogsREDFISH.py` ↔ PowerShell `Get-IdracLifecycleLogsREDFISH`
  // —— Python 文件名以 "Get" / "Set" / "Invoke" / "New" / "Remove" / "Reset" 等 PS Verb 开头
  // 归一化时把前缀去掉，让其与 PowerShell Noun（`IdracLifecycleLogsREDFISH`）匹配
  const PS_VERB_PREFIXES = /^(Get|Set|Invoke|New|Remove|Reset|Add|Update|Delete|Enable|Disable|Test|Start|Stop|Restart|Mount|Dismount|Push|Pop|Register|Unregister|Show|Hide|Open|Close|Format|Out|Copy|Move|Rename|Convert|Import|Export|Connect|Disconnect|Read|Write|Send|Receive|Wait|Resolve|Use|Save|Backup|Restore|Sync|Unregister|Trace|Assert)\b/;
  const base = relPath.replace(/^.*\//, '').replace(/\.py$/, '');
  const norm = base ? base.replace(PS_VERB_PREFIXES, '') : null;
  facts.crossLangKey = norm || base || null;

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
