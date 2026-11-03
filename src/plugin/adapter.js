// dsh LlmAdapter 工厂：把"会话级模型路由"接进 dsh 的进程内模型调用链（docs/10）。
// 需求意图：dsh 里只看到一个虚拟模型（INV-01），真实模型按 options.sessionId 的映射改写（INV-02）；
//          dsh 盖章的 sessionId 比自己从 header 猜可靠得多，所以这里完全不读 HTTP 请求头。
// 思路：基类与错误类由调用方注入（本项目零依赖，不 import 宿主包）；转发复用阶段 3/4 的
//      config / session-store / credentials / drivers / stats，不另写一套存储或请求逻辑。

import { getDataRoot } from '../gateway/paths.js';
import { readConfig } from '../gateway/config.js';
import { readSessionTarget } from '../gateway/session-store.js';
import { dispatchWithRotation } from '../gateway/dispatcher.js';
import { resolveSessionTargetWithFallback } from '../gateway/session-fallback.js';
import { resolveAttemptContext } from '../gateway/attempt-context.js';
import { DEFAULT_MAX_REQUEST_ROWS, appendRequestRow, buildRequestRow } from '../gateway/stats.js';
import { createClock } from '../gateway/clock.js';
import { DEFAULT_USAGE_PATH, extractUsage } from '../gateway/mapping.js';
import { parseSseJsonData } from '../gateway/sse.js';
import { defaultLogger, describeFailure } from '../gateway/logger.js';
import { ERROR_CODES, GatewayError } from '../gateway/errors.js';
import { classifyUpstreamFailure, createStreamChunkBuilder } from './llm-protocol.js';

// 缺省 provider 路由名与展示名
export const DEFAULT_PROVIDER_ID = 'dsh-model-team';
export const PROVIDER_DISPLAY_NAME = '模型团队';

// 选择器里那唯一一条模型的名字与说明（INV-01）
export const PLUGIN_MODEL_NAME = '模型团队 · 模型群聊';
export const PLUGIN_MODEL_DESCRIPTION = '按会话切换真实模型；在悬浮面板里 @ 群友选择';

// 进程内调用没有客户端 IP/UA，请求行里用固定占位，避免污染成真实网络来源
export const IN_PROCESS_IP = '—';
export const IN_PROCESS_USER_AGENT = 'dsh-llm-adapter';

// 网关业务错误码 → LlmError 错误码
const LLM_ERROR_CODE_BY_GATEWAY_CODE = Object.freeze({
  [ERROR_CODES.SESSION_UNRESOLVED]: 'SESSION_UNRESOLVED',
  [ERROR_CODES.MODEL_UNRESOLVED]: 'MODEL_UNRESOLVED',
  [ERROR_CODES.GROUP_NOT_FOUND]: 'GROUP_NOT_FOUND',
  [ERROR_CODES.DRIVER_FAILED]: 'DRIVER_FAILED',
  [ERROR_CODES.DRIVER_NOT_FOUND]: 'DRIVER_NOT_FOUND',
  [ERROR_CODES.UPSTREAM_TIMEOUT]: 'UPSTREAM_TIMEOUT',
});

import {
  buildOpenAiRequestBody,
  buildRowContext,
  collectStreamState,
  createStreamState,
  findAttemptGroup,
  normalizeSessionId,
} from './adapter-support.js';

// 兼容旧的导入面：消息/工具/请求体转换仍可从 adapter.js 取到
export { buildOpenAiRequestBody, toOpenAiMessages, toOpenAiTools } from './adapter-support.js';
// 工厂：注入基类与错误类（本项目不 import 宿主包，测试可传桩）
export function createModelTimAdapter({ BaseAdapter, LlmErrorClass, deps = {} }) {
  const resolvedDeps = {
    dataRoot: undefined,
    readConfig,
    readSessionTarget,
    dispatchWithRotation,
    resolveSessionTargetWithFallback,
    // 宿主 sessions 服务（父链回落）：缺省永远取不到 → 跳过父链
    getSessionService: () => null,
    resolveAttemptContext,
    appendRequestRow,
    buildRequestRow,
    clock: createClock(),
    logger: defaultLogger,
    fetchImpl: undefined,
    ...deps,
  };
  const adapterDataRoot = resolvedDeps.dataRoot ?? getDataRoot();

  // 业务错误统一转成 LlmError：dsh 只认这个类型
  const toLlmError = (errorCandidate, fallbackCode = 'UPSTREAM_ERROR') => {
    if (errorCandidate instanceof LlmErrorClass) {
      return errorCandidate;
    }
    if (errorCandidate instanceof GatewayError) {
      return new LlmErrorClass(
        errorCandidate.message,
        LLM_ERROR_CODE_BY_GATEWAY_CODE[errorCandidate.code] ?? fallbackCode,
        errorCandidate.upstreamStatus === undefined ? {} : { status: errorCandidate.upstreamStatus },
      );
    }
    return new LlmErrorClass(describeFailure(errorCandidate), fallbackCode);
  };

  // 会话 → 会话目标：单模型 / 分组都原样交给 dispatcher；没目标时用兜底群的 defaultModel
  // 目标解析与 HTTP 路径共用同一份回落链：explicit → parent → last-session → fallback-group（docs/19）
  const resolveTarget = async ({ config, sessionId }) => {
    let sessionService = null;
    try {
      sessionService = resolvedDeps.getSessionService?.() ?? null;
    } catch (serviceError) {
      resolvedDeps.logger.warn(`sessions 服务解析失败，父链回落已跳过：${describeFailure(serviceError)}`);
    }

    const resolution = await resolvedDeps.resolveSessionTargetWithFallback({
      sessionId,
      dataRoot: adapterDataRoot,
      config,
      sessionService,
      logger: resolvedDeps.logger,
    });
    if (!resolution.target) {
      throw new GatewayError(ERROR_CODES.MODEL_UNRESOLVED, '该会话还没有选择模型或分组，且未配置兜底群', {
        hint: '在悬浮面板里 @ 一个群友或分组，或配置 session.fallbackGroupId',
      });
    }
    return { target: resolution.target, targetSource: resolution.source };
  };

  // 一次成员调用：解析上下文 → 校验流式能力 → 调驱动流式接口（供 dispatcher 逐成员调用）
  const buildAttemptInvoker = ({ config, options }) => async (attempt) => {
    const attemptContext = await resolvedDeps.resolveAttemptContext({
      attempt,
      config,
      dataRoot: adapterDataRoot,
      logger: resolvedDeps.logger,
    });
    if (!attemptContext.ok) {
      return { ok: false, error: attemptContext.error };
    }
    if (typeof attemptContext.driver.streamCompletions !== 'function') {
      return {
        ok: false,
        error: { code: ERROR_CODES.DRIVER_FAILED, message: `驱动不支持流式：${attemptContext.group.driver}` },
      };
    }
    return attemptContext.driver.streamCompletions(
      {
        group: attemptContext.group,
        credentials: attemptContext.credentials,
        logger: resolvedDeps.logger,
        fetchImpl: resolvedDeps.fetchImpl,
      },
      buildOpenAiRequestBody(options, attempt.modelId),
      { signal: options?.signal },
    );
  };

  // 上游事件 → StreamChunk：块逐条 yield，usage/id/完成原因收集到 streamState
  const relayEventChunks = async function* relayStreamEvents({ streamResult, chunkBuilder, usagePath, streamState }) {
    for await (const sseEvent of streamResult.events) {
      const parsedEvent = parseSseJsonData(sseEvent);
      if (parsedEvent.done) {
        streamState.upstreamFinished = true;
        continue;
      }
      if (parsedEvent.invalid || !parsedEvent.payload) {
        continue;
      }
      collectStreamState(streamState, parsedEvent.payload, usagePath);
      for (const streamChunk of chunkBuilder.appendOpenAiChunk(parsedEvent.payload)) {
        yield streamChunk;
      }
    }
  };

  return class ModelTimAdapter extends BaseAdapter {
    providerInfo(provider) {
      const providerId = typeof provider === 'string' && provider.length > 0 ? provider : DEFAULT_PROVIDER_ID;
      return { id: providerId, name: PROVIDER_DISPLAY_NAME };
    }

    // INV-01：永远只报一条虚拟模型；id 跟随 config.virtualModel（与 HTTP 入口 /v1/models 保持同一口径）
    async listModels(provider) {
      const providerId = typeof provider === 'string' && provider.length > 0 ? provider : DEFAULT_PROVIDER_ID;
      const config = await resolvedDeps.readConfig({ dataRoot: adapterDataRoot, logger: resolvedDeps.logger });
      const configuredVirtualModel = config?.virtualModel;
      const virtualModelId =
        typeof configuredVirtualModel === 'string' && configuredVirtualModel.trim().length > 0
          ? configuredVirtualModel.trim()
          : DEFAULT_PROVIDER_ID;
      return [
        {
          provider: providerId,
          id: virtualModelId,
          name: PLUGIN_MODEL_NAME,
          description: PLUGIN_MODEL_DESCRIPTION,
        },
      ];
    }

    async resolveModel(provider, model) {
      const providerId = typeof provider === 'string' && provider.length > 0 ? provider : DEFAULT_PROVIDER_ID;
      return {
        provider: providerId,
        id: typeof model === 'string' && model.length > 0 ? model : DEFAULT_PROVIDER_ID,
        name: PLUGIN_MODEL_NAME,
      };
    }

    // 兼容 0.1.x 的 prepareCall 入口：仍走同一个 stream
    async prepareCall(provider, model) {
      return {
        model: await this.resolveModel(provider, model),
        stream: (options) => this.stream(options),
      };
    }

    // 转发点：sessionId 由 dsh 盖章 → 取会话目标 → 调度（单模型直连 / 分组轮换）→ 逐块 yield StreamChunk
    async *stream(options) {
      const startedAtMs = resolvedDeps.clock.nowMs();
      const sessionId = normalizeSessionId(options?.sessionId);
      const config = await resolvedDeps.readConfig({ dataRoot: adapterDataRoot, logger: resolvedDeps.logger });

      let targetResolution;
      try {
        targetResolution = await resolveTarget({ config, sessionId });
      } catch (targetError) {
        throw toLlmError(targetError, 'MODEL_UNRESOLVED');
      }
      const target = targetResolution.target;

      const dispatchResult = await resolvedDeps.dispatchWithRotation({
        config,
        target,
        dataRoot: adapterDataRoot,
        logger: resolvedDeps.logger,
        now: () => resolvedDeps.clock.nowMs(),
        invoke: buildAttemptInvoker({ config, options }),
      });

      const attempt = dispatchResult.attempt ?? null;
      const rowContext = buildRowContext({ sessionId, config, attempt, startedAtMs, targetSource: targetResolution.targetSource });
      if (!dispatchResult.ok) {
        await this.reportDispatchFailure({ dispatchResult, rowContext });
      }

      const chunkBuilder = createStreamChunkBuilder();
      const streamState = createStreamState(dispatchResult.result);
      try {
        yield* relayEventChunks({
          streamResult: dispatchResult.result,
          chunkBuilder,
          usagePath: rowContext.targetGroup?.response?.usagePath ?? DEFAULT_USAGE_PATH,
          streamState,
        });
      } catch (streamError) {
        await this.handleStreamError({ streamError, streamState, options, rowContext });
      }

      await this.recordRow({
        ...rowContext,
        upstreamStatus: streamState.abortedByCaller ? 0 : streamState.upstreamStatus,
        usage: streamState.lastUsage,
        requestId: streamState.lastResponseId,
        aborted: streamState.abortedByCaller,
      });
      yield* this.finishStream({ streamState, chunkBuilder });
    }

    // 收尾：调用方取消要抛 ABORTED，否则补齐 finish 块（拆出来让 stream 本体保持可读长度）
    async *finishStream({ streamState, chunkBuilder }) {
      if (streamState.abortedByCaller) {
        throw new LlmErrorClass('调用方已取消本次请求', 'ABORTED');
      }
      yield* chunkBuilder.finish({ finishReason: streamState.finishReason, usage: streamState.lastUsage });
    }

    // 全部成员都失败：记一行失败请求行，再把最后一个错误转成 LlmError
    async reportDispatchFailure({ dispatchResult, rowContext }) {
      const lastError = dispatchResult.errors?.[dispatchResult.errors.length - 1] ?? null;
      const upstreamStatus = typeof dispatchResult.result?.status === 'number' ? dispatchResult.result.status : 0;
      await this.recordRow({ ...rowContext, upstreamStatus, usage: null, requestId: null, aborted: false });
      const failureCode = classifyUpstreamFailure(upstreamStatus);
      throw toLlmError(
        new LlmErrorClass(lastError?.message ?? '上游返回失败', failureCode, upstreamStatus ? { status: upstreamStatus } : {}),
        failureCode,
      );
    }

    // 上游流中断的三分类：已完成 → 忽略；调用方 abort → 记中断；其余 → 上游错误
    async handleStreamError({ streamError, streamState, options, rowContext }) {
      if (streamState.upstreamFinished) {
        resolvedDeps.logger.info(`上游已完成，忽略其后的流中断：${describeFailure(streamError)}`);
        return;
      }
      if (options?.signal?.aborted) {
        streamState.abortedByCaller = true;
        return;
      }
      resolvedDeps.logger.warn(`适配器流式转发中断：${describeFailure(streamError)}`);
      await this.recordRow({
        ...rowContext,
        upstreamStatus: streamState.upstreamStatus,
        usage: streamState.lastUsage,
        requestId: streamState.lastResponseId,
        aborted: false,
      });
      throw toLlmError(streamError, 'UPSTREAM_ERROR');
    }

    // 请求行：与 HTTP 路径同一份组装/存储实现，保证两边字段口径一致
    async recordRow({ sessionId, targetGroup, targetModel, groupId, targetSource, startedAtMs, upstreamStatus, usage, requestId, aborted }) {
      const requestRow = resolvedDeps.buildRequestRow({
        sessionId,
        statusCode: aborted ? 0 : upstreamStatus || 0,
        statusText: aborted ? '客户端中断' : undefined,
        model: targetModel,
        account: targetGroup ? { name: targetGroup.name, id: targetGroup.id } : null,
        ipAddress: IN_PROCESS_IP,
        userAgent: IN_PROCESS_USER_AGENT,
        startedAtMs,
        finishedAtMs: resolvedDeps.clock.nowMs(),
        usage: usage ?? null,
        credit: null,
        requestId: requestId ?? resolvedDeps.clock.createRequestId(),
        aborted,
        groupId,
        targetSource,
      });
      try {
        await resolvedDeps.appendRequestRow(requestRow, {
          dataRoot: adapterDataRoot,
          logger: resolvedDeps.logger,
          maxRows: DEFAULT_MAX_REQUEST_ROWS,
        });
      } catch (recordError) {
        // 记账失败不能打断对话：只告警
        resolvedDeps.logger.warn(`请求行写入失败：${describeFailure(recordError)}`);
      }
      return requestRow;
    }
  };
}
