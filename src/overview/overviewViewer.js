// 全景架构 viewer model + HTML 渲染
// 借鉴 serviceViewer / deployViewer / dbViewer 模式：buildOverviewViewerModel + renderOverviewHtml
// 与既有 viewer 保持自包含、零外部依赖、深蓝暗色主题一致性

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
// 2. HTML 渲染
// ============================================================================
export function renderOverviewHtml(viewerModel, opts = {}) {
  const t = viewerModel.totals || {};
  const m = viewerModel._meta || {};
  const projects = viewerModel.projects || [];
  const layers = viewerModel.layers || {};
  const javaServices = viewerModel.applicationServices || [];
  const langs = viewerModel.languages || {};
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
  .svc{background:var(--panel2);border:1px solid var(--bdr);border-radius:8px;padding:10px 12px;position:relative;transition:transform .15s,border-color .15s}
  .svc:hover{transform:translateY(-2px);border-color:var(--acc)}
  .svc .name{font-size:13px;font-weight:600;color:var(--ink);font-family:SF Mono,Menlo,Consolas,monospace}
  .svc .meta{font-size:11px;color:var(--mut);margin-top:2px;line-height:1.4}
  .svc .port{display:inline-block;padding:1px 6px;background:rgba(245,158,11,.15);color:var(--warn);border-radius:3px;font-size:10px;font-family:SF Mono,Menlo,monospace;margin-top:4px}
  .svc .tech{margin-top:6px;font-size:10px;color:var(--mut);line-height:1.3;max-height:3em;overflow:hidden}
  .svc .role{position:absolute;top:8px;right:8px;font-size:9px;padding:1px 5px;background:var(--panel);border:1px solid var(--bdr);border-radius:3px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}
  .arrow{text-align:center;color:var(--mut);font-size:11px;padding:4px 0;letter-spacing:.5em}
  .arrow b{color:var(--ink);font-size:13px;font-family:SF Mono,Menlo,monospace;background:var(--panel);padding:3px 10px;border-radius:4px;border:1px solid var(--bdr);margin:0 6px}
  table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--bdr);border-radius:10px;overflow:hidden;margin:10px 0}
  th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--bdr);font-size:13px}
  th{background:var(--panel2);color:var(--mut);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  tr:last-child td{border-bottom:0}
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
  const renderSvc = (p) => {
    const port = p.javaServices && p.javaServices[0]?.port ? `<span class="port">:${p.javaServices[0].port}</span>` : '';
    const tech = (p.techStack || []).slice(0, 3).join(' · ') || p.framework;
    return `<div class="svc">
      <div class="role">${p.roleHint}</div>
      <div class="name">${escape(p.displayName || p.name)}</div>
      <div class="meta">${escape(p.note || '')}</div>
      ${port}
      <div class="tech">${escape(tech)}</div>
    </div>`;
  };

  const renderJavaSvc = (s) => {
    return `<div class="svc">
      <div class="name">${escape(s.displayName || s.name)}</div>
      ${s.port ? `<span class="port">:${s.port}</span>` : ''}
      <div class="meta">${escape(s.description || s.appName || '')}</div>
      <div class="tech">Spring Boot · ${escape(s.parent || '')}</div>
    </div>`;
  };

  // ---------- 整体架构 Panel ----------
  const overallParts = [];
  overallParts.push('<h2>整体架构概览</h2>');
  overallParts.push(
    `<div class="intent"><div class="ititle">📐 扫描方式</div><div class="idesc">本蓝图聚合 <b>${t.projects}</b> 个项目 code-ontology 快照（含 <b>${t.javaServices}</b> 个 Java Spring Boot 微服务），单项目扫描命令 <code>nice-aos action refreshRepo</code>。人类架构知识（设计意图 / 资源需求）从 <code>${escape(m.humanKnowledgeFile || '—')}</code> 加载，5 层架构（client / gateway / application / integration / tool）从 <code>${escape(m.layoutFile || '—')}</code> 推断。</div></div>`,
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
      // 先放 Java 服务（更细粒度）
      for (const svc of javaServices) overallParts.push(renderJavaSvc(svc));
      // 再放非 Java 项目
      for (const p of items) overallParts.push(renderSvc(p));
      overallParts.push('</div></div>');
    } else {
      if (items.length === 0) continue;
      overallParts.push(`<div class="layer"><div class="lh"><span class="ico">${ld.ico}</span><span class="title">${ld.title} <small>${ld.subtitle}（${items.length} 项）</small></span></div>`);
      overallParts.push('<div class="grid">');
      for (const p of items) overallParts.push(renderSvc(p));
      overallParts.push('</div></div>');
    }
    overallParts.push('<div class="arrow">↓ <b>调用 / 路由</b> ↓</div>');
  }

  // ---------- 服务清单 Panel ----------
  const servicesParts = [];
  servicesParts.push('<h2>服务清单</h2>');
  servicesParts.push(`<p class="mut">共 <b>${projects.length}</b> 个项目 + <b>${javaServices.length}</b> 个 Java 微服务</p>`);
  servicesParts.push('<table><thead><tr><th>#</th><th>名称</th><th>角色</th><th>架构层</th><th class="num">文件</th><th class="num">行数</th><th>框架</th></tr></thead><tbody>');
  let row = 0;
  for (const s of javaServices) {
    row += 1;
    servicesParts.push(`<tr><td>${row}</td><td><b>${escape(s.displayName || s.name)}</b><br><span class="mut" style="font-size:10px">${escape(s.name)}</span></td><td><span class="pill">Java 微服务</span></td><td>application</td><td class="num">—</td><td class="num">—</td><td>Spring Boot${s.port ? ` · <code>${s.port}</code>` : ''}</td></tr>`);
  }
  for (const p of [...projects].sort((a, b) => b.totalLines - a.totalLines)) {
    row += 1;
    servicesParts.push(`<tr><td>${row}</td><td><b>${escape(p.displayName || p.name)}</b></td><td><span class="pill">${p.roleHint}</span></td><td>${p.layerHint}</td><td class="num">${p.fileCount.toLocaleString()}</td><td class="num">${p.totalLines.toLocaleString()}</td><td>${p.framework}${p.frameworkVariants?.length ? ' · ' + p.frameworkVariants.slice(0, 2).join(' / ') : ''}</td></tr>`);
  }
  servicesParts.push('</tbody></table>');

  // ---------- 技术栈 Panel ----------
  const techParts = [];
  techParts.push('<h2>技术栈矩阵</h2>');
  const byFramework = {};
  for (const p of projects) {
    const fw = p.framework || 'unknown';
    byFramework[fw] = byFramework[fw] || [];
    byFramework[fw].push(p);
  }
  for (const [fw, ps] of Object.entries(byFramework).sort((a, b) => b[1].length - a[1].length)) {
    techParts.push(`<h3>${escape(fw)} <small class="mut" style="font-weight:400">（${ps.length} 个项目）</small></h3>`);
    techParts.push('<div class="grid">');
    for (const p of ps) {
      const tech = (p.techStack || []).slice(0, 3).join(' · ') || p.framework;
      techParts.push(`<div class="svc"><div class="name">${escape(p.displayName || p.name)}</div><div class="tech">${escape(tech)}</div></div>`);
    }
    techParts.push('</div>');
  }
  // Java 详细
  if (javaServices.length > 0) {
    techParts.push('<h3>Java 后端 <small class="mut" style="font-weight:400">（Spring Boot 微服务）</small></h3>');
    techParts.push('<table><thead><tr><th>服务</th><th class="num">端口</th><th>Spring 名</th><th>描述</th></tr></thead><tbody>');
    for (const s of javaServices) {
      techParts.push(`<tr><td><b>${escape(s.displayName || s.name)}</b></td><td class="num">${s.port ? `<code>${s.port}</code>` : '—'}</td><td><code>${escape(s.appName || s.artifactId || s.name)}</code></td><td>${escape(s.description || '')}</td></tr>`);
    }
    techParts.push('</tbody></table>');
  }

  // ---------- 集成关系 Panel ----------
  const integrationParts = [];
  integrationParts.push('<h2>集成关系</h2>');
  const cross = arch.crossMatrix || {};
  const crossEntries = Object.entries(cross);
  if (crossEntries.length > 0) {
    integrationParts.push('<h3>1. 跨项目 npm 依赖</h3>');
    integrationParts.push('<table><thead><tr><th>来源项目</th><th>依赖</th></tr></thead><tbody>');
    for (const [src, deps] of crossEntries) {
      integrationParts.push(`<tr><td><b>${escape(src)}</b></td><td>${deps.map((d) => `<code>${escape(d)}</code>`).join(' ')}</td></tr>`);
    }
    integrationParts.push('</tbody></table>');
  } else {
    integrationParts.push('<div class="empty">未检测到跨项目 npm 依赖</div>');
  }

  // 跨 Java 模块依赖
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
    integrationParts.push('<table><thead><tr><th>来源</th><th>→</th><th>目标</th></tr></thead><tbody>');
    for (const d of javaCrossDeps) {
      integrationParts.push(`<tr><td><code>${escape(d.from)}</code></td><td>→</td><td><code>${escape(d.to)}</code></td></tr>`);
    }
    integrationParts.push('</tbody></table>');
  }

  // ---------- 部署拓扑 Panel ----------
  const deploymentParts = [];
  deploymentParts.push('<h2>部署拓扑</h2>');
  const ports = arch.portAllocations || [];
  if (ports.length > 0) {
    deploymentParts.push('<h3>1. 端口分配总览</h3>');
    deploymentParts.push('<table><thead><tr><th>服务</th><th class="num">端口</th><th>类型</th><th>备注</th></tr></thead><tbody>');
    for (const p of ports) {
      deploymentParts.push(`<tr><td><b>${escape(p.service)}</b>${p.parent ? `<br><span class="mut" style="font-size:10px">${escape(p.parent)}</span>` : ''}</td><td class="num">${p.port ? `<code>${p.port}</code>` : '—'}</td><td><span class="pill">${escape(p.kind || '—')}</span></td><td>${p.appName ? `<code>${escape(p.appName)}</code>` : ''}</td></tr>`);
    }
    deploymentParts.push('</tbody></table>');
  } else {
    deploymentParts.push('<div class="empty">未检测到端口分配</div>');
  }
  const composes = arch.composeRelations || [];
  if (composes.length > 0) {
    deploymentParts.push(`<h3>2. Docker Compose 服务关系（前 ${Math.min(50, composes.length)} 条）</h3>`);
    deploymentParts.push('<table><thead><tr><th>项目</th><th>Compose</th><th>服务</th><th>关系</th></tr></thead><tbody>');
    for (const r of composes) {
      const rel = r.kind === 'compose-port' ? `<code>${r.port}</code>` : `→ <code>${escape(r.dependsOn)}</code>`;
      deploymentParts.push(`<tr><td>${escape(r.project)}</td><td><span class="mut" style="font-size:11px">${escape(r.compose || '')}</span></td><td><b>${escape(r.service)}</b></td><td>${rel}</td></tr>`);
    }
    deploymentParts.push('</tbody></table>');
  }
  const nginxRels = arch.nginxRelations || [];
  if (nginxRels.length > 0) {
    deploymentParts.push(`<h3>3. nginx 代理关系（前 ${Math.min(50, nginxRels.length)} 条）</h3>`);
    deploymentParts.push('<table><thead><tr><th>项目</th><th>配置</th><th>关系</th></tr></thead><tbody>');
    for (const r of nginxRels) {
      const rel = r.kind === 'proxy-pass'
        ? `<code>${escape(r.path)}</code> → <code>${escape(r.target)}</code>`
        : `listen <code>${r.listen}</code>`;
      deploymentParts.push(`<tr><td>${escape(r.project)}</td><td><span class="mut" style="font-size:11px">${escape(r.config || '')}</span></td><td>${rel}</td></tr>`);
    }
    deploymentParts.push('</tbody></table>');
  }

  // ---------- 设计意图 Panel（人类架构知识） ----------
  const intentParts = [];
  intentParts.push('<h2>设计意图 <small class="mut" style="font-size:14px;font-weight:400">（来自人类架构知识，可与代码事实交叉验证）</small></h2>');
  if ((human.intent || []).length > 0) {
    for (const it of human.intent) {
      const tags = (it.tags || []).map((tag) => `<span class="pill">${escape(tag)}</span>`).join('');
      intentParts.push(
        `<div class="intent">
          <div class="ititle">${escape(it.title || '')}</div>
          <div class="idesc">${escape(it.description || '')}</div>
          ${tags ? `<div class="itags">${tags}</div>` : ''}
          ${it.source ? `<div class="hk-src">来源: <a href="${escape(it.source.href || '#')}">${escape(it.source.label || it.source.path || '')}</a></div>` : ''}
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
      intentParts.push(`<li>${escape(s.label || s.path || '')}${s.path ? ` <code>${escape(s.path)}</code>` : ''}</li>`);
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
      if (r.cpu) meta.push(`CPU: ${escape(r.cpu)}`);
      if (r.memory) meta.push(`内存: ${escape(r.memory)}`);
      if (r.replicas) meta.push(`副本: ${r.replicas}`);
      if (r.storage) meta.push(`存储: ${escape(r.storage)}`);
      resParts.push(
        `<div class="res-card">
          <div class="rname">${escape(r.name || r.service || '')}</div>
          <div class="rmeta">${meta.join(' · ')}</div>
          ${r.description ? `<div class="rmeta">${escape(r.description)}</div>` : ''}
        </div>`,
      );
    }
    resParts.push('</div>');
  } else {
    resParts.push(
      `<div class="empty">未提供资源需求数据。可整理 <code>cict-asdm/资源规划/服务资源清单表.md</code> + <code>asdm-*/deploy/docker-compose*.yml</code> 中的 <code>resources</code> 字段为 JSON 后通过 <code>--human-knowledge</code> 传入。</div>`,
    );
  }

  // ---------- 组合最终 HTML ----------
  const parts = [];
  parts.push(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>全景架构蓝图（${t.projects} 项目 + ${t.javaServices} Java 服务）</title><style>${css}</style></head><body><div class="wrap">`);
  parts.push(`<h1>全景架构蓝图</h1>`);
  parts.push(`<div class="topright"><span class="pill">服务 <b>${t.projects + t.javaServices}</b></span><span class="pill">微服务 <b>${t.javaServices}</b></span><span class="pill">架构分层 <b>${t.layers}</b></span><span class="pill">总行数 <b>${(t.grandTotalLines || 0).toLocaleString()}</b></span></div>`);
  parts.push(`<div class="meta"><span>生成时间 <b>${m.generatedAt || '—'}</b></span><span>扫描工具 <b>nice-aos v${m.scannerVersion || '0.31.0'}</b></span><span>项目根 <b>${escape(m.projectsRoot || '—')}</b></span><span>布局 <b>${escape(m.layoutFile || '—')}</b></span><span>人类知识 <b>${escape(m.humanKnowledgeFile || '—')}</b></span></div>`);

  // 6 张统计卡
  parts.push('<div class="cards">');
  parts.push(`<div class="card c-services"><div class="k">项目总数</div><div class="v">${t.projects}<small>个</small></div></div>`);
  parts.push(`<div class="card c-backend"><div class="k">后端微服务</div><div class="v">${t.javaServices}<small>Spring Boot</small></div></div>`);
  parts.push(`<div class="card c-layers"><div class="k">架构分层</div><div class="v">${t.layers}<small>层</small></div></div>`);
  parts.push(`<div class="card c-int"><div class="k">跨项目依赖</div><div class="v">${t.crossProjectDeps || 0}<small>条</small></div></div>`);
  parts.push(`<div class="card c-api"><div class="k">API 控制器</div><div class="v">${t.apiControllers || 0}<small>@RestController</small></div></div>`);
  parts.push(`<div class="card c-biz"><div class="k">业务服务</div><div class="v">${t.businessServices || 0}<small>@Service/@Component</small></div></div>`);
  parts.push('</div>');

  // Tab nav
  parts.push('<div class="tabs" id="tabs">');
  for (const tab of tabs) {
    parts.push(`<div class="tab ${tab.active ? 'active' : ''}" data-tab="${tab.id}">${tab.label}</div>`);
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

  // Tab 切换 JS
  parts.push(`<script>document.addEventListener('DOMContentLoaded',()=>{const tabs=document.querySelectorAll('#tabs .tab');const panels=document.querySelectorAll('.panel');tabs.forEach(tab=>{tab.addEventListener('click',()=>{const target=tab.dataset.tab;tabs.forEach(t=>t.classList.toggle('active',t===tab));panels.forEach(p=>p.classList.toggle('active',p.dataset.panel===target));document.getElementById('tabs').scrollIntoView({behavior:'smooth',block:'start'});});});});</script>`);

  parts.push('</div></body></html>');
  return parts.join('');
}

function escape(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
