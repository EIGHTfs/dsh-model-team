// utils.js —— 插件侧的小工具：数字格式化与一次性告警（DOM/转义/提示由 ui 分片自带，避免重复声明）。
function formatTokenCount(totalTokens) {
  if (typeof totalTokens !== "number" || !isFinite(totalTokens) || totalTokens <= 0) return "0";
  if (totalTokens >= 1000000) return (totalTokens / 1000000).toFixed(1) + "M";
  if (totalTokens >= 1000) return (totalTokens / 1000).toFixed(1) + "k";
  return String(totalTokens);
}

// 同一类故障只告警一次，避免刷新时刷屏
var WARNED = {};
function warnOnce(label, error) {
  if (WARNED[label]) return;
  WARNED[label] = true;
  if (typeof console === "undefined" || typeof console.warn !== "function") return;
  console.warn("[" + LOG_PREFIX + "] " + label + " disabled: " + (error && error.message ? error.message : String(error)));
}
