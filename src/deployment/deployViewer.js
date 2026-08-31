// 部署蓝图 deployoverview HTML 生成器
// 数据流：deploy-snapshot.json（DeployModel）→ buildDeployViewerModel()（视图模型）→ renderDeployOverviewHtml()（HTML）
// 九个视图：
//   1. 部署拓扑：分层架构图（接入层 → 前端层 → 应用服务层 → … → 数据层），层间箭头标注流量语义
//   2. K8s 架构（条件显示）：仅当扫描数据含 K8s manifest 时展示——概览指标 + 命名空间筛选 +
//      工作负载 / Service 服务发现 / Ingress 入口路由 / 配置与存储四张清单表
//   3. 服务清单：搜索 + 分层过滤 + 服务卡片（镜像/端口/探针/环境变量展开）
//   4. 网关路由：nginx location → proxy_pass 解析结果 + upstream 后端表
//   5. 依赖关系：SVG 依赖图（depends_on / env_ref / route 三色边）+ 依赖矩阵
//   6. 中间件：基础设施卡片（版本/端口/消费方）
//   7. 环境配置：.env 文件变量表（敏感值脱敏）+ 服务引用
//   8. 部署文件：按类型分组的源文件清单（compose/k8s/nginx/dockerfile/env/shell/ci）
//   9. 健康审计：评分环 + 四维得分 + 问题清单

import {
  auditSecurity, auditResilience, auditConfigConsistency, auditDependency, auditHealth,
} from './deployAuditor.js';
import { SERVICE_TYPE_LABELS, SERVICE_TYPE_COLORS, LAYER_RULES } from './deployModel.js';
import { buildThemeCss, DEFAULT_THEMES } from '../themes/index.js';
import { SHARED_CSS } from '../themes/sharedCss.js';
import { RING_JS } from '../themes/ring.js';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ISO UTC 时间 → 浏览器本地时间（YYYY-MM-DD HH:mm:ss），与代码蓝图 fmtLocalTime 对齐
function fmtLocalTime(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return String(iso || '').replace('T', ' ').slice(0, 19);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

const ENV_DISPLAY_CAP = 40;

export function buildDeployViewerModel(model) {
  const meta = model._meta || {};
  const services = model.services || [];
  const routes = model.routes || [];
  const upstreams = model.upstreams || [];
  const dependencies = model.dependencies || [];

  const layerByKey = new Map((model.layers || []).map((l) => [l.key, l]));
  const layerLabel = (key) => layerByKey.get(key)?.label || LAYER_RULES.find((r) => r.key === key)?.label || key;

  const serviceSummaries = services.map((s) => {
    const envKeys = Object.keys(s.env || {});
    const envCapped = {};
    envKeys.slice(0, ENV_DISPLAY_CAP).forEach((k) => { envCapped[k] = s.env[k]; });
    return {
      name: s.name,
      type: s.type,
      typeLabel: SERVICE_TYPE_LABELS[s.type] || s.type,
      layer: s.layer,
      layerLabel: layerLabel(s.layer),
      image: s.image,
      registry: s.registry,
      imageVersion: s.imageVersion,
      kind: s.kind,
      namespace: s.namespace,
      replicas: s.replicas,
      ports: s.ports || [],
      containerPorts: s.containerPorts || [],
      env: envCapped,
      envCount: envKeys.length,
      envTruncated: envKeys.length > ENV_DISPLAY_CAP,
      envRefs: s.envRefs || [],
      configRefs: s.configRefs || [],
      dependsOn: s.dependsOn || [],
      volumes: s.volumes || [],
      hasHealthcheck: Boolean(s.healthcheck || s.readinessProbe || s.livenessProbe),
      readinessProbe: s.readinessProbe,
      livenessProbe: s.livenessProbe,
      resources: s.resources,
      restart: s.restart,
      networks: s.networks || [],
      virtual: Boolean(s.virtual),
      sources: s.sources || [],
      middleware: s.middleware || null,
      envServiceRefs: s.envServiceRefs || [],
      buildFrom: s.buildFrom || null,
      routeCount: routes.filter((r) => r.gateway === s.name).length,
    };
  });

  const serviceByName = new Map(serviceSummaries.map((s) => [s.name, s]));

  // 拓扑数据：层 → 服务摘要
  const topologyLayers = (model.layers || []).map((l) => ({
    key: l.key,
    label: l.label,
    arrow: l.arrow,
    services: l.serviceNames.map((n) => serviceByName.get(n)).filter(Boolean),
  }));

  // 依赖图（SVG 用）
  const depGraph = {
    nodes: serviceSummaries.map((s) => ({
      id: s.name,
      label: s.name,
      type: s.type,
      layer: s.layer,
      routeCount: s.routeCount,
      virtual: s.virtual,
    })),
    edges: dependencies.map((d) => ({
      source: d.from,
      target: d.to,
      type: d.type,
    })),
  };

  // 中间件消费视图
  const middleware = (model.middleware || []).map((mw) => ({
    ...mw,
    consumerCount: (mw.consumers || []).length,
  }));

  // 环境变量视图（变量截断防超大）
  const environments = (model.environments || []).map((e) => ({
    id: e.id,
    name: e.name,
    file: e.file,
    variableCount: (e.variables || []).length,
    secretCount: (e.variables || []).filter((v) => v.isSecret).length,
    variables: (e.variables || []).slice(0, 120),
    truncated: (e.variables || []).length > 120,
    serviceRefs: e.serviceRefs || [],
  }));

  // 文件分组
  const files = model.files || [];
  const fileGroups = {};
  for (const f of files) {
    (fileGroups[f.type] = fileGroups[f.type] || []).push(f);
  }

  // K8s 部署架构视图（仅扫描数据含 K8s manifest 时展示独立标签页）
  const K8S_WORKLOAD_KINDS_SET = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'ReplicaSet']);
  const K8S_CLASSIFIED_KINDS_SET = new Set([
    ...K8S_WORKLOAD_KINDS_SET, 'Service', 'Ingress', 'ConfigMap', 'Secret', 'PersistentVolumeClaim',
  ]);
  const k8sResources = model.k8sResources || [];
  const k8s = {
    present: k8sResources.length > 0,
    total: k8sResources.length,
    namespaces: [...new Set(k8sResources.map((r) => r.namespace || 'default'))].sort(),
    kindCounts: model.k8sResourceCounts || {},
    workloads: k8sResources.filter((r) => K8S_WORKLOAD_KINDS_SET.has(r.kind)),
    services: k8sResources.filter((r) => r.kind === 'Service'),
    ingresses: k8sResources.filter((r) => r.kind === 'Ingress'),
    configs: k8sResources.filter((r) => r.kind === 'ConfigMap' || r.kind === 'Secret'),
    storage: k8sResources.filter((r) => r.kind === 'PersistentVolumeClaim'),
    others: k8sResources.filter((r) => !K8S_CLASSIFIED_KINDS_SET.has(r.kind)),
  };

  // 审计
  const securityAudit = auditSecurity(model);
  const resilienceAudit = auditResilience(model);
  const consistencyAudit = auditConfigConsistency(model);
  const dependencyAudit = auditDependency(model);
  const healthAudit = auditHealth(model);

  // 拓扑统计
  const typeDist = {};
  for (const s of serviceSummaries) typeDist[s.type] = (typeDist[s.type] || 0) + 1;

  return {
    meta: {
      sourceDir: meta.sourceDir || '',
      scannedAt: meta.scannedAt || '',
      incremental: meta.incremental || false,
      fileCount: meta.fileCount || files.length,
      serviceCount: meta.serviceCount || services.length,
      routeCount: meta.routeCount || routes.length,
      upstreamCount: meta.upstreamCount || upstreams.length,
      dependencyCount: meta.dependencyCount || dependencies.length,
      middlewareCount: meta.middlewareCount || (model.middleware || []).length,
      environmentCount: meta.environmentCount || (model.environments || []).length,
      layerCount: meta.layerCount || (model.layers || []).length,
      k8sResourceCount: meta.k8sResourceCount || k8sResources.length,
      parseErrors: meta.parseErrors || 0,
    },
    typeDist,
    typeLabels: SERVICE_TYPE_LABELS,
    typeColors: SERVICE_TYPE_COLORS,
    services: serviceSummaries,
    topologyLayers,
    routes,
    upstreams,
    depGraph,
    middleware,
    environments,
    files,
    fileGroups,
    k8s,
    k8sResourceCounts: model.k8sResourceCounts || {},
    audits: {
      health: healthAudit,
      security: securityAudit,
      resilience: resilienceAudit,
      configConsistency: consistencyAudit,
      dependency: dependencyAudit,
    },
  };
}

export function renderDeployOverviewHtml(model, options = {}) {
  const dataJson = JSON.stringify(model).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
  const title = esc(model.meta.sourceDir ? model.meta.sourceDir.split('/').pop() : '部署蓝图');
  const theme = options.theme || DEFAULT_THEMES.deploy;

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${esc(theme)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} · 部署架构蓝图</title>
<style>
${buildThemeCss(theme)}
${SHARED_CSS}
/* ---- 布局骨架固定，以下为部署蓝图专属样式 ---- */
/* ---- 拓扑 ---- */
.topo-layer { background: linear-gradient(135deg, color-mix(in srgb, var(--cyan) 6%, transparent), color-mix(in srgb, var(--purple) 6%, transparent)); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
.topo-layer-title { font-size: 14px; font-weight: 600; color: var(--blue); margin-bottom: 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.topo-layer-title .cnt { font-weight: 400; color: var(--fg-dim); font-size: 12px; }
.topo-services { display: flex; flex-wrap: wrap; gap: 10px; }
.svc-box { background: var(--panel2); border: 1px solid var(--border); border-left: 3px solid var(--blue); border-radius: 8px; padding: 8px 12px; min-width: 170px; max-width: 260px; flex: 1 1 170px; transition: border-color .15s, transform .15s; }
.svc-box:hover { border-color: var(--blue); transform: translateY(-1px); }
.svc-box .svc-name { font-size: 13px; font-weight: 600; font-family: 'SF Mono', Menlo, monospace; word-break: break-all; }
.svc-box .svc-img { font-size: 10px; color: var(--fg-faint); font-family: 'SF Mono', Menlo, monospace; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.svc-box .svc-meta { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
.svc-box .svc-meta span { font-size: 10px; padding: 0 6px; border-radius: 8px; border: 1px solid var(--border); color: var(--fg-dim); }
.topo-arrow { text-align: center; padding: 6px; color: var(--blue); font-size: 13px; opacity: .8; }
/* ---- 通用 ---- */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; }
.badge-type { font-weight: 500; }
.detail { display: none; margin-top: 10px; border-top: 1px solid var(--border); padding-top: 10px; }
.card.expanded .detail { display: block; }
.kv { display: flex; gap: 8px; padding: 2px 0; font-size: 12px; }
.kv .k { min-width: 90px; color: var(--fg-dim); }
.kv .v { word-break: break-all; }
.env-row { display: flex; gap: 8px; padding: 2px 0; font-size: 12px; font-family: 'SF Mono', Menlo, monospace; }
.env-row .ek { min-width: 180px; color: var(--cyan); word-break: break-all; }
.env-row .ev { color: var(--fg-dim); word-break: break-all; }
.env-row.secret .ev { color: var(--amber); }
.chip-filters { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { padding: 4px 10px; border-radius: 12px; font-size: 12px; cursor: pointer; border: 1px solid var(--border); background: var(--panel2); color: var(--fg-dim); }
.chip.active { color: var(--fg); border-color: var(--blue); }
/* ---- 依赖图 ---- */
.graph-container { position: relative; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.graph-toolbar { position: absolute; top: 8px; right: 8px; z-index: 10; display: flex; gap: 4px; }
.graph-toolbar button { padding: 4px 10px; font-size: 12px; background: var(--panel2); border: 1px solid var(--border); border-radius: 4px; color: var(--fg-dim); cursor: pointer; }
.graph-toolbar button:hover { color: var(--fg); }
.graph-legend { position: absolute; bottom: 8px; left: 8px; z-index: 10; background: var(--panel2); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; font-size: 11px; }
.graph-legend .item { display: flex; align-items: center; gap: 4px; margin: 2px 0; }
.graph-legend .dot { width: 10px; height: 10px; border-radius: 2px; }
/* ---- 中间件 / 环境 ---- */
.mw-card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
.mw-card .mw-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.mw-card .mw-name { font-size: 15px; font-weight: 700; }
.mw-kv { font-size: 12px; color: var(--fg-dim); padding: 2px 0; }
.consumer-tag { display: inline-block; font-size: 11px; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--border); background: var(--panel2); margin: 2px 4px 2px 0; font-family: 'SF Mono', Menlo, monospace; }
/* ---- 健康（基础仪表盘样式见共享骨架，此处仅部署专属） ---- */
.issue-item .loc { display: block; font-size: 11px; color: var(--fg-faint); font-family: 'SF Mono', Menlo, monospace; margin-top: 2px; }
</style>
</head>
<body>
<header>
  <h1>${title} · 部署架构蓝图</h1>
  <div class="sub">${esc(model.meta.sourceDir)} · 扫描于 ${esc(fmtLocalTime(model.meta.scannedAt) || 'N/A')}${model.meta.incremental ? ' · 增量' : ' · 全量'}</div>
  <div class="stats" id="stats"></div>
  <div class="tabs">
    <button class="tab-btn active" data-tab="topology">部署拓扑</button>
    ${model.k8s?.present ? '<button class="tab-btn" data-tab="k8s">K8s 架构</button>' : ''}
    <button class="tab-btn" data-tab="services">服务清单</button>
    <button class="tab-btn" data-tab="routes">网关路由</button>
    <button class="tab-btn" data-tab="deps">依赖关系</button>
    <button class="tab-btn" data-tab="middleware">中间件</button>
    <button class="tab-btn" data-tab="envs">环境配置</button>
    <button class="tab-btn" data-tab="files">部署文件</button>
    <button class="tab-btn" data-tab="health">健康审计</button>
  </div>
</header>
<main>
<section class="view active" id="view-topology">
  <div id="topology"></div>
</section>
${model.k8s?.present ? `
<section class="view" id="view-k8s">
  <div class="metric-row" id="k8s-metrics"></div>
  <div class="search-bar">
    <input type="text" id="k8s-search" placeholder="搜索 K8s 资源名 / 镜像 / kind..." oninput="renderK8s()">
    <div class="chip-filters" id="k8s-ns-filters"></div>
  </div>
  <h2 style="font-size:16px;margin-bottom:12px;">工作负载 <span style="color:var(--fg-dim);font-weight:400;font-size:12px;">(Deployment / StatefulSet / DaemonSet / Job / CronJob / ReplicaSet)</span></h2>
  <div class="panel" id="k8s-workloads"></div>
  <h2 style="font-size:16px;margin:16px 0 12px;">Service 服务发现 <span style="color:var(--fg-dim);font-weight:400;font-size:12px;">(ClusterIP / NodePort / LoadBalancer → selector 工作负载)</span></h2>
  <div class="panel" id="k8s-services"></div>
  <h2 style="font-size:16px;margin:16px 0 12px;">Ingress 入口路由 <span style="color:var(--fg-dim);font-weight:400;font-size:12px;">(host / path → 后端 Service)</span></h2>
  <div class="panel" id="k8s-ingresses"></div>
  <h2 style="font-size:16px;margin:16px 0 12px;">配置与存储 <span style="color:var(--fg-dim);font-weight:400;font-size:12px;">(ConfigMap / Secret / PersistentVolumeClaim)</span></h2>
  <div class="panel" id="k8s-configs"></div>
</section>` : ''}
<section class="view" id="view-services">
  <div class="search-bar">
    <input type="text" id="svc-search" placeholder="搜索服务名 / 镜像..." oninput="renderServices()">
    <div class="chip-filters" id="layer-filters"></div>
  </div>
  <div class="grid" id="svc-grid"></div>
</section>
<section class="view" id="view-routes">
  <h2 style="font-size:16px;margin-bottom:12px;">网关路由（nginx location → proxy_pass）</h2>
  <div class="panel" id="route-list"></div>
  <h2 style="font-size:16px;margin-bottom:12px;">Upstream 后端</h2>
  <div class="panel" id="upstream-list"></div>
</section>
<section class="view" id="view-deps">
  <div class="graph-container" id="dep-container">
    <div class="graph-toolbar">
      <button onclick="depZoom(-0.1)">−</button>
      <button onclick="depZoom(0.1)">+</button>
      <button onclick="depReset()">重置</button>
    </div>
    <div class="graph-legend" id="dep-legend"></div>
    <svg id="dep-svg" width="100%" height="700" style="cursor: grab;"></svg>
  </div>
  <h2 style="font-size:16px;margin:16px 0 12px;">依赖清单</h2>
  <div class="panel" id="dep-list"></div>
</section>
<section class="view" id="view-middleware">
  <div class="metric-row" id="mw-metrics"></div>
  <div class="grid" id="mw-grid"></div>
</section>
<section class="view" id="view-envs">
  <div class="grid" id="env-grid"></div>
</section>
<section class="view" id="view-files">
  <div class="metric-row" id="file-metrics"></div>
  <div id="file-groups"></div>
</section>
<section class="view" id="view-health">
  <div class="panel" id="health-score"></div>
  <h2 style="font-size:16px;margin-bottom:12px;">维度得分</h2>
  <div class="dim-grid" id="health-dimensions"></div>
  <h2 style="font-size:16px;margin-bottom:12px;">问题清单</h2>
  <div class="panel" id="health-issues" style="margin-bottom:16px;"></div>
  <h2 style="font-size:16px;margin-bottom:12px;">审计明细</h2>
  <div class="panel" id="audit-details"></div>
</section>
</main>
<script id="deploy-viewer-data" type="application/json">${dataJson}</script>
<script>
${RING_JS}
const MODEL = JSON.parse(document.getElementById('deploy-viewer-data').textContent);
const TYPE_COLORS = MODEL.typeColors || {};
const TYPE_LABELS = MODEL.typeLabels || {};
let currentLayer = 'all';
let depScale = 1;

function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function colorOf(type) { return TYPE_COLORS[type] || '#64748b'; }

// ---- Stats ----
(function() {
  const m = MODEL.meta;
  const stats = [
    { v: m.serviceCount, k: '服务' },
    { v: m.routeCount, k: '路由' },
    { v: m.upstreamCount, k: '上游' },
    { v: m.dependencyCount, k: '依赖' },
    { v: m.middlewareCount, k: '中间件' },
    { v: m.environmentCount, k: '环境' },
    { v: m.layerCount, k: '分层' },
    { v: m.fileCount, k: '文件' },
  ];
  document.getElementById('stats').innerHTML = stats.map(s => '<div class="stat"><div class="v">' + s.v + '</div><div class="k">' + s.k + '</div></div>').join('');
})();

// ---- Tabs ----
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('section.view').forEach(s => s.classList.remove('active'));
    document.getElementById('view-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'deps') renderDepGraph();
    if (btn.dataset.tab === 'topology') renderTopology();
  });
});

// ---- 1. 拓扑 ----
function svcBox(s) {
  const c = colorOf(s.type);
  const ports = (s.containerPorts.length ? s.containerPorts : s.ports.map(p => p.container))
    .slice(0, 3).map(p => '<span>:' + p + '</span>').join('');
  const replicas = s.replicas != null ? '<span>×' + s.replicas + '</span>' : '';
  const routes = s.routeCount > 0 ? '<span>' + s.routeCount + ' 路由</span>' : '';
  const mw = s.middleware ? '<span>' + esc(s.middleware.label) + (s.middleware.version ? ' ' + esc(s.middleware.version) : '') + '</span>' : '';
  const hc = s.hasHealthcheck ? '<span style="color:var(--green);border-color:rgba(74,222,128,.4);">HC</span>' : '';
  return '<div class="svc-box" style="border-left-color:' + c + ';" title="' + esc(s.image || s.name) + '">' +
    '<div class="svc-name" style="color:' + c + ';">' + esc(s.name) + (s.virtual ? ' <span style="color:var(--fg-faint);font-size:10px;">(conf)</span>' : '') + '</div>' +
    (s.image ? '<div class="svc-img">' + esc(s.image) + '</div>' : '') +
    '<div class="svc-meta">' + ports + replicas + routes + mw + hc + '</div>' +
  '</div>';
}

function renderTopology() {
  const el = document.getElementById('topology');
  const layers = MODEL.topologyLayers || [];
  if (layers.length === 0) { el.innerHTML = '<div class="empty">无拓扑数据</div>'; return; }
  el.innerHTML = layers.map((l, i) => {
    const boxes = l.services.map(svcBox).join('');
    const arrow = i < layers.length - 1 && l.arrow ? '<div class="topo-arrow">' + esc(l.arrow) + '</div>' : '';
    return '<div class="topo-layer">' +
      '<div class="topo-layer-title"><span style="width:10px;height:10px;border-radius:2px;display:inline-block;background:var(--blue);"></span>' + esc(l.label) + ' <span class="cnt">' + l.services.length + ' 个服务</span></div>' +
      '<div class="topo-services">' + (boxes || '<span style="color:var(--fg-faint);font-size:12px;">（空）</span>') + '</div>' +
    '</div>' + arrow;
  }).join('');
}

// ---- 2. 服务清单 ----
function renderServices() {
  const query = (document.getElementById('svc-search')?.value || '').toLowerCase();
  const grid = document.getElementById('svc-grid');
  let list = MODEL.services || [];
  if (currentLayer !== 'all') list = list.filter(s => s.layer === currentLayer);
  if (query) {
    list = list.filter(s => s.name.toLowerCase().includes(query) || (s.image || '').toLowerCase().includes(query));
  }
  if (list.length === 0) { grid.innerHTML = '<div class="empty">没有匹配的服务</div>'; return; }
  grid.innerHTML = list.map(s => {
    const c = colorOf(s.type);
    const envRows = Object.entries(s.env || {}).map(([k, v]) =>
      '<div class="env-row' + (/password|passwd|secret|token|credential/i.test(k) ? ' secret' : '') + '"><span class="ek">' + esc(k) + '</span><span class="ev">' + esc(v) + '</span></div>'
    ).join('');
    const envRefRows = (s.envRefs || []).map(r =>
      '<div class="kv"><span class="k">' + esc(r.name) + '</span><span class="v">' + esc(r.type) + ':' + esc(r.ref) + '.' + esc(r.key) + '</span></div>'
    ).join('');
    const cfgRows = (s.configRefs || []).map(r =>
      '<div class="kv"><span class="k">envFrom</span><span class="v">' + esc(r.type) + ':' + esc(r.ref) + '</span></div>'
    ).join('');
    const depRows = (s.dependsOn || []).map(d => '<span class="consumer-tag">' + esc(d) + '</span>').join('');
    const srcRows = (s.sources || []).map(src => '<span class="consumer-tag">' + esc(src.file) + '</span>').join('');
    const resRows = s.resources ? (s.resources.limits ? 'limits ' + JSON.stringify(s.resources.limits) : 'requests ' + JSON.stringify(s.resources.requests || {})) : '';
    const probeInfo = [];
    if (s.readinessProbe) probeInfo.push('readiness: ' + (s.readinessProbe.type || '') + (s.readinessProbe.path || ''));
    if (s.livenessProbe) probeInfo.push('liveness: ' + (s.livenessProbe.type || '') + (s.livenessProbe.path || ''));
    return '<div class="card" onclick="this.classList.toggle(\\'expanded\\')">' +
      '<div class="title" style="color:' + c + ';">' + esc(s.name) + '</div>' +
      '<div class="desc">' + esc(s.image || (s.virtual ? '虚拟网关（仅 nginx.conf）' : '镜像未知')) + '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">' +
        '<span class="badge badge-type" style="color:' + c + ';border-color:' + c + '40;">' + esc(s.typeLabel) + '</span>' +
        '<span class="badge">' + esc(s.layerLabel) + '</span>' +
        (s.kind ? '<span class="badge">' + esc(s.kind) + '</span>' : '') +
        (s.replicas != null ? '<span class="badge">×' + s.replicas + '</span>' : '') +
        '<span class="badge">' + s.envCount + ' env</span>' +
        (s.hasHealthcheck ? '<span class="badge" style="color:var(--green);border-color:rgba(74,222,128,.4);">健康检查</span>' : '<span class="badge" style="color:var(--amber);border-color:rgba(210,153,34,.4);">无 HC</span>') +
      '</div>' +
      '<div class="detail">' +
        '<div class="kv"><span class="k">端口</span><span class="v">' + (s.containerPorts.length ? s.containerPorts.join(', ') : s.ports.map(p => p.host + ':' + p.container).join(', ') || '—') + '</span></div>' +
        (s.namespace ? '<div class="kv"><span class="k">命名空间</span><span class="v">' + esc(s.namespace) + '</span></div>' : '') +
        (s.registry ? '<div class="kv"><span class="k">镜像仓库</span><span class="v">' + esc(s.registry) + '</span></div>' : '') +
        (s.restart ? '<div class="kv"><span class="k">restart</span><span class="v">' + esc(s.restart) + '</span></div>' : '') +
        (resRows ? '<div class="kv"><span class="k">resources</span><span class="v">' + esc(resRows) + '</span></div>' : '') +
        (probeInfo.length ? '<div class="kv"><span class="k">探针</span><span class="v">' + probeInfo.map(esc).join('；') + '</span></div>' : '') +
        (s.buildFrom ? '<div class="kv"><span class="k">构建自</span><span class="v">' + esc(s.buildFrom.file) + '（base: ' + esc(s.buildFrom.baseImage || '?') + '）</span></div>' : '') +
        (depRows ? '<div class="kv"><span class="k">depends_on</span><span class="v">' + depRows + '</span></div>' : '') +
        (envRefRows ? '<div class="kv"><span class="k">env 引用</span><span class="v">' + envRefRows + '</span></div>' : '') +
        (cfgRows ? '<div class="kv"><span class="k">envFrom</span><span class="v">' + cfgRows + '</span></div>' : '') +
        '<div class="kv"><span class="k">定义于</span><span class="v">' + srcRows + '</span></div>' +
        (envRows ? '<div style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px;"><div style="color:var(--fg-dim);font-size:11px;margin-bottom:4px;">环境变量 (' + s.envCount + (s.envTruncated ? '，仅显示前 ' + Object.keys(s.env).length : '') + ')</div>' + envRows + '</div>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

(function() {
  const layers = MODEL.topologyLayers || [];
  document.getElementById('layer-filters').innerHTML =
    '<div class="chip active" data-layer="all" onclick="setLayer(this,\\'all\\')">全部</div>' +
    layers.map(l => '<div class="chip" data-layer="' + l.key + '" onclick="setLayer(this,\\'' + l.key + '\\')">' + esc(l.label) + ' (' + l.services.length + ')</div>').join('');
})();

function setLayer(el, layer) {
  document.querySelectorAll('#layer-filters .chip').forEach(f => f.classList.remove('active'));
  el.classList.add('active');
  currentLayer = layer;
  renderServices();
}

// ---- 3. 网关路由 ----
(function() {
  const routes = MODEL.routes || [];
  const el = document.getElementById('route-list');
  if (routes.length === 0) { el.innerHTML = '<div class="empty">无网关路由（未发现 nginx proxy_pass 或 K8s Ingress）</div>'; }
  else {
    const byGateway = {};
    routes.forEach(r => { (byGateway[r.gateway] = byGateway[r.gateway] || []).push(r); });
    el.innerHTML = Object.entries(byGateway).map(([gw, list]) =>
      '<div style="margin-bottom:16px;"><div style="font-weight:600;margin-bottom:6px;color:' + (TYPE_COLORS.gateway || '#f472b6') + ';">' + esc(gw) + ' <span style="color:var(--fg-dim);font-weight:400;font-size:12px;">(' + list.length + ' 条路由)</span></div>' +
      '<table><thead><tr><th>路径</th><th>匹配</th><th>proxy_pass</th><th>目标服务</th><th>特性</th><th>来源</th></tr></thead><tbody>' +
      list.map(r => {
        const target = r.resolvedService
          ? '<span style="color:var(--green);">' + esc(r.resolvedService) + (r.resolvedPort ? ':' + r.resolvedPort : '') + '</span>'
          : r.externalHost ? '<span style="color:var(--orange);">外部 ' + esc(r.externalHost) + '</span>'
          : '<span style="color:var(--red);">未解析</span>';
        const feats = [];
        if (r.authRequest) feats.push('auth');
        if (r.websocket) feats.push('ws');
        if (r.clientMaxBodySize) feats.push('body ' + r.clientMaxBodySize);
        return '<tr>' +
          '<td class="mono">' + esc(r.path) + '</td>' +
          '<td>' + esc(r.matchType) + '</td>' +
          '<td class="mono" style="font-size:12px;">' + esc(r.proxyPass) + '</td>' +
          '<td class="mono">' + target + '</td>' +
          '<td>' + feats.map(f => '<span class="badge">' + esc(f) + '</span>').join(' ') + '</td>' +
          '<td class="mono" style="font-size:11px;color:var(--fg-faint);">' + esc(r.source) + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>'
    ).join('');
  }

  const upstreams = MODEL.upstreams || [];
  const upEl = document.getElementById('upstream-list');
  if (upstreams.length === 0) { upEl.innerHTML = '<div class="empty">无 upstream 定义</div>'; return; }
  upEl.innerHTML = '<table><thead><tr><th>Upstream</th><th>网关</th><th>后端服务器</th><th>来源</th></tr></thead><tbody>' +
    upstreams.map(u =>
      '<tr>' +
        '<td class="mono">' + esc(u.name) + '</td>' +
        '<td class="mono">' + esc(u.gateway) + '</td>' +
        '<td>' + u.servers.map(s =>
          s.resolvedService
            ? '<span class="badge" style="color:var(--green);">' + esc(s.resolvedService) + ':' + s.port + '</span>'
            : '<span class="badge" style="color:var(--red);">' + esc(s.host) + ':' + s.port + '</span>'
        ).join(' ') + '</td>' +
        '<td class="mono" style="font-size:11px;color:var(--fg-faint);">' + esc(u.source) + '</td>' +
      '</tr>'
    ).join('') +
  '</tbody></table>';
})();

// ---- 4. 依赖图 ----
const DEP_EDGE_COLORS = { depends_on: 'var(--green)', env_ref: 'var(--blue)', route: 'var(--purple)' };
const DEP_EDGE_LABELS = { depends_on: 'depends_on 启动依赖', env_ref: 'env_ref 环境引用', route: 'route 网关路由' };

function renderDepGraph() {
  const svg = document.getElementById('dep-svg');
  const graph = MODEL.depGraph;
  if (!graph.nodes || graph.nodes.length === 0) {
    svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#8b949e">无依赖数据</text>';
    return;
  }

  // 按分层分列布局
  const LAYER_ORDER = ['edge', 'frontend', 'backend', 'adapter', 'job', 'data', 'observability', 'cicd', 'tool'];
  const cols = {};
  graph.nodes.forEach(n => {
    const col = LAYER_ORDER.indexOf(n.layer) >= 0 ? LAYER_ORDER.indexOf(n.layer) : 3;
    (cols[col] = cols[col] || []).push(n);
  });
  const colKeys = Object.keys(cols).map(Number).sort((a, b) => a - b);

  const nodeW = 150, nodeH = 30, colGap = 90, rowGap = 14;
  let x = 20;
  const nodePos = {};
  let maxH = 0;
  const NODE_CAP = 40;
  colKeys.forEach(col => {
    const nodes = cols[col].slice(0, NODE_CAP);
    nodes.forEach((n, i) => {
      nodePos[n.id] = { x, y: 20 + i * (nodeH + rowGap), w: nodeW, h: nodeH };
      maxH = Math.max(maxH, 20 + (i + 1) * (nodeH + rowGap));
    });
    x += nodeW + colGap;
  });

  const totalW = x + 20;
  const totalH = Math.max(maxH + 20, 400);
  svg.setAttribute('viewBox', '0 0 ' + totalW + ' ' + totalH);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', Math.min(totalH, 700));
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
  svg.setAttribute('data-original-vb', '0 0 ' + totalW + ' ' + totalH);

  let html = '<defs><marker id="deparrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="var(--purple)"/></marker></defs>';

  // 分列背景
  colKeys.forEach((col, ci) => {
    const nodes = cols[col].slice(0, NODE_CAP);
    if (nodes.length === 0) return;
    const layerKey = nodes[0].layer;
    const layerLabel = (MODEL.topologyLayers || []).find(l => l.key === layerKey)?.label || layerKey;
    html += '<rect x="' + (nodePos[nodes[0].id].x - 10) + '" y="10" width="' + (nodeW + 20) + '" height="' + (totalH - 20) + '" fill="color-mix(in srgb, var(--blue) 3%, transparent)" stroke="var(--border)" rx="8"/>';
    html += '<text x="' + nodePos[nodes[0].id].x + '" y="' + (totalH - 8) + '" fill="var(--fg-faint)" font-size="11">' + esc(layerLabel) + ' (' + cols[col].length + ')</text>';
    if (ci < colKeys.length - 1) html += '<text x="' + (nodePos[nodes[0].id].x + nodeW + 20) + '" y="' + (totalH / 2) + '" fill="var(--fg-faint)" font-size="16" text-anchor="middle">→</text>';
  });

  // 边
  graph.edges.forEach(edge => {
    const s = nodePos[edge.source], t = nodePos[edge.target];
    if (!s || !t) return;
    const sx = s.x + s.w, sy = s.y + s.h / 2;
    const tx = t.x, ty = t.y + t.h / 2;
    const mx = (sx + tx) / 2;
    const color = edge.type === 'depends_on' ? '#4ade80' : edge.type === 'env_ref' ? '#58a6ff' : '#a78bfa';
    html += '<path class="dep-edge" data-from="' + esc(edge.source) + '" data-to="' + esc(edge.target) + '" d="M' + sx + ',' + sy + ' C' + mx + ',' + sy + ' ' + mx + ',' + ty + ' ' + (tx - 2) + ',' + ty + '" fill="none" stroke="' + color + '" stroke-width="1.3" marker-end="url(#deparrow)" opacity="0.55"/>';
  });

  // 节点
  Object.values(nodePos).forEach(() => {});
  graph.nodes.forEach(n => {
    const p = nodePos[n.id];
    if (!p) return;
    const c = colorOf(n.type);
    html += '<g class="dep-node" data-id="' + esc(n.id) + '" style="cursor:pointer">' +
      '<rect x="' + p.x + '" y="' + p.y + '" width="' + p.w + '" height="' + p.h + '" fill="var(--panel2)" stroke="' + c + '" stroke-width="1.5" rx="4"/>' +
      '<text x="' + (p.x + 6) + '" y="' + (p.y + 20) + '" fill="' + c + '" font-size="11" font-weight="600" font-family="monospace">' + esc(n.id.length > 22 ? n.id.slice(0, 21) + '…' : n.id) + '</text>' +
    '</g>';
  });

  svg.innerHTML = html;

  // 点击高亮
  svg.querySelectorAll('.dep-node').forEach(g => {
    g.addEventListener('click', () => {
      const id = g.dataset.id;
      svg.querySelectorAll('.dep-node rect').forEach(r => r.setAttribute('stroke-width', '1.5'));
      g.querySelectorAll('rect').forEach(r => r.setAttribute('stroke-width', '3'));
      svg.querySelectorAll('.dep-edge').forEach(p => {
        const active = p.dataset.from === id || p.dataset.to === id;
        p.setAttribute('opacity', active ? '1' : '0.06');
        p.setAttribute('stroke-width', active ? '2.2' : '1.3');
      });
    });
  });

  document.getElementById('dep-legend').innerHTML =
    Object.entries(DEP_EDGE_LABELS).map(([k, label]) =>
      '<div class="item"><div class="dot" style="background:' + DEP_EDGE_COLORS[k].replace('var(--green)', '#4ade80').replace('var(--blue)', '#58a6ff').replace('var(--purple)', '#a78bfa') + '"></div>' + label + '</div>'
    ).join('') + '<div class="item" style="color:var(--fg-faint);">点击节点高亮关联边</div>';
}

(function() {
  const list = document.getElementById('dep-list');
  const deps = [];
  (MODEL.depGraph?.edges || []).forEach(e => {
    const existing = deps.find(d => d.from === e.source && d.to === e.target);
    if (existing) existing.types.push(e.type);
    else deps.push({ from: e.source, to: e.target, types: [e.type] });
  });
  if (deps.length === 0) { list.innerHTML = '<div class="empty">无依赖关系</div>'; return; }
  deps.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  list.innerHTML = '<table><thead><tr><th>来源服务</th><th>目标服务</th><th>依赖类型</th></tr></thead><tbody>' +
    deps.map(d =>
      '<tr><td class="mono">' + esc(d.from) + '</td><td class="mono">' + esc(d.to) + '</td><td>' +
      d.types.map(t => '<span class="badge" style="color:' + (DEP_EDGE_COLORS[t] || 'var(--fg-dim)') + ';border-color:var(--border);">' + t + '</span>').join(' ') +
      '</td></tr>'
    ).join('') +
  '</tbody></table>';
})();

function depZoom(delta) {
  depScale = Math.max(0.3, Math.min(3, depScale + delta));
  const svg = document.getElementById('dep-svg');
  const vb = svg.getAttribute('viewBox').split(' ').map(Number);
  const cx = vb[2] / 2, cy = vb[3] / 2;
  const nw = vb[2] / depScale, nh = vb[3] / depScale;
  svg.setAttribute('viewBox', (cx - nw/2) + ' ' + (cy - nh/2) + ' ' + nw + ' ' + nh);
}
function depReset() {
  depScale = 1;
  const svg = document.getElementById('dep-svg');
  svg.setAttribute('viewBox', svg.getAttribute('data-original-vb') || '0 0 1000 700');
}
(function() {
  const svg = document.getElementById('dep-svg');
  let isDrag = false, sx = 0, sy = 0, vbx = 0, vby = 0;
  svg.addEventListener('mousedown', e => {
    if (e.target.closest('.dep-node')) return;
    isDrag = true; sx = e.clientX; sy = e.clientY;
    const vb = svg.getAttribute('viewBox').split(' ').map(Number);
    vbx = vb[0]; vby = vb[1];
    svg.style.cursor = 'grabbing';
  });
  document.addEventListener('mousemove', e => {
    if (!isDrag) return;
    const dx = (e.clientX - sx) / depScale;
    const dy = (e.clientY - sy) / depScale;
    const vb = svg.getAttribute('viewBox').split(' ').map(Number);
    svg.setAttribute('viewBox', (vbx - dx) + ' ' + (vby - dy) + ' ' + vb[2] + ' ' + vb[3]);
  });
  document.addEventListener('mouseup', () => { isDrag = false; svg.style.cursor = 'grab'; });
  svg.addEventListener('wheel', e => { e.preventDefault(); depZoom(e.deltaY > 0 ? -0.1 : 0.1); });
})();

// ---- 5. 中间件 ----
(function() {
  const mws = MODEL.middleware || [];
  const metrics = document.getElementById('mw-metrics');
  const kinds = [...new Set(mws.map(m => m.label))];
  const orphan = mws.filter(m => m.consumerCount === 0).length;
  metrics.innerHTML = [
    { v: mws.length, l: '中间件总数' },
    { v: kinds.length, l: '种类' },
    { v: mws.reduce((s, m) => s + m.consumerCount, 0), l: '消费关系' },
    { v: orphan, l: '无消费方', c: orphan > 0 ? 'var(--amber)' : 'var(--green)' },
  ].map(m => '<div class="metric-card"><div class="metric-val" style="color:' + (m.c || 'var(--blue)') + ';">' + m.v + '</div><div class="metric-label">' + m.l + '</div></div>').join('');

  const grid = document.getElementById('mw-grid');
  if (mws.length === 0) { grid.innerHTML = '<div class="empty">未识别到中间件</div>'; return; }
  grid.innerHTML = mws.map(mw => {
    const consumers = (mw.consumers || []).map(c => '<span class="consumer-tag">' + esc(c) + '</span>').join('');
    return '<div class="mw-card">' +
      '<div class="mw-head">' +
        '<span class="mw-name">' + esc(mw.label) + '</span>' +
        (mw.version ? '<span class="badge">' + esc(mw.version) + '</span>' : '') +
        '<span class="badge">' + mw.consumerCount + ' 消费方</span>' +
      '</div>' +
      '<div class="mw-kv mono">服务名: ' + esc(mw.name) + '</div>' +
      '<div class="mw-kv mono">镜像: ' + esc(mw.image || '—') + '</div>' +
      '<div class="mw-kv mono">端口: ' + (mw.ports || []).join(', ') + '</div>' +
      (mw.source ? '<div class="mw-kv mono" style="font-size:11px;color:var(--fg-faint);">来源: ' + esc(mw.source) + '</div>' : '') +
      '<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px;">' +
        '<div style="font-size:11px;color:var(--fg-dim);margin-bottom:4px;">消费方</div>' +
        (consumers || '<span style="color:var(--amber);font-size:12px;">暂未发现消费方</span>') +
      '</div>' +
    '</div>';
  }).join('');
})();

// ---- 6. 环境配置 ----
(function() {
  const envs = MODEL.environments || [];
  const grid = document.getElementById('env-grid');
  if (envs.length === 0) { grid.innerHTML = '<div class="empty">无环境配置文件</div>'; return; }
  grid.innerHTML = envs.map(e => {
    const varRows = (e.variables || []).map(v =>
      '<div class="env-row' + (v.isSecret ? ' secret' : '') + '"><span class="ek">' + esc(v.key) + '</span><span class="ev">' + esc(v.value) + '</span></div>'
    ).join('');
    const refs = (e.serviceRefs || []).map(r => '<span class="consumer-tag">' + esc(r.key) + ' → ' + esc(r.serviceName) + (r.port ? ':' + r.port : '') + '</span>').join('');
    return '<div class="card">' +
      '<div class="title">' + esc(e.name) + '</div>' +
      '<div class="desc mono">' + esc(e.file) + '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">' +
        '<span class="badge">' + e.variableCount + ' 变量</span>' +
        (e.secretCount > 0 ? '<span class="badge" style="color:var(--amber);border-color:rgba(210,153,34,.4);">' + e.secretCount + ' 敏感</span>' : '') +
      '</div>' +
      (refs ? '<div style="margin-bottom:6px;"><div style="font-size:11px;color:var(--fg-dim);">服务引用</div>' + refs + '</div>' : '') +
      '<div class="detail" style="display:block;border-top:1px solid var(--border);margin-top:8px;padding-top:8px;">' +
        varRows +
        (e.truncated ? '<div style="color:var(--fg-faint);font-size:11px;margin-top:4px;">… 变量过多已截断</div>' : '') +
      '</div>' +
    '</div>';
  }).join('');
})();

// ---- 7. 部署文件 ----
(function() {
  const groups = MODEL.fileGroups || {};
  const typeLabels = {
    compose: 'Docker Compose', k8s: 'Kubernetes Manifest', nginx: 'Nginx 配置',
    dockerfile: 'Dockerfile', env: '环境变量文件', shell: 'Shell 脚本',
    ci: 'CI 流水线', config: '其他配置',
  };
  const typeOrder = ['compose', 'k8s', 'nginx', 'dockerfile', 'env', 'shell', 'ci', 'config'];
  const files = MODEL.files || [];

  const k8sCounts = MODEL.k8sResourceCounts || {};
  document.getElementById('file-metrics').innerHTML = [
    { v: files.length, l: '文件总数' },
    ...typeOrder.filter(t => groups[t]).map(t => ({ v: groups[t].length, l: typeLabels[t] })),
  ].map(m => '<div class="metric-card"><div class="metric-val">' + m.v + '</div><div class="metric-label">' + m.l + '</div></div>').join('');

  const container = document.getElementById('file-groups');
  container.innerHTML = typeOrder.filter(t => groups[t]).map(t => {
    const list = groups[t];
    const rows = list.map(f => {
      let extra = '';
      if (f.serviceCount != null) extra = f.serviceCount + ' 服务';
      else if (f.kinds) extra = Object.entries(f.kinds).map(([k, v]) => k + '×' + v).join(', ');
      else if (f.routeCount != null) extra = f.routeCount + ' 路由 / ' + f.upstreamCount + ' 上游';
      else if (f.baseImage) extra = 'base: ' + f.baseImage;
      else if (f.variableCount != null) extra = f.variableCount + ' 变量';
      else if (f.commandCount != null) extra = f.commandCount + ' 命令';
      const size = f.fileSize > 1024 ? (f.fileSize / 1024).toFixed(1) + ' KB' : (f.fileSize || 0) + ' B';
      return '<tr>' +
        '<td class="mono" style="font-size:12px;">' + esc(f.relativePath) + '</td>' +
        '<td>' + (extra ? '<span class="badge">' + esc(extra) + '</span>' : '') + '</td>' +
        '<td style="color:var(--fg-dim);white-space:nowrap;">' + esc(size) + '</td>' +
      '</tr>';
    }).join('');
    return '<div class="panel" style="margin-bottom:12px;">' +
      '<div style="font-weight:600;margin-bottom:8px;">' + (typeLabels[t] || t) + ' <span style="color:var(--fg-dim);font-weight:400;font-size:12px;">(' + list.length + ')</span></div>' +
      '<table><tbody>' + rows + '</tbody></table>' +
    '</div>';
  }).join('') + (Object.keys(k8sCounts).length ?
    '<div class="panel"><div style="font-weight:600;margin-bottom:8px;">K8s 资源统计</div><div>' +
    Object.entries(k8sCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
      '<span class="consumer-tag">' + esc(k) + ' × ' + v + '</span>'
    ).join('') + '</div></div>' : '');
})();

// ---- 8. K8s 架构（仅扫描数据含 K8s manifest 时渲染） ----
let k8sNs = 'all';

function k8sMatch(r, query) {
  if (k8sNs !== 'all' && (r.namespace || 'default') !== k8sNs) return false;
  if (!query) return true;
  if ((r.name || '').toLowerCase().includes(query) || (r.kind || '').toLowerCase().includes(query)) return true;
  return (r.containers || []).some(c => (c.image || '').toLowerCase().includes(query) || (c.name || '').toLowerCase().includes(query));
}

function k8sProbeBadges(w) {
  const hasReady = (w.containers || []).some(c => c.readinessProbe);
  const hasLive = (w.containers || []).some(c => c.livenessProbe);
  const out = [];
  if (hasReady) out.push('<span class="badge" style="color:var(--green);border-color:rgba(74,222,128,.4);">readiness</span>');
  if (hasLive) out.push('<span class="badge" style="color:var(--green);border-color:rgba(74,222,128,.4);">liveness</span>');
  if (!out.length) out.push('<span class="badge" style="color:var(--amber);border-color:rgba(210,153,34,.4);">无探针</span>');
  return out.join(' ');
}

function k8sResourceLimits(w) {
  const parts = [];
  (w.containers || []).forEach(c => {
    if (c.resources && c.resources.limits) {
      const s = Object.entries(c.resources.limits).map(([rk, rv]) => rk + '=' + rv).join(' ');
      if (s) parts.push(((w.containers || []).length > 1 ? (c.name || '?') + ': ' : '') + s);
    }
  });
  return parts.join(' | ');
}

function k8sConfigRefTags(w) {
  const refs = [];
  (w.containers || []).forEach(c => {
    (c.envRefs || []).forEach(r => refs.push(r.type + ':' + r.ref));
    (c.envFrom || []).forEach(r => refs.push(r.type + ':' + r.ref));
  });
  return [...new Set(refs)].map(t => '<span class="consumer-tag">' + esc(t) + '</span>').join('');
}

function renderK8s() {
  const k = MODEL.k8s;
  if (!k || !k.present) return;
  const query = (document.getElementById('k8s-search')?.value || '').toLowerCase();
  const wl = k.workloads.filter(r => k8sMatch(r, query));
  const svcs = k.services.filter(r => k8sMatch(r, query));
  const cfgs = k.configs.filter(r => k8sMatch(r, query));
  const pvcs = k.storage.filter(r => k8sMatch(r, query));
  const ings = k.ingresses.filter(r => {
    if (k8sNs !== 'all' && (r.namespace || 'default') !== k8sNs) return false;
    if (!query) return true;
    if ((r.name || '').toLowerCase().includes(query)) return true;
    return (r.paths || []).some(p => ((p.path || '') + ' ' + (p.serviceName || '') + ' ' + (p.host || '')).toLowerCase().includes(query));
  });

  document.getElementById('k8s-metrics').innerHTML = [
    { v: k.total, l: 'K8s 资源' },
    { v: k.workloads.length, l: '工作负载' },
    { v: k.services.length, l: 'Service' },
    { v: k.ingresses.reduce((s, i) => s + (i.paths || []).length, 0), l: 'Ingress 路由' },
    { v: k.configs.length, l: 'ConfigMap/Secret' },
    { v: k.storage.length, l: 'PVC' },
    { v: k.namespaces.length, l: '命名空间' },
  ].map(m => '<div class="metric-card"><div class="metric-val">' + m.v + '</div><div class="metric-label">' + m.l + '</div></div>').join('');

  const wlEl = document.getElementById('k8s-workloads');
  if (wl.length === 0) wlEl.innerHTML = '<div class="empty">无匹配的工作负载</div>';
  else wlEl.innerHTML = '<table><thead><tr><th>名称</th><th>Kind</th><th>命名空间</th><th>副本</th><th>镜像</th><th>探针</th><th>资源限额</th><th>配置引用</th><th>来源</th></tr></thead><tbody>' +
    wl.map(w => {
      const images = (w.containers || []).map(c => '<div class="mono" style="font-size:11px;word-break:break-all;">' + esc(c.image || c.name || '') + '</div>').join('');
      const limits = k8sResourceLimits(w);
      const cfgTags = k8sConfigRefTags(w);
      return '<tr>' +
        '<td class="mono">' + esc(w.name) + '</td>' +
        '<td><span class="badge">' + esc(w.kind) + '</span></td>' +
        '<td class="mono">' + esc(w.namespace || 'default') + '</td>' +
        '<td>' + (w.replicas != null ? '×' + w.replicas : '—') + '</td>' +
        '<td>' + (images || '—') + '</td>' +
        '<td>' + k8sProbeBadges(w) + '</td>' +
        '<td class="mono" style="font-size:11px;">' + (limits ? esc(limits) : '<span style="color:var(--amber);">未限额</span>') + '</td>' +
        '<td>' + (cfgTags || '—') + '</td>' +
        '<td class="mono" style="font-size:11px;color:var(--fg-faint);">' + esc(w.source) + '</td>' +
      '</tr>';
    }).join('') +
  '</tbody></table>';

  const svcEl = document.getElementById('k8s-services');
  if (svcs.length === 0) svcEl.innerHTML = '<div class="empty">无匹配的 Service</div>';
  else svcEl.innerHTML = '<table><thead><tr><th>名称</th><th>类型</th><th>命名空间</th><th>端口映射</th><th>selector</th><th>来源</th></tr></thead><tbody>' +
    svcs.map(s => {
      const ports = (s.ports || []).map(p => esc(p.port) + (p.targetPort !== p.port ? '→' + esc(p.targetPort) : '') + (p.name ? ' (' + esc(p.name) + ')' : '')).join('<br>');
      const selector = Object.entries(s.selector || {}).map(([sk, sv]) => '<span class="consumer-tag">' + esc(sk) + '=' + esc(sv) + '</span>').join('');
      return '<tr>' +
        '<td class="mono">' + esc(s.name) + '</td>' +
        '<td><span class="badge">' + esc(s.serviceType || 'ClusterIP') + '</span></td>' +
        '<td class="mono">' + esc(s.namespace || 'default') + '</td>' +
        '<td class="mono">' + (ports || '—') + '</td>' +
        '<td>' + (selector || '<span style="color:var(--fg-faint);">—</span>') + '</td>' +
        '<td class="mono" style="font-size:11px;color:var(--fg-faint);">' + esc(s.source) + '</td>' +
      '</tr>';
    }).join('') +
  '</tbody></table>';

  const ingEl = document.getElementById('k8s-ingresses');
  if (ings.length === 0) ingEl.innerHTML = '<div class="empty">' + (k.ingresses.length === 0 ? '未发现 K8s Ingress 资源（入口流量可能由 nginx 网关 / Service NodePort 承担）' : '无匹配的 Ingress') + '</div>';
  else ingEl.innerHTML = '<table><thead><tr><th>Ingress</th><th>命名空间</th><th>Host</th><th>路径</th><th>后端 Service</th><th>来源</th></tr></thead><tbody>' +
    ings.map(i => (i.paths || []).map(p =>
      '<tr>' +
        '<td class="mono">' + esc(i.name) + '</td>' +
        '<td class="mono">' + esc(i.namespace || 'default') + '</td>' +
        '<td class="mono">' + esc(p.host || i.hosts?.[0] || '*') + '</td>' +
        '<td class="mono">' + esc(p.path || '/') + '</td>' +
        '<td class="mono" style="color:var(--green);">' + esc(p.serviceName || '?') + (p.servicePort != null ? ':' + esc(p.servicePort) : '') + '</td>' +
        '<td class="mono" style="font-size:11px;color:var(--fg-faint);">' + esc(i.source) + '</td>' +
      '</tr>'
    ).join('') || '<tr><td class="mono">' + esc(i.name) + '</td><td colspan="5" style="color:var(--fg-faint);">无规则</td></tr>').join('') +
  '</tbody></table>';

  const cfgEl = document.getElementById('k8s-configs');
  const cfgList = [...cfgs, ...pvcs];
  if (cfgList.length === 0) cfgEl.innerHTML = '<div class="empty">无匹配的 ConfigMap / Secret / PVC</div>';
  else cfgEl.innerHTML = '<table><thead><tr><th>Kind</th><th>名称</th><th>命名空间</th><th>详情</th><th>键 / 模式</th><th>来源</th></tr></thead><tbody>' +
    cfgList.map(c => {
      let detail = '';
      let keys = '';
      if (c.kind === 'PersistentVolumeClaim') {
        detail = esc(c.storage || '?') + ' · ' + esc((c.accessModes || []).join(', '));
        keys = '<span class="consumer-tag">' + esc((c.accessModes || []).join(' / ')) + '</span>';
      } else if (c.kind === 'Secret') {
        detail = c.dataKeyCount + ' 个键 · ' + (c.dataSize > 1024 ? (c.dataSize / 1024).toFixed(1) + ' KB' : c.dataSize + ' B');
        keys = '<span style="color:var(--fg-faint);">键名已隐藏</span>';
      } else {
        detail = (c.dataKeyCount || 0) + ' 个键 · ' + ((c.dataSize || 0) > 1024 ? (c.dataSize / 1024).toFixed(1) + ' KB' : (c.dataSize || 0) + ' B');
        keys = (c.dataKeys || []).slice(0, 10).map(kk => '<span class="consumer-tag">' + esc(kk) + '</span>').join('') +
          ((c.dataKeys || []).length > 10 ? '<span style="color:var(--fg-faint);font-size:11px;"> +' + ((c.dataKeys || []).length - 10) + '</span>' : '');
      }
      return '<tr>' +
        '<td><span class="badge">' + esc(c.kind) + '</span></td>' +
        '<td class="mono">' + esc(c.name) + '</td>' +
        '<td class="mono">' + esc(c.namespace || 'default') + '</td>' +
        '<td>' + esc(detail) + '</td>' +
        '<td>' + keys + '</td>' +
        '<td class="mono" style="font-size:11px;color:var(--fg-faint);">' + esc(c.source) + '</td>' +
      '</tr>';
    }).join('') +
  '</tbody></table>' + ((k.others || []).length ?
    '<div style="margin-top:10px;font-size:12px;color:var(--fg-dim);">其他资源：' + k.others.map(o => '<span class="consumer-tag">' + esc(o.kind + ' ' + (o.name || '')) + '</span>').join('') + '</div>' : '');
}

(function() {
  const k = MODEL.k8s;
  if (!k || !k.present) return;
  document.getElementById('k8s-ns-filters').innerHTML =
    '<div class="chip active" data-ns="all" onclick="setK8sNs(this,\\'all\\')">全部</div>' +
    k.namespaces.map(ns => '<div class="chip" data-ns="' + esc(ns) + '" onclick="setK8sNs(this,\\'' + esc(ns) + '\\')">' + esc(ns) + '</div>').join('');
  renderK8s();
})();

function setK8sNs(chip, ns) {
  document.querySelectorAll('#k8s-ns-filters .chip').forEach(f => f.classList.remove('active'));
  chip.classList.add('active');
  k8sNs = ns;
  renderK8s();
}

// ---- 9. 健康审计 ----
(function() {
  const h = MODEL.audits?.health;
  if (!h) return;

  document.getElementById('health-score').innerHTML =
    '<div class="health-score">' +
      scoreRingSvg(h.score, { label: '等级 ' + h.grade, size: 156 }) +
      '<div style="flex:1;">' +
        '<h2 style="font-size:18px;margin-bottom:8px;">部署架构健康度总评</h2>' +
        '<div style="color:var(--fg-dim);margin-bottom:8px;">基于 ' + MODEL.meta.serviceCount + ' 个服务 / ' + MODEL.meta.routeCount + ' 条路由 / ' + MODEL.meta.dependencyCount + ' 条依赖的静态分析</div>' +
        '<div style="display:flex;gap:16px;flex-wrap:wrap;">' +
          '<span style="color:var(--red);">● ' + h.errorCount + ' 错误</span>' +
          '<span style="color:var(--amber);">● ' + h.warnCount + ' 警告</span>' +
          '<span style="color:var(--blue);">● ' + h.infoCount + ' 提示</span>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.getElementById('health-dimensions').innerHTML = (h.dimensions || []).map(d => {
    const c = d.score >= 80 ? 'var(--green)' : d.score >= 60 ? 'var(--amber)' : 'var(--red)';
    return '<div class="dim-card">' +
      '<div class="dim-name">' + esc(d.label) + ' <span style="color:var(--fg-faint);">权重 ' + Math.round(d.weight * 100) + '%</span></div>' +
      '<div class="dim-score" style="color:' + c + '">' + d.score + '</div>' +
      '<div class="dim-bar"><div class="dim-bar-fill" style="--bar-c:' + c + ';width:' + d.score + '%"></div></div>' +
    '</div>';
  }).join('');

  document.getElementById('health-issues').innerHTML = (h.topFindings || []).map(f =>
    '<div class="issue-item ' + f.level + '">' +
      '<strong>' + (f.level === 'error' ? '错误' : f.level === 'warn' ? '警告' : '提示') + '</strong> · ' + esc(f.title) +
      (f.location ? '<span class="loc">' + esc(f.location) + '</span>' : '') +
    '</div>'
  ).join('') || '<div style="color:var(--green);">✓ 未发现问题</div>';

  const details = ['security', 'resilience', 'configConsistency', 'dependency'].map(key => {
    const a = MODEL.audits?.[key];
    if (!a) return '';
    const c = a.score >= 80 ? 'var(--green)' : a.score >= 60 ? 'var(--amber)' : 'var(--red)';
    const findings = (a.findings || []).map(f =>
      '<div class="issue-item ' + f.level + '">' +
        '<strong>' + (f.level === 'error' ? '错误' : f.level === 'warn' ? '警告' : '提示') + '</strong> · ' + esc(f.title) +
        (f.detail ? '<div style="color:var(--fg-dim);font-size:12px;margin-top:2px;white-space:pre-wrap;">' + esc(f.detail) + '</div>' : '') +
        (f.location ? '<span class="loc">' + esc(f.location) + '</span>' : '') +
      '</div>'
    ).join('');
    return '<div style="margin-bottom:20px;">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">' +
        '<span style="font-size:15px;font-weight:600;">' + esc(a.label) + '</span>' +
        '<span class="badge" style="color:' + c + ';border-color:' + c + '40;">得分 ' + a.score + '</span>' +
        '<span style="color:var(--fg-dim);font-size:12px;">' + (a.findings || []).length + ' 项发现</span>' +
      '</div>' +
      (findings || '<div style="color:var(--green);">✓ 全部通过</div>') +
    '</div>';
  }).join('');
  document.getElementById('audit-details').innerHTML = details;
})();

// init
renderTopology();
renderServices();
renderDepGraph();
</script>
</body>
</html>`;
}
