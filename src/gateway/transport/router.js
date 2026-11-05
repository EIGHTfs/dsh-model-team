// 转发路由：POST /v1/chat/completions 全流程 + GET /v1/models（只暴露一个虚拟模型）。
// 需求意图：dsh 侧永远只看到一个模型，真实模型由会话映射改写；任何"不确定"都必须明确报错，绝不静默用错模型
//          （INV-01 单模型注册 / INV-02 会话隔离 / INV-07 请求行完整）。
// 思路：解析会话 → 定位群与目标模型（映射 → 群 defaultModel）→ 解引用凭证 → 驱动转发 → 组装请求行落盘 → 回写上游响应；
//      失败也先落一行行记录再抛 GatewayError，保证"每条请求都有请求行"。

import { resolveSessionIdentity } from '../session/store.js';
import { resolveSessionTargetWithFallback } from '../session/fallback.js';
import { DEFAULT_MAX_REQUEST_ROWS, appendRequestRow, buildRequestRow } from '../stats/index.js';
import { dispatchWithRotation } from './dispatcher.js';
import { resolveAttemptContext } from './attempt-context.js';
import { readFieldByPath } from '../mapping.js';
import { defaultLogger, describeFailure } from '../logger.js';
import { ERROR_CODES, GatewayError } from '../errors.js';

// 虚拟模型缺省 id（docs/09 §1：config.virtualModel 可覆盖）
export const DEFAULT_VIRTUAL_MODEL_ID = 'dsh-model-team';

// OpenAI 兼容响应里的对象类型标识
export const MODEL_OBJECT_TYPE = 'model';
export const MODEL_LIST_OBJECT_TYPE = 'list';

// 宿主 sessions 服务：getter 缺失/抛错都按"没有服务"处理（父链回落会因此跳过）
function resolveSessionServiceSafely(getSessionService, logger) {
  try {
    return getSessionService?.() ?? null;
  } catch (serviceError) {
    logger.warn(`sessions 服务解析失败，父链回落已跳过：${describeFailure(serviceError)}`);
    return null;
  }
}

// 网关自身产生的失败统一回 502（上游问题），504 只留给超时
const GATEWAY_UPSTREAM_FAILURE_STATUS = 502;
const UPSTREAM_TIMEOUT_STATUS = 504;

// 会话未映射时的固定文案（docs/09 §3 要求 statusText 为"无模型映射"）
export const NO_MODEL_MAPPING_TEXT = '无模型映射';

// 事件流里的类型标识（docs/09 §4 的 SessionEvent.type）
// 取虚拟模型 id：配置可覆盖，缺省固定值
export function resolveVirtualModelId(config) {
  const configuredVirtualModel = config?.virtualModel;
  if (typeof configuredVirtualModel === 'string' && configuredVirtualModel.trim().length > 0) {
    return configuredVirtualModel.trim();
  }
  return DEFAULT_VIRTUAL_MODEL_ID;
}

// GET /v1/models 响应：永远只有一条（INV-01）
export function buildModelListResponse(config, clock) {
  return {
    object: MODEL_LIST_OBJECT_TYPE,
    data: [
      {
        id: resolveVirtualModelId(config),
        object: MODEL_OBJECT_TYPE,
        created: Math.floor(clock.nowMs() / 1000),
        owned_by: DEFAULT_VIRTUAL_MODEL_ID,
      },
    ],
  };
}

// 取客户端 IP：反向代理场景优先 x-forwarded-for 首段，否则用连接远端地址
export function extractClientIp(incomingRequest) {
  const forwardedForHeader = incomingRequest?.headers?.['x-forwarded-for'];
  if (typeof forwardedForHeader === 'string' && forwardedForHeader.trim().length > 0) {
    const firstForwardedIp = forwardedForHeader.split(',')[0].trim();
    if (firstForwardedIp.length > 0) {
      return firstForwardedIp;
    }
  }
  return incomingRequest?.socket?.remoteAddress ?? null;
}

// 取 User-Agent
export function extractUserAgent(incomingRequest) {
  const userAgentHeader = incomingRequest?.headers?.['user-agent'];
  if (typeof userAgentHeader === 'string' && userAgentHeader.trim().length > 0) {
    return userAgentHeader.trim();
  }
  return null;
}

// credit 只认平台返回值（可能是 response.credit 或 usage.credit），没有就 null（不估算）
export function extractCredit(upstreamResponse, group) {
  const creditPath = group?.response?.creditPath ?? 'credit';
  const directCredit = readFieldByPath(upstreamResponse, creditPath);
  if (directCredit !== undefined && directCredit !== null) {
    return directCredit;
  }
  const usageCredit = readFieldByPath(upstreamResponse, 'usage.credit');
  return usageCredit ?? null;
}

// 上游 request id：优先用响应 id，没有则由网关生成
export function resolveRequestId(upstreamResponse, clock) {
  const upstreamRequestId = upstreamResponse?.id;
  if (typeof upstreamRequestId === 'string' && upstreamRequestId.trim().length > 0) {
    return upstreamRequestId.trim();
  }
  return clock.createRequestId();
}

// 收敛本次请求应当落库的 maxRows
function resolveMaxRows(config, overrideMaxRows) {
  if (typeof overrideMaxRows === 'number' && overrideMaxRows > 0) {
    return overrideMaxRows;
  }
  const configuredMaxRows = config?.stats?.maxRows;
  if (typeof configuredMaxRows === 'number' && configuredMaxRows > 0) {
    return configuredMaxRows;
  }
  return DEFAULT_MAX_REQUEST_ROWS;
}

// 落一条请求行：chat 成功与各种失败都要调这里，避免"有响应没记录"
export async function recordRequestRow({
  dataRoot,
  logger,
  config,
  overrideMaxRows,
  sessionId,
  statusCode,
  statusText,
  model,
  group,
  groupId,
  incomingRequest,
  clientIp,
  userAgent,
  startedAtMs,
  finishedAtMs,
  usage,
  credit,
  requestId,
  aborted,
  targetSource,
  clock,
}) {
  const requestRow = buildRequestRow({
    sessionId,
    statusCode,
    statusText,
    model,
    account: group ? { name: group.name, id: group.id } : null,
    // 优先用请求开始时抓到的值：流式路径落行时 socket 可能已经关了
    ipAddress: clientIp ?? extractClientIp(incomingRequest),
    userAgent: userAgent ?? extractUserAgent(incomingRequest),
    startedAtMs,
    finishedAtMs,
    usage,
    credit,
    requestId,
    aborted,
    groupId,
    targetSource,
  });
  await appendRequestRow(requestRow, { dataRoot, logger, maxRows: resolveMaxRows(config, overrideMaxRows) });
  return requestRow;
}

// 失败专用：落行 + 抛业务异常（HTTP 状态与文案由调用方给）
async function failRequest({ gatewayError, statusCode, statusText, ...rowContext }) {
  await recordRequestRow({ ...rowContext, statusCode, statusText });
  throw gatewayError;
}

// 模型列表链路已搬到 group-models.js（保持导出面，老调用方不用改）
export { fetchGroupModels, safeFetchModels } from '../group/models.js';

// 解析一次 chat 请求的目标（会话 → 会话目标）：失败时先落请求行、再抛 GatewayError
// 具体派给哪个平台/模型由 dispatcher 决策（单模型 / 分组轮换），本函数只管"目标是什么"
export async function resolveChatTarget({
  incomingRequest,
  config,
  dataRoot,
  logger = defaultLogger,
  clock,
  fetchImpl,
  jsonlResolver,
  maxRows,
  getSessionService,
} = {}) {
  const startedAtMs = clock.nowMs();
  const sessionIdentity = await resolveSessionIdentity({ incomingRequest, config, logger, jsonlResolver });

  // 目标解析：当前 session 映射 → 父链递归向上 → 其它 session 最近绑定 → 兜底群（docs/19）
  const sessionService = resolveSessionServiceSafely(getSessionService, logger);

  const rowContext = {
    dataRoot,
    logger,
    config,
    overrideMaxRows: maxRows,
    sessionId: sessionIdentity.sessionId,
    incomingRequest,
    // 客户端 IP/UA 在请求开始时取一次：流式路径常常在响应结束后才落行，那时 socket 可能已拆除
    clientIp: extractClientIp(incomingRequest),
    userAgent: extractUserAgent(incomingRequest),
    startedAtMs,
    clock,
  };

  // 回落链：explicit → parent → last-session → fallback-group；一级都没有则 target=null
  let resolvedTarget = null;
  let targetSource = null;
  try {
    const fallbackResolution = await resolveSessionTargetWithFallback({
      sessionId: sessionIdentity.sessionId,
      dataRoot,
      config,
      sessionService,
      logger,
    });
    resolvedTarget = fallbackResolution.target;
    targetSource = fallbackResolution.source;
  } catch (resolutionError) {
    // 兜底群配了却不存在：保持既有行为——落一行 404 行再抛（不能静默当成"没配"）
    if (resolutionError instanceof GatewayError && resolutionError.code === ERROR_CODES.GROUP_NOT_FOUND) {
      await failRequest({
        gatewayError: resolutionError,
        statusCode: 404,
        statusText: '群不存在',
        model: null,
        finishedAtMs: clock.nowMs(),
        requestId: clock.createRequestId(),
        ...rowContext,
      });
    }
    throw resolutionError;
  }
  rowContext.targetSource = targetSource;

  if (!resolvedTarget) {
    await recordRequestRow({
      ...rowContext,
      statusCode: 400,
      statusText: NO_MODEL_MAPPING_TEXT,
      model: null,
      finishedAtMs: clock.nowMs(),
      usage: null,
      credit: null,
      requestId: clock.createRequestId(),
    });
    throw new GatewayError(ERROR_CODES.MODEL_UNRESOLVED, '该会话还没有选择模型或分组，且未配置兜底群', {
      hint: '在群里 @ 一个模型/分组，或配置 session.fallbackGroupId',
    });
  }

  return { startedAtMs, sessionIdentity, target: resolvedTarget, targetSource, rowContext };
}

// POST /v1/chat/completions（非流式）：解析目标 → 按策略派发 → 落请求行 → 回写响应
export async function handleChatCompletions({
  incomingRequest,
  requestBody,
  config,
  dataRoot,
  logger = defaultLogger,
  clock,
  fetchImpl,
  jsonlResolver,
  maxRows,
  getSessionService,
} = {}) {
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

  // 派发：单模型直连；分组按策略轮换（调度语义全在 dispatcher，这里只提供"怎么调一次"）
  const dispatchResult = await dispatchWithRotation({
    config,
    target,
    dataRoot,
    logger,
    now: () => clock.nowMs(),
    invoke: async (attempt) => {
      const attemptContext = await resolveAttemptContext({ attempt, config, dataRoot, logger });
      if (!attemptContext.ok) {
        return { ok: false, error: attemptContext.error };
      }
      try {
        return await attemptContext.driver.chatCompletions(
          { group: attemptContext.group, credentials: attemptContext.credentials, logger, fetchImpl },
          { ...(requestBody ?? {}), model: attempt.modelId },
        );
      } catch (driverError) {
        // 驱动抛错同样交给调度引擎换下一个成员，不让异常穿过转发链路
        return {
          ok: false,
          error: { code: ERROR_CODES.DRIVER_FAILED, message: `驱动执行失败：${describeFailure(driverError)}` },
        };
      }
    },
  });

  const attempted = dispatchResult.attempt ?? null;
  const attemptGroup = attempted
    ? (config?.groups ?? []).find((group) => group.id === attempted.platformId) ?? null
    : null;
  const finishedAtMs = clock.nowMs();
  const driverResult = dispatchResult.result;
  const upstreamStatus = typeof driverResult?.status === 'number' ? driverResult.status : 0;

  if (!dispatchResult.ok) {
    const lastError = dispatchResult.errors?.[dispatchResult.errors.length - 1] ?? null;
    const failureStatus = upstreamStatus > 0 ? upstreamStatus : GATEWAY_UPSTREAM_FAILURE_STATUS;
    await recordRequestRow({
      ...rowContext,
      group: attemptGroup,
      groupId: attempted?.groupId ?? null,
      statusCode: failureStatus,
      statusText: undefined,
      model: attempted?.modelId ?? null,
      finishedAtMs,
      usage: null,
      credit: null,
      requestId: clock.createRequestId(),
    });
    const isTimeout = upstreamStatus === UPSTREAM_TIMEOUT_STATUS;
    throw new GatewayError(
      isTimeout
        ? ERROR_CODES.UPSTREAM_TIMEOUT
        : upstreamStatus > 0
          ? ERROR_CODES.UPSTREAM_ERROR
          : ERROR_CODES.DRIVER_FAILED,
      lastError?.message ?? `上游返回 ${upstreamStatus || '无响应'}`,
      {
        hint: (dispatchResult.attemptsTried?.length ?? 0) > 1
          ? '已按策略尝试全部可用成员仍失败'
          : '检查凭证、模型名与上游服务状态',
        upstreamStatus: upstreamStatus || undefined,
        details: { attemptsTried: dispatchResult.attemptsTried ?? [] },
      },
    );
  }

  await recordRequestRow({
    ...rowContext,
    group: attemptGroup,
    groupId: attempted?.groupId ?? null,
    statusCode: upstreamStatus || 200,
    statusText: undefined,
    model: attempted?.modelId ?? null,
    finishedAtMs,
    usage: driverResult.usage ?? null,
    credit: extractCredit(driverResult.response, attemptGroup),
    requestId: resolveRequestId(driverResult.response, clock),
  });

  return { status: upstreamStatus || 200, body: driverResult.response };
}

// 事件流追加（系统提示）已移到 session-store.js：那是事件流的自然归属，入口保持不变
