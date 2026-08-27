// 用户自定义主题落盘层（out-5）：
//   `nice-aos output theme add/list/remove` 的存储实现。
//
// 目录解析链：NICE_AOS_THEMES_DIR 环境变量（测试注入用）> ~/.nice-aos/themes/
// 文件形态：<name>.json，内容 { label, dark, vars } —— 与 themes/index.js 的
// registerTheme 校验规则一致；themes/index.js 在 resolveTheme/listThemeNames
// 时会懒加载本目录，故 add 之后无需任何额外注册步骤。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const THEME_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function getUserThemesDir() {
  if (process.env.NICE_AOS_THEMES_DIR) return process.env.NICE_AOS_THEMES_DIR;
  return path.join(os.homedir(), '.nice-aos', 'themes');
}

export function isValidThemeName(name) {
  return typeof name === 'string' && THEME_NAME_RE.test(name);
}

/** 读取单个用户主题文件（不存在/损坏返回 null，错误信息由调用方决定如何呈现） */
export function readUserTheme(name, dir = getUserThemesDir()) {
  const filePath = path.join(dir, `${name}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return { filePath, definition: JSON.parse(fs.readFileSync(filePath, 'utf-8')) };
  } catch {
    return null;
  }
}

/** 列出用户主题（损坏文件标记 error 字段而非静默丢弃——用户需要知道有东西坏了） */
export function listUserThemes(dir = getUserThemesDir()) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -'.json'.length);
    try {
      const def = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      out.push({ name, label: def?.label ?? '', dark: !!def?.dark, file: path.join(dir, f) });
    } catch (err) {
      out.push({ name, label: '', dark: false, file: path.join(dir, f), error: err.message });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 写入用户主题文件。校验以 throw 形式呈现（保持本模块可单测、可编程调用）；
 * CLI 层（output theme add）在调用前已做同等校验，此处为兜底。
 * @returns {{filePath: string}} 写入路径
 */
export function saveUserTheme(name, definition, dir = getUserThemesDir()) {
  if (!isValidThemeName(name)) {
    throw new Error(`非法主题名: ${String(name)}（仅允许小写字母数字与中划线，≤40 字符，如 midnight-teal）`);
  }
  if (!definition || typeof definition !== 'object') {
    throw new Error('主题定义不能为空。示例: {"label":"午夜青","dark":true,"vars":{"--bg":"#0b1220","--fg":"#e2e8f0", ...}}');
  }
  const dirAbs = path.resolve(dir);
  fs.mkdirSync(dirAbs, { recursive: true });
  const filePath = path.join(dirAbs, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(definition, null, 2), 'utf-8');
  return { filePath };
}

/** 删除用户主题文件；内置主题（无对应文件）抛错引导 */
export function removeUserTheme(name, dir = getUserThemesDir()) {
  const filePath = path.join(dir, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`未找到用户主题 "${name}"（${filePath}）。内置主题不可删除，只能被同名用户主题覆盖展示名。`);
  }
  fs.rmSync(filePath);
  return { filePath };
}
