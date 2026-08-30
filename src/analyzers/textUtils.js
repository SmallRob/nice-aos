// 分析器共享文本工具：行号计算（computeLineStarts/lineAt 原为
// dart/go/kotlin/python/rust 五个分析器逐字重复的副本，收敛于此）。

export function computeLineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) {
    if (src.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

export function lineAt(lineStarts, pos) {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}
