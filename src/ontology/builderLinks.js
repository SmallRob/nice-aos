// 相位 5（buildOntologyData 拆分）：renders 关系 + vclass renders 组合边回填 + Props 传递链
// 原为 builder.js 内联代码段（"6. renders 关系" + "6a. renders 组合边回填" + "6b. Props 传递链"），逻辑不变。
import { pascalCaseName, uniqueId } from './builderUtils.js';

export function builderLinksPhase(ctx) {
  const {
    scan, factsMap, components, compIdByName, componentsByFile, classes,
    resolutionStats, resolver, vclassByCompId,
  } = ctx;

  // 6. renders 关系：文件主组件的 JSX/模板标签 → 导入来源文件的组件
  // 统一标签解析（React 具名导入精确匹配为基底的超集）：
  //   局部 components 注册表 → import 索引（local 名 + PascalCase 双键）→ 全局 Vue.component 注册 → 同文件兜底；
  //   default 导入 → 目标文件 primary 组件（修复 Vue 默认导入名与组件名不一致的断裂）
  const globalVueComponents = new Map(); // PascalCase(全局注册名) → {file, exported}
  for (const [, facts] of factsMap) {
    for (const g of facts.vueGlobalComponents ?? []) {
      const key = pascalCaseName(g.name);
      if (globalVueComponents.has(key)) continue;
      for (const imp of facts.imports) {
        if (!imp.resolved || imp.resolved.kind !== 'internal' || imp.isTypeOnly) continue;
        const n = (imp.names ?? []).find((x) => x.local === g.local && x.imported && x.imported !== '*');
        if (!n) continue;
        globalVueComponents.set(key, { file: imp.resolved.file, exported: n.imported });
        break;
      }
    }
  }
  // 导入索引：local 名 + PascalCase(local 名) 双键 → {file, exported}
  const buildImportIndex = (facts, relPath) => {
    const index = new Map();
    for (const imp of facts.imports) {
      if (!imp.resolved || imp.resolved.kind !== 'internal' || imp.isTypeOnly) continue;
      for (const n of imp.names) {
        if (!n.local || !n.imported || n.imported === '*') continue;
        const entry = { file: imp.resolved.file, exported: n.imported };
        if (!index.has(n.local)) index.set(n.local, entry);
        const pc = pascalCaseName(n.local);
        if (pc !== n.local && !index.has(pc)) index.set(pc, entry);
      }
    }
    // defineAsyncComponent / React.lazy 包装：const X = defineAsyncComponent(() => import('./x.vue'))
    // 模板/JSX 可直接用 X 作标签（snowy 等 Vue3 项目惯用）
    for (const w of facts.lazyWrappers ?? []) {
      if (!w.name || index.has(w.name)) continue;
      const r = resolver.resolve(relPath, w.importPath);
      if (r.kind === 'internal') index.set(w.name, { file: r.file, exported: 'default' });
    }
    return index;
  };
  // 导入目标 → 目标文件组件（default → primary；具名 → exported 名 → tag 名；.vue 文件 primary 兜底）
  const pickTargetComponent = (target, tag) => {
    const targetComps = componentsByFile.get(target.file) ?? [];
    if (!targetComps.length) return null;
    if (target.exported === 'default') {
      return targetComps.find((c) => c.isPrimary) ?? targetComps[0];
    }
    return targetComps.find((c) => c.name === target.exported)
      ?? targetComps.find((c) => c.name === tag)
      ?? (target.file.endsWith('.vue') ? (targetComps.find((c) => c.isPrimary) ?? targetComps[0]) : null);
  };
  // 模板/JSX 标签 → 目标组件条目（componentsByFile 项）
  const resolveTagToComponent = (facts, tag, importIndex, fileComps) => {
    const pcTag = pascalCaseName(tag);
    // 1. Vue 局部注册表（Options API components 选项）：PascalCase(tag) → local 名 → 导入索引
    const regLocal = facts.vueComponents?.[pcTag] ?? facts.vueComponents?.[tag];
    if (regLocal) {
      const t = importIndex.get(regLocal);
      if (t) {
        const hit = pickTargetComponent(t, pcTag);
        if (hit) return hit;
      }
    }
    // 2. 导入索引直接命中（React 具名导入 / Vue3 setup 无注册表直用）
    const direct = importIndex.get(tag) ?? importIndex.get(pcTag);
    if (direct) {
      const hit = pickTargetComponent(direct, pcTag);
      if (hit) return hit;
    }
    // 3. 全局注册兜底（main.js 的 Vue.component）
    const globalTarget = globalVueComponents.get(pcTag) ?? globalVueComponents.get(tag);
    if (globalTarget) {
      const hit = pickTargetComponent(globalTarget, pcTag);
      if (hit) { resolutionStats.vueGlobalFallbackCount += 1; return hit; }
    }
    // 4. 同文件兜底（无 import 记录的同文件导出组件）
    const sameFile = fileComps.find((c) => c.name === tag) ?? fileComps.find((c) => c.name === pcTag);
    if (sameFile) resolutionStats.vueSameFileFallbackCount += 1;
    return sameFile ?? null;
  };
  for (const relPath of scan.files) {
    const facts = factsMap.get(relPath);
    if (!facts.primaryComponentName) continue;
    const primaryId = compIdByName.get(facts.primaryComponentName);
    if (!primaryId || !facts.jsxTags.size) continue;
    const importIndex = buildImportIndex(facts, relPath);
    const primary = components.find((c) => c.id === primaryId);
    if (!primary) continue;
    const fileComps = componentsByFile.get(relPath) ?? [];
    for (const tag of facts.jsxTags) {
      const hit = resolveTagToComponent(facts, tag, importIndex, fileComps);
      if (hit && hit.id !== primaryId && !primary.rendersIds.includes(hit.id)) {
        primary.rendersIds.push(hit.id);
      }
    }
  }

  // 6a. renders 组合边回填：组件 renders 关系映射到 vclass（非 vclass 目标不成边，保持类图纯净）
  {
    const compById = new Map(components.map((c) => [c.id, c]));
    for (const [compId, vclassId] of vclassByCompId) {
      const comp = compById.get(compId);
      const vclass = classes.find((c) => c.id === vclassId);
      if (!comp?.rendersIds?.length || !vclass) continue;
      for (const rid of comp.rendersIds) {
        const targetVclass = vclassByCompId.get(rid);
        if (targetVclass && targetVclass !== vclassId && !vclass.rendersIds.includes(targetVclass)) {
          vclass.rendersIds.push(targetVclass);
        }
      }
    }
  }

  // 6b. Props 传递链：tsx/jsx 的 jsxPropRenders + .vue 的 vuePropRenders（含来源分类）→ 按组件对聚合的 PropEdge 对象
  const propEdges = [];
  {
    const SOURCE_PRIORITY = { forward: 6, state: 5, store: 4, handler: 3, computed: 2, literal: 1, spread: 0 };
    const compById = new Map(components.map((c) => [c.id, c]));
    const agg = new Map(); // `${fromId}→${toId}` → { fromId, toId, props: Map<name, prop>, renderCount }
    for (const relPath of scan.files) {
      const isVue = relPath.endsWith('.vue');
      if (!isVue && !/\.(tsx|jsx)$/.test(relPath)) continue;
      const facts = factsMap.get(relPath);
      const passes = isVue ? facts?.vuePropRenders : facts?.jsxPropRenders;
      if (!passes?.length) continue;
      const importIndex = buildImportIndex(facts, relPath);
      const fileComps = componentsByFile.get(relPath) ?? [];
      for (const pass of passes) {
        // .vue 为单组件语义：from 固定取文件 primary 组件（vuePropRenders 无 fromComponent 字段）
        const from = isVue
          ? (fileComps.find((c) => c.isPrimary) ?? fileComps[0])
          : (pass.fromComponent ? fileComps.find((c) => c.name === pass.fromComponent) : null);
        if (!from) continue;
        const to = resolveTagToComponent(facts, pass.tag, importIndex, fileComps);
        if (!to || to.id === from.id) continue;
        const key = `${from.id}→${to.id}`;
        let entry = agg.get(key);
        if (!entry) {
          entry = { fromId: from.id, toId: to.id, props: new Map(), renderCount: 0 };
          agg.set(key, entry);
        }
        entry.renderCount += 1;
        for (const p of pass.props) {
          const prev = entry.props.get(p.name);
          if (!prev || (SOURCE_PRIORITY[p.source] ?? 0) > (SOURCE_PRIORITY[prev.source] ?? 0)) {
            entry.props.set(p.name, { name: p.name, source: p.source, valueText: p.valueText, storeHook: p.storeHook ?? null });
          }
        }
      }
    }
    const propEdgeIdsUsed = new Set();
    for (const entry of agg.values()) {
      const props = [...entry.props.values()];
      if (!props.length) continue;
      const from = compById.get(entry.fromId);
      const to = compById.get(entry.toId);
      const id = uniqueId(`prop:${from.name}→${to.name}`, propEdgeIdsUsed);
      propEdges.push({
        id,
        fromComponentId: entry.fromId,
        toComponentId: entry.toId,
        fromFileId: `file:${from.filePath}`,
        toFileId: `file:${to.filePath}`,
        props,
        renderCount: entry.renderCount,
        reviewed: false,
        notes: null,
      });
    }
    // 组件出入度统计
    for (const c of components) {
      c.propOutCount = 0;
      c.propInCount = 0;
    }
    for (const e of propEdges) {
      const from = components.find((c) => c.id === e.fromComponentId);
      const to = components.find((c) => c.id === e.toComponentId);
      if (from) from.propOutCount += 1;
      if (to) to.propInCount += 1;
    }
  }

  Object.assign(ctx, { propEdges });
}
