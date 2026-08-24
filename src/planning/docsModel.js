// 产品规划 / PRD 文档蓝图数据模型：实体类型、状态/优先级归一化常量与特性对象规范化。

// 可查询的对象类型（query <type>）与油猴问答代理 planning 模式一一对应
export const PLANNING_TYPES = [
  'features', 'modules', 'releases', 'milestones', 'themes', 'dependencies',
];

// 特性状态定义：key → { label, emoji }
export const STATUS_DEFS = {
  done: { label: '已完成', emoji: '🟢' },
  implementing: { label: '实现中', emoji: '🟡' },
  designing: { label: '设计中', emoji: '🟠' },
  clarifying: { label: '澄清中', emoji: '🟣' },
  blocked: { label: '阻塞/风险', emoji: '🔴' },
  unknown: { label: '未知', emoji: '⚪' },
};

export const STATUS_ORDER = ['done', 'implementing', 'designing', 'clarifying', 'blocked', 'unknown'];

// 状态 emoji → key（精确命中优先）
const STATUS_EMOJI = {
  '🟢': 'done', '✅': 'done', '✔': 'done', '已交付': 'done',
  '🟡': 'implementing',
  '🟠': 'designing',
  '🟣': 'clarifying', '❓': 'clarifying',
  '🔴': 'blocked', '⛔': 'blocked', '红色': 'blocked', '阻塞': 'blocked',
};

// 状态关键词 → key（fallback，忽略 emoji 后按包含匹配）
const STATUS_KEYWORDS = [
  ['blocked', ['阻塞', '风险', '有问题', '停']],
  ['done', ['已完成', '交付', '完成', '上线', 'done', 'released']],
  ['implementing', ['实现中', '开发中', '实施中', '进行中', 'implementing', 'in progress']],
  ['clarifying', ['澄清中', '待确认', '待澄清', '评审中', 'clarifying']],
  ['designing', ['设计', '设计评审', '设计中', 'designing']],
];

export function statusKey(text) {
  if (!text) return 'unknown';
  const t = String(text);
  // 先按首个状态 emoji 命中
  for (const ch of Object.keys(STATUS_EMOJI)) {
    if (t.includes(ch)) return STATUS_EMOJI[ch];
  }
  const low = t.toLowerCase();
  for (const [key, kws] of STATUS_KEYWORDS) {
    if (kws.some((kw) => low.includes(kw.toLowerCase()))) return key;
  }
  return 'unknown';
}

export function statusLabel(key) {
  return (STATUS_DEFS[key] || STATUS_DEFS.unknown).label;
}

// 优先级归一化：任一大小写写法的 P0/P1/P2/P3 与高/中/低
export function priorityKey(text) {
  if (!text) return '';
  const t = String(text).toUpperCase().trim();
  if (/P0/.test(t)) return 'P0';
  if (/P1/.test(t)) return 'P1';
  if (/P2/.test(t)) return 'P2';
  if (/P3/.test(t)) return 'P3';
  if (/高|紧急/.test(t)) return 'P1';
  if (/中|标准/.test(t)) return 'P2';
  if (/低|一般/.test(t)) return 'P3';
  return t.slice(0, 3);
}

export const PRIORITY_ORDER = ['P0', 'P1', 'P2', 'P3', ''];

// markdown 链接单元 → 链接文本与 URL：`[Title](url)` → { text, url }
export function parseLinkCell(cell) {
  const m = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(String(cell ?? ''));
  if (m) return { text: m[1].trim(), url: m[2].trim() };
  // 裸链接 <a href="...">Title</a>
  const a = /<a\s+href="([^"]+)"[^>]*>([^<]*)<\/a>/i.exec(String(cell ?? ''));
  if (a) return { text: a[2].trim(), url: a[1].trim() };
  return { text: String(cell ?? '').trim(), url: '' };
}

// 去除常见噪音前缀（[断点] 等标注），返回纯标题
export function cleanTitle(text) {
  return String(text ?? '')
    .replace(/^\[[^\]]*\]\s*/g, '')
    .replace(/\s*◇$/, '')
    .trim();
}

// 规范化特性对象：由扫描器产出的行数据 + 文档增强字段组装
export function normalizeFeature(f) {
  const status = statusKey(f.statusText);
  return {
    id: f.id,
    title: cleanTitle(f.title),
    moduleKey: f.moduleKey || '',
    moduleLabel: f.moduleLabel || '',
    priority: f.priority || '',
    targetVersion: f.targetVersion || '',
    owner: f.owner || '',
    status,
    statusEmoji: STATUS_DEFS[status].emoji,
    description: f.description || '',
    docPath: f.docPath || '',
    lastUpdated: f.lastUpdated || '',
    openQuestionCount: f.openQuestionCount ?? 0,
    completion: f.completion ?? null,
    depIds: f.depIds || [],
    sources: f.sources || [],
  };
}

// 模块对象 short form（供 viewer/query）
export function moduleView(m) {
  return {
    key: m.key,
    label: m.label,
    description: m.description,
    featureCount: (m.featureIds || []).length,
    featureIds: m.featureIds || [],
  };
}