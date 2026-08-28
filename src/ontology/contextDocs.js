// 上下文文档生成（v0.38，context-builder skill 的 CLI 支撑）
// 把本体快照渲染为「三明治结构」的 Markdown 文档树（输出到 .nice-aos/context/）：
//   L1  index.md / architecture.md / modules.md / domains/_index.md
//   L2  domains/<slug>.md
//   L3  domains/<slug>/{components,routes,state,services}.md
// 另产 tree.json（目录树索引）供 docs.html 浏览器侧边栏消费——
// 借鉴 display-web knowledge-graph 的「离线生成索引 + 运行时按需 fetch 正文」模式。
// 纯函数：不触盘、不依赖运行环境；写盘由 export.js 的 docs 子命令负责。
// 粒度预算（黄金数字）：L1 <2KB / L2 <1KB / L3 <5KB，超出以 TopN 截断并注明总量。

export const CONTEXT_DOCS_VERSION = '0.4.0';

const L1_DOMAIN_TOP = 10;
const L2_MODULE_TOP = 5;
const L2_NAME_TOP = 5;
const L3_ROWS = 25;
const MODULE_GROUP_ROWS = 15;
const CYCLE_TOP = 5;
const DEP_TOP = 10;

// —— 通用小工具 ——

const num = (v) => Number(v || 0);
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, Math.max(1, n - 1))}…` : t;
};
// 模块源领域的 summary 常为「833 个文件。」这类与计数重复的无信息文案，此时省略
const informative = (s) => {
  const t = String(s ?? '').trim();
  return t && !/^[\d,.]+\s*(个文件|文件)?[。.]?$/.test(t) ? t : '';
};
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');
const baseName = (p) => String(p ?? '').split('/').pop() || '-';

// CJK 保留的 slug：非字母数字（含中文）序列折叠为 '-'
export function slugify(name) {
  const s = String(name ?? '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return s || 'domain';
}

function frontmatter({ title, layer, domain, generated }) {
  const lines = ['---', `title: ${title}`];
  if (layer) lines.push(`layer: ${layer}`);
  if (domain) lines.push(`domain: ${domain}`);
  lines.push(`generated: ${generated}`, '---', '');
  return `${lines.join('\n')}\n`;
}

function buildIdIndex(dataMap) {
  const idx = new Map();
  for (const arr of Object.values(dataMap || {})) {
    if (!Array.isArray(arr)) continue;
    for (const o of arr) if (o && typeof o.id === 'string') idx.set(o.id, o);
  }
  return idx;
}

// 领域成员解析：优先 Domain 自带 *Ids；旧快照缺失时按成员对象 domainIds 反查
function domainMembers(domain, dataMap, byId) {
  const fromIds = (key) => (domain[key] || []).map((id) => byId.get(id)).filter(Boolean);
  let modules = fromIds('moduleIds');
  let components = fromIds('componentIds');
  let routes = fromIds('routeIds');
  let stores = fromIds('storeIds');
  let hooks = fromIds('hookIds');
  let services = fromIds('serviceIds');
  let scripts = fromIds('userScriptIds');
  const hasAny = modules.length + components.length + routes.length + stores.length + hooks.length + services.length + scripts.length > 0;
  if (!hasAny) {
    const scan = (type) => (dataMap[type] || []).filter((o) => Array.isArray(o.domainIds) && o.domainIds.includes(domain.id));
    if (!modules.length) modules = scan('Module');
    components = scan('Component');
    routes = scan('Route');
    stores = scan('Store');
    hooks = scan('Hook');
    services = scan('Service');
    scripts = scan('UserScript');
  }
  // 接口/类无 domainIds，按领域文件路径集合圈定（L3 services.md 用）
  const filePaths = new Set((domain.fileIds || []).map((id) => (id.startsWith('file:') ? id.slice(5) : id)));
  return { modules, components, routes, stores, hooks, services, scripts, filePaths };
}

const truncNote = (shown, total, unit) => (shown < total ? `\n\n> 仅列出前 ${shown} ${unit}，共 ${total} ${unit}（完整清单见本体快照或 viewmodel）。` : '');

// —— L1：index.md（<2KB）——

function renderIndex(dataMap, { generated }) {
  const p = (dataMap.Project || [])[0] || {};
  const domains = (dataMap.Domain || []).slice().sort((a, b) => num(b.fileCount) - num(a.fileCount));
  const moduleCount = dataMap._meta?.objectCounts?.Module ?? (dataMap.Module || []).length;
  const lines = [frontmatter({ title: `${p.name || '项目'} — 项目顶层索引`, layer: 'L1', generated })];
  lines.push(`# ${p.name || '项目'} · 项目顶层索引`, '');
  lines.push(`> ${p.frameworkLabel || p.framework || '未知框架'} · ${num(p.fileCount)} 个源文件 · ${moduleCount} 个模块${p.branch ? ` · ${p.branch}` : ''}${p.commitHash ? ` @ ${String(p.commitHash).slice(0, 7)}` : ''}`, '');
  lines.push('## 技术栈', '');
  lines.push(`- 框架：${p.framework ?? 'unknown'}（${p.frameworkLabel ?? '-'}）`);
  lines.push(`- 语言：${p.language ?? '-'}`);
  if (p.architecture?.styleLabel || p.architecture?.style) lines.push(`- 架构风格：${p.architecture.styleLabel ?? p.architecture.style}`);
  lines.push(`- 分析时间：${dataMap._meta?.generatedAt ?? generated}`, '');
  const layers = p.architecture?.layers || [];
  if (layers.length) {
    lines.push('## 架构分层', '', '| 层 | 文件数 | 占比 |', '|---|---:|---:|');
    for (const l of layers) lines.push(`| ${esc(l.label ?? l.key)} | ${num(l.fileCount)} | ${l.share ?? '-'}% |`);
    lines.push('');
  }
  const top = domains.slice(0, L1_DOMAIN_TOP);
  lines.push(`## 功能域（${domains.length ? `Top ${top.length} / 共 ${domains.length}` : '无'}）`, '');
  if (domains.length) {
    for (const d of top) {
      const s = informative(d.summary);
      lines.push(`- [${d.name}](domains/${slugify(d.name)}.md) — ${num(d.fileCount)} 文件${s ? ` · ${clip(s, 50)}` : ''}`);
    }
  } else {
    lines.push('- （未识别出功能域，见模块地图）');
  }
  lines.push('', '## 入口', '');
  lines.push('- [架构总览](architecture.md) · [模块地图](modules.md) · [领域地图](domains/_index.md)');
  lines.push('- 在线浏览：`nice-aos serve` 后访问 `/docs`；交互蓝图：`nice-aos output --format html`', '');
  return lines.join('\n');
}

// —— 汇总：architecture.md ——

const HEALTH_LABELS = [
  ['cycleCount', '循环依赖组'],
  ['orphanFileCount', '孤儿文件'],
  ['deadTypeCount', '死代码候选类型'],
  ['deadExportCount', '死代码候选导出'],
  ['deadFunctionCount', '死代码候选函数'],
  ['undeclaredDependencyCount', '未声明依赖'],
  ['highRiskScriptCount', '高风险脚本'],
  ['analysisErrorCount', '解析错误'],
];

function cycleLine(cyc) {
  if (!Array.isArray(cyc) || cyc.length === 0) return '';
  if (cyc.length <= 3) return cyc.map(baseName).join(' → ');
  return [baseName(cyc[0]), baseName(cyc[1]), `…(${cyc.length - 3} 个中间文件)…`, baseName(cyc[cyc.length - 1])].join(' → ');
}

function renderArchitecture(dataMap, { generated }) {
  const p = (dataMap.Project || [])[0] || {};
  const meta = dataMap._meta || {};
  const lines = [frontmatter({ title: '架构总览', layer: '汇总', generated })];
  lines.push('# 架构总览', '');
  if (p.summary) lines.push('> ' + clip(p.summary, 400), '');
  const layers = p.architecture?.layers || [];
  if (layers.length) {
    lines.push('## 语义分层', '', '| 层 | 说明 | 文件数 | 占比 |', '|---|---|---:|---:|');
    for (const l of layers) lines.push(`| ${esc(l.label ?? l.key)} | ${esc(l.description ?? '')} | ${num(l.fileCount)} | ${l.share ?? '-'}% |`);
    lines.push('');
  }
  const health = p.health || {};
  lines.push('## 健康度', '', '| 指标 | 数值 |', '|---|---:|');
  for (const [key, label] of HEALTH_LABELS) {
    const v = num(health[key]);
    lines.push(`| ${label}${v > 0 && key !== 'analysisErrorCount' ? '（治理点）' : ''} | ${v} |`);
  }
  lines.push('');
  const cycles = meta.cycles || [];
  if (cycles.length) {
    lines.push(`## 循环依赖（Top ${Math.min(CYCLE_TOP, cycles.length)} / 共 ${cycles.length} 组）`, '');
    for (const cyc of cycles.slice(0, CYCLE_TOP)) lines.push(`- ${cycleLine(cyc)}`);
    lines.push('');
  }
  const deps = (dataMap.Dependency || []).slice().sort((a, b) => num(b.importCount) - num(a.importCount)).slice(0, DEP_TOP);
  if (deps.length) {
    lines.push(`## 依赖 Top ${deps.length}（按被导入次数）`, '', '| 包 | 版本 | 来源 | 导入次数 |', '|---|---|---|---:|');
    for (const d of deps) lines.push(`| ${esc(d.name)} | ${esc(d.version ?? '-')} | ${esc(d.source ?? '-')} | ${num(d.importCount)} |`);
    lines.push('');
  }
  return lines.join('\n');
}

// —— 汇总：modules.md ——

function renderModules(dataMap, { generated }) {
  const modules = (dataMap.Module || []).slice();
  const lines = [frontmatter({ title: '模块地图', layer: '汇总', generated })];
  lines.push('# 模块地图', '');
  lines.push(`> ${modules.length} 个模块，按语义架构层分组（archLayer 以内容信号推断，目录名仅弱信号）。`, '');
  const groups = new Map();
  for (const m of modules) {
    const key = m.archLayer || m.layer || 'mixed';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const ordered = [...groups.entries()].sort((a, b) => {
    const sum = (arr) => arr.reduce((s, m) => s + num(m.subtreeFileCount ?? m.fileCount), 0);
    return sum(b[1]) - sum(a[1]);
  });
  for (const [key, arr] of ordered) {
    const label = arr[0]?.archLayerLabel ?? key;
    const files = arr.reduce((s, m) => s + num(m.subtreeFileCount ?? m.fileCount), 0);
    lines.push(`## ${label} ${key}（${arr.length} 个模块 · ${files} 文件）`, '');
    lines.push('| 模块 | 文件数 | 组件 | 职责 |', '|---|---:|---:|---|');
    const sorted = arr.slice().sort((a, b) => num(b.subtreeFileCount ?? b.fileCount) - num(a.subtreeFileCount ?? a.fileCount));
    for (const m of sorted.slice(0, MODULE_GROUP_ROWS)) {
      const comps = m.unitCounts?.component ?? 0;
      lines.push(`| \`${esc(m.path ?? m.name)}\` | ${num(m.subtreeFileCount ?? m.fileCount)} | ${comps} | ${esc(clip(m.summary, 60))} |`);
    }
    lines.push('', truncNote(Math.min(MODULE_GROUP_ROWS, sorted.length), sorted.length, '个模块'), '');
  }
  if (!modules.length) lines.push('（快照中无模块对象）', '');
  return lines.join('\n');
}

// —— L2：domains/_index.md 与 domains/<slug>.md ——

function renderDomainIndex(domains, { generated }) {
  const lines = [frontmatter({ title: '领域地图', layer: 'L2', generated })];
  lines.push('# 领域地图', '');
  lines.push('> 横向业务切片（路由域段 + 业务命名目录聚合），与纵向架构分层正交。', '');
  if (!domains.length) {
    lines.push('（快照中未识别出功能域——小型仓库或纯脚本仓库属正常现象，结构信息见 [模块地图](../modules.md)）', '');
    return lines.join('\n');
  }
  lines.push('| 领域 | 文件 | 行数 | 组件 | 路由 | Store | 概要 |', '|---|---:|---:|---:|---:|---:|---|');
  for (const d of domains) {
    const s = informative(d.summary);
    lines.push(`| [${esc(d.name)}](${slugify(d.name)}.md) | ${num(d.fileCount)} | ${num(d.lineCount)} | ${num(d.componentCount)} | ${num(d.routeCount)} | ${num(d.storeCount)} | ${s ? esc(clip(s, 40)) : '-'} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function memberLine(label, arr, total) {
  if (!total) return '';
  const names = arr.slice(0, L2_NAME_TOP).map((o) => o.name).join('、');
  const more = total > arr.slice(0, L2_NAME_TOP).length ? ` 等` : '';
  return `- ${label}（共 ${total}）：${names}${more}`;
}

function renderDomainL2(domain, members, slug, { generated }) {
  const d = domain;
  const lines = [frontmatter({ title: `${d.name} — 领域索引`, layer: 'L2', domain: slug, generated })];
  lines.push(`# ${d.name} · 领域索引`, '');
  const summary = informative(d.summary);
  lines.push('> ' + (summary ? clip(summary, 200) : '（无职责画像）'), '');
  lines.push('| 文件 | 行数 | 模块 | 组件 | 路由 | Store | Hook | Service | 脚本 |', '|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  lines.push(`| ${num(d.fileCount)} | ${num(d.lineCount)} | ${members.modules.length} | ${members.components.length} | ${members.routes.length} | ${members.stores.length} | ${members.hooks.length} | ${members.services.length} | ${members.scripts.length} |`, '');
  const mods = members.modules.slice().sort((a, b) => num(b.subtreeFileCount ?? b.fileCount) - num(a.subtreeFileCount ?? a.fileCount));
  if (mods.length) {
    lines.push(`## 子模块（Top ${Math.min(L2_MODULE_TOP, mods.length)} / 共 ${mods.length}）`, '');
    for (const m of mods.slice(0, L2_MODULE_TOP)) {
      lines.push(`- \`${m.path ?? m.name}\` — ${num(m.subtreeFileCount ?? m.fileCount)} 文件 · ${m.archLayerLabel ?? m.archLayer ?? '-'}`);
    }
    lines.push('');
  }
  const units = [
    memberLine('组件', members.components, members.components.length),
    memberLine('路由', members.routes, members.routes.length),
    memberLine('Store', members.stores, members.stores.length),
    memberLine('Hook', members.hooks, members.hooks.length),
    memberLine('Service', members.services, members.services.length),
    memberLine('脚本', members.scripts, members.scripts.length),
  ].filter(Boolean);
  if (units.length) lines.push('## 单元构成', '', ...units, '');
  const l3Links = [
    members.components.length && `[组件清单](${slug}/components.md)`,
    members.routes.length && `[路由地图](${slug}/routes.md)`,
    (members.stores.length || members.hooks.length) && `[状态管理](${slug}/state.md)`,
    (members.services.length || members.filePaths.size) && `[服务与类型](${slug}/services.md)`,
  ].filter(Boolean);
  if (l3Links.length) lines.push('## 领域详情', '', `- ${l3Links.join(' · ')}`, '');
  return lines.join('\n');
}

// —— L3：domains/<slug>/{components,routes,state,services}.md ——

function mdTable(header, rows) {
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map((_, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`];
  for (const r of rows) lines.push(`| ${r.join(' | ')} |`);
  return lines.join('\n');
}

function renderDomainL3(domain, members, slug, dataMap, { generated }) {
  const out = [];
  const head = (title) => [
    frontmatter({ title: `${domain.name} — ${title}`, layer: 'L3', domain: slug, generated }),
    `# ${domain.name} · ${title}`, '',
  ];

  if (members.components.length) {
    const lines = head('组件清单');
    const sorted = members.components.slice().sort((a, b) => num(b.lineCount) - num(a.lineCount));
    const rows = sorted.slice(0, L3_ROWS).map((c) => [
      esc(c.name),
      `\`${esc(baseName(c.filePath))}\``,
      esc(c.kind ?? '-'),
      String(num(c.propsCount)),
      String(num(c.lineCount)),
    ]);
    lines.push(mdTable(['组件', '文件', '类型', 'Props', '行数'], rows), truncNote(rows.length, sorted.length, '个组件'), '');
    out.push(['components.md', lines.join('\n')]);
  }

  if (members.routes.length) {
    const lines = head('路由地图');
    const rows = members.routes.slice(0, L3_ROWS).map((r) => [
      esc(r.overlayId ?? r.routePath ?? r.name),
      esc(r.routePath ?? '-'),
      esc(r.routeType ?? '-'),
      esc(r.backTarget || '-'),
      String(Array.isArray(r.navigatesToIds) ? r.navigatesToIds.length : 0),
    ]);
    lines.push(mdTable(['路由', '路径', '类型', '返回目标', '跳转'], rows), truncNote(rows.length, members.routes.length, '条路由'), '');
    out.push(['routes.md', lines.join('\n')]);
  }

  if (members.stores.length || members.hooks.length) {
    const lines = head('状态管理');
    if (members.stores.length) {
      lines.push(`## Store（${members.stores.length}）`, '');
      lines.push(mdTable(
        ['Store', 'storageKey', '持久化', '状态键', '动作'],
        members.stores.slice(0, L3_ROWS).map((s) => [
          esc(s.name),
          esc(s.storageKey ?? '-'),
          s.hasPersist ? '是' : '否',
          String(Array.isArray(s.stateKeys) ? s.stateKeys.length : 0),
          String(Array.isArray(s.actionKeys) ? s.actionKeys.length : 0),
        ]),
      ), '');
    }
    if (members.hooks.length) {
      const sorted = members.hooks.slice().sort((a, b) => num(b.lineCount) - num(a.lineCount));
      lines.push(`## Hook / Composable（${sorted.length}）`, '');
      lines.push(mdTable(
        ['Hook', '文件', '行数'],
        sorted.slice(0, L3_ROWS).map((h) => [esc(h.name), `\`${esc(baseName(h.filePath))}\``, String(num(h.lineCount))]),
      ), truncNote(Math.min(L3_ROWS, sorted.length), sorted.length, '个 Hook'), '');
    }
    out.push(['state.md', lines.join('\n')]);
  }

  if (members.services.length || members.filePaths.size) {
    const lines = head('服务与类型');
    if (members.services.length) {
      lines.push(`## Service（${members.services.length}）`, '');
      lines.push(mdTable(
        ['Service', '模式', '导出', '行数'],
        members.services.slice(0, L3_ROWS).map((s) => [esc(s.name), esc(s.pattern ?? '-'), String(num(s.exportsCount)), String(num(s.lineCount))]),
      ), '');
    }
    const inDomain = (o) => o && members.filePaths.has(o.filePath);
    const ifaces = (dataMap.Interface || []).filter(inDomain);
    const classes = (dataMap.Class || []).filter(inDomain);
    if (ifaces.length) {
      const sorted = ifaces.slice().sort((a, b) => num(b.lineCount ?? 0) - num(a.lineCount ?? 0));
      lines.push(`## 接口（${sorted.length}）`, '');
      lines.push(mdTable(
        ['接口', '文件', '导出'],
        sorted.slice(0, L3_ROWS).map((i) => [esc(i.name), `\`${esc(baseName(i.filePath))}\``, i.exported ? '是' : '否']),
      ), truncNote(Math.min(L3_ROWS, sorted.length), sorted.length, '个接口'), '');
    }
    if (classes.length) {
      const sorted = classes.slice().sort((a, b) => num(b.lineCount ?? 0) - num(a.lineCount ?? 0));
      lines.push(`## 类（${sorted.length}）`, '');
      lines.push(mdTable(
        ['类', '文件', '单例'],
        sorted.slice(0, L3_ROWS).map((c) => [esc(c.name), `\`${esc(baseName(c.filePath))}\``, c.isSingleton ? '是' : '否']),
      ), truncNote(Math.min(L3_ROWS, sorted.length), sorted.length, '个类'), '');
    }
    if (members.services.length || ifaces.length || classes.length) out.push(['services.md', lines.join('\n')]);
  }

  return out;
}

// —— 目录树（tree.json，供 docs.html 侧边栏）——

export function buildTree(files, { generated } = {}) {
  const root = new Map();
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.has(parts[i])) node.set(parts[i], new Map());
      node = node.get(parts[i]);
    }
    node.set(parts[parts.length - 1], { __file: f });
  }
  const toNodes = (map, dirPath) => {
    const dirs = [];
    const fileNodes = [];
    let fileTotal = 0;
    for (const [name, child] of map.entries()) {
      const p = dirPath ? `${dirPath}/${name}` : name;
      if (child.__file) {
        fileTotal += 1;
        fileNodes.push({ name, type: 'file', path: p, size: Buffer.byteLength(child.__file.content, 'utf-8') });
      } else {
        const [node, count] = toNodes(child, p);
        fileTotal += count;
        dirs.push(node);
      }
    }
    const cmp = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN');
    dirs.sort(cmp);
    fileNodes.sort(cmp);
    const children = [...dirs, ...fileNodes];
    if (dirPath == null) return [children, fileTotal];
    return [{ name: dirPath.split('/').pop(), type: 'directory', path: dirPath, count: fileTotal, children }, fileTotal];
  };
  const [tree, totalFiles] = toNodes(root, null);
  return { generated, version: CONTEXT_DOCS_VERSION, totalFiles, tree };
}

// —— 编排入口 ——

export function buildContextDocs(dataMap, options = {}) {
  if (!dataMap || typeof dataMap !== 'object') throw new Error('buildContextDocs: dataMap 必须为快照对象');
  const generated = options.generatedAt ?? dataMap._meta?.generatedAt ?? new Date().toISOString();
  const byId = buildIdIndex(dataMap);
  const domains = (dataMap.Domain || []).slice().sort((a, b) => num(b.fileCount) - num(a.fileCount));

  const files = [];
  const push = (path, content) => files.push({ path, content });

  push('index.md', renderIndex(dataMap, { generated }));
  push('architecture.md', renderArchitecture(dataMap, { generated }));
  push('modules.md', renderModules(dataMap, { generated }));
  push('domains/_index.md', renderDomainIndex(domains, { generated }));

  // slug 去重（同名领域追加序号）
  const usedSlugs = new Map();
  const slugOf = (name) => {
    const base = slugify(name);
    const n = usedSlugs.get(base) ?? 0;
    usedSlugs.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };

  for (const d of domains) {
    const slug = slugOf(d.name);
    const members = domainMembers(d, dataMap, byId);
    push(`domains/${slug}.md`, renderDomainL2(d, members, slug, { generated }));
    for (const [name, content] of renderDomainL3(d, members, slug, dataMap, { generated })) {
      push(`domains/${slug}/${name}`, content);
    }
  }

  const tree = buildTree(files, { generated });
  return { files, tree, generated, version: CONTEXT_DOCS_VERSION };
}
