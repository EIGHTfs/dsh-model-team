// utils.js —— 插件侧的小工具：数字格式化与一次性告警（DOM/转义/提示由 ui 分片自带，避免重复声明）。

// 数字量级换算：1000 = 千，1000000 = 百万。名字带单位，避免读代码时把阈值当业务参数
var TOKEN_COUNT_PER_THOUSAND = 1000;
var TOKEN_COUNT_PER_MILLION = 1000000;

function formatTokenCount(totalTokens) {
  if (typeof totalTokens !== "number" || !isFinite(totalTokens) || totalTokens <= 0) return "0";
  if (totalTokens >= TOKEN_COUNT_PER_MILLION) return (totalTokens / TOKEN_COUNT_PER_MILLION).toFixed(1) + "M";
  if (totalTokens >= TOKEN_COUNT_PER_THOUSAND) return (totalTokens / TOKEN_COUNT_PER_THOUSAND).toFixed(1) + "k";
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
