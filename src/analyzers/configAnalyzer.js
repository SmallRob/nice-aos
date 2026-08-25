// 配置文件 / 视图文件 / SQL 脚本轻量级解析器
// 用途：把 .css / .html / .sql / .yml / .yaml / .conf / .toml / .ini / .env 纳入主代码本体扫描
// 与 tsAnalyzer / vueAnalyzer 等平级：纯函数模块，无副作用
// 设计目标：
//   1) 给出准确的 lineCount（用于代码行数统计）
//   2) 提取关键 token（CSS 规则 / HTML 标签 / SQL 对象 / YAML 顶层 key / 配置 section）
//   3) 保持与主 facts shape 兼容（ext / imports=[] / components=[] / hooks=[] / classes=[] / moduleFunctions=[]）
//   4) 不进 import 解析（这些是配置 / 视图 / 数据库脚本，不参与模块依赖图）
//   5) 不修改原文件扩展名语义——SQL/YAML 等仍由 db / deploy 子命令做深度分析，本模块只做轻量级覆盖

import fs from 'node:fs';
import path from 'node:path';

// 文件类型到内部 kind 的映射（用于蓝图分类展示）
const KIND_BY_EXT = {
  css: 'css',
  html: 'html',
  sql: 'sql',
  yml: 'yaml', yaml: 'yaml',
  conf: 'config', toml: 'config', ini: 'config', env: 'config',
};

// ---------- 行数（fast） ----------
function countLines(text) {
  if (!text) return 0;
  // 包含空行；与 tsAnalyzer 的语义一致（lineCount = 物理行数）
  let n = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) n += 1;
  }
  // 末行无换行时不计额外空行（wc -l 行为）
  if (text.length > 0 && text.charCodeAt(text.length - 1) === 10) n -= 1;
  return Math.max(0, n);
}

// 通用空 facts 形状（与 tsAnalyzer 返回的最小 shape 对齐）
function emptyFacts(relPath, ext) {
  return {
    path: relPath,
    ext,
    lineCount: 0,
    imports: [],
    exportSymbols: [],
    exportNames: [],
    jsxTags: new Set(),
    useCalls: [],
    overlayOpens: [],
    stores: [],
    lazyWrappers: [],
    components: [],
    hooks: [],
    primaryComponentName: null,
    hasSingletonClass: false,
    hasClassExport: false,
    importMap: new Map(),
    vueRoutes: [],
    vueRouteMeta: null,
    interfaces: [],
    classes: [],
    moduleFunctions: [],
    // 新增：配置文件语义提取（蓝图展示用）
    configKind: KIND_BY_EXT[ext] ?? ext,
    configItems: [],
  };
}

// ---------- CSS ----------
// 提取：顶层选择器名、@import URL、@keyframes / @font-face 名、--css 变量名
function parseCss(text) {
  const items = [];
  // @import 其它样式
  for (const m of text.matchAll(/@import\s+(?:url\()?['"]?([^'")\s]+)['"]?\)?/gi)) {
    items.push({ kind: 'import', name: m[1] });
  }
  // @keyframes / @font-face / @layer / @scope
  for (const m of text.matchAll(/@(keyframes|font-face|layer|scope|container)\s+([A-Za-z_][\w-]*)/g)) {
    items.push({ kind: m[1], name: m[2] });
  }
  // CSS 自定义属性
  for (const m of text.matchAll(/--([A-Za-z_][\w-]*)\s*:/g)) {
    items.push({ kind: 'var', name: `--${m[1]}` });
  }
  // 顶层选择器：行首 .class / #id / tag（粗略——排除嵌套）
  const seen = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('/*') || line.startsWith('//') || line.startsWith('*')) continue;
    if (line.startsWith('@')) continue;
    // 选择器 { —— 末尾是 { 才计
    if (!line.includes('{')) continue;
    const selector = line.split('{')[0].trim();
    if (!selector || seen.has(selector)) continue;
    // 简单过滤：必须是 .class / #id / tag / :pseudo 开头
    if (!/^([.#:&A-Za-z*]|--)/.test(selector)) continue;
    seen.add(selector);
    items.push({ kind: 'selector', name: selector.split(',')[0].trim() });
  }
  return items;
}

// ---------- HTML ----------
// 提取：<title> / <script src> / <link href> / <meta name|property> / id="..." 锚点
function parseHtml(text) {
  const items = [];
  const titleM = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleM) items.push({ kind: 'title', name: titleM[1].trim().slice(0, 120) });
  for (const m of text.matchAll(/<script\b([^>]*)\bsrc=["']([^"']+)["']/gi)) {
    items.push({ kind: 'script', name: m[2] });
  }
  for (const m of text.matchAll(/<link\b([^>]*)\bhref=["']([^"']+)["']/gi)) {
    items.push({ kind: 'link', name: m[2] });
  }
  for (const m of text.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = m[1];
    const nameM = attrs.match(/\b(?:name|property|http-equiv)=["']([^"']+)["']/i);
    const contentM = attrs.match(/\bcontent=["']([^"']+)["']/i);
    if (nameM) items.push({ kind: 'meta', name: nameM[1], value: contentM ? contentM[1] : null });
  }
  for (const m of text.matchAll(/\bid=["']([^"']+)["']/g)) {
    items.push({ kind: 'anchor', name: m[1] });
  }
  return items;
}

// ---------- SQL ----------
// 提取：CREATE TABLE / VIEW / INDEX / FUNCTION / PROCEDURE / TRIGGER / TYPE 的对象名
// 不解析字符串/注释里的伪关键字（最简版注释剥离）
function stripSqlComments(text) {
  // 把字符串字面量内的内容替换为同长度空白（保留换行符），避免正则误匹配字符串内的关键字
  // SQL 字符串转义：单引号字符串内 '' 表示一个 '；双引号、反引号按 MySQL 约定不做 '' 转义
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "'") {
      // 单引号字符串：'' 是字面量 '，需配对
      out += ch;
      i += 1;
      while (i < text.length) {
        const c = text[i];
        if (c === "'" && text[i + 1] === "'") { out += "''"; i += 2; continue; } // 转义 '
        if (c === "'" || c === '\n') { out += c; i += 1; break; } // 结束或换行截断
        out += (c === '\n') ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      // 双引号字符串：到下一个双引号结束（无双引号转义）
      out += ch;
      i += 1;
      while (i < text.length) {
        const c = text[i];
        if (c === '"' || c === '\n') { out += c; i += 1; break; }
        out += (c === '\n') ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '`') {
      // MySQL 反引号是标识符引用，保留原文（标准 SQL 不允许反引号内嵌关键字）
      out += ch;
      i += 1;
      while (i < text.length) {
        const c = text[i];
        if (c === '`' || c === '\n') { out += c; i += 1; break; }
        out += c;
        i += 1;
      }
      continue;
    }
    if (ch === '-' && next === '-') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function parseSql(text) {
  const items = [];
  const cleaned = stripSqlComments(text);
  // CREATE [OR REPLACE] [UNIQUE]? [MATERIALIZED]? TABLE|VIEW|INDEX|FUNCTION|PROCEDURE|TRIGGER|TYPE|SCHEMA|DATABASE
  const re = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+|MATERIALIZED\s+|TEMP(?:ORARY)?\s+)*?(TABLE|VIEW|INDEX|FUNCTION|PROCEDURE|TRIGGER|TYPE|SCHEMA|DATABASE|SEQUENCE)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`?([A-Za-z_][\w.]*)`?\.)?`?([A-Za-z_][\w.]*)`?/gi;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const kind = m[1].toLowerCase();
    const schema = m[2] ?? null;
    const name = m[3];
    items.push({ kind, schema, name, qualified: schema ? `${schema}.${name}` : name });
  }
  // DROP/ALTER 也算（用于审计/影响面）
  const dropRe = /\bDROP\s+(?:TABLE|VIEW|INDEX|FUNCTION|PROCEDURE|TRIGGER|TYPE|SCHEMA|DATABASE)\s+(?:IF\s+EXISTS\s+)?(?:`?([A-Za-z_][\w.]*)`?\.)?`?([A-Za-z_][\w.]*)`?/gi;
  while ((m = dropRe.exec(cleaned)) !== null) {
    items.push({ kind: `drop-${m[1].toLowerCase()}`, name: m[2] });
  }
  return items;
}

// ---------- YAML ----------
// 提取：顶层 keys（缩进为 0）、services.* 名称（docker-compose 特征）
function parseYaml(text) {
  const items = [];
  const lines = text.split('\n');
  for (const raw of lines) {
    if (!raw || raw.startsWith('#')) continue;
    const m = /^(\s*)([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(raw);
    if (!m) continue;
    const indent = m[1].length;
    const key = m[2];
    const value = m[3].trim();
    if (indent === 0) {
      // 顶层 key
      if (key === 'services' || key === 'version' || key === 'apiVersion' || key === 'kind' || key === 'metadata' || key === 'name' || key === 'image') {
        // docker-compose / k8s 强信号字段
        items.push({ kind: key, name: value ? value.replace(/^["']|["']$/g, '') : null });
      } else {
        items.push({ kind: 'key', name: key });
      }
    } else if (indent === 2 && key.length > 0) {
      // 二级 key（service 名 / k8s metadata.labels / spec.containers）
      items.push({ kind: 'subkey', name: key, parent: m[0].split('\n')[0] });
    }
  }
  return items;
}

// ---------- INI / CONF / TOML ----------
// 提取：[section] / 裸 section { ... }（nginx 风格）段名 + key=value / key value 键名
function parseIniLike(text) {
  const items = [];
  let currentSection = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    // [section] 形式
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      currentSection = sec[1];
      items.push({ kind: 'section', name: currentSection });
      continue;
    }
    // nginx 风格 section { （裸标识符 + {）
    const nginxSec = /^([A-Za-z_][\w.-]*)\s*\{$/.exec(line);
    if (nginxSec) {
      currentSection = nginxSec[1];
      items.push({ kind: 'section', name: currentSection });
      continue;
    }
    // 提取 key：支持 key=value / key: value / nginx 风格 key value;
    // 不取 value 避免泄露密码（secret 标记在 buildDeployModel 里）
    // nginx 风格：行末是 ; 且首个 token 是 key
    if (line.endsWith(';') && /^[A-Za-z_][\w.-]*\s+\S/.test(line) && !line.startsWith('#') && !line.startsWith(';')) {
      const m = /^([A-Za-z_][\w.-]*)\s+/.exec(line);
      if (m) {
        items.push({ kind: 'key', name: m[1], section: currentSection });
        continue;
      }
    }
    const kv = /^([A-Za-z_][\w.-]*)\s*[=:]/.exec(line);
    if (kv) {
      items.push({ kind: 'key', name: kv[1], section: currentSection });
    }
  }
  return items;
}

// ---------- .env ----------
// 提取：KEY=value 的 KEY（值不取，敏感）
function parseEnv(text) {
  const items = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][\w.-]*)\s*=/.exec(line);
    if (m) items.push({ kind: 'var', name: m[1] });
  }
  return items;
}

// 调度：按扩展名分发
function analyzeConfigText(ext, text) {
  switch (ext) {
    case 'css': return parseCss(text);
    case 'html': return parseHtml(text);
    case 'sql': return parseSql(text);
    case 'yml':
    case 'yaml': return parseYaml(text);
    case 'conf':
    case 'toml':
    case 'ini': return parseIniLike(text);
    case 'env': return parseEnv(text);
    default: return [];
  }
}

// 从文件名/路径提取配置类型 kind：.env / .env.* 视为 env；其他用扩展名
function inferConfigExt(relPath, extOverride = null) {
  if (extOverride) return extOverride.toLowerCase().replace(/^\./, '');
  const base = path.basename(relPath).toLowerCase();
  if (base === '.env' || base.startsWith('.env.')) return 'env';
  return path.extname(relPath).slice(1).toLowerCase();
}

// 单文件分析：从磁盘读取 + 解析
// extOverride: 显式 ext（用于 .env.* 文件规范化）
export function analyzeConfigFileFromDisk(relPath, projectRoot, extOverride = null) {
  const ext = inferConfigExt(relPath, extOverride);
  const abs = path.join(projectRoot, relPath);
  const facts = emptyFacts(relPath, ext);
  let text = '';
  try {
    text = fs.readFileSync(abs, 'utf-8');
  } catch (err) {
    facts.lineCount = 0;
    return facts;
  }
  // 单文件 > 2MB 跳过详细解析，只算行数（防 OOM）
  if (text.length > 2 * 1024 * 1024) {
    facts.lineCount = countLines(text);
    facts.configItems = [];
    facts.configTruncated = true;
    return facts;
  }
  facts.lineCount = countLines(text);
  try {
    facts.configItems = analyzeConfigText(ext, text);
  } catch {
    facts.configItems = [];
  }
  return facts;
}

// 内存分析（用于 analyzeFile action 单文件入口）
export function analyzeConfigFile(relPath, text) {
  const ext = inferConfigExt(relPath);
  const facts = emptyFacts(relPath, ext);
  facts.lineCount = countLines(text);
  if (text.length > 2 * 1024 * 1024) {
    facts.configTruncated = true;
    return facts;
  }
  try {
    facts.configItems = analyzeConfigText(ext, text);
  } catch {
    facts.configItems = [];
  }
  return facts;
}
