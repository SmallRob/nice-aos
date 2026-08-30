// v0.41.0 统一 NetworkEndpoint（outbound 侧）：
// Python HTTP 客户端调用 → 全局聚合的 outbound NetworkEndpoint 实体。
// 原为 builder.js 内部函数（slugifyEndpointUrl / endpointDomainOf /
// buildPythonOutboundEndpoints），拆分时收敛于此（纯函数迁移，逻辑不变）。

// URL → 稳定 slug，用于 NetworkEndpoint 的 id。
// 保留 {} %s $ 等插值占位符（v0.42.0 再做占位符归一化），其余非安全字符折叠为 _。
export function slugifyEndpointUrl(url) {
  return String(url)
    .replace(/^https?:\/\//i, '')
    .replace(/[^A-Za-z0-9._\-/:{}%$]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/_+$/, '')
    .slice(0, 140) || 'unknown';
}

// URL → host（domain 字段）。带插值占位符的 URL 会原样保留占位符（如 https://%s/redfish/... → %s）。
export function endpointDomainOf(url) {
  const m = /^(?:https?:)?\/\/([^/?#]+)/i.exec(String(url));
  if (m) return m[1];
  return String(url).split(/[/?#]/)[0] || 'unknown';
}

// Python HTTP 客户端调用（facts.httpClientCalls）→ 全局聚合的 outbound NetworkEndpoint 实体。
// 聚合键 = (method, url)：同一端点被 N 个文件调用只产出一个实体，files/lines 承载调用点证据。
// 注意：v0.41.0 不填 fns/fnIds —— pythonAnalyzer 的 function fact 只有 pos 没有 end，
// 无法可靠判定调用行归属哪个函数；宁可留空也不做易误报的近似归属（v0.42.0 补齐 end 后再接）。
export function buildPythonOutboundEndpoints(scanFiles, factsMap, fileObjectByPath, usedIds) {
  // 聚合键用 "::" 分隔：method 恒为 [A-Z]+ 或 MIXED，不含 ":"，故拼接无歧义
  const agg = new Map(); // key = `${method}::${url}`
  for (const relPath of scanFiles) {
    if (!relPath.endsWith('.py')) continue;
    const calls = factsMap.get(relPath)?.httpClientCalls;
    if (!calls || calls.length === 0) continue;
    for (const c of calls) {
      const key = `${c.method}::${c.url}`;
      let e = agg.get(key);
      if (!e) {
        e = { method: c.method, url: c.url, libs: new Set(), files: new Set(), lines: [], hasAuth: false, hasJson: false, hasData: false };
        agg.set(key, e);
      }
      e.libs.add(c.lib);
      e.files.add(relPath);
      e.lines.push({ file: relPath, line: c.line, lib: c.lib, method: c.method, url: c.url });
      if (c.hasAuth) e.hasAuth = true;
      if (c.hasJson) e.hasJson = true;
      if (c.hasData) e.hasData = true;
    }
  }
  // 排序保证 id 与输出顺序稳定（不依赖扫描顺序）
  const sorted = [...agg.values()].sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
  const out = [];
  for (const e of sorted) {
    const slug = slugifyEndpointUrl(e.url);
    let id = `net:out:${e.method.toLowerCase()}:${slug}`;
    let n = 2;
    while (usedIds.has(id)) id = `net:out:${e.method.toLowerCase()}:${slug}#${n++}`;
    usedIds.add(id);
    const files = [...e.files].sort();
    out.push({
      id,
      direction: 'outbound',
      lang: 'python',
      lib: [...e.libs].sort().join('+'),   // 同端点被多个 lib 调用时合并（罕见但保留证据）
      libs: [...e.libs].sort(),
      kind: 'http-client',
      domain: endpointDomainOf(e.url),
      url: e.url,
      urls: [e.url],
      methods: [e.method],
      callCount: e.lines.length,
      lines: e.lines,
      files,
      fileIds: files.map((p) => fileObjectByPath.get(p)?.id ?? `file:${p}`),
      hasAuth: e.hasAuth,
      hasJson: e.hasJson,
      hasData: e.hasData,
      fns: [],
      fnIds: [],
      // 油猴专有字段：Python 侧置 null（字段保留以维持两端的实体同构）
      allowedByConnect: null,
      scriptId: null,
      scriptName: null,
      filePath: files[0],
      reviewed: false, notes: null,
    });
  }
  return out;
}
