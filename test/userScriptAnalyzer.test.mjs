// 油猴脚本（Tampermonkey UserScript）解析器测试：元数据 / GM API / DOM 注入 / 网络与劫持 / 函数逻辑分布 / 集成
// 样例模式取自 steam-tampermonkey-scripts（React 宿主）与 js_script/other-gm-user-js（Vue 宿主）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseUserScriptMeta, isUserScriptCandidate, analyzeUserScript } from '../src/analyzers/userScriptAnalyzer.js';
import { scanProject } from '../src/analyzers/projectScanner.js';
import { buildOntologyData } from '../src/ontology/builder.js';
import { createBlueprint } from '../src/ontology/blueprint.js';

const ROOT = process.cwd();

// ---- fixture：综合样例（覆盖 GM API / DOM 注入 / 网络 / 劫持 / 函数调用图 / unsafeWindow）----
const FIXTURE = [
  '// ==UserScript==',
  '// @name         Test Demo Script',
  '// @namespace    https://example.com/',
  '// @version      1.0.0',
  '// @description  测试用油猴脚本',
  '// @author       tester',
  '// @match        https://store.steampowered.com/*',
  '// @match        https://steamcommunity.com/*',
  '// @grant        GM_getValue',
  '// @grant        GM_setValue',
  '// @grant        GM_xmlhttpRequest',
  '// @connect      api.steampowered.com',
  '// @connect      example.com',
  '// @run-at       document-end',
  '// @noframes',
  '// ==/UserScript==',
  '(function () {',
  "  'use strict';",
  '',
  '  const CONFIG_KEY = "demo_config";',
  '',
  '  const storage = {',
  '    get(key) { return GM_getValue(key, null); },',
  '    set(key, value) { GM_setValue(key, value); },',
  '  };',
  '',
  '  function fetchData(url) {',
  '    GM_xmlhttpRequest({',
  "      method: 'GET',",
  '      url: `https://api.steampowered.com/v1/${url}`,',
  '      onload: (res) => {',
  '        try { render(JSON.parse(res.responseText)); } catch (e) { console.error(e); }',
  '      },',
  '    });',
  '  }',
  '',
  '  function render(data) {',
  "    const container = document.querySelector('#global_actions');",
  '    if (!container) return;',
  "    const panel = document.createElement('div');",
  "    panel.className = 'demo-panel';",
  '    panel.innerHTML = `<h3>Demo</h3><span>${data.name}</span>`;',
  '    container.appendChild(panel);',
  "    GM_addStyle('.demo-panel { color: red; }');",
  '  }',
  '',
  '  const originalFetch = window.fetch;',
  '  window.fetch = function (...args) {',
  '    console.log("intercepted", args[0]);',
  '    return originalFetch.apply(this, args);',
  '  };',
  '',
  '  setInterval(() => {',
  '    storage.get(CONFIG_KEY);',
  "    fetchData('demo');",
  '  }, 5000);',
  '',
  "  document.addEventListener('DOMContentLoaded', () => {",
  "    fetchData('init');",
  '  });',
  '',
  "  window.fetch('/api/local');",
  "  unsafeWindow.DEMO_EXPORT = { version: '1.0.0' };",
  '  console.log(unsafeWindow.g_steamID);',
  '})();',
].join('\n');

test('元数据块解析：@match/@grant/@connect/@run-at/@noframes', () => {
  const meta = parseUserScriptMeta(FIXTURE);
  assert.ok(meta);
  assert.equal(meta.name, 'Test Demo Script');
  assert.equal(meta.version, '1.0.0');
  assert.equal(meta.author, 'tester');
  assert.equal(meta.runAt, 'document-end');
  assert.equal(meta.noframes, true);
  assert.deepEqual(meta.matches, ['https://store.steampowered.com/*', 'https://steamcommunity.com/*']);
  assert.deepEqual(meta.grants, ['GM_getValue', 'GM_setValue', 'GM_xmlhttpRequest']);
  assert.deepEqual(meta.connects, ['api.steampowered.com', 'example.com']);
  assert.equal(meta.grantNone, false);
  // 无元数据块 → null
  assert.equal(parseUserScriptMeta('const a = 1;'), null);
});

test('元数据块解析：@grant none 归零与 @resource/@require', () => {
  const meta = parseUserScriptMeta([
    '// ==UserScript==',
    '// @name         No Grant Demo',
    '// @grant        none',
    '// @require      https://cdn.example.com/lib.js',
    '// @resource     icon https://example.com/icon.png',
    '// ==/UserScript==',
  ].join('\n'));
  assert.ok(meta);
  assert.equal(meta.grantNone, true);
  assert.deepEqual(meta.grants, []);
  assert.deepEqual(meta.requires, ['https://cdn.example.com/lib.js']);
  assert.deepEqual(meta.resources, [{ name: 'icon', url: 'https://example.com/icon.png' }]);
});

test('isUserScriptCandidate：.user.js 扩展名 / .js 头部元数据块 / 普通文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-candidate-'));
  try {
    const named = path.join(dir, 'demo.user.js');
    fs.writeFileSync(named, 'const a = 1;');
    assert.equal(isUserScriptCandidate(named), true); // 扩展名强信号

    const plainMeta = path.join(dir, 'demo-1.2.3.js');
    fs.writeFileSync(plainMeta, '// ==UserScript==\n// @name x\n// ==/UserScript==\n(function(){})();');
    assert.equal(isUserScriptCandidate(plainMeta), true); // 头部元数据块

    const normal = path.join(dir, 'normal.js');
    fs.writeFileSync(normal, 'const a = 1;');
    assert.equal(isUserScriptCandidate(normal), false);

    const ts = path.join(dir, 'x.ts');
    fs.writeFileSync(ts, '// ==UserScript==');
    assert.equal(isUserScriptCandidate(ts), false); // 非 js 扩展名
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GM API 使用：调用统计 + @grant 声明比对（GM_addStyle 未声明）', () => {
  const facts = analyzeUserScript('fixture/demo.user.js', FIXTURE, ROOT);
  const gm = new Map(facts.gmApiCalls.map((g) => [g.name, g]));
  assert.equal(gm.size, 4);
  assert.equal(gm.get('GM_getValue').callCount, 1);
  assert.equal(gm.get('GM_setValue').callCount, 1);
  assert.equal(gm.get('GM_xmlhttpRequest').callCount, 1);
  assert.equal(gm.get('GM_addStyle').callCount, 1);
  assert.equal(gm.get('GM_getValue').declared, true);
  assert.equal(gm.get('GM_addStyle').declared, false); // 未在 @grant 声明
  assert.equal(gm.get('GM_xmlhttpRequest').category, 'network');
  assert.equal(gm.get('GM_setValue').category, 'storage');
});

test('DOM 注入：innerHTML 动态插值 / querySelector 锚点挂载 / GM_addStyle 样式', () => {
  const facts = analyzeUserScript('fixture/demo.user.js', FIXTURE, ROOT);
  const inj = new Map(facts.domInjections.map((i) => [`${i.kind}|${i.target}`, i]));
  const html = inj.get("inner-html|panel");
  assert.ok(html, '应识别 panel.innerHTML 注入');
  assert.equal(html.interpolated, true); // 模板插值 → XSS 面
  const mount = inj.get("mount|querySelector('#global_actions')");
  assert.ok(mount, 'container.appendChild 应解析为 querySelector 锚点挂载');
  assert.ok(inj.has("style-gm|GM_addStyle"), 'GM_addStyle 应记为样式注入');
});

test('网络请求：GM_xhr 域名 + @connect 白名单 / fetch 劫持后调用', () => {
  const facts = analyzeUserScript('fixture/demo.user.js', FIXTURE, ROOT);
  const net = new Map(facts.networkRequests.map((n) => [`${n.kind}|${n.domain}`, n]));
  const gmXhr = net.get('gm-xhr|api.steampowered.com');
  assert.ok(gmXhr, '应提取 GM 请求域名');
  assert.equal(gmXhr.allowedByConnect, true); // 已在 @connect 声明
  assert.deepEqual(gmXhr.methods, ['GET']);
  assert.ok(net.has('fetch|(dynamic)'), 'window.fetch(url) 应记为 fetch 请求');
  // 劫持：window.fetch = function ...
  assert.equal(facts.hijacks.length, 1);
  assert.equal(facts.hijacks[0].kind, 'hijack-fetch');
});

test('函数逻辑分布：storage 对象方法 / 调用边 fetchData→render / 顶层调用链', () => {
  const facts = analyzeUserScript('fixture/demo.user.js', FIXTURE, ROOT);
  const names = new Set(facts.functions.map((f) => f.name));
  assert.ok(names.has('storage'), '对象常量 storage 应为逻辑单元');
  assert.ok(names.has('storage.get') && names.has('storage.set'), '对象方法应为逻辑单元');
  assert.ok(names.has('fetchData') && names.has('render'));
  assert.equal(facts.isIife, true);
  assert.equal(facts.usesStrict, true);
  // 调用边：fetchData → render（onload 回调位于 fetchData 范围内）
  const edge = facts.callEdges.find((e) => e.from === 'fetchData');
  assert.ok(edge);
  assert.ok(edge.to.some((t) => t.to === 'render' && t.count === 1));
  // 顶层调用链：IIFE 顶层（interval/DOMContentLoaded 回调）调用 fetchData
  const topCall = facts.topLevelCalls.find((c) => c.name === 'fetchData');
  assert.ok(topCall);
  assert.equal(topCall.count, 2);
});

test('unsafeWindow 读写 / 监听与定时器 / 风险等级', () => {
  const facts = analyzeUserScript('fixture/demo.user.js', FIXTURE, ROOT);
  assert.deepEqual(facts.unsafeWindowWrites, ['DEMO_EXPORT']);
  assert.deepEqual(facts.unsafeWindowReads, ['g_steamID']);
  assert.ok(facts.listeners.some((l) => l.event === 'DOMContentLoaded' && l.targetKind === 'document'));
  assert.equal(facts.timers.filter((t) => t.kind === 'interval').length, 1);
  assert.equal(facts.timers[0].delay, 5000);
  // 风险：hijack-fetch(high) + unsafe-window-write(medium) + html-injection(medium) + undeclared-gm-api(medium)
  const riskKinds = new Set(facts.risks.map((r) => r.kind));
  assert.ok(riskKinds.has('hijack-fetch'));
  assert.ok(riskKinds.has('unsafe-window-write'));
  assert.ok(riskKinds.has('html-injection'));
  assert.ok(riskKinds.has('undeclared-gm-api'));
  assert.equal(facts.riskLevel, 'high');
});

test('宿主框架推断：__vue__ → vue / __reactContainer$ → react', () => {
  const vueHost = analyzeUserScript('fixture/vue-host.user.js', [
    '// ==UserScript==',
    '// @name         VueHost',
    '// @grant        none',
    '// ==/UserScript==',
    '(function(){ const app = document.querySelector("#app").__vue__; })();',
  ].join('\n'), ROOT);
  assert.equal(vueHost.hostFramework, 'vue');

  const reactHost = analyzeUserScript('fixture/react-host.user.js', [
    '// ==UserScript==',
    '// @name         ReactHost',
    '// @grant        none',
    '// ==/UserScript==',
    '(function(){ const root = document.getElementById("root")._reactRootContainer; })();',
  ].join('\n'), ROOT);
  assert.equal(reactHost.hostFramework, 'react');
});

// ---- fixture：类风格脚本（this.method() / new 入口 / 实例变量调用 / 角色推断 / 注入与网络归属函数）----
const CLASS_FIXTURE = [
  '// ==UserScript==',
  '// @name         Class Style Demo',
  '// @version      2.0.0',
  '// @match        https://example.com/*',
  '// @grant        GM_xmlhttpRequest',
  '// @grant        GM_setValue',
  '// @connect      api.example.com',
  '// ==/UserScript==',
  '(function () {',
  "  'use strict';",
  '  class Panel {',
  '    constructor() {',
  '      this.mount();',
  '    }',
  '    mount() {',
  "      const host = document.querySelector('#app');",
  "      if (host) host.innerHTML = '<div class=\"panel\">loading</div>';",
  '    }',
  '    load() {',
  '      GM_xmlhttpRequest({',
  "        method: 'GET',",
  "        url: 'https://api.example.com/v1/data',",
  '        onload: (res) => this.update(JSON.parse(res.responseText)),',
  '      });',
  '    }',
  '    update(data) {',
  "      GM_setValue('last', data);",
  "      const host = document.querySelector('#app');",
  '      if (host) host.innerHTML = `<div>${data.name}</div>`;',
  '    }',
  '  }',
  '  const panel = new Panel();',
  '  panel.load();',
  '})();',
].join('\n');

test('类风格脚本：constructor/方法收集 + this.method() 调用边解析', () => {
  const facts = analyzeUserScript('fixture/class-demo.user.js', CLASS_FIXTURE, ROOT);
  const names = new Set(facts.functions.map((f) => f.name));
  assert.ok(names.has('Panel'), '类本身应为逻辑单元');
  assert.ok(names.has('Panel.constructor'), 'constructor 应收集为类入口');
  assert.ok(names.has('Panel.mount') && names.has('Panel.load') && names.has('Panel.update'));
  // this.mount()（constructor 内）→ Panel.mount；this.update()（load 回调内）→ Panel.update
  const edgeOf = (from) => facts.callEdges.find((e) => e.from === from);
  assert.ok(edgeOf('Panel.constructor').to.some((t) => t.to === 'Panel.mount'));
  assert.ok(edgeOf('Panel.load').to.some((t) => t.to === 'Panel.update'));
  // new Panel() → 顶层入口调用 Panel.constructor；panel.load() → 实例别名解析为 Panel.load
  const top = new Map(facts.topLevelCalls.map((c) => [c.name, c.count]));
  assert.equal(top.get('Panel.constructor'), 1);
  assert.equal(top.get('Panel.load'), 1);
});

test('类风格脚本：注入点/网络端点归属函数 + innerHTML 锚点还原', () => {
  const facts = analyzeUserScript('fixture/class-demo.user.js', CLASS_FIXTURE, ROOT);
  // innerHTML receiver host 为 querySelector 变量 → 锚点还原为页面选择器
  const inj = facts.domInjections.find((i) => i.kind === 'inner-html');
  assert.equal(inj.target, "querySelector('#app')");
  assert.equal(inj.callCount, 2); // mount（静态）+ update（模板插值）
  assert.equal(inj.interpolated, true);
  assert.deepEqual(inj.fns, ['Panel.mount', 'Panel.update']); // 注入归属函数（逻辑注入链）
  // 网络端点归属函数
  const net = facts.networkRequests.find((n) => n.kind === 'gm-xhr');
  assert.equal(net.domain, 'api.example.com');
  assert.deepEqual(net.fns, ['Panel.load']);
});

test('函数业务角色推断：render/data/state/event/ui/logic', () => {
  const facts = analyzeUserScript('fixture/class-demo.user.js', CLASS_FIXTURE, ROOT);
  const roles = new Map(facts.functions.map((f) => [f.name, f.roles]));
  assert.deepEqual(roles.get('Panel.mount'), ['render']);            // innerHTML 注入
  assert.deepEqual(roles.get('Panel.load'), ['data']);               // 网络请求
  assert.deepEqual(roles.get('Panel.update'), ['render', 'state']);  // 注入 + GM 存储（双角色）
  assert.deepEqual(roles.get('Panel.constructor'), ['logic']);       // 纯调度逻辑
  // 综合样例：storage.get 有 GM 存储 → state；fetchData 有网络 → data
  const demo = analyzeUserScript('fixture/demo.user.js', FIXTURE, ROOT);
  const demoRoles = new Map(demo.functions.map((f) => [f.name, f.roles]));
  assert.deepEqual(demoRoles.get('storage.get'), ['state']);
  assert.deepEqual(demoRoles.get('fetchData'), ['data']);
  assert.ok(demoRoles.get('render').includes('render'));
});


// ---- 集成：纯油猴仓库（无 package.json）扫描 + 本体构建 ----

test('scanProject：纯油猴仓库 framework=userscript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-repo-'));
  try {
    fs.writeFileSync(path.join(dir, 'demo.user.js'), FIXTURE);
    const scan = scanProject(dir);
    assert.equal(scan.framework, 'userscript'); // 无 package.json + 存在油猴脚本
    assert.equal(scan.name, path.basename(dir)); // 项目名回退为目录名
    assert.equal(scan.userScriptFileCount, 1);
    assert.ok(scan.userScriptFiles.has('demo.user.js'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildOntologyData + blueprint：UserScript 五类对象与链接', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-build-'));
  try {
    fs.writeFileSync(path.join(dir, 'demo.user.js'), FIXTURE);
    const dataMap = await buildOntologyData(dir);
    const proj = dataMap.Project[0];
    assert.equal(proj.framework, 'userscript');
    assert.equal(proj.userScriptFileCount, 1);

    assert.equal(dataMap.UserScript.length, 1);
    const us = dataMap.UserScript[0];
    assert.equal(us.name, 'Test Demo Script');
    assert.equal(us.version, '1.0.0');
    assert.equal(us.hostFramework, 'unknown'); // fixture 无宿主标记
    assert.equal(us.riskLevel, 'high');
    // 与 React/Vue 体系互不干扰：油猴仓库不产出组件/路由
    assert.equal(dataMap.Component.length, 0);
    assert.equal(dataMap.Route.length, 0);
    // 五类对象
    assert.equal(dataMap.GmApiUsage.length, 4);
    assert.ok(dataMap.InjectionPoint.length >= 3);
    assert.ok(dataMap.NetworkEndpoint.length >= 2);
    assert.ok(dataMap.ScriptFunction.length >= 5);
    assert.equal(dataMap._meta.objectCounts.UserScript, 1);

    // blueprint 链接遍历
    const bp = createBlueprint(dataMap);
    const gmObjs = bp.link('usesGmApi', us.id);
    assert.equal(gmObjs.length, 4);
    const gmUsage = dataMap.GmApiUsage.find((g) => g.name === 'GM_addStyle');
    assert.equal(bp.link('usesGmApi', gmUsage.id)[0].id, us.id); // 反查所属脚本
    assert.ok(bp.link('injectsInto', us.id).length >= 3);
    assert.ok(bp.link('requestsTo', us.id).length >= 2);
    // 调用图：fetchData → render
    const fnFetch = dataMap.ScriptFunction.find((f) => f.name === 'fetchData');
    const callees = bp.link('calls', fnFetch.id);
    assert.ok(callees.some((c) => c.name === 'render'));
    const fnRender = dataMap.ScriptFunction.find((f) => f.name === 'render');
    assert.ok(bp.link('calledBy', fnRender.id).some((c) => c.name === 'fetchData'));
    // 逻辑注入链：注入点/网络端点携带归属函数（fns + fnIds 指向 ScriptFunction）
    const inj = dataMap.InjectionPoint.find((i) => i.kind === 'inner-html');
    assert.deepEqual(inj.fns, ['render']);
    assert.equal(inj.fnIds.length, 1);
    assert.equal(inj.fnIds[0], fnRender.id);
    const net = dataMap.NetworkEndpoint.find((n) => n.kind === 'gm-xhr');
    assert.deepEqual(net.fns, ['fetchData']);
    assert.equal(net.fnIds[0], fnFetch.id);
    // 函数业务角色透传
    assert.deepEqual(fnFetch.roles, ['data']);
    assert.ok(fnRender.roles.includes('render'));
    // contains：file: → us:
    const fileObjs = bp.link('contains', `file:demo.user.js`);
    assert.ok(fileObjs.some((o) => o.id === us.id));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
