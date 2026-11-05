// rate.js —— 模型团队速率计算（唯一实现，ui 预览与插件客户端共用）。
//
// 口径（与解码段公式对齐，docs/02 §5.1，别再改回 total/latency）：
//   1) 精确值 = 输出 token / **解码段**（首字 → 结束）：分母去掉首字等待（TTFT），
//      这才是"生成速度"；整步耗时里首字等待可能占一大半，长思考模型会被严重低估
//   2) 退化值 = 输出 token / 整步耗时：拿不到首字时刻时只能这么算，它是**下界**，
//      所以必须返回 exact=false，展示层加 ≈，别让下界冒充精确值
//   3) 禁止用 row.tokens（total，含输入）或 row.latency 字符串兜底：长上下文下 total 里 99% 是
//      promptTokens，40.3k / 4.56s 会算出 8837 tok/s，而真实生成速度只有 83 tok/s
//   4) 取不到 → null，展示层 formatRateText(null) 输出 "—"
//
// 纯函数、零依赖、不碰 DOM。这里刻意不写 IIFE 包装：本文件是"按顺序拼接的大脚本"里的一个片段，
// 与 store/float 那些分片一样用顶层函数，再在文件末尾挂一次全局；包一层会让"整个文件"被当成
// 一个上百行的函数（代码行门禁会拦），也让调试栈里多一层无意义的匿名调用。

// 毫秒 → 秒：本文件里出现的 1000 只有这一个含义，集中成常量避免各处裸写
var MS_PER_SECOND = 1000;
// token 后缀换算（parseTokenCount 的 k / m 分支）：1000 = 千，1000000 = 百万
var TOKENS_PER_THOUSAND = 1000;
var TOKENS_PER_MILLION = 1000000;
// 近似值前缀：一眼能看出"这个数字是下界"，不用点开 tooltip
var RATE_APPROX_PREFIX = '≈';
// 缺值占位：与全仓一致用破折号
var RATE_EMPTY_TEXT = '—';

// 解析 "40.3k" / "1.2M" / 数字；"—"/空/非法 → null（仅供展示与兼容，不参与速率）
function parseTokenCount(text) {
  if (typeof text === 'number') return isFinite(text) ? text : null;
  var match = /^\s*([\d.]+)\s*([kKmM]?)\s*$/.exec(String(text == null ? '' : text));
  if (!match) return null;
  var value = parseFloat(match[1]);
  if (!isFinite(value)) return null;
  var unit = match[2].toLowerCase();
  if (unit === 'k') return value * TOKENS_PER_THOUSAND;
  if (unit === 'm') return value * TOKENS_PER_MILLION;
  return value;
}

// 解析 "4.56s" / 数字秒；"—"/空/非法 → null
function parseLatencySeconds(text) {
  if (typeof text === 'number') return isFinite(text) ? text : null;
  var match = /^\s*([\d.]+)\s*s\s*$/.exec(String(text == null ? '' : text));
  if (!match) return null;
  var value = parseFloat(match[1]);
  return isFinite(value) ? value : null;
}

// 只有"能做除数"的数字才算有效分母：0 与负数一律视为没有数据，避免算出 Infinity / 负速率
function isUsableMeasure(value) {
  return typeof value === 'number' && isFinite(value) && value > 0;
}

// 单行的生成速率：返回 { tps, exact } 或 null。
// exact=true 只有一种来路——本行记录了首字时刻（decodeMs 可用），分母是解码段；
// 退化到整步耗时一律 exact=false，让展示层能标 ≈。
// 注意用宽松比较：历史行没有这些字段（undefined）与显式 null 都要跳过。
function computeGenerationRate(row) {
  if (!row || typeof row !== 'object') return null;
  var completionTokens = row.completionTokens;
  if (!isUsableMeasure(completionTokens)) return null;

  if (isUsableMeasure(row.decodeMs)) {
    return { tps: completionTokens / (row.decodeMs / MS_PER_SECOND), exact: true };
  }
  if (isUsableMeasure(row.latencySeconds)) {
    return { tps: completionTokens / row.latencySeconds, exact: false };
  }
  return null;
}

// 会话级聚合：sum(输出 token) / sum(分母)，不是逐行速率的平均——
// 平均会让"只有 1 个 token 的短请求"和"上千 token 的长请求"同权，长回复被短回复带偏。
// 两个桶分别累加：精确桶（有解码段）优先；一条精确行都没有时才退化成整步桶。
function aggregateGenerationRate(rows) {
  if (!rows || typeof rows.length !== 'number' || rows.length === 0) return null;

  var exactTokens = 0;
  var exactDecodeMs = 0;
  var spanTokens = 0;
  var spanSeconds = 0;

  for (var index = 0; index < rows.length; index += 1) {
    var row = rows[index];
    if (!row || typeof row !== 'object') continue;
    var completionTokens = row.completionTokens;
    if (!isUsableMeasure(completionTokens)) continue;

    if (isUsableMeasure(row.decodeMs)) {
      exactTokens += completionTokens;
      exactDecodeMs += row.decodeMs;
    } else if (isUsableMeasure(row.latencySeconds)) {
      spanTokens += completionTokens;
      spanSeconds += row.latencySeconds;
    }
  }

  if (exactDecodeMs > 0 && exactTokens > 0) {
    return { tps: exactTokens / (exactDecodeMs / MS_PER_SECOND), exact: true };
  }
  if (spanSeconds > 0 && spanTokens > 0) {
    return { tps: spanTokens / spanSeconds, exact: false };
  }
  return null;
}

// 展示格式：<100 保留 1 位小数；>=100 取整；>=1000 用 k；无效 → "—"
function formatRate(value) {
  if (typeof value !== 'number' || !isFinite(value)) return RATE_EMPTY_TEXT;
  if (value >= 1000) return (value / 1000).toFixed(1) + 'k';
  if (value >= 100) return String(Math.round(value));
  return value.toFixed(1);
}

// 带"精确/下界"标记的展示串：退化值前面加 ≈，精确值原样，无数据 "—"。
// 前缀放在这里而不是 formatRate 里：formatRate 只管数字形态，标记是口径问题，两者别混。
function formatRateText(result) {
  if (!result || typeof result !== 'object') return RATE_EMPTY_TEXT;
  var text = formatRate(result.tps);
  if (text === RATE_EMPTY_TEXT) return text;
  return result.exact === true ? text : RATE_APPROX_PREFIX + text;
}

// 对外出口：api.js / 测试都通过这个名字取函数（预览页与打包产物都靠它）
var ModelTeamRate = {
  parseTokenCount: parseTokenCount,
  parseLatencySeconds: parseLatencySeconds,
  computeGenerationRate: computeGenerationRate,
  aggregateGenerationRate: aggregateGenerationRate,
  formatRate: formatRate,
  formatRateText: formatRateText
};

if (typeof globalThis !== 'undefined') {
  globalThis.ModelTeamRate = ModelTeamRate;
}
