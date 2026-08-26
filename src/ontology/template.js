// 极简模板引擎：{{path.to.field}} 占位符替换
// 借鉴 asdm-aos 的 blueprint builder 风格（数据 → 字符串），但只用纯字符串替换
//
// 支持的占位符形式：
//   {{Project.name}}              → dataMap.Project[0].name（Project 数组自动取首元素）
//   {{Project.fileCount}}         → 同上
//   {{stats.Component}}            → dataMap.Component.length
//   {{Project.architecture.styleLabel}}
//   {{Health.complexity.avg}}     → dataMap.Project[0].health.complexity.avg（如果存在）
//   {{ObjectCounts.Module}}       → dataMap._meta.objectCounts.Module
//
// 找不到的字段：输出 (unknown:key) 兜底，避免模板崩溃
//
// 注：高级模板（Mustache/Handlebars 风格）超出 MVP 范围；用户可读 .tpl 文件自助扩展

import { buildViewerModel } from './viewer.js';

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/g;

// 解析占位符 path 到 dataMap 里的实际值
// 返回字符串（找不到时返回空字符串，前端用 replace 占位）
function resolvePlaceholder(key, dataMap) {
  const segs = key.split('.');
  // 第 1 段通常表示"对象类型"或"Project"或"_meta"
  const root = segs[0];

  // 1) _meta 子树：{{_meta.objectCounts.Module}} → dataMap._meta.objectCounts.Module
  if (root === '_meta') {
    const v = segs.slice(1).reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), dataMap._meta);
    return v == null ? '' : v;
  }

  // 1.5) ObjectCounts 语法糖：{{ObjectCounts.Module}} → _meta.objectCounts.Module
  //      用户视角更直观（"对象统计"），不需知道 _meta 中间层
  if (root === 'ObjectCounts' && segs.length >= 2) {
    const v = segs.slice(1).reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), dataMap._meta?.objectCounts);
    if (v != null) return v;
  }

  // 2) stats.<Type>：返回数组长度
  if (root === 'stats' && segs.length === 2) {
    const arr = dataMap[segs[1]];
    return Array.isArray(arr) ? arr.length : 0;
  }

  // 3) Health.<dim>：从 Project[0].health 取（如 Health.complexity）
  if (root === 'Health' && segs.length >= 2) {
    const proj = dataMap.Project?.[0];
    const v = segs.slice(1).reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), proj?.health);
    if (v != null) return v;
  }

  // 4) 一般对象类型（Component/Method/Module/Domain 等）：
  //    - {{Component.length}} → 数组长度
  //    - {{Component.0.name}} → 第一项的 name
  //    - {{Component.first.name}} → 同样第一项
  const arr = dataMap[root];
  if (Array.isArray(arr)) {
    if (segs.length === 2 && segs[1] === 'length') return arr.length;
    // 数字或 'first'：取首元素
    const first = arr[0];
    if (first && typeof first === 'object') {
      const v = segs.slice(1).reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), first);
      if (v != null) return v;
    }
  }

  // 5) Project 单数：{{Project.name}} → dataMap.Project[0].name
  if (root === 'Project') {
    const proj = dataMap.Project?.[0];
    if (proj && typeof proj === 'object') {
      const v = segs.slice(1).reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), proj);
      if (v != null) return v;
    }
  }

  // 6) viewerModel 兜底（让用户能拿更聚合的字段）
  // 延迟构建：只在 root 不在 dataMap 顶层时尝试
  try {
    const vm = buildViewerModel(dataMap);
    if (root in vm || segs[0] in vm) {
      const v = segs.reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), vm);
      if (v != null) return v;
    }
  } catch { /* 不可用时忽略 */ }

  return ''; // 找不到时返回空字符串（不输出 (unknown:key) 兜底文本，让模板更干净）
}

// 渲染模板：用占位符的实际值替换
export function renderTemplate(templateStr, dataMap) {
  return templateStr.replace(PLACEHOLDER_RE, (match, key) => {
    const v = resolvePlaceholder(key, dataMap);
    if (v === '' || v == null) return `(unknown:${key})`;
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });
}

// 从文件读模板并渲染（便利函数）—— export.js 用 fs.readFileSync 读后调用 renderTemplate
// 本模块不强制绑 fs：保持纯函数 + 无副作用，便于测试与跨运行时
