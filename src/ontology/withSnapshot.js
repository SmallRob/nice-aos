// withSnapshot：透明快照保障包装。
// 借鉴 asdm-aos-server 的 withGraph(gid, fn)（mcp.server.ts:53-56）：
//   "查询类工具未命中内存时会自动加载，无需先调 load"。
//
// 借鉴的是**思路**（透明、对外不暴露加载步骤），不抄实现：
//   - asdm 走 core-service HTTP 拉取；nice-aos 走本地 buildOntologyData + 本地 snapshot.json
//   - asdm 用 sessionId + ensureGraphLoaded；nice-aos 用 NO_SNAPSHOT 错误码 + 兜底构建
//   - asdm 失败抛 AppError；nice-aos 失败透传原始错误（保持错误可诊断性）
//
// 与现有 CLI 关系：
//   - action.js refreshRepo 是显式入口（推荐路径）
//   - ask.js / link.js / query.js / export.js 共享 loadSnapshot（无兜底，缺快照就抛 NO_SNAPSHOT）
//   - 本模块为**新形态**（MCP server 内部 / HTTP serve endpoint / ondemand 脚本）提供兜底构建，
//     复用同源 buildOntologyData，避免各调用方各自写 fallback
//
// 默认 silent：与 ADR 0001 决策 4 "silent 默认" 一致；测试 / onProgress 场景传 silent:false

import { loadSnapshot, saveSnapshot } from './snapshot.js';
import { buildOntologyData } from './builder.js';

/**
 * @typedef {Object} WithSnapshotOptions
 * @property {boolean} [silent=true] 是否静默构建（false 时消费方需自接 onProgress）
 * @property {boolean} [forceRefresh=false] 强制重建（忽略缓存）
 * @property {Array<string>} [roots] 构建根目录（参照 action.js refreshRepo 路径）
 * @property {(step: string, payload: Object) => void} [onProgress] 进度回调（透传给 buildOntologyData）
 * @property {(dataMap: Object) => void} [onRebuild] 重建完成回调（仅在本次确实重建时触发，不影响 fn）
 */

/**
 * 透明快照保障：当前快照存在时直接使用 fn(snap)；缺失或 forceRefresh 时先 buildOntologyData 再 fn(snap)。
 *
 * @param {string} projectRoot 待分析项目根（绝对路径）
 * @param {(snap: Object) => any | Promise<any>} fn 拿到 snap 后执行的函数
 * @param {WithSnapshotOptions} [opts]
 * @returns {Promise<{value: any, rebuilt: boolean}>} fn 返回值 + 是否本次确实重建（观测用）
 */
export async function withSnapshot(projectRoot, fn, opts = {}) {
  const { silent = true, forceRefresh = false, roots, onProgress, onRebuild } = opts;

  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new Error('withSnapshot: 必须传入 projectRoot 字符串');
  }
  if (typeof fn !== 'function') {
    throw new Error('withSnapshot: 必须传入 fn 回调函数');
  }

  let snap = null;
  let rebuilt = false;

  if (!forceRefresh) {
    try {
      snap = loadSnapshot();
    } catch (err) {
      // NO_SNAPSHOT 是唯一可兜底场景；其他错误（JSON 损坏 / IO）必须透传
      if (err?.code !== 'NO_SNAPSHOT') throw err;
      // 否则 snap 留空，进入构建分支
    }
  }

  if (!snap) {
    snap = await buildOntologyData(projectRoot, {
      silent,
      roots,
      onProgress,
    });
    saveSnapshot(snap);
    rebuilt = true;
    if (typeof onRebuild === 'function') {
      try {
        onRebuild(snap);
      } catch {
        // onRebuild 异常不影响 fn 执行（兜底观测通道）
      }
    }
  }

  const value = await fn(snap);
  return { value, rebuilt };
}

/**
 * 仅触发保证（不消费 fn）：用于"我要先确保快照可用"的场景。
 * 与 withSnapshot 区别：不传 fn，直接返回 snap。
 *
 * @param {string} projectRoot
 * @param {WithSnapshotOptions} [opts]
 * @returns {Promise<Object>} 当前/重建后的 snap
 */
export async function ensureSnapshot(projectRoot, opts = {}) {
  const { value } = await withSnapshot(projectRoot, (snap) => snap, opts);
  return value;
}
