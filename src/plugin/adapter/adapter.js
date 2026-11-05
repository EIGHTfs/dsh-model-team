// dsh LlmAdapter 工厂：把"会话级模型路由"接进 dsh 的进程内模型调用链（docs/10）。
// 需求意图：dsh 里只看到一个虚拟模型（INV-01），真实模型按 options.sessionId 的映射改写（INV-02）；
//          dsh 盖章的 sessionId 比自己从 header 猜可靠得多，所以这里完全不读 HTTP 请求头。
// 思路：基类与错误类由调用方注入（本项目零依赖，不 import 宿主包）；转发复用阶段 3/4 的
//      config / session-store / credentials / drivers / stats，不另写一套存储或请求逻辑。

import { getDataRoot } from '../../gateway/config/paths.js';
import { readConfig } from '../../gateway/config/config.js';
import { readSessionTarget } from '../../gateway/session/store.js';
import { dispatchWithRotation } from '../../gateway/transport/dispatcher.js';
import { resolveSessionTargetWithFallback } from '../../gateway/session/fallback.js';
import { resolveAttemptContext } from '../../gateway/transport/attempt-context.js';
import { DEFAULT_MAX_REQUEST_ROWS, appendRequestRow, buildRequestRow, readRequestRows } from '../../gateway/stats/index.js';
import { createClock } from '../../gateway/clock.js';
import { DEFAULT_USAGE_PATH, extractUsage } from '../../gateway/mapping.js';
import { parseSseJsonData } from '../../gateway/transport/sse.js';
import { defaultLogger, describeFailure } from '../../gateway/logger.js';
import { ERROR_CODES, GatewayError } from '../../gateway/errors.js';
import { classifyUpstreamFailure, createStreamChunkBuilder } from './llm-protocol.js';
import { peekDeclaredContextWindow, resolveModelContextWindow, startContextWindowProbe } from '../context/window.js';
import { buildContextOverflowMessage, estimateMessagesTokens, evaluateContextGuard, isContextGuardEnabled } from '../context/guard.js';
import { messagesHaveImage, resolveImageUrls } from '../image/prefetch.js';
import { assertImageInputAllowed } from '../image/gate.js';
import { buildForwardRowInput, openForwardRequest } from './forward.js';

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
} from './support.js';

// 兼容旧的导入面：消息/工具/请求体转换仍可从 adapter.js 取到
export { buildOpenAiRequestBody, toOpenAiMessages, toOpenAiTools } from './support.js';
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
    // 本插件注册的 provider 路由名：forward 的递归守卫要拿它比对（目标是自己就绝不转发）
    providerIds: [],
    // 宿主 llm 服务的流式入口（rewrite 不用它）：forward 模式下由它真正发请求
    llmStream: undefined,
    ...deps,
  };
  const adapterDataRoot = resolvedDeps.dataRoot ?? getDataRoot();

  // 附件服务：宿主通过 ctx.get('attachments') 提供（与 getSessionService 同一套注入方式）。
  // 取不到就不声明图片能力——声明了却送不出图，用户只会以为图坏了。
  const resolveAttachments = () => {
    try {
      const service = typeof resolvedDeps.getAttachmentsService === 'function' ? resolvedDeps.getAttachmentsService() : null;
      return service || null;
    } catch (serviceError) {
      resolvedDeps.logger.warn(`附件服务获取失败，按不可用处理：${describeFailure(serviceError)}`);
      return null;
    }
  };

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
  const buildAttemptInvoker = ({ config, options, imageUrls }) => async (attempt) => {
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
      buildOpenAiRequestBody(options, attempt.modelId, imageUrls),
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
      // 容量申报：dsh 压缩读的是这里（拿不到 context 会抛 TargetPressureConfigError）。
      // 申报值 = 所有已知模型窗口的最小值，兜底 config.contextWindowFallback（缺省 1048576）；
      // 取值函数保证返回正数，0/负数/NaN 会让 dsh 抛 INVALID_MODEL_CONTEXT 直接崩掉整轮对话。
      const config = await resolvedDeps.readConfig({ dataRoot: adapterDataRoot, logger: resolvedDeps.logger });
      // 只读缓存 + 甩到后台补探：这条链路就是"用户切换模型"那一下，等一次上游 = 切一下卡 1 秒（实测），
      // 而上游常常一条容量都不报（收益为零）。探测是否真发网络由它内部的 TTL + single-flight 判定，
      // 所以这里可以无条件调用——空样本缓存不会被误判成"没探过"而每次重付一次网络。
      const contextWindow = peekDeclaredContextWindow({ config, logger: resolvedDeps.logger });
      startContextWindowProbe({
        config,
        dataRoot: adapterDataRoot,
        logger: resolvedDeps.logger,
        fetchImpl: resolvedDeps.fetchImpl,
      });
      const resolvedModel = {
        provider: providerId,
        id: typeof model === 'string' && model.length > 0 ? model : DEFAULT_PROVIDER_ID,
        name: PLUGIN_MODEL_NAME,
        context: { contextWindow },
      };
      // 能力申报：只有真能送图（附件服务可用）才声明 image，否则不声明（避免骗宿主）。
      // 这里同时把结论记在实例上，stream() 的门禁用的是**同一份**判定，不在请求期重新猜。
      const attachments = resolveAttachments();
      this.declaredInputModalities = attachments ? ['text', 'image'] : undefined;
      this.declaredModelId = resolvedModel.id;
      if (attachments) resolvedModel.inputModalities = this.declaredInputModalities;
      return resolvedModel;
    }

    // 兼容 0.1.x 的 prepareCall 入口：仍走同一个 stream
    async prepareCall(provider, model) {
      return {
        model: await this.resolveModel(provider, model),
        stream: (options) => this.stream(options),
      };
    }

    // 入口分流（docs/15 §一）：能转发就转发；不能转发（或首块前抛 NO_ADAPTER）走 rewrite。
    // rewrite 的实现原样保留在 streamRewrite 里，本函数只做"选哪条路"。
    async *stream(options) {
      const startedAtMs = resolvedDeps.clock.nowMs();
      const sessionId = normalizeSessionId(options?.sessionId);
      const config = await resolvedDeps.readConfig({ dataRoot: adapterDataRoot, logger: resolvedDeps.logger });

      // 转发预检 + 首块探测都在 openForwardRequest 里；它返回 null 表示"这次不转发"
      const forwardRequest = await openForwardRequest({
        options, config, sessionId, startedAtMs,
        providerIds: resolvedDeps.providerIds,
        logger: resolvedDeps.logger,
        deps: resolvedDeps,
        resolveTarget,
        recordRow: (rowInput) => this.recordRow(rowInput),
      }).catch((forwardError) => { throw toLlmError(forwardError, 'UPSTREAM_ERROR'); });

      if (!forwardRequest) {
        yield* this.streamRewrite(options);
        return;
      }
      // 通道内部已记好请求行（含中途失败），这里只把错误翻译成 dsh 认的类型
      try {
        yield* forwardRequest.chunks;
      } catch (forwardStreamError) {
        throw toLlmError(forwardStreamError, 'UPSTREAM_ERROR');
      }
    }

    // 转发点：sessionId 由 dsh 盖章 → 取会话目标 → 调度（单模型直连 / 分组轮换）→ 逐块 yield StreamChunk
    async *streamRewrite(options) {
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

      // 图片输入三态门禁（见 image-gate.js）：未加载完 → INVALID_REQUEST（不可重试）、
      // 明确不支持 / 缺附件服务 → UNSUPPORTED_CONTENT。判定用的是 resolveModel 记下的同一份能力。
      const hasImage = messagesHaveImage(options?.messages);
      let imageUrls;
      if (hasImage) {
        const attachments = resolveAttachments();
        assertImageInputAllowed({
          modelId: this.declaredModelId || target?.id,
          declaredModalities: this.declaredInputModalities,
          attachmentsAvailable: Boolean(attachments),
          hasImage: true,
          LlmErrorClass,
        });
        // 先异步取图，再同步拼 body；**空 Map 也保留**（全部失败时靠它产出占位文本）
        imageUrls = await resolveImageUrls(options?.messages, {
          attachments,
          logger: resolvedDeps.logger,
          signal: options?.signal,
        });
      }

      // 发请求前超限检查（契约 02 §5.4）：只对"单模型"目标做——分组目标是运行时轮换选成员，
      // 此刻没有确定窗口，硬判会把正常请求拦掉；未知窗口也放行（宁可漏报不误报）。
      if (isContextGuardEnabled(config) && target && target.type === 'model') {
        await this.assertContextWithinWindow({ config, target, options, sessionId });
      }

      const dispatchResult = await resolvedDeps.dispatchWithRotation({
        config,
        target,
        dataRoot: adapterDataRoot,
        logger: resolvedDeps.logger,
        now: () => resolvedDeps.clock.nowMs(),
        invoke: buildAttemptInvoker({ config, options, imageUrls }),
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

    // 超限检查：估算 = max(本次消息估算, 上次成功请求的 prompt_tokens)，只在明确超过窗口时拒绝
    async assertContextWithinWindow({ config, target, options, sessionId }) {
      const modelId = typeof target?.id === 'string' ? target.id : '';
      const groupId = typeof target?.platformId === 'string' ? target.platformId : '';
      if (modelId.length === 0 || groupId.length === 0) return;

      let windowTokens = null;
      try {
        windowTokens = await resolveModelContextWindow({
          config,
          groupId,
          modelId,
          dataRoot: adapterDataRoot,
          logger: resolvedDeps.logger,
          fetchImpl: resolvedDeps.fetchImpl,
        });
      } catch (windowError) {
        resolvedDeps.logger.warn(`目标模型窗口查询失败，本次跳过超限检查：${describeFailure(windowError)}`);
        return;
      }
      if (windowTokens === null) return;   // 窗口未知：不拦

      const lastPromptTokens = await this.readLastPromptTokens({ sessionId });
      const outboundMessages = buildOpenAiRequestBody(options, modelId).messages;
      const estimatedTokens = Math.max(estimateMessagesTokens(outboundMessages), lastPromptTokens ?? 0);
      const verdict = evaluateContextGuard({ estimatedTokens, windowTokens });
      if (verdict.blocked) {
        throw new LlmErrorClass(
          buildContextOverflowMessage({ estimatedTokens, lastPromptTokens, windowTokens, modelId }),
          'CONTEXT_OVERFLOW',
        );
      }
      // 接近上限时留一行日志：真超了以后能回看是不是估算偏差，而不是只有一个"上游 400"
      if (estimatedTokens > windowTokens * 0.9) {
        resolvedDeps.logger.info(`上下文接近目标窗口：估算 ${estimatedTokens} / 窗口 ${windowTokens}（${modelId}）`);
      }
    }

    // 上次成功请求的 prompt_tokens：请求行里唯一可靠的"真实占用"参照（估算只作补充）
    async readLastPromptTokens({ sessionId }) {
      try {
        const rows = await readRequestRows({ dataRoot: adapterDataRoot, logger: resolvedDeps.logger });
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          const row = rows[index];
          if (sessionId && row?.sessionId && row.sessionId !== sessionId) continue;
          const promptTokens = row?.usage?.promptTokens;
          if (typeof promptTokens === 'number' && promptTokens > 0) return promptTokens;
        }
      } catch (readError) {
        resolvedDeps.logger.warn(`读取历史请求行失败，超限检查改用纯估算：${describeFailure(readError)}`);
      }
      return null;
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
