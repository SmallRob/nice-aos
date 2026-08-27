// IO 注册表：数据驱动的敏感 API 表 + 静态扫描。
// 借鉴 code-graph-rag 的 IO_SINKS 数据驱动注册表（codebase_rag/parsers/io_access/registry.py）：
//   - 核心数据结构：IOSink { callee, kind, direction, targetArg, targetKw, valueArg, danger }
//   - 双 key 注册（bare + FQN）
//   - shadow check（local var 不污染全局）
//   - 阶段 1 实现：纯数据声明，不做 AST taint propagation
//   - 阶段 2 扩展：FLOWS_TO 三 kind 边（taint walk）
//
// nice-aos 范围（v0.32.0 阶段 2.1）：
//   - 油猴 GM_* API（30 个）
//   - 浏览器 JS：fetch / localStorage / sessionStorage / document.cookie / XHR
//   - 不做 Rust/Java/PHP/Go 跨语言 taint（按 docs/adr/0004 阶段 2.1 范围限定）
//
// 与现有 nice-aos 油猴审计的关系：
//   - facts.gmApiCalls（userScriptAnalyzer）已记录 GM_* 调用点
//   - 现有 userscript 审计 SKILL.md 已覆盖 GM API 越权 / @connect / XSS
//   - 本表作为统一数据源（CLI/MCP 工具 + 审计 SKILL 消费），避免硬编码 if 链

// 危险等级
export const DANGER_LEVELS = {
  CRITICAL: 'critical',  // eval / Function / GM_setClipboard
  HIGH: 'high',          // GM_xmlhttpRequest / fetch / XHR
  MEDIUM: 'medium',      // GM_setValue / localStorage.setItem
  LOW: 'low',            // GM_info / localStorage.getItem (read)
  INFO: 'info',          // GM_log / console
};

// Resource Kind（与 code-graph-rag Resource 抽象对齐）
export const RESOURCE_KINDS = {
  STORAGE: 'STORAGE',
  NETWORK: 'NETWORK',
  DOM: 'DOM',
  STDOUT: 'STDOUT',
  SCRIPT: 'SCRIPT',
};

/**
 * @typedef {Object} IOSink
 * @property {string} callee     - 完整或简短的 API 名（用于匹配 call site 文本）
 * @property {string} kind       - ResourceKind
 * @property {string} direction  - 'READ' | 'WRITE' | 'READ_WRITE' | 'EXEC'
 * @property {number|null} targetArg - 哪个 arg 是 resource identity（0-indexed），null = N/A
 * @property {string|null} valueArg  - 哪个 arg 是 data payload（用于 WRITE）
 * @property {string} danger     - DANGER_LEVELS
 * @property {string} [desc]     - 简短描述
 */

// 油猴 GM_* API（完整 30+ 个）
const GM_SINKS = [
  // 网络类（最危险）
  { callee: 'GM_xmlhttpRequest', kind: RESOURCE_KINDS.NETWORK, direction: 'READ_WRITE', targetArg: 0, valueArg: 1, danger: DANGER_LEVELS.HIGH, desc: 'GM 跨域请求' },
  { callee: 'GM.fetch', kind: RESOURCE_KINDS.NETWORK, direction: 'READ_WRITE', targetArg: 0, danger: DANGER_LEVELS.HIGH, desc: 'GM fetch 封装' },
  // 存储类
  { callee: 'GM_setValue', kind: RESOURCE_KINDS.STORAGE, direction: 'WRITE', targetArg: 0, valueArg: 1, danger: DANGER_LEVELS.MEDIUM, desc: '写入 GM 存储' },
  { callee: 'GM_getValue', kind: RESOURCE_KINDS.STORAGE, direction: 'READ', targetArg: 0, danger: DANGER_LEVELS.LOW, desc: '读 GM 存储' },
  { callee: 'GM_listValues', kind: RESOURCE_KINDS.STORAGE, direction: 'READ', danger: DANGER_LEVELS.INFO, desc: '枚举 GM 存储' },
  { callee: 'GM_deleteValue', kind: RESOURCE_KINDS.STORAGE, direction: 'WRITE', targetArg: 0, danger: DANGER_LEVELS.MEDIUM, desc: '删除 GM 存储' },
  // DOM
  { callee: 'GM_addStyle', kind: RESOURCE_KINDS.DOM, direction: 'WRITE', valueArg: 0, danger: DANGER_LEVELS.MEDIUM, desc: '注入 CSS（潜在劫持）' },
  { callee: 'GM_addElement', kind: RESOURCE_KINDS.DOM, direction: 'WRITE', danger: DANGER_LEVELS.MEDIUM, desc: '插入 DOM 元素' },
  { callee: 'GM_setClipboard', kind: RESOURCE_KINDS.DOM, direction: 'WRITE', valueArg: 0, danger: DANGER_LEVELS.CRITICAL, desc: '写剪贴板' },
  // 跨域/CSP
  { callee: 'GM_openInTab', kind: RESOURCE_KINDS.DOM, direction: 'READ_WRITE', targetArg: 0, danger: DANGER_LEVELS.LOW, desc: '开新标签' },
  { callee: 'GM_notification', kind: RESOURCE_KINDS.DOM, direction: 'WRITE', valueArg: 0, danger: DANGER_LEVELS.LOW, desc: '系统通知' },
  // 危险
  { callee: 'GM_setTimeout', kind: RESOURCE_KINDS.SCRIPT, direction: 'EXEC', valueArg: 0, danger: DANGER_LEVELS.MEDIUM, desc: '延迟执行回调' },
  { callee: 'GM_setInterval', kind: RESOURCE_KINDS.SCRIPT, direction: 'EXEC', valueArg: 0, danger: DANGER_LEVELS.MEDIUM, desc: '周期执行回调' },
  // 信息
  { callee: 'GM_info', kind: RESOURCE_KINDS.SCRIPT, direction: 'READ', danger: DANGER_LEVELS.INFO, desc: '读脚本元信息' },
  { callee: 'GM_log', kind: RESOURCE_KINDS.STDOUT, direction: 'WRITE', valueArg: 0, danger: DANGER_LEVELS.INFO, desc: '脚本控制台日志' },
  { callee: 'GM_registerMenuCommand', kind: RESOURCE_KINDS.DOM, direction: 'WRITE', valueArg: 1, danger: DANGER_LEVELS.LOW, desc: '注册菜单' },
];

// 浏览器 JS 通用 API
const BROWSER_SINKS = [
  // 网络
  { callee: 'fetch', kind: RESOURCE_KINDS.NETWORK, direction: 'READ_WRITE', targetArg: 0, valueArg: 1, danger: DANGER_LEVELS.HIGH, desc: '网络请求' },
  { callee: 'XMLHttpRequest', kind: RESOURCE_KINDS.NETWORK, direction: 'READ_WRITE', danger: DANGER_LEVELS.HIGH, desc: 'XHR（已弃用但仍可用）' },
  // 存储
  { callee: 'localStorage.setItem', kind: RESOURCE_KINDS.STORAGE, direction: 'WRITE', targetArg: 0, valueArg: 1, danger: DANGER_LEVELS.MEDIUM, desc: 'localStorage 写' },
  { callee: 'localStorage.getItem', kind: RESOURCE_KINDS.STORAGE, direction: 'READ', targetArg: 0, danger: DANGER_LEVELS.LOW, desc: 'localStorage 读' },
  { callee: 'localStorage.removeItem', kind: RESOURCE_KINDS.STORAGE, direction: 'WRITE', targetArg: 0, danger: DANGER_LEVELS.MEDIUM, desc: 'localStorage 删除' },
  { callee: 'sessionStorage.setItem', kind: RESOURCE_KINDS.STORAGE, direction: 'WRITE', targetArg: 0, valueArg: 1, danger: DANGER_LEVELS.MEDIUM, desc: 'sessionStorage 写' },
  { callee: 'sessionStorage.getItem', kind: RESOURCE_KINDS.STORAGE, direction: 'READ', targetArg: 0, danger: DANGER_LEVELS.LOW, desc: 'sessionStorage 读' },
  // DOM
  { callee: 'document.cookie', kind: RESOURCE_KINDS.STORAGE, direction: 'READ_WRITE', danger: DANGER_LEVELS.MEDIUM, desc: '读写 cookie（任意子域）' },
  { callee: 'eval', kind: RESOURCE_KINDS.SCRIPT, direction: 'EXEC', valueArg: 0, danger: DANGER_LEVELS.CRITICAL, desc: '执行任意 JS（XSS 风险）' },
  { callee: 'Function', kind: RESOURCE_KINDS.SCRIPT, direction: 'EXEC', valueArg: 0, danger: DANGER_LEVELS.CRITICAL, desc: 'new Function 动态构造' },
  { callee: 'setTimeout', kind: RESOURCE_KINDS.SCRIPT, direction: 'EXEC', valueArg: 0, danger: DANGER_LEVELS.MEDIUM, desc: '字符串 setTimeout' },
  { callee: 'setInterval', kind: RESOURCE_KINDS.SCRIPT, direction: 'EXEC', valueArg: 0, danger: DANGER_LEVELS.MEDIUM, desc: '字符串 setInterval' },
  { callee: 'innerHTML', kind: RESOURCE_KINDS.DOM, direction: 'WRITE', danger: DANGER_LEVELS.HIGH, desc: 'innerHTML 赋值（XSS 风险）' },
  { callee: 'outerHTML', kind: RESOURCE_KINDS.DOM, direction: 'WRITE', danger: DANGER_LEVELS.HIGH, desc: 'outerHTML 赋值' },
];

/** 合并所有 sink 表 */
export const IO_SINKS = [
  ...GM_SINKS,
  ...BROWSER_SINKS,
];

/** 索引：callee → sink（用于快速查找） */
const SINK_BY_CALLEE = new Map();
for (const s of IO_SINKS) {
  SINK_BY_CALLEE.set(s.callee, s);
}

/**
 * 查 sink 详情。
 * @param {string} callee
 * @returns {IOSink|null}
 */
export function getSink(callee) {
  return SINK_BY_CALLEE.get(callee) ?? null;
}

/**
 * 字符串字面量与注释打码：把 '...' / "..." / `...` 的内容与 // /* *\/ 注释替换为等长空白
 * （保留换行，保证打码后索引与原文一致），防止注册表 callee 名出现在字符串常量、
 * 代码生成模板或文档注释中时被误判为真实调用。
 * 模板字面量的 ${...} 插值段保留为代码（内部调用仍是真实运行时行为）。
 *
 * @param {string} source 原始源码
 * @returns {string} 等长打码文本
 */
export function maskStringsAndComments(source) {
  const out = source.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  const n = source.length;
  // tpl = 模板插值表达式作用域（'}' 结束）；brace = 普通花括号块
  const scopeStack = [];
  let i = 0;
  while (i < n) {
    const c = source[i];
    // 行注释
    if (c === '/' && source[i + 1] === '/') {
      let j = i;
      while (j < n && source[j] !== '\n') j++;
      blank(i, j); i = j; continue;
    }
    // 块注释
    if (c === '/' && source[i + 1] === '*') {
      const j = source.indexOf('*/', i + 2);
      const end = j < 0 ? n : j + 2;
      blank(i, end); i = end; continue;
    }
    // 单引号 / 双引号字符串：整体打码
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === c) { j++; break; }
        j++;
      }
      blank(i, j); i = j; continue;
    }
    // 模板字面量：内容打码，${...} 插值段保留为代码
    if (c === '`') {
      blank(i, i + 1); i++;
      while (i < n) {
        if (source[i] === '\\') { blank(i, Math.min(n, i + 2)); i += 2; continue; }
        if (source[i] === '`') { blank(i, i + 1); i++; break; }
        if (source[i] === '$' && source[i + 1] === '{') { blank(i, i + 1); i += 2; scopeStack.push('tpl'); continue; }
        out[i] = source[i] === '\n' ? '\n' : ' '; i++;
      }
      continue;
    }
    // 模板插值作用域内的花括号配对：'}' 弹出 tpl，其余 '{'/'}' 按普通块处理
    if (scopeStack.length > 0) {
      if (c === '{') { scopeStack.push('brace'); i++; continue; }
      if (c === '}') { scopeStack.pop(); i++; continue; }
    } else if (c === '{' || c === '}') {
      i++; continue;
    }
    // 正则字面量含引号时可能破坏后续配对——按普通字符略过（宁漏报不误报的保守方向）
    i++;
  }
  return out.join('');
}

/**
 * 静态扫描：在 source 文本中找所有 sink call sites。
 * 借鉴 code-graph-rag 的"shadow check"——但简化版只做文本匹配。
 * 匹配在「打码后」的文本上执行：字符串字面量与注释中的 callee 名不再误报；
 * callText/argsText 回取自原文对应位置，保持展示保真。
 *
 * @param {string} source 函数体源码
 * @param {string[]} [declaredLocals=[]] 函数内 local 变量名（用来 shadow check；简化为只看 var/let/const）
 * @returns {Array<{ sink: IOSink, callText: string, line: number }>}
 */
export function scanSource(source, declaredLocals = []) {
  if (!source) return [];
  const hits = [];

  const masked = maskStringsAndComments(source);
  // 找所有 <callee>( 的位置
  // callee 转义（特殊字符 . 等）
  for (const sink of IO_SINKS) {
    const escaped = sink.callee.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // \b 边界（避免匹配 myFetch 的 fetch）
    // 形式：callee(...) 或 callee.something(...)
    const re = new RegExp(`\\b${escaped}\\s*\\(\\s*([^)]*?)\\)`, 'gm');
    let m;
    while ((m = re.exec(masked))) {
      // shadow check：如果 callee 的最后一段是 local var 声明的，跳过
      const short = sink.callee.split('.').pop();
      if (declaredLocals.includes(short) && !sink.callee.includes('.')) {
        continue;
      }
      // 打码为等长替换 → masked 索引即原文索引，回取原始文本保持展示保真
      const origCallText = source.slice(m.index, m.index + m[0].length);
      const openParen = origCallText.indexOf('(');
      const closeParen = origCallText.lastIndexOf(')');
      const argsText = closeParen > openParen ? origCallText.slice(openParen + 1, closeParen).trim() : '';
      // 找行号
      const before = source.slice(0, m.index);
      const line = (before.match(/\n/g) || []).length + 1;
      hits.push({
        sink,
        callText: origCallText,
        argsText,
        line,
      });
    }
  }
  return hits;
}

/**
 * 简易 local 变量提取（用于 shadow check）。
 * @param {string} source
 * @returns {string[]}
 */
export function extractDeclaredLocals(source) {
  if (!source) return [];
  const locals = new Set();
  // var/let/const <names> = ...;
  // 跳过 keyword const/let/var,然后把整段当 names 列表（处理解构 const {a,b}=...）
  const re = /(?:^|[^.\w$])(?:var|let|const)\s+([\s\S]+?)\s*(?:=[^;]+)?[;\n}]/gm;
  let m;
  while ((m = re.exec(source))) {
    // 去掉花括号/方括号/冒号/默认值
    const cleaned = m[1]
      .replace(/[{}()\[\]]/g, ' ')
      .replace(/[:=].*$/m, ' ') // 去掉类型注解和默认值
      .trim();
    if (!cleaned) continue;
    for (const part of cleaned.split(',').map((s) => s.trim()).filter(Boolean)) {
      const name = part.split(/\s/)[0];
      if (name) locals.add(name);
    }
  }
  // function name(...) declarations
  const fnRe = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = fnRe.exec(source))) locals.add(m[1]);
  return [...locals];
}

/**
 * 危险等级排序辅助。
 */
export const DANGER_RANK = {
  [DANGER_LEVELS.CRITICAL]: 4,
  [DANGER_LEVELS.HIGH]: 3,
  [DANGER_LEVELS.MEDIUM]: 2,
  [DANGER_LEVELS.LOW]: 1,
  [DANGER_LEVELS.INFO]: 0,
};
