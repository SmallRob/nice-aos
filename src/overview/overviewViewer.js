// 全景架构 viewer model + HTML 渲染（v0.45.0）
//
// 与既有 viewer（serviceViewer / deployViewer / dbViewer）保持自包含 / 零外部依赖 / 深蓝暗色主题一致性；
// 借鉴 serviceViewer 的"交互密度"思路，把原本只有 Tab 切换的 viewer 补齐：
//   - 服务搜索（services tab / tech tab 即时过滤 + 高亮）
//   - 框架过滤（tech tab：chips 多选）
//   - 端口过滤（deployment tab）
//   - 卡片点击展开（services / tech 卡：显示完整技术栈 / 端口 / 依赖）
//   - 复制按钮（服务名 / 端口 / 路径一键复制到剪贴板）
//   - URL hash 同步（#tab=xxx 可分享 / 刷新还原）
//   - 回到顶部浮动按钮
//
// 精简：
//   - 6 处 <table><thead> 模板拼接 → renderTable() 辅助函数
//   - 重复的 escape 拼接 → escapeHtml / escapeAttr 两个工具（合并老 escape）
//   - 6 张卡片统计行 → cardsHtml() 一处组装

// ============================================================================
// 0. escape 工具
// ============================================================================
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const escape = escapeHtml; // 兼容旧名（导出函数保留语义）

// 属性值转义：除 HTML 外，还需对引号敏感；保留 &/</> 转义但不像 HTML 那样彻底
function escapeAttr(s) {
  if (s == null) return '';
  return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
}

// ============================================================================
// 1. viewer model 聚合
// ============================================================================
export function buildOverviewViewerModel(overviewModel) {
  const t = overviewModel.totals || {};
  const m = overviewModel._meta || {};
  return {
    _meta: m,
    totals: t,
    projects: overviewModel.projects || [],
    layers: overviewModel.layers || {},
    applicationServices: overviewModel.applicationServices || [],
    languages: overviewModel.languages || {},
    architecture: overviewModel.architecture || {},
    humanKnowledge: overviewModel.humanKnowledge || { intent: [], resources: [], sources: [] },
  };
}

// ============================================================================
// 2. HTML 渲染辅助
// ============================================================================
// 渲染统一表格（替换 6 处 <table><thead><tbody> 模板拷贝）
function renderTable(headers, rows, opts = {}) {
  const numCol = new Set(opts.numCols || []);
  const empty = opts.empty || '暂无数据';
  if (rows.length === 0) return `<div class="empty">${escapeHtml(empty)}</div>`;
  const head = headers.map((h, i) => `<th${numCol.has(i) ? ' class="num"' : ''}>${escapeHtml(h.label)}${h.hint ? ` <small class="mut">${escapeHtml(h.hint)}</small>` : ''}</th>`).join('');
  const body = rows.map((r) => {
    const tds = r.map((cell, i) => `<td${numCol.has(i) ? ' class="num"' : ''}>${typeof cell === 'string' ? cell : (cell?.html ?? '')}</td>`).join('');
    return `<tr>${tds}</tr>`;
  }).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// ============================================================================
// 3. HTML 渲染
// ============================================================================
export function renderOverviewHtml(viewerModel, opts = {}) {
  const t = viewerModel.totals || {};
  const m = viewerModel._meta || {};
  const projects = viewerModel.projects || [];
  const layers = viewerModel.layers || {};
  const javaServices = viewerModel.applicationServices || [];
  const arch = viewerModel.architecture || {};
  const human = viewerModel.humanKnowledge || {};

  const css = `
  :root{
    --bg:#0b1220;--panel:#111a2e;--panel2:#16213a;--ink:#e6edf7;--mut:#8a98b4;
    --acc:#4dabf7;--acc2:#7c5cff;--ok:#10b981;--warn:#f59e0b;--err:#ef4444;--bdr:#1f2a44;
    --pink:#ec4899;--purple:#a78bfa;--orange:#f59e0b;--green:#10b981;
  }
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink);line-height:1.55}
  .wrap{max-width:1400px;margin:0 auto;padding:32px 28px 64px}
  h1{font-size:30px;margin:0 0 6px;background:linear-gradient(90deg,#4dabf7,#7c5cff,#ec4899);-webkit-background-clip:text;background-clip:text;color:transparent}
  h2{font-size:22px;margin:36px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--bdr)}
  h3{font-size:16px;margin:24px 0 10px;color:var(--acc)}
  .meta{color:var(--mut);font-size:13px;margin-bottom:18px;display:flex;gap:16px;flex-wrap:wrap}
  .meta b{color:var(--ink)}
  .topright{position:absolute;top:32px;right:32px;display:flex;gap:14px;color:var(--mut);font-size:12px}
  .topright .pill{background:var(--panel);border:1px solid var(--bdr);padding:4px 10px;border-radius:6px}
  .topright .pill b{color:var(--ink);font-size:14px;margin-left:4px}
  .cards{display:grid;grid-template-columns:repeat(6,1fr);gap:14px;margin:18px 0 28px}
  .card{background:var(--panel);border:1px solid var(--bdr);border-radius:10px;padding:16px 18px;position:relative;overflow:hidden}
  .card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--acc)}
  .card.c-services::before{background:var(--acc)}
  .card.c-backend::before{background:var(--orange)}
  .card.c-layers::before{background:var(--purple)}
  .card.c-int::before{background:var(--green)}
  .card.c-api::before{background:var(--pink)}
  .card.c-biz::before{background:var(--warn)}
  .card .k{color:var(--mut);font-size:12px;letter-spacing:.04em;text-transform:uppercase}
  .card .v{font-size:30px;font-weight:600;margin-top:6px}
  .card .v small{font-size:13px;color:var(--mut);font-weight:400;margin-left:4px}
  .toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 16px;padding:12px 14px;background:var(--panel);border:1px solid var(--bdr);border-radius:10px}
  .toolbar input[type="search"],.toolbar input[type="number"]{background:var(--bg);border:1px solid var(--bdr);color:var(--ink);padding:6px 10px;border-radius:6px;font-size:13px;outline:none}
  .toolbar input[type="search"]{min-width:220px}
  .toolbar input:focus{border-color:var(--acc)}
  .toolbar label{font-size:12px;color:var(--mut);display:flex;align-items:center;gap:6px}
  .toolbar .chip{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border:1px solid var(--bdr);border-radius:14px;background:var(--panel2);font-size:11px;color:var(--mut);cursor:pointer;user-select:none;transition:all .15s}
  .toolbar .chip:hover{color:var(--ink);border-color:var(--acc)}
  .toolbar .chip.on{background:rgba(77,171,247,.15);border-color:var(--acc);color:var(--acc)}
  .toolbar .sep{flex:1}
  .toolbar .meta-info{font-size:11px;color:var(--mut)}
  .tabs{display:flex;gap:6px;margin:24px 0 0;border-bottom:1px solid var(--bdr);padding-bottom:0;flex-wrap:wrap}
  .tab{padding:10px 18px;color:var(--mut);cursor:pointer;font-size:13px;border-bottom:2px solid transparent;margin-bottom:-1px;user-select:none;transition:color .15s,border-color .15s}
  .tab:hover{color:var(--ink)}
  .tab.active{color:var(--ink);border-bottom-color:var(--acc);background:var(--panel)}
  .panel{display:none;padding:24px 0 0}
  .panel.active{display:block}
  .layer{background:var(--panel);border:1px solid var(--bdr);border-radius:10px;padding:16px 20px;margin-bottom:14px;position:relative}
  .layer .lh{display:flex;align-items:center;gap:10px;margin-bottom:14px}
  .layer .lh .ico{font-size:18px}
  .layer .lh .title{font-size:15px;font-weight:600;color:var(--ink)}
  .layer .lh .title small{color:var(--mut);font-weight:400;margin-left:8px;font-size:12px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
  .svc{background:var(--panel2);border:1px solid var(--bdr);border-radius:8px;padding:10px 12px;position:relative;transition:transform .15s,border-color .15s;cursor:pointer}
  .svc:hover{transform:translateY(-2px);border-color:var(--acc)}
  .svc.expanded .tech,.svc.expanded .meta-detail{display:block}
  .svc .name{font-size:13px;font-weight:600;color:var(--ink);font-family:SF Mono,Menlo,Consolas,monospace}
  .svc .meta{font-size:11px;color:var(--mut);margin-top:2px;line-height:1.4}
  .svc .port{display:inline-block;padding:1px 6px;background:rgba(245,158,11,.15);color:var(--warn);border-radius:3px;font-size:10px;font-family:SF Mono,Menlo,monospace;margin-top:4px}
  .svc .tech{margin-top:6px;font-size:10px;color:var(--mut);line-height:1.3;max-height:3em;overflow:hidden}
  .svc .role{position:absolute;top:8px;right:8px;font-size:9px;padding:1px 5px;background:var(--panel);border:1px solid var(--bdr);border-radius:3px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}
  .svc .copy-btn{position:absolute;top:8px;left:8px;font-size:11px;padding:2px 6px;background:var(--panel);border:1px solid var(--bdr);border-radius:4px;color:var(--mut);cursor:pointer;opacity:0;transition:opacity .15s}
  .svc:hover .copy-btn{opacity:1}
  .svc .copy-btn:hover{color:var(--acc);border-color:var(--acc)}
  .svc .copy-btn.copied{color:var(--green);border-color:var(--green)}
  .svc .meta-detail{display:none;margin-top:8px;padding-top:8px;border-top:1px solid var(--bdr);font-size:11px;color:var(--mut);line-height:1.5}
  .svc .meta-detail b{color:var(--ink)}
  .svc.hit .name{background:rgba(245,158,11,.2);color:var(--warn);padding:0 2px;border-radius:2px}
  .svc.hide{display:none}
  .arrow{text-align:center;color:var(--mut);font-size:11px;padding:4px 0;letter-spacing:.5em}
  .arrow b{color:var(--ink);font-size:13px;font-family:SF Mono,Menlo,monospace;background:var(--panel);padding:3px 10px;border-radius:4px;border:1px solid var(--bdr);margin:0 6px}
  table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--bdr);border-radius:10px;overflow:hidden;margin:10px 0}
  th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--bdr);font-size:13px}
  th{background:var(--panel2);color:var(--mut);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  tr:last-child td{border-bottom:0}
  tr.hide{display:none}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  code{font-family:SF Mono,Menlo,Consolas,monospace;font-size:12px;background:var(--panel2);padding:1px 5px;border-radius:3px}
  a{color:var(--acc);text-decoration:none}
  a:hover{text-decoration:underline}
  .pill{display:inline-block;padding:2px 8px;border-radius:10px;background:var(--panel2);color:var(--acc);font-size:11px;margin-right:4px}
  .mut{color:var(--mut)}
  .legend{display:flex;flex-wrap:wrap;gap:12px;margin:14px 0 6px;font-size:12px}
  .legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:middle}
  .intent{background:var(--panel);border:1px solid var(--bdr);border-left:3px solid var(--acc);padding:14px 18px;border-radius:0 8px 8px 0;margin:8px 0}
  .intent .ititle{font-size:14px;font-weight:600;color:var(--ink);margin-bottom:6px}
  .intent .idesc{font-size:13px;color:var(--mut);line-height:1.6}
  .intent .itags{margin-top:8px;font-size:11px}
  .intent .itags .pill{background:rgba(77,171,247,.12);color:var(--acc)}
  .hk-src{font-size:11px;color:var(--mut);margin-top:6px}
  .hk-src a{color:var(--mut);text-decoration:underline}
  .res-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;margin:10px 0}
  .res-card{background:var(--panel2);border:1px solid var(--bdr);border-radius:8px;padding:10px 14px}
  .res-card .rname{font-size:13px;font-weight:600;color:var(--ink)}
  .res-card .rmeta{font-size:11px;color:var(--mut);margin-top:4px}
  .empty{padding:20px;color:var(--mut);text-align:center;font-size:13px;background:var(--panel2);border-radius:8px;border:1px dashed var(--bdr)}
  #back-top{position:fixed;right:24px;bottom:24px;width:42px;height:42px;border-radius:50%;background:var(--panel);border:1px solid var(--bdr);color:var(--ink);font-size:18px;cursor:pointer;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;box-shadow:0 4px 12px rgba(0,0,0,.4)}
  #back-top.show{opacity:1;pointer-events:auto}
  #back-top:hover{transform:translateY(-2px);border-color:var(--acc)}
  .toast{position:fixed;right:24px;bottom:78px;background:var(--panel2);border:1px solid var(--bdr);color:var(--ink);padding:8px 14px;border-radius:6px;font-size:12px;opacity:0;pointer-events:none;transform:translateY(10px);transition:opacity .2s,transform .2s;z-index:9}
  .toast.show{opacity:1;transform:translateY(0)}
  `;

  const tabs = [
    { id: 'overall', label: '整体架构', active: true },
    { id: 'services', label: '服务清单', active: false },
    { id: 'tech', label: '技术栈', active: false },
    { id: 'integration', label: '集成关系', active: false },
    { id: 'deployment', label: '部署拓扑', active: false },
    { id: 'intent', label: '设计意图', active: false },
    { id: 'resources', label: '资源需求', active: false },
  ];

  // ---------- 服务卡片 HTML ----------
  // 卡片可点击展开（services / tech tab）；复制按钮只对 .svc 生效
  function svcHtml(p, kind = 'project') {
    const port = p.javaServices && p.javaServices[0]?.port ? `<span class="port">:${p.javaServices[0].port}</span>` : '';
    const tech = (p.techStack || []).slice(0, 3).join(' · ') || p.framework;
    const fullTech = (p.techStack || []).join(' · ');
    const detail = p.note ? `<div class="meta-detail"><b>说明:</b> ${escapeHtml(p.note)}</div>` : '';
    const copyVal = escapeAttr(p.displayName || p.name || '');
    return `<div class="svc" data-name="${copyVal}" data-framework="${escapeAttr(p.framework || '')}" data-role="${escapeAttr(p.roleHint || '')}">
      <button class="copy-btn" type="button" title="复制名称">⧉</button>
      <div class="role">${escapeHtml(p.roleHint)}</div>
      <div class="name">${escapeHtml(p.displayName || p.name)}</div>
      <div class="meta">${escapeHtml(p.note || '')}</div>
      ${port}
      <div class="tech" data-full="${escapeAttr(fullTech)}">${escapeHtml(tech)}</div>
      ${detail}
    </div>`;
  }
  function javaSvcHtml(s) {
    const copyVal = escapeAttr(s.displayName || s.name || '');
    const portStr = s.port ? `:${s.port}` : '';
    return `<div class="svc" data-name="${copyVal}" data-framework="Spring Boot" data-role="Java微服务" data-port="${s.port || 0}">
      <button class="copy-btn" type="button" title="复制服务名">⧉</button>
      <div class="name">${escapeHtml(s.displayName || s.name)}</div>
      ${s.port ? `<span class="port">:${s.port}</span>` : ''}
      <div class="meta">${escapeHtml(s.description || s.appName || '')}</div>
      <div class="tech">Spring Boot · ${escapeHtml(s.parent || '')}</div>
      <div class="meta-detail">
        ${s.port ? `<b>端口:</b> <code>${s.port}</code><br>` : ''}
        ${s.appName ? `<b>Spring 名:</b> <code>${escapeHtml(s.appName)}</code><br>` : ''}
        ${s.artifactId ? `<b>Artifact:</b> <code>${escapeHtml(s.artifactId)}</code><br>` : ''}
        ${s.path ? `<b>路径:</b> <code>${escapeHtml(s.path)}</code>` : ''}
      </div>
    </div>`;
  }

  // ---------- 整体架构 Panel ----------
  const overallParts = [];
  overallParts.push('<h2>整体架构概览</h2>');
  overallParts.push(
    `<div class="intent"><div class="ititle">📐 扫描方式</div><div class="idesc">本蓝图聚合 <b>${t.projects}</b> 个项目 code-ontology 快照（含 <b>${t.javaServices}</b> 个 Java Spring Boot 微服务），单项目扫描命令 <code>nice-aos action refreshRepo</code>。人类架构知识（设计意图 / 资源需求）从 <code>${escapeHtml(m.humanKnowledgeFile || '—')}</code> 加载，5 层架构（client / gateway / application / integration / tool）从 <code>${escapeHtml(m.layoutFile || '—')}</code> 推断。</div></div>`,
  );

  const LAYER_DEFS = [
    { id: 'client', ico: '👤', title: '客户端层', subtitle: 'Client Layer' },
    { id: 'gateway', ico: '🔀', title: '网关层', subtitle: 'Gateway Layer' },
    { id: 'application', ico: '⚙️', title: '应用服务层', subtitle: 'Application Services' },
    { id: 'integration', ico: '🔌', title: '集成层', subtitle: 'Integration Layer' },
    { id: 'tool', ico: '🛠', title: '工具 / 运行时层', subtitle: 'Tool / Runtime Layer' },
    { id: 'repo', ico: '📦', title: '配置 / 文档仓库', subtitle: 'Config / Docs Repos' },
  ];
  for (const ld of LAYER_DEFS) {
    const items = layers[ld.id] || [];
    if (ld.id === 'application') {
      if (javaServices.length === 0 && items.length === 0) continue;
      overallParts.push(`<div class="layer"><div class="lh"><span class="ico">${ld.ico}</span><span class="title">${ld.title} <small>${ld.subtitle}（${items.length} 项目 + ${javaServices.length} Java 服务）</small></span></div>`);
      overallParts.push('<div class="grid">');
      for (const svc of javaServices) overallParts.push(javaSvcHtml(svc));
      for (const p of items) overallParts.push(svcHtml(p));
      overallParts.push('</div></div>');
    } else {
      if (items.length === 0) continue;
      overallParts.push(`<div class="layer"><div class="lh"><span class="ico">${ld.ico}</span><span class="title">${ld.title} <small>${ld.subtitle}（${items.length} 项）</small></span></div>`);
      overallParts.push('<div class="grid">');
      for (const p of items) overallParts.push(svcHtml(p));
      overallParts.push('</div></div>');
    }
    overallParts.push('<div class="arrow">↓ <b>调用 / 路由</b> ↓</div>');
  }

  // ---------- 服务清单 Panel ----------
  // 工具栏：搜索框 + 角色过滤
  const servicesRows = [];
  let row = 0;
  for (const s of javaServices) {
    row += 1;
    servicesRows.push([
      String(row),
      { html: `<b>${escapeHtml(s.displayName || s.name)}</b><br><span class="mut" style="font-size:10px">${escapeHtml(s.name)}</span>` },
      { html: '<span class="pill">Java 微服务</span>' },
      'application',
      '—',
      '—',
      { html: `Spring Boot${s.port ? ` · <code>${s.port}</code>` : ''}` },
    ]);
  }
  const sortedProjects = [...projects].sort((a, b) => b.totalLines - a.totalLines);
  for (const p of sortedProjects) {
    row += 1;
    servicesRows.push([
      String(row),
      { html: `<b>${escapeHtml(p.displayName || p.name)}</b>` },
      { html: `<span class="pill">${escapeHtml(p.roleHint)}</span>` },
      escapeHtml(p.layerHint),
      (p.fileCount || 0).toLocaleString(),
      (p.totalLines || 0).toLocaleString(),
      { html: `${escapeHtml(p.framework)}${p.frameworkVariants?.length ? ' · ' + escapeHtml(p.frameworkVariants.slice(0, 2).join(' / ')) : ''}` },
    ]);
  }
  const servicesParts = [];
  servicesParts.push('<h2>服务清单</h2>');
  servicesParts.push(
    `<div class="toolbar" data-toolbar="services" data-toolbar-for="services">
      <input type="search" placeholder="🔍 搜索项目 / 服务 / 框架" data-search-target="services">
      <label><input type="checkbox" data-role-filter value="Java 微服务"> 仅 Java 服务</label>
      <span class="sep"></span>
      <span class="meta-info" data-meta-info>共 ${servicesRows.length} 项</span>
    </div>`,
  );
  servicesParts.push(renderTable(
    [
      { label: '#' },
      { label: '名称' },
      { label: '角色' },
      { label: '架构层' },
      { label: '文件', hint: 'count' },
      { label: '行数', hint: 'count' },
      { label: '框架' },
    ],
    servicesRows,
    { numCols: [0, 4, 5], empty: '无项目数据' },
  ));

  // ---------- 技术栈 Panel ----------
  const techParts = [];
  techParts.push('<h2>技术栈矩阵</h2>');
  const byFramework = {};
  for (const p of projects) {
    const fw = p.framework || 'unknown';
    (byFramework[fw] = byFramework[fw] || []).push(p);
  }
  // 框架 chips 工具栏
  const fwChips = Object.entries(byFramework)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([fw, ps]) => `<span class="chip on" data-fw="${escapeAttr(fw)}">${escapeHtml(fw)} <small>(${ps.length})</small></span>`)
    .join('');
  techParts.push(
    `<div class="toolbar" data-toolbar="tech" data-toolbar-for="tech">
      <input type="search" placeholder="🔍 搜索技术栈" data-search-target="tech">
      <span class="sep"></span>
      ${fwChips}
      <span class="meta-info" data-meta-info></span>
    </div>`,
  );
  for (const [fw, ps] of Object.entries(byFramework).sort((a, b) => b[1].length - a[1].length)) {
    techParts.push(`<h3 data-fw-section="${escapeAttr(fw)}">${escapeHtml(fw)} <small class="mut" style="font-weight:400">（${ps.length} 个项目）</small></h3>`);
    techParts.push('<div class="grid">');
    for (const p of ps) {
      const tech = (p.techStack || []).slice(0, 3).join(' · ') || p.framework;
      const fullTech = (p.techStack || []).join(' · ');
      techParts.push(
        `<div class="svc" data-name="${escapeAttr(p.displayName || p.name)}" data-framework="${escapeAttr(fw)}">
          <button class="copy-btn" type="button" title="复制">⧉</button>
          <div class="name">${escapeHtml(p.displayName || p.name)}</div>
          <div class="tech" data-full="${escapeAttr(fullTech)}">${escapeHtml(tech)}</div>
        </div>`,
      );
    }
    techParts.push('</div>');
  }
  if (javaServices.length > 0) {
    techParts.push('<h3>Java 后端 <small class="mut" style="font-weight:400">（Spring Boot 微服务）</small></h3>');
    const javaRows = javaServices.map((s) => [
      { html: `<b>${escapeHtml(s.displayName || s.name)}</b>` },
      s.port ? { html: `<code>${s.port}</code>` } : '—',
      { html: `<code>${escapeHtml(s.appName || s.artifactId || s.name)}</code>` },
      escapeHtml(s.description || ''),
    ]);
    techParts.push(renderTable(
      [{ label: '服务' }, { label: '端口' }, { label: 'Spring 名' }, { label: '描述' }],
      javaRows,
      { numCols: [1], empty: '无 Java 服务数据' },
    ));
  }

  // ---------- 集成关系 Panel ----------
  const integrationParts = [];
  integrationParts.push('<h2>集成关系</h2>');
  const cross = arch.crossMatrix || {};
  const crossEntries = Object.entries(cross);
  if (crossEntries.length > 0) {
    integrationParts.push('<h3>1. 跨项目 npm 依赖</h3>');
    const crossRows = crossEntries.map(([src, deps]) => [
      `<b>${escapeHtml(src)}</b>`,
      { html: deps.map((d) => `<code>${escapeHtml(d)}</code>`).join(' ') },
    ]);
    integrationParts.push(renderTable(
      [{ label: '来源项目' }, { label: '依赖' }],
      crossRows,
      { empty: '未检测到跨项目 npm 依赖' },
    ));
  } else {
    integrationParts.push('<div class="empty">未检测到跨项目 npm 依赖</div>');
  }
  const javaCrossDeps = [];
  for (const p of projects) {
    for (const svc of p.javaServices || []) {
      for (const d of svc.dependencies || []) {
        if (d.startsWith('asdm-admin-services-') && d !== svc.name) {
          javaCrossDeps.push({ from: svc.name, to: d, scope: 'compile' });
        }
      }
    }
  }
  if (javaCrossDeps.length > 0) {
    integrationParts.push('<h3>2. Java 跨模块依赖（asdm-admin-services 内部）</h3>');
    const jRows = javaCrossDeps.map((d) => [
      { html: `<code>${escapeHtml(d.from)}</code>` },
      '→',
      { html: `<code>${escapeHtml(d.to)}</code>` },
    ]);
    integrationParts.push(renderTable(
      [{ label: '来源' }, { label: '→' }, { label: '目标' }],
      jRows,
      { empty: '无 Java 跨模块依赖' },
    ));
  }

  // ---------- 部署拓扑 Panel ----------
  const deploymentParts = [];
  deploymentParts.push('<h2>部署拓扑</h2>');
  const ports = arch.portAllocations || [];
  // 端口过滤工具栏
  deploymentParts.push(
    `<div class="toolbar" data-toolbar="deployment" data-toolbar-for="deployment">
      <input type="search" placeholder="🔍 搜索服务 / 配置" data-search-target="deployment">
      <label>端口范围:
        <input type="number" data-port-min placeholder="min" min="0" max="65535" style="width:80px">
        —
        <input type="number" data-port-max placeholder="max" min="0" max="65535" style="width:80px">
      </label>
      <span class="sep"></span>
      <span class="meta-info" data-meta-info></span>
    </div>`,
  );
  if (ports.length > 0) {
    deploymentParts.push('<h3>1. 端口分配总览</h3>');
    const portRows = ports.map((p) => [
      { html: `<b>${escapeHtml(p.service)}</b>${p.parent ? `<br><span class="mut" style="font-size:10px">${escapeHtml(p.parent)}</span>` : ''}` },
      p.port ? `<code>${p.port}</code>` : '—',
      { html: `<span class="pill">${escapeHtml(p.kind || '—')}</span>` },
      p.appName ? `<code>${escapeHtml(p.appName)}</code>` : '',
    ]);
    deploymentParts.push(renderTable(
      [{ label: '服务' }, { label: '端口' }, { label: '类型' }, { label: '备注' }],
      portRows,
      { numCols: [1], empty: '未检测到端口分配' },
    ));
  } else {
    deploymentParts.push('<div class="empty">未检测到端口分配</div>');
  }
  const composes = arch.composeRelations || [];
  if (composes.length > 0) {
    deploymentParts.push(`<h3>2. Docker Compose 服务关系（前 ${Math.min(50, composes.length)} 条）</h3>`);
    const composeRows = composes.map((r) => [
      escapeHtml(r.project),
      `<span class="mut" style="font-size:11px">${escapeHtml(r.compose || '')}</span>`,
      `<b>${escapeHtml(r.service)}</b>`,
      { html: r.kind === 'compose-port' ? `<code>${r.port}</code>` : `→ <code>${escapeHtml(r.dependsOn)}</code>` },
    ]);
    deploymentParts.push(renderTable(
      [{ label: '项目' }, { label: 'Compose' }, { label: '服务' }, { label: '关系' }],
      composeRows,
      { empty: '无 docker-compose 数据' },
    ));
  }
  const nginxRels = arch.nginxRelations || [];
  if (nginxRels.length > 0) {
    deploymentParts.push(`<h3>3. nginx 代理关系（前 ${Math.min(50, nginxRels.length)} 条）</h3>`);
    const nginxRows = nginxRels.map((r) => [
      escapeHtml(r.project),
      `<span class="mut" style="font-size:11px">${escapeHtml(r.config || '')}</span>`,
      { html: r.kind === 'proxy-pass'
          ? `<code>${escapeHtml(r.path)}</code> → <code>${escapeHtml(r.target)}</code>`
          : `listen <code>${r.listen}</code>` },
    ]);
    deploymentParts.push(renderTable(
      [{ label: '项目' }, { label: '配置' }, { label: '关系' }],
      nginxRows,
      { empty: '无 nginx 配置数据' },
    ));
  }

  // ---------- 设计意图 Panel ----------
  const intentParts = [];
  intentParts.push('<h2>设计意图 <small class="mut" style="font-size:14px;font-weight:400">（来自人类架构知识，可与代码事实交叉验证）</small></h2>');
  if ((human.intent || []).length > 0) {
    for (const it of human.intent) {
      const tags = (it.tags || []).map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join('');
      intentParts.push(
        `<div class="intent">
          <div class="ititle">${escapeHtml(it.title || '')}</div>
          <div class="idesc">${escapeHtml(it.description || '')}</div>
          ${tags ? `<div class="itags">${tags}</div>` : ''}
          ${it.source ? `<div class="hk-src">来源: <a href="${escapeAttr(it.source.href || '#')}">${escapeHtml(it.source.label || it.source.path || '')}</a></div>` : ''}
        </div>`,
      );
    }
  } else {
    intentParts.push(
      `<div class="empty">未提供人类架构知识（<code>--human-knowledge &lt;file&gt;</code>）。可参考 <code>cict-asdm/架构设计/ASDM架构.md</code> 手动整理为 JSON 后传入。示例：<pre style="text-align:left;font-size:11px;background:var(--panel2);padding:10px;border-radius:6px;margin-top:10px">{"intent":[{"title":"产品定位","description":"AI Coding Agent 的统一管理层","tags":["vendor-agnostic","mcp"],"source":{"label":"ASDM架构.md","path":"cict-asdm/架构设计/ASDM架构.md"}}]}</pre></div>`,
    );
  }
  if ((human.sources || []).length > 0) {
    intentParts.push('<h3>参考来源</h3><ul style="font-size:12px;color:var(--mut)">');
    for (const s of human.sources) {
      intentParts.push(`<li>${escapeHtml(s.label || s.path || '')}${s.path ? ` <code>${escapeHtml(s.path)}</code>` : ''}</li>`);
    }
    intentParts.push('</ul>');
  }

  // ---------- 资源需求 Panel ----------
  const resParts = [];
  resParts.push('<h2>资源需求 <small class="mut" style="font-size:14px;font-weight:400">（来自人类架构知识 / K8s / Compose）</small></h2>');
  if ((human.resources || []).length > 0) {
    resParts.push('<div class="res-grid">');
    for (const r of human.resources) {
      const meta = [];
      if (r.cpu) meta.push(`CPU: ${escapeHtml(r.cpu)}`);
      if (r.memory) meta.push(`内存: ${escapeHtml(r.memory)}`);
      if (r.replicas) meta.push(`副本: ${r.replicas}`);
      if (r.storage) meta.push(`存储: ${escapeHtml(r.storage)}`);
      resParts.push(
        `<div class="res-card">
          <div class="rname">${escapeHtml(r.name || r.service || '')}</div>
          <div class="rmeta">${meta.join(' · ')}</div>
          ${r.description ? `<div class="rmeta">${escapeHtml(r.description)}</div>` : ''}
        </div>`,
      );
    }
    resParts.push('</div>');
  } else {
    resParts.push(
      `<div class="empty">未提供资源需求数据。可整理 <code>cict-asdm/资源规划/服务资源清单表.md</code> + <code>asdm-*/deploy/docker-compose*.yml</code> 中的 <code>resources</code> 字段为 JSON 后通过 <code>--human-knowledge</code> 传入。</div>`,
    );
  }

  // ---------- 卡片统计行 ----------
  const cards = [
    ['c-services', '项目总数', t.projects, '个'],
    ['c-backend', '后端微服务', t.javaServices, 'Spring Boot'],
    ['c-layers', '架构分层', t.layers, '层'],
    ['c-int', '跨项目依赖', t.crossProjectDeps || 0, '条'],
    ['c-api', 'API 控制器', t.apiControllers || 0, '@RestController'],
    ['c-biz', '业务服务', t.businessServices || 0, '@Service/@Component'],
  ].map(([cls, k, v, small]) => `<div class="card ${cls}"><div class="k">${escapeHtml(k)}</div><div class="v">${v}<small>${escapeHtml(small)}</small></div></div>`).join('');

  // ---------- 组合最终 HTML ----------
  const parts = [];
  parts.push(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>全景架构蓝图（${t.projects} 项目 + ${t.javaServices} Java 服务）</title><style>${css}</style></head><body><div class="wrap">`);
  parts.push(`<h1>全景架构蓝图</h1>`);
  parts.push(`<div class="topright"><span class="pill">服务 <b>${t.projects + t.javaServices}</b></span><span class="pill">微服务 <b>${t.javaServices}</b></span><span class="pill">架构分层 <b>${t.layers}</b></span><span class="pill">总行数 <b>${(t.grandTotalLines || 0).toLocaleString()}</b></span></div>`);
  parts.push(`<div class="meta"><span>生成时间 <b>${escapeHtml(m.generatedAt || '—')}</b></span><span>扫描工具 <b>nice-aos v${escapeHtml(m.scannerVersion || '0.31.0')}</b></span><span>项目根 <b>${escapeHtml(m.projectsRoot || '—')}</b></span><span>布局 <b>${escapeHtml(m.layoutFile || '—')}</b></span><span>人类知识 <b>${escapeHtml(m.humanKnowledgeFile || '—')}</b></span></div>`);
  parts.push(`<div class="cards">${cards}</div>`);
  // Tab nav
  parts.push('<div class="tabs" id="tabs">');
  for (const tab of tabs) {
    parts.push(`<div class="tab ${tab.active ? 'active' : ''}" data-tab="${tab.id}">${escapeHtml(tab.label)}</div>`);
  }
  parts.push('</div>');
  // Panels
  parts.push(`<div class="panel active" data-panel="overall">${overallParts.join('')}</div>`);
  parts.push(`<div class="panel" data-panel="services">${servicesParts.join('')}</div>`);
  parts.push(`<div class="panel" data-panel="tech">${techParts.join('')}</div>`);
  parts.push(`<div class="panel" data-panel="integration">${integrationParts.join('')}</div>`);
  parts.push(`<div class="panel" data-panel="deployment">${deploymentParts.join('')}</div>`);
  parts.push(`<div class="panel" data-panel="intent">${intentParts.join('')}</div>`);
  parts.push(`<div class="panel" data-panel="resources">${resParts.join('')}</div>`);

  // 回到顶部 + toast
  parts.push('<button id="back-top" type="button" title="回到顶部">↑</button>');
  parts.push('<div class="toast" id="toast"></div>');

  // ---------- 交互脚本 ----------
  // 设计：模块化 IIFE，单一 document.DOMContentLoaded 入口
  // 1) Tab 切换 + URL hash 同步
  // 2) 服务清单搜索 + Java 过滤
  // 3) 技术栈搜索 + 框架 chips 多选
  // 4) 部署拓扑搜索 + 端口范围过滤
  // 5) 卡片点击展开 + 复制按钮
  // 6) 回到顶部按钮（滚动显示）
  // 7) Toast 提示
  parts.push(`
<script>
(function(){
  'use strict';
  // ---------- 工具 ----------
  function debounce(fn, ms){var t=null;return function(){var a=arguments,c=this;clearTimeout(t);t=setTimeout(function(){fn.apply(c,a);},ms);};}
  function escapeReg(s){return s.replace(/[-/\\\\^$*+?.()|[\\]{}]/g,'\\\\$&');}
  function showToast(msg){
    var el=document.getElementById('toast');
    if(!el) return;
    el.textContent=msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t=setTimeout(function(){el.classList.remove('show');},1600);
  }
  function copyText(text){
    if(navigator.clipboard && navigator.clipboard.writeText){
      return navigator.clipboard.writeText(text).then(function(){return true;},function(){return fallbackCopy(text);});
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text){
    try{
      var ta=document.createElement('textarea');
      ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
      document.body.appendChild(ta);ta.select();
      var ok=document.execCommand('copy');document.body.removeChild(ta);
      return ok;
    }catch(e){return false;}
  }

  // ---------- 1) Tab 切换 + hash 同步 ----------
  var tabs=document.querySelectorAll('#tabs .tab');
  var panels=document.querySelectorAll('.panel');
  function activate(tabId,push){
    tabs.forEach(function(t){t.classList.toggle('active',t.dataset.tab===tabId);});
    panels.forEach(function(p){p.classList.toggle('active',p.dataset.panel===tabId);});
    var t=document.querySelector('.tab[data-tab="'+tabId+'"]');
    if(t) t.scrollIntoView({behavior:'smooth',block:'start'});
    if(push && location.hash!=='#tab='+tabId){
      history.replaceState(null,'','#tab='+tabId);
    }
  }
  tabs.forEach(function(tab){
    tab.addEventListener('click',function(){activate(tab.dataset.tab,true);});
  });
  // 从 hash 还原（分享链接 / 刷新）
  var m=location.hash.match(/^#tab=([a-z]+)$/);
  if(m){
    var exists=Array.prototype.some.call(tabs,function(t){return t.dataset.tab===m[1];});
    if(exists) activate(m[1],false);
  }

  // ---------- 5) 卡片点击展开 + 复制按钮 ----------
  // 复制按钮点击不触发卡片展开
  document.addEventListener('click',function(ev){
    var btn=ev.target.closest('.svc .copy-btn');
    if(btn){
      ev.stopPropagation();
      var card=btn.closest('.svc');
      var name=card?card.dataset.name:'';
      if(!name) return;
      copyText(name).then(function(ok){
        if(ok){
          btn.classList.add('copied');
          btn.textContent='✓';
          setTimeout(function(){btn.classList.remove('copied');btn.textContent='⧉';},1200);
          showToast('已复制：'+name);
        }else{
          showToast('复制失败，请手动选择');
        }
      });
      return;
    }
    // 卡片本体点击 → 展开 / 收起
    var svc=ev.target.closest('.svc');
    if(svc){svc.classList.toggle('expanded');}
  });

  // ---------- 2) 服务清单：搜索 + Java 过滤 ----------
  var servicesPanel=document.querySelector('[data-toolbar-for="services"]');
  if(servicesPanel){
    var searchInput=servicesPanel.querySelector('input[type="search"]');
    var roleBox=servicesPanel.querySelector('[data-role-filter]');
    var metaInfo=servicesPanel.querySelector('[data-meta-info]');
    var table=servicesPanel.querySelector('table');
    var allRows=table?Array.prototype.slice.call(table.querySelectorAll('tbody tr')):[];
    var totalRows=allRows.length;
    function refilter(){
      var q=(searchInput?searchInput.value:'').trim().toLowerCase();
      var javaOnly=roleBox?roleBox.checked:false;
      var visible=0;
      allRows.forEach(function(r){
        var txt=r.textContent.toLowerCase();
        var isJava=r.textContent.indexOf('Java 微服务')>=0;
        var pass=(!q||txt.indexOf(q)!==-1)&&(!javaOnly||isJava);
        r.classList.toggle('hide',!pass);
        if(pass) visible++;
      });
      if(metaInfo) metaInfo.textContent='共 '+totalRows+' 项，显示 '+visible+' 项';
    }
    if(searchInput) searchInput.addEventListener('input',debounce(refilter,150));
    if(roleBox) roleBox.addEventListener('change',refilter);
    if(metaInfo && totalRows) metaInfo.textContent='共 '+totalRows+' 项';
  }

  // ---------- 3) 技术栈：搜索 + 框架 chips 多选 ----------
  var techPanel=document.querySelector('[data-toolbar-for="tech"]');
  if(techPanel){
    var techSearch=techPanel.querySelector('input[type="search"]');
    var chips=Array.prototype.slice.call(techPanel.querySelectorAll('.chip[data-fw]'));
    var sections=Array.prototype.slice.call(techPanel.querySelectorAll('[data-fw-section]'));
    var cards=Array.prototype.slice.call(techPanel.querySelectorAll('.grid .svc[data-framework]'));
    var techMeta=techPanel.querySelector('[data-meta-info]');
    var enabledFws=new Set(chips.map(function(c){return c.dataset.fw;}));
    function refilterTech(){
      var q=(techSearch?techSearch.value:'').trim().toLowerCase();
      var visible=0;
      cards.forEach(function(c){
        var fwOk=enabledFws.has(c.dataset.framework);
        var qOk=!q||c.dataset.name.toLowerCase().indexOf(q)!==-1;
        var pass=fwOk&&qOk;
        c.classList.toggle('hide',!pass);
        if(pass) visible++;
      });
      sections.forEach(function(sec){
        var fw=sec.dataset.fwSection;
        var inFw=Array.prototype.some.call(cards,function(c){return c.dataset.framework===fw&&!c.classList.contains('hide');});
        sec.style.display=enabledFws.has(fw)&&inFw?'':'none';
        var grid=sec.nextElementSibling;
        if(grid && grid.classList.contains('grid')) grid.style.display=enabledFws.has(fw)?'':'none';
      });
      if(techMeta) techMeta.textContent=cards.length+' 项目 / '+enabledFws.size+' 框架，显示 '+visible+' 项';
    }
    chips.forEach(function(chip){
      chip.addEventListener('click',function(){
        chip.classList.toggle('on');
        if(chip.classList.contains('on')) enabledFws.add(chip.dataset.fw);
        else enabledFws.delete(chip.dataset.fw);
        refilterTech();
      });
    });
    if(techSearch) techSearch.addEventListener('input',debounce(refilterTech,150));
    if(techMeta) techMeta.textContent=cards.length+' 项目 / '+enabledFws.size+' 框架';
  }

  // ---------- 4) 部署拓扑：搜索 + 端口范围 ----------
  var deployPanel=document.querySelector('[data-toolbar-for="deployment"]');
  if(deployPanel){
    var dSearch=deployPanel.querySelector('input[type="search"]');
    var pMin=deployPanel.querySelector('[data-port-min]');
    var pMax=deployPanel.querySelector('[data-port-max]');
    var dMeta=deployPanel.querySelector('[data-meta-info]');
    var dTables=Array.prototype.slice.call(deployPanel.querySelectorAll('table'));
    var dRows=[];
    dTables.forEach(function(t){dRows=dRows.concat(Array.prototype.slice.call(t.querySelectorAll('tbody tr')));});
    var dTotal=dRows.length;
    function refilterDeploy(){
      var q=(dSearch?dSearch.value:'').trim().toLowerCase();
      var lo=pMin&&pMin.value!==''?parseInt(pMin.value,10):null;
      var hi=pMax&&pMax.value!==''?parseInt(pMax.value,10):null;
      var visible=0;
      dRows.forEach(function(r){
        var txt=r.textContent.toLowerCase();
        var portMatch=r.textContent.match(/\\b(\\d{2,5})\\b/g);
        var inRange=true;
        if((lo!=null||hi!=null) && portMatch){
          inRange=false;
          for(var i=0;i<portMatch.length;i++){
            var p=parseInt(portMatch[i],10);
            if((lo==null||p>=lo)&&(hi==null||p<=hi)){inRange=true;break;}
          }
        }
        var qOk=!q||txt.indexOf(q)!==-1;
        var pass=qOk&&inRange;
        r.classList.toggle('hide',!pass);
        if(pass) visible++;
      });
      if(dMeta) dMeta.textContent='共 '+dTotal+' 条，显示 '+visible+' 条';
    }
    if(dSearch) dSearch.addEventListener('input',debounce(refilterDeploy,150));
    if(pMin) pMin.addEventListener('input',debounce(refilterDeploy,150));
    if(pMax) pMax.addEventListener('input',debounce(refilterDeploy,150));
    if(dMeta) dMeta.textContent='共 '+dTotal+' 条';
  }

  // ---------- 6) 回到顶部 ----------
  var backTop=document.getElementById('back-top');
  if(backTop){
    window.addEventListener('scroll',debounce(function(){
      backTop.classList.toggle('show',window.scrollY>400);
    },80));
    backTop.addEventListener('click',function(){
      window.scrollTo({top:0,behavior:'smooth'});
    });
  }
})();
</script>`);

  parts.push('</div></body></html>');
  return parts.join('');
}