// 死代码图遍历算法。
// 借鉴 code-graph-rag 的 `cgr dead-code` 模式（docs/guide/dead-code.md）：
//   - Roots：entry files 中的 module functions + 所有 exported + test files + 用户 --entry-point
//   - 沿 *Ids / *Id 边 BFS（calls / imports / usesStore / usesHook / extends / implements / overrides / registers / ...）
//   - 不可达 + 符合 dead 条件 → dead candidate
//
// 与 nice-aos 现有启发式互补：
//   - 现有（builder.js line 300/307/337）：non-exported + 本文件零引用 → dead
//     局限：跨文件零调用检测不到（导出 helper 实际没人用）
//   - 新增（BFS）：exported 不可达 → dead
//     价值：找出被导出但实际未被任何 root 调用的 helper（典型死代码）
//
// 阶段 1.2 范围：算法 + CLI 子命令 + MCP tool。不替代现有启发式，并行触发。

// 入口文件 basename（与 builder.js line 32 保持一致；避免循环 import）
const ENTRY_BASENAMES = new Set([
  'App.tsx', 'index.tsx', 'main.tsx', 'index.ts', 'main.ts',
  'main.js', 'App.vue', 'main.dart', 'main.go',
]);

// 测试文件判定（与 builder.js line 116 保持一致）
function isTestFile(relPath) {
  if (!relPath) return false;
  if (relPath.endsWith('_test.go')) return true; // Go 惯例
  return /(__tests__|\.test\.|\.spec\.)/.test(relPath)
    || relPath.startsWith('src/tests/')
    || relPath.startsWith('src/e2e/');
}

function isEntryFileRel(relPath) {
  if (!relPath) return false;
  const base = relPath.split('/').pop() || '';
  if (!ENTRY_BASENAMES.has(base)) return false;
  // Go: 每个 main.go 都是入口
  if (relPath.endsWith('.go')) return true;
  // 其他：根级或 src 根级
  return relPath === base
    || relPath === `src/${base}`
    || /^src\//.test(relPath) && relPath.split('/').length === 2;
}

/**
 * 从对象收集所有 *Ids / *Id 字段值（作为 BFS 出边）。
 * @param {Object} obj
 * @returns {string[]} out-neighbor ids
 */
function collectOutNeighbors(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'id' || k === '_type') continue;
    if (Array.isArray(v) && k.endsWith('Ids')) {
      for (const tid of v) {
        if (typeof tid === 'string') out.push(tid);
      }
    } else if (typeof v === 'string' && k.endsWith('Id') && !k.endsWith('Ids')) {
      out.push(v);
    }
  }
  return out;
}

/**
 * 计算可达集。
 *
 * @param {Object} snap 本体快照
 * @param {{
 *   extraEntryIds?: string[],   // 显式 --entry-point
 *   entryFiles?: string[],      // 显式声明的额外入口文件
 *   includeInterfaces?: boolean, // interface 是否作为 root（默认 true；TS 中 interface 即使无运行时用途也应被检测）
 *   verbose?: boolean,           // 调试日志
 * }} [opts]
 * @returns {{
 *   reachable: Set<string>,
 *   roots: Set<string>,
 *   byId: Map<string, Object>,
 *   stats: { nodesTotal, nodesReachable, rootsCount, queueOps }
 * }}
 */
export function computeReachableSet(snap, opts = {}) {
  const {
    extraEntryIds = [],
    entryFiles = [],
    includeInterfaces = true,
    verbose = false,
  } = opts;

  // 1. byId 索引
  const byId = new Map();
  for (const [type, arr] of Object.entries(snap)) {
    if (type.startsWith('_')) continue;
    if (!Array.isArray(arr)) continue;
    for (const obj of arr) {
      if (obj?.id) byId.set(obj.id, obj);
    }
  }

  // 1a. 反向索引：method → owner class/interface
  // class.methodIds 是向下（class → method），但 BFS 从 method 出发时无法回到 class
  // 当 method 可达时，owner class/interface 也视为可达
  const ownerByMethod = new Map();
  for (const c of snap.Class ?? []) {
    for (const mid of c.methodIds ?? []) {
      ownerByMethod.set(mid, c.id);
    }
  }
  for (const i of snap.Interface ?? []) {
    for (const mid of i.methodIds ?? []) {
      ownerByMethod.set(mid, i.id);
    }
  }
  // file → components/hooks（Component.fileId === file.id）
  // 反向边：file 可达时，文件内所有 Component / Hook 也算可达
  const compsByFile = new Map();
  for (const c of snap.Component ?? []) {
    if (!c.fileId) continue;
    if (!compsByFile.has(c.fileId)) compsByFile.set(c.fileId, []);
    compsByFile.get(c.fileId).push(c.id);
  }
  const hooksByFile = new Map();
  for (const h of snap.Hook ?? []) {
    if (!h.fileId) continue;
    if (!hooksByFile.has(h.fileId)) hooksByFile.set(h.fileId, []);
    hooksByFile.get(h.fileId).push(h.id);
  }
  // file → class/interface（Class.fileId === file.id）
  // 反向边：file 可达时，文件内所有 Class / Interface / Method 也算可达
  const classesByFile = new Map();
  for (const c of snap.Class ?? []) {
    if (!c.fileId) continue;
    if (!classesByFile.has(c.fileId)) classesByFile.set(c.fileId, []);
    classesByFile.get(c.fileId).push(c.id);
  }
  const ifacesByFile = new Map();
  for (const i of snap.Interface ?? []) {
    if (!i.fileId) continue;
    if (!ifacesByFile.has(i.fileId)) ifacesByFile.set(i.fileId, []);
    ifacesByFile.get(i.fileId).push(i.id);
  }
  const methodsByFile = new Map();
  for (const m of snap.Method ?? []) {
    if (!m.fileId) continue;
    if (!methodsByFile.has(m.fileId)) methodsByFile.set(m.fileId, []);
    methodsByFile.get(m.fileId).push(m.id);
  }

  // 2. 构造 roots
  // 设计：
  //   - entry files 中的 module functions（程序入口）
  //   - 所有 Component（framework 渲染，模拟 JSX 树）
  //   - test files 中的 method（测试入口）
  //   - 用户显式 --entry-point
  //   - **不**直接 add exported class/interface/module function：
  //     那些是被别人引用的"被引用方"，由 BFS 沿 importIds / callIds 决定是否可达
  //     没人引 = dead
  const roots = new Set();

  // 2a. entry files 中的 module functions + entry file 自身
  for (const m of snap.Method ?? []) {
    if (m.ownerKind === 'module' && m.filePath && isEntryFileRel(m.filePath)) {
      roots.add(m.id);
    }
  }
  // entry file 自身作为 root（main.tsx 不一定有名为 main 的 module function，
  // 但 file.importIds 能链到 import 的 Component）
  for (const f of snap.SourceFile ?? []) {
    if (f.isEntry && f.id) roots.add(f.id);
  }

  // 2b. Component（React/Vue/Flutter 框架渲染入口——BFS 找不到 framework 调用，必须当 root）
  for (const c of snap.Component ?? []) {
    if (c?.id) roots.add(c.id);
  }

  // 2c. 油猴函数：顶层 isTopLevel 函数视为脚本入口
  for (const fn of snap.ScriptFunction ?? []) {
    if (fn.isTopLevel && fn.id) roots.add(fn.id);
  }

  // 2d. 测试文件中的 method
  for (const m of snap.Method ?? []) {
    if (m.filePath && isTestFile(m.filePath) && m.id) roots.add(m.id);
  }

  // 2e. 显式声明的额外入口文件
  for (const rel of entryFiles) {
    for (const m of snap.Method ?? []) {
      if (m.filePath === rel && m.id) roots.add(m.id);
    }
    for (const c of snap.Component ?? []) {
      if (c.filePath === rel && c.id) roots.add(c.id);
    }
  }

  // 2f. 显式 --entry-point ids
  for (const id of extraEntryIds) {
    if (byId.has(id)) roots.add(id);
  }

  if (verbose) {
    console.error(`[deadCode] roots: ${roots.size}, byId: ${byId.size}`);
  }

  // 3. BFS
  const reachable = new Set();
  const queue = [...roots];
  let queueOps = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    queueOps += 1;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const obj = byId.get(id);
    if (!obj) continue;
    // 正向边：*Ids / *Id 字段
    const neighbors = collectOutNeighbors(obj);
    for (const nid of neighbors) {
      if (byId.has(nid) && !reachable.has(nid)) queue.push(nid);
    }
    // 反向边 1：method → owner class/interface
    const owner = ownerByMethod.get(id);
    if (owner && byId.has(owner) && !reachable.has(owner)) queue.push(owner);
    // 反向边 2：method on module → file
    if (obj.fileId && byId.has(obj.fileId) && !reachable.has(obj.fileId)) queue.push(obj.fileId);
    // 反向边 3：file → 该文件的所有 Component / Hook
    if (compsByFile.has(id)) {
      for (const cid of compsByFile.get(id)) {
        if (byId.has(cid) && !reachable.has(cid)) queue.push(cid);
      }
    }
    if (hooksByFile.has(id)) {
      for (const hid of hooksByFile.get(id)) {
        if (byId.has(hid) && !reachable.has(hid)) queue.push(hid);
      }
    }
    // 反向边 4：file → 该文件的所有 Class / Interface / Method
    if (classesByFile.has(id)) {
      for (const cid of classesByFile.get(id)) {
        if (byId.has(cid) && !reachable.has(cid)) queue.push(cid);
      }
    }
    if (ifacesByFile.has(id)) {
      for (const iid of ifacesByFile.get(id)) {
        if (byId.has(iid) && !reachable.has(iid)) queue.push(iid);
      }
    }
    if (methodsByFile.has(id)) {
      for (const mid of methodsByFile.get(id)) {
        if (byId.has(mid) && !reachable.has(mid)) queue.push(mid);
      }
    }
  }

  if (verbose) {
    console.error(`[deadCode] queueOps: ${queueOps}, reachable: ${reachable.size}`);
  }

  return {
    reachable,
    roots,
    byId,
    stats: {
      nodesTotal: byId.size,
      nodesReachable: reachable.size,
      rootsCount: roots.size,
      queueOps,
    },
  };
}

/**
 * 找出所有"导出但不可达"的 class。
 * 阶段 1.2 范围：**仅 class**（method 误报风险高，FC default export 经常 BFS 找不到）。
 * v0.34.0 扩展：method / interface dead 检测（需 --strict 模式或更精细的根推断）。
 *
 * @param {Object} snap
 * @param {Object} [opts]
 * @returns {{
 *   deadClasses: Array<{ id, name, filePath, line, reason }>,
 *   stats: { nodesTotal, nodesReachable, rootsCount, deadTotal }
 * }}
 */
export function findDeadExported(snap, opts = {}) {
  const { reachable, stats } = computeReachableSet(snap, opts);

  const deadClasses = [];
  for (const c of snap.Class ?? []) {
    if (!c.exported) continue;
    if (!reachable.has(c.id)) {
      deadClasses.push({
        id: c.id,
        name: c.name,
        filePath: c.filePath,
        line: c.line,
        reason: '导出但未从任何入口可达（entry-point BFS 不可达）',
      });
    }
  }

  // 排序：按 filePath, line
  const sortFn = (a, b) => (a.filePath || '').localeCompare(b.filePath || '') || (a.line || 0) - (b.line || 0);
  deadClasses.sort(sortFn);

  return {
    deadClasses,
    stats: { ...stats, deadTotal: deadClasses.length },
  };
}

/**
 * 把 dead 信息写回到 snapshot 的 Class 实体上（升级现有 deadCandidate 字段）。
 * 借鉴 asdm-aos 的 deadCandidate 字段语义。
 *
 * @param {Object} snap (in-place mutation)
 * @param {Object} [opts]
 * @returns {number} 新增 dead 标记数
 */
export function markDeadCandidates(snap, opts = {}) {
  const result = findDeadExported(snap, opts);
  let marked = 0;

  for (const c of result.deadClasses) {
    const orig = snap.Class?.find((x) => x.id === c.id);
    if (orig) {
      orig.deadCandidate = true;
      orig.deadReason = 'BFS 不可达（导出但未被任何入口引用）';
      marked += 1;
    }
  }
  return marked;
}
