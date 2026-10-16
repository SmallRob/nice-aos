// 蓝图客户端脚本片段。顺序由 viewerClient.js 拼接，勿单独重排。
export const OVERVIEW = `// ---------- Tab 1: 总览 ----------
function renderOverview() {
  const p = M.project;
  const el = document.getElementById('view-overview');
  const arch = p.architecture || {};
  const layers = arch.layers || [];
  const maxLayer = layers.length ? layers[0].fileCount : 0;
  const h = p.health || {};
  const capMap = Object.fromEntries((p.capabilities || []).map((c) => [c.domain, c.summary]));

  el.innerHTML =
    '<div class="panel"><h2>执行摘要</h2>'
    + '<ul class="plain">' + (p.summary || '').split('。').filter(Boolean).map((s) => '<li>' + esc(s) + '。</li>').join('') + '</ul>'
    + '<div class="note">分层依据内容信号推断（单元构成/路由归属/引用结构），目录名仅作弱信号回退。</div></div>'

    + '<div class="panel"><h2>健康度</h2><div class="chips">'
    + (h.cycleCount ? chip('循环依赖 ' + h.cycleCount, 'red') : chip('循环依赖 0', 'green'))
    + (h.orphanFileCount ? chip('死代码候选 ' + fmt(h.orphanFileCount), 'amber') : chip('死代码候选 0', 'green'))
    + (h.undeclaredDependencyCount ? chip('未声明依赖 ' + h.undeclaredDependencyCount, 'amber') : chip('未声明依赖 0', 'green'))
    + (h.highRiskScriptCount ? chip('高风险脚本 ' + h.highRiskScriptCount, 'red') : '')
    + (h.analysisErrorCount ? chip('解析错误 ' + h.analysisErrorCount, 'red') : chip('解析错误 0', 'green'))
    + '</div></div>'

    + '<div class="panel"><h2>架构分层</h2>'
    + layers.map((l) => barRow(l.label, l.fileCount, maxLayer, '', l.description)).join('')
    + '</div>'

    + '<div class="panel"><h2>功能域清单（' + M.domainCount + ' 个）</h2>'
    + table(
      [{ label: '功能域' }, { label: '能力画像', num: false }],
      M.domains.slice(0, 40).map((d) => [
        { v: d.name, html: '<b>' + esc(d.name) + '</b> ' + chip(d.fileCount + ' 文件', 'blue') },
        { v: capMap[d.name] || d.summary || '' },
      ]),
    )
    + (M.domains.length > 40 ? '<div class="note">仅显示前 40 个功能域，完整清单见"领域蓝图"页。</div>' : '')
    + '</div>'

    + '<div class="panel"><h2>本体蓝图（概念分类体系 v' + (M.blueprint.version || '') + '）</h2>'
    + '<div class="split"><div>'
    + '<h3>抽象层级</h3>'
    + table([{ label: '层级' }, { label: '名称' }, { label: '类型' }],
      M.blueprint.abstractionLevels.map((l) => [
        { v: l.level, html: chip(l.level, 'purple') },
        { v: l.name },
        { v: l.types.join(' / ') },
      ]))
    + '</div><div>'
    + '<h3>对象实例计数</h3>'
    + table([{ label: '类型' }, { label: '范畴' }, { label: '层级', num: true }, { label: '数量', num: true }],
      M.blueprint.objectTypes.map((t) => [
        { v: t.type, html: '<b>' + esc(t.type) + '</b> <span class="path">' + esc(t.prefix) + '</span>' },
        { v: t.category },
        { v: t.level },
        { v: fmt(t.count), num: true },
      ]))
    + '</div></div>'
    + '<h3>链接类型（' + M.blueprint.linkTypes.length + ' 种）</h3>'
    + '<div class="chips">' + M.blueprint.linkTypes.map((l) => chip(l, 'cyan')).join('') + '</div>'
    + '<div class="note">想看类型与边按概念范畴 + 抽象层级的双维组织、活跃类型实例计数与样本预览？跳到 <b>本体概览</b> Tab。</div>'
    + '</div>';
}

`;
