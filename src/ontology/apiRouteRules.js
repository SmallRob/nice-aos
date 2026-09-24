// 人工路由规则加载（ADR 0012 D4，借鉴 asdm-aos gatewayRouteLoader / aos-gateway-routes.json）：
//   <projectRoot>/.nice-aos/api-routes.json → [{ from, to, comment? }]
// 语义：网关 / nginx / 平台层的前缀改写（T1/T2/T3 路由差异模型中的平台层知识必须来自人工输入）。
// 容错：文件缺失 → 空规则零警告（默认形态）；非法 JSON / 无效条目 → 跳过并记 warning，
//       不阻断构建（对齐 DDL 解析错误隔离哲学）。不做正则/通配——人工规则要可读可审计。
import fs from 'node:fs';
import path from 'node:path';

const RULES_REL = path.join('.nice-aos', 'api-routes.json');

// 可经 serverRouteTypes 显式开启的服务端路由类型（v0.47）。
// php 默认排除（zentaopms query 式 URL 误命中风险），确信形态的项目可自行开启。
const OPT_IN_SERVER_ROUTE_TYPES = ['php'];

function toSegs(p) {
  return p.replace(/\/+$/, '').split('/').filter(Boolean);
}

// 返回 { rules, warnings, extraServerRouteTypes }；rules 条目含原始 from/to（matchedVia 回执用）与预切段数组
export function loadApiRouteRules(projectRoot) {
  const file = path.join(projectRoot, RULES_REL);
  if (!fs.existsSync(file)) return { rules: [], warnings: [], extraServerRouteTypes: [] };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    return { rules: [], warnings: [`api-routes.json 解析失败，已忽略: ${err?.message ?? err}`], extraServerRouteTypes: [] };
  }
  // serverRouteTypes：显式扩展服务端路由候选池（如 zentaopms 形态确认的项目开启 php）
  const typeWarnings = [];
  const extraServerRouteTypes = [];
  if (Array.isArray(raw?.serverRouteTypes)) {
    for (const t of raw.serverRouteTypes) {
      if (OPT_IN_SERVER_ROUTE_TYPES.includes(t)) {
        if (!extraServerRouteTypes.includes(t)) extraServerRouteTypes.push(t);
      } else {
        typeWarnings.push(`serverRouteTypes 不支持 "${t}"（可选: ${OPT_IN_SERVER_ROUTE_TYPES.join('/')}），已忽略`);
      }
    }
  }
  // 顶层裸数组或 { rules: [...] } 两种形态都接受；对象形态只给 serverRouteTypes 不给 rules 也合法
  const hasTypeSection = extraServerRouteTypes.length > 0 || typeWarnings.length > 0;
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.rules) ? raw.rules : (hasTypeSection ? [] : null));
  if (!list) {
    return { rules: [], warnings: ['api-routes.json 格式无效（应为数组或 {"rules":[...]}），已忽略'], extraServerRouteTypes: [] };
  }
  const rules = [];
  const warnings = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const from = typeof r?.from === 'string' ? r.from.trim() : '';
    const to = typeof r?.to === 'string' ? r.to.trim() : '';
    if (!from.startsWith('/') || !to.startsWith('/')) {
      warnings.push(`规则 #${i} 缺少以 / 开头的 from/to，已跳过: ${JSON.stringify(r)}`);
      continue;
    }
    // v0.44.1 审核 B1：from 归一后必须非空 —— from: "/" 得空段数组，
    // rewriteByRule 空前缀循环 0 次 → 隐式改写所有未自动命中的路径
    const fromSegs = toSegs(from);
    if (fromSegs.length === 0) {
      warnings.push(`规则 #${i} from 归一后为空（from: "${from}"），已跳过: ${JSON.stringify(r)}`);
      continue;
    }
    rules.push({
      from,
      to,
      fromSegs,
      toSegs: toSegs(to),
      comment: typeof r?.comment === 'string' ? r.comment : null,
    });
  }
  return { rules, warnings: [...typeWarnings, ...warnings], extraServerRouteTypes };
}
