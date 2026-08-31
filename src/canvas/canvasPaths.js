// src/canvas/canvasPaths.js
// 画布模板路径解析：模板文件随 skills/nice-aos-canvas-skill/assets 一起打包，
// CLI 与上游 API 都通过本模块定位，避免到处写 fileURLToPath。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/canvas/canvasPaths.js → ../../skills/nice-aos-canvas-skill/assets
const ASSETS_DIR = path.resolve(__dirname, '..', '..', 'skills', 'nice-aos-canvas-skill', 'assets');

export const CANVAS_TEMPLATES = {
  deploy: path.join(ASSETS_DIR, 'deploy-canvas-template.html'),
  overview: path.join(ASSETS_DIR, 'overview-canvas-template.html'),
};

/**
 * 读取模板文件；文件不存在时给出可定位的错误。
 * @param {keyof typeof CANVAS_TEMPLATES} kind
 * @returns {string} 模板内容
 */
export function readCanvasTemplate(kind) {
  const p = CANVAS_TEMPLATES[kind];
  if (!p) throw new Error(`未知画布类型: ${kind}（支持 deploy / overview）`);
  if (!fs.existsSync(p)) {
    throw new Error(
      `画布模板缺失: ${p}\n` +
      `提示：模板随 nice-aos 包一起发布，若文件不存在通常是安装包不完整，请重装 nice-aos。`,
    );
  }
  return fs.readFileSync(p, 'utf-8');
}

export const CANVAS_DATA_PLACEHOLDER = '__CANVAS_DATA_JSON__';

/**
 * 把画布数据 JSON 注入模板的占位符。
 * JSON 字符串用 JSON.stringify 双保险转义，模板里的占位符应是一个纯文本 token
 * （不能是 HTML 注释、不能被模板转义），保证替换后浏览器能直接 JSON.parse。
 */
export function injectCanvasData(templateHtml, data) {
  const json = JSON.stringify(data);
  // 转义 JSON 字符串中可能出现的特殊序列，避免破坏 </script> 边界
  // （前端 JSON.parse 不需要这个，但为了更稳我们用单引号包外 + JSON.stringify）
  const safeJson = json.replace(/<\/script/gi, '<\\/script');
  if (!templateHtml.includes(CANVAS_DATA_PLACEHOLDER)) {
    throw new Error(
      `画布模板未找到占位符 ${CANVAS_DATA_PLACEHOLDER}，无法注入数据。\n` +
      `请确认模板内 <script id="canvas-data" type="application/json"> 后接的是 ${CANVAS_DATA_PLACEHOLDER} token。`,
    );
  }
  return templateHtml.replace(CANVAS_DATA_PLACEHOLDER, safeJson);
}
