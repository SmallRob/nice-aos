// 工具注册表：把 nice-aos 的能力暴露为 MCP tools。
// 借鉴 code-graph-rag 的 create_mcp_tools_registry 模式（codebase_rag/mcp/tools.py）：
//   - 工具定义 = {name, description, inputSchema, handler}
//   - registry.list() 返回所有工具的 metadata（不含 handler）
//   - registry.call(name, args) 按 name 查找并调 handler
//   - 错误用返回值表达（不抛），让 MCP layer 统一渲染
//
// 与现有 blueprintActions.js 的关系：
//   - blueprintActions.js 是"蓝图 UI 内的动作卡片"（markReviewed / addNote / refreshRepo / analyzeFile）
//   - 本文件是"MCP 工具"（无 UI、走协议、面向 AI agent）
//   - 两者参数共用 ParamDef 形态（src/ontology/paramDefs.js）
//
// inputSchema 用 JSON Schema 形态（MCP 标准），不是 zod：
//   - 避免新增 zod 依赖（nice-aos 零依赖原则）
//   - JSON Schema 与 ParamDef 几乎一一对应，转化简单
//   - code-graph-rag 的 SDK 默认接受 raw shape，本实现对齐
//
// 工具集（阶段 1 v0.33.0；v0.35.0 增 epistemic 信封 + 模糊元数据）：
//   1. get_stats         — 快照统计摘要
//   2. get_schema        — 本体元模型（对象/链接/动作 schema）
//   3. list_types        — 列出 20 种对象类型
//   4. query_objects     — 按类型 + where 条件查询（歧义名 → 候选列表）
//   5. get_node          — 按 id 查单个对象（不存在 → 相似候选）
//   6. traverse_links    — 链接遍历（_meta.epistemic + withMeta 模糊元数据 + byDepth 分层）
//   7. get_health        — 五维健康审计（从 _meta 读；含 resolutionStats 解析覆盖度）
// 后续阶段 2 增量加：query_graph（Cypher-like）、search_duplicates、trace_flows 等

import { OBJECT_TYPES, LINK_TYPES, ACTION_NAMES, ONTOLOGY_META } from './blueprint.js';
import { linkWithMeta2, linkBfsWithMeta } from './linkMeta.js';
import { projectObjects } from '../cli/shared.js'; // ADR 0012 D1：字段白名单投影（与 CLI query --field 同语义）

/**
 * 解析 where 条件字符串 "k=v,k2~v2" 为 [{key, op, value}] 数组。
 * 与 src/cli/commands/serve.js 的 parseWhere 行为完全一致。
 *
 * @param {string} whereStr
 * @returns {Array<{key: string, op: '='|'~', value: string}>}
 */
function parseWhere(whereStr) {
  if (!whereStr) return [];
  return String(whereStr)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^([\w.]+)(=|~)(.*)$/);
      if (!m) return null;
      return { key: m[1], op: m[2], value: m[3] };
    })
    .filter(Boolean);
}

/**
 * 判断 obj 是否满足 conditions（AND 关系）。
 * @param {Object} obj
 * @param {Array} conditions parseWhere 输出
 * @returns {boolean}
 */
function matchesWhere(obj, conditions) {
  for (const c of conditions) {
    const v = c.key.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
    if (v == null) return false;
    if (c.op === '=' && String(v) !== c.value) return false;
    if (c.op === '~' && !String(v).includes(c.value)) return false;
  }
  return true;
}

/**
 * 构造工具注册表实例。
 *
 * @param {Object} opts
 * @param {Object} opts.snap 本体快照（snapshot.json 解析后的对象）
 * @returns {{
 *   list: () => Array<{name, description, inputSchema}>,
 *   call: (name: string, args: Object) => Promise<{ok: boolean, [key: string]: any}>
 * }}
 */
export function createToolRegistry({ snap }) {
  if (!snap || typeof snap !== 'object') {
    throw new Error('createToolRegistry: 必须传入 snap（snapshot.json 解析结果）');
  }

  // byId 索引（O(1) 查询，避免每次 byType 重建）
  const byId = new Map();
  for (const [type, arr] of Object.entries(snap)) {
    if (type.startsWith('_')) continue;
    if (!Array.isArray(arr)) continue;
    for (const obj of arr) {
      if (obj?.id) byId.set(obj.id, { ...obj, _type: type });
    }
  }

  // 健康审计数据从 _meta 取（builder.js 写入的）
  const meta = snap._meta ?? {};
  const counts = meta.objectCounts || {};
  const cycles = meta.cycles || [];
  const orphanCandidates = meta.orphanCandidates || [];

  const tools = [
    {
      name: 'get_stats',
      description: '获取本体快照统计摘要：项目元信息（name/framework/branch/generatedAt）+ 各对象类型数量 + 循环依赖 + 孤儿候选',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const project = snap.Project?.[0];
        return {
          ok: true,
          name: project?.name ?? null,
          framework: project?.framework ?? null,
          branch: project?.branch ?? null,
          generatedAt: meta.generatedAt ?? null,
          counts,
          cycles,
          orphanCandidates,
        };
      },
    },

    {
      name: 'get_schema',
      description: '获取本体元模型：20 种对象类型（带 prefix/category/level 描述）、26 链接类型、4 个 action 名称、抽象层级（L0-L3）、6 个概念范畴。供 agent 自动发现能力',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => ({
        ok: true,
        meta: {
          version: ONTOLOGY_META.version,
          abstractionLevels: ONTOLOGY_META.abstractionLevels,
          categories: ONTOLOGY_META.categories,
        },
        objectTypes: OBJECT_TYPES,
        linkTypes: LINK_TYPES,
        actionNames: ACTION_NAMES,
        prefixMap: Object.fromEntries(OBJECT_TYPES.map((t) => [t.prefix, t.type])),
      }),
    },

    {
      name: 'list_types',
      description: '列出 20 种对象类型（仅 name + prefix + category + level + description 摘要，比 get_schema 更轻量）',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => ({
        ok: true,
        types: OBJECT_TYPES.map((t) => ({
          type: t.type,
          prefix: t.prefix,
          category: t.category,
          level: t.level,
          description: t.description,
        })),
      }),
    },

    {
      name: 'query_objects',
      description: '按类型与条件查询对象。type 必填（必为 20 种对象类型之一）；where 形如 "k=v,k2~v2"（= 全等、~ 包含）；limit 默认 200；fields 为字段白名单投影（id 恒保留）。返回 {ok, type, source, count, total, truncated, objects: [...]}',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: '对象类型名，如 Component / Method / SourceFile / UserScript 等（必填）',
            enum: OBJECT_TYPES.map((t) => t.type),
          },
          where: {
            type: 'string',
            description: '过滤条件：k=v（等于）、k~v（包含）；多条件逗号分隔 AND，如 "deadCandidate=true,language=ts"',
          },
          limit: {
            type: 'number',
            description: '最大返回数（默认 200，传 0 取全部）',
            default: 200,
            minimum: 0,
          },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: '字段白名单投影，如 ["id","name"]；id 恒保留，对象上不存在的字段不产生键',
          },
        },
        required: ['type'],
      },
      handler: async ({ type, where, limit = 200, fields }) => {
        if (!OBJECT_TYPES.some((t) => t.type === type)) {
          return {
            ok: false,
            error: `未知对象类型: ${type}`,
            validTypes: OBJECT_TYPES.map((t) => t.type),
          };
        }
        const objects = snap[type] ?? [];
        const conditions = parseWhere(where);
        const filtered = conditions.length ? objects.filter((o) => matchesWhere(o, conditions)) : objects;
        const total = filtered.length;
        const truncated = limit > 0 && total > limit;

        // v0.35.0 epistemic envelope：歧义名（~ 包含过滤多匹配）返回候选聚合
        // 触发条件：~ 操作符匹配数 > 1 且 limit 未截断；附按 name 分组的 Top5 候选 + 相关度
        const meta = {};
        if (conditions.length) {
          const nameCond = conditions.find((c) => c.key === 'name' && c.op === '~');
          if (nameCond && total > 1 && !truncated) {
            const groups = new Map();
            for (const o of filtered) {
              const n = o.name ?? '';
              if (!groups.has(n)) groups.set(n, { name: n, count: 0, sampleId: o.id });
              groups.get(n).count += 1;
            }
            const candidates = [...groups.values()]
              .map((g) => ({ ...g, relevance: nameRelevance(g.name, nameCond.value) }))
              .sort((a, b) => b.relevance - a.relevance || b.count - a.count)
              .slice(0, 5);
            meta.ambiguity = { queriedName: nameCond.value, distinctNames: groups.size, candidates };
          }
        }
        return {
          ok: true,
          type,
          count: truncated ? limit : total,
          total,
          truncated,
          objects: projectObjects(truncated ? filtered.slice(0, limit) : filtered, Array.isArray(fields) && fields.length ? fields : null),
          ...(Object.keys(meta).length ? { _meta: meta } : {}),
        };
      },
    },

    {
      name: 'get_node',
      description: '按 id 查单个对象（含自动推断的 _type 字段）。id 形如 "comp:Button"、"method:src/a.ts#foo"',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: '对象 id（如 comp:Button / method:src/a.ts#foo / us:script.user.js）',
          },
        },
        required: ['id'],
      },
      handler: async ({ id }) => {
        if (!id) return { ok: false, error: '缺少参数 id' };
        const obj = byId.get(id);
        if (obj) return { ok: true, object: obj };

        // v0.35.0 epistemic envelope：id 不存在时返回相似候选（不静默二选一）
        // 候选打分：编辑距离（prefix + 子串命中加权）；上限 5 条
        const candidates = findSimilarIds(byId, id, 5);
        return {
          ok: false,
          error: `对象不存在: ${id}`,
          _meta: {
            epistemic: 'lower-bound',
            ambiguity: {
              queried: id,
              candidates,
            },
          },
        };
      },
    },

    {
      name: 'traverse_links',
      description: '从源对象出发遍历链接关系。linkType 必填（24+ 链接类型之一）；srcId 必填；depth 控制 hop 数（默认 1）。返回相邻节点列表（不含源节点）。v0.35.0 起：默认带 _meta.epistemic 信封；withMeta=true 时额外返回每条边的 {confidence, reason}；depth>1 时输出按深度分层',
      inputSchema: {
        type: 'object',
        properties: {
          linkType: {
            type: 'string',
            description: '链接类型（必填）',
            enum: [...LINK_TYPES, 'links', 'all'],
          },
          srcId: {
            type: 'string',
            description: '源对象 id（必填）',
          },
          depth: {
            type: 'number',
            description: '遍历深度（默认 1；最大 3）',
            default: 1,
            minimum: 1,
            maximum: 3,
          },
          withMeta: {
            type: 'boolean',
            description: '是否在返回中携带每条边的 {id, confidence, reason} 模糊元数据（默认 false，节省带宽）',
            default: false,
          },
        },
        required: ['linkType', 'srcId'],
      },
      handler: async ({ linkType, srcId, depth = 1, withMeta = false }) => {
        if (!srcId) return { ok: false, error: '缺少参数 srcId' };
        const src = byId.get(srcId);
        if (!src) {
          const candidates = findSimilarIds(byId, srcId, 5);
          return {
            ok: false,
            error: `源对象不存在: ${srcId}`,
            _meta: { epistemic: 'lower-bound', ambiguity: { queried: srcId, candidates } },
          };
        }

        // "links" / "all"：返回 src 上所有以 ids 结尾的字段（importIds / callIds / ...）
        if (linkType === 'links' || linkType === 'all') {
          const refs = {};
          for (const [k, v] of Object.entries(src)) {
            if (Array.isArray(v) && k.endsWith('Ids')) {
              const objs = v.map((id) => byId.get(id)).filter(Boolean);
              if (objs.length) refs[k] = objs;
            }
          }
          const count = Object.values(refs).reduce((a, b) => a + b.length, 0);
          return {
            ok: true,
            linkType,
            srcId,
            depth: 1,
            refs,
            count,
            _meta: epistemicEnvelope('exact', count, { linkType, srcId }),
          };
        }

        // 具体 linkType：走 linkWithMeta2 拿带元数据的瘦对象
        // 但 target 仍要 lookup 完整对象给 agent 消费
        const bp = await ensureBlueprint(snap);
        const ctx = { linkFn: (lt, sid) => bp.link(lt, sid), byId };
        const meta = linkWithMeta2(ctx, linkType, srcId);
        const targets = meta.map((e) => byId.get(e.id)).filter(Boolean);

        // depth > 1：按 hop 分层（借鉴 GitNexus impact byDepth）
        if (depth > 1) {
          const layered = linkBfsWithMeta(ctx, linkType, srcId, depth);
          return {
            ok: true,
            linkType,
            srcId,
            depth,
            // 兼容旧字段：d=1 targets 平铺
            targets: targets.slice(0, 200),
            count: targets.length,
            byDepth: layered.byDepth,
            _meta: epistemicEnvelope('exact', targets.length, { linkType, srcId, depth, withMeta }),
          };
        }

        const out = {
          ok: true,
          linkType,
          srcId,
          depth: 1,
          targets,
          count: targets.length,
          _meta: epistemicEnvelope('exact', targets.length, { linkType, srcId, withMeta }),
        };
        if (withMeta) {
          out.edges = meta; // [{id, confidence, reason}, ...]
        }
        return out;
      },
    },

    {
      name: 'get_health',
      description: '获取五维健康审计摘要：循环依赖（cycles）、孤儿候选（orphanCandidates）、各类型数量、生成时间、解析覆盖度（resolutionStats）。无参',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        // 五维健康审计 builder 写入 _meta，本工具暴露其精简版
        // 完整审计在 src/cli/commands/serve.js 的 /api/stats 中也暴露
        return {
          ok: true,
          summary: {
            generatedAt: meta.generatedAt ?? null,
            objectCounts: counts,
            cyclesCount: cycles.length,
            cyclesPreview: cycles.slice(0, 5),
            orphanCandidatesCount: orphanCandidates.length,
            orphanCandidatesPreview: orphanCandidates.slice(0, 5),
            // 四维（与 build/serve 端点对齐）：数量 / 循环 / 孤儿 / 类型覆盖
            typeCoverage: {
              total: OBJECT_TYPES.length,
              present: OBJECT_TYPES.filter((t) => (counts[t.type] ?? 0) > 0).length,
              missing: OBJECT_TYPES.filter((t) => (counts[t.type] ?? 0) === 0).map((t) => t.type),
            },
            // v0.35.0 解析覆盖度记账（借鉴 GitNexus resolution-outcome 模式）
            // builder.js 在 _meta.resolutionStats 写入的近似判定统计
            resolutionStats: meta.resolutionStats ?? null,
          },
        };
      },
    },

    // 9 工具裁剪到 7 核心工具说明：
    //   - detect_dead_code（v0.32.0 简版）：删除，与 nice-aos deadcode CLI 子命令重叠
    //     （两者数据源相同，MCP 客户端可调 CLI / shell_exec 复用）。
    //   - query_graph（v0.32.0 简版，深度 ≤ 3 / 节点 ≤ 1000）：删除，价值密度低；
    //     多 hop 遍历用 traverse_links 增加 depth 即可覆盖，不需独立工具。
    // 后续 v0.34.0+ 引入「图数据库 / Cypher 抽象」再补 detect_dead_code / query_graph。
  ];

  return {
    /** 列出所有工具的元信息（MCP listTools 用） */
    list() {
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    },

    /** 调用指定工具。args 与 inputSchema 形态一致 */
    async call(name, args = {}) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        return {
          ok: false,
          error: `未知工具: ${name}（可用: ${tools.map((t) => t.name).join(', ')}）`,
        };
      }
      try {
        const result = await tool.handler(args);
        return result && typeof result === 'object' ? result : { ok: true, value: result };
      } catch (err) {
        return {
          ok: false,
          error: `工具执行异常: ${err?.message ?? err}`,
        };
      }
    },

    /** 内部用：暴露 tool 数与 name 列表（测试用） */
    _meta: {
      toolCount: tools.length,
      names: tools.map((t) => t.name),
    },
  };
}

// ============================================================
// v0.35.0 借鉴 GitNexus 的 epistemic envelope / 歧义候选协议
//   - findSimilarIds(byId, query, k) — 找不到时返回相似候选
//   - nameRelevance(a, b) — ~ 模糊匹配的相关度打分
//   - epistemicEnvelope(kind, count, ctx) — 通用元数据封装
//   - ensureBlueprint() — 懒构造 createBlueprint 引用（traverse_links 走 linkWithMeta2 需要）
// ============================================================

// 懒加载：避免循环依赖（toolRegistry.js → blueprint.js → ...）
function ensureBlueprint(snap) {
  if (!snap) throw new Error('ensureBlueprint: 缺 snap 参数');
  return import('./blueprint.js').then(({ createBlueprint }) => createBlueprint(snap));
}

/**
 * 构造 epistemic 元数据。
 *   - epistemic: 'exact' 当结果完整可靠；'lower-bound' 当已知存在解析缺失
 *   - causes:    一句话描述影响可信度的因素（空数组 = 完美）
 *   - confidence: 0..1 汇总（exact=1.0，lower-bound 由 causes 数衰减）
 */
function epistemicEnvelope(kind, count, ctx = {}) {
  if (kind === 'exact') {
    return {
      epistemic: 'exact',
      confidence: 1.0,
      causes: [],
      count,
      at: new Date().toISOString(),
    };
  }
  return { epistemic: kind, confidence: 0, causes: [], count, at: new Date().toISOString(), ...ctx };
}

/**
 * 找相似 id 候选。打分：完全 > 前缀 > 子串 > 编辑距离。
 * 用于 get_node 找不到 / traverse_links 源不存在时返回候选。
 */
function findSimilarIds(byId, query, k = 5) {
  if (!query) return [];
  const q = String(query).toLowerCase();
  const out = [];
  for (const [id, obj] of byId.entries()) {
    const lower = id.toLowerCase();
    let score = 0;
    if (lower === q) score = 1.0;
    else if (lower.startsWith(q)) score = 0.8;
    else if (lower.includes(q)) score = 0.5;
    else {
      // 简单编辑距离（仅前 64 字符，超长跳过避免 O(n²)）
      const t = lower.slice(0, 64);
      const d = levenshtein(t, q.slice(0, 64));
      const max = Math.max(t.length, q.length, 1);
      score = Math.max(0, 1 - d / max) * 0.4;
    }
    if (score > 0.2) {
      out.push({ id, name: obj.name, _type: obj._type, score: Number(score.toFixed(3)) });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, k);
}

/** name 模糊匹配的相关度（0..1）：子串 > 前缀 > 大小写无关 > 全字相等 */
function nameRelevance(candidate, query) {
  if (!candidate || !query) return 0;
  const c = String(candidate).toLowerCase();
  const q = String(query).toLowerCase();
  if (c === q) return 1.0;
  if (c.startsWith(q)) return 0.85;
  if (c.includes(q)) return 0.6;
  // 编辑距离
  const d = levenshtein(c.slice(0, 64), q.slice(0, 64));
  const max = Math.max(c.length, q.length, 1);
  return Math.max(0, 1 - d / max) * 0.4;
}

/** 标准 Levenshtein 距离（O(n*m) 空间），用于 id/name 相似度 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}
