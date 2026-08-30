// Vue 单文件组件（.vue SFC）分析器
// 参考 steam-stat（Vue 3 + Vite + vue-router + Pinia + <script setup>）的代码组织：
//   - 拆分顶层块 <template>/<script setup>/<script>/<style>/<route lang="yaml">
//   - script 内容复用 tsAnalyzer 解析（imports/composables/stores/导航调用）
//   - template 提取组件标签（PascalCase 与 kebab-case 统一转 PascalCase），供 renders 关系使用
//   - <route lang="yaml"> 提取 unplugin-vue-router 的文件路由 meta（title/name/path）
// Vue2 适配（Options API，参考 leaniss-system-core/aise-ui：Vue 2.6 + element-ui + vuex）：
//   - export default {} 选项解析：props（对象/数组）→ propsDefs/propsNames、components 注册表、
//     data/computed/methods 键集（mapState/mapGetters/mapActions/mapMutations 展开 → storeKeys）
//   - template 绑定提取与来源分类（forward/state/store/handler/computed/literal/spread）→ vuePropRenders
//   - router-link 静态 to → overlayOpens（builder 7c 导航边）
// 输出与 tsAnalyzer 相同 shape 的 facts，供 builder 无缝复用。

import path from 'node:path';
import ts from 'typescript';
import { analyzeFile } from './tsAnalyzer.js';
import { analyzeFileFromDisk } from './textUtils.js';

// 原生 HTML 标签（不进组件标签集）
const NATIVE_TAGS = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi',
  'bdo', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code',
  'col', 'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog',
  'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure', 'footer',
  'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr',
  'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li',
  'link', 'main', 'map', 'mark', 'menu', 'meta', 'meter', 'nav', 'noscript',
  'object', 'ol', 'optgroup', 'option', 'output', 'p', 'picture', 'pre',
  'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script', 'section',
  'select', 'slot', 'small', 'source', 'span', 'strong', 'style', 'sub',
  'summary', 'sup', 'table', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead',
  'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
  'svg', 'path', 'circle', 'rect', 'g', 'defs', 'mask', 'line', 'polyline',
  'polygon', 'ellipse', 'text', 'tspan', 'use', 'symbol', 'foreignObject',
]);
// Vue 内置组件（不进组件标签集）
const VUE_BUILTIN_TAGS = new Set([
  'component', 'template', 'transition', 'transition-group', 'keep-alive',
  'teleport', 'suspense', 'router-view', 'router-link',
]);
// 模板属性：无业务传递语义的指令 / DOM 透传属性（不计入传递链）
const VUE_DIRECTIVE_SKIP = new Set([
  'v-if', 'v-else', 'v-else-if', 'v-for', 'v-show', 'v-html', 'v-text',
  'v-once', 'v-pre', 'v-cloak', 'v-slot', 'slot', 'slot-scope', 'scope', 'ref', 'key', 'is',
]);
const DOM_ATTR_SKIP = new Set(['class', 'style', 'id']);

// 顶层 SFC 块拆分：块开标签必须顶格（行首），闭合标签顶格配对
// template 块内可能含 <template #footer> 等嵌套子元素，用计数器配对避免误拆
function splitSfc(content) {
  const blocks = [];
  const openRe = /^<(template|script|style|route)([^>]*)>/gm;
  let m;
  while ((m = openRe.exec(content)) !== null) {
    const tag = m[1];
    const attrs = m[2].trim();
    // 带 #name / v- 指令属性的是 template 内嵌元素（如 <template #footer>），跳过
    if (tag === 'template' && /^[#v]/.test(attrs)) continue;
    const contentStart = m.index + m[0].length;
    let end = null;
    if (tag === 'template') {
      // 嵌套配对：<template> 开 → depth+1，</template> → depth-1，归零即顶层闭合
      // 不做行首锚定：单行 SFC（<template>…</template> 同行）的闭合标签在行中
      // 注：正则字面量内 `</` 序列与 HTML 注释语法冲突，斜杠需转义为 `\/`
      let depth = 1;
      const pairRe = /<(\/?)template\b/g;
      pairRe.lastIndex = contentStart;
      let pm;
      while ((pm = pairRe.exec(content)) !== null) {
        if (pm[1] === '/') {
          depth -= 1;
          if (depth === 0) {
            end = pm.index;
            break;
          }
        } else {
          depth += 1;
        }
      }
    } else {
      // script/style/route 闭合标签可出现在行内（单行 SFC），不做行首锚定
      const closeRe = new RegExp(`</${tag}>`, 'g');
      closeRe.lastIndex = contentStart;
      const closeMatch = closeRe.exec(content);
      if (closeMatch) end = closeMatch.index;
    }
    if (end === null) continue;
    blocks.push({
      type: attrs.includes('setup') ? 'script-setup' : tag,
      attrs,
      content: content.slice(contentStart, end),
      start: contentStart,
      end,
    });
    openRe.lastIndex = end + `</${tag}>`.length;
  }
  return blocks;
}

// kebab-case / snake_case / camelCase → PascalCase（close-confirm-dialog → CloseConfirmDialog）
function toPascalCase(name) {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

// 文件名 → 组件名：status.vue → Status；index.vue → 父目录名；[...all].vue → All
function componentNameFromFile(filePath) {
  const base = path.posix.basename(filePath, '.vue');
  if (base === 'index') {
    const dir = path.posix.dirname(filePath);
    const parent = dir === '.' ? null : path.posix.basename(dir);
    return parent && parent !== 'src' ? toPascalCase(parent) : 'Index';
  }
  if (base.startsWith('[...') && base.endsWith(']')) return 'All';
  return toPascalCase(base);
}

// template 组件标签：PascalCase 直接收；kebab-case 转 PascalCase（与 import 名对齐）；:is="X" 动态组件收变量
// 原生 HTML / Vue 内置排除仅针对全小写标签（HTML 标签恒为小写，PascalCase 必是组件）
function extractTemplateTags(template) {
  const tags = new Set();
  const tagRe = /<\/?([A-Za-z][\w-]*)\b/g;
  let m;
  while ((m = tagRe.exec(template)) !== null) {
    if (m[0].startsWith('</')) continue;
    const raw = m[1];
    // UI 库前缀标签（element-ui el- / Antdv a-）不进组件标签集
    if (raw.startsWith('el-') || raw.startsWith('a-')) continue;
    if (raw.includes('-')) {
      tags.add(toPascalCase(raw));
    } else if (/^[A-Z]/.test(raw)) {
      tags.add(raw);
    } else if (!NATIVE_TAGS.has(raw.toLowerCase()) && !VUE_BUILTIN_TAGS.has(raw.toLowerCase())) {
      // 非原生的纯小写标签（少见），按字面收
      tags.add(raw);
    }
  }
  // <component :is="X" /> 动态组件（X 为 import 的组件变量）
  const dynRe = /:is\s*=\s*["']([A-Za-z_$][\w$]*)["']/g;
  while ((m = dynRe.exec(template)) !== null) {
    tags.add(m[1]);
  }
  return tags;
}

// <route lang="yaml"> 块解析（unplugin-vue-router）：提取 title / name / path
function parseRouteBlock(block) {
  if (!block) return { title: null, name: null, path: null };
  const yaml = block.content;
  const pick = (key) => {
    const re = new RegExp(`^\\s*${key}\\s*:\\s*['"]?([^'"\\n]+)['"]?\\s*$`, 'm');
    const hit = yaml.match(re);
    return hit ? hit[1].trim() : null;
  };
  return { title: pick('title'), name: pick('name'), path: pick('path') };
}

// defineProps 宏调用参数（数组/对象形式）→ props 名列表（forward 分类用）
function extractDefinePropsNames(script) {
  const callRe = /defineProps\s*(?:<[^>]*>)?\s*\(\s*(\[[\s\S]*?\]|\{[\s\S]*?\})/;
  const m = script.match(callRe);
  if (!m) return null;
  const arg = m[1].trim();
  if (arg.startsWith('[')) {
    return [...arg.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
  }
  return [...arg.matchAll(/^\s*['"]?([\w$]+)['"]?\s*:/gm)].map((x) => x[1]);
}

// defineOptions({ name: 'X' }) → 组件名
function findDefineOptionsName(script) {
  const m = script.match(/defineOptions\s*\(\s*\{[\s\S]*?\bname\s*:\s*['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

// <script setup name="X"> 开标签属性 → 组件名（vite-plugin-vue-setup-extend 惯例）
function setupAttrName(attrs) {
  if (!attrs) return null;
  const m = /(?:^|\s)name\s*=\s*["']([^"']+)["']/.exec(attrs);
  return m ? m[1] : null;
}

// ---------- <script setup>（Composition API）顶层声明收集 ----------
// ref/reactive → state、computed → computed、函数声明 → method、
// storeToRefs(useXxxStore()) 解构 → store 键（module=useXxxStore）、
// useXxxStore() 赋值 → store 变量、toRefs(props)/defineProps()/defineModel 解构 → prop 键
const SETUP_REACTIVE_FNS = new Set(['ref', 'shallowRef', 'reactive', 'shallowReactive', 'customRef', 'toRef']);
function parseScriptSetup(script) {
  const sourceFile = ts.createSourceFile('setup.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const stateKeys = new Set();
  const computedKeys = new Set();
  const methodKeys = new Set();
  const storeKeys = [];
  const storeVars = new Map();
  const propKeys = new Set();
  // store hook 命名：useXxxStore（Pinia 官方惯例）与 xxxStore（snowy 的 globalStore/iframeStore 等）双形态
  const storeCallName = (init) => (ts.isCallExpression(init) && ts.isIdentifier(init.expression)
    && /^\w*Store$/.test(init.expression.text) ? init.expression.text : null);
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      methodKeys.add(stmt.name.text);
      continue;
    }
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      const init = d.initializer;
      if (!init) continue;
      if (ts.isObjectBindingPattern(d.name)) {
        const callee = ts.isCallExpression(init) && ts.isIdentifier(init.expression) ? init.expression.text : null;
        let hook = null;
        if (callee === 'storeToRefs') {
          const arg = init.arguments[0];
          if (arg && ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) hook = arg.expression.text;
          else if (arg && ts.isIdentifier(arg) && storeVars.has(arg.text)) hook = storeVars.get(arg.text);
          else hook = 'store';
        } else if (storeCallName(init)) {
          hook = storeCallName(init);
        }
        for (const el of d.name.elements) {
          if (ts.isOmittedExpression(el) || !ts.isIdentifier(el.name)) continue;
          const key = el.propertyName ? el.propertyName.getText(sourceFile) : el.name.text;
          if (hook) storeKeys.push({ name: key, module: hook });
          else if (callee === 'toRefs' || callee === 'defineProps') propKeys.add(key);
        }
        continue;
      }
      if (!ts.isIdentifier(d.name)) continue;
      const name = d.name.text;
      const callee = ts.isCallExpression(init) && ts.isIdentifier(init.expression) ? init.expression.text : null;
      if (callee === 'computed') { computedKeys.add(name); continue; }
      if (callee && SETUP_REACTIVE_FNS.has(callee)) { stateKeys.add(name); continue; }
      if (callee === 'defineModel') { propKeys.add(name); continue; }
      const storeHook = storeCallName(init);
      if (storeHook) { storeVars.set(name, storeHook); continue; }
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) methodKeys.add(name);
    }
  }
  return { stateKeys, computedKeys, methodKeys, storeKeys, storeVars, propKeys };
}

// ---------- Vue2 Options API 解析（export default {} / Vue.extend({}) / defineComponent({})）----------

// 定位组件选项对象字面量；非 Options API（script setup）返回 null
function findOptionsObject(script) {
  const sourceFile = ts.createSourceFile('script.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let optionsNode = null;
  for (const stmt of sourceFile.statements) {
    if (!ts.isExportAssignment(stmt)) continue;
    const expr = stmt.expression;
    if (ts.isObjectLiteralExpression(expr)) {
      optionsNode = expr;
    } else if ((ts.isCallExpression(expr) || ts.isNewExpression(expr))) {
      // export default Vue.extend({...}) / defineComponent({...}) / new Vue({...})
      const arg = expr.arguments?.[0];
      if (arg && ts.isObjectLiteralExpression(arg)) optionsNode = arg;
    }
    break; // 只看顶层第一个 export default
  }
  return optionsNode ? { node: optionsNode, sourceFile } : null;
}

// 属性键名（Identifier / 字面量键），计算属性键返回 null
function keyName(nameNode) {
  if (!nameNode) return null;
  if (ts.isIdentifier(nameNode) || ts.isStringLiteralLike(nameNode) || ts.isNumericLiteral(nameNode)) {
    return nameNode.text;
  }
  return null;
}

// 对象字面量顶层键列表（PropertyAssignment / Shorthand / MethodDeclaration）
function objectKeys(obj) {
  const keys = [];
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) {
      const name = keyName(p.name);
      if (name) keys.push(name);
    }
  }
  return keys;
}

// props 选项 → 定义列表（对象形式含 type 提取；数组形式 type null）
function extractPropsDefs(propNode, sourceFile) {
  const defs = [];
  if (ts.isArrayLiteralExpression(propNode)) {
    for (const el of propNode.elements) {
      if (ts.isStringLiteralLike(el)) defs.push({ name: el.text, type: null });
    }
    return defs;
  }
  if (!ts.isObjectLiteralExpression(propNode)) return defs;
  for (const p of propNode.properties) {
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
    const name = keyName(p.name);
    if (!name) continue;
    let type = null;
    if (ts.isPropertyAssignment(p) && p.initializer) {
      if (ts.isObjectLiteralExpression(p.initializer)) {
        // { total: { type: Number, required: true } }
        const typeProp = p.initializer.properties.find(
          (x) => ts.isPropertyAssignment(x) && keyName(x.name) === 'type',
        );
        if (typeProp) type = typeProp.initializer.getText(sourceFile).replace(/\s+/g, ' ').trim();
      } else {
        // value: [String, Object] / x: String
        type = p.initializer.getText(sourceFile).replace(/\s+/g, ' ').trim();
      }
    }
    defs.push({ name, type });
  }
  return defs;
}

// data 选项 → 键列表（对象 / 返回对象的函数 / data() 方法形式）
function extractDataKeys(propNode) {
  let obj = null;
  if (ts.isObjectLiteralExpression(propNode)) {
    obj = propNode;
  } else if ((ts.isFunctionExpression(propNode) || ts.isArrowFunction(propNode)) && ts.isObjectLiteralExpression(propNode.body)) {
    obj = propNode.body;
  } else if (ts.isMethodDeclaration(propNode) && propNode.body) {
    // data() { return {...} } 方法形式：取首个 return 的对象字面量
    for (const stmt of propNode.body.statements) {
      if (ts.isReturnStatement(stmt) && stmt.expression && ts.isObjectLiteralExpression(stmt.expression)) {
        obj = stmt.expression;
        break;
      }
    }
  }
  return obj ? objectKeys(obj) : [];
}

// mapState/mapGetters/mapActions/mapMutations 调用参数 → store 键（含 vuex 模块名）
function extractMapHelperArgs(call, sourceFile) {
  const args = call.arguments ?? [];
  let module = null;
  let argNode = null;
  if (args.length >= 2 && ts.isStringLiteralLike(args[0])) {
    module = args[0].text; // mapState('app', [...]) 双参形式
    argNode = args[1];
  } else {
    argNode = args[0];
  }
  const out = [];
  if (argNode && ts.isArrayLiteralExpression(argNode)) {
    for (const el of argNode.elements) {
      if (ts.isStringLiteralLike(el)) out.push({ name: el.text, module });
    }
  } else if (argNode && ts.isObjectLiteralExpression(argNode)) {
    for (const p of argNode.properties) {
      const name = (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) ? keyName(p.name) : null;
      if (!name) continue;
      // 对象值形式：{ sidebar: state => state.app.sidebar } — 从函数体提取模块名
      let mod = module;
      if (ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) {
        const m = /state\.(\w+)/.exec(p.initializer.getText(sourceFile));
        if (m) mod = m[1];
      }
      out.push({ name, module: mod });
    }
  }
  return out;
}

// computed / methods 选项 → 键列表 + spread 的 map* helper store 键
function extractKeysWithStores(propNode, sourceFile) {
  const keys = [];
  const storeKeys = [];
  if (!ts.isObjectLiteralExpression(propNode)) return { keys, storeKeys };
  for (const p of propNode.properties) {
    if (ts.isSpreadAssignment(p)) {
      const expr = p.expression;
      if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)
        && /^map(State|Getters|Actions|Mutations)$/.test(expr.expression.text)) {
        storeKeys.push(...extractMapHelperArgs(expr, sourceFile));
      }
      continue;
    }
    const name = keyName(p.name);
    if (name) keys.push(name);
  }
  return { keys, storeKeys };
}

// components 选项 → 注册表：PascalCase(注册键) → 值标识符名（import local 名）
function extractComponents(propNode) {
  const reg = {};
  if (!ts.isObjectLiteralExpression(propNode)) return reg;
  for (const p of propNode.properties) {
    const name = (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) ? keyName(p.name) : null;
    if (!name) continue;
    const valueName = ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer) ? p.initializer.text : name;
    reg[toPascalCase(name)] = valueName;
  }
  return reg;
}

// Options API 整体解析
function parseOptionsApi(script) {
  const found = findOptionsObject(script);
  if (!found) return null;
  const { node, sourceFile } = found;
  const pick = (key) => {
    const prop = node.properties.find(
      (x) => (ts.isPropertyAssignment(x) || ts.isMethodDeclaration(x)) && keyName(x.name) === key,
    );
    return prop && ts.isPropertyAssignment(prop) ? prop.initializer : (prop ?? null);
  };
  const propsProp = pick('props');
  const nameProp = pick('name');
  const result = {
    name: nameProp && ts.isStringLiteralLike(nameProp) ? nameProp.text : null,
    propsDefs: propsProp ? extractPropsDefs(propsProp, sourceFile) : [],
    dataKeys: [],
    computedKeys: [],
    methodKeys: [],
    storeKeys: [],
    components: {},
  };
  const dataProp = pick('data');
  if (dataProp) result.dataKeys = extractDataKeys(dataProp);
  const computedProp = pick('computed');
  if (computedProp) {
    const r = extractKeysWithStores(computedProp, sourceFile);
    result.computedKeys = r.keys;
    result.storeKeys.push(...r.storeKeys);
  }
  const methodsProp = pick('methods');
  if (methodsProp) {
    const r = extractKeysWithStores(methodsProp, sourceFile);
    result.methodKeys = r.keys;
    result.storeKeys.push(...r.storeKeys);
  }
  const componentsProp = pick('components');
  if (componentsProp) result.components = extractComponents(componentsProp);
  return result;
}

// ---------- 模板绑定提取与来源分类 ----------

function trimText(text) {
  let t = String(text).replace(/\s+/g, ' ');
  if (t.length > 60) t = `${t.slice(0, 57)}...`;
  return t;
}

// 表达式根标识符：queryParams.pageNum → queryParams
function rootIdentifier(expr) {
  const m = /^[$A-Za-z_][\w$]*/.exec(expr.trim());
  return m ? m[0] : null;
}

// 动态绑定表达式 → 来源分类（词法近似：按根标识符查 Options API / setup 变量域键集）
function classifyExpr(expr, ctx) {
  const trimmed = expr.trim();
  if (!trimmed) return { source: 'computed', valueText: null, storeHook: null };
  if (/^(['"]).*\1$/.test(trimmed) || /^-?\d+(\.\d+)?$/.test(trimmed) || /^(true|false|null)$/.test(trimmed)) {
    return { source: 'literal', valueText: trimText(trimmed), storeHook: null };
  }
  const root = rootIdentifier(trimmed);
  if (root) {
    if (ctx.propsNames.includes(root)) return { source: 'forward', valueText: root, storeHook: null };
    if (ctx.dataKeys.has(root)) return { source: 'state', valueText: root, storeHook: null };
    const storeKey = ctx.storeKeys.find((s) => s.name === root);
    if (storeKey) return { source: 'store', valueText: root, storeHook: storeKey.module ?? 'vuex' };
    if (ctx.storeVars?.has(root)) return { source: 'store', valueText: root, storeHook: ctx.storeVars.get(root) };
    if (ctx.methodKeys.has(root)) return { source: 'handler', valueText: root, storeHook: null };
    if (ctx.computedKeys.has(root)) return { source: 'computed', valueText: root, storeHook: null };
  }
  return { source: 'computed', valueText: trimText(trimmed), storeHook: null };
}

// 单个模板属性 → 传递项（null 表示跳过）
function classifyAttr(rawName, value, ctx) {
  // v-bind="obj" 整体透传 → spread
  if (rawName === 'v-bind') {
    if (!value) return null;
    const root = rootIdentifier(value);
    return { name: `...${root ?? trimText(value)}`, source: 'spread', valueText: trimText(value), storeHook: null };
  }
  // 事件：@event.mod / v-on:event.mod → handler（回调流向）
  if (rawName.startsWith('@') || rawName.startsWith('v-on:')) {
    const evName = rawName.replace(/^@/, '').replace(/^v-on:/, '').split('.')[0];
    if (!evName || !value) return null;
    return { name: `@${evName}`, source: 'handler', valueText: trimText(value), storeHook: null };
  }
  // v-model / v-model:arg（Vue2 即 value prop + input 事件，记为单项 v-model）
  if (rawName === 'v-model' || rawName.startsWith('v-model:')) {
    if (!value) return null;
    const name = rawName.split('.')[0];
    return { name, ...classifyExpr(value, ctx) };
  }
  // 动态绑定：:prop.mod / v-bind:prop.mod（.sync 修饰符剥离）
  if (rawName.startsWith(':') || rawName.startsWith('v-bind:')) {
    const propName = rawName.replace(/^:/, '').replace(/^v-bind:/, '').split('.')[0];
    if (!propName || !value || propName === 'is') return null;
    return { name: propName, ...classifyExpr(value, ctx) };
  }
  // 其余指令 / 插槽 / DOM 透传属性跳过
  if (rawName.startsWith('v-') || rawName.startsWith('#')) return null;
  if (VUE_DIRECTIVE_SKIP.has(rawName) || DOM_ATTR_SKIP.has(rawName)) return null;
  if (rawName.startsWith('aria-') || rawName.startsWith('data-')) return null;
  // 静态属性 / 裸属性 → literal
  return { name: rawName.split('.')[0], source: 'literal', valueText: value ?? 'true', storeHook: null };
}

// 模板整体：组件标签属性 → 已分类的 vuePropRenders；router-link 静态 to → 导航目标
function extractTemplateBindings(template, ctx) {
  const renders = [];
  const navTargets = [];
  // 标签匹配：属性区引号内的 > 安全（引号优先消费）
  const tagRe = /<([A-Za-z][\w.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g;
  let m;
  while ((m = tagRe.exec(template)) !== null) {
    const rawTag = m[1];
    const attrsText = m[2];
    // router-link 静态 to="/path" → 导航边（动态 :to 含表达式不可静态解析，跳过）
    if (rawTag === 'router-link') {
      const to = /(?:^|\s)to\s*=\s*"([^"]*)"/.exec(attrsText);
      if (to && to[1].startsWith('/')) navTargets.push(to[1]);
      continue;
    }
    const lower = rawTag.toLowerCase();
    // el-（element-ui）/ a-（Ant Design Vue）UI 库前缀、原生 / Vue 内置标签不进传递链
    if (rawTag.startsWith('el-') || rawTag.startsWith('a-') || NATIVE_TAGS.has(lower) || VUE_BUILTIN_TAGS.has(lower)) continue;
    const tag = toPascalCase(rawTag);
    const props = [];
    const attrRe = /([@:#A-Za-z_][\w:@.$-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
    let a;
    while ((a = attrRe.exec(attrsText)) !== null) {
      const entry = classifyAttr(a[1], a[2] ?? a[3] ?? null, ctx);
      if (entry) props.push(entry);
    }
    if (props.length && renders.length < 200) {
      renders.push({ tag, props: props.slice(0, 16) });
    }
  }
  return { renders, navTargets };
}

export function analyzeVueFile(filePath, content, projectRoot) {
  const blocks = splitSfc(content.replace(/^\uFEFF/, ''));
  const templateBlock = blocks.find((b) => b.type === 'template');
  const scriptBlock = blocks.find((b) => b.type === 'script-setup') ?? blocks.find((b) => b.type === 'script');
  const routeBlock = blocks.find((b) => b.type === 'route');
  const routeMeta = parseRouteBlock(routeBlock);

  // script 块复用 tsAnalyzer 解析（虚拟 .ts 路径），imports/composables/stores/导航调用全部继承
  let scriptFacts = null;
  if (scriptBlock && scriptBlock.content.trim()) {
    try {
      scriptFacts = analyzeFile(`${filePath}.ts`, scriptBlock.content, projectRoot);
    } catch {
      scriptFacts = null;
    }
  }
  const sf = scriptFacts ?? {
    imports: [], useCalls: [], overlayOpens: [], stores: [], lazyWrappers: [],
    hooks: [], exportSymbols: [], exportNames: [], importMap: new Map(),
    globPatterns: [],
  };

  const scriptText = scriptBlock?.content ?? '';
  const isSetup = scriptBlock?.type === 'script-setup';

  // Vue2 Options API / Vue3 defineProps 解析
  const options = isSetup ? null : parseOptionsApi(scriptText);
  const setupPropsNames = isSetup ? (extractDefinePropsNames(scriptText) ?? []) : [];
  const setupScope = isSetup ? parseScriptSetup(scriptText) : null;
  const propsDefs = options?.propsDefs ?? (isSetup ? setupPropsNames.map((n) => ({ name: n, type: null })) : []);
  const propsNames = options ? propsDefs.map((p) => p.name) : [...new Set([...setupPropsNames, ...(setupScope?.propKeys ?? [])])];
  const dataKeys = new Set([...(options?.dataKeys ?? []), ...(setupScope?.stateKeys ?? [])]);
  const computedKeys = new Set([...(options?.computedKeys ?? []), ...(setupScope?.computedKeys ?? [])]);
  const methodKeys = new Set([...(options?.methodKeys ?? []), ...(setupScope?.methodKeys ?? [])]);
  const storeKeys = [...(options?.storeKeys ?? []), ...(setupScope?.storeKeys ?? [])];
  const vueComponents = options?.components ?? {};

  const templateTags = templateBlock ? extractTemplateTags(templateBlock.content) : new Set();

  // 模板 props 传递链 + router-link 导航
  const bindingCtx = { propsNames, dataKeys, computedKeys, methodKeys, storeKeys, storeVars: setupScope?.storeVars };
  const bound = templateBlock
    ? extractTemplateBindings(templateBlock.content, bindingCtx)
    : { renders: [], navTargets: [] };
  const overlayOpens = [...sf.overlayOpens];
  for (const t of bound.navTargets) {
    overlayOpens.push({ target: t, pos: templateBlock?.start ?? 0 });
  }

  const name = options?.name
    ?? findDefineOptionsName(scriptText)
    ?? (isSetup ? setupAttrName(scriptBlock?.attrs) : null)
    ?? componentNameFromFile(filePath);
  const propsCount = options ? propsDefs.length : propsNames.length;
  const hooksUsed = [...new Set(sf.useCalls.map((c) => c.name))];
  // 组件体内 store hook 调用名：useXxxStore 已入 hooksUsed；xxxStore（globalStore 等）不在 useCalls，
  // 从 setup 变量域 storeVars 补齐——auto-import 场景无 import 语句，builder 靠调用名对全局 Store 名单建隐式边
  const storeCalls = [...new Set([
    ...hooksUsed.filter((n) => /^\w*Store$/.test(n)),
    ...(setupScope ? [...setupScope.storeVars.values()] : []),
  ])];
  const stateCount = options
    ? dataKeys.size
    : (setupScope ? dataKeys.size : (scriptText.match(/\b(?:ref|shallowRef|reactive|shallowReactive)\s*\(/g) ?? []).length);
  const scriptLine = scriptBlock ? content.slice(0, scriptBlock.start).split('\n').length : 0;

  const facts = {
    path: filePath,
    ext: 'vue',
    lineCount: content.split('\n').length,
    imports: sf.imports,
    exportSymbols: sf.exportSymbols,
    exportNames: sf.exportNames,
    jsxTags: templateTags,
    useCalls: sf.useCalls,
    overlayOpens,
    stores: sf.stores,
    lazyWrappers: sf.lazyWrappers,
    hasSingletonClass: false,
    hasClassExport: false,
    importMap: sf.importMap,
    // 组件：SFC 单组件语义，整文件即组件
    components: [{
      name,
      isDefault: true,
      line: scriptLine,
      pos: scriptBlock?.start ?? 0,
      end: scriptBlock?.end ?? content.length,
      propsCount,
      propsNames,
      hooksUsed,
      storeCalls,
      stateCount,
      lineCount: (scriptBlock ? scriptBlock.content.split('\n').length : 0)
        + (templateBlock ? templateBlock.content.split('\n').length : 0),
      description: routeMeta.title ?? '',
    }],
    primaryComponentName: name,
    hooks: sf.hooks,
    // Vue props 传递链（分类已完成，builder 按注册表/import/全局注册解析目标组件）
    vuePropRenders: bound.renders,
    vueComponents,
    // Options API / setup 变量域键集（builder 合成类视图实体用）
    vueOptions: {
      propsDefs,
      dataKeys: [...dataKeys],
      computedKeys: [...computedKeys],
      methodKeys: [...methodKeys],
      storeKeys,
    },
    // unplugin-vue-router 文件路由 meta（builder 用于生成 Route 与 description）
    vueRouteMeta: routeMeta,
  };
  return facts;
}

export function analyzeVueFileFromDisk(relPath, projectRoot) {
  return analyzeFileFromDisk(relPath, projectRoot, (rp, content) => analyzeVueFile(rp, content, projectRoot));
}
