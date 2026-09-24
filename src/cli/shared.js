import fs from 'node:fs';
import path from 'node:path';
import { getSnapshotDirOverride } from '../paths.js';

// 快照目录解析链：显式 --dir → 全局 --snapshot-dir 覆盖 → 环境变量 → <root>/.nice-aos/data
// 注：子命令不要重复定义 --snapshot-dir 选项——Commander 中与全局选项重名的子命令选项会被父命令吞掉，子命令 action 拿不到值
export function resolveSnapshotDirs(opts) {
  const root = path.resolve(opts.root || process.cwd());
  const explicitDir = opts.dir || getSnapshotDirOverride() || process.env.NICE_AOS_SNAPSHOT_DIR;
  const dataDir = explicitDir ? path.resolve(explicitDir) : path.join(root, '.nice-aos', 'data');
  return { root, dataDir };
}

export function loadSnapshotFile(snapPath) {
  if (!fs.existsSync(snapPath)) return { ok: false, error: 'NOT_FOUND' };
  let text;
  try {
    text = fs.readFileSync(snapPath, 'utf-8');
  } catch (err) {
    return { ok: false, error: `READ_FAILED: ${err?.message ?? err}` };
  }
  try {
    return { ok: true, snap: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: `PARSE_FAILED: ${err?.message ?? err}` };
  }
}

// --where 过滤语法（与 asdm-aos 对齐，v0.47 扩展）：
//   "k1=v1,k2=v2" 多条件 AND；等号或冒号 = 精确相等；~ = 模糊匹配（子串包含，忽略大小写）
//   v0.47（借鉴 asdm-aos whereClause）：>N / >=N / <N / <=N 数值比较（非数值或不存在的字段不命中）；
//   点路径取嵌套字段（"apiMatch.methodMatches" / "health.cyclomatic"），缺失路径视为字段不存在
//   数组值：精确为成员包含，模糊为任一成员包含
export function parseWhere(where) {
  if (!where) return null;
  const conditions = [];
  for (const part of where.split(',')) {
    // 取最先出现的分隔符；双字符操作符（>= / <=）优先于单字符判定
    let idx = -1;
    let op = null;
    let width = 1;
    for (let i = 0; i < part.length; i++) {
      const ch = part[i];
      const next = part[i + 1];
      if ((ch === '>' || ch === '<') && next === '=') { idx = i; op = ch === '>' ? 'gte' : 'lte'; width = 2; break; }
      if (ch === '=' || ch === ':') { idx = i; op = 'eq'; break; }
      if (ch === '~') { idx = i; op = 'contains'; break; }
      if (ch === '>' || ch === '<') { idx = i; op = ch === '>' ? 'gt' : 'lt'; break; }
    }
    if (idx <= 0) continue;
    conditions.push({ key: part.slice(0, idx).trim(), op, value: part.slice(idx + width).trim() });
  }
  return conditions;
}

// 点路径取值：'a.b.c' 逐层下钻；中途非对象 / 缺键 → undefined（与顶层缺键同语义）
function getByPath(obj, key) {
  if (!key.includes('.')) return obj[key];
  let cur = obj;
  for (const seg of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

const NUMERIC_OPS = new Set(['gt', 'gte', 'lt', 'lte']);

export function matchesWhere(obj, conditions) {
  if (!conditions) return true;
  return conditions.every(({ key, op, value }) => {
    const objValue = getByPath(obj, key);
    if (NUMERIC_OPS.has(op)) {
      // 数值比较：两侧均可数值化才参与比较（否则该条件不命中，不做字符串字典序比较）
      const n = Number(value);
      const ov = Number(objValue);
      if (!Number.isFinite(n) || !Number.isFinite(ov)) return false;
      if (op === 'gt') return ov > n;
      if (op === 'gte') return ov >= n;
      if (op === 'lt') return ov < n;
      return ov <= n;
    }
    if (op === 'contains') {
      const needle = String(value).toLowerCase();
      if (Array.isArray(objValue)) return objValue.some((v) => String(v).toLowerCase().includes(needle));
      return String(objValue ?? '').toLowerCase().includes(needle);
    }
    if (Array.isArray(objValue)) return objValue.includes(value);
    return String(objValue) === value;
  });
}

// --field 字段投影（ADR 0012 D1，借鉴 asdm-aos）：
//   'id,name,filePath' → ['id','name','filePath']；逗号分隔、trim、去空；空/undefined → null
export function parseFields(spec) {
  if (!spec) return null;
  const fields = spec.split(',').map((f) => f.trim()).filter(Boolean);
  return fields.length ? fields : null;
}

// 字段白名单投影：id 恒保留（agent 定位锚点）；对象上不存在的请求字段不产生键，
// 投影结果 = 该对象实际拥有的白名单子集（不产生 undefined 键，JSON 序列化稳定）
export function projectObjects(objects, fields) {
  if (!fields || !Array.isArray(objects)) return objects;
  return objects.map((o) => {
    const out = {};
    for (const f of fields) {
      // v0.44.1 审核 S3：id 与其它字段一致仅 hasOwn 才写——
      // 请求了不存在的 id 不产生键（原实现会写入 id: undefined 且阻止补写）
      if (Object.prototype.hasOwnProperty.call(o, f)) out[f] = o[f];
    }
    // id 恒保留：请求未显式带 id 且对象有 id 时补到末尾（键序稳定）
    if (!('id' in out) && Object.prototype.hasOwnProperty.call(o, 'id')) out.id = o.id;
    return out;
  });
}

export function outputJson(objects) {
  console.log(JSON.stringify(objects, null, 2));
}

export function outputPretty(objects) {
  if (!Array.isArray(objects) || objects.length === 0) {
    console.log('(空结果)');
    return;
  }
  const keys = Object.keys(objects[0]).filter((k) => k !== 'node' && k !== 'statementNode');
  const widths = keys.map((k) => Math.min(Math.max(k.length, ...objects.map((o) => String(o[k] ?? '').length)), 40));
  const line = (cells) => cells.map((c, i) => String(c ?? '').slice(0, widths[i]).padEnd(widths[i])).join('  ');
  console.log(line(keys));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const obj of objects) console.log(line(keys.map((k) => obj[k])));
}

export function succeed(payload) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

export function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
}
