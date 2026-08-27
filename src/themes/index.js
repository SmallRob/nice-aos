// 蓝图主题注册表：布局骨架固定在 HTML 蓝图中，视觉 token 按主题切换。
// 主题 = 一组 :root CSS 变量值；渲染时经 buildThemeCss() 拼接进 <style> 首块（自包含离线打开）。
// 语义色变量名与各查看器现有用法一致（--blue 为主色，--green/--amber/... 为状态色），
// 浅色主题下调深语义色保证可读性；透明变体由 color-mix() 派生，无需独立变量。
//
// out-5（v0.34.0）扩展：
//   - registerTheme(name, def) 运行时注册（校验：label/dark/vars，vars 须含 --bg/--fg）
//   - 用户主题目录懒加载：~/.nice-aos/themes/*.json（NICE_AOS_THEMES_DIR 可覆盖），
//     resolveTheme/listThemeNames 首次调用时自动 sync——CLI 写入后无需手动注册

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const THEMES = {
  'deep-blue': {
    label: '深蓝暗色',
    dark: true,
    vars: {
      '--bg': '#0d1117', '--panel': '#161b22', '--panel2': '#1c2128', '--border': '#30363d',
      '--fg': '#e6edf3', '--fg-dim': '#8b949e', '--fg-faint': '#6e7681',
      '--blue': '#58a6ff', '--green': '#4ade80', '--amber': '#d29922', '--purple': '#a78bfa',
      '--red': '#f85149', '--cyan': '#39c5cf', '--pink': '#f472b6', '--orange': '#fb923c',
    },
  },
  'fresh-green': {
    label: '淡绿清新',
    dark: false,
    vars: {
      '--bg': '#f3f8f4', '--panel': '#ffffff', '--panel2': '#eaf3ec', '--border': '#d3e3d8',
      '--fg': '#1c2b22', '--fg-dim': '#56705f', '--fg-faint': '#8aa493',
      '--blue': '#1e7f5c', '--green': '#2f9e5f', '--amber': '#b45309', '--purple': '#7c5cbf',
      '--red': '#d64545', '--cyan': '#0e8fa3', '--pink': '#c2417f', '--orange': '#c2570b',
    },
  },
  'elegant-purple': {
    label: '典雅紫',
    dark: true,
    vars: {
      '--bg': '#12101f', '--panel': '#1a1730', '--panel2': '#251f45', '--border': '#3b3363',
      '--fg': '#ece8fb', '--fg-dim': '#a79ecf', '--fg-faint': '#726a9e',
      '--blue': '#a78bfa', '--green': '#4ade80', '--amber': '#fbbf24', '--purple': '#c084fc',
      '--red': '#f87171', '--cyan': '#7dd3fc', '--pink': '#f0abfc', '--orange': '#fb923c',
    },
  },
};

export const DEFAULT_THEMES = {
  deploy: 'deep-blue',
  db: 'fresh-green',
  code: 'deep-blue',
  service: 'elegant-purple',
  planning: 'deep-blue',
};

export function resolveTheme(name) {
  if (!name) throw new Error('主题名不能为空');
  const theme = THEMES[name];
  if (!theme) {
    const available = Object.keys(THEMES).join(' / ');
    throw new Error(`未知主题: ${name}（可用主题: ${available}）`);
  }
  return theme;
}

// 生成 :root 变量块；extraVars 供查看器追加私有变量（如代码蓝图的 --teal/--go）
// color-scheme 让浏览器原生控件（滚动条/输入框）跟随明暗主题
export function buildThemeCss(name, extraVars = {}) {
  const theme = resolveTheme(name);
  const vars = { ...theme.vars, ...extraVars };
  const lines = Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`);
  lines.push(`  color-scheme: ${theme.dark ? 'dark' : 'light'};`);
  return `:root[data-theme="${name}"] {\n${lines.join('\n')}\n}`;
}

export function listThemeNames() {
  syncUserThemes();
  return Object.keys(THEMES);
}

// ---------- out-5：运行时注册 + 用户主题目录懒加载 ----------

const THEME_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
let userThemesSynced = false;

/** 用户主题目录（NICE_AOS_THEMES_DIR 可覆盖；测试注入用） */
export function getUserThemesDir() {
  if (process.env.NICE_AOS_THEMES_DIR) return process.env.NICE_AOS_THEMES_DIR;
  return path.join(os.homedir(), '.nice-aos', 'themes');
}

/**
 * 运行时注册自定义主题。同名校验与合并规则：
 *   - 覆盖内置主题允许（同名用户主题优先展示）但在返回值中标记 overridden
 *   - 定义形态 { label, dark, vars }；vars 至少含 --bg 与 --fg
 * @returns {{ name: string, overridden: boolean }}
 */
export function registerTheme(name, definition) {
  if (!THEME_NAME_RE.test(String(name ?? ''))) {
    throw new Error(`非法主题名: ${String(name)}（仅允许小写字母数字与中划线，≤40 字符）`);
  }
  const d = definition ?? {};
  const problems = [];
  if (typeof d.label !== 'string' || !d.label.trim()) problems.push('label 须为非空字符串');
  if (typeof d.dark !== 'boolean') problems.push('dark 须为 boolean（决定 color-scheme 明暗）');
  if (!d.vars || typeof d.vars !== 'object' || Array.isArray(d.vars)) {
    problems.push('vars 须为对象（CSS 变量名 → 值）');
  } else {
    for (const required of ['--bg', '--fg']) {
      if (!d.vars[required]) problems.push(`vars 缺少必需变量 ${required}`);
    }
  }
  if (problems.length) {
    throw new Error(`主题 "${name}" 定义不合法:\n  - ${problems.join('\n  - ')}`);
  }
  const overridden = !!THEMES[name];
  THEMES[name] = { label: d.label, dark: d.dark, vars: { ...d.vars }, source: 'user' };
  return { name, overridden };
}

/** 懒加载用户主题目录（幂等；单文件损坏跳过并在 stderr 提示一次，不阻塞构建） */
export function syncUserThemes(dir = getUserThemesDir()) {
  if (userThemesSynced) return 0;
  userThemesSynced = true;
  let count = 0;
  let entries;
  try {
    entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  } catch {
    return 0;
  }
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    try {
      const def = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      registerTheme(f.slice(0, -'.json'.length), def);
      count += 1;
    } catch (err) {
      process.stderr.write(`⚠️  跳过无法解析的用户主题 ${f}: ${err.message.split('\n')[0]}\n`);
    }
  }
  return count;
}

/** 测试辅助：重置懒加载门闩（切换 NICE_AOS_THEMES_DIR 后可重新扫描） */
export function resetUserThemesCache() {
  userThemesSynced = false;
}

