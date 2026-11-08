// rate.mjs —— 生成速率计算（纯 JS、零依赖、无宿主/框架/项目耦合）。
//
// 这个文件的特点：**可以直接拷贝到别的项目用**。
// 因此这里不出现任何本项目的东西：不引用本仓文档编号、不提插件/业务名、不读环境变量、
// 不碰 DOM 与 Node API、不做 I/O。只输入普通对象，输出数字或 null。
//
// 口径：
//   1) 精确值 = 输出 token / **解码段**（首个内容分片 → 结束）：分母去掉首字等待（TTFT），
//      这才是"生成速度"
//   2) 退化值 = 输出 token / 整步耗时：拿不到首字时刻时只能这么算。它是**下界**，
//      必须返回 exact=false，由展示层自行加标记，别让下界冒充精确值
//   3) 禁止用"总 token"（含输入）当分子：长上下文下总量里绝大部分是输入，
//      会算出高两个数量级的假值
//   4) 取不到可用数据 → null（调用方决定怎么显示空值）
//
// 输入形状（调用方自己组装，本模块不校验字段来源）：
//   row.completionTokens  输出 token（number）
//   row.decodeMs          解码段耗时（毫秒，number；没记到就是 null/undefined）
//   row.latencySeconds    整步耗时（秒，number；含首字等待）

// 毫秒 → 秒：本文件里 1000 只表示这一件事
export const MS_PER_SECOND = 1000;
// 人类可读数字的后缀换算
export const TOKENS_PER_THOUSAND = 1000;
export const TOKENS_PER_MILLION = 1000000;
// 下界标记：放在展示层字符串最前面，一眼能看出"这是近似值"
export const RATE_APPROX_PREFIX = '≈';
// 无数据占位
export const RATE_EMPTY_TEXT = '—';

// 解析 "40.3k" / "1.2M" / 纯数字；空值或非法 → null
export function parseTokenCount(text) {
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

// 解析 "4.56s" / 纯数字秒；空值或非法 → null
export function parseLatencySeconds(text) {
  if (typeof text === 'number') return isFinite(text) ? text : null;
  var match = /^\s*([\d.]+)\s*s\s*$/.exec(String(text == null ? '' : text));
  if (!match) return null;
  var value = parseFloat(match[1]);
  return isFinite(value) ? value : null;
}

// 能当除数才算有效度量：0 与负数一律视为"没有数据"，避免 Infinity / 负速率
export function isUsableMeasure(value) {
  return typeof value === 'number' && isFinite(value) && value > 0;
}

// 单行生成速率：返回 { tps, exact } 或 null
export function computeGenerationRate(row) {
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

// 多行聚合：sum(输出 token) / sum(分母)，不是逐行速率的平均
// 逐行平均会让"只回 1 个 token 的短请求"和"上千 token 的长请求"同权，把整体带偏。
// 两个桶分开累加：精确桶（有解码段）优先；一条精确行都没有时才退化成整步桶。
export function aggregateGenerationRate(rows) {
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

// 数字展示：<100 保留 1 位；>=100 取整；>=1000 用 k
export function formatRate(value) {
  if (typeof value !== 'number' || !isFinite(value)) return RATE_EMPTY_TEXT;
  if (value >= 1000) return (value / 1000).toFixed(1) + 'k';
  if (value >= 100) return String(Math.round(value));
  return value.toFixed(1);
}

// 带精确/下界标记的展示串：下界前面加 ≈，精确值原样，无数据占位
export function formatRateText(result) {
  if (!result || typeof result !== 'object') return RATE_EMPTY_TEXT;
  var text = formatRate(result.tps);
  if (text === RATE_EMPTY_TEXT) return text;
  return result.exact === true ? text : RATE_APPROX_PREFIX + text;
}

// 一步到位的展示值：rows 由调用方**先按自己的口径筛好**（按模型/按群/按时间窗都行）。
// 本模块不认识"群""会话"这类概念——口径属于调用方，公式留在共享层，改口径不用改本文件。
export function estimateRateText(rows, unitSuffix) {
  var aggregate = aggregateGenerationRate(rows);
  if (!aggregate) return RATE_EMPTY_TEXT;
  var suffix = typeof unitSuffix === 'string' ? unitSuffix : '';
  return formatRateText(aggregate) + suffix;
}

// 浏览器环境（无 import）用的出口：调用方拿到对象后自行挂到全局
export function createRateApi() {
  return {
    parseTokenCount: parseTokenCount,
    parseLatencySeconds: parseLatencySeconds,
    isUsableMeasure: isUsableMeasure,
    computeGenerationRate: computeGenerationRate,
    aggregateGenerationRate: aggregateGenerationRate,
    formatRate: formatRate,
    formatRateText: formatRateText,
    estimateRateText: estimateRateText
  };
}
