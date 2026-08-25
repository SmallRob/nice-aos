import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { analyzeMethodHealth, placeholderHealth } from './methodHealth.js';

let ts;
// 解析顺序：宿主项目 → 当前工作目录 → nice-aos 自身依赖
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

const OVERLAY_OPENER_FUNCS = new Set([
  'setActiveOverlay', 'openOverlay', 'pushOverlay', 'navigateToOverlay', 'showOverlay',
]);
const REACT_LAZY_WRAPPERS = new Set(['lazy', 'memo', 'forwardRef', 'React.memo', 'React.forwardRef']);
// vue-router 导航方法（仅当调用主体是 useRouter() 声明的变量时才计入）
const VUE_ROUTER_NAV_METHODS = new Set(['push', 'replace']);
// 路由库 JSX 组件（属性无业务传递语义，不进 props 传递链）
const ROUTING_JSX_COMPONENTS = new Set(['Link', 'Navigate', 'NavLink', 'Outlet', 'Routes', 'Route']);
// React 内部/DOM 透传属性（非业务 props，不计入传递链）
const REACT_INTERNAL_ATTRS = new Set(['key', 'ref', 'className', 'style', 'id', 'htmlFor', 'dangerouslySetInnerHTML']);
// React / 路由内置 hooks（props kind 分类时不算 store 数据源）
const BUILTIN_HOOKS = new Set([
  'useState', 'useEffect', 'useLayoutEffect', 'useInsertionEffect', 'useMemo', 'useCallback',
  'useRef', 'useReducer', 'useContext', 'useDebugValue', 'useImperativeHandle', 'useSyncExternalStore',
  'useTransition', 'useDeferredValue', 'useId', 'useOptimistic', 'useActionState', 'useFormState',
  'useFormStatus', 'use', 'useSearchParams', 'useParams', 'useLocation', 'useNavigate', 'useHref',
  'useMatch', 'useOutletContext', 'useOutlet', 'useResolvedPath', 'useInRouterContext',
  'useNavigationType', 'useFetcher', 'useFetchers', 'useRevalidator', 'useRouteError',
  'useRouteLoaderData', 'useLoaderData', 'useActionData', 'useAwaitError', 'useAsyncValue',
  'useRouter', 'usePathname', 'useSelectedLayoutSegment', 'useSelectedLayoutSegments',
  'useReportWebVitals', 'useLocale', 'useTranslations', 'useSearchParamsNext',
]);

function hasExportModifier(ts, node) {
  if (!ts.canHaveModifiers?.(node)) return false;
  const modifiers = ts.getModifiers(node);
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}
function hasModifierKind(ts, node, kind) {
  if (!ts.canHaveModifiers?.(node)) return false;
  const modifiers = ts.getModifiers(node);
  return !!modifiers?.some((m) => m.kind === kind);
}

// 方法/函数签名文本（参数列表 + 返回类型），仅用于展示，超长截断
function buildSignature(ts, node, sourceFile) {
  const params = (node.parameters ?? []).map((p) => p.getText(sourceFile)).join(', ');
  const ret = node.type ? node.type.getText(sourceFile) : null;
  let sig = `(${params})${ret ? `: ${ret}` : ''}`;
  if (sig.length > 120) sig = `${sig.slice(0, 117)}...`;
  return sig;
}
function hasDefaultModifier(ts, node) {
  if (!ts.canHaveModifiers?.(node)) return false;
  const modifiers = ts.getModifiers(node);
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

// 借鉴 asdm-aos 字节码二次扫描:把"框架调用 + 注解生成代码"虚拟化为 ext: 节点
// 适配:React hooks / DOM API / 状态管理 API 标记为外部调用(不进入 Method.calls link 结果,避免破坏旧 viewer)
// 标在 method.externalCalls[],用户用 query --where 过滤即可
const REACT_HOOKS = new Set([
  'useState', 'useEffect', 'useLayoutEffect', 'useInsertionEffect', 'useMemo', 'useCallback',
  'useRef', 'useReducer', 'useContext', 'useDebugValue', 'useImperativeHandle', 'useSyncExternalStore',
  'useTransition', 'useDeferredValue', 'useId', 'useOptimistic', 'useActionState', 'useFormState',
  'useFormStatus',
]);
const DOM_APIS = new Set([
  'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
  'localStorage', 'sessionStorage', 'document', 'window', 'navigator', 'history',
  'console', 'alert', 'confirm', 'prompt',
]);
const STATE_MGMT_APIS = new Set([
  // Zustand
  'create', 'setState', 'getState', 'subscribe',
  // Pinia / Vue Composition
  'ref', 'reactive', 'computed', 'watch', 'watchEffect', 'onMounted', 'onUnmounted', 'onUpdated', 'onBeforeMount',
]);

/**
 * 识别函数体内的"外部调用"——框架 API / DOM API / 状态管理 API
 * 这些调用在源码中存在但没有对应 Method 实体,借鉴 aos 的 ext: 虚拟对象思路
 * @param {Object} ts - TypeScript Compiler API
 * @param {Object} node - 函数节点
 * @param {Object} sourceFile - SourceFile
 * @returns {Array<{ name: string, kind: string, framework: string, line: number }>}
 */
function extractExternalCalls(ts, node, sourceFile) {
  if (!node || !node.body || !ts.isBlock(node.body)) return [];
  const out = [];
  const seen = new Set();
  function walk(n) {
    if (!n) return;
    // 形式 1:直接调用 useState() / fetch() / ref()
    if (ts.isCallExpression(n)) {
      const expr = n.expression;
      if (ts.isIdentifier(expr)) {
        const name = expr.text;
        if (REACT_HOOKS.has(name) || DOM_APIS.has(name) || STATE_MGMT_APIS.has(name)) {
          const kind = REACT_HOOKS.has(name) ? 'react-hook' : (DOM_APIS.has(name) ? 'dom-api' : 'state-mgmt');
          const framework = kind === 'react-hook' ? 'react'
            : (kind === 'dom-api' ? 'browser' : 'state-management');
          const key = `${kind}:${name}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({
              name,
              kind,
              framework,
              line: sourceFile.getLineAndCharacterOfPosition(n.getStart(sourceFile)).line + 1,
            });
          }
        }
      }
    }
    ts.forEachChild(n, walk);
  }
  walk(node.body);
  return out;
}

// 借鉴 asdm-aos endpointInfo（@RestController + @RequestMapping/@GetMapping）
// 适配前端域：Next.js App Router（export async function GET/POST）+ Nuxt 3 文件名后缀
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']);

/**
 * 识别方法的 API 端点信息。
 * @param {string} name - 方法名
 * @param {string} relPath - 文件相对路径（用于推断路由）
 * @returns {null | { framework: string, method: string, path: string }}
 */
// 借鉴 asdm-aos mapperMapsTable:在 Service / Store 函数体里识别 SQL 字符串,提取表名
// 适配:SELECT/INSERT/UPDATE/DELETE + 模板字符串(`FROM ${tableName}`) + 字符串字面量
// 设计:4 个独立、简单正则(避免 [\s\S]+? 在大字符串上回溯爆炸)
// table 名接受 3 种形式:
//   1) word chars:users / products
//   2) 模板字符串:$\{name\} → 内部 name 提取,标 dynamic
//   3) 拼接变量:["us","ers"].join("") 等无法识别,标 dynamic
const SQL_PATTERNS = [
  { kind: 'SELECT', regex: /\bSELECT\b[\s\S]+?\bFROM\s+(?:`?(\w+)`?|(\$\{[^}]+\}))/gi },
  { kind: 'INSERT', regex: /\bINSERT\s+INTO\s+(?:`?(\w+)`?|(\$\{[^}]+\}))/gi },
  { kind: 'UPDATE', regex: /\bUPDATE\s+(?:`?(\w+)`?|(\$\{[^}]+\}))/gi },
  { kind: 'DELETE', regex: /\bDELETE\s+FROM\s+(?:`?(\w+)`?|(\$\{[^}]+\}))/gi },
];

/**
 * 从函数体字符串中提取 SQL 表名。
 * @param {string} bodyText - 函数体原文
 * @returns {Array<{ kind: string, table: string, dynamic: boolean }>}
 */
function extractSqlTables(bodyText) {
  if (!bodyText) return [];
  const out = [];
  const seen = new Set();
  for (const { kind, regex } of SQL_PATTERNS) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(bodyText)) !== null) {
      // 两个 capture group:group 1 是静态表名,group 2 是 ${...} 模板
      const staticTable = m[1];
      const dynamicTable = m[2];
      const isDynamic = !!dynamicTable;
      const table = isDynamic ? dynamicTable.slice(2, -1) : staticTable; // 去掉 ${ 和 }
      if (!table) continue;
      const key = `${kind}:${table}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, table, dynamic: isDynamic });
    }
  }
  return out;
}

function detectApiEndpoint(name, filePath) {
  // 兼容绝对/相对路径:取框架根目录段(app|pages|server)
  const normalized = filePath.replace(/\\/g, '/');
  // 找到 app|pages|server 在路径中的位置(可能前面有 src/ 或绝对路径前缀)
  const m = normalized.match(/(?:^|\/)(app|pages|server)\//);
  if (!m) return null;
  const rel = normalized.slice(m.index + m[0].indexOf(m[1]));
  // 1. Next.js App Router: app/api/.../route.ts + 函数名是 HTTP method
  if (HTTP_METHODS.has(name)) {
    const appRouter = rel.match(/^app\/(?:\([^)]+\)\/)?(api\/.*?)\/route\.(?:ts|tsx|js|jsx|mjs)$/);
    if (appRouter) {
      const routePath = '/' + appRouter[1].replace(/\/\([^)]+\)\//g, '/');
      return { framework: 'next-app-router', method: name, path: routePath };
    }
    // 2. Next.js Pages Router: pages/api/users.ts + 函数名是 HTTP method
    const pagesApi = rel.match(/^pages\/api\/(.*?)\.(?:ts|tsx|js|jsx|mjs)$/);
    if (pagesApi) {
      return { framework: 'next-pages-router', method: name, path: '/api/' + pagesApi[1] };
    }
  }
  // 2b. Pages Router 也接受 `export default function handler()` 形式(方法在 req.method 决定)
  //     这里 method 标 'ANY' 提示用户查 req.method
  if (name === 'default' || name === 'handler') {
    const pagesApi2 = rel.match(/^pages\/api\/(.*?)\.(?:ts|tsx|js|jsx|mjs)$/);
    if (pagesApi2) {
      return { framework: 'next-pages-router', method: 'ANY', path: '/api/' + pagesApi2[1] };
    }
  }
  // 3. Nuxt 3: server/api/users.get.ts (method 在文件名后缀,函数名可能是 default/handler)
  //    仅当函数名匹配 default/handler/_default 时启用
  if (name === 'default' || name === 'handler' || name === '_default') {
    const nuxt = rel.match(/^server\/api\/(.*)\.(get|post|put|delete|patch|head|options)\.(?:ts|js|mjs)$/);
    if (nuxt) {
      return { framework: 'nuxt', method: nuxt[2].toUpperCase(), path: '/api/' + nuxt[1] };
    }
  }
  return null;
}

// 借鉴 asdm-aos dataModelType（JPA Entity / Record / Lombok Data / MongoDB / Immutable）
// 适配前端域：基于类/接口名后缀 + 装饰器启发式识别数据模型
function detectDataModel(ts, name, node, sourceFile) {
  // 1. 名字后缀启发式（DTO / Model / Entity / Schema / Request / Response / Form / Payload）
  const SUFFIX_MAP = {
    DTO: 'dto', Dto: 'dto',
    Model: 'model',
    Entity: 'entity',
    Schema: 'schema',
    Request: 'request', Response: 'response',
    Params: 'params', Param: 'params',
    Input: 'input', Output: 'output',
    Form: 'form', Payload: 'payload',
  };
  for (const [suffix, type] of Object.entries(SUFFIX_MAP)) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      return { isDataModel: true, dataModelType: type };
    }
  }
  // 2. 装饰器识别（TypeORM / NestJS GraphQL / 类验证器）
  if (ts.canHaveDecorators?.(node)) {
    const decs = ts.getDecorators(node);
    if (decs) {
      for (const d of decs) {
        const text = d.getText(sourceFile);
        if (/@(Entity|ObjectType|InputType|Model|ArgsType)\b/.test(text)) {
          return { isDataModel: true, dataModelType: 'orm-decorated' };
        }
      }
    }
  }
  return { isDataModel: false, dataModelType: null };
}

function extractJsdoc(ts, node, sourceText) {
  try {
    const docs = ts.getJSDocCommentsAndTags(node);
    for (const doc of docs) {
      if (doc.comment == null) continue;
      if (typeof doc.comment === 'string') return doc.comment.replace(/\s+/g, ' ').trim().slice(0, 200);
      const text = doc.comment.map((part) => part.text ?? '').join('').replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 200);
    }
  } catch { /* jsdoc 提取失败不影响主流程 */ }
  return '';
}

function isZustandCreateCall(ts, node, importMap) {
  if (!ts.isCallExpression(node)) return false;
  let callee = node.expression;
  // create<State>()(...) 泛型形式：外层 call 的 expression 是内层 call，向内穿透到 identifier
  while (ts.isCallExpression(callee)) callee = callee.expression;
  if (!ts.isIdentifier(callee)) return false;
  const source = importMap.get(callee.text);
  return !!source && (source === 'zustand' || source.startsWith('zustand/'));
}

function isPiniaDefineStoreCall(ts, node, importMap) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isIdentifier(callee)) return false;
  const source = importMap.get(callee.text);
  // auto-import 场景（unplugin-auto-import）无 import 记录；defineStore 是 Pinia 专有 API 名
  return !source || source === 'pinia';
}

// ---- 前后端 API 映射：前端 HTTP 调用采集（X.get/post/put/delete/patch('/path') / fetch('/path')）----

const HTTP_METHOD_PROPS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);
// axios 封装实例常见命名（service({url, method}) 配置对象调用形态）
const HTTP_CLIENT_NAMES = new Set(['service', 'request', 'api', 'http', 'axios', '$http', 'instance', 'fetcher']);
const HTTP_CLIENT_MODULE_RE = /(?:^|\/)[^/]*(?:axios|request|http|api)[^/]*$/i;

// 首参路径文本：字符串字面量或模板串（`${x}` 保留原文，后端 :param 通配匹配）
function firstArgPath(ts, arg) {
  if (!arg) return null;
  if (ts.isStringLiteralLike(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) {
    let text = arg.head.text;
    for (const span of arg.templateSpans) {
      text += `\${${span.expression.getText()}}${span.literal.text}`;
    }
    return text;
  }
  return null;
}

function looksLikeHttpPath(p) {
  return typeof p === 'string' && (p.startsWith('/') || /^https?:\/\//.test(p));
}

function extractHttpCall(ts, node, sourceFile, importMap) {
  const pos = node.getStart(sourceFile);
  const line = sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  if (ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
    const p = firstArgPath(ts, node.arguments[0]);
    if (!looksLikeHttpPath(p)) return null;
    let method = 'GET';
    const opt = node.arguments[1];
    if (opt && ts.isObjectLiteralExpression(opt)) {
      for (const prop of opt.properties) {
        if (ts.isPropertyAssignment(prop) && prop.name?.getText(sourceFile) === 'method'
            && ts.isStringLiteralLike(prop.initializer)) {
          method = prop.initializer.text.toUpperCase();
        }
      }
    }
    return { method, path: p, line };
  }
  // axios 封装实例配置对象形态：service({url: '/api/user', method: 'post', data})（gin-vue-admin 惯例）。
  // 判定：调用名为常见 HTTP 封装，或该名 import 自含 axios/request/http/api 的模块；首参须含 url 字符串属性
  if (ts.isIdentifier(node.expression) && node.arguments[0]
      && ts.isObjectLiteralExpression(node.arguments[0])) {
    const name = node.expression.text;
    const module = importMap.get(name);
    const isClient = HTTP_CLIENT_NAMES.has(name)
      || (module !== undefined && (module === 'axios' || HTTP_CLIENT_MODULE_RE.test(module)));
    if (isClient) {
      let p = null;
      let method = 'GET';
      for (const prop of node.arguments[0].properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const key = prop.name?.getText(sourceFile);
        if (key === 'url') p = firstArgPath(ts, prop.initializer);
        else if (key === 'method' && ts.isStringLiteralLike(prop.initializer)) method = prop.initializer.text.toUpperCase();
      }
      if (looksLikeHttpPath(p)) return { method, path: p, line };
    }
  }
  if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
      && HTTP_METHOD_PROPS.has(node.expression.name.text)) {
    const p = firstArgPath(ts, node.arguments[0]);
    if (!looksLikeHttpPath(p)) return null;
    return { method: node.expression.name.text.toUpperCase(), path: p, line };
  }
  return null;
}

// 从节点子树中找第一个动态 import 的模块字符串（路由懒加载 component: () => import('...')）
function findDynamicImportSpec(ts, node) {
  let found = null;
  function visit(n) {
    if (found) return;
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) found = arg.text;
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return found;
}

function unwrapStateObject(ts, factoryNode) {
  let body = null;
  if (ts.isArrowFunction(factoryNode) || ts.isFunctionExpression(factoryNode)) {
    body = factoryNode.body;
    if (ts.isBlock(body)) {
      body = body.statements.find((s) => ts.isReturnStatement(s) && s.expression)?.expression ?? null;
    }
  }
  // () => ({...}) 的 body 是 ParenthesizedExpression
  while (body && ts.isParenthesizedExpression(body)) body = body.expression;
  if (body && ts.isObjectLiteralExpression(body)) return body;
  return null;
}

function objectPropKeys(ts, objectNode, sourceFile) {
  const keys = [];
  if (!objectNode) return keys;
  for (const prop of objectNode.properties) {
    if (ts.isMethodDeclaration(prop) || ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
      // 对象字面量方法简写：login() {} / get x() {}
      const name = prop.name?.getText(sourceFile);
      if (name) keys.push(name);
      continue;
    }
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
    const key = ts.isPropertyAssignment(prop) && !ts.isIdentifier(prop.name)
      ? prop.name.getText(sourceFile).replace(/^['"]|['"]$/g, '')
      : prop.name?.getText(sourceFile);
    if (key) keys.push(key);
  }
  return keys;
}

// Pinia defineStore('id', setup | { state, getters, actions }, options?) → 与 zustand 同构的 store 事实
function extractPiniaStore(ts, callNode, sourceFile) {
  const storeId = callNode.arguments[0] && ts.isStringLiteralLike(callNode.arguments[0])
    ? callNode.arguments[0].text
    : null;
  const stateKeys = [];
  const actionKeys = [];
  let hasPersist = false;
  let storageKey = null;

  const setupOrOptions = callNode.arguments[1];
  if (setupOrOptions && (ts.isArrowFunction(setupOrOptions) || ts.isFunctionExpression(setupOrOptions))) {
    // setup store：返回对象中的函数值 → action，其余 → state；shorthand 需回溯 setup 函数体内的函数声明
    const fnNames = new Set();
    const collectFnDecls = (n) => {
      if (ts.isFunctionDeclaration(n) && n.name) {
        fnNames.add(n.name.text);
      } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
        const init = n.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) fnNames.add(n.name.text);
      } else {
        ts.forEachChild(n, collectFnDecls);
      }
    };
    collectFnDecls(setupOrOptions);
    const returned = unwrapStateObject(ts, setupOrOptions);
    if (returned) {
      for (const prop of returned.properties) {
        if (ts.isMethodDeclaration(prop) || ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
          const name = prop.name?.getText(sourceFile);
          if (name) actionKeys.push(name);
          continue;
        }
        if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
        const key = ts.isPropertyAssignment(prop) && !ts.isIdentifier(prop.name)
          ? prop.name.getText(sourceFile).replace(/^['"]|['"]$/g, '')
          : prop.name?.getText(sourceFile);
        if (!key) continue;
        const isAction = (ts.isPropertyAssignment(prop)
            && (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer)))
          || (ts.isShorthandPropertyAssignment(prop) && fnNames.has(key));
        (isAction ? actionKeys : stateKeys).push(key);
      }
    }
  } else if (setupOrOptions && ts.isObjectLiteralExpression(setupOrOptions)) {
    // options store：state/getters 归 state，actions 归 action
    for (const prop of setupOrOptions.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const section = prop.name?.getText(sourceFile);
      if (section === 'state') {
        stateKeys.push(...objectPropKeys(ts, unwrapStateObject(ts, prop.initializer), sourceFile));
      } else if (section === 'getters' && ts.isObjectLiteralExpression(prop.initializer)) {
        stateKeys.push(...objectPropKeys(ts, prop.initializer, sourceFile));
      } else if (section === 'actions' && ts.isObjectLiteralExpression(prop.initializer)) {
        actionKeys.push(...objectPropKeys(ts, prop.initializer, sourceFile));
      }
    }
  }

  // persist 插件配置（pinia-plugin-persistedstate）：第三参数，或第二参数对象内的 persist 字段
  const persistSources = [callNode.arguments[2], setupOrOptions].filter((x) => x && ts.isObjectLiteralExpression(x));
  for (const src of persistSources) {
    for (const prop of src.properties) {
      if (ts.isPropertyAssignment(prop) && prop.name?.getText(sourceFile) === 'persist') {
        const init = prop.initializer;
        if (init.kind === ts.SyntaxKind.TrueKeyword) {
          hasPersist = true;
        } else if (ts.isObjectLiteralExpression(init)) {
          hasPersist = true;
          for (const p of init.properties) {
            if (ts.isPropertyAssignment(p) && p.name?.getText(sourceFile) === 'key'
                && ts.isStringLiteralLike(p.initializer)) {
              storageKey = p.initializer.text;
            }
          }
        }
      }
    }
  }
  return { id: storeId, stateKeys, actionKeys, hasPersist, storageKey };
}

export function analyzeFile(filePath, content, projectRoot) {
  const ts = getTs(projectRoot);
  const scriptKind = filePath.endsWith('.tsx') || filePath.endsWith('.jsx')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, content.replace(/^\uFEFF/, ''), ts.ScriptTarget.Latest, true, scriptKind);

  const facts = {
    path: filePath,
    ext: path.extname(filePath).slice(1),
    lineCount: content.split('\n').length,
    imports: [],
    exportSymbols: [],
    jsxTags: new Set(),
    useCalls: [],
    overlayOpens: [],
    jsxPropRenders: [],
    zustandCreates: [],
    piniaCreates: [],
    globPatterns: [],
    vueRoutes: [],
    vueGlobalComponents: [],
    httpCalls: [],
    lazyWrappers: [],
    hasSingletonClass: false,
    hasClassExport: false,
    importMap: new Map(),
    interfaces: [],
    classes: [],
    moduleFunctions: [],
    nameReferences: new Map(),
  };

  const recordNameRef = (name, pos) => {
    const arr = facts.nameReferences.get(name);
    if (arr) arr.push(pos);
    else facts.nameReferences.set(name, [pos]);
  };

  const recordImport = (node, specifier, isTypeOnly, isDynamic, names) => {
    facts.imports.push({ specifier, isTypeOnly, isDynamic, names, pos: node.getStart(sourceFile) });
  };

  const collectNamedImports = (clause) => {
    const names = [];
    if (clause.name) names.push({ imported: 'default', local: clause.name.text });
    const bindings = clause.namedBindings;
    if (bindings) {
      if (ts.isNamespaceImport(bindings)) {
        names.push({ imported: '*', local: bindings.name.text });
      } else if (ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          names.push({ imported: el.propertyName?.text ?? el.name.text, local: el.name.text });
        }
      }
    }
    return names;
  };

  // useRouter() 声明的变量名（含解构 { push }），用于归属 vue-router 导航调用
  const routerVarDecls = [];
  const pendingNavCalls = [];
  let sawNavLinkDynamic = false; // <NavLink to={x.path}> 动态引用（数据驱动侧边栏）
  // props 传递链采集：JSX 属性原文（visit 后统一分类，此时文件级 state/store/fn 索引已齐）
  const pendingPropAttrs = [];
  const hookVarNames = []; // { hook, names, pos }（useState 解构首元素 / useXxxStore 变量）
  const localFnNames = new Set(); // 本文件函数声明与箭头函数变量（handler 判定）

  function visit(node) {
    if (ts.isIdentifier(node)) {
      recordNameRef(node.text, node.getStart(sourceFile));
    } else if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
      recordNameRef(node.argumentExpression.text, node.argumentExpression.getStart(sourceFile));
    } else if (ts.isImportDeclaration(node) && node.importClause && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const names = collectNamedImports(node.importClause);
      recordImport(node, node.moduleSpecifier.text, !!node.importClause.isTypeOnly, false, names);
      for (const n of names) {
        if (n.imported !== '*') facts.importMap.set(n.local, node.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const names = [];
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          names.push({ imported: el.propertyName?.text ?? el.name.text, local: null });
        }
      }
      recordImport(node, node.moduleSpecifier.text, !!node.isTypeOnly, false, names);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) recordImport(node, arg.text, false, true, []);
      } else if (ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        if (OVERLAY_OPENER_FUNCS.has(name)) {
          const first = node.arguments[0];
          if (first && ts.isStringLiteralLike(first)) {
            facts.overlayOpens.push({ target: first.text, pos: node.getStart(sourceFile) });
          }
        } else if (name === 'useRouter') {
          // 记录 useRouter() 声明的变量（const router = useRouter() / const { push } = useRouter()）
          // 注意：必须置于 /^use[A-Z]/ 分支之前，否则被 useCalls 提前吞掉
          const parent = node.parent;
          if (parent && ts.isVariableDeclaration(parent)) {
            if (ts.isIdentifier(parent.name)) {
              routerVarDecls.push({ name: parent.name.text, pos: node.getStart(sourceFile) });
            } else if (ts.isObjectBindingPattern(parent.name)) {
              for (const el of parent.name.elements) {
                if (ts.isIdentifier(el.name)) routerVarDecls.push({ name: el.name.text, pos: node.getStart(sourceFile) });
              }
            }
          }
        } else if (VUE_ROUTER_NAV_METHODS.has(name)) {
          // push('/path') / replace('/path') 形式（解构自 useRouter 时计入导航）
          const first = node.arguments[0];
          if (first && ts.isStringLiteralLike(first)) {
            pendingNavCalls.push({ calleeName: name, isProp: false, target: first.text, pos: node.getStart(sourceFile) });
          }
        } else if (/^use[A-Z]/.test(name)) {
          facts.useCalls.push({ name, pos: node.getStart(sourceFile) });
          // 记录 hook 调用声明的变量名（props kind 分类用）：
          // const [x, setX] = useState() 取首元素（state）；const items = useXxxStore() 全量（store）
          const parent = node.parent;
          if (parent && ts.isVariableDeclaration(parent)) {
            const names = [];
            if (ts.isIdentifier(parent.name)) names.push(parent.name.text);
            else if (ts.isObjectBindingPattern(parent.name)) {
              for (const el of parent.name.elements) {
                if (ts.isIdentifier(el.name)) names.push(el.name.text);
              }
            } else if (ts.isArrayBindingPattern(parent.name)) {
              const first = parent.name.elements[0];
              if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name)) names.push(first.name.text);
            }
            if (names.length) hookVarNames.push({ hook: name, names, pos: node.getStart(sourceFile) });
          }
        } else if (name === 'create' || name === 'createStore') {
          // zustand create：支持 create((set)=>({...})) 与 create<State>()(...) 泛型形式。
          // 泛型形式中 create 是内层 call（parent 为外层 call），需穿透到外层 call 再定位变量声明
          let decl = node.parent;
          let callNode = node;
          if (ts.isCallExpression(decl) && decl.expression === node && ts.isVariableDeclaration(decl.parent)) {
            callNode = decl;
            decl = decl.parent;
          }
          if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
            facts.zustandCreates.push({
              varName: decl.name.text,
              callNode,
              pos: decl.getStart(sourceFile),
              end: decl.end,
            });
          }
        } else if (name === 'defineStore') {
          // Pinia store：export const useXxxStore = defineStore('id', ...)
          const parent = node.parent;
          if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
            facts.piniaCreates.push({
              varName: parent.name.text,
              callNode: node,
              pos: parent.getStart(sourceFile),
              end: parent.end,
            });
          }
        }
      } else if (ts.isPropertyAccessExpression(node.expression)
        && OVERLAY_OPENER_FUNCS.has(node.expression.name.text)) {
        // app.setActiveOverlay('xxx') 形式
        const first = node.arguments[0];
        if (first && ts.isStringLiteralLike(first)) {
          facts.overlayOpens.push({ target: first.text, pos: node.getStart(sourceFile) });
        }
      } else if (ts.isPropertyAccessExpression(node.expression)
        && VUE_ROUTER_NAV_METHODS.has(node.expression.name.text)
        && ts.isIdentifier(node.expression.expression)) {
        // router.push('/path') 形式（router 来自 useRouter() 时计入导航）
        const first = node.arguments[0];
        if (first && ts.isStringLiteralLike(first)) {
          pendingNavCalls.push({
            calleeName: node.expression.expression.text,
            isProp: true,
            target: first.text,
            pos: node.getStart(sourceFile),
          });
        }
      } else if (ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'component'
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'Vue') {
        // Vue.component('X', Y) 全局组件注册（main.js）：builder 聚合为全仓库注册表
        const first = node.arguments[0];
        const second = node.arguments[1];
        if (first && ts.isStringLiteralLike(first) && second && ts.isIdentifier(second)) {
          facts.vueGlobalComponents.push({ name: first.text, local: second.text });
        }
      } else if (ts.isPropertyAccessExpression(node.expression)
        && VUE_ROUTER_NAV_METHODS.has(node.expression.name.text)
        && ts.isPropertyAccessExpression(node.expression.expression)
        && node.expression.expression.name.text === '$router') {
        // this.$router.push('/path')（Vue2 Options API 导航）
        const first = node.arguments[0];
        if (first && ts.isStringLiteralLike(first)) {
          facts.overlayOpens.push({ target: first.text, pos: node.getStart(sourceFile) });
        }
      }
      // 前后端 API 映射：采集本调用为 HTTP 请求（builder 与 go 路由路径匹配）
      const httpInfo = extractHttpCall(ts, node, sourceFile, facts.importMap);
      if (httpInfo && facts.httpCalls.length < 500) facts.httpCalls.push(httpInfo);
      const calleeText = node.expression.getText(sourceFile);
      // import.meta.glob(['/src/views/**.vue', '!/src/views/auth/**.vue'])（Vite 动态批量导入）：
      // 采集模式供 builder 豁免 glob 注册文件的孤儿候选
      if (ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'glob'
        && ts.isMetaProperty(node.expression.expression)) {
        const patterns = [];
        for (const arg of node.arguments) {
          if (ts.isStringLiteralLike(arg)) patterns.push(arg.text);
          else if (ts.isArrayLiteralExpression(arg)) {
            for (const el of arg.elements) {
              if (ts.isStringLiteralLike(el)) patterns.push(el.text);
            }
          }
        }
        if (patterns.length) facts.globPatterns.push({ patterns, fromFile: filePath });
      }
      // defineAsyncComponent(() => import('...'))（Vue）：unplugin-auto-import 场景可能无 import 记录，不校验来源
      const isVueAsync = calleeText === 'defineAsyncComponent'
        || (calleeText.split('.').pop() === 'defineAsyncComponent' && facts.importMap.get(calleeText.split('.').pop()) === 'vue');
      if ((REACT_LAZY_WRAPPERS.has(calleeText) && facts.importMap.get(calleeText.split('.').pop()) === 'react') || isVueAsync) {
        const arg = node.arguments[0];
        if (arg && ts.isArrowFunction(arg)) {
          const inner = arg.body;
          if (ts.isCallExpression(inner) && inner.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const spec = inner.arguments[0];
            if (spec && ts.isStringLiteralLike(spec)) {
              const vd = node.parent;
              const varName = vd && ts.isVariableDeclaration(vd) && ts.isIdentifier(vd.name) ? vd.name.text : null;
              facts.lazyWrappers.push({ name: varName, importPath: spec.text, pos: node.getStart(sourceFile) });
            }
          }
        }
      }
    } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;
      if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) facts.jsxTags.add(tag.text);
      // props 传递链：PascalCase 标签的属性原文（路由库组件 Link/Navigate 的属性无业务语义，跳过）
      if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)
        && !ROUTING_JSX_COMPONENTS.has(tag.text)) {
        const attrs = node.attributes?.properties ?? [];
        const propAttrs = [];
        for (const p of attrs) {
          if (ts.isJsxSpreadAttribute(p)) {
            propAttrs.push({ name: null, node: p.expression });
            continue;
          }
          if (!ts.isJsxAttribute(p) || !p.name) continue;
          const attrName = p.name.getText(sourceFile);
          if (REACT_INTERNAL_ATTRS.has(attrName)) continue;
          let expr = p.initializer ?? null;
          if (expr && ts.isJsxExpression(expr)) expr = expr.expression ?? null;
          propAttrs.push({ name: attrName, node: expr });
        }
        if (propAttrs.length && pendingPropAttrs.length < 200) {
          pendingPropAttrs.push({ toComponent: tag.text, pos: node.getStart(sourceFile), attrs: propAttrs.slice(0, 16) });
        }
      }
      // <Navigate to="/path" /> 重定向（react-router），计入 overlayOpens 供路由导航边使用
      if (tag.text === 'Navigate' && /react-router/.test(facts.importMap.get('Navigate') ?? '')) {
        const attrs = node.attributes?.properties ?? [];
        const toAttr = attrs.find((p) => ts.isJsxAttribute(p) && p.name?.getText(sourceFile) === 'to');
        if (toAttr?.initializer && ts.isStringLiteral(toAttr.initializer)) {
          facts.overlayOpens.push({ target: toAttr.initializer.text, pos: node.getStart(sourceFile) });
        }
      }
      // <Link href="/path">（next/link）：字符串或 { pathname: '/x' } 对象形式，计入 overlayOpens 供路由导航边使用
      if (tag.text === 'Link' && facts.importMap.get('Link') === 'next/link') {
        const attrs = node.attributes?.properties ?? [];
        const hrefAttr = attrs.find((p) => ts.isJsxAttribute(p) && p.name?.getText(sourceFile) === 'href');
        let expr = hrefAttr?.initializer ?? null;
        if (expr && ts.isJsxExpression(expr)) expr = expr.expression;
        let target = null;
        if (expr && ts.isStringLiteralLike(expr)) target = expr.text;
        else if (expr && ts.isObjectLiteralExpression(expr)) {
          const pn = expr.properties.find((p) => ts.isPropertyAssignment(p) && p.name?.getText(sourceFile) === 'pathname');
          if (pn && ts.isStringLiteralLike(pn.initializer)) target = pn.initializer.text;
        }
        if (target) facts.overlayOpens.push({ target, pos: node.getStart(sourceFile) });
      }
      // <NavLink to="/path">（react-router 导航链接）：字符串或 { pathname: '/x' } 对象形式
      if (tag.text === 'NavLink' && /react-router/.test(facts.importMap.get('NavLink') ?? '')) {
        const attrs = node.attributes?.properties ?? [];
        const toAttr = attrs.find((p) => ts.isJsxAttribute(p) && p.name?.getText(sourceFile) === 'to');
        let expr = toAttr?.initializer ?? null;
        if (expr && ts.isJsxExpression(expr)) expr = expr.expression;
        let target = null;
        if (expr && ts.isStringLiteralLike(expr)) target = expr.text;
        else if (expr && ts.isObjectLiteralExpression(expr)) {
          const pn = expr.properties.find((p) => ts.isPropertyAssignment(p) && p.name?.getText(sourceFile) === 'pathname');
          if (pn && ts.isStringLiteralLike(pn.initializer)) target = pn.initializer.text;
        }
        if (target) facts.overlayOpens.push({ target, pos: node.getStart(sourceFile) });
        // 动态引用（to={item.path}）：数据驱动侧边栏，visit 后从同文件常量表兜底提取
        else if (expr) sawNavLinkDynamic = true;
      }
    } else if (ts.isInterfaceDeclaration(node) && node.name) {
      const exported = hasExportModifier(ts, node);
      const extendsNames = [];
      for (const hc of node.heritageClauses ?? []) {
        if (hc.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const t of hc.types) {
          if (ts.isIdentifier(t.expression)) extendsNames.push(t.expression.text);
        }
      }
      const methods = [];
      for (const m of node.members) {
        if (ts.isMethodSignature(m) && m.name) {
          methods.push({
            name: m.name.getText(sourceFile),
            line: sourceFile.getLineAndCharacterOfPosition(m.getStart(sourceFile)).line + 1,
            signature: buildSignature(ts, m, sourceFile),
            pos: m.getStart(sourceFile),
            end: m.end,
            // interface signature 无 body，health 不可计算
            health: placeholderHealth(),
          });
        }
      }
      facts.interfaces.push({
        name: node.name.text,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        exported,
        extendsNames,
        methods,
        pos: node.getStart(sourceFile),
        end: node.end,
        // 数据模型识别（借鉴 asdm-aos isDataModel/dataModelType,适配前端启发式）
        ...detectDataModel(ts, node.name.text, node, sourceFile),
      });
    } else if (ts.isClassDeclaration(node) && node.name) {
      const exported = hasExportModifier(ts, node);
      if (exported) facts.hasClassExport = true;
      let extendsName = null;
      const implementsNames = [];
      for (const hc of node.heritageClauses ?? []) {
        if (hc.token === ts.SyntaxKind.ExtendsKeyword) {
          const t = hc.types[0];
          if (t && ts.isIdentifier(t.expression)) extendsName = t.expression.text;
        } else if (hc.token === ts.SyntaxKind.ImplementsKeyword) {
          for (const t of hc.types) {
            if (ts.isIdentifier(t.expression)) implementsNames.push(t.expression.text);
          }
        }
      }
      const methods = [];
      for (const m of node.members) {
        if (!ts.isMethodDeclaration(m) || !m.name) continue;
        methods.push({
          name: m.name.getText(sourceFile),
          line: sourceFile.getLineAndCharacterOfPosition(m.getStart(sourceFile)).line + 1,
          isStatic: hasModifierKind(ts, m, ts.SyntaxKind.StaticKeyword),
          isAsync: hasModifierKind(ts, m, ts.SyntaxKind.AsyncKeyword),
          isOverride: hasModifierKind(ts, m, ts.SyntaxKind.OverrideKeyword),
          signature: buildSignature(ts, m, sourceFile),
          pos: m.getStart(sourceFile),
          end: m.end,
          // 方法级健康度（借鉴 asdm-aos complexity/isTest/lambdaCount，整合为 health 画像）
          health: analyzeMethodHealth({ ts, node: m, sourceFile, options: { language: 'ts' } }),
          // 外部调用识别（借鉴 asdm-aos ext: 虚拟对象）
          externalCalls: extractExternalCalls(ts, m, sourceFile),
        });
      }
      const isSingleton = node.members.some((m) => ts.isMethodDeclaration(m) && m.name?.getText(sourceFile) === 'getInstance');
      if (isSingleton) facts.hasSingletonClass = true;
      facts.classes.push({
        name: node.name.text,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        exported,
        isSingleton,
        implementsNames,
        extendsName,
        methods,
        pos: node.getStart(sourceFile),
        end: node.end,
        // 数据模型识别
        ...detectDataModel(ts, node.name.text, node, sourceFile),
      });
    } else if (ts.isExportAssignment(node)) {
      const expr = node.expression;
      const name = ts.isIdentifier(expr) ? expr.text : '<default-anonymous>';
      facts.exportSymbols.push({
        name, kind: ts.isIdentifier(expr) ? 'reexport' : 'default',
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        isDefault: true, isExported: true,
      });
    } else if (ts.isVariableStatement(node)) {
      const exported = hasExportModifier(ts, node);
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const initializer = decl.initializer;
        const kind = initializer
          ? (ts.isArrowFunction(initializer) ? 'arrow'
            : ts.isObjectLiteralExpression(initializer) ? 'object'
            : ts.isCallExpression(initializer) ? 'call'
            : 'const')
          : 'const';
        facts.exportSymbols.push({
          name: decl.name.text, kind,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          isDefault: false, isExported: exported,
          node: decl, statementNode: node,
          description: exported ? extractJsdoc(ts, node, content) : '',
        });
      }
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      localFnNames.add(node.name.text);
      const exported = hasExportModifier(ts, node);
      if (exported || hasDefaultModifier(ts, node)) {
        facts.exportSymbols.push({
          name: node.name.text, kind: 'function',
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          isDefault: hasDefaultModifier(ts, node), isExported: exported,
          node, statementNode: node,
          description: exported ? extractJsdoc(ts, node, content) : '',
        });
      }
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const init = node.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        localFnNames.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  // 数据驱动侧边栏兜底：<NavLink to={item.path}> 动态引用时，
  // 同文件常量表（如 NAV_ITEMS 数组）中的 { path: '/xxx' } 字符串值计为导航目标
  if (sawNavLinkDynamic) {
    // 形态 1：字面量 { path: '/xxx' }
    for (const m of content.matchAll(/\bpath\s*:\s*(['"`])(\/[^'"`]*)\1/g)) {
      facts.overlayOpens.push({ target: m[2], pos: m.index });
    }
    // 形态 2：常量成员引用 { path: ROUTES.DASHBOARD }——从 const 对象表解析
    // （同文件 const X = { KEY: '/value' }，或 named import 的模块文件内定义）
    const memberRefs = [...content.matchAll(/\bpath\s*:\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)];
    if (memberRefs.length > 0) {
      // 同文件 const 对象表（浅层 KEY: '字面量'）
      const localTable = new Map();
      for (const m of content.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\{([\s\S]*?)\}/g)) {
        const members = new Map();
        for (const p of m[2].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(['"`])([^'"`]+)\2/g)) {
          if (p[3].startsWith('/')) members.set(p[1], p[3]);
        }
        if (members.size > 0) localTable.set(m[1], members);
      }
      // 跨文件：import { X } from './module' → 模块文件的 const 对象表（含 export const）
      const importedTable = new Map();
      for (const ref of memberRefs) {
        const objName = ref[1];
        if (localTable.has(objName) || importedTable.has(objName)) continue;
        const spec = facts.importMap.get(objName);
        if (!spec || !spec.startsWith('.')) continue;
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), spec));
        for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js']) {
          const cand = base + ext;
          let modContent;
          try {
            modContent = fs.readFileSync(path.join(projectRoot, cand), 'utf-8');
          } catch {
            continue;
          }
          const members = new Map();
          for (const m of modContent.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\{([\s\S]*?)\}/g)) {
            if (m[1] !== objName) continue;
            for (const p of m[2].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(['"`])([^'"`]+)\2/g)) {
              if (p[3].startsWith('/')) members.set(p[1], p[3]);
            }
          }
          importedTable.set(objName, members);
          break;
        }
      }
      for (const ref of memberRefs) {
        const table = localTable.get(ref[1]) ?? importedTable.get(ref[1]);
        const target = table?.get(ref[2]);
        if (target) facts.overlayOpens.push({ target, pos: ref.index });
      }
    }
  }

  // 预扫：vitest/jest test 调用的 callback 箭头函数（让 health.testInfo.testType 能正确标记为 unit/suite/setup）
  // 整棵 sourceFile 递归扫 testCallbacks（包括 describe 嵌套内的 it/beforeEach），顶层 test 调用额外记到 topLevelTestCalls
  const TEST_CALLBACK_NAMES = new Set(['it', 'test', 'specify', 'describe', 'suite', 'context', 'beforeAll', 'beforeEach', 'afterAll', 'afterEach']);
  const testCallbacks = new Map(); // arrowFn node → enclosingCallName
  const topLevelTestCalls = [];    // 顶层 describe/it/test 调用（用于 moduleFunction 收录）
  for (const stmt of sourceFile.statements) {
    // 1) 顶层 test 调用（ExpressionStatement 形式）
    if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)
        && ts.isIdentifier(stmt.expression.expression) && TEST_CALLBACK_NAMES.has(stmt.expression.expression.text)) {
      const cb = stmt.expression.arguments?.[1];
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
        const callName = stmt.expression.expression.text;
        testCallbacks.set(cb, callName);
        topLevelTestCalls.push({ call: stmt.expression, callback: cb, name: callName });
      }
    }
    // 2) 整棵子树递归（识别嵌套 it/beforeEach 等，不入 moduleFunction 但建 testCallbacks 映射）
    (function collectNested(n) {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && TEST_CALLBACK_NAMES.has(n.expression.text)) {
        const cb = n.arguments?.[1];
        if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
          testCallbacks.set(cb, n.expression.text);
        }
      }
      ts.forEachChild(n, collectNested);
    })(stmt);
  }

  // 模块级函数：顶层函数声明 + 顶层 const/let 箭头函数/函数表达式（Method 实体的 module 归属来源）
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      // export default function () {} 是 FunctionDeclaration with Default+Export modifiers,name 为空
      // 借鉴 asdm-aos endpointInfo 适配:作为 name='default' 的 moduleFunction 收集
      // 这样 Nuxt 3 `server/api/users.get.ts` + `export default function() {}` 能被识别为 GET /api/users
      const isDefaultExport = !stmt.name && hasDefaultModifier(ts, stmt) && hasExportModifier(ts, stmt);
      if (isDefaultExport) {
        facts.moduleFunctions.push({
          name: 'default',
          line: sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile)).line + 1,
          exported: true,
          isAsync: hasModifierKind(ts, stmt, ts.SyntaxKind.AsyncKeyword),
          signature: buildSignature(ts, stmt, sourceFile),
          pos: stmt.getStart(sourceFile),
          end: stmt.end,
          health: analyzeMethodHealth({ ts, node: stmt, sourceFile, options: { language: 'ts' } }),
          endpointInfo: detectApiEndpoint('default', filePath),
        });
        continue;
      }
      if (!stmt.name) continue; // 跳过无名非 default export（理论不应出现）
      facts.moduleFunctions.push({
        name: stmt.name.text,
        line: sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile)).line + 1,
        exported: hasExportModifier(ts, stmt) || hasDefaultModifier(ts, stmt),
        isAsync: hasModifierKind(ts, stmt, ts.SyntaxKind.AsyncKeyword),
        signature: buildSignature(ts, stmt, sourceFile),
        pos: stmt.getStart(sourceFile),
        end: stmt.end,
        // 模块级函数：分析健康度
        health: analyzeMethodHealth({ ts, node: stmt, sourceFile, options: { language: 'ts' } }),
        // API 端点识别（借鉴 asdm-aos Method.endpointInfo,适配 Next.js/Nuxt）
        endpointInfo: detectApiEndpoint(stmt.name.text, filePath),
        // SQL 表名提取（借鉴 asdm-aos mapperMapsTable,适配 SELECT/INSERT/UPDATE/DELETE）
        sqlQueries: extractSqlTables(stmt.body ? sourceFile.text.slice(stmt.body.getStart(sourceFile), stmt.body.end) : null),
        // 外部调用识别（借鉴 asdm-aos ext: 虚拟对象,React/DOM/状态管理 API）
        externalCalls: extractExternalCalls(ts, stmt, sourceFile),
      });
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const init = decl.initializer;
        if (!init || (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init))) continue;
        facts.moduleFunctions.push({
          name: decl.name.text,
          line: sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile)).line + 1,
          exported: hasExportModifier(ts, stmt),
          isAsync: hasModifierKind(ts, init, ts.SyntaxKind.AsyncKeyword),
          signature: buildSignature(ts, init, sourceFile),
          pos: stmt.getStart(sourceFile),
          end: stmt.end,
          // 顶层箭头函数：分析健康度
          // 如该箭头函数是 test call 的 callback，传递 enclosingCallName 让 testType 标记为 unit/suite/setup
          health: analyzeMethodHealth({
            ts, node: init, sourceFile,
            options: { language: 'ts', enclosingCallName: testCallbacks.get(init) ?? null },
          }),
        });
      }
    } else if (ts.isExpressionStatement(stmt)) {
      // 顶层 test 调用由下方 topLevelTestCalls 统一处理（保持 moduleFunction 列表不重复）
    }
  }

  // 顶层 test 调用的 callback：作为 moduleFunction 收录（name 用 it@testType 形式以便 query 区分）
  // 嵌套的 it/beforeEach（describe 内部）暂不收录到 moduleFunction（避免双计），但 testCallbacks 已建立，
  // 用户可单独扩展（如需"全部测试函数"清单）
  for (const { call, callback, name } of topLevelTestCalls) {
    const callStart = call.getStart(sourceFile);
    facts.moduleFunctions.push({
      name: `${name}@${sourceFile.getLineAndCharacterOfPosition(callStart).line + 1}`,
      line: sourceFile.getLineAndCharacterOfPosition(callStart).line + 1,
      exported: false,
      isAsync: callback.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false,
      signature: buildSignature(ts, callback, sourceFile),
      pos: callStart,
      end: call.end,
      // 顶层 test 调用：直接传 enclosingCallName
      health: analyzeMethodHealth({
        ts, node: callback, sourceFile,
        options: { language: 'ts', enclosingCallName: name },
      }),
    });
  }

  // vue-router 导航调用归属：callee 名与更早出现的 useRouter 声明匹配才计入 overlayOpens
  for (const nav of pendingNavCalls) {
    const hit = routerVarDecls.find((d) => d.name === nav.calleeName && d.pos < nav.pos);
    if (hit) facts.overlayOpens.push({ target: nav.target, pos: nav.pos });
  }

  // 「const X = ...; export default X;」分离导出模式：末尾 default 引用回填导出标记
  const defaultReferenced = new Set(
    facts.exportSymbols.filter((s) => s.kind === 'reexport').map((s) => s.name),
  );
  if (defaultReferenced.size > 0) {
    for (const s of facts.exportSymbols) {
      if (defaultReferenced.has(s.name) && !s.isExported) {
        s.isExported = true;
        s.isDefault = true;
      }
    }
  }

  // zustand store 详情（importMap 此刻已完整，import 具有提升语义）
  facts.stores = [];
  for (const entry of facts.zustandCreates) {
    if (!isZustandCreateCall(ts, entry.callNode, facts.importMap)) continue;
    // factory 取外层 call 的 arguments[0]：create((set)=>({...})) 与 create<State>()(X) 中 X 均位于此
    let factory = entry.callNode.arguments[0];
    let hasPersist = false;
    let storageKey = null;
    // 穿透 persist/devtools 包装（可嵌套，如 devtools(persist((set)=>({...}), {name})))）
    while (factory && ts.isCallExpression(factory) && ts.isIdentifier(factory.expression)
        && (factory.expression.text === 'persist' || factory.expression.text === 'devtools')) {
      if (factory.expression.text === 'persist') {
        hasPersist = true;
        const opts = factory.arguments[1];
        if (opts && ts.isObjectLiteralExpression(opts)) {
          for (const prop of opts.properties) {
            if (ts.isPropertyAssignment(prop) && prop.name?.getText(sourceFile) === 'name'
                && ts.isStringLiteralLike(prop.initializer)) {
              storageKey = prop.initializer.text;
            }
          }
        }
      }
      factory = factory.arguments[0];
    }
    const stateObj = factory ? unwrapStateObject(ts, factory) : null;
    const stateKeys = [];
    const actionKeys = [];
    if (stateObj) {
      for (const prop of stateObj.properties) {
        if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
          const key = ts.isPropertyAssignment(prop) && !ts.isIdentifier(prop.name)
            ? prop.name.getText(sourceFile).replace(/^['"]|['"]$/g, '')
            : prop.name?.getText(sourceFile);
          if (!key) continue;
          const isAction = ts.isPropertyAssignment(prop)
            && (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer));
          (isAction ? actionKeys : stateKeys).push(key);
        }
      }
    }
    facts.stores.push({
      name: entry.varName,
      stateKeys, actionKeys,
      hasPersist, storageKey,
      line: sourceFile.getLineAndCharacterOfPosition(entry.pos).line + 1,
      lineCount: sourceFile.text.slice(entry.pos, entry.end).split('\n').length,
      providerType: 'zustand',
    });
  }

  // Pinia store 详情（defineStore 调用，importMap 提升语义同上）
  for (const entry of facts.piniaCreates) {
    if (!isPiniaDefineStoreCall(ts, entry.callNode, facts.importMap)) continue;
    const pinia = extractPiniaStore(ts, entry.callNode, sourceFile);
    facts.stores.push({
      name: entry.varName,
      stateKeys: pinia.stateKeys,
      actionKeys: pinia.actionKeys,
      hasPersist: pinia.hasPersist,
      storageKey: pinia.storageKey,
      line: sourceFile.getLineAndCharacterOfPosition(entry.pos).line + 1,
      lineCount: sourceFile.text.slice(entry.pos, entry.end).split('\n').length,
      providerType: 'pinia',
    });
  }
  delete facts.zustandCreates;
  delete facts.piniaCreates;

  // Vuex store 检测（Vue2）：/store/ 目录或导入 vuex 的文件，
  // default export（export default {...} / export default new Vuex.Store({...}) / export default X
  // 回溯 const X = {...}，RuoYi 风格）对象含 state/actions/mutations → store 事实
  const isVuexCandidate = filePath.includes('/store/') || [...facts.importMap.values()].some((s) => s === 'vuex');
  if (isVuexCandidate) {
    const topVarInits = new Map(); // 顶层 const X = <init>
    for (const stmt of sourceFile.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.initializer) topVarInits.set(d.name.text, d.initializer);
        }
      }
    }
    const asStoreObject = (expr) => {
      if (ts.isObjectLiteralExpression(expr)) return expr;
      if (ts.isNewExpression(expr)) {
        const arg = expr.arguments?.[0];
        if (arg && ts.isObjectLiteralExpression(arg)) return arg;
      }
      return null;
    };
    let vuexObj = null;
    for (const stmt of sourceFile.statements) {
      if (!ts.isExportAssignment(stmt)) continue;
      vuexObj = asStoreObject(stmt.expression)
        ?? (ts.isIdentifier(stmt.expression) ? asStoreObject(topVarInits.get(stmt.expression.text) ?? null) : null);
      break; // 只看顶层第一个 export default
    }
    if (vuexObj) {
      const stateKeys = [];
      const actionKeys = [];
      const sectionInit = (prop) => {
        if (ts.isPropertyAssignment(prop)) return prop.initializer;
        // RuoYi dict.js 风格：export default { namespaced: true, state, mutations } shorthand 引用顶层 const
        if (ts.isShorthandPropertyAssignment(prop)) return topVarInits.get(prop.name.text) ?? null;
        return null;
      };
      for (const prop of vuexObj.properties) {
        const section = prop.name?.getText(sourceFile);
        if (section !== 'state' && section !== 'actions' && section !== 'mutations') continue;
        const init = sectionInit(prop);
        if (!init) continue;
        if (section === 'state') {
          const stateObj = unwrapStateObject(ts, init)
            ?? (ts.isObjectLiteralExpression(init) ? init : null);
          stateKeys.push(...objectPropKeys(ts, stateObj, sourceFile));
        } else if (ts.isObjectLiteralExpression(init)) {
          for (const k of objectPropKeys(ts, init, sourceFile)) {
            if (!actionKeys.includes(k)) actionKeys.push(k);
          }
        }
      }
      // 组件 .vue 选项对象无 state/actions/mutations 键，stateKeys/actionKeys 双空自动跳过
      if (stateKeys.length || actionKeys.length) {
        facts.stores.push({
          name: path.posix.basename(filePath).replace(/\.(tsx?|jsx?)$/, ''),
          stateKeys,
          actionKeys,
          hasPersist: false,
          storageKey: null,
          line: sourceFile.getLineAndCharacterOfPosition(vuexObj.getStart(sourceFile)).line + 1,
          lineCount: content.split('\n').length,
          providerType: 'vuex',
        });
      }
    }
  }

  // Vue Router 路由提取：router/ 目录（或导入 vue-router）文件中 path+component 对象 → RouteRecordRaw
  if (filePath.includes('/router/') || [...facts.importMap.values()].some((s) => s === 'vue-router' || s.startsWith('vue-router/'))) {
    const localFunctions = new Map();
    for (const stmt of sourceFile.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) localFunctions.set(stmt.name.text, stmt);
      // 顶层 const ClientLogin = () => import('...') 形式的懒加载包装（snowy 等路由文件惯用）
      if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.initializer
            && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
            localFunctions.set(d.name.text, d.initializer);
          }
        }
      }
    }
    const resolveComponentRef = (init) => {
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        const spec = findDynamicImportSpec(ts, init);
        if (spec) return { ref: `() => import('${spec}')`, specifier: spec };
      } else if (ts.isIdentifier(init)) {
        if (facts.importMap.has(init.text)) return { ref: init.text, specifier: facts.importMap.get(init.text) };
        const fn = localFunctions.get(init.text);
        if (fn) {
          const spec = findDynamicImportSpec(ts, fn);
          if (spec) return { ref: init.text, specifier: spec };
        }
      }
      return { ref: init.getText(sourceFile), specifier: null };
    };
    const visited = new Set();
    const collectRouteObject = (node, parentPath) => {
      if (visited.has(node)) return;
      visited.add(node);
      const pathProp = node.properties.find((x) => ts.isPropertyAssignment(x) && x.name?.getText(sourceFile) === 'path');
      const compProp = node.properties.find((x) => ts.isPropertyAssignment(x) && x.name?.getText(sourceFile) === 'component');
      if (!pathProp || !ts.isStringLiteralLike(pathProp.initializer) || !compProp) return;
      const childPath = pathProp.initializer.text;
      const fullPath = childPath.startsWith('/') ? childPath : parentPath + childPath;
      const nameProp = node.properties.find((x) => ts.isPropertyAssignment(x) && x.name?.getText(sourceFile) === 'name');
      const metaProp = node.properties.find((x) => ts.isPropertyAssignment(x) && x.name?.getText(sourceFile) === 'meta');
      let metaTitle = null;
      if (metaProp && ts.isObjectLiteralExpression(metaProp.initializer)) {
        const titleProp = metaProp.initializer.properties.find((x) => ts.isPropertyAssignment(x) && x.name?.getText(sourceFile) === 'title');
        if (titleProp) {
          if (ts.isStringLiteralLike(titleProp.initializer)) {
            metaTitle = titleProp.initializer.text;
          } else if (ts.isArrowFunction(titleProp.initializer)) {
            // () => t('menu.steamData') 形式取 i18n key
            const body = titleProp.initializer.body;
            if (ts.isCallExpression(body) && body.arguments[0] && ts.isStringLiteralLike(body.arguments[0])) {
              metaTitle = body.arguments[0].text;
            }
          }
        }
      }
      const { ref, specifier } = resolveComponentRef(compProp.initializer);
      facts.vueRoutes.push({
        path: fullPath,
        name: nameProp && ts.isStringLiteralLike(nameProp.initializer) ? nameProp.initializer.text : null,
        metaTitle,
        componentRef: ref,
        specifier,
        pos: node.getStart(sourceFile),
        end: node.end,
      });
      const childrenProp = node.properties.find((x) => ts.isPropertyAssignment(x) && x.name?.getText(sourceFile) === 'children');
      if (childrenProp && ts.isArrayLiteralExpression(childrenProp.initializer)) {
        for (const el of childrenProp.initializer.elements) {
          if (ts.isObjectLiteralExpression(el)) collectRouteObject(el, fullPath);
        }
      }
    };
    const collectVisit = (node) => {
      if (ts.isObjectLiteralExpression(node)) collectRouteObject(node, '');
      ts.forEachChild(node, collectVisit);
    };
    collectVisit(sourceFile);
  }

  // 组件抽取：.tsx/.jsx 中的导出 PascalCase 符号
  facts.components = [];
  if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) {
    for (const sym of facts.exportSymbols) {
      if (!sym.isExported || !/^[A-Z]/.test(sym.name)) continue;
      if (sym.kind !== 'function' && sym.kind !== 'arrow' && sym.kind !== 'call') continue;
      let fnNode = null;
      if (sym.kind === 'function') {
        fnNode = sym.node;
      } else if (sym.kind === 'arrow' && sym.node?.initializer && ts.isArrowFunction(sym.node.initializer)) {
        fnNode = sym.node.initializer;
      } else if (sym.kind === 'call' && sym.node?.initializer && ts.isCallExpression(sym.node.initializer)) {
        // memo(() => ...) / forwardRef((props) => ...)
        const init = sym.node.initializer;
        fnNode = init.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a)) ?? null;
      }
      if (!fnNode || (!ts.isFunctionDeclaration(fnNode) && !ts.isArrowFunction(fnNode) && !ts.isFunctionExpression(fnNode))) continue;

      const start = sym.statementNode.getStart(sourceFile);
      const end = sym.statementNode.end;
      const params = fnNode.parameters ?? [];
      let propsCount = null;
      const propsNames = [];
      if (params.length > 0 && ts.isObjectBindingPattern(params[0].name)) {
        for (const el of params[0].name.elements) {
          if (ts.isOmittedExpression(el) || !ts.isIdentifier(el.name)) continue;
          propsNames.push(el.propertyName ? el.propertyName.getText(sourceFile) : el.name.text);
        }
        propsCount = propsNames.length;
      } else if (params.length > 0) {
        propsCount = 1;
      } else {
        propsCount = 0;
      }
      const inRange = facts.useCalls.filter((c) => c.pos >= start && c.pos < end);
      const hooksUsed = [...new Set(inRange.map((c) => c.name))];
      facts.components.push({
        name: sym.name,
        isDefault: sym.isDefault,
        line: sym.line,
        pos: start,
        end,
        propsCount,
        propsNames,
        hooksUsed,
        stateCount: inRange.filter((c) => c.name === 'useState').length,
        lineCount: sourceFile.text.slice(start, end).split('\n').length,
        description: sym.description || '',
      });
    }
  }

  // props 传递链分类：JSX 属性表达式按来源归类（forward/state/store/handler/literal/computed/spread）
  // 词法近似：按标识符名 + 组件声明范围 + 文件级变量表判定，非作用域精确分析
  const trimText = (node) => {
    let t = node.getText(sourceFile).replace(/\s+/g, ' ');
    if (t.length > 60) t = `${t.slice(0, 57)}...`;
    return t;
  };
  for (const pass of pendingPropAttrs) {
    const owner = facts.components.find((c) => pass.pos >= c.pos && pass.pos < c.end) ?? null;
    const props = [];
    for (const attr of pass.attrs) {
      const expr = attr.node;
      // spread 属性（不展开成员）：{...obj} 记为单条 spread 边
      if (attr.name === null) {
        props.push({ name: `...${trimText(expr)}`, source: 'spread', valueText: null, storeHook: null });
        continue;
      }
      // 无 initializer 的裸属性（<Xxx disabled />）→ boolean 字面量
      if (!expr) {
        props.push({ name: attr.name, source: 'literal', valueText: 'true', storeHook: null });
        continue;
      }
      if (ts.isStringLiteralLike(expr) || expr.kind === ts.SyntaxKind.NumericLiteral
          || expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword
          || expr.kind === ts.SyntaxKind.NullKeyword) {
        props.push({ name: attr.name, source: 'literal', valueText: trimText(expr), storeHook: null });
        continue;
      }
      // 内联函数 → handler
      if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
        props.push({ name: attr.name, source: 'handler', valueText: trimText(expr), storeHook: null });
        continue;
      }
      if (ts.isIdentifier(expr)) {
        const name = expr.text;
        // 父组件 props 转发（解构 props 遮蔽模块级同名符号，优先判定）
        if (owner && owner.propsNames.includes(name)) {
          props.push({ name: attr.name, source: 'forward', valueText: name, storeHook: null });
          continue;
        }
        // 本地函数引用（组件内定义或模块级工具函数）→ handler
        if (localFnNames.has(name)) {
          props.push({ name: attr.name, source: 'handler', valueText: name, storeHook: null });
          continue;
        }
        // 组件范围内 useState 解构变量 → 本地状态
        const stateHit = hookVarNames.find((h) => h.hook === 'useState' && h.names.includes(name)
          && h.pos < pass.pos && (!owner || (h.pos >= owner.pos && h.pos < owner.end)));
        if (stateHit) {
          props.push({ name: attr.name, source: 'state', valueText: name, storeHook: null });
          continue;
        }
        // 组件范围内非内置 hook 变量（useXxxStore/useQuery 等）→ 状态库数据源
        const hookHit = hookVarNames.find((h) => h.hook !== 'useState' && !BUILTIN_HOOKS.has(h.hook)
          && h.names.includes(name) && h.pos < pass.pos
          && (!owner || (h.pos >= owner.pos && h.pos < owner.end)));
        if (hookHit) {
          props.push({ name: attr.name, source: 'store', valueText: name, storeHook: hookHit.hook });
          continue;
        }
        props.push({ name: attr.name, source: 'computed', valueText: name, storeHook: null });
        continue;
      }
      props.push({ name: attr.name, source: 'computed', valueText: trimText(expr), storeHook: null });
    }
    if (props.length) {
      facts.jsxPropRenders.push({
        tag: pass.toComponent,
        fromComponent: owner?.name ?? null,
        pos: pass.pos,
        props,
      });
    }
  }

  const defaultComp = facts.components.find((c) => c.isDefault);
  facts.primaryComponentName = defaultComp?.name ?? facts.components[0]?.name ?? null;

  // Hook 符号：导出的 useXxx
  facts.hooks = facts.exportSymbols
    .filter((s) => s.isExported && /^use[A-Z]/.test(s.name) && (s.kind === 'function' || s.kind === 'arrow'))
    .map((s) => ({
      name: s.name,
      line: s.line,
      lineCount: s.node ? sourceFile.text.slice(s.statementNode.getStart(sourceFile), s.statementNode.end).split('\n').length : null,
      description: s.description || '',
    }));

  facts.exportNames = facts.exportSymbols.filter((s) => s.isExported || s.isDefault).map((s) => s.name);
  return facts;
}

export function analyzeFileFromDisk(relPath, projectRoot) {
  const content = fs.readFileSync(path.join(projectRoot, relPath), 'utf-8');
  return analyzeFile(relPath, content, projectRoot);
}
