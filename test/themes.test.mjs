// 主题模块测试：注册表解析 / 变量块生成 / 共享骨架 / 炫彩圆环 / 三个查看器的主题注入
import test from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, DEFAULT_THEMES, resolveTheme, buildThemeCss, listThemeNames } from '../src/themes/index.js';
import { SHARED_CSS } from '../src/themes/sharedCss.js';
import { RING_STYLES, RING_JS } from '../src/themes/ring.js';
import { renderDeployOverviewHtml } from '../src/deployment/deployViewer.js';
import { renderDbOverviewHtml } from '../src/database/dbViewer.js';
import { renderViewerHtml } from '../src/ontology/viewer.js';

test('主题注册表包含 deep-blue / fresh-green / elegant-purple', () => {
  const names = listThemeNames();
  assert.ok(names.includes('deep-blue'));
  assert.ok(names.includes('fresh-green'));
  assert.ok(names.includes('elegant-purple'));
  assert.equal(THEMES['deep-blue'].dark, true);
  assert.equal(THEMES['fresh-green'].dark, false);
  assert.equal(THEMES['elegant-purple'].dark, true);
});

test('resolveTheme 合法名返回主题，非法名抛错并列出可选项', () => {
  assert.equal(resolveTheme('deep-blue'), THEMES['deep-blue']);
  assert.throws(() => resolveTheme('not-exist'), /未知主题: not-exist/);
  assert.throws(() => resolveTheme('not-exist'), /deep-blue/);
  assert.throws(() => resolveTheme(''), /主题名不能为空/);
});

test('buildThemeCss 输出 :root[data-theme] 变量块并带 color-scheme', () => {
  const css = buildThemeCss('deep-blue');
  assert.ok(css.startsWith(':root[data-theme="deep-blue"]'));
  assert.ok(css.includes('--bg: #0d1117'));
  assert.ok(css.includes('--blue: #58a6ff'));
  assert.ok(css.includes('--fg-faint'));
  assert.ok(css.includes('color-scheme: dark'));
  assert.ok(buildThemeCss('fresh-green').includes('color-scheme: light'));
  assert.ok(buildThemeCss('elegant-purple').includes('--bg: #12101f'));
  assert.ok(buildThemeCss('elegant-purple').includes('color-scheme: dark'));
});

test('buildThemeCss 支持追加查看器私有变量', () => {
  const css = buildThemeCss('deep-blue', { '--teal': '#00b4ab' });
  assert.ok(css.includes('--teal: #00b4ab'));
  assert.ok(css.includes('--blue: #58a6ff'));
});

test('共享骨架非空且关键规则齐备', () => {
  assert.ok(SHARED_CSS.length > 500);
  for (const rule of ['.stats .stat', '.tab-btn, .tab', 'section.view.active', '.panel {', 'tr:hover td', '.metric-card', '@media (max-width: 768px)']) {
    assert.ok(SHARED_CSS.includes(rule), `缺少规则: ${rule}`);
  }
  // 透明色必须从主题变量派生，不允许硬编码 rgba
  assert.ok(!SHARED_CSS.includes('rgba('));
});

test('默认主题分配：deploy=deep-blue / db=fresh-green / code=deep-blue', () => {
  assert.equal(DEFAULT_THEMES.deploy, 'deep-blue');
  assert.equal(DEFAULT_THEMES.db, 'fresh-green');
  assert.equal(DEFAULT_THEMES.code, 'deep-blue');
});

test('部署蓝图默认注入 deep-blue 主题且可切换', () => {
  const model = { meta: { sourceDir: '/x/deploy', scannedAt: '2026-08-23T00:00:00Z' }, topologyLayers: [], services: [], routes: [], upstreams: [], dependencies: [], middleware: [], environments: [], files: [], layers: [], audits: {} };
  const html = renderDeployOverviewHtml(model);
  assert.ok(html.includes('data-theme="deep-blue"'));
  assert.ok(html.includes('--bg: #0d1117'));
  assert.ok(html.includes('.topo-layer'));
  const green = renderDeployOverviewHtml(model, { theme: 'fresh-green' });
  assert.ok(green.includes('data-theme="fresh-green"'));
  assert.ok(green.includes('--bg: #f3f8f4'));
  assert.ok(green.includes('.topo-layer'));
});

test('数据库蓝图默认注入 fresh-green 主题且可切换', () => {
  const model = { meta: { sourceDir: '/x/1.mysql' }, tables: [], foreignKeys: [], migrations: [], domains: [], views: [], triggers: [], procedures: [], patterns: [], health: {}, evolution: {}, indexes: {}, naming: {}, fkGraph: { nodes: [], edges: [] } };
  const html = renderDbOverviewHtml(model);
  assert.ok(html.includes('data-theme="fresh-green"'));
  assert.ok(html.includes('--bg: #f3f8f4'));
  assert.ok(html.includes('.er-container'));
  const dark = renderDbOverviewHtml(model, { theme: 'deep-blue' });
  assert.ok(dark.includes('data-theme="deep-blue"'));
  assert.ok(dark.includes('--bg: #0d1117'));
  assert.ok(dark.includes('.er-container'));
});

test('代码蓝图默认 deep-blue 并保留 teal/go 私有变量', () => {
  const model = { project: { name: 't' }, views: {} };
  const html = renderViewerHtml(model);
  assert.ok(html.includes('data-theme="deep-blue"'));
  assert.ok(html.includes('--teal: #00b4ab'));
  assert.ok(html.includes('--go: #00add8'));
  assert.ok(html.includes('--content-w: 1400px'));
  assert.ok(html.includes('svg.uml'));
  const green = renderViewerHtml(model, { theme: 'fresh-green' });
  assert.ok(green.includes('--bg: #f3f8f4'));
  assert.ok(green.includes('--teal: #00b4ab'));
});

test('炫彩圆环：三主题渐变配置齐备', () => {
  for (const name of listThemeNames()) {
    const conf = RING_STYLES[name];
    assert.ok(conf, `缺少环配置: ${name}`);
    assert.ok(/^#[0-9a-f]{6}$/i.test(conf.from), `${name}.from 应为 hex`);
    assert.ok(/^#[0-9a-f]{6}$/i.test(conf.to), `${name}.to 应为 hex`);
    assert.ok(conf.track.startsWith('rgba('), `${name}.track 应为 rgba`);
    assert.ok(conf.dim.startsWith('#'), `${name}.dim 应为 hex`);
  }
  assert.equal(RING_STYLES['deep-blue'].from, '#a78bfa');
  assert.equal(RING_STYLES['deep-blue'].to, '#4ade80');
  assert.equal(RING_STYLES['fresh-green'].from, '#a7f3d0');
  assert.equal(RING_STYLES['fresh-green'].to, '#059669');
  assert.equal(RING_STYLES['elegant-purple'].from, '#c084fc');
  assert.equal(RING_STYLES['elegant-purple'].to, '#f0abfc');
});

test('炫彩圆环：客户端函数按主题生成 SVG 能量环', () => {
  const origDoc = globalThis.document;
  const origRaf = globalThis.requestAnimationFrame;
  globalThis.document = {
    documentElement: { getAttribute: () => 'deep-blue' },
    querySelectorAll: () => [],
  };
  globalThis.requestAnimationFrame = (fn) => { fn(() => {}); return 0; };
  try {
    const scoreRingSvg = new Function(RING_JS + '; return scoreRingSvg;')();
    const svg = scoreRingSvg(71, { label: '等级 C' });
    assert.ok(svg.startsWith('<svg'));
    assert.ok(svg.includes('linearGradient'));
    assert.ok(svg.includes('feGaussianBlur'));
    assert.ok(svg.includes('stroke-linecap="round"'));
    assert.ok(svg.includes('rotate(-90'));
    assert.ok(svg.includes('>71<'));
    assert.ok(svg.includes('等级 C'));
    assert.ok(svg.includes('aria-label="健康评分 71"'));
    // deep-blue 渐变端点与插值色
    assert.ok(svg.includes('#a78bfa') && svg.includes('#4ade80'));
    assert.ok(/stop offset="71%" stop-color="rgb\(\d+,\d+,\d+\)"/.test(svg));
    // 主题切换：fresh-green
    globalThis.document.documentElement = { getAttribute: () => 'fresh-green' };
    const green = scoreRingSvg(90);
    assert.ok(green.includes('#a7f3d0') && green.includes('#059669'));
    assert.ok(green.includes('rgba(22,101,52,0.10)'));
    // 主题切换：elegant-purple
    globalThis.document.documentElement = { getAttribute: () => 'elegant-purple' };
    const purple = scoreRingSvg(85);
    assert.ok(purple.includes('#c084fc') && purple.includes('#f0abfc'));
    // 边界值
    assert.ok(scoreRingSvg(0).includes('>0<') && !scoreRingSvg(0).includes('NaN'));
    assert.ok(scoreRingSvg(100).includes('>100<') && !scoreRingSvg(100).includes('NaN'));
    // 未知主题回退 deep-blue
    globalThis.document.documentElement = { getAttribute: () => 'unknown' };
    assert.ok(scoreRingSvg(50).includes('#a78bfa'));
  } finally {
    globalThis.document = origDoc;
    globalThis.requestAnimationFrame = origRaf;
  }
});

test('部署与数据库蓝图嵌入炫彩圆环客户端代码', () => {
  const deployModel = { meta: { sourceDir: '/x/deploy', scannedAt: '2026-08-23T00:00:00Z' }, topologyLayers: [], services: [], routes: [], upstreams: [], dependencies: [], middleware: [], environments: [], files: [], layers: [], audits: {} };
  const deployHtml = renderDeployOverviewHtml(deployModel);
  assert.ok(deployHtml.includes('function scoreRingSvg'));
  assert.ok(deployHtml.includes('RING_STYLES'));
  assert.ok(deployHtml.includes('.score-ring-svg circle.score-arc'));
  assert.ok(deployHtml.includes('prefers-reduced-motion'));

  const dbModel = { meta: { sourceDir: '/x/1.mysql' }, tables: [], foreignKeys: [], migrations: [], domains: [], views: [], triggers: [], procedures: [], patterns: [], health: {}, evolution: {}, indexes: {}, naming: {}, fkGraph: { nodes: [], edges: [] } };
  const dbHtml = renderDbOverviewHtml(dbModel, { theme: 'elegant-purple' });
  assert.ok(dbHtml.includes('function scoreRingSvg'));
  assert.ok(dbHtml.includes('data-theme="elegant-purple"'));
});

test('数据库蓝图支持典雅紫主题导出', () => {
  const model = { meta: { sourceDir: '/x/1.mysql' }, tables: [], foreignKeys: [], migrations: [], domains: [], views: [], triggers: [], procedures: [], patterns: [], health: {}, evolution: {}, indexes: {}, naming: {}, fkGraph: { nodes: [], edges: [] } };
  const html = renderDbOverviewHtml(model, { theme: 'elegant-purple' });
  assert.ok(html.includes('data-theme="elegant-purple"'));
  assert.ok(html.includes('--bg: #12101f'));
  assert.ok(html.includes('--blue: #a78bfa'));
  assert.ok(html.includes('color-scheme: dark'));
});
