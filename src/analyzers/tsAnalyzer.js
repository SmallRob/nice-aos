import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

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

  // 模块级函数：顶层函数声明 + 顶层 const/let 箭头函数/函数表达式（Method 实体的 module 归属来源）
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      facts.moduleFunctions.push({
        name: stmt.name.text,
        line: sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile)).line + 1,
        exported: hasExportModifier(ts, stmt) || hasDefaultModifier(ts, stmt),
        isAsync: hasModifierKind(ts, stmt, ts.SyntaxKind.AsyncKeyword),
        signature: buildSignature(ts, stmt, sourceFile),
        pos: stmt.getStart(sourceFile),
        end: stmt.end,
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
        });
      }
    }
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
