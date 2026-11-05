// 发请求前的上下文超限检查（契约 02 §5.4 `contextGuard.enabled`）。
//
// 为什么需要：申报给 dsh 的窗口是**所有模型的最小值**（安全下界），真正发请求时目标可能是更大的模型；
// 反过来，切到小窗口模型时 dsh 仍按虚拟模型申报值算压缩阈值，可能放过一个必然被上游拒绝的请求。
// 所以发请求前用「本次消息估算 + 上次成功请求的 prompt_tokens」做一次显式判断，只拦**明确超了**的。
//
// 为什么估算要保守（宁可漏报不可误报）：消息 → token 的比例随语言/代码/工具调用差异极大，
// 估算偏大就会把能跑的请求拦下来，那比上游自己报错更糟（上游报错至少是准确信息）。
// 因此这里只在「估算值 > 窗口」时拒绝，等于窗口放行，未知窗口直接放行。

/** 每 token 平均字符数的保守估计：中文约 1.5、英文约 4，取 3 作为折中（偏大 → 估算偏保守） */
export const CHARS_PER_TOKEN = 3;
/** 每条消息的结构开销（role/分隔符等），对齐主流 chat 模板的量级 */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/** 开关缺省为开（契约 02 §5.4）；只有显式 false 才关闭 */
export function isContextGuardEnabled(config) {
  return config?.contextGuard?.enabled !== false;
}

/** 粗估消息 token：总字符数 / CHARS_PER_TOKEN + 每条消息固定开销 */
export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let characterCount = 0;
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === 'string') {
      characterCount += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part?.text === 'string') characterCount += part.text.length;
        else if (typeof part === 'string') characterCount += part.length;
      }
    }
    if (typeof message?.reasoning === 'string') characterCount += message.reasoning.length;
  }
  return Math.ceil(characterCount / CHARS_PER_TOKEN) + messages.length * MESSAGE_OVERHEAD_TOKENS;
}

/**
 * 判定是否超限。窗口未知（null/0/NaN）→ 不拦。
 * @param {{estimatedTokens: number, windowTokens: number|null}} input
 * @returns {{blocked: boolean, reason: string}}
 */
export function evaluateContextGuard({ estimatedTokens, windowTokens }) {
  const windowValue = typeof windowTokens === 'number' && Number.isFinite(windowTokens) ? windowTokens : 0;
  if (windowValue <= 0) return { blocked: false, reason: 'unknown-window' };
  const estimate = typeof estimatedTokens === 'number' && Number.isFinite(estimatedTokens) ? estimatedTokens : 0;
  // 刚好等于窗口放行：边界情况不拦，避免"差一个 token 就报错"的误报
  return estimate > windowValue ? { blocked: true, reason: 'over-window' } : { blocked: false, reason: 'within-window' };
}

/** 超限错误文案：四个数字都要给全，便于判断是误报还是真超了 */
export function buildContextOverflowMessage({ estimatedTokens, lastPromptTokens, windowTokens, modelId }) {
  const lastPromptText = typeof lastPromptTokens === 'number' && lastPromptTokens > 0 ? String(lastPromptTokens) : '无记录';
  return `上下文超出目标模型窗口：估算约 ${estimatedTokens} tokens（上次成功请求 prompt_tokens=${lastPromptText}），`
    + `目标模型 ${modelId} 的窗口 ${windowTokens} tokens。`
    + '请缩小上下文（清空历史/减少附件）或切换到更大窗口的模型。';
}
