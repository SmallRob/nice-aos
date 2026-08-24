// 蓝图主题注册表：布局骨架固定在 HTML 蓝图中，视觉 token 按主题切换。
// 主题 = 一组 :root CSS 变量值；渲染时经 buildThemeCss() 拼接进 <style> 首块（自包含离线打开）。
// 语义色变量名与各查看器现有用法一致（--blue 为主色，--green/--amber/... 为状态色），
// 浅色主题下调深语义色保证可读性；透明变体由 color-mix() 派生，无需独立变量。

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
  return Object.keys(THEMES);
}
