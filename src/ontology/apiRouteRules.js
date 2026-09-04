// 人工路由规则加载（ADR 0012 D4，借鉴 asdm-aos gatewayRouteLoader / aos-gateway-routes.json）：
//   <projectRoot>/.nice-aos/api-routes.json → [{ from, to, comment? }]
// 语义：网关 / nginx / 平台层的前缀改写（T1/T2/T3 路由差异模型中的平台层知识必须来自人工输入）。
// 容错：文件缺失 → 空规则零警告（默认形态）；非法 JSON / 无效条目 → 跳过并记 warning，
//       不阻断构建（对齐 DDL 解析错误隔离哲学）。不做正则/通配——人工规则要可读可审计。
import fs from 'node:fs';
import path from 'node:path';

const RULES_REL = path.join('.nice-aos', 'api-routes.json');

function toSegs(p) {
  return p.replace(/\/+$/, '').split('/').filter(Boolean);
}

// 返回 { rules, warnings }；rules 条目含原始 from/to（matchedVia 回执用）与预切段数组
export function loadApiRouteRules(projectRoot) {
  const file = path.join(projectRoot, RULES_REL);
  if (!fs.existsSync(file)) return { rules: [], warnings: [] };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    return { rules: [], warnings: [`api-routes.json 解析失败，已忽略: ${err?.message ?? err}`] };
  }
  // 顶层裸数组或 { rules: [...] } 两种形态都接受
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.rules) ? raw.rules : null);
  if (!list) {
    return { rules: [], warnings: ['api-routes.json 格式无效（应为数组或 {"rules":[...]}），已忽略'] };
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
    rules.push({
      from,
      to,
      fromSegs: toSegs(from),
      toSegs: toSegs(to),
      comment: typeof r?.comment === 'string' ? r.comment : null,
    });
  }
  return { rules, warnings };
}
