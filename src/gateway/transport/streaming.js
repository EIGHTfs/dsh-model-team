// HTTP 流式透传：`stream:true` 时把上游 SSE 逐块写回客户端（docs/09 §12）。
// 需求意图：调用方必须"逐块看到"回复，禁止憋完整段再吐；客户端断开时要真的掐断上游请求，而不是继续白跑。
// 思路：会话目标 → dispatcher 选出实际成员（单模型直连 / 分组轮换）→ 用该成员的驱动拿事件流
//      → 边收边写并解析 usage/id → 结束时落一条请求行。上游事件原样转发，不在网关里重排 SSE 结构。

import { ERROR_CODES, GatewayError } from '../errors.js';
import { extractCredit, recordRequestRow, resolveChatTarget, resolveRequestId } from './router.js';
import { dispatchWithRotation } from './dispatcher.js';
import { resolveAttemptContext } from './attempt-context.js';
import { parseSseJsonData } from './sse.js';
import { extractUsage } from '../mapping.js';
import { describeFailure } from '../logger.js';

// 流式响应头：no-cache 让中间层不要缓存，x-accel-buffering 关掉 nginx 类反代的缓冲
export const SSE_CONTENT_TYPE = 'text/event-stream; charset=utf-8';
const SSE_RESPONSE_HEADERS = Object.freeze({
  'content-type': SSE_CONTENT_TYPE,
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
});

// 客户端中断时请求行的状态文案
export const CLIENT_ABORTED_STATUS_TEXT = '客户端中断';

// 状态码常量
const HTTP_OK = 200;
const GATEWAY_UPSTREAM_FAILURE_STATUS = 502;
const UPSTREAM_TIMEOUT_STATUS = 504;

// 把一条上游事件按 SSE 规范写回（保留原始 data 内容，不改写字段）
function writeSseEvent(outgoingResponse, sseEvent) {
  outgoingResponse.write(`data: ${sseEvent.data}\n\n`);
}

// 非流式兜底：驱动没实现 streamCompletions 时，把一次性结果包成单块事件，避免调用方空等
function writeSingleShotEvents(outgoingResponse, responseBody) {
  outgoingResponse.writeHead(HTTP_OK, SSE_RESPONSE_HEADERS);
  writeSseEvent(outgoingResponse, { data: JSON.stringify(responseBody) });
  outgoingResponse.write('data: [DONE]\n\n');
  outgoingResponse.end();
}

// 流式 chat 处理：返回 { streamed: true } 表示响应已由本函数写完
export async function handleStreamingChatCompletions({
  incomingRequest,
  outgoingResponse,
  requestBody,
  config,
  dataRoot,
  logger,
  clock,
  fetchImpl,
  jsonlResolver,
  maxRows,
  getSessionService,
}) {
  const { target, rowContext } = await resolveChatTarget({
    incomingRequest,
    config,
    dataRoot,
    logger,
    clock,
    fetchImpl,
    jsonlResolver,
    maxRows,
    getSessionService,
  });

  // 客户端断开 → 中止上游；只在响应还没写完时触发，避免正常结束后误 abort
  const abortController = new AbortController();
  const abortOnClose = () => {
    if (!outgoingResponse.writableEnded) {
      abortController.abort();
    }
  };
  outgoingResponse.on('close', abortOnClose);

  let lastPayload = null;
  let lastUsage = null;
  let lastResponseId = null;
  let upstreamStatus = 0;
  let streamFailure = null;
  let abortedByClient = false;
  let attemptGroup = null;
  let attemptedModelId = null;
  let attemptedGroupId = null;

  try {
    // 派发：单模型直连；分组按策略轮换。客户端已断开时不再继续换成员试
    const dispatchResult = await dispatchWithRotation({
      config,
      target,
      dataRoot,
      logger,
      now: () => clock.nowMs(),
      invoke: async (attempt) => {
        if (abortController.signal.aborted) {
          return { ok: false, error: { code: 'CLIENT_ABORTED', message: '客户端已断开' } };
        }
        const attemptContext = await resolveAttemptContext({ attempt, config, dataRoot, logger });
        if (!attemptContext.ok) {
          return { ok: false, error: attemptContext.error };
        }
        const driverContext = {
          group: attemptContext.group,
          credentials: attemptContext.credentials,
          logger,
          fetchImpl,
        };
        const outboundBody = { ...(requestBody ?? {}), model: attempt.modelId };
        // 驱动支持流式就走流式；否则退回非流式（结果由下面包成单块事件）
        if (typeof attemptContext.driver.streamCompletions === 'function') {
          return attemptContext.driver.streamCompletions(driverContext, outboundBody, { signal: abortController.signal });
        }
        const plainResult = await attemptContext.driver.chatCompletions(driverContext, outboundBody);
        return { ...plainResult, events: null, plainResponse: plainResult.response };
      },
    });

    const attempt = dispatchResult.attempt ?? null;
    attemptedModelId = attempt?.modelId ?? null;
    attemptedGroupId = attempt?.groupId ?? null;
    attemptGroup = attempt
      ? (config?.groups ?? []).find((group) => group.id === attempt.platformId) ?? null
      : null;
    const usagePath = attemptGroup?.response?.usagePath ?? 'usage';
    const streamResult = dispatchResult.result;

    if (!dispatchResult.ok) {
      // 区分"我们主动中止"与"上游真的坏了"：前者不能记成 502
      if (abortController.signal.aborted) {
        abortedByClient = true;
      } else {
        upstreamStatus = typeof streamResult?.status === 'number' ? streamResult.status : 0;
        streamFailure = dispatchResult.errors?.[dispatchResult.errors.length - 1]
          ?? { code: 'UPSTREAM_HTTP_ERROR', message: '上游返回失败' };
      }
    } else if (!streamResult.events) {
      // 非流式兜底：一次性结果包成单块事件
      upstreamStatus = streamResult.status ?? HTTP_OK;
      lastPayload = streamResult.plainResponse ?? null;
      lastUsage = streamResult.usage ?? null;
      lastResponseId = typeof lastPayload?.id === 'string' ? lastPayload.id : null;
      writeSingleShotEvents(outgoingResponse, lastPayload);
    } else {
      upstreamStatus = streamResult.status ?? HTTP_OK;
      outgoingResponse.writeHead(streamResult.status ?? HTTP_OK, SSE_RESPONSE_HEADERS);
      try {
        for await (const sseEvent of streamResult.events) {
          if (abortController.signal.aborted) {
            abortedByClient = true;
            break;
          }
          const parsedEvent = parseSseJsonData(sseEvent);
          if (!parsedEvent.done && parsedEvent.payload) {
            lastPayload = parsedEvent.payload;
            const chunkUsage = extractUsage(parsedEvent.payload, usagePath);
            if (chunkUsage) {
              lastUsage = chunkUsage;
            }
            if (typeof parsedEvent.payload.id === 'string' && parsedEvent.payload.id.length > 0) {
              lastResponseId = parsedEvent.payload.id;
            }
          }
          // 原样透传：包括 [DONE] 与上游的事件名，客户端按自己的解析器处理
          writeSseEvent(outgoingResponse, sseEvent);
        }
      } catch (streamError) {
        // 客户端中断会让 fetch 的 body 流抛 AbortError，这里不当成网关故障
        if (abortController.signal.aborted) {
          abortedByClient = true;
        } else {
          streamFailure = { code: 'UPSTREAM_STREAM_FAILED', message: describeFailure(streamError) };
          logger.warn(`流式转发中断：${describeFailure(streamError)}`);
        }
      } finally {
        if (!outgoingResponse.writableEnded) {
          outgoingResponse.end();
        }
      }
    }
  } finally {
    outgoingResponse.off('close', abortOnClose);
  }

  const finishedAtMs = clock.nowMs();
  const requestRowStatus = streamFailure
    ? (upstreamStatus > 0 ? upstreamStatus : GATEWAY_UPSTREAM_FAILURE_STATUS)
    : upstreamStatus || HTTP_OK;

  await recordRequestRow({
    ...rowContext,
    group: attemptGroup,
    groupId: attemptedGroupId,
    // 中断没有"上游最终状态"：status 记 0 并带 aborted 标记，避免被全局统计算成一次成功
    statusCode: abortedByClient ? 0 : requestRowStatus,
    statusText: abortedByClient ? CLIENT_ABORTED_STATUS_TEXT : undefined,
    aborted: abortedByClient,
    model: attemptedModelId,
    finishedAtMs,
    usage: lastUsage,
    credit: extractCredit(lastPayload, attemptGroup),
    requestId: resolveRequestId({ id: lastResponseId }, clock),
  });

  if (streamFailure) {
    const isTimeout = upstreamStatus === UPSTREAM_TIMEOUT_STATUS;
    throw new GatewayError(
      isTimeout ? ERROR_CODES.UPSTREAM_TIMEOUT : ERROR_CODES.UPSTREAM_ERROR,
      streamFailure.message ?? `上游返回 ${upstreamStatus || '无响应'}`,
      {
        hint: isTimeout ? '上游超时，可适当调大 request.timeoutMs' : '检查凭证、模型名与上游服务状态',
        upstreamStatus: upstreamStatus || undefined,
      },
    );
  }

  return { streamed: true };
}
