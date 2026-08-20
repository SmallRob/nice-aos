// Vue 3 单文件组件（.vue SFC）分析器
// 参考 steam-stat（Vue 3 + Vite + vue-router + Pinia + <script setup>）的代码组织：
//   - 拆分顶层块 <template>/<script setup>/<script>/<style>/<route lang="yaml">
//   - script 内容复用 tsAnalyzer 解析（imports/composables/stores/导航调用）
//   - template 提取组件标签（PascalCase 与 kebab-case 统一转 PascalCase），供 renders 关系使用
//   - <route lang="yaml"> 提取 unplugin-vue-router 的文件路由 meta（title/name/path）
// 输出与 tsAnalyzer 相同 shape 的 facts，供 builder 无缝复用。

import fs from 'node:fs';
import path from 'node:path';
import { analyzeFile } from './tsAnalyzer.js';

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
      // 注：正则字面量内 `</` 序列与 HTML 注释语法冲突，斜杠需转义为 `\/`
      let depth = 1;
      const pairRe = /^<(\/?)template\b/gm;
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

// kebab-case / snake_case → PascalCase（close-confirm-dialog → CloseConfirmDialog）
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

// defineProps 宏调用参数（数组/对象形式）→ props 数量
function countDefineProps(script) {
  const callRe = /defineProps\s*(?:<[^>]*>)?\s*\(\s*(\[[\s\S]*?\]|\{[\s\S]*?\})/;
  const m = script.match(callRe);
  if (!m) return null;
  const arg = m[1].trim();
  if (arg.startsWith('[')) {
    const items = [...arg.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
    return items.length;
  }
  // 对象形式数顶层 key（粗粒度：按行首 key 计数）
  const keys = [...arg.matchAll(/^\s*['"]?([\w$]+)['"]?\s*:/gm)].map((x) => x[1]);
  return keys.length;
}

// defineOptions({ name: 'X' }) → 组件名
function findDefineOptionsName(script) {
  const m = script.match(/defineOptions\s*\(\s*\{[\s\S]*?\bname\s*:\s*['"]([^'"]+)['"]/);
  return m ? m[1] : null;
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
  };

  const templateTags = templateBlock ? extractTemplateTags(templateBlock.content) : new Set();
  const name = findDefineOptionsName(scriptBlock?.content ?? '') ?? componentNameFromFile(filePath);
  const propsCount = scriptBlock ? countDefineProps(scriptBlock.content) : null;
  const hooksUsed = [...new Set(sf.useCalls.map((c) => c.name))];
  const stateCount = scriptBlock ? (scriptBlock.content.match(/\b(?:ref|shallowRef|reactive|shallowReactive)\s*\(/g) ?? []).length : 0;
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
    overlayOpens: sf.overlayOpens,
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
      hooksUsed,
      stateCount,
      lineCount: (scriptBlock ? scriptBlock.content.split('\n').length : 0)
        + (templateBlock ? templateBlock.content.split('\n').length : 0),
      description: routeMeta.title ?? '',
    }],
    primaryComponentName: name,
    hooks: sf.hooks,
    // unplugin-vue-router 文件路由 meta（builder 用于生成 Route 与 description）
    vueRouteMeta: routeMeta,
  };
  return facts;
}

export function analyzeVueFileFromDisk(relPath, projectRoot) {
  const content = fs.readFileSync(path.join(projectRoot, relPath), 'utf-8');
  return analyzeVueFile(relPath, content, projectRoot);
}
