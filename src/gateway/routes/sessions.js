// 端点路由表与处理器：把 docs/09 §6 的端点逐个落成"业务函数 + 声明式路由"。
// 需求意图：新增/调整端点只改这张表，不碰 HTTP 管道；处理器只返回 { status, body }，
//          序列化与错误码统一由 http-server 处理，避免每个端点各写一套响应逻辑。
// 思路：路径模式用 ':' 占位做单段匹配，分发时先比路径再比方法（路径命中但方法不对要报 405）。

import { API_PREFIX } from '../config/constants.js';
import { parseGroupId, parseLimit } from '../transport/query-params.js';
import { buildSwitchEvents } from '../session/events.js';
import { listDrivers } from '../drivers/index.js';
import {
  appendSessionEvent,
  readSessionEvents,
  readSessionMapping,
  readSessionTarget,
  writeSessionTarget,
} from '../session/store.js';
import { buildGlobalStats, readRequestRows, toPublicRequestRow } from '../stats/index.js';
import { buildModelListResponse, fetchGroupModels, handleChatCompletions, resolveVirtualModelId } from '../transport/router.js';
import {
  deleteFriendGroup,
  findFriendGroup,
  listFriendGroups,
  readGroupCursor,
  saveFriendGroup,
} from '../group/friend-groups.js';
import { normalizeSessionTarget } from '../session/target.js';
import { handleCurrentSessionRoute, handleSessionDetailRoute } from '../session/current.js';
import { loadPlatformPresets } from '../config/platform-presets.js';
import { probeModels } from '../model/probe.js';
import { resolveSessionTargetWithFallback } from '../session/fallback.js';
import {
  addGroup,
  exportGroups,
  findGroup,
  importGroups,
  listGroupsWithSummary,
  removeGroup,
  verifyGroup,
} from '../group/groups.js';
import { ERROR_CODES, GatewayError } from '../errors.js';
import { resolveHttpConfig } from '../config/config.js';
import { handleStreamingChatCompletions } from '../transport/streaming.js';
import { formatIsoWithOffset } from '../clock.js';
import { describeFailure } from '../logger.js';

// 成功状态码
const HTTP_OK = 200;
const HTTP_CREATED = 201;

// /v1/chat/completions 是否对外开放（docs/09 §11：默认关闭；dsh 自身走 LlmAdapter，不经 HTTP）
function assertExternalOpenAiCompatEnabled(config) {
  if (resolveHttpConfig(config).externalOpenAiCompat) {
    return;
  }
  throw new GatewayError(ERROR_CODES.NOT_FOUND, '未开放外部 OpenAI 兼容入口', {
    hint: '在 config.json 里设置 http.externalOpenAiCompat: true 后再试',
  });
}

// ---------- 会话与对话 ----------

async function handleChatCompletionsRoute(context) {
  assertExternalOpenAiCompatEnabled(context.config);

  // stream:true 走逐块透传（docs/09 §12）：响应由 streaming 模块自己写完，这里只回报"已写"
  if (context.body?.stream === true) {
    return handleStreamingChatCompletions({
      incomingRequest: context.incomingRequest,
      outgoingResponse: context.outgoingResponse,
      requestBody: context.body,
      config: context.config,
      dataRoot: context.dataRoot,
      logger: context.logger,
      clock: context.clock,
      fetchImpl: context.fetchImpl,
      jsonlResolver: context.jsonlResolver,
      getSessionService: context.getSessionService,
    });
  }

  const chatResult = await handleChatCompletions({
    incomingRequest: context.incomingRequest,
    requestBody: context.body,
    config: context.config,
    dataRoot: context.dataRoot,
    logger: context.logger,
    clock: context.clock,
    fetchImpl: context.fetchImpl,
    jsonlResolver: context.jsonlResolver,
    getSessionService: context.getSessionService,
  });
  return { status: chatResult.status, body: chatResult.body };
}

async function handleSessionModelReadRoute(context) {
  const sessionMapping = await readSessionMapping(context.params.id, {
    dataRoot: context.dataRoot,
    logger: context.logger,
  });
  // docs/09 §10：没有映射时返回 { platform: null, model: null }，前端按"未选择"渲染，不用先处理 404
  if (!sessionMapping) {
    return { status: HTTP_OK, body: { platform: null, model: null } };
  }
  return { status: HTTP_OK, body: { platform: sessionMapping.platform, model: sessionMapping.model } };
}

// PUT /_team/session/:id/model（兼容入口）：等价于写 { type:'model', id:model, platformId:platform }

// 事件写入是 best-effort：失败只告警，不能让"切换模型"整体失败
async function appendEventSafely(context, sessionEvent) {
  try {
    await appendSessionEvent(context.params.id, sessionEvent, { dataRoot: context.dataRoot });
  } catch (eventError) {
    context.logger.warn(`会话事件写入失败：${describeFailure(eventError)}`);
  }
}

async function handleSessionModelWriteRoute(context) {
  const requestedModel = context.body?.model;
  const requestedGroupId = context.body?.platform ?? context.body?.platformId ?? context.body?.groupId;
  if (typeof requestedModel !== 'string' || requestedModel.trim().length === 0) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, '请求体缺少 model', {
      hint: '形如 { "platform": "agnes", "model": "agnes-3.0-flash" }',
    });
  }
  if (typeof requestedGroupId !== 'string' || requestedGroupId.trim().length === 0) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, '请求体缺少 platform（群 id）');
  }
  const group = findGroup(context.config, requestedGroupId.trim());
  if (!group) {
    throw new GatewayError(ERROR_CODES.GROUP_NOT_FOUND, `群不存在：${requestedGroupId}`);
  }

  const trimmedModel = requestedModel.trim();
  const storedMapping = await writeSessionTarget(
    context.params.id,
    { type: 'model', id: trimmedModel, platformId: group.id },
    { dataRoot: context.dataRoot, logger: context.logger, updatedAt: formatIsoWithOffset(context.clock.nowMs()) },
  );
  // 每次切换落两条事件（@目标 + 系统提示），ath 由 clock 统一生成，刷新后仍可回放
  for (const sessionEvent of buildSwitchEvents({
    target: { type: 'model', id: trimmedModel },
    clock: context.clock,
  })) {
    await appendEventSafely(context, sessionEvent);
  }
  return { status: HTTP_OK, body: { platform: group.id, model: trimmedModel, target: storedMapping.target } };
}

// GET /_team/session/:id/target：读会话目标（前端悬浮窗/群聊头要区分"模型"与"@分组"）

async function handleSessionTargetReadRoute(context) {
  const sessionTarget = await readSessionTarget(context.params.id, {
    dataRoot: context.dataRoot,
    logger: context.logger,
  });
  // 出参同时给"显式目标"与"实际会用的目标"：新会话没有映射时前端也能看到真正派发的是谁（docs/19）
  const fallbackResolution = await resolveSessionTargetWithFallback({
    sessionId: context.params.id,
    dataRoot: context.dataRoot,
    config: context.config,
    sessionService: resolveContextSessionService(context),
    logger: context.logger,
  });
  return {
    status: HTTP_OK,
    body: {
      target: sessionTarget ?? null,
      effectiveTarget: fallbackResolution.target ?? null,
      targetSource: fallbackResolution.source ?? null,
    },
  };
}

// 宿主 sessions 服务（父链回落用）：getter 缺失/抛错都按"没有服务"处理
function resolveContextSessionService(context) {
  try {
    return context.getSessionService?.() ?? null;
  } catch (serviceError) {
    context.logger.warn(`sessions 服务解析失败，回落链已跳过父链：${describeFailure(serviceError)}`);
    return null;
  }
}

// PUT /_team/session/:id/target：设置会话目标（单模型 / 分组），是上面那个端点的超集

async function handleSessionTargetWriteRoute(context) {
  const normalizedTarget = normalizeSessionTarget(context.body ?? {});
  if (!normalizedTarget) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, '请求体不是合法的会话目标', {
      hint: '形如 { "type": "model", "id": "agnes-3.0-flash", "platformId": "agnes" } 或 { "type": "group", "id": "ds-high-avail" }',
    });
  }

  // 指向已配置实体的目标先做存在性校验，避免把请求发给不存在的群/分组
  const targetFriendGroup = normalizedTarget.type === 'group'
    ? findFriendGroup(context.config, normalizedTarget.id, { logger: context.logger })
    : null;
  if (normalizedTarget.type === 'group') {
    if (!targetFriendGroup) {
      throw new GatewayError(ERROR_CODES.FRIEND_GROUP_NOT_FOUND, `好友分组不存在：${normalizedTarget.id}`);
    }
  } else if (normalizedTarget.platformId) {
    if (!findGroup(context.config, normalizedTarget.platformId)) {
      throw new GatewayError(ERROR_CODES.GROUP_NOT_FOUND, `群不存在：${normalizedTarget.platformId}`);
    }
  }

  const storedMapping = await writeSessionTarget(context.params.id, normalizedTarget, {
    dataRoot: context.dataRoot,
    logger: context.logger,
    updatedAt: formatIsoWithOffset(context.clock.nowMs()),
  });
  for (const sessionEvent of buildSwitchEvents({ target: normalizedTarget, friendGroup: targetFriendGroup, clock: context.clock })) {
    await appendEventSafely(context, sessionEvent);
  }
  return { status: HTTP_OK, body: { target: storedMapping.target } };
}

// ---------- 好友分组 ----------

// GET /_team/friend-groups：分组 + 成员 + 当前游标位置（UI 展示"下一个轮到谁"）

async function handleSessionEventsRoute(context) {
  const events = await readSessionEvents(context.params.id, {
    dataRoot: context.dataRoot,
    logger: context.logger,
    // 聊天流按群隔离：只返回属于该群的事件；不传返回全部
    groupId: parseGroupId(context.incomingRequest),
  });
  return { status: HTTP_OK, body: { events } };
}

export { handleChatCompletionsRoute, handleSessionModelReadRoute, handleSessionModelWriteRoute, handleSessionTargetReadRoute, handleSessionTargetWriteRoute, handleSessionEventsRoute };