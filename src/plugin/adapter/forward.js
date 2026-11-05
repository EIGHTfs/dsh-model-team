// forward 转发通道（docs/15 §一 / docs/12 §四）：把"换个 provider/model 再交回宿主"这件事收在一处。
//
// 为什么单独成文件：这条路径与 rewrite（自己转协议、自己发 HTTP）是两条完全不同的链路，
// 混在 adapter.js 里会让"哪些行为只属于 forward"（不跑图片门禁、不跑预取、不二次包装流块）变得不可读。
//
// 三条硬约束（docs/15 §二）：
//   1) 递归守卫：目标 provider 是本插件自己注册的路由 → 绝不调 llmStream（转了必然打转）
//   2) 逐块原样 yield：宿主给的就是 dsh 的 StreamChunk，再包一层就是双重包装
//   3) usage 只旁路观测：读 chunk 里的 usage 供请求行落库，不重算 token

import { isSelfProvider, resolveMode, MODE_FORWARD } from './mode.js';

// 不能转发的原因清单：调用方据此决定"直接走 rewrite"还是"抛错"
export const FORWARD_SKIP_REASONS = Object.freeze({
  // 目标 provider 就是本插件注册的路由：转发给自己会无限打转
  SELF_PROVIDER: 'self-provider',
  // 群没有声明 host provider id：不知道该把请求交给谁
  PROVIDER_MISSING: 'provider-missing',
  // 宿主没有注入 llmStream（旧宿主 / 测试环境未提供）
  LLM_STREAM_MISSING: 'llm-stream-missing',
  // 目标不是"单模型"（分组轮换要在多个群之间换成员，forward 没有这个概念）
  TARGET_NOT_SINGLE_MODEL: 'target-not-single-model',
  // 群解析不到（目标指向的群已被删）
  GROUP_MISSING: 'group-missing',
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

// 编排：解析目标 → 解析模式 → 预检 → 打开流并探首个块。
// 返回 null 表示"这次不转发"，调用方直接走 rewrite（全程只尝试一次，不重发）。
// 抛出的错误只有两种：目标解析前的业务错误（原样抛给上层分类）、以及非 NO_ADAPTER 的首次调用错误。
export async function openForwardRequest({
  options, config, sessionId, startedAtMs, providerIds, logger, deps, resolveTarget, recordRow,
}) {
  let resolution;
  try {
    resolution = await resolveTarget({ config, sessionId });
  } catch {
    // 目标解析失败交给 rewrite 路径去抛（错误码/提示文案只在那里维护一份）
    return null;
  }

  const target = resolution?.target ?? null;
  // 分组轮换要在多个群之间换成员，forward 没有这个概念：一律交给 rewrite
  if (!target || target.type !== 'model') return null;

  const group = (config?.groups ?? []).find((candidate) => candidate.id === target.platformId) ?? null;
  if (!group) return null;

  // 群配置显式 rewrite（或 mode 非法被回退、或目标 provider 是自己）→ 不转发
  if (resolveMode({ group, providerIds, logger }) !== MODE_FORWARD) return null;

  const forwardTarget = resolveForwardTarget({ group, model: target.id });
  const plan = planForward({ target: forwardTarget, providerIds, deps });
  if (!plan.ok) {
    // 只有"声明了 provider 但宿主没注入 llmStream"值得告警；没声明 provider 是当前灰度期的常态
    if (plan.reason === FORWARD_SKIP_REASONS.LLM_STREAM_MISSING && logger?.warn) {
      logger.warn('宿主未注入 llmStream，forward 不可用，本次走 rewrite');
    }
    return null;
  }

  const observation = createForwardObservation();
  const iterator = forwardStream({ options, target: forwardTarget, deps, observation })[Symbol.asyncIterator]();
  let firstResult;
  try {
    firstResult = await iterator.next();
  } catch (forwardError) {
    // 首块之前抛 NO_ADAPTER：同一次调用内降级（docs/15 §二.1）；此时一个字都没吐出去
    if (isNoAdapterError(forwardError)) {
      if (logger?.warn) {
        logger.warn(`目标 provider「${forwardTarget.provider}」在宿主没有适配器（${NO_ADAPTER_CODE}），本次改走 rewrite`);
      }
      return null;
    }
    throw forwardError;
  }

  // 已经把首块拿到手：后续块原样转出，**不再允许降级**（重发会重复输出）。
  // 请求行也在这里收口：成功记 200，中途失败记 0（与 rewrite 的失败口径一致），记完再把错误抛给上层。
  async function* drainChunksWithRow() {
    let upstreamStatus = 200;
    try {
      if (!firstResult.done) yield firstResult.value;
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        yield next.value;
      }
    } catch (streamError) {
      upstreamStatus = 0;
      await recordRow(buildForwardRowInput({
        request: { group, model: target.id, targetSource: resolution.source ?? null, observation },
        sessionId,
        startedAtMs,
        upstreamStatus,
        aborted: Boolean(options?.signal?.aborted),
      })).catch(() => {});
      throw streamError;
    }
    await recordRow(buildForwardRowInput({
      request: { group, model: target.id, targetSource: resolution.source ?? null, observation },
      sessionId,
      startedAtMs,
      upstreamStatus,
      aborted: Boolean(options?.signal?.aborted),
    })).catch(() => {});
  }

  return {
    group,
    model: target.id,
    targetSource: resolution.source ?? null,
    observation,
    chunks: drainChunksWithRow(),
  };
}

// forward 的请求行入参：字段与 rewrite 走同一个 recordRow，只是 usage 来自旁路观测。
// 放在这里而不是 adapter 里，是为了让 adapter 的分流入口保持短小（它已有 400 行门禁）。
export function buildForwardRowInput({ request, sessionId, startedAtMs, upstreamStatus, aborted }) {
  return {
    sessionId,
    targetGroup: request.group,
    targetModel: request.model,
    groupId: request.group.id,
    targetSource: request.targetSource,
    startedAtMs,
    upstreamStatus,
    usage: toRowUsage(request.observation.usage),
    requestId: null,
    aborted,
  };
}
