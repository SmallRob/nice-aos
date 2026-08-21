// CLI 自更新：npm registry 版本比对 + 按安装模式升级/指引。
// 安装模式判定用两个互补信号（符号链接场景 import.meta.url 会被 realpath 解析回源码目录，
// 故以"调用入口 argv[1]（保留链接）"为主、"模块真实路径布局"为辅）：
//   global — registry 全局安装（含 npm install -g <本地目录> 的符号链接形式，升级会替换为 registry 版本）
//   npx    — _npx 缓存运行 → npx 按版本缓存，建议 `npx nice-aos@latest` 拉新
//   local  — 项目 node_modules 依赖 → 升级会改写项目 package.json，不代做，给出指引
//   repo   — 仓库源码运行（node src/cli/index.js）→ 跟随 git，建议 git pull + npm install
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf-8')).version ?? '0.0.0';

const NPM_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 180_000;

function npmRun(args, opts = {}) {
  return execFileSync('npm', args, {
    encoding: 'utf-8',
    timeout: NPM_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    ...opts,
  }).trim();
}

function fetchLatestVersion() {
  try {
    const v = npmRun(['view', 'nice-aos', 'version']);
    return /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null;
  }
}

// 入口是否位于 npm 全局 bin 目录（registry 安装 / npm link / npm install -g <本地目录>）
function entryInGlobalBin(entry) {
  try {
    const prefix = npmRun(['prefix', '-g']);
    const globalBin = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
    const rel = path.relative(globalBin, entry);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function isSymlinkDir(dir) {
  try {
    return fs.lstatSync(dir).isSymbolicLink();
  } catch {
    return false;
  }
}

function detectInstallMode() {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : null;
  const realSelfDir = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));

  // npx 缓存：入口或真实路径任一命中 _npx
  if ([entry, realSelfDir].some((p) => p && p.includes(`${path.sep}_npx${path.sep}`))) {
    const m = realSelfDir.match(/^(.*_npx.*node_modules)[/\\]nice-aos[/\\]/);
    return { mode: 'npx', pkgDir: m ? path.join(m[1], 'nice-aos') : null };
  }

  // 信号一：入口位于 npm 全局 bin（覆盖符号链接安装：npm link / npm install -g <本地目录>）
  if (entry && entryInGlobalBin(entry)) {
    const globalRoot = npmRun(['root', '-g']);
    const pkgDir = path.join(globalRoot, 'nice-aos');
    return { mode: 'global', pkgDir, linked: isSymlinkDir(pkgDir) };
  }

  // 信号二：unix 全局布局强信号 <prefix>/lib/node_modules/nice-aos（多 prefix 环境：homebrew / nvm 等，
  // PATH 中 npm 的 prefix 与实际安装 prefix 不一致时仍可识别）
  const m = realSelfDir.match(/^(.*lib[/\\]node_modules)[/\\]nice-aos[/\\]/);
  if (m && process.platform !== 'win32') {
    const pkgDir = path.join(m[1], 'nice-aos');
    return { mode: 'global', pkgDir, linked: isSymlinkDir(pkgDir) };
  }

  // 项目本地依赖
  const lm = realSelfDir.match(/^(.*[/\\]node_modules)[/\\]nice-aos[/\\]/);
  if (lm) return { mode: 'local', pkgDir: path.join(lm[1], 'nice-aos') };

  return { mode: 'repo', pkgDir: PKG_ROOT };
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

export { compareVersions };

function installedVersionAt(pkgDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')).version ?? null;
  } catch {
    return null;
  }
}

const MODE_LABEL = {
  global: 'npm 全局安装',
  npx: 'npx 缓存运行',
  local: '项目依赖安装（node_modules）',
  repo: '仓库源码运行',
};

function upgradeGuidance(mode, latest) {
  switch (mode) {
    case 'global':
      return 'npm install -g nice-aos@latest';
    case 'npx':
      return 'npx nice-aos@latest ...（npx 按版本缓存，指定 @latest 拉取新版；或改用全局安装：npm install -g nice-aos）';
    case 'local':
      return '在宿主项目内执行 npm install nice-aos@latest（升级会改写 package.json，不由 CLI 代做）';
    default:
      return `git pull && npm install（仓库源码跟随 git，最新发布见 npm registry 当前 latest: ${latest}）`;
  }
}

export const updateCommand = new Command('update')
  .description('检查 npm 最新版本并升级 CLI（全局安装时自动执行 npm install -g nice-aos@latest；--check 仅检测不升级）')
  .option('--check', '仅检测版本是否最新（不升级），输出 JSON 供 agent / CI 前置校验')
  .action((opts) => {
    const latest = fetchLatestVersion();
    if (!latest) {
      console.log(JSON.stringify({
        ok: false,
        error: '无法获取 npm registry 最新版本（网络不可达或 registry 配置异常）；可手动执行 npm view nice-aos version 核对',
        current: VERSION,
      }, null, 2));
      process.exit(1);
    }

    const { mode, pkgDir, linked } = detectInstallMode();
    const upToDate = compareVersions(VERSION, latest) >= 0;
    const base = {
      current: VERSION,
      latest,
      upToDate,
      installMode: mode,
      installModeLabel: linked ? 'npm 全局安装（本地目录符号链接）' : MODE_LABEL[mode],
      linkedInstall: !!linked,
    };

    if (opts.check || upToDate || mode !== 'global') {
      const payload = upToDate
        ? { ok: true, upgraded: false, ...base, message: `已是最新版 ${VERSION}（${base.installModeLabel}）` }
        : {
          ok: mode === 'global',
          upgraded: false,
          ...base,
          message: mode === 'global'
            ? `检测到新版本 ${latest}（当前 ${VERSION}），执行不带 --check 的 update 一键升级`
            : `检测到新版本 ${latest}（当前 ${VERSION}，${base.installModeLabel}）。当前安装模式无法自动升级，升级方式：${upgradeGuidance(mode, latest)}`,
          upgradeCommand: mode === 'global' ? 'nice-aos update' : upgradeGuidance(mode, latest),
        };
      console.log(JSON.stringify(payload, null, 2));
      process.exit(payload.ok ? 0 : 1);
    }

    // global 模式一键升级（符号链接安装会被替换为 registry 版本）
    try {
      execFileSync('npm', ['install', '-g', `nice-aos@${latest}`], {
        stdio: 'inherit',
        timeout: INSTALL_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch (err) {
      console.log(JSON.stringify({
        ok: false,
        error: `升级失败：${err.message ?? err}。可手动执行 npm install -g nice-aos@latest`,
        ...base,
      }, null, 2));
      process.exit(1);
    }
    const installed = installedVersionAt(pkgDir);
    const linkNote = linked ? '；原本地目录符号链接已被替换为 registry 版本' : '';
    console.log(JSON.stringify({
      ok: true,
      upgraded: true,
      ...base,
      installedVersion: installed,
      message: installed === latest
        ? `已升级 ${VERSION} → ${latest}（npm 全局安装${linkNote}）。执行 nice-aos --version 可复核`
        : `升级命令已完成（registry latest ${latest}，磁盘版本 ${installed ?? '未知'}）。执行 nice-aos --version 复核；若仍为旧版，检查 PATH 是否存在多个 nice-aos 安装`,
    }, null, 2));
  });
