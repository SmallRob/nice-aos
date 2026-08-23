// 炫彩评分圆环（SVG 能量环）：健康审计的视觉锚点。
// 参考实现：steam-family-analysis v2.10「家庭组健康分」能量环——
// 渐变弧（from → 插值色 → to）+ 发光滤镜 + 大字号分数 + 加载动画。
// 主题感知：客户端读取 <html data-theme>，按 RING_STYLES 取该主题的渐变端点/轨道/辉光/弱文本色。

export const RING_STYLES = {
  'deep-blue': {
    from: '#a78bfa', to: '#4ade80',
    track: 'rgba(255,255,255,0.07)', dim: '#8b949e',
  },
  'fresh-green': {
    from: '#a7f3d0', to: '#059669',
    track: 'rgba(22,101,52,0.10)', dim: '#56705f', light: true,
  },
  'elegant-purple': {
    from: '#c084fc', to: '#f0abfc',
    track: 'rgba(255,255,255,0.07)', dim: '#a79ecf',
  },
};

const RING_FN = [
  'function ringHexToRgb(hex) {',
  '  var h = String(hex).replace("#", "");',
  '  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];',
  '}',
  'var ringUid = 0;',
  'function scoreRingSvg(score, opts) {',
  '  opts = opts || {};',
  '  var size = opts.size || 150, stroke = opts.stroke || 11;',
  '  var theme = document.documentElement.getAttribute("data-theme") || "deep-blue";',
  '  var conf = RING_STYLES[theme] || RING_STYLES["deep-blue"];',
  '  var pct = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));',
  '  var fr = ringHexToRgb(conf.from), tr = ringHexToRgb(conf.to);',
  '  var rr = Math.round(fr[0] + (tr[0] - fr[0]) * pct / 100);',
  '  var rg = Math.round(fr[1] + (tr[1] - fr[1]) * pct / 100);',
  '  var rb = Math.round(fr[2] + (tr[2] - fr[2]) * pct / 100);',
  '  var scoreColor = "rgb(" + rr + "," + rg + "," + rb + ")";',
  // 浅色主题下低分插值色过浅（白底对比不足），数字直接用深色端点；暗色主题插值色天然可读
  '  var textColor = conf.light ? conf.to : scoreColor;',
  '  var R = (size - stroke) / 2, cx = size / 2, cy = size / 2;',
  '  var C = 2 * Math.PI * R;',
  '  var off = (C * (1 - pct / 100)).toFixed(2);',
  '  var uid = "ring" + (++ringUid);',
  '  var svg = \'<svg class="score-ring-svg" width="\' + size + \'" height="\' + size + \'" viewBox="0 0 \' + size + \' \' + size + \'" role="img" aria-label="\\u5065\\u5eb7\\u8bc4\\u5206 \' + pct + \'">\'',
  '    + \'<defs>\'',
  '    + \'<linearGradient id="\' + uid + \'Grad" x1="0%" y1="100%" x2="100%" y2="0%">\'',
  '    + \'<stop offset="0%" stop-color="\' + conf.from + \'"/>\'',
  '    + \'<stop offset="\' + Math.max(8, pct) + \'%" stop-color="\' + scoreColor + \'"/>\'',
  '    + \'<stop offset="100%" stop-color="\' + conf.to + \'"/>\'',
  '    + \'</linearGradient>\'',
  '    + \'<filter id="\' + uid + \'Glow" x="-60%" y="-60%" width="220%" height="220%">\'',
  '    + \'<feGaussianBlur stdDeviation="3.5" result="blur"/>\'',
  '    + \'<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>\'',
  '    + \'</filter>\'',
  '    + \'</defs>\'',
  // 底轨
  '    + \'<circle cx="\' + cx + \'" cy="\' + cy + \'" r="\' + R + \'" fill="none" stroke="\' + conf.track + \'" stroke-width="\' + stroke + \'"/>\'',
  // 能量弧：-90° 从顶部起，圆头端点，渐变描边 + 辉光；初始 dashoffset=周长，动画过渡到目标
  '    + \'<circle class="score-arc" data-off="\' + off + \'" cx="\' + cx + \'" cy="\' + cy + \'" r="\' + R + \'" fill="none" stroke="url(#\' + uid + \'Grad)" stroke-width="\' + stroke + \'" stroke-linecap="round" stroke-dasharray="\' + C.toFixed(2) + \'" stroke-dashoffset="\' + C.toFixed(2) + \'" transform="rotate(-90 \' + cx + \' \' + cy + \')" filter="url(#\' + uid + \'Glow)"/>\'',
  // 中心分数与标签
  '    + \'<text x="\' + cx + \'" y="\' + (cy - size * 0.03) + \'" text-anchor="middle" dominant-baseline="middle" fill="\' + textColor + \'" font-size="\' + Math.round(size * 0.24) + \'" font-weight="700" font-variant-numeric="tabular-nums">\' + pct + \'</text>\'',
  '    + \'<text x="\' + cx + \'" y="\' + (cy + size * 0.17) + \'" text-anchor="middle" dominant-baseline="middle" fill="\' + conf.dim + \'" font-size="\' + Math.max(10, Math.round(size * 0.075)) + \'" font-weight="500">\' + (opts.label || "\\u5065\\u5eb7\\u5206") + \'</text>\'',
  '    + \'</svg>\';',
  // 下一帧触发弧长动画（仅一次，幂等）
  '  requestAnimationFrame(function() { requestAnimationFrame(function() {',
  '    document.querySelectorAll("circle.score-arc[data-off]:not([data-animated])").forEach(function(el) {',
  '      el.setAttribute("data-animated", "1");',
  '      el.style.strokeDashoffset = el.getAttribute("data-off");',
  '    });',
  '  }); });',
  '  return svg;',
  '}',
].join('\n');

// 嵌入查看器 <script> 的客户端代码（配置 + 函数），在健康审计渲染前注入
export const RING_JS = 'var RING_STYLES = ' + JSON.stringify(RING_STYLES) + ';\n' + RING_FN;
