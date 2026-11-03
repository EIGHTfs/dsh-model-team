// rate.js —— 模型团队速率计算（唯一实现，ui 预览与插件客户端共用）。
//
// 计算规则（真机踩过，别再改回 total/latency）：
//   1) 速率 = 输出 token / 耗时（生成速度），优先用后端字段 completionTokens + latencySeconds
//   2) 只有两者都是有效数字且 latencySeconds > 0 才算：completionTokens / latencySeconds
//   3) 禁止用 row.tokens（total，含输入）或 row.latency 字符串兜底：长上下文下 total 里 99% 是
//      promptTokens，40.3k / 4.56s 会算出 8837 tok/s，而真实生成速度只有 83 tok/s
//   4) 取不到 → null，展示层 formatRate(null) 输出 "—"
//
// 纯函数、零依赖、不碰 DOM；UMD 挂到全局，Node 里也能直接加载测试。
(function (root) {
  'use strict';

  // 解析 "40.3k" / "1.2M" / 数字；"—"/空/非法 → null（仅供展示与兼容，不参与速率）
  function parseTokenCount(text) {
    if (typeof text === 'number') return isFinite(text) ? text : null;
    const match = /^\s*([\d.]+)\s*([kKmM]?)\s*$/.exec(String(text == null ? '' : text));
    if (!match) return null;
    const value = parseFloat(match[1]);
    if (!isFinite(value)) return null;
    const unit = match[2].toLowerCase();
    if (unit === 'k') return value * 1000;
    if (unit === 'm') return value * 1000000;
    return value;
  }

  // 解析 "4.56s" / 数字秒；"—"/空/非法 → null
  function parseLatencySeconds(text) {
    if (typeof text === 'number') return isFinite(text) ? text : null;
    const match = /^\s*([\d.]+)\s*s\s*$/.exec(String(text == null ? '' : text));
    if (!match) return null;
    const value = parseFloat(match[1]);
    return isFinite(value) ? value : null;
  }

  // 单行的生成速率（tok/s）：只用 completionTokens + latencySeconds，拿不到返回 null
  // 注意用宽松比较 != null：历史行可能没有这两个字段（undefined），也可能显式是 null，两者都要跳过
  function computeGenerationRate(row) {
    if (!row || typeof row !== 'object') return null;
    const completionTokens = row.completionTokens;
    const latencySeconds = row.latencySeconds;
    if (completionTokens == null || latencySeconds == null) return null;
    if (typeof completionTokens !== 'number' || typeof latencySeconds !== 'number') return null;
    if (!isFinite(completionTokens) || !isFinite(latencySeconds) || latencySeconds <= 0) return null;
    return completionTokens / latencySeconds;
  }

  // 展示格式：<100 保留 1 位小数；>=100 取整；>=1000 用 k；无效 → "—"
  function formatRate(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '—';
    if (value >= 1000) return (value / 1000).toFixed(1) + 'k';
    if (value >= 100) return String(Math.round(value));
    return value.toFixed(1);
  }

  root.ModelTeamRate = {
    parseTokenCount: parseTokenCount,
    parseLatencySeconds: parseLatencySeconds,
    computeGenerationRate: computeGenerationRate,
    formatRate: formatRate
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
