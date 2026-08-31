// src/canvas/canvasBuilder.js
// 画布构建器（程序化版 nice-aos-canvas-skill）：
//   - 把"读模板 + 注入数据"做成纯函数，避免 Agent/用户手动复制粘贴
//   - 多蓝图类型支持：deploy / overview（后续可扩展 db / service / planning）
//   - 输出自包含 HTML（零依赖、离线可开）
//
// 设计要点：
//   1. 模板与数据解耦：模板只负责"画"（含 JS 语义分析 + 布局 + 交互），数据来自快照；
//   2. 占位符契约：<script id="canvas-data" type="application/json">__CANVAS_DATA_JSON__</script>
//      由 canvasPaths.injectCanvasData 替换为合法 JSON；
//   3. 错误前置：模板缺失 / 数据字段不满足（无 services）→ 抛明确错误而非产出空图。
//
// 与 SKILL.md 的关系：SKILL.md 描述 Agent 视角的四阶段工作流；本模块是 Path A（模板驱动）
// 的程序化实现，让 `nice-aos deploy export --format canvas` / `nice-aos output --format canvas`
// 一行命令即可产出。

import { readCanvasTemplate, injectCanvasData, CANVAS_TEMPLATES } from './canvasPaths.js';

/**
 * 通用画布入口：按 kind 选模板 + 注入快照数据 + 返回自包含 HTML。
 * @param {object} args
 * @param {'deploy'|'overview'} args.kind  画布类型
 * @param {object} args.snapshot  蓝图快照（对应 nice-aos 的 deploy-snapshot / overview-snapshot）
 * @param {string} [args.title]  覆盖标题（默认从快照 _meta 推断）
 * @returns {{ html: string, kind: string, stats: object }}
 */
export function buildCanvas({ kind, snapshot, title } = {}) {
  if (!kind) throw new Error('buildCanvas: 必须指定 kind（deploy | overview）');
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('buildCanvas: 缺少 snapshot 数据');
  }
  // 数据充分性检查（先于模板读取，避免读到模板后才发现数据不行）
  validateSnapshot(kind, snapshot);

  const tpl = readCanvasTemplate(kind);
  const html = injectCanvasData(tpl, snapshot);
  return {
    html,
    kind,
    stats: collectStats(kind, snapshot),
  };
}

/**
 * 部署蓝图画布：消费 deploy-snapshot.json。
 * @param {object} deployModel  完整 deploy 模型
 * @param {{ title?: string }} [opts]
 */
export function buildDeployCanvas(deployModel, opts = {}) {
  return buildCanvas({ kind: 'deploy', snapshot: deployModel, title: opts.title });
}

/**
 * 全景蓝图画布：消费 overview-snapshot.json。
 * @param {object} overviewModel
 * @param {{ title?: string }} [opts]
 */
export function buildOverviewCanvas(overviewModel, opts = {}) {
  return buildCanvas({ kind: 'overview', snapshot: overviewModel, title: opts.title });
}

/**
 * 自动检测可用的快照类型，返回对应画布。
 * 检测顺序：deploy → overview → （未来 db / service / planning）。
 * 全部缺失时抛出可定位错误。
 *
 * @param {{ deployModel?: object, overviewModel?: object, preferKind?: string }} args
 * @returns {{ html: string, kind: string, stats: object, source: string }}
 */
export function buildCanvasAuto({ deployModel, overviewModel, preferKind } = {}) {
  const order = preferKind
    ? [preferKind, ...['deploy', 'overview'].filter((k) => k !== preferKind)]
    : ['deploy', 'overview'];
  for (const k of order) {
    if (k === 'deploy' && hasServices(deployModel)) {
      return { ...buildDeployCanvas(deployModel), source: 'deploy-snapshot' };
    }
    if (k === 'overview' && hasProjects(overviewModel)) {
      return { ...buildOverviewCanvas(overviewModel), source: 'overview-snapshot' };
    }
  }
  const hint = [
    '未找到可用的画布数据。请先扫描对应蓝图：',
    '  nice-aos deploy scan --dir <deploy 目录>     # 部署蓝图（Docker / K8s / nginx）',
    '  nice-aos overview scan --projects-dir <root> # 全景架构（多项目聚合）',
  ].join('\n');
  throw new Error(hint);
}

// ─────────────── 内部辅助 ───────────────

function hasServices(m) {
  return m && Array.isArray(m.services) && m.services.length > 0;
}

function hasProjects(m) {
  return m && Array.isArray(m.projects) && m.projects.length > 0;
}

function validateSnapshot(kind, snapshot) {
  if (kind === 'deploy') {
    if (!hasServices(snapshot)) {
      throw new Error('deploy 画布需要 services 字段且至少 1 项；当前快照无服务。\n提示：先跑 `nice-aos deploy scan --dir <dir>` 重新扫描。');
    }
  } else if (kind === 'overview') {
    if (!hasProjects(snapshot)) {
      throw new Error('overview 画布需要 projects 字段且至少 1 项；当前快照无项目。\n提示：先跑 `nice-aos overview scan --projects-dir <root>` 重新扫描。');
    }
  } else {
    throw new Error(`buildCanvas: 不支持的 kind=${kind}（已实现: ${Object.keys(CANVAS_TEMPLATES).join(' / ')}）`);
  }
}

function collectStats(kind, snapshot) {
  if (kind === 'deploy') {
    return {
      kind,
      services: snapshot.services?.length ?? 0,
      routes: snapshot.routes?.length ?? 0,
      upstreams: snapshot.upstreams?.length ?? 0,
      dependencies: snapshot.dependencies?.length ?? 0,
      middleware: snapshot.middleware?.length ?? 0,
      environments: snapshot.environments?.length ?? 0,
      k8sResources: snapshot.k8sResources?.length ?? 0,
      layers: snapshot.layers?.length ?? 0,
      source: snapshot._meta?.sourceDir ?? null,
      scannedAt: snapshot._meta?.scannedAt ?? null,
    };
  }
  if (kind === 'overview') {
    return {
      kind,
      projects: snapshot.projects?.length ?? 0,
      applicationServices: snapshot.applicationServices?.length ?? 0,
      crossProjectDeps: snapshot.totals?.crossProjectDeps ?? 0,
      javaServices: snapshot.totals?.javaServices ?? 0,
      source: snapshot._meta?.projectsRoot ?? null,
      generatedAt: snapshot._meta?.generatedAt ?? null,
    };
  }
  return { kind };
}
