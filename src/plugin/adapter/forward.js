// forward 转发通道（docs/15 §一 / docs/12 §四）：把"换个 provider/model 再交回宿主"这件事收在一处。
//
// 为什么单独成文件：这条路径与 rewrite（自己转协议、自己发 HTTP）是两条完全不同的链路，
// 混在 adapter.js 里会让"哪些行为只属于 forward"（不跑图片门禁、不跑预取、不二次包装流块）变得不可读。
//
// 三条硬约束（docs/15 §二）：
//   1) 递归守卫：目标 provider 是本插件自己注册的路由 → 绝不调 llmStream（转了必然打转）
//   2) 逐块原样 yield：宿主给的就是 dsh 的 StreamChunk，再包一层就是双重包装
//   3) usage 只旁路观测：读 chunk 里的 usage 供请求行落库，不重算 token

import { isSelfProvider } from './mode.js';

// 不能转发的三种原因：调用方据此决定"直接走 rewrite"还是"抛错"
export const FORWARD_SKIP_REASONS = Object.freeze({
  // 目标 provider 就是本插件注册的路由：转发给自己会无限打转
  SELF_PROVIDER: 'self-provider',
  // 群没有声明 host provider id：不知道该把请求交给谁
  PROVIDER_MISSING: 'provider-missing',
  // 宿主没有注入 llmStream（旧宿主 / 测试环境未提供）
  LLM_STREAM_MISSING: 'llm-stream-missing',
});

// 宿主"目标协议没有适配器"的错误码（packages/llm/llm 的 registration() 抛的就是它）
export const NO_ADAPTER_CODE = 'NO_ADAPTER';

// 目标描述：forward 只需要 provider + model 两个字段，其余 options 原样透传
export function resolveForwardTarget({ group, model }) {
  const providerValue = typeof group?.provider === 'string' ? group.provider.trim() : '';
  return {
    provider: providerValue,
    model: typeof model === 'string' ? model : '',
  };
}

// 预检（纯函数、不发请求）：答案只可能是"能转发"或"为什么不能"
export function planForward({ target, providerIds, deps }) {
  if (!target || typeof target.provider !== 'string' || target.provider.length === 0) {
    return { ok: false, reason: FORWARD_SKIP_REASONS.PROVIDER_MISSING };
  }
  if (isSelfProvider(target.provider, providerIds)) {
    return { ok: false, reason: FORWARD_SKIP_REASONS.SELF_PROVIDER };
  }
  if (typeof deps?.llmStream !== 'function') {
    return { ok: false, reason: FORWARD_SKIP_REASONS.LLM_STREAM_MISSING };
  }
  return { ok: true };
}

// 旁路观测容器：forward 不改写块，只在这里累计"请求行要的几项"
export function createForwardObservation() {
  return { usage: null, finishReason: null, chunkCount: 0 };
}

// 观测单个块：只读不改（块本身原样交给调用方）
export function observeForwardChunk(observation, chunk) {
  if (!observation || !chunk) return;
  observation.chunkCount += 1;
  if (chunk.type === 'usage' && chunk.usage) {
    observation.usage = chunk.usage;
  }
  if (chunk.type === 'finish' && chunk.reason) {
    observation.finishReason = chunk.reason;
  }
}

// 宿主 TokenUsage（inputTokens / outputTokens）→ 本项目请求行口径（promptTokens / completionTokens）
// 只做字段改名与缺失兜底，**不做**任何重算：没有 totalTokens 时才用加减补出来。
export function toRowUsage(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== 'object') return null;
  const promptTokens = typeof tokenUsage.inputTokens === 'number' ? tokenUsage.inputTokens : null;
  const completionTokens = typeof tokenUsage.outputTokens === 'number' ? tokenUsage.outputTokens : null;
  const explicitTotal = typeof tokenUsage.totalTokens === 'number' ? tokenUsage.totalTokens : null;
  const totalTokens = explicitTotal
    ?? (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
  const rowUsage = { promptTokens, completionTokens, totalTokens };
  if (typeof tokenUsage.cacheReadTokens === 'number') {
    rowUsage.cacheHit = tokenUsage.cacheReadTokens;
  }
  return rowUsage;
}

// 首块之前抛出 NO_ADAPTER 才允许降级；已吐过块再降级会重复输出（docs/15 §二.1）
export function isNoAdapterError(error) {
  return Boolean(error) && error.code === NO_ADAPTER_CODE;
}

// 转发：交给宿主，逐块原样 yield。
// 注意这里**不**捕获异常——降级判定必须发生在"首个 chunk 之前"，
// 只有调用方掌握"已经吐过几个块"，所以由调用方驱动迭代器并决定是否降级。
export async function* forwardStream({ options, target, deps, observation }) {
  const stream = await deps.llmStream({ ...options, provider: target.provider, model: target.model });
  for await (const chunk of stream) {
    observeForwardChunk(observation, chunk);
    yield chunk;
  }
}
