// Dart 实体分析器（Flutter 客户端 lib/ 组件）：轻量语法级解析（深度状态机 + 等长噪声剥离），
// 与 tsAnalyzer / vueAnalyzer / userScriptAnalyzer / rustAnalyzer 平级共存、逻辑完全独立。
// 实体映射（对齐 TS 语义）：
//   abstract class → Interface（契约声明）；class/enum/mixin → Class（kind: class/enum/mixin，
//   extends/implements/with 关系、字段、方法）；
//   类方法 → Method（ownerKind=class）；顶层 fn → Method（ownerKind=module）；
//   import/export → imports（package:/相对路径，跨文件解析由 builder 统一做）；
//   StatelessWidget/StatefulWidget/ConsumerWidget 等 → Component（kind: page/widget）；
//   ChangeNotifier 子类与 Riverpod Provider 变量 → Store（stateKeys/actionKeys）；
//   GoRoute(path/builder) → dartRoutes（路由实体由 builder 合并）；
//   方法体内调用 → callEdges（逻辑调用链：本类方法/顶层函数/跨文件静态方法/Widget 构造）。
// 双通道设计：stripDartNoise（全剥离：字符串+注释）供块状态机使用；
// stripCommentsOnly（仅剥注释，保留字符串）供 import / GoRoute / 路由常量提取——
// Dart 的 import 路径与路由 path 是字符串字面量，全剥离会丢失内容。
// 死代码判定契约：nameReferences（全文标识符位置）+ 实体 pos/end（声明范围），
// 由 collectTypeEntities 统一消费——Dart 类型引用即使用。

import path from 'node:path';
import { computeLineStarts, lineAt, analyzeFileFromDisk } from './textUtils.js';

export function isDartCandidate(relPath) {
  return relPath.endsWith('.dart');
}

export function analyzeDartFileFromDisk(relPath, projectRoot) {
  return analyzeFileFromDisk(relPath, projectRoot, analyzeDartFile);
}

// Flutter Widget 基类（extends 命中即视为组件）
const WIDGET_BASE_CLASSES = new Set([
  'StatelessWidget', 'StatefulWidget', 'ConsumerWidget', 'ConsumerStatefulWidget',
  'HookWidget', 'HookConsumerWidget', 'StatefulHookConsumerWidget',
  'Widget', 'PreferredSizeWidget', 'StatelessHookConsumerWidget',
]);

// 方法体内调用提取时排除的控制流/语法关键字
const CALL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'return', 'throw', 'assert', 'new', 'const',
  'case', 'catch', 'finally', 'do', 'else', 'in', 'is', 'as', 'await', 'yield',
  'with', 'extends', 'implements', 'import', 'export', 'part', 'super', 'this',
  'true', 'false', 'null', 'void', 'var', 'final', 'static', 'async', 'get', 'set',
  'try', 'when', 'on',
]);

// ---------- 噪声剥离 ----------
// 全剥离：等长替换字符串/注释为空格（保留换行与偏移量不变），供块结构状态机使用
function stripDartNoise(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (i) => { if (src[i] !== '\n') out[i] = ' '; };
  let i = 0;
  while (i < n) {
    const c = src[i];
    // 行注释 //、///、//!
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i += 1; }
      continue;
    }
    // 块注释（Dart 支持嵌套）
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
    // raw 字符串 r'...' / r"..." / r'''...''' / r"""..."""
    if (c === 'r' && /['"]/.test(src[i + 1] ?? '')) {
      const q = src[i + 1];
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      const triple = src.startsWith(q + q, i);
      const close = triple ? q + q + q : q;
      if (triple) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      while (i < n) {
        if (src.startsWith(close, i)) { for (let k = 0; k < close.length; k++) out[i + k] = ' '; i += close.length; break; }
        blank(i); i += 1;
      }
      continue;
    }
    // 三引号字符串 '''...''' / """..."""
    if (c === "'" || c === '"') {
      if (src[i + 1] === c && src[i + 2] === c) {
        out[i] = ' '; out[i + 1] = ' '; out[i + 2] = ' '; i += 3;
        while (i < n) {
          if (src[i] === c && src[i + 1] === c && src[i + 2] === c) {
            out[i] = ' '; out[i + 1] = ' '; out[i + 2] = ' '; i += 3; break;
          }
          blank(i); i += 1;
        }
        continue;
      }
      // 单行字符串（含 ${} 插值——等长剥离即可，不影响外层结构识别）
      out[i] = ' '; i += 1;
      while (i < n) {
        if (src[i] === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
        if (src[i] === c) { out[i] = ' '; i += 1; break; }
        blank(i); i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

// 仅剥注释（保留字符串内容与偏移量），供 import / GoRoute / 路由常量提取
function stripCommentsOnly(src) {
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
      let depth = 1;
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') { depth += 1; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
        if (src[i] === '*' && src[i + 1] === '/') { depth -= 1; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
        blank(i); i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

// ---------- import / export / part 提取（commentsOnly 文本，字符串内容保留） ----------
function extractImports(clean) {
  const imports = [];
  const re = /^[ \t]*(import|export|part)\s+['"]([^'"]+)['"]\s*(?:deferred\s+)?(?:as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*((?:show|hide)\s+[^;]*)?;/gm;
  let m;
  while ((m = re.exec(clean))) {
    const keyword = m[1];
    const specifier = m[2];
    const alias = m[3] ?? null;
    const clause = m[4] ?? null;
    const names = [];
    if (keyword === 'part') continue; // part 文件链：不构成导入依赖
    if (alias) {
      names.push({ imported: '*', local: alias });
    } else {
      const showM = /(?:show|hide)\s+(.+)$/.exec(clause ?? '');
      if (showM) {
        for (const part of showM[1].split(',')) {
          const t = part.trim();
          if (!t) continue;
          names.push({ imported: t, local: t });
        }
      } else {
        names.push({ imported: '*', local: '*' });
      }
    }
    imports.push({
      specifier,
      isTypeOnly: false,
      isDynamic: false,
      isExport: keyword === 'export',
      names,
      pos: m.index,
    });
  }
  return imports;
}

// ---------- GoRoute 声明提取（commentsOnly 文本；平衡括号扫描，跳过字符串） ----------
function extractGoRoutes(clean) {
  const routes = [];
  const re = /GoRoute\s*\(/g;
  let m;
  while ((m = re.exec(clean))) {
    let depth = 1;
    let i = m.index + m[0].length;
    let inStr = false;
    let strCh = '';
    const start = i;
    for (; i < clean.length; i += 1) {
      const ch = clean[i];
      if (inStr) {
        if (ch === '\\') { i += 1; continue; }
        if (ch === strCh) inStr = false;
        continue;
      }
      if (ch === "'" || ch === '"') { inStr = true; strCh = ch; continue; }
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const route = parseGoRouteArgs(clean.slice(start, i));
    if (route.path || route.builderWidget) {
      route.pos = m.index;
      routes.push(route);
    }
  }
  return routes;
}

// GoRoute 参数解析：path（字符串/常量引用）、name、builder/pageBuilder 目标 Widget
function parseGoRouteArgs(argsText) {
  const route = { path: null, builderWidget: null, name: null };
  const pathM = /path\s*:\s*([^,]+?)(?=,\s*\w+\s*:|$)/.exec(argsText);
  if (pathM) {
    let p = pathM[1].trim();
    const strM = /^['"]([^'"]+)['"]$/.exec(p);
    route.path = strM ? strM[1] : p; // AppRoutes.dashboard 引用由 dartRouteConstants 回填
  }
  const nameM = /name\s*:\s*['"]([^'"]+)['"]/.exec(argsText);
  if (nameM) route.name = nameM[1];
  // builder/pageBuilder 目标 Widget：直接形式 => const XxxPage()、块形式 { return XxxPage(...) }、
  // 包装形式 => _buildSlidePage(context, state, const SettingsPage())——取 builder 体最后一个大写构造调用
  const builderBodyM = /(?:builder|pageBuilder)\s*:\s*\([^)]*\)\s*(?:=>|\{\s*return)\s*([\s\S]+)/.exec(argsText);
  if (builderBodyM) {
    const constructions = [...builderBodyM[1].matchAll(/(?<![A-Za-z0-9_.$])(?:const\s+|new\s+)?([A-Z][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/g)];
    if (constructions.length) route.builderWidget = constructions[constructions.length - 1][1];
  }
  return route;
}

// ---------- 路由常量提取（commentsOnly）：static const String x = '/path' 与顶层 const ----------
function extractRouteConstants(clean) {
  const map = new Map();
  const re = /(?:static\s+)?const\s+(?:String|var|final)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(clean))) {
    map.set(m[1], m[2]);
  }
  return map;
}

// ---------- 原生路由表提取（commentsOnly）：Map<String, WidgetBuilder> routes = {...} ----------
// 深度感知的条目扫描：仅 map 体顶层（深度 0）的 'path': 视为条目键，
// builder 体内部的字符串（如 arguments: {'tid': x}）不误判；值取最后一个大写构造调用（与 GoRoute 一致）
function extractNativeRoutes(clean) {
  const routes = [];
  const headRe = /Map\s*<\s*String\s*,\s*WidgetBuilder\s*>\s*[A-Za-z_]\w*\s*=\s*\{/g;
  let m;
  while ((m = headRe.exec(clean))) {
    // 平衡花括号扫描取 map 体
    let depth = 1;
    let i = m.index + m[0].length;
    let inStr = false;
    let strCh = '';
    for (; i < clean.length; i += 1) {
      const ch = clean[i];
      if (inStr) {
        if (ch === '\\') { i += 1; continue; }
        if (ch === strCh) inStr = false;
        continue;
      }
      if (ch === "'" || ch === '"') { inStr = true; strCh = ch; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = clean.slice(m.index + m[0].length, i);
    // 顶层条目扫描：深度 0 的字符串字面量后紧跟 ':' → 条目键（字符串整体跳过，避免吞掉后续内容）
    const entries = [];
    let j = 0;
    let eDepth = 0;
    while (j < body.length) {
      const ch = body[j];
      if (ch === "'" || ch === '"') {
        const keyStart = j;
        let k = j + 1;
        while (k < body.length && body[k] !== ch) {
          if (body[k] === '\\') k += 1;
          k += 1;
        }
        const key = body.slice(keyStart + 1, k);
        let p = k + 1;
        while (p < body.length && /\s/.test(body[p])) p += 1;
        if (eDepth === 0 && body[p] === ':') entries.push({ key, valueStart: p + 1 });
        j = k + 1;
        continue;
      }
      if (ch === '(' || ch === '{' || ch === '[') eDepth += 1;
      else if (ch === ')' || ch === '}' || ch === ']') eDepth -= 1;
      j += 1;
    }
    // 各条目值：扫描到深度 0 逗号为止，取最后一个大写构造调用
    for (const entry of entries) {
      let vDepth = 0;
      let vStr = false;
      let vStrCh = '';
      let end = body.length;
      for (let v = entry.valueStart; v < body.length; v += 1) {
        const ch = body[v];
        if (vStr) {
          if (ch === '\\') { v += 1; continue; }
          if (ch === vStrCh) vStr = false;
          continue;
        }
        if (ch === "'" || ch === '"') { vStr = true; vStrCh = ch; continue; }
        if (ch === '(' || ch === '{' || ch === '[') vDepth += 1;
        else if (ch === ')' || ch === '}' || ch === ']') vDepth -= 1;
        else if (ch === ',' && vDepth === 0) { end = v; break; }
      }
      const valueText = body.slice(entry.valueStart, end);
      const constructions = [...valueText.matchAll(/(?<![A-Za-z0-9_.$])(?:const\s+|new\s+)?([A-Z][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/g)];
      const builderWidget = constructions.length ? constructions[constructions.length - 1][1] : null;
      if (builderWidget) routes.push({ path: entry.key, name: null, builderWidget, native: true });
    }
  }
  return routes;
}

// ---------- Riverpod Provider 变量解析（顶层 final xxxProvider = XxxProvider(...)） ----------
const PROVIDER_TYPES = [
  'AsyncNotifierProvider', 'NotifierProvider', 'StateNotifierProvider',
  'ChangeNotifierProvider', 'FutureProvider', 'StreamProvider', 'StateProvider', 'Provider',
];
function parseProviderVar(head) {
  const m = new RegExp(`^(?:final|late\\s+final)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*(?:<[^>]*>)?\\s*=\\s*(${PROVIDER_TYPES.join('|')})\\b`).exec(head.trim());
  if (!m) return null;
  const notifierM = new RegExp(`${m[2]}(?:<[^>]*>)?\\s*\\.new\\s*\\(\\s*([A-Za-z_][A-Za-z0-9_]*)`).exec(head);
  return {
    name: m[1],
    providerType: m[2],
    notifierClass: notifierM ? notifierM[1] : null,
  };
}

// ---------- 头部解析辅助 ----------
function lastPathSegment(text) {
  const m = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(text);
  return m ? m[1] : null;
}
// 泛型剥离：ConsumerState<DashboardPage> → ConsumerState
function stripGenerics(text) {
  if (!text.includes('<')) return text;
  let depth = 0;
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '<') { depth += 1; continue; }
    if (ch === '>') { depth -= 1; continue; }
    if (depth === 0) out += ch;
  }
  return out.trim();
}

// 声明头分类：class / abstract class / enum / mixin / fn / getter / setter / 顶层变量
function classifyHead(head) {
  const body = head.trim();
  let m;
  if ((m = /^abstract\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(body))) {
    return { kind: 'abstract-class', name: m[1], head: body };
  }
  if ((m = /^class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(body))) {
    return { kind: 'class', name: m[1], head: body };
  }
  if ((m = /^enum\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(body))) {
    return { kind: 'enum', name: m[1], head: body };
  }
  if ((m = /^mixin\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(body))) {
    return { kind: 'mixin', name: m[1], head: body };
  }
  if ((m = /(?:^|\s)get\s+([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\()/.exec(body))) {
    return { kind: 'getter', name: m[1], head: body };
  }
  if ((m = /(?:^|\s)set\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(body))) {
    return { kind: 'setter', name: m[1], head: body };
  }
  // 方法/构造：ReturnType name( / name(（排除控制流关键字）
  if ((m = /^(?:(?:static|async|const)\s+)*(?:[\w<>,?[\]]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(body))) {
    if (!CALL_KEYWORDS.has(m[1])) return { kind: 'fn', name: m[1], head: body };
  }
  if ((m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(body)) && !CALL_KEYWORDS.has(m[1])) {
    return { kind: 'fn', name: m[1], head: body };
  }
  if (/^(?:final|const|var|late)\s+/.test(body) && !/=>/.test(body) && !/\(/.test(body)) {
    return { kind: 'var', name: null, head: body };
  }
  return { kind: 'other', name: null, head: body };
}

// 类头关系解析：extends / implements / with（含泛型剥离，仅取名字）
function parseClassRelations(head) {
  const rel = { extendsName: null, implementsNames: [], withNames: [], baseClass: null };
  const extM = /(?:^|\s)extends\s+([^\s{]+)/.exec(head);
  if (extM) rel.extendsName = lastPathSegment(stripGenerics(extM[1]));
  const implM = /(?:^|\s)implements\s+(.+?)(?:\s+with\s|$)/.exec(head);
  if (implM) {
    rel.implementsNames = implM[1].split(',').map((s) => lastPathSegment(stripGenerics(s.trim()))).filter(Boolean);
  }
  const withM = /(?:^|\s)with\s+(.+?)(?:\s+implements\s|$)/.exec(head);
  if (withM) {
    rel.withNames = withM[1].split(',').map((s) => lastPathSegment(stripGenerics(s.trim()))).filter(Boolean);
  }
  rel.baseClass = rel.extendsName;
  return rel;
}

// ---------- 方法体内调用提取（逻辑调用链） ----------
// 所有正则均带前导边界 (?<![A-Za-z0-9_.$])：避免从更长标识符/成员访问中截取伪调用
// （如 Column( → olumn(、DateTime.now( → now( 与静态调用双重匹配）。
function extractCalls(bodyText, lineStarts, commentsOnlyBody) {
  const calls = [];   // { to, kind: 'self'|'static'|'widget'|'nav', owner?, line, navPath? }
  const lineOf = (pos) => lineAt(lineStarts, pos);
  // 裸小写调用（本类方法/顶层函数）：x()，排除关键字；
  // 下划线开头但含大写（_ModuleEntry(...)）实为私有类构造 → widget
  const bareRe = /(?<![A-Za-z0-9_.$])([a-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/g;
  let m;
  while ((m = bareRe.exec(bodyText))) {
    const name = m[1];
    if (CALL_KEYWORDS.has(name)) continue;
    calls.push({ to: name, kind: /[A-Z]/.test(name) ? 'widget' : 'self', line: lineOf(m.index) });
  }
  // 显式实例调用：this.x() / super.x()
  const memberRe = /(?:this|super)\.([a-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/g;
  while ((m = memberRe.exec(bodyText))) {
    calls.push({ to: m[1], kind: 'self', line: lineOf(m.index) });
  }
  // 静态方法调用：ClassName.method()
  const staticRe = /(?<![A-Za-z0-9_.$])([A-Z][A-Za-z0-9_]*)\s*\.\s*([a-z_][A-Za-z0-9_]*)\s*\(/g;
  while ((m = staticRe.exec(bodyText))) {
    calls.push({ to: m[2], kind: 'static', owner: m[1], line: lineOf(m.index) });
  }
  // Widget/类型构造调用：WidgetName( / const WidgetName(
  const widgetRe = /(?<![A-Za-z0-9_.$])(?:const\s+|new\s+)?([A-Z][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/g;
  while ((m = widgetRe.exec(bodyText))) {
    calls.push({ to: m[1], kind: 'widget', line: lineOf(m.index) });
  }
  // GoRouter 导航调用：context.go('/path') / context.push(AppRouter.xxx)（字符串与常量引用两种参数形式；
  // 常量引用在 builder 侧用全仓库路由常量表回填，动态变量如 feature.route 查不到即忽略）
  if (commentsOnlyBody) {
    const navRe = /([A-Za-z_]\w*)\s*\.\s*(go|push|replace|pushReplacement|pop)\s*\(\s*(['"][^'"]+['"]|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\)/g;
    while ((m = navRe.exec(commentsOnlyBody))) {
      const arg = m[3];
      const navPath = arg.startsWith("'") || arg.startsWith('"') ? arg.slice(1, -1) : arg;
      calls.push({ to: m[2], kind: 'nav', owner: m[1], line: lineOf(m.index), navPath });
    }
    // pushNamed 系列：Navigator.of(context).pushNamed('/x') 与 Navigator.pushNamed(context, '/x') 两种形式；
    // 参数区取首个字符串字面量（跳过 context 位置参数），常量引用形式由 builder 常量表回填
    const namedRe = /(?<![A-Za-z0-9_$])(pushNamed|pushReplacementNamed|popAndPushNamed|restorablePushNamed)\s*\(/g;
    while ((m = namedRe.exec(commentsOnlyBody))) {
      const argText = commentsOnlyBody.slice(m.index + m[0].length, m.index + m[0].length + 160);
      const strM = /^\s*(?:[A-Za-z_]\w*\s*,\s*)?['"]([^'"]+)['"]/.exec(argText);
      if (strM) calls.push({ to: m[1], kind: 'nav', owner: 'Navigator', line: lineOf(m.index), navPath: strM[1] });
    }
  }
  return calls;
}

// ---------- ChangeNotifier Store 状态字段提取 ----------
// 私有字段 _x → stateKeys；公开方法（非生命周期/构建）→ actionKeys
function collectStoreMembers(bodyText) {
  const stateKeys = [];
  const fieldRe = /^\s*(?:final\s+|late\s+)?(?:[\w<>,?[\]]+)\s+(_[A-Za-z0-9_]+)\s*(?:=|;)/gm;
  let m;
  while ((m = fieldRe.exec(bodyText))) {
    if (!stateKeys.includes(m[1])) stateKeys.push(m[1]);
  }
  const actionKeys = [];
  const methodRe = /^\s*(?:[\w<>,?[\]]+|void|Future[\w<>,?]*)\s+([a-z][A-Za-z0-9_]*)\s*\(/gm;
  while ((m = methodRe.exec(bodyText))) {
    const name = m[1];
    if (name.startsWith('_')) continue;
    if (['build', 'initState', 'dispose', 'didChangeDependencies', 'didUpdateWidget',
      'createState', 'notifyListeners', 'addListener', 'removeListener'].includes(name)) continue;
    if (!actionKeys.includes(name)) actionKeys.push(name);
  }
  return { stateKeys, actionKeys };
}

// ---------- dartdoc 提取 ----------
function extractDartDoc(content, declPos) {
  const before = content.slice(Math.max(0, declPos - 500), declPos);
  const docs = [...before.matchAll(/\/\/\/\s*([^\n]+)/g)];
  if (!docs.length) return null;
  const text = docs.map((d) => d[1].trim()).filter(Boolean).join(' ').slice(0, 160);
  return text || null;
}

// ---------- snake_case 文件名 → PascalCase（primaryComponentName 启发式） ----------
function snakeToPascal(stem) {
  return stem.split('_').filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1)).join('');
}

// ---------- 主解析 ----------
export function analyzeDartFile(relPath, content) {
  const lineStarts = computeLineStarts(content);
  const stripped = stripDartNoise(content);
  const clean = stripCommentsOnly(content);
  const lineOf = (pos) => lineAt(lineStarts, pos);

  const facts = {
    ext: '.dart',
    lineCount: lineStarts.length,
    isUserScript: false,
    isDart: true,
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
    widgetTags: new Set(),
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
    dartRoutes: [],
    dartProviderVars: [],
    dartRouteConstants: new Map(),
    exportAllSpecifiers: [],
    topFnNames: [],
  };

  // nameReferences：全文标识符出现位置（Dart 类型/方法引用即使用）
  for (const m of stripped.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const arr = facts.nameReferences.get(m[1]);
    if (arr) arr.push(m.index);
    else facts.nameReferences.set(m[1], [m.index]);
  }

  // import/export（commentsOnly 通道：字符串内容保留）
  for (const imp of extractImports(clean)) {
    facts.imports.push(imp);
    for (const n of imp.names) {
      if (n.local && n.local !== '*') facts.importMap.set(n.local, imp.specifier);
    }
    if (imp.isExport && imp.names.length === 1 && imp.names[0].imported === '*') {
      facts.exportAllSpecifiers.push(imp.specifier);
    }
  }

  // GoRoute、原生路由表与路由常量（commentsOnly 通道）
  facts.dartRoutes = [...extractGoRoutes(clean), ...extractNativeRoutes(clean)];
  facts.dartRouteConstants = extractRouteConstants(clean);
  // 常量回填：path: AppRoutes.dashboard → '/dashboard'
  for (const r of facts.dartRoutes) {
    if (!r.path || r.path.startsWith('/') || r.path.startsWith('http')) continue;
    const seg = lastPathSegment(r.path);
    const resolved = facts.dartRouteConstants.get(seg);
    if (resolved) r.path = resolved;
  }

  const interfaces = facts.interfaces;
  const classes = facts.classes;
  const blockStack = [];
  let currentHead = '';
  let headStart = 0;

  // 剥离注解行（@override / @visibleForTesting 等）：注解前缀会破坏 classifyHead 的行首匹配，
  // 使带注解的方法（如 @override Widget build(...)）被误判为匿名块而丢失
  function stripAnnotations(head) {
    return head.replace(/^\s*@\w+(?:\([^)]*\))?[ \t]*(?:\r?\n|$)/gm, '');
  }

  // 方法帧完成：归属父帧（类 → 方法；顶层 → 模块函数）；调用链提取
  const finishFnFrame = (frame, bodyStart, endPos) => {
    const parent = blockStack[blockStack.length - 1];
    // 类构造器（与类同名的无返回类型声明）不是方法：HomePage({super.key}) / HomePage(...)
    if (parent && frame.name === parent.name) return;
    const signature = frame.head.replace(/\{.*$/, '').replace(/\s+/g, ' ').trim().slice(0, 140);
    const bodyText = stripped.slice(bodyStart, endPos);
    const cleanBody = clean.slice(bodyStart, endPos);
    if (parent && ['class', 'enum', 'mixin', 'abstract-class'].includes(parent.kind)) {
      parent.methods.push({
        name: frame.name,
        line: lineOf(frame.headStart),
        isStatic: /\bstatic\b/.test(frame.head),
        isAsync: /\basync\b/.test(frame.head) || /\bFuture\b/.test(frame.head),
        // 注解行在声明 head 区间内（headStart → bodyStart），而非 head 之前；
        // 注意：\b@ 在空格（非单词）与 @（非单词）间不成立，去掉前导 \b
        isOverride: /@override\b/.test(content.slice(frame.headStart, frame.bodyStart)),
        signature,
        pos: frame.headStart,
        end: endPos + 1,
      });
      const calls = extractCalls(bodyText, lineStarts, cleanBody);
      // 导航调用 → overlayOpens（builder 合并为 Route navigatesTo 边）
      for (const c of calls) {
        if (c.kind === 'nav' && c.navPath) facts.overlayOpens.push({ target: c.navPath });
      }
      if (calls.length) {
        facts.callEdges.push({ from: `${parent.name}.${frame.name}`, to: calls });
      }
      // build 方法的 Widget 构造 → widgetTags（渲染树）
      if (frame.name === 'build') {
        for (const c of calls) {
          if (c.kind === 'widget') facts.widgetTags.add(c.to);
        }
      }
    } else if (blockStack.length === 0) {
      facts.moduleFunctions.push({
        name: frame.name,
        line: lineOf(frame.headStart),
        exported: true, // Dart 顶层函数库内可见
        isAsync: /\basync\b/.test(frame.head) || /\bFuture\b/.test(frame.head),
        signature,
        pos: frame.headStart,
        end: endPos + 1,
      });
      facts.topFnNames.push(frame.name);
      facts.exportSymbols.push({ name: frame.name, kind: 'function', line: lineOf(frame.headStart), isDefault: false, isExported: true });
      const calls = extractCalls(bodyText, lineStarts, cleanBody);
      // 顶层函数的导航调用同样进 overlayOpens（builder 合并为 Route navigatesTo 边）
      for (const c of calls) {
        if (c.kind === 'nav' && c.navPath) facts.overlayOpens.push({ target: c.navPath });
      }
      if (calls.length) facts.callEdges.push({ from: frame.name, to: calls });
    }
  };

  const finalizeBlock = (frame, bodyText, closePos) => {
    const line = lineOf(frame.headStart);
    switch (frame.kind) {
      case 'class':
      case 'enum':
      case 'mixin':
      case 'abstract-class': {
        const rel = parseClassRelations(frame.head);
        const isWidget = frame.kind === 'class' && WIDGET_BASE_CLASSES.has(rel.baseClass);
        const isStore = frame.kind === 'class' && (
          rel.baseClass === 'ChangeNotifier'
          || rel.withNames.includes('ChangeNotifier')
          || (rel.baseClass && rel.baseClass.startsWith('Notifier'))
        );
        const { stateKeys, actionKeys } = isStore ? collectStoreMembers(bodyText) : { stateKeys: [], actionKeys: [] };
        if (frame.kind === 'abstract-class') {
          interfaces.push({
            name: frame.name,
            line,
            exported: true,
            extendsNames: rel.implementsNames.length ? rel.implementsNames : (rel.extendsName ? [rel.extendsName] : []),
            methods: frame.methods,
            pos: frame.headStart,
            end: closePos + 1,
            language: 'dart',
          });
          facts.exportSymbols.push({ name: frame.name, kind: 'dart-interface', line, isDefault: false, isExported: true });
          break;
        }
        const cls = {
          name: frame.name,
          line,
          exported: true,
          isSingleton: false,
          kind: frame.kind === 'mixin' ? 'mixin' : (frame.kind === 'enum' ? 'enum' : 'class'),
          derives: [],
          fields: frame.kind === 'enum' ? [] : parseDartFields(bodyText),
          variants: frame.kind === 'enum' ? parseEnumVariants(bodyText) : [],
          implementsNames: rel.implementsNames,
          withNames: rel.withNames,
          extendsName: rel.extendsName,
          methods: frame.methods,
          pos: frame.headStart,
          end: closePos + 1,
          language: 'dart',
          isWidget,
          widgetBase: isWidget ? rel.baseClass : null,
          isStore,
        };
        classes.push(cls);
        facts.exportSymbols.push({ name: frame.name, kind: `dart-${cls.kind}`, line, isDefault: false, isExported: true });
        // Widget → Component
        if (isWidget && !frame.name.startsWith('_')) {
          const isPage = /Page$/.test(frame.name) || /Screen$/.test(frame.name);
          facts.components.push({
            name: frame.name,
            isDefault: false,
            propsCount: 0,
            hooksUsed: [],
            stateCount: stateKeys.length,
            lineCount: lineOf(closePos) - line + 1,
            // declPos 为声明行首（head 累积起点可能落在 dartdoc 注释行之前）
            description: extractDartDoc(content, frame.declPos ?? frame.headStart),
            kind: isPage ? 'page' : 'widget',
          });
        }
        // Store → Store 实体（ChangeNotifier/Notifier 继承，或 Store/Controller/ViewModel 命名惯例的类；
        // Provider 后缀常见于 enum（如 AiProvider），排除以免误报）
        if (isStore || (frame.kind === 'class' && /(Store|Controller|ViewModel)$/.test(frame.name))) {
          facts.stores.push({
            name: frame.name,
            stateKeys,
            actionKeys,
            hasPersist: /SharedPreferences|Hive|sqflite/.test(bodyText),
            storageKey: null,
            lineCount: lineOf(closePos) - line + 1,
          });
        }
        break;
      }
      case 'fn':
      case 'getter':
      case 'setter': {
        finishFnFrame(frame, frame.bodyStart, closePos);
        break;
      }
      case 'provider': {
        // Riverpod Provider 变量（lambda 体块）：记录变量
        const pv = parseProviderVar(frame.head);
        if (pv) facts.dartProviderVars.push(pv);
        break;
      }
      default:
        break;
    }
  };

  // 单分号语句处理：类内无体方法签名（abstract 方法）、顶层 Provider 单行变量
  const handleSemicolon = (head, start, semiPos) => {
    const body = stripAnnotations(head).trim();
    const parent = blockStack[blockStack.length - 1];
    if (parent && ['class', 'enum', 'mixin', 'abstract-class'].includes(parent.kind)) {
      const cls = classifyHead(body);
      if ((cls.kind === 'fn' || cls.kind === 'getter' || cls.kind === 'setter') && cls.name !== parent.name) {
        parent.methods.push({
          name: cls.name,
          line: lineOf(start),
          isStatic: /\bstatic\b/.test(body),
          isAsync: /\basync\b/.test(body),
          isOverride: false,
          signature: body.replace(/;$/, '').trim().slice(0, 140),
          pos: start,
          end: semiPos + 1,
        });
      }
      return;
    }
    if (/^(?:final|const|late\s+final)\s+/.test(body)) {
      const pv = parseProviderVar(body);
      if (pv) facts.dartProviderVars.push(pv);
    }
  };

  // 主循环（全剥离通道：块结构）
  let i = 0;
  const n = stripped.length;
  while (i < n) {
    const c = stripped[i];
    if (c === '{') {
      const head = stripAnnotations(currentHead);
      const cls = classifyHead(head);
      if (cls.kind === 'fn' || cls.kind === 'getter' || cls.kind === 'setter'
        || cls.kind === 'class' || cls.kind === 'enum' || cls.kind === 'mixin' || cls.kind === 'abstract-class') {
        blockStack.push({ ...cls, head: head.trim(), headStart, declPos: headStart + (head.length - head.trimStart().length), bodyStart: i + 1, methods: [] });
      } else if (/^(?:final|const|late)\s+[A-Za-z_]\w*\s*(?:<[^>]*>)?\s*=\s*(?:AsyncNotifierProvider|NotifierProvider|StateNotifierProvider|ChangeNotifierProvider|FutureProvider|StreamProvider|StateProvider|Provider)\b/.test(head.trim())) {
        // Provider 工厂 lambda 体
        blockStack.push({ kind: 'provider', head: head.trim(), headStart, bodyStart: i + 1, methods: [] });
      } else {
        // 匿名 lambda / 控制流块：仅维护括号配对
        blockStack.push({ kind: 'other', headStart, bodyStart: i + 1, methods: [] });
      }
      currentHead = '';
      headStart = i + 1;
      i += 1;
      continue;
    }
    if (c === '}') {
      const frame = blockStack.pop();
      if (frame) {
        const bodyText = stripped.slice(frame.bodyStart ?? frame.headStart, i);
        finalizeBlock(frame, bodyText, i);
      }
      currentHead = '';
      headStart = i + 1;
      i += 1;
      continue;
    }
    if (c === ';') {
      handleSemicolon(stripAnnotations(currentHead), headStart, i);
      currentHead = '';
      headStart = i + 1;
      i += 1;
      continue;
    }
    currentHead += c;
    i += 1;
  }

  // 主组件名：snake_case 文件名匹配的公开 Widget 优先
  const stem = path.posix.basename(relPath).replace(/\.dart$/, '');
  const pascalStem = snakeToPascal(stem);
  const publicWidgets = facts.components.filter((c) => !c.name.startsWith('_'));
  const primary = publicWidgets.find((c) => c.name === pascalStem)
    ?? publicWidgets.find((c) => c.name.endsWith('Page') || c.name.endsWith('Screen'))
    ?? publicWidgets[0]
    ?? null;
  facts.primaryComponentName = primary ? primary.name : null;
  for (const c of facts.components) c.isPrimary = c.name === facts.primaryComponentName;

  // Riverpod Provider 变量 → Store 实体（变量级状态容器，stateKeys 由 notifierClass 关联）
  for (const pv of facts.dartProviderVars) {
    if (facts.stores.some((s) => s.name === pv.name)) continue;
    facts.stores.push({
      name: pv.name,
      stateKeys: [],
      actionKeys: [],
      hasPersist: false,
      storageKey: null,
      lineCount: 0,
      providerType: pv.providerType,
      notifierClass: pv.notifierClass,
    });
  }

  facts.exportNames = facts.exportSymbols.map((s) => s.name);
  return facts;
}

// ---------- 类字段解析（Dart 类体：字段声明/构造参数 this.x） ----------
function parseDartFields(bodyText) {
  const fields = [];
  const fieldRe = /^\s*(?:final\s+|late\s+|const\s+)?(?:static\s+)?(?:[\w<>,?[\]]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;|\()/gm;
  let m;
  while ((m = fieldRe.exec(bodyText))) {
    const name = m[1];
    if (name.startsWith('_') || fields.some((f) => f.name === name)) continue;
    // 排除方法声明（带 ()）
    const lineStart = bodyText.lastIndexOf('\n', m.index) + 1;
    const decl = bodyText.slice(lineStart, m.index + m[0].length).trim();
    if (/\(/.test(decl)) continue;
    const typeM = /^(?:final\s+|late\s+|const\s+)?(?:static\s+)?([\w<>,?[\]]+)\s+/.exec(decl);
    const type = typeM ? typeM[1] : null;
    fields.push({ name, type: type ? type.replace(/\s+/g, ' ').trim() : null });
  }
  return fields;
}

// ---------- enum 变体解析 ----------
function parseEnumVariants(bodyText) {
  const variants = [];
  for (const line of bodyText.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = /^([a-zA-Z_][a-zA-Z0-9_]*)/.exec(t);
    if (m && !['enum', 'const'].includes(m[1]) && !/\s/.test(t.slice(0, m[1].length + 1))) {
      if (!variants.includes(m[1])) variants.push(m[1]);
    }
  }
  return variants;
}
