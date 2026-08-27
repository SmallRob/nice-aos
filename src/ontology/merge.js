// 多快照合并引擎（out-3，v0.34.0）：monorepo / 多子项目各有一份 code-ontology 快照时，
// `output --merge a/snapshot.json b/snapshot.json` 在 dataMap 层合成一份总览后再走
// 全格式渲染管线（md / html / json / viewmodel 无需分别改造）。
//
// 合并规则：
//   - 按"源顺序"线性吸收：先到者优先占据全局 id 空间
//   - Project 类型特殊处理：只保留首源的 Project 作为总览画像；后续源的 Project
//     折叠进 _meta.mergedProjects（防多 Project 干扰 markdown/viewmodel 的 [0] 取数）
//   - 冲突（同 id 再次出现）两种策略：
//       first-wins（默认）：保留先到者，计数上报
//       rename：后到的冲突对象重写为 `<sourceName>:<origId>` 并对**全部已收对象**做
//               引用字段泛键回填（字段名以 Id/Ids 结尾的值级替换）——无类型耦合，
//               新增链接类型无需改本模块
//   - _meta 合成：objectCounts 重算 + merged 元信息段

/**
 * @param {Object[]} snapshots 各源完整 dataMap（含 _meta）
 * @param {{
 *   strategy?: 'first-wins'|'rename',
 *   sources?: { name?: string, path?: string }[],
 * }} opts
 * @returns {{ dataMap: Object, meta: {
 *   strategy: string,
 *   conflicts: number,
 *   conflictSamples: string[],      // 前 10 个冲突 id（供 stderr 提示）
 *   renamedCount: number,
 *   droppedProjects: string[],      // 被折叠的非首源 Project 名
 *   sources: { name: string, path?: string }[],
 * }}}
 */
export function mergeSnapshots(snapshots, opts = {}) {
  const strategy = opts.strategy ?? 'first-wins';
  const sources = normalizeSources(opts.sources, snapshots);

  const out = {};
  const firstMeta = snapshots[0]?._meta ?? {};
  const newMeta = {
    analyzerVersion: firstMeta.analyzerVersion ?? null,
    generatedAt: new Date().toISOString(),
    snapshotVersion: firstMeta.snapshotVersion ?? null,
    merged: {
      strategy,
      sourceCount: snapshots.length,
      finishedAtSourceOrder: [...sources.map((s) => s.name)],
    },
  };
  out._meta = newMeta;

  // 首源 Project 即总览画像（无则报告如实呈现"无 Project"）
  const idSeen = new Set(); // 全局 id → 已收录
  let conflicts = 0;
  let renamedCount = 0;
  const droppedProjects = [];
  const conflictSamples = [];

  const collectFromSource = (dataMap, srcIdx) => {
    const sourceLabel = sources[srcIdx]?.name ?? `snap-${srcIdx}`;
    const renames = new Map(); // oldId → newId（跨源累计；收录任何对象前先按其回填）
    const applyRenames = (obj) => {
      let cur = obj;
      for (const [o, n] of renames) cur = rewriteIdRefs(cur, o, n);
      return cur;
    };
    for (const [type, arr] of Object.entries(dataMap)) {
      if (type === '_meta') continue;
      if (!Array.isArray(arr)) continue;
      if (out[type] === undefined) out[type] = [];
      for (const obj of arr) {
        if (type === 'Project') {
          if (srcIdx === 0) {
            out.Project.push(obj);
            if (obj.id) idSeen.add(obj.id);
          } else if (obj?.name) {
            droppedProjects.push(obj.name);
          }
          continue;
        }
        // 先应用历史重命名映射（后到源对象可能引用本源早前被重命名的 id）
        const prepared = renames.size > 0 ? applyRenames(obj) : obj;
        const oid = prepared?.id;
        if (oid && idSeen.has(oid)) {
          conflicts += 1;
          if (conflictSamples.length < 10) conflictSamples.push(`${type}:${oid}`);
          if (strategy === 'rename') {
            const newId = `${sourceLabel}:${oid}`;
            const renamedObj = rewriteIdRefs(prepared, oid, newId);
            renamedCount += 1;
            renames.set(oid, newId);
            idSeen.add(newId);
            // 引用回填策略：仅对【收录时机晚于本次 rename 的对象】经 applyRenames 生效——
            // 先到对象对新实体不持有引用意图，其指向原 id 的引用保持不变；
            // 后到源内部互引由收录时 applyRenames 统一覆盖
            out[type].push(renamedObj);
          }
          // first-wins：静默丢弃后到者
          continue;
        }
        if (oid) idSeen.add(oid);
        out[type].push(prepared);
      }
    }
  };

  snapshots.forEach(collectFromSource);

  // objectCounts 重算（与内容一致）
  const counts = {};
  for (const [t, arr] of Object.entries(out)) {
    if (t === '_meta' || !Array.isArray(arr)) continue;
    counts[t] = arr.length;
  }
  newMeta.objectCounts = counts;

  return {
    dataMap: out,
    meta: {
      strategy,
      conflicts,
      conflictSamples,
      renamedCount,
      droppedProjects,
      sources,
    },
  };
}

function normalizeSources(rawSources, snapshots) {
  if (Array.isArray(rawSources) && rawSources.length > 0) {
    return rawSources.map((s, i) => ({
      name: s?.name ?? `snap-${i}`,
      ...(s?.path ? { path: s.path } : {}),
    }));
  }
  return snapshots.map((_, i) => ({ name: `snap-${i}` }));
}

// 引用字段泛键回填：① 对象自身 id 重写；② 字段名以 Id / Ids 结尾（区分大小写，
// 避开 filePath/path 等噪声字段）且值命中 oldId 时替换。返回浅拷贝新对象，原对象不动。
const REF_FIELD_RE = /Id(s)?$/;

function rewriteIdRefs(obj, oldId, newId) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [...obj] : { ...obj };
  if (out.id === oldId) out.id = newId;
  for (const [k, v] of Object.entries(out)) {
    if (!REF_FIELD_RE.test(k)) continue;
    if (v === oldId) out[k] = newId;
    else if (Array.isArray(v) && v.includes(oldId)) {
      out[k] = v.map((x) => (x === oldId ? newId : x));
    }
  }
  return out;
}
