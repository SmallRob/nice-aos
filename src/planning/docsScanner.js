// 产品规划 / PRD 文档扫描器：遍历 docs 目录，解析「特性清单」表与各特性文档，
// 抽取特性/模块/依赖/迭代发布/Roadmap 主题，产出归一化规划模型（纯函数，heuristics 解析）。

import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeFeature, statusKey, priorityKey, parseLinkCell, cleanTitle,
} from './docsModel.js';

const FT_ID_RE = /FT-(\d+)/g;
const VERSION_RE = /v\d+(?:\.\d+)+/;

function walkMd(absDir, out = [], depth = 0) {
  if (depth > 12) return out;
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(absDir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'archive' || e.name === 'node_modules' || e.name === '.git') continue;
      walkMd(full, out, depth + 1);
    } else if (e.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function readSafe(file) {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

function splitCells(line) {
  const t = String(line).trim();
  const s = t.startsWith('|') ? t.slice(1) : t;
  const e = s.endsWith('|') ? s.slice(0, -1) : s;
  return e.split('|').map((c) => c.trim());
}

function isSepRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

// 解析内容中所有 markdown 表格 → [{ header, rows }]
export function parseMarkdownTables(content) {
  const lines = String(content ?? '').split('\n');
  const tables = [];
  let cur = null;
  for (const raw of lines) {
    const line = String(raw);
    if (line.trim().startsWith('|')) {
      const cells = splitCells(line);
      if (!cur) cur = [];
      cur.push(cells);
    } else if (cur && cur.length >= 2) {
      pushTable(cur, tables);
      cur = null;
    }
  }
  if (cur && cur.length >= 2) pushTable(cur, tables);
  return tables;
}

function pushTable(rows, tables) {
  const header = rows[0];
  const sep = rows[1];
  if (!sep || !isSepRow(sep)) return; // 非表（如分隔内容）
  const data = rows.slice(2).filter((r) => r.length > 0);
  tables.push({ header: header.slice(), rows: data });
}

// 特性清单表列定位：按表头关键词映射列索引（缺失为 -1）
function featCols(header) {
  const idx = (re) => header.findIndex((h) => re.test(h));
  const norm = header.map((h) => String(h).replace(/\s+/g, '').toLowerCase());
  const c = (re) => norm.findIndex((h) => re.test(h));
  return {
    id: c(/^id$|编号|^ft$/),
    module: c(/分类|模块|领域|分组/),
    title: c(/特性名称|名称|标题|特性$/),
    priority: c(/优先级/),
    version: c(/^版本$|目标版本|版本/),
    owner: c(/负责人|修订人|owner/),
    status: c(/状态|进展/),
    desc: c(/特性说明|描述|说明|概述|摘要/),
  };
}

function isFeatureRow(cells) {
  return cells.some((c) => /^FT-\d+/.test(c.trim()));
}

function parseModuleCell(text) {
  const t = String(text ?? '').trim();
  const m = /^(\d+)[-—–]\s*(.+)$/.exec(t);
  if (m) return { key: m[1], label: m[2].trim() };
  return { key: t, label: t };
}

function parseVersion(text) {
  const m = VERSION_RE.exec(String(text ?? ''));
  return m ? m[0] : String(text ?? '').trim();
}

// 从「特性清单」表抽取特性骨架（保留原始状态文本，供 normalize 归一化）
function parseFeatureRows(tables) {
  const feats = [];
  const seen = new Set();
  for (const { header, rows } of tables) {
    const cols = featCols(header);
    if (cols.id < 0) continue;
    for (const r of rows) {
      if (!isFeatureRow(r)) continue;
      const idRaw = (r[cols.id] || '').trim();
      const m = /^(FT-\d+)/i.exec(idRaw);
      if (!m) continue;
      const id = m[1].toUpperCase();
      if (seen.has(id)) continue;
      seen.add(id);
      const titleCell = cols.title >= 0 ? r[cols.title] : '';
      const link = parseLinkCell(titleCell);
      const mod = cols.module >= 0 ? parseModuleCell(r[cols.module]) : { key: '', label: '' };
      const statusText = cols.status >= 0 ? r[cols.status] : '';
      feats.push({
        id,
        title: cleanTitle(link.text || titleCell),
        moduleKey: mod.key,
        moduleLabel: mod.label,
        priority: priorityKey(cols.priority >= 0 ? r[cols.priority] : ''),
        targetVersion: parseVersion(cols.version >= 0 ? r[cols.version] : ''),
        owner: cols.owner >= 0 ? r[cols.owner].replace(/^[*]|\s*$/g, '').trim() : '',
        statusText,
        description: cols.desc >= 0 ? r[cols.desc] : '',
      });
    }
  }
  return feats;
}

// 从 Feat/ 目录名兜底推导特性（特性清单缺失时）
function deriveFeaturesFromDirs(featsDir, featureIds) {
  const out = [];
  const known = new Set(featureIds);
  if (!featsDir) return out;
  let entries;
  try {
    entries = fs.readdirSync(featsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  const sorted = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const e of sorted) {
    const m = /^(FT-\d+)/i.exec(e.name);
    if (!m) continue;
    const id = m[1].toUpperCase();
    if (known.has(id)) continue;
    known.add(id);
    const title = e.name.slice(id.length).replace(/^[-—–_\s]+/, '') || id;
    out.push({
      id, title: cleanTitle(title), moduleKey: '', moduleLabel: '',
      priority: '', targetVersion: '', owner: '', statusText: '', description: '',
    });
  }
  return out;
}

// 从 DOC 取「功能概述/概述」首个非空段落作为描述（纯文本，过滤标题/列表/表格/引用）
export function extractOverview(content) {
  const lines = String(content ?? '').split('\n');
  let active = false;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (/^#{1,4}\s*/.test(L)) {
      active = /功能概述|概述/.test(L);
      continue;
    }
    if (!active) continue;
    const t = L.trim();
    if (!t || /^[|#\-*>!`]/.test(t)) continue;
    const atx = L.search(/\S/);
    if (atx > 4) continue; // 缩进块（代码/引用）跳过
    return t.slice(0, 500);
  }
  return '';
}

function countOpenQuestions(content) {
  const lines = String(content ?? '').split('\n');
  let inSection = false;
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (/^#{1,3}\s*/.test(L)) {
      inSection = /开放问题|待确认项|待澄清|Open Question/.test(L);
      continue;
    }
    if (!inSection) continue;
    const t = L.trim();
    if (!t) continue;
    // 表行计数（跳过表头/分隔行）
    if (t.startsWith('|')) {
      const cells = splitCells(L);
      if (isSepRow(cells) || cells.some((c) => /修订人|版本|问题|编号|序号|主题/.test(c))) continue;
      count++;
      continue;
    }
    if (/^[-*+]\s/.test(t) || /^\d+[.、)]\s/.test(t)) count++;
  }
  return count;
}

function extractLastUpdated(content) {
  const m = /最后更新[\s]*[:：]\s*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/.exec(String(content ?? ''));
  if (m) return m[1].replace(/\//g, '-');
  return '';
}

function extractCompletion(content) {
  const m = /(?:总体)?完成度[\s]*[:：]?\s*(\d{1,3})\s*%/.exec(String(content ?? ''));
  return m ? Math.min(100, Math.max(0, parseInt(m[1], 10))) : null;
}

// 收集特性文档集内出现的其它 FT-\d+ 引用（排除自身），用于依赖边
function collectDepIds(content, selfId) {
  const out = [];
  FT_ID_RE.lastIndex = 0;
  let m;
  while ((m = FT_ID_RE.exec(String(content))) !== null) {
    const id = 'FT-' + m[1];
    if (id === selfId || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

function listPropertyCompletion(feat, ctx) {
  // 遍历该特性文件夹内 md，补充描述/状态/完成度/开放问题/最后更新/依赖
  const ids = ctx.featureFolderBases[feat.id];
  if (!ids || ids.length === 0) return feat;
  const files = [];
  for (const base of ids) {
    if (fs.statSync(base).isDirectory()) {
      const md = walkMd(base, []);
      files.push(...md);
    }
  }
  const ordered = files.slice().sort((a, b) => {
    // 优先 Feature 明细 / 进展报告 / 其它
    const rank = (f) => (/(Feature|SSO|Design)|Overview|Overall|Detailed|AskMe/.test(path.basename(f)) ? 0
      : /进展报告/.test(path.basename(f)) ? 1 : 2);
    return rank(a) - rank(b);
  });
  let prdContent = '';
  const depIds = [];
  const sources = [];
  for (const f of ordered) {
    const c = readSafe(f);
    if (!c) continue;
    sources.push(path.relative(ctx.docsDir, f));
    depIds.push(...collectDepIds(c, feat.id));
    const base = path.basename(f);
    if (!prdContent && /Feature|Overview|Overall|Detailed|AskMe/.test(base) && !/进展报告/.test(base)) {
      prdContent = c;
      feat.docPath = path.relative(ctx.docsDir, f);
    }
    if (/进展报告/.test(base) && !feat.statusText) {
      const sm = /状态[\s]*[:：]\s*([^\n|]+)/.exec(c);
      if (sm && sm[1].trim()) feat.statusText = sm[1].trim();
    }
    if (feat.completion == null) {
      const cp = extractCompletion(c);
      if (cp != null) feat.completion = cp;
    }
    if (!feat.description) feat.description = extractOverview(c);
    if (!feat.lastUpdated) feat.lastUpdated = extractLastUpdated(c);
  }
  feat.openQuestionCount = prdContent && /开放问题/.test(prdContent)
    ? countOpenQuestions(prdContent)
    : 0;
  feat.depIds = Array.from(new Set(depIds));
  feat.sources = Array.from(new Set(sources));
  if (!feat.lastUpdated) {
    // 回退到源文件 mtime（取文件夹内最新）
    let latest = 0;
    for (const base of ids) {
      if (!fs.statSync(base).isDirectory()) continue;
      for (const f of walkMd(base, [])) {
        try { latest = Math.max(latest, fs.statSync(f).mtimeMs); } catch {}
      }
    }
    if (latest) feat.lastUpdated = new Date(latest).toISOString().split('T')[0];
  }
  return feat;
}

// 模块解析：合并特性表「分类」 + Modules/ 文档（feature→module 关联）
function buildModules(features, modulesDir) {
  const byKey = new Map();
  const add = (key, label, desc = '') => {
    const k = key || label || 'unknown';
    if (!byKey.has(k)) byKey.set(k, { key: k, label: label || k, description: desc, featureIds: [] });
  };
  for (const f of features) add(f.moduleKey, f.moduleLabel);
  // Modules/ 目录文档
  const modsDir = modulesDir;
  if (fs.existsSync(modsDir)) {
    for (const f of walkMd(modsDir, [])) {
      const label = path.basename(f, '.md').replace(/^\d+[-—–]\s*/, '');
      const key = path.basename(f, '.md');
      const c = readSafe(f);
      const desc = extractOverview(c) || c.trim().split('\n').filter((l) => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('|')).slice(0, 1).join('');
      add(key, label, desc.slice(0, 200));
    }
  }
  // 关联特性到模块
  for (const f of features) {
    if (!f.moduleKey) continue;
    const mod = byKey.get(f.moduleKey);
    if (mod && !mod.featureIds.includes(f.id)) mod.featureIds.push(f.id);
  }
  const arr = Array.from(byKey.values()).sort((a, b) => {
    const na = parseInt(a.key, 10), nb = parseInt(b.key, 10);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return a.label.localeCompare(b.label, 'zh');
  });
  // 空模块收尾：无特性归属的模块（目录文档）保留但标注空
  for (const m of arr) if (!m.featureIds.length) m.featureIds = [];
  return arr;
}

// 迭代里程碑：扫描所有表，取首列形如 v1.x 的版本规划行（迭代/发布计划、里程碑表）
function parseMilestones(planningMd) {
  const out = [];
  if (!planningMd) return out;
  const tables = parseMarkdownTables(planningMd);
  const seen = new Set();
  for (const { header, rows } of tables) {
    const isPlan = header.some((h) => /状态/.test(h))
      || /版本|迭代|里程碑|发布/.test(header[0] || '');
    if (!isPlan) continue;
    const statusIdx = header.findIndex((h, i) => i !== 0 && /状态/.test(h));
    for (const r of rows) {
      const vcell = parseVersion(r[0]);
      if (!VERSION_RE.test(vcell) || !/^v\d/.test(vcell)) continue;
      if (seen.has(vcell)) continue;
      seen.add(vcell);
      out.push({
        version: vcell,
        window: r[1] || '',
        status: statusIdx >= 0 ? (r[statusIdx] || '') : '',
        features: r.slice(2).filter((x) => /FT-|特性|交付|已完成|发布/.test(x)).join(' ; ').slice(0, 240),
      });
    }
  }
  return out.slice(0, 60);
}

function parseReleases(releasePlanDir) {
  const out = [];
  if (!releasePlanDir || !fs.existsSync(releasePlanDir)) return out;
  const dirs = fs.readdirSync(releasePlanDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const d of dirs) {
    const rel = { id: d.name, name: d.name, status: '', iterations: [], featureIds: [] };
    const files = walkMd(path.join(releasePlanDir, d.name), []);
    for (const f of files) {
      const c = readSafe(f);
      const base = path.basename(f, '.md');
      const itId = /^(T\d+_\d+)/i.exec(base);
      const iterName = itId ? itId[1] : base;
      const ft = [];
      FT_ID_RE.lastIndex = 0;
      let m;
      while ((m = FT_ID_RE.exec(c)) !== null) ft.push('FT-' + m[1]);
      rel.iterations.push({ id: iterName, name: iterName, featureIds: Array.from(new Set(ft)) });
      rel.featureIds.push(...ft);
    }
    rel.featureIds = Array.from(new Set(rel.featureIds));
    out.push(rel);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

function parseThemes(roadmapDir) {
  const out = [];
  if (!roadmapDir || !fs.existsSync(roadmapDir)) return out;
  let idx = 0;
  for (const f of walkMd(roadmapDir, [])) {
    const c = readSafe(f);
    const lines = c.split('\n');
    let section = null;
    // File title：首个 # 标题
    const fileTitle = lines.map((l) => l.trim()).find((l) => /^#\s/.test(l))?.replace(/^#\s*/, '') || path.basename(f, '.md');
    out.push({ id: 'doc-' + idx++, title: fileTitle, summary: '', milestones: [], kind: 'doc' });
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      const m = /^##\s+(.+)$/.exec(L.trim());
      if (!m) continue;
      let summary = '';
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (!t) continue;
        if (/^#/.test(t) || /^\|/.test(t) || /^```/.test(t)) break;
        if (/^[-*>!]/.test(t)) continue;
        summary = t.slice(0, 200);
        break;
      }
      out.push({ id: 'theme-' + idx++, title: cleanTitle(m[1]), summary, milestones: [], kind: 'theme' });
    }
  }
  return out;
}

function buildDistribution(features) {
  const dist = { status: {}, priority: {}, targetVersion: {} };
  for (const f of features) {
    dist.status[f.status] = (dist.status[f.status] || 0) + 1;
    dist.priority[f.priority] = (dist.priority[f.priority] || 0) + 1;
    const v = f.targetVersion || '(未排期)';
    dist.targetVersion[v] = (dist.targetVersion[v] || 0) + 1;
  }
  return dist;
}

function buildDependencies(features) {
  const edges = [];
  const seen = new Set();
  for (const f of features) {
    for (const t of f.depIds || []) {
      const k = f.id + '\u0000' + t + '\u0000references';
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push({ source: f.id, target: t, kind: 'references' });
    }
  }
  return edges.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.target.localeCompare(b.target)));
}

export function scanPlanningModel(docsDir) {
  const start = Date.now();
  const absDir = path.resolve(docsDir);
  if (!fs.existsSync(absDir)) throw new Error(`路径不存在: ${absDir}`);
  if (!fs.statSync(absDir).isDirectory()) throw new Error(`路径不是目录: ${absDir}`);
  // 规划根：优先 <docs>/planning 子目录（Feat/Modules/ReleasePlan/Roadmap 常位于其中）
  const planRoot = fs.existsSync(path.join(absDir, 'planning'))
    ? path.join(absDir, 'planning')
    : absDir;

  const allFiles = walkMd(absDir, []);
  const listFile = allFiles.find((f) => /ProductPlanning/i.test(f))
    || allFiles.find((f) => /ProductSuite/i.test(f))
    || allFiles.find((f) => /规划/i.test(f))
    || allFiles.find((f) => f.startsWith(planRoot) && /\.md$/.test(f));
  const listContent = listFile ? readSafe(listFile) : '';
  const tables = parseMarkdownTables(listContent);
  let features = parseFeatureRows(tables);

  // 特性文件夹映射（补充增强）
  const featsDir = path.join(planRoot, 'Feat');
  const featureFolderBases = {};
  if (fs.existsSync(featsDir)) {
    for (const e of fs.readdirSync(featsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const m = /^(FT-\d+)/i.exec(e.name);
      if (!m) continue;
      const id = m[1].toUpperCase();
      featureFolderBases[id] = [path.join(featsDir, e.name)];
    }
  }

  // 兜底：清单缺失时从目录推导
  features = features.concat(deriveFeaturesFromDirs(featsDir, new Set(features.map((f) => f.id))));

  const ctx = { docsDir: absDir, featureFolderBases };
  features = features.map((f) => listPropertyCompletion(JSON.parse(JSON.stringify(f)), ctx));
  // 归一化（状态/优先级等），并按 id 稳定排序
  features = features
    .map((f) => normalizeFeature({ ...f, statusText: f.statusText || '' }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const modules = buildModules(features, path.join(planRoot, 'Modules'));
  const milestones = parseMilestones(listContent);
  const releases = parseReleases(path.join(planRoot, 'ReleasePlan'));
  const themes = parseThemes(path.join(planRoot, 'Roadmap'));
  const dependencies = buildDependencies(features);
  const distribution = buildDistribution(features);

  const durationMs = Date.now() - start;
  return {
    _meta: {
      name: path.basename(absDir),
      generator: 'nice-aos planning',
      version: '0.27.0',
      sourceDir: absDir,
      scannedAt: new Date().toISOString(),
      durationMs,
      fileCount: allFiles.length,
      featureCount: features.length,
      moduleCount: modules.length,
      dependencyCount: dependencies.length,
      releaseCount: releases.length,
      milestoneCount: milestones.length,
      themeCount: themes.length,
      analysisErrors: [],
    },
    features,
    modules,
    releases,
    milestones,
    themes,
    dependencies,
    distribution,
    stats: {
      totalFeatures: features.length,
      totalModules: modules.length,
      totalReleases: releases.length,
      totalMilestones: milestones.length,
      totalThemes: themes.length,
      totalDeps: dependencies.length,
    },
  };
}