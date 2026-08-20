// --where 过滤语法（与 asdm-aos 对齐，扩展模糊匹配）：
//   "k1=v1,k2=v2" 多条件 AND；等号或冒号 = 精确相等；~ = 模糊匹配（子串包含，忽略大小写）
//   数组值：精确为成员包含，模糊为任一成员包含
export function parseWhere(where) {
  if (!where) return null;
  const conditions = [];
  for (const part of where.split(',')) {
    // 取最先出现的分隔符：= / : 为精确，~ 为模糊
    let idx = -1;
    let op = 'eq';
    for (let i = 0; i < part.length; i++) {
      const ch = part[i];
      if (ch === '=' || ch === ':' || ch === '~') {
        idx = i;
        op = ch === '~' ? 'contains' : 'eq';
        break;
      }
    }
    if (idx <= 0) continue;
    conditions.push({ key: part.slice(0, idx).trim(), op, value: part.slice(idx + 1).trim() });
  }
  return conditions;
}

export function matchesWhere(obj, conditions) {
  if (!conditions) return true;
  return conditions.every(({ key, op, value }) => {
    const objValue = obj[key];
    if (op === 'contains') {
      const needle = String(value).toLowerCase();
      if (Array.isArray(objValue)) return objValue.some((v) => String(v).toLowerCase().includes(needle));
      return String(objValue ?? '').toLowerCase().includes(needle);
    }
    if (Array.isArray(objValue)) return objValue.includes(value);
    return String(objValue) === value;
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
