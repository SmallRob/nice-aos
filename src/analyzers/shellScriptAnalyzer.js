// Shell 脚本（PowerShell + Bash）专用解析器
// 与 tsAnalyzer / vueAnalyzer / userScriptAnalyzer 平级共存、逻辑完全独立。
//
// 设计要点（与 userScriptAnalyzer 同形输出 facts,本体侧用 *Ids 数组挂边,不重写 builder）：
//   - 语言分派:首字符 `#!` / shebang 含 bash/sh/zsh → Bash;<# ... #> 头 / .ps1 扩展 + param() → PowerShell
//   - 元数据块:PS 用 `<# .SYNOPSIS/.DESCRIPTION/.PARAMETER/.EXAMPLE/.NOTES #>`,Bash 用头部注释段(# 开头)
//   - 函数定义:
//       Bash   → name() { body } / function name { body } / function name() { body } 三种形态
//       PS     → function Verb-Noun { ... } / filter / Workflow(简化,只取 Verb-Noun 形态)
//   - 内置调用:
//       Bash   → 从 token 序列里抽已知外部命令(jq/curl/sudo/tar/sha256sum/ln/cp/mv/rm/mkdir/...);pipeline 与 command sub 不破坏识别
//       PS     → 抽 Verb-Noun 形态(Get-/Set-/Test-/New-/Remove-/Stop-/Start-/Invoke-/Resolve-/...)+ 已知 .NET 类型
//   - CLI 参数:
//       Bash   → `case "$1" in --foo|--bar|--baz=*)` / 形如 --key value 的 positional
//       PS     → param([switch]$X, [string]$Y, [Parameter(...)] $Z) 解析类型/默认值/是否 mandatory
//   - 下载与校验:URL 字面量(http(s)://)→ 风险域名;SHA-256/校验命令
//   - 写文件操作:cp/mv/rm/Out-File/Set-Content/Remove-Item/Move-Item/Copy-Item 的目标路径
//   - 注册表(PS 专属):HKCU:\ / HKLM:\ / HKCR:\ / HKU:\ 路径
//
// 输出与 userScriptAnalyzer 同 shape 的 facts(imports/exportNames 等保持空壳,供 builder 复用)。

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 候选检测 & 语言分派
// ---------------------------------------------------------------------------

// 文件是否为 shell 脚本候选:.sh / .bash / .zsh → Bash;.ps1 / .psm1 → PowerShell;
// 强信号检测:无扩展名但首字符是 #!bash 或 shebang 含 bash/sh
export function isShellScriptCandidate(absFilePath) {
  try {
    const base = path.basename(absFilePath).toLowerCase();
    if (base.endsWith('.sh') || base.endsWith('.bash') || base.endsWith('.zsh')) return true;
    if (base.endsWith('.ps1') || base.endsWith('.psm1')) return true;
    if (base.endsWith('.user.js')) return false; // 油猴脚本优先级更高
    const ext = path.extname(absFilePath);
    if (ext !== '') return false; // 有扩展名但不匹配则不归本 analyzer
    // 无扩展名:读首 256 字节看 shebang
    const fd = fs.openSync(absFilePath, 'r');
    try {
      const buf = Buffer.alloc(256);
      const { bytesRead } = fs.readSync(fd, buf, 0, 256, 0);
      const head = buf.toString('utf-8', 0, bytesRead);
      return /^#!.*\b(bash|sh|zsh|ksh|dash)\b/.test(head);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

// 基于扩展名快速判定脚本语言:'bash' | 'powershell' | null
export function detectShellLanguage(absFilePath) {
  const base = path.basename(absFilePath).toLowerCase();
  if (base.endsWith('.sh') || base.endsWith('.bash') || base.endsWith('.zsh')) return 'bash';
  if (base.endsWith('.ps1') || base.endsWith('.psm1')) return 'powershell';
  return null;
}

// ---------------------------------------------------------------------------
// Bash 已知外部命令(用于抽 usesBuiltin / downloadsFrom / writesTo / 风险检测)
// ---------------------------------------------------------------------------

const BASH_BUILTIN_CMDS = new Set([
  // 文件操作
  'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'ln', 'install', 'touch', 'chmod', 'chown', 'chgrp',
  // 文本/搜索
  'cat', 'echo', 'printf', 'head', 'tail', 'awk', 'sed', 'grep', 'egrep', 'fgrep', 'cut', 'tr', 'sort', 'uniq', 'wc', 'tee', 'xargs', 'less', 'more',
  // 下载/网络
  'curl', 'wget',
  // 归档/校验
  'tar', 'unzip', 'zip', 'gunzip', 'gzip', 'xz', 'sha256sum', 'sha1sum', 'md5sum', 'b2sum', 'sha512sum',
  // 系统管理
  'sudo', 'apt', 'apt-get', 'dpkg', 'pacman', 'yum', 'dnf', 'zypper', 'systemctl', 'service',
  // 查询
  'jq', 'yq', 'uname', 'id', 'whoami', 'command', 'type', 'which', 'env', 'dirname', 'basename', 'realpath', 'readlink',
  // 进程
  'kill', 'killall', 'pkill', 'ps', 'pgrep', 'pidof',
  // 测试/重定向
  'test', '[', 'true', 'false', ':', 'eval', 'exec', 'source', '.', 'exit', 'return',
  // 平台/构建
  'cmake', 'make', 'ninja', 'cargo', 'rustc', 'gcc', 'g++', 'clang', 'clang++', 'cc', 'c++', 'ld', 'ar', 'patchelf',
  // 运行时
  'node', 'bun', 'python', 'python3', 'ruby', 'perl', 'php', 'java', 'go', 'rustc', 'docker', 'podman', 'git',
  // 实用
  'sleep', 'date', 'read', 'test', 'trap', 'wait', 'export', 'set', 'unset', 'local', 'declare', 'typeset', 'alias', 'unalias', 'history', 'shopt', 'ulimit',
]);

// 已知"会下载远程内容"的网络命令(单独标记,用于风险检测)
const DOWNLOAD_CMDS = new Set(['curl', 'wget', 'fetch']);

// 已知"会写文件/目录"的操作(用于 writesTo 边)
const WRITE_CMDS = new Set(['cp', 'mv', 'rm', 'rmdir', 'mkdir', 'ln', 'install', 'touch', 'tee']);

// 已知"会读注册表"的工具(Windows;非 PS 也算)
const REG_TOOLS = new Set(['reg', 'regedit']);

// PowerShell 已知 cmdlet 分类(用于风险与归类)
const PS_CMDLET_CATEGORIES = {
  Get: 'read', Set: 'write', New: 'write', Remove: 'write', Clear: 'write',
  Start: 'exec', Stop: 'exec', Restart: 'exec', Wait: 'exec',
  Copy: 'write', Move: 'write', Rename: 'write',
  Test: 'check', Resolve: 'read', Select: 'read', Where: 'read', ForEach: 'exec',
  Invoke: 'exec', Out: 'write', Write: 'write', Read: 'read',
  Add: 'write', Push: 'write', Pop: 'read',
  Enable: 'write', Disable: 'write', Register: 'write', Unregister: 'write',
  Import: 'read', Export: 'write', Convert: 'read', Format: 'read',
  Show: 'read', Hide: 'write', Open: 'exec', Close: 'exec', Mount: 'write', Dismount: 'write',
  Connect: 'exec', Disconnect: 'exec', Enter: 'exec', Exit: 'exec',
};

const PS_NET_CMDLETS = new Set([
  'Invoke-WebRequest', 'Invoke-RestMethod', 'Invoke-RestMethodEx', 'Invoke-WebRequestEx',
  'Send-MailMessage', 'Get-WebRequest', 'Test-NetConnection', 'Resolve-DnsName',
  'Get-NetIPAddress', 'Get-NetAdapter', 'New-WebServiceProxy',
]);

const PS_REG_HIVES = ['HKCU:', 'HKLM:', 'HKCR:', 'HKU:', 'HKCC:'];

// ---------------------------------------------------------------------------
// 元数据块解析
// ---------------------------------------------------------------------------

// 解析 Bash 顶部注释块(# 开头的连续行)
function parseBashHeader(content) {
  const lines = content.split('\n');
  const out = { description: [], notes: [] };
  let inDesc = false;
  let inNotes = false;
  for (let i = 0; i < Math.min(60, lines.length); i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      if (inDesc) inDesc = false;
      if (inNotes) inNotes = false;
      continue;
    }
    if (line.startsWith('#!')) continue;
    if (!line.startsWith('#')) break; // 离开头部注释区
    if (/^#\s*@name\b/i.test(line)) out.name = line.replace(/^#\s*@name\s*/i, '').trim();
    else if (/^#\s*@description\b/i.test(line)) { out.description.push(line.replace(/^#\s*@description\s*/i, '').trim()); inDesc = true; inNotes = false; }
    else if (/^#\s*@notes\b/i.test(line)) { out.notes.push(line.replace(/^#\s*@notes\s*/i, '').trim()); inNotes = true; inDesc = false; }
    else if (inDesc) out.description.push(line.replace(/^#\s*/, '').trim());
    else if (inNotes) out.notes.push(line.replace(/^#\s*/, '').trim());
  }
  if (out.description.length) out.description = [out.description.join(' ')];
  if (out.notes.length) out.notes = [out.notes.join(' ')];
  return out;
}

// 解析 PowerShell 基于注释的帮助块(必须在文件前 16KB)
export function parsePowerShellHelp(content) {
  const head = content.slice(0, 16384);
  const start = head.indexOf('<#');
  if (start < 0) return null;
  const end = head.indexOf('#>', start);
  if (end < 0) return null;
  const block = head.slice(start + 2, end);
  const meta = { synopsis: null, description: null, parameters: [], examples: [], notes: null, links: [] };
  let currentSection = null;
  let buffer = [];
  const flush = () => {
    const text = buffer.join('\n').trim();
    if (!text) return;
    if (currentSection === 'synopsis' && !meta.synopsis) meta.synopsis = text;
    else if (currentSection === 'description' && !meta.description) meta.description = text;
    else if (currentSection === 'notes' && !meta.notes) meta.notes = text;
    else if (currentSection === 'example') meta.examples.push(text);
    else if (currentSection === 'link') meta.links.push(text);
    buffer = [];
  };
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (/^\.([A-Z]+)\b/i.test(line)) {
      flush();
      currentSection = line.slice(1).split(/\s+/)[0].toLowerCase();
      const after = line.replace(/^\.[A-Z]+\s*/i, '').trim();
      if (after) buffer.push(after);
    } else {
      buffer.push(raw.replace(/^\s*#\s?/, ''));
    }
  }
  flush();
  // 解析 .PARAMETER 行(短形式 .PARAMETER Name + 跨行描述)
  const paramRegex = /^\.PARAMETER\s+(\S+)\s*$/gm;
  let m;
  while ((m = paramRegex.exec(block)) !== null) {
    meta.parameters.push({ name: m[1], description: null });
  }
  return meta;
}

// 解析 PS param(...) 块(类型/默认值/mandatory/位置)
function parsePowerShellParamBlock(content) {
  const idx = content.search(/^\s*\[?\s*CmdletBinding\s*\(\s*\)\s*\]?\s*$/m);
  const paramStart = content.indexOf('param(', idx >= 0 ? idx : 0);
  if (paramStart < 0) return { params: [], hasCmdletBinding: idx >= 0 };
  // 找到匹配的右括号
  let depth = 0;
  let end = -1;
  for (let i = paramStart; i < content.length; i++) {
    if (content[i] === '(') depth++;
    else if (content[i] === ')') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return { params: [], hasCmdletBinding: idx >= 0 };
  const inner = content.slice(paramStart + 'param('.length, end);
  // 顶层 split(忽略括号内的逗号)
  const parts = [];
  let buf = '';
  let d = 0;
  let inStr = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inStr) {
      if (c === inStr && inner[i - 1] !== '\\') inStr = null;
      buf += c;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; buf += c; continue; }
    if (c === '(' || c === '[' || c === '{') { d++; buf += c; continue; }
    if (c === ')' || c === ']' || c === '}') { d--; buf += c; continue; }
    if (c === ',' && d === 0) { parts.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) parts.push(buf.trim());
  const params = [];
  for (const raw of parts) {
    const p = parseOnePowerShellParam(raw);
    if (p) params.push(p);
  }
  return { params, hasCmdletBinding: idx >= 0 };
}

// 形如:
//   [Parameter(Mandatory=$true, Position=0)]
//   [string]$Path = '/default',
//   [switch]$Force,
//   [ValidateSet('a','b')][string]$Mode = 'a'
function parseOnePowerShellParam(raw) {
  // 收集所有 [..] 特性 + 类型 + 变量
  const attrRe = /\[([^\]]+)\]/g;
  const attrs = [];
  let m;
  while ((m = attrRe.exec(raw)) !== null) attrs.push(m[1].trim());
  // 去掉特性后剩: 类型(可选) + 变量
  const remainder = raw.replace(attrRe, '').trim();
  // 类型名从 attrs 中识别:[string] [int] [bool] [switch] [array] [hashtable] [psobject] 等
  // 也接受从 remainder 前缀识别:`string $X = ...`
  const knownTypes = ['string', 'int', 'long', 'bool', 'switch', 'array', 'hashtable', 'psobject', 'object', 'double', 'decimal', 'datetime', 'guid', 'ipaddress', 'uri', 'regex', 'scriptblock', 'xml', 'char', 'byte'];
  let type = null;
  for (const a of attrs) {
    const lower = a.toLowerCase();
    if (knownTypes.includes(lower)) { type = lower; break; }
  }
  // 简化 remainder:去掉前导的已知类型名
  let cleaned = remainder;
  if (type) {
    cleaned = cleaned.replace(new RegExp(`^${type}\\s+`, 'i'), '');
  } else {
    // 试从前缀抽
    const tmatch = cleaned.match(/^([A-Za-z][\w.]*)\s+(\$[A-Za-z_][\w]*)/);
    if (tmatch) { type = tmatch[1].toLowerCase(); cleaned = tmatch[2] + cleaned.slice(tmatch[0].length - tmatch[2].length); }
  }
  const varMatch = cleaned.match(/^(\$[A-Za-z_][\w]*)\s*(=\s*(.+))?$/);
  if (!varMatch) return null;
  const name = varMatch[1].slice(1);
  const defaultValue = varMatch[3] ? varMatch[3].trim().replace(/,$/, '') : null;
  let mandatory = false;
  let position = null;
  for (const a of attrs) {
    const m1 = a.match(/Mandatory\s*=\s*\$true/i);
    if (m1) mandatory = true;
    const m2 = a.match(/Position\s*=\s*(\d+)/i);
    if (m2) position = parseInt(m2[1], 10);
  }
  return { name, type, defaultValue, mandatory, position };
}

// ---------------------------------------------------------------------------
// 噪声剥离(行/块注释 + 单/双引号字符串 + here-doc)
// ---------------------------------------------------------------------------

// 把 content 中的注释与字符串替换为等长空白,保留行号与列号
function stripNoise(content) {
  let out = '';
  let i = 0;
  const n = content.length;
  let inHereDoc = null; // {tag: string, endTag: string}
  while (i < n) {
    // here-doc 处理
    if (inHereDoc) {
      if (content.startsWith(inHereDoc.endTag, i) && (content[i + inHereDoc.endTag.length] === '\n' || i + inHereDoc.endTag.length === n)) {
        out += ' '.repeat(inHereDoc.endTag.length);
        i += inHereDoc.endTag.length;
        inHereDoc = null;
        continue;
      }
      out += content[i] === '\n' ? '\n' : ' ';
      i++;
      continue;
    }
    const c = content[i];
    const nx = content[i + 1];
    if (c === '#' && (out.length === 0 || out[out.length - 1] === '\n' || /^\s/.test(out.slice(-1)))) {
      // 行注释到行末
      while (i < n && content[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '<' && nx === '#') {
      // PS 块注释 <# ... #>
      i += 2;
      while (i < n && !(content[i] === '#' && content[i + 1] === '>')) { out += content[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      out += c;
      i++;
      while (i < n && content[i] !== q) {
        if (content[i] === '\\' && i + 1 < n) { out += '  '; i += 2; continue; }
        out += content[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += q; i++; }
      continue;
    }
    if (c === '<' && nx === '<' && /[A-Za-z]/.test(content[i + 2] ?? '')) {
      // here-doc 起始:<<EOF / <<-EOF / <<'EOF' / <<"EOF"
      const m = content.slice(i).match(/^<<-?\s*(?:['"]?)([A-Za-z_][\w]*)(?:['"]?)/);
      if (m) {
        inHereDoc = { tag: m[1], endTag: m[1] };
        out += ' '.repeat(m[0].length);
        i += m[0].length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bash 解析
// ---------------------------------------------------------------------------

// 抽 Bash 函数定义:返回 [{name, body, startLine, endLine, params}]
function findBashFunctions(stripped) {
  const fns = [];
  // 形态 1:name() { body }   / name()  { body; }
  // 形态 2:function name { body }
  // 形态 3:function name() { body }
  // 用 { ... } 配对找 body
  const lines = stripped.split('\n');
  const declRe = /^(?:\s*)(?:function\s+([A-Za-z_][\w]*)\s*(?:\(\s*\))?\s*\{?|([A-Za-z_][\w]*)\s*\(\s*\)\s*\{)/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(declRe);
    if (!m) continue;
    // 必须以 { 结尾(形态 1 形如 `name() {` 单行)或后续行以 { 开头
    let name = m[1] || m[2];
    let braceStart = line.indexOf('{', m[0].length - 1);
    if (braceStart < 0) {
      // 找下一行首个 { (function name\n{ ... })
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (/^\s*\{/.test(lines[j])) { braceStart = 0; break; }
      }
      if (braceStart < 0) continue;
    }
    // 找匹配的 }
    let depth = 0;
    let endLine = -1;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { endLine = j; break; }
        }
      }
      if (endLine >= 0) break;
    }
    if (endLine < 0) endLine = lines.length - 1;
    const body = lines.slice(i, endLine + 1).join('\n');
    fns.push({ name, body, startLine: i + 1, endLine: endLine + 1 });
    i = endLine; // 跳过已收录 body
  }
  return fns;
}

// 抽 Bash CLI 长参数(--foo / --bar / --baz=*)
function findBashCliParams(content) {
  const params = [];
  const seen = new Set();
  // 形态 A:--foo) 或 --foo=*) 在 case 块中
  // 用 content 而非 stripped(stripNoise 会破坏 "$1" 内的 $ 引用)
  // 简化为:只抓 --name 形式,=value / =* 都视为 hasValue=true
  const re = /--([A-Za-z][\w-]*)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    if (seen.has(name)) continue;
    // 简化:仅在 case 块或 while 循环内出现的 --name 才视为 CLI 参数
    // 上下文扩大到 400 字符(case 块 4-5 个 case 项总长约 200-300 字符)
    const ctxStart = Math.max(0, m.index - 400);
    const ctx = content.slice(ctxStart, m.index);
    if (!/case|while|shift|getopts|set\s+--|\$\d+|getopt/i.test(ctx)) continue;
    seen.add(name);
    // 上下文后 60 字符内是否 =value 形态
    const tail = content.slice(m.index, Math.min(content.length, m.index + 60));
    const hasValue = /=[^*)\s]/.test(tail) || /=\*/.test(tail);
    params.push({ name, hasValue, kind: 'long' });
  }
  return params;
}

// 抽 Bash 内置调用(从 token 流里)
function findBashBuiltinCalls(body) {
  const counts = new Map();
  const urls = [];
  const writeTargets = [];
  // 按空白与 shell 标点分词(简单实现,够用)
  const tokens = body.split(/[\s|&;()<>"'`{}]+/);
  for (const tokRaw of tokens) {
    if (!tokRaw) continue;
    const tok = tokRaw.replace(/^["']|["']$/g, '');
    if (BASH_BUILTIN_CMDS.has(tok)) counts.set(tok, (counts.get(tok) ?? 0) + 1);
    if (DOWNLOAD_CMDS.has(tok)) {
      // 尝试抽 URL
      const m = body.match(/https?:\/\/[^\s"')}]+/g);
      if (m) for (const u of m) urls.push({ cmd: tok, url: u });
    }
  }
  // 写文件目标:cp/mv/ln/install/tee 后第一个非选项参数
  const writeRegex = /\b(cp|mv|ln|install|tee|rm|mkdir|rmdir)\b\s+((?:-\S+\s+)*)([^-\s][^\s;|]*)/g;
  let wm;
  while ((wm = writeRegex.exec(body)) !== null) {
    writeTargets.push({ cmd: wm[1], target: wm[3].replace(/['"]/g, '') });
  }
  return { counts, urls, writeTargets };
}

// 抽函数间调用(function a { ...; b; ... })
// Bash 调用形式:name / name() / name args;允许紧跟空白/换行/`(`/`;`/行尾,但要排除 name= 与 name: 等赋值/声明
function findBashCallEdges(fns) {
  const out = new Map();
  for (const fn of fns) {
    const targets = new Set();
    for (const other of fns) {
      if (other.name === fn.name) continue;
      // 排除自身声明:fn.body 开头就是 `name() {`
      // 先去掉自身声明行
      const body = fn.body.replace(new RegExp(`^\\s*function\\s+${other.name}\\b.*$`, 'm'), '');
      const body2 = body.replace(new RegExp(`^\\s*${other.name}\\s*\\(\\s*\\)\\s*\\{`, 'm'), '');
      // 形态:其他函数出现在 body 中(后跟空白/`(`/`;`/行尾),但不是赋值/关键字
      const re = new RegExp(`(?<![=:])\\b${other.name}\\b(?=\\s|\\(|;|$)`, 'm');
      if (re.test(body2)) targets.add(other.name);
    }
    if (targets.size) out.set(fn.name, targets);
  }
  return out;
}

// 抽 main() 入口 + 顶层 CLI 分发
// 注意:stripNoise 会破坏字符串内的 $ 引用(把 $ 后的内容当字符串字面替换),所以此处改用原始 content 检测骨架
function findBashMainEntry(content) {
  // 入口 main "$@"(允许 main () / main() 形态)
  const hasMain = /\bmain\s*\(\s*"\$@"\s*\)/.test(content)
    || /\bmain\s*\(\s*\)\s*\{/.test(content);
  // 顶层 CLI 分发:while [ $# -gt 0 ] / while [[ ... ]] / while (( ... ))  + 任意 case 块
  // 不能直接依赖 stripped(stripNoise 把 "$1" 内的 $1 替换为空),用宽松骨架
  // 形态:while 循环(参数循环)+ case "$N" in 块(N 是数字)
  const hasWhileArg = /while[^\n]*\$\#/.test(content);
  const hasCase = /\bcase\s+["']?\$\d+["']?\s+in\b/.test(content);

  return { hasMainEntry: hasMain, hasTopLevelDispatch: hasWhileArg && hasCase };
}

// 抽注册表调用(reg 工具)
function findBashRegOps(body) {
  const out = [];
  const re = /\breg\s+(?:add|delete|query)\s+([A-Z]{3,5}\\[^\s]+)/gi;
  let m;
  while ((m = re.exec(body)) !== null) out.push({ path: m[1] });
  return out;
}

// 抽 SHA-256 校验
function findBashChecksumOps(body) {
  const out = [];
  const re = /\bsha(?:256|1|512)?sum\b/g;
  const matches = body.match(re);
  if (matches) out.push({ tool: 'sha256sum', count: matches.length });
  return out;
}

// ---------------------------------------------------------------------------
// PowerShell 解析
// ---------------------------------------------------------------------------

// 抽 PS 函数定义: function Verb-Noun { ... }  /  filter  / Workflow
function findPowerShellFunctions(stripped) {
  const fns = [];
  const lines = stripped.split('\n');
  // 形态:function Name { ... }  (必须 Verb-Noun 形态;但也接受 Verb-Noun 单字符变体)
  const re = /^\s*function\s+([A-Za-z][\w-]*)\s*(?:\[[^\]]*\])?\s*\{/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    let depth = 0;
    let endLine = -1;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { endLine = j; break; } }
      }
      if (endLine >= 0) break;
    }
    if (endLine < 0) endLine = lines.length - 1;
    const body = lines.slice(i, endLine + 1).join('\n');
    fns.push({ name: m[1], body, startLine: i + 1, endLine: endLine + 1 });
    i = endLine;
  }
  return fns;
}

// 抽 PS cmdlet 调用: Verb-Noun
function findPowerShellCmdletCalls(body) {
  const counts = new Map();
  // 形如:Get-Process / Stop-Process / Invoke-RestMethod / Test-Path / ...
  // 也接受:\Get-Process  / & Get-Process
  const re = /(^|[\s&|;{(\[,=])\b([A-Z][a-z]+(?:-[A-Z][\w-]+)+)\b/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const name = m[2];
    if (name === 'switch' || name === 'if' || name === 'else' || name === 'function') continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

// 抽 PS 写文件 cmdlet 目标
function findPowerShellWriteTargets(body) {
  const out = [];
  // Copy-Item / Move-Item / Remove-Item / Set-Content / Out-File / New-Item / Rename-Item
  const re = /\b(Copy-Item|Move-Item|Remove-Item|Set-Content|Out-File|New-Item|Rename-Item)\b[^\n]*?-(?:Path|Destination|LiteralPath|FilePath)\s+["']?([^"'\s,;)]+)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    out.push({ cmd: m[1], target: m[2] });
  }
  return out;
}

// 抽 PS 网络调用 URL
function findPowerShellUrls(body) {
  const out = [];
  const re = /-Uri\s+["']?(https?:\/\/[^"'\s,;)]+)/g;
  let m;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  // 也抽裸 URL(供下载相关 cmdlet 间接使用)
  const bare = body.match(/https?:\/\/[^\s"')}]+/g);
  if (bare) for (const u of bare) if (!out.includes(u)) out.push(u);
  return out;
}

// 从原始 content 直接抽 URL(绕开 stripNoise 字符串破坏)
function extractUrlsFromContent(content) {
  const out = [];
  const re = /https?:\/\/[^\s"'<>)\]\\,;]+/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    let url = m[0];
    // 去掉末尾标点
    while (/[.,;:!?]$/.test(url)) url = url.slice(0, -1);
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

// 抽注册表读写
function findPowerShellRegOps(body) {
  const out = [];
  // 形如 HKCU:\Software\Valve\Steam 或 HKLM:\SOFTWARE\Valve\Steam
  // 兼容单反斜杠(HKCU:\Software)与双反斜杠('HKCU:\\Software',源文件字符串字面里的转义)
  // 把 hive 与反斜杠都写成 literal,避免 RegExp 字符类里出现 ':' / 字符类嵌套
  const hives = ['HKCU', 'HKLM', 'HKCR', 'HKU', 'HKCC'];
  for (const hive of hives) {
    // 单反斜杠:HKCU:\
    const re1 = new RegExp(`\\b${hive}:\\\\([^\\s"',;\\]\\[(){}]+)`, 'g');
    let m;
    while ((m = re1.exec(body)) !== null) out.push({ hive, path: m[1] });
    // 双反斜杠:HKCU:\\(源字面里的转义)
    const re2 = new RegExp(`\\b${hive}:\\\\\\\\([^\\s"',;\\]\\[(){}]+)`, 'g');
    while ((m = re2.exec(body)) !== null) out.push({ hive, path: m[1] });
  }
  return out;
}

// 抽 SHA-256 校验
function findPowerShellChecksumOps(body) {
  const out = [];
  if (/Get-FileHash\b/.test(body) && /-Algorithm\s+SHA256\b/i.test(body)) {
    out.push({ tool: 'Get-FileHash', algorithm: 'SHA256' });
  }
  return out;
}

// 抽函数间调用
function findPowerShellCallEdges(fns) {
  const out = new Map();
  for (const fn of fns) {
    const targets = new Set();
    for (const other of fns) {
      if (other.name === fn.name) continue;
      // 形态:FunctionName / & FunctionName
      const re = new RegExp(`(^|[\\s&|;{(\\[,=])${other.name}\\b`);
      if (re.test(fn.body)) targets.add(other.name);
    }
    if (targets.size) out.set(fn.name, targets);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 风险检测
// ---------------------------------------------------------------------------

function detectBashRisks({ stripped, fns, builtinCalls, writeTargets, urls }) {
  const risks = [];
  // 高:sudo rm -rf / sudo cp 任意路径
  if (/\bsudo\s+cp\b/.test(stripped) || /\bsudo\s+cp\s+-r/.test(stripped)) {
    risks.push({ severity: 'high', kind: 'sudo-cp', detail: 'sudo cp 会以 root 身份覆盖文件' });
  }
  if (/\bsudo\s+rm\s+-rf?\b/.test(stripped)) {
    risks.push({ severity: 'high', kind: 'sudo-rm-rf', detail: 'sudo rm -rf 高危(取决于路径)' });
  }
  if (/\bsudo\s+ln\s+-sf/.test(stripped)) {
    risks.push({ severity: 'medium', kind: 'sudo-ln-sf', detail: 'sudo ln -sf 强制符号链接,可能覆盖已有链接' });
  }
  // 中:网络下载无 SHA 校验
  if (urls.length > 0 && !/\bsha256sum\b/.test(stripped) && !/\bsha512sum\b/.test(stripped)) {
    risks.push({ severity: 'medium', kind: 'download-no-checksum', detail: `下载 ${urls.length} 个 URL,未发现 SHA 校验` });
  }
  // 中:rm -rf + 未引号变量
  if (/\brm\s+-rf?\s+\$/.test(stripped)) {
    risks.push({ severity: 'medium', kind: 'rm-rf-unquoted-var', detail: 'rm -rf $var 未引号,空格路径会拆解多删' });
  }
  // 中:写入 /usr/lib / /etc 等系统目录
  for (const t of writeTargets) {
    if (/^(\/usr|\/etc|\/bin|\/sbin)\b/.test(t.target)) {
      risks.push({ severity: 'medium', kind: 'system-path-write', detail: `${t.cmd} 写入系统路径 ${t.target}` });
      break;
    }
  }
  return risks;
}

function detectPowerShellRisks({ stripped, fns, cmdletCalls, writeTargets, urls, regOps }) {
  const risks = [];
  // 高:写 HKLM 注册表
  for (const op of regOps) {
    if (op.hive === 'HKLM' || op.hive === 'HKCR') {
      risks.push({ severity: 'high', kind: 'system-registry-write', detail: `${op.hive}:\\${op.path} 写入系统注册表` });
    }
  }
  // 高:Stop-Process / Remove-Item 强删
  if ((cmdletCalls.get('Stop-Process') ?? 0) > 0 && /-Force\b/.test(stripped)) {
    risks.push({ severity: 'high', kind: 'force-kill', detail: 'Stop-Process -Force 强制结束进程' });
  }
  if ((cmdletCalls.get('Remove-Item') ?? 0) > 0 && /-Recurse\b/.test(stripped) && /-Force\b/.test(stripped)) {
    risks.push({ severity: 'high', kind: 'force-recurse-remove', detail: 'Remove-Item -Recurse -Force 强删' });
  }
  // 中:Invoke-WebRequest / Invoke-RestMethod 无 SHA 校验
  const netCalls = (cmdletCalls.get('Invoke-WebRequest') ?? 0) + (cmdletCalls.get('Invoke-RestMethod') ?? 0);
  if (netCalls > 0 && !/Get-FileHash\b/.test(stripped)) {
    risks.push({ severity: 'medium', kind: 'download-no-checksum', detail: `Invoke-WebRequest/RestMethod 调用 ${netCalls} 次,无 Get-FileHash 校验` });
  }
  // 中:写入 Steam 安装根(用户级 OK,但标记)
  for (const t of writeTargets) {
    if (/[Ss]team$/.test(t.target) || /steam\b/i.test(t.target)) {
      risks.push({ severity: 'medium', kind: 'steam-dir-write', detail: `${t.cmd} 写入 Steam 目录 ${t.target}` });
      break;
    }
  }
  return risks;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function analyzeShellScript(filePath, content) {
  const language = detectShellLanguage(filePath) ?? 'bash';
  const stripped = stripNoise(content);
  const lineCount = content.split('\n').length;

  let facts;
  if (language === 'powershell') facts = analyzePowerShell(filePath, content, stripped, lineCount);
  else facts = analyzeBash(filePath, content, stripped, lineCount);

  return facts;
}

function analyzeBash(filePath, content, stripped, lineCount) {
  const header = parseBashHeader(content);
  const fns = findBashFunctions(stripped);
  const cliParams = findBashCliParams(content);
  const entry = findBashMainEntry(content);
  const callEdges = findBashCallEdges(fns);
  const risks = [];

  // 聚合 builtin 调用
  const builtinSummary = new Map(); // cmd -> {count, kind}
  const allUrls = [];
  const allWriteTargets = [];
  const allRegOps = [];
  const allChecksum = [];

  const fnFacts = [];
  for (const fn of fns) {
    const builtins = findBashBuiltinCalls(fn.body);
    const checksumOps = findBashChecksumOps(fn.body);
    const regOps = findBashRegOps(fn.body);
    for (const [k, v] of builtins.counts) {
      builtinSummary.set(k, (builtinSummary.get(k) ?? 0) + v);
    }
    for (const u of builtins.urls) allUrls.push({ fn: fn.name, ...u });
    for (const t of builtins.writeTargets) allWriteTargets.push({ fn: fn.name, ...t });
    for (const r of regOps) allRegOps.push({ fn: fn.name, ...r });
    for (const c of checksumOps) allChecksum.push({ fn: fn.name, ...c });
    // 角色推断(Bash 简化)
    const role = inferBashFnRole(fn);
    fnFacts.push({
      name: fn.name,
      kind: 'BashFunction',
      startLine: fn.startLine,
      endLine: fn.endLine,
      builtinCount: builtins.counts.size,
      // 本函数体内实际出现的外部命令名单(供 builder 生成精确的 fn→BashBuiltin usesBuiltin 边)
      builtinNames: [...builtins.counts.keys()],
      // 本函数体内以 --name 形式实际读到的 CLI 参数(供 builder 生成精确的 readsCliParam 边;
      // 基于剥离注释/字符串后的函数体文本关联——case 模式可命中,引号内 getopts 形态会漏)
      cliParamNames: cliParams.filter((p) => fn.body.includes(`--${p.name}`)).map((p) => p.name),
      callTargets: [...(callEdges.get(fn.name) ?? [])],
      role,
    });
  }
  // 顶层 builtin 调用
  const topLevel = findBashBuiltinCalls(stripped);
  // 顶层 URL 从 content 抽取(stripped 中字符串内 URL 被破坏)
  const topUrls = extractUrlsFromContent(content);
  for (const [k, v] of topLevel.counts) builtinSummary.set(k, (builtinSummary.get(k) ?? 0) + v);
  for (const u of topUrls) allUrls.push({ fn: '<top>', url: u, cmd: null });
  for (const t of topLevel.writeTargets) allWriteTargets.push({ fn: '<top>', ...t });

  const detectedRisks = detectBashRisks({ stripped, fns, builtinCalls: builtinSummary, writeTargets: allWriteTargets, urls: allUrls });
  risks.push(...detectedRisks);

  const fnRoles = countRoles(fnFacts);

  return {
    // 与 tsAnalyzer/userScriptAnalyzer 同 shape(空壳,builder 复用)
    path: filePath, ext: path.extname(filePath).slice(1), lineCount,
    imports: [], exportSymbols: [], exportNames: [], jsxTags: new Set(),
    useCalls: [], overlayOpens: [], stores: [], lazyWrappers: [],
    components: [], hooks: [],
    primaryComponentName: null, hasSingletonClass: false, hasClassExport: false,
    importMap: new Map(), vueRoutes: [], vueRouteMeta: null,
    interfaces: [], classes: [], traits: [], routes: [], moduleFunctions: [],
    // ---- 脚本专有 ----
    isShellScript: true,
    shellLanguage: 'bash',
    name: header.name ?? path.basename(filePath, path.extname(filePath)),
    description: header.description?.[0] ?? null,
    notes: header.notes?.[0] ?? null,
    shebang: (content.match(/^#!.*$/m) ?? [null])[0],
    functions: fnFacts,
    fnCount: fnFacts.length,
    cliParams,
    cliParamCount: cliParams.length,
    builtinCalls: [...builtinSummary.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    builtinCount: builtinSummary.size,
    downloadUrls: allUrls,
    writeTargets: allWriteTargets,
    regOps: allRegOps,
    checksumOps: allChecksum,
    hasMainEntry: entry.hasMainEntry,
    hasTopLevelDispatch: entry.hasTopLevelDispatch,
    callEdges: [...callEdges.entries()].map(([from, set]) => ({ from, to: [...set] })),
    fnRoles,
    risks,
    riskLevel: aggregateRisk(risks),
  };
}

function analyzePowerShell(filePath, content, stripped, lineCount) {
  const help = parsePowerShellHelp(content);
  const { params, hasCmdletBinding } = parsePowerShellParamBlock(content);
  const fns = findPowerShellFunctions(stripped);
  const callEdges = findPowerShellCallEdges(fns);
  const risks = [];

  // 注册表/URL/SHA 等需要原始 content(stripNoise 会破坏字符串内的 \ 与 $)
  const regOpsContent = findPowerShellRegOps(content);
  const regOpsStripped = findPowerShellRegOps(stripped);
  // 把 content 中抽到的顶层注册表合并到 fn 级循环
  const allRegOps = [...regOpsContent];

  const cmdletSummary = new Map();
  const allUrls = [];
  const allWriteTargets = [];
  const allChecksum = [];

  const fnFacts = [];
  for (const fn of fns) {
    const cmds = findPowerShellCmdletCalls(fn.body);
    const writeTargets = findPowerShellWriteTargets(fn.body);
    const urls = findPowerShellUrls(fn.body);
    const regOps = findPowerShellRegOps(fn.body);
    const checksum = findPowerShellChecksumOps(fn.body);
    for (const [k, v] of cmds) cmdletSummary.set(k, (cmdletSummary.get(k) ?? 0) + v);
    for (const u of urls) allUrls.push({ fn: fn.name, url: u });
    for (const t of writeTargets) allWriteTargets.push({ fn: fn.name, ...t });
    for (const r of regOps) allRegOps.push({ fn: fn.name, ...r });
    for (const c of checksum) allChecksum.push({ fn: fn.name, ...c });
    const role = inferPowerShellFnRole(fn, params);
    fnFacts.push({
      name: fn.name,
      kind: 'PsFunction',
      startLine: fn.startLine,
      endLine: fn.endLine,
      cmdletCount: cmds.size,
      // 本函数体内实际出现的 cmdlet/函数调用名单(供 builder 生成精确的 fn→Cmdlet usesBuiltin 边)
      cmdletNames: [...cmds.keys()],
      // 本函数体内以 $Name 形式实际引用的 CLI 参数(大小写不敏感;供 builder 生成精确的 readsCliParam 边)
      cliParamNames: params
        .filter((p) => new RegExp(`\\$${p.name}\\b`, 'i').test(fn.body))
        .map((p) => p.name),
      callTargets: [...(callEdges.get(fn.name) ?? [])],
      role,
    });
  }
  // 顶层 cmdlet(脚本体直接调用)
  const topCmds = findPowerShellCmdletCalls(stripped);
  for (const [k, v] of topCmds) cmdletSummary.set(k, (cmdletSummary.get(k) ?? 0) + v);
  // 顶层 URL 从 content 抽取(stripped 中字符串内 URL 被破坏)
  const topUrls = extractUrlsFromContent(content);
  for (const u of topUrls) allUrls.push({ fn: '<top>', url: u });
  const topChecksum = findPowerShellChecksumOps(stripped);
  for (const c of topChecksum) allChecksum.push({ fn: '<top>', ...c });

  const detectedRisks = detectPowerShellRisks({ stripped, fns, cmdletCalls: cmdletSummary, writeTargets: allWriteTargets, urls: allUrls, regOps: allRegOps });
  risks.push(...detectedRisks);

  const fnRoles = countRoles(fnFacts);

  // CLI 参数元数据:把 help.parameters 的 description 与 param() 的 name/type/mandatory 对齐
  const cliParams = params.map((p) => {
    const helpMatch = (help?.parameters ?? []).find((hp) => hp.name === p.name);
    return {
      name: p.name,
      type: p.type,
      mandatory: p.mandatory,
      position: p.position,
      defaultValue: p.defaultValue,
      description: helpMatch?.description ?? null,
    };
  });

  return {
    path: filePath, ext: path.extname(filePath).slice(1), lineCount,
    imports: [], exportSymbols: [], exportNames: [], jsxTags: new Set(),
    useCalls: [], overlayOpens: [], stores: [], lazyWrappers: [],
    components: [], hooks: [],
    primaryComponentName: null, hasSingletonClass: false, hasClassExport: false,
    importMap: new Map(), vueRoutes: [], vueRouteMeta: null,
    interfaces: [], classes: [], traits: [], routes: [], moduleFunctions: [],
    // ---- PS 专有 ----
    isShellScript: true,
    shellLanguage: 'powershell',
    name: help?.synopsis?.split('\n')[0] ?? path.basename(filePath, path.extname(filePath)),
    description: help?.description ?? null,
    notes: help?.notes ?? null,
    examples: help?.examples ?? [],
    hasCmdletBinding,
    functions: fnFacts,
    fnCount: fnFacts.length,
    cliParams,
    cliParamCount: cliParams.length,
    cmdletCalls: [...cmdletSummary.entries()].map(([name, count]) => ({ name, count, category: PS_CMDLET_CATEGORIES[name.split('-')[0]] ?? 'other', isNet: PS_NET_CMDLETS.has(name) })).sort((a, b) => b.count - a.count),
    cmdletCount: cmdletSummary.size,
    downloadUrls: allUrls,
    writeTargets: allWriteTargets,
    regOps: allRegOps,
    checksumOps: allChecksum,
    callEdges: [...callEdges.entries()].map(([from, set]) => ({ from, to: [...set] })),
    fnRoles,
    risks,
    riskLevel: aggregateRisk(risks),
  };
}

function inferBashFnRole(fn) {
  const n = fn.name.toLowerCase();
  if (/^check|verify|validate|test_/.test(n)) return 'check';
  if (/^install|setup|uninstall|cleanup|destroy/.test(n)) return 'install';
  if (/^download|fetch|get_/.test(n)) return 'network';
  if (/^post|pre|init|finalize/.test(n)) return 'lifecycle';
  if (/^log|format|print/.test(n)) return 'ui';
  if (/^main$/.test(n)) return 'entry';
  if (/^parse_/.test(n)) return 'parse';
  return 'logic';
}

function inferPowerShellFnRole(fn) {
  const n = fn.name;
  if (/^Get-/.test(n)) return 'read';
  if (/^Set-|^New-|^Add-|^Remove-|^Clear-/.test(n)) return 'write';
  if (/^Test-/.test(n)) return 'check';
  if (/^Start-|^Stop-|^Restart-|^Invoke-/.test(n)) return 'exec';
  if (/^Resolve-|^Find-/.test(n)) return 'resolve';
  if (/^Format-|^Convert-/.test(n)) return 'transform';
  return 'logic';
}

function countRoles(fnFacts) {
  const m = new Map();
  for (const f of fnFacts) m.set(f.role, (m.get(f.role) ?? 0) + 1);
  return [...m.entries()].map(([role, count]) => ({ role, count })).sort((a, b) => b.count - a.count);
}

function aggregateRisk(risks) {
  if (risks.length === 0) return 'none';
  const order = { high: 3, medium: 2, low: 1 };
  return risks.reduce((max, r) => order[r.severity] > order[max] ? r.severity : max, 'low');
}

export function analyzeShellScriptFromDisk(relPath, projectRoot) {
  const content = fs.readFileSync(path.join(projectRoot, relPath), 'utf-8');
  return analyzeShellScript(relPath, content);
}
