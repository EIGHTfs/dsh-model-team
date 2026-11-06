// forward 转发通道（docs/15 §一/§二）：把"协议转换交给官方库"这件事收在一处。
//
// 为什么是「官方库直调」而不是 `ctx.llm.stream`：
//   1) 那条入口按 options.provider 路由，route 归注册者；转发给 dsh-model-team 等于调回自己（递归）
//   2) GenerateOptions 没有 request 字段，不存在 per-call 端点/凭据覆盖 —— 借别人的 route 就必然用别人的 key
// 所以这里直接实例化官方 `PiAiAdapter`，端点与凭据都来自群自己的配置。
//
// 三条硬约束：
//   1) profile 一律由官方 `resolveProfiles` 生成（**不手写** ResolvedPiAiProviderProfile，否则宿主升级必炸）
//   2) 逐块原样 yield：宿主给的就是 dsh 的 StreamChunk，再包一层就是双重包装
//   3) usage 只旁路观测：读 chunk 里的 usage 供请求行落库，不重算 token

import { describeFailure } from '../../gateway/logger.js';
import { capMaxTokens } from '../../gateway/config/limits.js';
import { MODE_FORWARD, resolveMode } from './mode.js';

// 官方包的两个 specifier：一个是 dsh 适配器实现，一个是它底下的 pi-ai 核心（凭据存储从这里取）
const PI_AI_DSH_SPECIFIER = '@deepseek-ai/dsh-llm-pi-ai';
const PI_AI_CORE_SPECIFIER = '@earendil-works/pi-ai';

// 群里只有 OpenAI 兼容这一个协议（driver 也是它）；换别的协议要先扩 driver，这里不猜
export const FORWARD_PROTOCOL = 'openai-completions';

// 不能转发的原因清单：调用方据此决定"直接走 rewrite"还是"抛错"
export const FORWARD_SKIP_REASONS = Object.freeze({
  // 目标不是"单模型"（分组轮换要在多群之间换成员，forward 没有这个概念）
  TARGET_NOT_SINGLE_MODEL: 'target-not-single-model',
  // 群解析不到（目标指向的群已被删）
  GROUP_MISSING: 'group-missing',
  // 群没配 baseURL / 凭据（属于配置错误，交给 rewrite 路径按既有错误码报）
  BASE_URL_MISSING: 'base-url-missing',
  CREDENTIAL_MISSING: 'credential-missing',
  // 官方包不可用：import 失败，或宿主版本没有导出 resolveProfiles
  RUNTIME_IMPORT_FAILED: 'runtime-import-failed',
  RUNTIME_INCOMPLETE: 'runtime-incomplete',
});

// 探测结果缓存：官方包 import 一次就够（失败也缓存，避免每个请求重试 + 刷屏）
let runtimePromise = null;
// 不可用只 warn 一次：配置不变的部署里，每请求一条日志等于把日志淹掉
let runtimeWarningEmitted = false;

// 默认导入器：测试注入假模块时换成自己的实现
function defaultImporter(specifier) {
  return import(specifier);
}

// 探测官方包是否可用（结果缓存，重复调用拿同一个 promise）
export function loadPiAiRuntime({ importer = defaultImporter } = {}) {
  if (!runtimePromise) {
    runtimePromise = probePiAiRuntime(importer);
  }
  return runtimePromise;
}

// 只给测试用：清掉缓存，让下一个用例从"没探过"开始
export function resetPiAiRuntimeCacheForTest() {
  runtimePromise = null;
  runtimeWarningEmitted = false;
}

async function probePiAiRuntime(importer) {
  let dshPiAi;
  try {
    dshPiAi = await importer(PI_AI_DSH_SPECIFIER);
  } catch (error) {
    return { ok: false, reason: FORWARD_SKIP_REASONS.RUNTIME_IMPORT_FAILED, error };
  }
  // 宿主没补 resolveProfiles 的版本会走到这里：不报错，只判定"不可用"，由调用方降级 rewrite
  if (typeof dshPiAi?.PiAiAdapter !== 'function' || typeof dshPiAi?.resolveProfiles !== 'function') {
    return { ok: false, reason: FORWARD_SKIP_REASONS.RUNTIME_INCOMPLETE };
  }
  let piAi;
  try {
    piAi = await importer(PI_AI_CORE_SPECIFIER);
  } catch (error) {
    return { ok: false, reason: FORWARD_SKIP_REASONS.RUNTIME_IMPORT_FAILED, error };
  }
  if (typeof piAi?.InMemoryCredentialStore !== 'function') {
    return { ok: false, reason: FORWARD_SKIP_REASONS.RUNTIME_INCOMPLETE };
  }
  return { ok: true, dshPiAi, piAi };
}

// 官方不可用时只告警一次（含原因原文，便于定位是没装还是宿主版本没导出）
export function warnRuntimeUnavailableOnce({ runtime, logger }) {
  if (runtimeWarningEmitted || typeof logger?.warn !== 'function') return;
  runtimeWarningEmitted = true;
  const detail = runtime.error ? `：${describeFailure(runtime.error)}` : '';
  logger.warn(`官方 pi-ai 适配器不可用（${runtime.reason}${detail}），forward 群本次改走 rewrite`);
}

// 群配置 → 官方 resolveProfiles 的**原始入参**（形状：{ [群id]: { api, baseURL, models } }）
// 注意：入参必须是没有经过 Config() 解析的普通对象；把解析结果传进去只会得到 {"get": ...} 这种假键。
export function buildRawProviders({ group, model }) {
  return {
    [group.id]: {
      api: FORWARD_PROTOCOL,
      baseURL: group.baseURL,
      models: [{ id: model }],
    },
  };
}

// 用官方库构造一次请求的适配器：端点 = 群 baseURL，凭据 = 群自己的 apiKey
export function createForwardAdapter({ runtime, group, model, apiKey }) {
  const profiles = runtime.dshPiAi.resolveProfiles(buildRawProviders({ group, model }), 'deferred');
  return new runtime.dshPiAi.PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => apiKey,
    auth: { credentials: new runtime.piAi.InMemoryCredentialStore() },
  });
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

// forward 的请求行入参：字段与 rewrite 走同一个 recordRow，只是 usage 来自旁路观测
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

// 编排：解析目标 → 解析模式 → 探测官方包 → 取群凭据 → 构造适配器 → 打开流并探首个块。
// 返回 null 表示"这次不转发"，调用方直接走 rewrite（全程只尝试一次，不重发）。
export async function openForwardRequest({
  options,
  config,
  sessionId,
  startedAtMs,
  logger,
  deps,
  resolveTarget,
  resolveCredential,
  runtime,
  limitsStore,
  recordRow,
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
  if (resolveMode({ group, logger }) !== MODE_FORWARD) return null;
  // baseURL/凭据缺失属于配置错误：不进 forward，让 rewrite 路径按既有错误码报（INVALID_BASE_URL / MISSING_CREDENTIAL）
  if (typeof group.baseURL !== 'string' || group.baseURL.trim().length === 0) return null;

  const runtimeInfo = runtime ?? await loadPiAiRuntime({ importer: deps?.importer });
  if (!runtimeInfo.ok) {
    warnRuntimeUnavailableOnce({ runtime: runtimeInfo, logger });
    return null;
  }

  const credential = await resolveCredential(group);
  if (!credential?.ok) return null;

  let adapter;
  try {
    adapter = createForwardAdapter({
      runtime: runtimeInfo,
      group,
      model: target.id,
      apiKey: credential.credentials.apiKey,
    });
  } catch (buildError) {
    // 构造失败（profile 解析不出、schema 不认）→ 同一次调用内降级，warn 含原文
    if (logger?.warn) logger.warn(`forward 适配器构造失败，本次改走 rewrite：${describeFailure(buildError)}`);
    return null;
  }

  // 官方适配器层夹不到 max_tokens（它只认 options），所以在这里发请求前就夹一次：
  // 群配置 request.maxTokens > 学到的上限 > 宿主给的原值
  const learnedLimit = limitsStore ? await limitsStore.getLimit(group.id, target.id) : null;
  const capped = capMaxTokens({
    requested: options?.maxTokens,
    configured: group.request?.maxTokens,
    learned: learnedLimit,
  });

  const observation = createForwardObservation();
  const iterator = adapter.stream({ ...options, maxTokens: capped.maxTokens, provider: group.id, model: target.id })[Symbol.asyncIterator]();
  let firstResult;
  try {
    firstResult = await iterator.next();
  } catch (firstError) {
    // 首块之前抛错：一个字都没吐出去，允许同一次调用内降级（docs/15 §三）
    if (logger?.warn) logger.warn(`forward 首块前失败，本次改走 rewrite：${describeFailure(firstError)}`);
    return null;
  }

  // 已经把首块拿到手：后续块原样转出，**不再允许降级**（重发会重复输出）。
  // 请求行也在这里收口：成功记 200，中途失败记 0，记完再把错误抛给上层。
  async function* drainChunksWithRow() {
    let upstreamStatus = 200;
    const rowRequest = { group, model: target.id, targetSource: resolution.source ?? null, observation };
    try {
      if (!firstResult.done) {
        observeForwardChunk(observation, firstResult.value);   // 旁路观测：只读 usage/finish，不改块
        yield firstResult.value;
      }
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        observeForwardChunk(observation, next.value);
        yield next.value;
      }
    } catch (streamError) {
      upstreamStatus = 0;
      await recordRow(buildForwardRowInput({
        request: rowRequest, sessionId, startedAtMs, upstreamStatus,
        aborted: Boolean(options?.signal?.aborted),
      })).catch(() => {});
      throw streamError;
    }
    await recordRow(buildForwardRowInput({
      request: rowRequest, sessionId, startedAtMs, upstreamStatus,
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
