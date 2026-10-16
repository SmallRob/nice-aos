// 五份自包含蓝图共用的文档壳（代码 / 数据库 / 部署 / 服务 / 规划）。
// css 与 body 由各 viewer 原样传入：换行与原先手写模板一致，只去掉重复的 doctype / head 骨架。

export function htmlShell({ theme, title, css, body }) {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
${css}
</style>
</head>
<body>
${body}
</body>
</html>`;
}
