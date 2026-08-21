// 油猴脚本（Tampermonkey UserScript）专用解析器
// 与 tsAnalyzer（React/TS）/ vueAnalyzer（Vue 3 SFC）平级共存、逻辑完全独立：
//   - 元数据块（// ==UserScript== ... // ==/UserScript==）解析：@name/@version/@match/@grant/@connect/@require/@resource...
//   - 函数使用与逻辑分布：IIFE 内顶层函数/箭头函数/类（含 constructor）/常量对象（含对象方法）、
//     函数间调用关系（直调 / this.method() / 实例变量 app.method() / new X() 入口）、业务角色推断（render/data/state/event/ui/logic）
//   - DOM 注入：innerHTML/insertAdjacentHTML/document.write（HTML 字符串面）、页面挂载点（appendChild/insertBefore）、样式注入、Shadow DOM
//   - 请求与劫持：GM_xmlhttpRequest/GM.* 跨域请求域名、fetch/XHR/WebSocket 调用、fetch/XHR/EventTarget/history 原型劫持
//   - GM API 使用：GM_* / GM.* 调用统计与 @grant 声明交叉比对、unsafeWindow 读写
//   - 观察者与生命周期：MutationObserver、setInterval/setTimeout、addEventListener、CustomEvent 事件总线
//   - 宿主框架交互推断：__vue__ → vue / __reactContainer$ 等 → react
// 输出与 tsAnalyzer 同 shape 的 facts（imports 等为空壳，供 builder 复用）+ 油猴专有事实。
// 参考脚本：steam-tampermonkey-scripts（React 页面）与 js_script/other-gm-user-js（Vue 页面）。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

let ts;
// 解析顺序：宿主项目 → 当前工作目录 → nice-aos 自身依赖（与 tsAnalyzer 同策略，但实现独立）
function getTs(projectRoot) {
  if (ts) return ts;
  for (const base of [projectRoot, process.cwd(), import.meta.url]) {
    try {
      ts = createRequire(base)('typescript');
      return ts;
    } catch { /* 尝试下一个解析路径 */ }
  }
  throw new Error('无法加载 typescript 模块（请先在 nice-aos/ 下执行 npm install）');
}

// ---------------------------------------------------------------------------
// 元数据块解析
// ---------------------------------------------------------------------------

// GM.*（GM4 风格）→ 对应的 @grant 名，供声明比对
const GM_DOT_ALIAS = {
  xmlHttpRequest: 'GM_xmlhttpRequest',
  getValue: 'GM_getValue',
  setValue: 'GM_setValue',
  deleteValue: 'GM_deleteValue',
  listValues: 'GM_listValues',
  addValueChangeListener: 'GM_addValueChangeListener',
  removeValueChangeListener: 'GM_removeValueChangeListener',
  getResourceText: 'GM_getResourceText',
  getResourceURL: 'GM_getResourceURL',
  setClipboard: 'GM_setClipboard',
  notification: 'GM_notification',
  download: 'GM_download',
  openInTab: 'GM_openInTab',
  registerMenuCommand: 'GM_registerMenuCommand',
  unregisterMenuCommand: 'GM_unregisterMenuCommand',
  log: 'GM_log',
  info: 'GM_info',
};

const GM_API_CATEGORIES = {
  GM_getValue: 'storage', GM_setValue: 'storage', GM_deleteValue: 'storage', GM_listValues: 'storage',
  GM_addValueChangeListener: 'storage', GM_removeValueChangeListener: 'storage',
  GM_xmlhttpRequest: 'network',
  GM_addStyle: 'style',
  GM_getResourceText: 'resource', GM_getResourceURL: 'resource',
  GM_registerMenuCommand: 'menu', GM_unregisterMenuCommand: 'menu',
  GM_notification: 'notification',
  GM_setClipboard: 'clipboard',
  GM_download: 'download',
  GM_openInTab: 'tab',
  GM_log: 'info', GM_info: 'info',
};

function gmApiCategory(name) {
  return GM_API_CATEGORIES[name] ?? 'other';
}

// 解析 ==UserScript== 元数据块；块必须出现在文件头部（前 8KB）
export function parseUserScriptMeta(content) {
  const head = content.slice(0, 8192);
  const start = head.indexOf('// ==UserScript==');
  if (start < 0) return null;
  const end = head.indexOf('// ==/UserScript==', start);
  if (end < 0) return null;
  const block = head.slice(start, end);

  const meta = {
    name: null, namespace: null, version: null, description: null, author: null,
    license: null, runAt: null, icon: null, downloadURL: null, updateURL: null, homepageURL: null, supportURL: null,
    noframes: false,
    matches: [], includes: [], excludes: [], grants: [], connects: [], requires: [], resources: [], tags: [],
  };
  const re = /^\s*\/\/\s*@([\w:.-]+)\s*(.*)$/gm;
  let m;
  while ((m = re.exec(block)) !== null) {
    const key = m[1];
    const value = m[2].trim();
    switch (key) {
      case 'name': meta.name = value; break;
      case 'namespace': meta.namespace = value; break;
      case 'version': meta.version = value; break;
      case 'description': meta.description = value; break;
      case 'author': meta.author = value; break;
      case 'license': meta.license = value; break;
      case 'run-at': meta.runAt = value; break;
      case 'icon': case 'defaulticon': meta.icon = meta.icon ?? value; break;
      case 'downloadURL': meta.downloadURL = value; break;
      case 'updateURL': meta.updateURL = value; break;
      case 'homepageURL': meta.homepageURL = value; break;
      case 'supportURL': meta.supportURL = value; break;
      case 'noframes': meta.noframes = true; break;
      case 'match': if (value) meta.matches.push(value); break;
      case 'include': if (value) meta.includes.push(value); break;
      case 'exclude': if (value) meta.excludes.push(value); break;
      case 'grant': if (value) meta.grants.push(value); break;
      case 'connect': if (value) meta.connects.push(value); break;
      case 'require': if (value) meta.requires.push(value); break;
      case 'resource': {
        const sp = value.indexOf(' ');
        if (sp > 0) meta.resources.push({ name: value.slice(0, sp), url: value.slice(sp + 1).trim() });
        break;
      }
      case 'tag': if (value) meta.tags.push(value); break;
      default: break;
    }
  }
  meta.grantNone = meta.grants.includes('none');
  if (meta.grantNone) meta.grants = [];
  return meta;
}

// 文件是否为油猴脚本：.user.js 扩展名（强信号），或内容头部含元数据块（如 xxx-1.3.12.js）
export function isUserScriptCandidate(absFilePath) {
  try {
    if (/\.user\.js$/.test(absFilePath)) return true;
    if (!/\.m?js$/.test(absFilePath)) return false;
    const fd = fs.openSync(absFilePath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const { bytesRead } = fs.readSync(fd, buf, 0, 4096, 0);
      return buf.toString('utf-8', 0, bytesRead).includes('==UserScript==');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// AST 分析
// ---------------------------------------------------------------------------

const MOUNT_METHODS = new Set(['appendChild', 'insertBefore', 'append', 'prepend', 'replaceChild', 'replaceWith', 'after', 'before']);
const QUERY_METHODS = new Set(['querySelector', 'querySelectorAll', 'getElementById', 'getElementsByClassName', 'getElementsByTagName']);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
const LIFECYCLE_EVENTS = new Set(['DOMContentLoaded', 'load', 'pageshow', 'pagehide', 'beforeunload', 'unload', 'popstate', 'hashchange', 'message', 'visibilitychange', 'readystatechange']);
const HOST_MARKERS = {
  vue: ['__vue__', '__vueParentComponent', '__VUE__', '$mount'],
  react: ['__reactContainer$', '__reactInternalInstance$', '__REACT_DEVTOOLS_GLOBAL_HOOK__', '_reactRootContainer', '__NEXT_DATA__'],
};

// 节点是否位于赋值左侧（unsafeWindow / cookie 写入判定）
function isAssignmentTarget(T, node) {
  let cur = node;
  let parent = cur.parent;
  while (parent) {
    if (T.isBinaryExpression(parent) && parent.operatorToken.kind === T.SyntaxKind.EqualsToken && parent.left === cur) {
      return true;
    }
    if (T.isPropertyAccessExpression(parent) || T.isElementAccessExpression(parent) || T.isParenthesizedExpression(parent)) {
      cur = parent;
      parent = parent.parent;
      continue;
    }
    return false;
  }
  return false;
}

// 从 URL 字面量/模板头提取域名
function domainOfUrlText(text) {
  if (!text) return null;
  const m = text.match(/^(?:https?:)?\/\/([^/?#\s'"`]+)/);
  if (m) return m[1];
  if (/^[a-z][\w.-]*\.[a-z]{2,}/i.test(text)) return text.split('/')[0];
  return null;
}

// 调用参数中的 URL/method 提取：GM_xmlhttpRequest({method,url,...}) / fetch(url) / xhr.open(m,url)
function extractUrlAndMethod(arg) {
  if (!arg) return { url: null, method: null, interpolated: false };
  if (ts.isStringLiteralLike(arg)) return { url: arg.text, method: null, interpolated: false };
  if (ts.isTemplateExpression(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return {
      url: ts.isTemplateExpression(arg) ? arg.head.text : arg.text,
      method: null,
      interpolated: ts.isTemplateExpression(arg),
    };
  }
  if (ts.isObjectLiteralExpression(arg)) {
    let url = null;
    let method = null;
    let interpolated = false;
    for (const prop of arg.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = prop.name?.getText();
      const init = prop.initializer;
      if (key === 'url') {
        if (ts.isStringLiteralLike(init)) url = init.text;
        else if (ts.isTemplateExpression(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
          url = ts.isTemplateExpression(init) ? init.head.text : init.text;
          interpolated = ts.isTemplateExpression(init);
        }
      } else if (key === 'method' && ts.isStringLiteralLike(init)) {
        method = init.text.toUpperCase();
      }
    }
    return { url, method, interpolated };
  }
  return { url: null, method: null, interpolated: false };
}

// HTML 赋值/插入值是否含动态内容（潜在 XSS 面：模板插值 / 拼接 / 变量来源）
function valueInterpolated(value) {
  if (!value) return false;
  if (ts.isTemplateExpression(value)) return true;
  if (ts.isBinaryExpression(value)) return true;
  if (ts.isStringLiteralLike(value)) return false;
  return true;
}

export function analyzeUserScript(filePath, content, projectRoot) {
  const T = getTs(projectRoot);
  const src = content.replace(/^\uFEFF/, '');
  const meta = parseUserScriptMeta(src);
  const sourceFile = T.createSourceFile(filePath, src, T.ScriptTarget.Latest, true, T.ScriptKind.JS);
  const lineOf = (pos) => (pos >= 0 ? sourceFile.getLineAndCharacterOfPosition(pos).line + 1 : null);

  // ---- 原始事件收集（记录 pos，函数归属事后统一回填）----
  const gmCalls = [];            // {name, pos}
  const htmlInjections = [];     // {kind, receiver, interpolated, pos}
  const mounts = [];             // {method, receiverText, pos}
  const queryDecls = [];         // {name, selector, pos}（querySelector 系变量 → 页面元素锚点）
  const creates = [];            // createElement {tag, pos}
  const shadowDoms = [];
  const networkCalls = [];       // {kind, url, domain, method, pos}
  const hijacks = [];            // {kind, target, pos}
  const functions = [];          // {name, kind, pos, end, isTopLevel, owner}
  const callSites = [];          // {callee, pos}
  const thisCalls = [];          // {method, pos}（this.method() → 归并时解析为 Owner.method）
  const newCalls = [];           // {name, pos}（new X() → 归并时解析为 X.constructor 入口边）
  const newVarDecls = [];        // {name, className}（const app = new App() → 实例变量别名）
  const observers = [];          // {kind, pos}
  const timers = [];             // {kind, delay, pos}
  const listeners = [];          // {event, targetKind, pos}
  const customEmits = [];        // {name, pos}
  const unsafeAccess = [];       // {prop, write, pos}
  const storageHits = [];        // {kind, pos}
  const evalHits = [];
  const cookieHits = [];         // {write, pos}
  const windowDefines = [];
  const hostMarkers = new Set();
  const windowExposes = [];      // {prop, pos}

  let isIife = false;
  let usesStrict = false;

  function recordGmCall(name, pos) {
    gmCalls.push({ name, pos });
    if (name === 'GM_addStyle') {
      htmlInjections.push({ kind: 'style-gm', receiver: 'GM_addStyle', interpolated: false, pos });
    }
  }

  // 记录网络调用（GM_xhr / fetch / xhr / websocket / beacon 统一入口）
  function recordNetwork(kind, extracted, pos) {
    networkCalls.push({ kind, url: extracted.url, domain: domainOfUrlText(extracted.url), method: extracted.method, interpolated: extracted.interpolated, pos });
  }

  function recordTimer(kind, node) {
    const delayArg = node.arguments[1];
    const delay = delayArg && T.isNumericLiteral(delayArg) ? Number(delayArg.text) : null;
    timers.push({ kind, delay, pos: node.getStart(sourceFile) });
  }

  // ---- 遍历（scopeDepth：0=文件顶层，1=IIFE 体内，…；isTopLevel = depth ≤ 1）----
  function visit(node, scopeDepth) {
    // IIFE 与 'use strict' 检测（文件顶层语句；'use strict' 允许出现在 IIFE 体内首句）
    if (scopeDepth <= 1 && T.isExpressionStatement(node)) {
      const expr = node.expression;
      if (T.isCallExpression(expr)) {
        const callee = expr.expression;
        const inner = T.isParenthesizedExpression(callee) ? callee.expression : callee;
        if (T.isFunctionExpression(inner) || T.isArrowFunction(inner)) {
          isIife = true;
        }
      }
      if (T.isStringLiteral(node.expression) && node.expression.text === 'use strict') {
        usesStrict = true;
      }
    }

    // ---- 赋值：劫持 / 全局暴露 / innerHTML / cookie 写 ----
    if (T.isBinaryExpression(node) && node.operatorToken.kind === T.SyntaxKind.EqualsToken) {
      const leftText = node.left.getText(sourceFile);
      let hijackKind = null;
      if (/^(?:(?:unsafeWindow|window|globalThis)\.)?fetch$/.test(leftText)) hijackKind = 'hijack-fetch';
      else if (/XMLHttpRequest\.prototype\.(open|send)/.test(leftText)) hijackKind = 'hijack-xhr';
      else if (/EventTarget\.prototype\.addEventListener/.test(leftText)) hijackKind = 'hijack-add-event-listener';
      else if (/(^|\.)WebSocket$/.test(leftText)) hijackKind = 'hijack-websocket';
      else if (/history\.(pushState|replaceState)/.test(leftText)) hijackKind = 'hijack-history';
      else if (leftText === 'document.cookie') hijackKind = 'cookie-write';
      if (hijackKind === 'cookie-write') {
        cookieHits.push({ write: true, pos: node.getStart(sourceFile) });
      } else if (hijackKind) {
        hijacks.push({ kind: hijackKind, target: leftText, pos: node.getStart(sourceFile) });
      }
      // unsafeWindow / window 全局暴露（unsafeWindow.SGLVSearch = … 模式）
      const expose = leftText.match(/^(unsafeWindow|window)\.([\w$]+)$/);
      if (expose) {
        windowExposes.push({ prop: expose[2], pos: node.getStart(sourceFile) });
        if (expose[1] === 'unsafeWindow') {
          unsafeAccess.push({ prop: expose[2], write: true, pos: node.getStart(sourceFile) });
        }
      }
      // innerHTML / outerHTML 赋值（HTML 字符串注入面）
      if (T.isPropertyAccessExpression(node.left)
        && (node.left.name.text === 'innerHTML' || node.left.name.text === 'outerHTML')) {
        htmlInjections.push({
          kind: 'inner-html',
          receiver: node.left.expression.getText(sourceFile),
          interpolated: valueInterpolated(node.right),
          pos: node.getStart(sourceFile),
        });
      }
      // 赋值形式的具名函数（state.foo = function(){}）
      if (T.isFunctionExpression(node.right) && T.isIdentifier(node.left)) {
        functions.push({ name: node.left.text, kind: 'function', pos: node.getStart(sourceFile), end: node.end, isTopLevel: false, owner: null });
      }
    }

    // ---- 属性访问：unsafeWindow / cookie 读 / storage / 宿主框架标记 ----
    if (T.isPropertyAccessExpression(node) && T.isIdentifier(node.expression)) {
      const base = node.expression.text;
      const prop = node.name.text;
      if (base === 'unsafeWindow') {
        if (!isAssignmentTarget(T, node)) unsafeAccess.push({ prop, write: false, pos: node.getStart(sourceFile) });
      } else if (base === 'localStorage' || base === 'sessionStorage' || base === 'indexedDB') {
        storageHits.push({ kind: base, pos: node.getStart(sourceFile) });
      } else if (base === 'document' && prop === 'cookie') {
        if (!isAssignmentTarget(T, node)) cookieHits.push({ write: false, pos: node.getStart(sourceFile) });
      }
      if (HOST_MARKERS.vue.includes(prop)) hostMarkers.add(`vue:${prop}`);
      if (HOST_MARKERS.react.includes(prop)) hostMarkers.add(`react:${prop}`);
    }
    if (T.isIdentifier(node)) {
      if (HOST_MARKERS.vue.includes(node.text)) hostMarkers.add(`vue:${node.text}`);
      if (HOST_MARKERS.react.includes(node.text)) hostMarkers.add(`react:${node.text}`);
    }

    // ---- 变量声明：函数/类/对象 → 逻辑单元；querySelector 变量 → 页面锚点 ----
    if (T.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!T.isIdentifier(decl.name) || !decl.initializer) continue;
        const name = decl.name.text;
        const init = decl.initializer;
        const pos = node.getStart(sourceFile);
        const end = node.end;
        const topLevel = scopeDepth <= 1;
        if (T.isFunctionExpression(init)) {
          functions.push({ name, kind: 'function', pos, end, isTopLevel: topLevel, owner: null });
        } else if (T.isArrowFunction(init)) {
          functions.push({ name, kind: 'arrow', pos, end, isTopLevel: topLevel, owner: null });
        } else if (T.isClassExpression(init)) {
          functions.push({ name, kind: 'class', pos, end, isTopLevel: topLevel, owner: null });
        } else if (T.isObjectLiteralExpression(init)) {
          functions.push({ name, kind: 'object', pos, end, isTopLevel: topLevel, owner: null });
          // 对象方法 / 函数值属性 → name.method 逻辑单元（storage.get / SteamAPI._req 模式）
          for (const prop of init.properties) {
            const propName = prop.name?.getText(sourceFile);
            if (!propName) continue;
            const isFn = T.isMethodDeclaration(prop)
              || (T.isPropertyAssignment(prop)
                && (T.isArrowFunction(prop.initializer) || T.isFunctionExpression(prop.initializer)));
            if (isFn) {
              functions.push({ name: `${name}.${propName}`, kind: 'method', pos: prop.getStart(sourceFile), end: prop.end, isTopLevel: false, owner: name });
            }
          }
        } else if (T.isNewExpression(init) && T.isIdentifier(init.expression)) {
          // const app = new App() → 记录实例变量别名（app.method() 归并时解析为 App.method）
          newVarDecls.push({ name, className: init.expression.text });
        } else if (T.isCallExpression(init) && T.isPropertyAccessExpression(init.expression)
          && T.isIdentifier(init.expression.expression) && init.expression.expression.text === 'document'
          && QUERY_METHODS.has(init.expression.name.text)) {
          const selArg = init.arguments[0];
          const selector = selArg && T.isStringLiteralLike(selArg) ? selArg.text : '(dynamic)';
          queryDecls.push({ name, selector: `${init.expression.name.text}('${selector}')`, pos });
        }
      }
      T.forEachChild(node, (c) => visit(c, scopeDepth));
      return;
    }

    if (T.isFunctionDeclaration(node) && node.name) {
      functions.push({ name: node.name.text, kind: 'function', pos: node.getStart(sourceFile), end: node.end, isTopLevel: scopeDepth <= 1, owner: null });
      T.forEachChild(node, (c) => visit(c, scopeDepth + 1));
      return;
    }

    if (T.isClassDeclaration(node) && node.name) {
      functions.push({ name: node.name.text, kind: 'class', pos: node.getStart(sourceFile), end: node.end, isTopLevel: scopeDepth <= 1, owner: null });
      for (const member of node.members) {
        if (T.isMethodDeclaration(member) && member.name) {
          functions.push({
            name: `${node.name.text}.${member.name.getText(sourceFile)}`,
            kind: 'method',
            pos: member.getStart(sourceFile),
            end: member.end,
            isTopLevel: false,
            owner: node.name.text,
          });
        } else if (T.isConstructorDeclaration(member)) {
          // constructor 收集为类入口（new X() 的调用目标，this.method() 链的起点）
          functions.push({
            name: `${node.name.text}.constructor`,
            kind: 'method',
            pos: member.getStart(sourceFile),
            end: member.end,
            isTopLevel: false,
            owner: node.name.text,
          });
        }
      }
      T.forEachChild(node, (c) => visit(c, scopeDepth + 1));
      return;
    }

    // ---- 调用表达式：GM API / 网络 / DOM / 观察者 / 监听 / 定时器 ----
    if (T.isCallExpression(node)) {
      const pos = node.getStart(sourceFile);
      const callee = node.expression;

      if (T.isIdentifier(callee)) {
        const name = callee.text;
        if (/^GM_/.test(name)) {
          recordGmCall(name, pos);
          if (name === 'GM_xmlhttpRequest') recordNetwork('gm-xhr', extractUrlAndMethod(node.arguments[0]), pos);
        } else if (name === 'fetch') {
          recordNetwork('fetch', extractUrlAndMethod(node.arguments[0]), pos);
        } else if (name === 'setInterval') {
          recordTimer('interval', node);
        } else if (name === 'setTimeout') {
          recordTimer('timeout', node);
        } else if (name === 'requestAnimationFrame') {
          timers.push({ kind: 'raf', delay: null, pos });
        } else if (name === 'eval') {
          evalHits.push({ pos });
        } else if (name === 'open' && node.arguments.length >= 2) {
          // xhr.open('GET', url)（首参为 HTTP 方法字面量才算，排除 window.open / db.open）
          const m0 = node.arguments[0];
          if (T.isStringLiteralLike(m0) && HTTP_METHODS.has(m0.text.toUpperCase())) {
            const extracted = extractUrlAndMethod(node.arguments[1]);
            extracted.method = m0.text.toUpperCase();
            recordNetwork('xhr', extracted, pos);
          }
        } else {
          callSites.push({ callee: name, pos });
        }
      } else if (T.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        const receiver = callee.expression;
        const receiverText = receiver.getText(sourceFile);

        if (T.isIdentifier(receiver) && receiver.text === 'GM') {
          const gmName = GM_DOT_ALIAS[method] ?? `GM_${method}`;
          recordGmCall(gmName, pos);
          if (gmName === 'GM_xmlhttpRequest') recordNetwork('gm-xhr', extractUrlAndMethod(node.arguments[0]), pos);
        } else if (method === 'addEventListener' && node.arguments.length >= 1) {
          const evtArg = node.arguments[0];
          if (T.isStringLiteralLike(evtArg)) {
            const targetKind = /^(document|window)\b/.test(receiverText)
              ? receiverText.split('.')[0]
              : 'element';
            listeners.push({ event: evtArg.text, targetKind, pos });
          }
        } else if (method === 'dispatchEvent' && node.arguments.length >= 1) {
          const arg = node.arguments[0];
          if (T.isNewExpression(arg) && T.isIdentifier(arg.expression)
            && (arg.expression.text === 'CustomEvent' || arg.expression.text === 'Event')
            && arg.arguments?.[0] && T.isStringLiteralLike(arg.arguments[0])) {
            customEmits.push({ name: arg.arguments[0].text, pos });
          }
        } else if (method === 'insertAdjacentHTML') {
          htmlInjections.push({ kind: 'insert-adjacent', receiver: receiverText, interpolated: valueInterpolated(node.arguments[1]), pos });
        } else if (method === 'createElement' && receiverText === 'document') {
          const tagArg = node.arguments[0];
          creates.push({ tag: tagArg && T.isStringLiteralLike(tagArg) ? tagArg.text : '(dynamic)', pos });
        } else if (method === 'write' && receiverText === 'document') {
          htmlInjections.push({ kind: 'document-write', receiver: 'document', interpolated: valueInterpolated(node.arguments[0]), pos });
        } else if (method === 'attachShadow') {
          shadowDoms.push({ pos });
        } else if (method === 'sendBeacon' && receiverText.includes('navigator')) {
          recordNetwork('beacon', extractUrlAndMethod(node.arguments[0]), pos);
        } else if (method === 'fetch' && /^(window|self|globalThis)$/.test(receiverText)) {
          recordNetwork('fetch', extractUrlAndMethod(node.arguments[0]), pos);
        } else if ((method === 'setInterval' || method === 'setTimeout') && /^(window|self|globalThis)$/.test(receiverText)) {
          recordTimer(method === 'setInterval' ? 'interval' : 'timeout', node);
        } else if (method === 'open' && node.arguments.length >= 2) {
          // xhr.open('GET', url)（属性访问形式；首参为 HTTP 方法字面量才算）
          const m0 = node.arguments[0];
          if (T.isStringLiteralLike(m0) && HTTP_METHODS.has(m0.text.toUpperCase())) {
            const extracted = extractUrlAndMethod(node.arguments[1]);
            extracted.method = m0.text.toUpperCase();
            recordNetwork('xhr', extracted, pos);
          }
        } else if (method === 'defineProperty' && T.isIdentifier(receiver) && receiver.text === 'Object'
          && node.arguments.length >= 2 && /^(unsafeWindow|window|globalThis)$/.test(node.arguments[0].getText(sourceFile))) {
          const propArg = node.arguments[1];
          windowDefines.push({ prop: propArg && T.isStringLiteralLike(propArg) ? propArg.text : '(dynamic)', pos });
        } else if (method === 'removeChild' || method === 'remove') {
          // 元素移除不作为注入点，跳过
        } else if (MOUNT_METHODS.has(method)) {
          mounts.push({ method, receiverText, pos });
        } else if (receiver.kind === T.SyntaxKind.ThisKeyword) {
          // this.method()：类/对象方法内互调，归并时按外层函数 owner 解析为 Owner.method
          thisCalls.push({ method, pos });
        } else if (T.isIdentifier(receiver)) {
          callSites.push({ callee: `${receiver.text}.${method}`, pos });
        }
      } else if (T.isElementAccessExpression(callee)) {
        // obj['method']() 形式（记入调用图）
        const obj = callee.expression;
        const keyArg = callee.argumentExpression;
        if (T.isIdentifier(obj) && keyArg && T.isStringLiteralLike(keyArg)) {
          callSites.push({ callee: `${obj.text}.${keyArg.text}`, pos });
        }
      }
    }

    // ---- new 表达式：MutationObserver / WebSocket / Function ----
    if (T.isNewExpression(node) && T.isIdentifier(node.expression)) {
      const pos = node.getStart(sourceFile);
      const name = node.expression.text;
      if (name === 'MutationObserver') observers.push({ kind: 'mutation', pos });
      else if (name === 'ResizeObserver') observers.push({ kind: 'resize', pos });
      else if (name === 'IntersectionObserver') observers.push({ kind: 'intersection', pos });
      else if (name === 'WebSocket') recordNetwork('websocket', extractUrlAndMethod(node.arguments?.[0]), pos);
      else if (name === 'Function') evalHits.push({ pos });
      newCalls.push({ name, pos });
    }

    // ---- 子节点递归（进入函数体时 depth+1）----
    const enterBody = T.isFunctionDeclaration(node) || T.isFunctionExpression(node)
      || T.isArrowFunction(node) || T.isMethodDeclaration(node)
      || T.isConstructorDeclaration(node) || T.isGetAccessorDeclaration(node)
      || T.isSetAccessorDeclaration(node);
    T.forEachChild(node, (c) => visit(c, enterBody ? scopeDepth + 1 : scopeDepth));
  }
  visit(sourceFile, 0);

  // ---------------------------------------------------------------------------
  // 事后归并
  // ---------------------------------------------------------------------------

  // 函数归属：pos → 内层包含函数
  const sortedFns = [...functions].sort((a, b) => a.pos - b.pos);
  function enclosingFunction(pos) {
    let best = null;
    for (const f of sortedFns) {
      if (f.pos > pos) break;
      if (pos < f.end && (!best || f.pos >= best.pos)) best = f;
    }
    return best;
  }

  // 挂载点解析：document.* 直挂 / querySelector 变量锚点（含 .parentNode 链；同名变量取全文最后声明，启发式）
  const queryMap = new Map(queryDecls.map((q) => [q.name, q]));
  // HTML 注入目标锚点还原：innerHTML/insertAdjacentHTML 的 receiver 若为 querySelector 变量 → 页面选择器；
  // 其余保留 receiver 原文（局部 createElement 元素仍有语义）
  const resolveAnchor = (rt) => {
    if (!rt) return '(global)';
    if (/^(window\.)?document\b/.test(rt)) return rt;
    return queryMap.get(rt)?.selector ?? rt;
  };
  const mountRecords = [];
  for (const m of mounts) {
    const rt = m.receiverText;
    let target = null;
    if (/^(window\.)?document\b/.test(rt)) {
      target = rt;
    } else if (/\.parent(Element|Node)$/.test(rt)) {
      const base = rt.replace(/\.parent(Element|Node)$/, '');
      const q = queryMap.get(base);
      if (q) target = `${q.selector}.parentNode`;
    } else {
      const q = queryMap.get(rt);
      if (q) target = q.selector;
    }
    if (target) mountRecords.push({ method: m.method, target, pos: m.pos });
  }

  // 调用图：调用点 → 已收集函数；来源归属内层函数（无归属即 IIFE 顶层调用链）
  const fnByName = new Map();
  for (const f of functions) {
    if (!fnByName.has(f.name)) fnByName.set(f.name, f);
  }
  // this.method() → Owner.method（外层函数为类/对象方法时，解析到同 owner 的目标方法）
  for (const t of thisCalls) {
    const enc = enclosingFunction(t.pos);
    if (!enc?.owner) continue;
    const target = fnByName.get(`${enc.owner}.${t.method}`);
    if (!target || target.name === enc.name) continue;
    callSites.push({ callee: target.name, pos: t.pos });
  }
  // 实例变量别名：const app = new App() → app.method() 解析为 App.method（类风格脚本调用链）
  const aliasByVar = new Map();
  for (const v of newVarDecls) {
    if (fnByName.has(v.className)) aliasByVar.set(v.name, v.className);
  }
  // new ClassName() → ClassName.constructor 入口边（类实例化即入口调用）
  for (const n of newCalls) {
    if (fnByName.has(`${n.name}.constructor`)) callSites.push({ callee: `${n.name}.constructor`, pos: n.pos });
  }
  const callEdges = new Map(); // fromName → Map(toName → count)
  const topLevelCalls = new Map();
  for (const site of callSites) {
    let calleeName = site.callee;
    const dot = calleeName.indexOf('.');
    if (dot > 0) {
      const cls = aliasByVar.get(calleeName.slice(0, dot));
      if (cls) calleeName = cls + calleeName.slice(dot);
    }
    const target = fnByName.get(calleeName);
    if (!target) continue;
    const from = enclosingFunction(site.pos);
    if (from) {
      if (!callEdges.has(from.name)) callEdges.set(from.name, new Map());
      const edgeMap = callEdges.get(from.name);
      edgeMap.set(target.name, (edgeMap.get(target.name) ?? 0) + 1);
    } else {
      topLevelCalls.set(target.name, (topLevelCalls.get(target.name) ?? 0) + 1);
    }
  }

  // GM API 汇总 + @grant 声明比对
  const gmSummary = new Map();
  for (const c of gmCalls) {
    if (!gmSummary.has(c.name)) gmSummary.set(c.name, { callCount: 0, lines: [] });
    const s = gmSummary.get(c.name);
    s.callCount += 1;
    if (s.lines.length < 5) s.lines.push(lineOf(c.pos));
  }
  const declaredGrants = new Set(meta?.grants ?? []);
  const gmApiCalls = [...gmSummary.entries()].map(([name, s]) => ({
    name,
    category: gmApiCategory(name),
    callCount: s.callCount,
    lines: s.lines,
    declared: declaredGrants.has(name),
  }));

  // unsafeWindow 读写汇总
  const unsafeWindowReads = [...new Set(unsafeAccess.filter((a) => !a.write).map((a) => a.prop))];
  const unsafeWindowWrites = [...new Set(unsafeAccess.filter((a) => a.write).map((a) => a.prop))];

  // 事件总线：CustomEvent 派发 + 监听匹配（派发过的名字或含 ':' 命名空间特征）
  const emittedNames = new Set(customEmits.map((e) => e.name));
  const customEventsEmitted = [...emittedNames];
  const customEventsListened = [...new Set(
    listeners.filter((l) => emittedNames.has(l.event) || l.event.includes(':')).map((l) => l.event),
  )];

  // DOM 注入汇总（kind + target 聚合；fns = 执行注入的函数，逻辑注入链的数据基础）
  const injectionAgg = new Map();
  function aggInjection(kind, target, pos, interpolated, count = 1) {
    const key = `${kind}|${target}`;
    if (!injectionAgg.has(key)) {
      injectionAgg.set(key, { kind, target, callCount: 0, lines: [], interpolated: false, fnSet: new Set() });
    }
    const s = injectionAgg.get(key);
    s.callCount += count;
    if (interpolated) s.interpolated = true;
    const owner = pos >= 0 ? enclosingFunction(pos)?.name : null;
    if (owner) s.fnSet.add(owner);
    if (pos >= 0 && s.lines.length < 5) s.lines.push(lineOf(pos));
  }
  for (const h of htmlInjections) aggInjection(h.kind, resolveAnchor(h.receiver), h.pos, h.interpolated);
  for (const m of mountRecords) aggInjection('mount', m.target, m.pos, false);
  const styleElementCount = creates.filter((c) => c.tag === 'style').length;
  if (styleElementCount > 0) aggInjection('style-element', "document.createElement('style')", -1, false, styleElementCount);
  for (const s of shadowDoms) aggInjection('shadow-dom', 'attachShadow', s.pos, false);
  const domInjections = [...injectionAgg.values()].map((s) => ({
    kind: s.kind,
    target: s.target,
    callCount: s.callCount,
    lines: s.lines,
    interpolated: s.interpolated,
    fns: [...s.fnSet].slice(0, 8),
  }));

  // 网络请求汇总（kind + domain 聚合；fns = 发起请求的函数）
  const netAgg = new Map();
  for (const c of networkCalls) {
    const domain = c.domain ?? '(dynamic)';
    const key = `${c.kind}|${domain}`;
    if (!netAgg.has(key)) netAgg.set(key, { kind: c.kind, domain, urls: [], callCount: 0, lines: [], methods: new Set(), fnSet: new Set() });
    const s = netAgg.get(key);
    s.callCount += 1;
    const owner = enclosingFunction(c.pos)?.name;
    if (owner) s.fnSet.add(owner);
    if (c.url && s.urls.length < 5) s.urls.push(c.url.slice(0, 120));
    if (c.method) s.methods.add(c.method);
    if (s.lines.length < 5) s.lines.push(lineOf(c.pos));
  }
  const connects = new Set(meta?.connects ?? []);
  const networkRequests = [...netAgg.values()].map((s) => ({
    kind: s.kind,
    domain: s.domain,
    urls: s.urls,
    callCount: s.callCount,
    lines: s.lines,
    methods: [...s.methods],
    fns: [...s.fnSet].slice(0, 8),
    // @connect 白名单比对（仅 GM 跨域请求受 TM 管控；* 为全放行；(dynamic) 域名无法静态判定 → null）
    allowedByConnect: s.kind !== 'gm-xhr' ? null
      : (connects.has('*') ? true
        : (s.domain === '(dynamic)' ? null : connects.has(s.domain))),
  }));

  // 函数指标（范围内各类操作计数）+ 业务角色推断
  const STORAGE_GM = new Set(['GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues', 'GM_addValueChangeListener', 'GM_removeValueChangeListener']);
  function inferRoles(f) {
    const roles = [];
    if (f.htmlInjectionCount + f.mountCount > 0) roles.push('render');      // DOM 注入（含挂载）
    if (f.networkCallCount > 0) roles.push('data');                         // 网络请求（数据获取）
    if ((f.gmApiCalls ?? []).some((n) => STORAGE_GM.has(n)) || (f.storageOpCount ?? 0) > 0) roles.push('state'); // GM/浏览器存储（跨会话状态）
    if (f.listenerCount + f.observerCount + f.timerCount > 0) roles.push('event'); // 监听/观察/定时
    if (f.domOpCount > 0) roles.push('ui');                                 // 元素构建
    return roles.length ? roles.slice(0, 2) : ['logic'];                    // 最多双角色，纯逻辑标 logic
  }
  const fnFacts = functions.map((f) => {
    const inRange = (pos) => pos >= f.pos && pos < f.end;
    return {
      ...f,
      line: lineOf(f.pos),
      lineCount: src.slice(f.pos, f.end).split('\n').length,
      gmApiCalls: [...new Set(gmCalls.filter((c) => inRange(c.pos)).map((c) => c.name))],
      domOpCount: creates.filter((c) => inRange(c.pos)).length,
      htmlInjectionCount: htmlInjections.filter((h) => inRange(h.pos)).length,
      mountCount: mountRecords.filter((m) => inRange(m.pos)).length,
      networkCallCount: networkCalls.filter((c) => inRange(c.pos)).length,
      observerCount: observers.filter((o) => inRange(o.pos)).length,
      listenerCount: listeners.filter((l) => inRange(l.pos)).length,
      timerCount: timers.filter((t) => inRange(t.pos)).length,
      storageOpCount: storageHits.filter((s) => inRange(s.pos)).length,
      callCount: 0,
      calledByCount: 0,
    };
  });
  for (const [fromName, toMap] of callEdges) {
    const fromFn = fnFacts.find((f) => f.name === fromName);
    if (fromFn) fromFn.callCount = [...toMap.values()].reduce((a, b) => a + b, 0);
  }
  for (const f of fnFacts) {
    f.calledByCount = [...callEdges.values()].filter((toMap) => toMap.has(f.name)).length;
    f.roles = inferRoles(f);
    f.role = f.roles[0];
  }

  // 存储使用
  const storageUsage = { localStorage: 0, sessionStorage: 0, indexedDB: 0 };
  for (const s of storageHits) storageUsage[s.kind] = (storageUsage[s.kind] ?? 0) + 1;

  // 宿主框架推断
  let hostFramework = 'unknown';
  const hasVue = [...hostMarkers].some((m) => m.startsWith('vue:'));
  const hasReact = [...hostMarkers].some((m) => m.startsWith('react:'));
  if (hasVue && hasReact) hostFramework = 'mixed';
  else if (hasVue) hostFramework = 'vue';
  else if (hasReact) hostFramework = 'react';

  // 风险清单（安全审计视角：请求劫持 / 动态执行 / 沙箱突破 / XSS 面 / 权限越界）
  const risks = [];
  for (const h of hijacks) {
    risks.push({ severity: 'high', kind: h.kind, detail: `重写 ${h.target}`, line: lineOf(h.pos) });
  }
  for (const e of evalHits) {
    risks.push({ severity: 'high', kind: 'eval-usage', detail: 'eval / new Function 动态代码执行', line: lineOf(e.pos) });
  }
  if (unsafeWindowWrites.length > 0) {
    risks.push({ severity: 'medium', kind: 'unsafe-window-write', detail: `向宿主页面写入全局变量: ${unsafeWindowWrites.slice(0, 5).join(', ')}`, line: null });
  }
  if (unsafeWindowReads.length > 0) {
    risks.push({ severity: 'low', kind: 'unsafe-window-read', detail: `读取宿主页面全局变量: ${unsafeWindowReads.slice(0, 5).join(', ')}`, line: null });
  }
  const cookieReadCount = cookieHits.filter((c) => !c.write).length;
  const cookieWriteCount = cookieHits.filter((c) => c.write).length;
  if (cookieReadCount > 0) risks.push({ severity: 'medium', kind: 'cookie-read', detail: `读取 document.cookie x${cookieReadCount}`, line: null });
  if (cookieWriteCount > 0) risks.push({ severity: 'high', kind: 'cookie-write', detail: `写入 document.cookie x${cookieWriteCount}`, line: null });
  const interpolatedHtml = domInjections.filter((d) => d.interpolated
    && (d.kind === 'inner-html' || d.kind === 'insert-adjacent' || d.kind === 'document-write'));
  if (interpolatedHtml.length > 0) {
    risks.push({ severity: 'medium', kind: 'html-injection', detail: `${interpolatedHtml.length} 处 HTML 注入含动态插值（潜在 XSS 面，需确认已转义）`, line: interpolatedHtml[0].lines[0] });
  }
  for (const g of gmApiCalls) {
    if (meta?.grantNone) {
      risks.push({ severity: 'low', kind: 'gm-api-without-grant', detail: `@grant none 但调用了 ${g.name} x${g.callCount}`, line: g.lines[0] });
    } else if (meta && !g.declared) {
      risks.push({ severity: 'medium', kind: 'undeclared-gm-api', detail: `${g.name} 未在 @grant 中声明`, line: g.lines[0] });
    }
  }
  for (const n of networkRequests) {
    if (n.kind === 'gm-xhr' && n.allowedByConnect === false) {
      risks.push({ severity: 'medium', kind: 'unlisted-connect-domain', detail: `GM 请求域名 ${n.domain} 未在 @connect 声明（运行时将弹授权确认）`, line: n.lines[0] });
    }
  }
  for (const w of windowDefines) {
    risks.push({ severity: 'low', kind: 'window-define', detail: `Object.defineProperty(window, '${w.prop}')`, line: lineOf(w.pos) });
  }
  const severityOrder = { high: 3, medium: 2, low: 1 };
  const riskLevel = risks.length === 0
    ? 'none'
    : risks.reduce((max, r) => (severityOrder[r.severity] > severityOrder[max] ? r.severity : max), 'low');

  const facts = {
    // 与 tsAnalyzer / vueAnalyzer 输出同 shape（builder 复用的公共字段）
    path: filePath,
    ext: path.extname(filePath).slice(1),
    lineCount: src.split('\n').length,
    imports: [],
    exportSymbols: [],
    exportNames: [],
    jsxTags: new Set(),
    useCalls: [],
    overlayOpens: [],
    stores: [],
    lazyWrappers: [],
    components: [],
    hooks: [],
    primaryComponentName: null,
    hasSingletonClass: false,
    hasClassExport: false,
    importMap: new Map(),
    vueRoutes: [],
    vueRouteMeta: null,
    // ---- 油猴脚本专有事实 ----
    isUserScript: true,
    meta,
    isIife,
    usesStrict,
    hostFramework,
    hostMarkers: [...hostMarkers],
    gmApiCalls,
    domInjections,
    networkRequests,
    hijacks: hijacks.map((h) => ({ kind: h.kind, target: h.target, line: lineOf(h.pos) })),
    functions: fnFacts,
    callEdges: [...callEdges.entries()].map(([from, toMap]) => ({
      from,
      to: [...toMap.entries()].map(([to, count]) => ({ to, count })),
    })),
    topLevelCalls: [...topLevelCalls.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
    observers: observers.map((o) => ({ kind: o.kind, line: lineOf(o.pos) })),
    timers: timers.map((t) => ({ kind: t.kind, delay: t.delay, line: lineOf(t.pos) })),
    listeners: listeners.map((l) => ({ event: l.event, targetKind: l.targetKind, line: lineOf(l.pos) })),
    lifecycleEvents: [...new Set(listeners.filter((l) => LIFECYCLE_EVENTS.has(l.event)).map((l) => l.event))],
    customEventsEmitted,
    customEventsListened,
    unsafeWindowReads,
    unsafeWindowWrites,
    windowExposes: windowExposes.map((w) => ({ prop: w.prop, line: lineOf(w.pos) })),
    storageUsage,
    createElementCount: creates.length,
    styleElementCount,
    gmAddStyleCount: gmSummary.get('GM_addStyle')?.callCount ?? 0,
    risks,
    riskLevel,
  };
  return facts;
}

export function analyzeUserScriptFromDisk(relPath, projectRoot) {
  const content = fs.readFileSync(path.join(projectRoot, relPath), 'utf-8');
  return analyzeUserScript(relPath, content, projectRoot);
}
