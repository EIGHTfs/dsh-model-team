// 上下文容量归一化（契约 02 §3.7、实现依据 07 §二点六）。
// 上游各家的字段名不统一，这里只做一件事：按冻结优先级取第一个**有效正整数**。
//   优先级：context_length → max_allowed_size → context_window.default
// 为什么要单独成文件：驱动映射（toModelEntry）与模型目录归一化（toModelOption）两处都要用，
// 各写一份必然漂移；而「容量」是被 dsh 压缩阈值与超限检查同时消费的事实，只能有一处口径。
//
// 关键约束（写死在这里，别在调用点重复判断）：
//   - 0 / 负数 / NaN / 非数字 一律视为「未知」，返回 null —— 这些值传给 dsh 会抛
//     INVALID_MODEL_CONTEXT，整轮对话起不来（不是降级，是崩）
//   - 未知就**不填**字段（UI 显示 —），绝不编造一个看起来合理的窗口

/** 探测不到任何模型窗口时的申报值（契约 02 §5.4 冻结：1048576 = 1M） */
export const DEFAULT_CONTEXT_WINDOW_FALLBACK = 1048576;

/** 任何来源的数值都先过这里：只有有限正数才算有效，其余返回 null */
export function toPositiveInteger(rawValue) {
  const numericValue = typeof rawValue === 'string' ? Number(rawValue.trim()) : rawValue;
  if (typeof numericValue !== 'number' || !Number.isFinite(numericValue)) return null;
  const integerValue = Math.floor(numericValue);
  return integerValue > 0 ? integerValue : null;
}

/** 归一化上下文窗口：按冻结优先级取第一个有效值，全缺返回 null */
export function normalizeContextLength(rawEntry) {
  if (!rawEntry || typeof rawEntry !== 'object') return null;
  const candidates = [
    rawEntry.context_length,
    rawEntry.max_allowed_size,
    rawEntry.context_window && typeof rawEntry.context_window === 'object' ? rawEntry.context_window.default : undefined,
  ];
  for (const candidate of candidates) {
    const normalized = toPositiveInteger(candidate);
    if (normalized !== null) return normalized;
  }
  return null;
}

/** 归一化输出上限（上游 max_output_tokens），缺失返回 null */
export function normalizeMaxOutputTokens(rawEntry) {
  if (!rawEntry || typeof rawEntry !== 'object') return null;
  return toPositiveInteger(rawEntry.max_output_tokens);
}

/**
 * 申报窗口（三级逐级回退，契约 02 §5.4）：
 *   ① 显式覆盖 `override`（config.contextWindow）：上游不报容量时手填真实值
 *   ② 所有**已知**模型窗口的最小值（安全下界：虚拟模型底下可能挂着任意真实模型）
 *   ③ 兜底 `fallback`（config.contextWindowFallback，缺省 1048576）
 * 非法覆盖值在这里只做「视为未设置」（继续往下走）；要不要告警由调用方决定，保持本函数纯粹。
 * @param {{knownWindows?: Array<number|null|undefined>, fallback?: number|string, override?: number|string}} [input]
 * @returns {number} 一定是正数（最差返回 DEFAULT_CONTEXT_WINDOW_FALLBACK）
 */
export function pickDeclaredContextWindow({ knownWindows = [], fallback, override } = {}) {
  const overrideWindow = toPositiveInteger(override);
  if (overrideWindow !== null) return overrideWindow;

  const validWindows = [];
  for (const candidate of knownWindows) {
    const normalized = toPositiveInteger(candidate);
    if (normalized !== null) validWindows.push(normalized);
  }
  if (validWindows.length > 0) return Math.min(...validWindows);

  const fallbackWindow = toPositiveInteger(fallback);
  return fallbackWindow === null ? DEFAULT_CONTEXT_WINDOW_FALLBACK : fallbackWindow;
}

/**
 * 从群配置里收集已知窗口：只认 models.static[]（endpoint 型群的模型清单不在配置里）。
 * @param {object} config
 * @returns {number[]}
 */
export function collectConfiguredContextWindows(config) {
  const groups = Array.isArray(config?.groups) ? config.groups : [];
  const windows = [];
  for (const group of groups) {
    const staticModels = group?.models?.static;
    if (!Array.isArray(staticModels)) continue;
    for (const modelEntry of staticModels) {
      const contextLength = toPositiveInteger(modelEntry?.contextLength);
      if (contextLength !== null) windows.push(contextLength);
    }
  }
  return windows;
}
