// 端点路由表与处理器：把 docs/09 §6 的端点逐个落成"业务函数 + 声明式路由"。
// 需求意图：新增/调整端点只改这张表，不碰 HTTP 管道；处理器只返回 { status, body }，
//          序列化与错误码统一由 http-server 处理，避免每个端点各写一套响应逻辑。
// 思路：路径模式用 ':' 占位做单段匹配，分发时先比路径再比方法（路径命中但方法不对要报 405）。

import { API_PREFIX } from './constants.js';
import { parseGroupId, parseLimit } from './query-params.js';
import { buildSwitchEvents } from './session-events.js';
import { listDrivers } from './drivers/index.js';
import {
  appendSessionEvent,
  readSessionEvents,
  readSessionMapping,
  readSessionTarget,
  writeSessionTarget,
} from './session-store.js';
import { buildGlobalStats, readRequestRows, toPublicRequestRow } from './stats.js';
import { buildModelListResponse, fetchGroupModels, handleChatCompletions, resolveVirtualModelId } from './router.js';
import {
  deleteFriendGroup,
  findFriendGroup,
  listFriendGroups,
  readGroupCursor,
  saveFriendGroup,
} from './friend-groups.js';
import { normalizeSessionTarget } from './session-target.js';
import { handleCurrentSessionRoute, handleSessionDetailRoute } from './session-current.js';
import { loadPlatformPresets } from './platform-presets.js';
import { probeModels } from './model-probe.js';
import { resolveSessionTargetWithFallback } from './session-fallback.js';
import {
  addGroup,
  exportGroups,
  findGroup,
  importGroups,
  listGroupsWithSummary,
  removeGroup,
  verifyGroup,
} from './groups.js';
import { ERROR_CODES, GatewayError } from './errors.js';
import { resolveHttpConfig } from './config.js';
import { handleStreamingChatCompletions } from './streaming.js';
import { formatIsoWithOffset } from './clock.js';
import { describeFailure } from './logger.js';

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

// ---------- 处理器 ----------

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

function handleModelListRoute(context) {
  return { status: HTTP_OK, body: buildModelListResponse(context.config, context.clock) };
}

function handleDriversRoute() {
  return { status: HTTP_OK, body: listDrivers() };
}

// GET /_team/meta：客户端启动取一次，拿 INV-14 的判定依据（契约 02 §3.8）。
// 两个值都必须是"实际生效"的那一份：virtualModel 复用 /v1/models 的同一个解析函数，
// providerIds 是注册适配器时真正交给 ctx.llm 的数组（经 deps 注入），网关不另算一份。
// 无副作用、无凭证、不读 session：部署方改配置后，客户端不必重新打包就能跟上。
function handleMetaRoute(context) {
  return {
    status: HTTP_OK,
    body: {
      virtualModel: resolveVirtualModelId(context.config),
      providerIds: context.providerIds,
    },
  };
}

// POST /_team/models/probe：探测可用模型（只在内存里跑一次，绝不落盘）
async function handleModelProbeRoute(context) {
  const probeResult = await probeModels({
    body: context.body ?? {},
    dataRoot: context.dataRoot,
    logger: context.logger,
    fetchImpl: context.fetchImpl,
  });
  return { status: HTTP_OK, body: probeResult };
}

// GET /_team/platforms：平台清单（用户覆盖 > 内置默认；缺失/损坏时返回空数组而不是 500）
async function handlePlatformListRoute(context) {
  const platforms = await loadPlatformPresets({ dataRoot: context.dataRoot, logger: context.logger });
  return { status: HTTP_OK, body: { platforms } };
}

async function handleGroupListRoute(context) {
  const groups = await listGroupsWithSummary(context.config, {
    dataRoot: context.dataRoot,
    logger: context.logger,
    fetchImpl: context.fetchImpl,
  });
  return { status: HTTP_OK, body: { groups } };
}

async function handleGroupDetailRoute(context) {
  const group = findGroup(context.config, context.params.id);
  if (!group) {
    throw new GatewayError(ERROR_CODES.GROUP_NOT_FOUND, `群不存在：${context.params.id}`);
  }
  const [groupWithSummary] = await listGroupsWithSummary({ groups: [group] }, {
    dataRoot: context.dataRoot,
    logger: context.logger,
    fetchImpl: context.fetchImpl,
  });
  // lastUpdated 只属于列表出参（详情形状不变）：这里显式摘掉
  const groupWithoutLastUpdated = { ...groupWithSummary };
  delete groupWithoutLastUpdated.lastUpdated;
  return { status: HTTP_OK, body: { group: groupWithoutLastUpdated } };
}

async function handleGroupCreateRoute(context) {
  const createdGroup = await addGroup(context.body, { dataRoot: context.dataRoot, logger: context.logger });
  return { status: HTTP_CREATED, body: { group: createdGroup } };
}

async function handleGroupRemoveRoute(context) {
  const removeResult = await removeGroup(context.params.id, { dataRoot: context.dataRoot, logger: context.logger });
  return { status: HTTP_OK, body: removeResult };
}

async function handleGroupModelsRoute(context) {
  const group = findGroup(context.config, context.params.id);
  if (!group) {
    throw new GatewayError(ERROR_CODES.GROUP_NOT_FOUND, `群不存在：${context.params.id}`);
  }
  const models = await fetchGroupModels(group, {
    dataRoot: context.dataRoot,
    logger: context.logger,
    fetchImpl: context.fetchImpl,
  });
  return { status: HTTP_OK, body: { models } };
}

async function handleGroupVerifyRoute(context) {
  const group = findGroup(context.config, context.params.id);
  if (!group) {
    throw new GatewayError(ERROR_CODES.GROUP_NOT_FOUND, `群不存在：${context.params.id}`);
  }
  const verifyResult = await verifyGroup(group, {
    dataRoot: context.dataRoot,
    logger: context.logger,
    fetchImpl: context.fetchImpl,
  });
  // 只回报结论，不改任何状态（不写映射、不记请求行）
  return { status: HTTP_OK, body: verifyResult };
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
async function handleFriendGroupListRoute(context) {
  const friendGroups = listFriendGroups(context.config, { logger: context.logger });
  const groupsWithCursor = await Promise.all(
    friendGroups.map(async (friendGroup) => ({
      ...friendGroup,
      cursor: await readGroupCursor(friendGroup.id, { dataRoot: context.dataRoot, logger: context.logger }),
    })),
  );
  return { status: HTTP_OK, body: { groups: groupsWithCursor } };
}

// POST /_team/friend-groups：创建/修改（同 id 覆盖）
async function handleFriendGroupSaveRoute(context) {
  const savedGroup = await saveFriendGroup(context.body, {
    dataRoot: context.dataRoot,
    logger: context.logger,
  });
  return { status: HTTP_CREATED, body: { group: savedGroup } };
}

// DELETE /_team/friend-groups/:id：被会话引用时 409 + 引用计数
async function handleFriendGroupRemoveRoute(context) {
  const removeResult = await deleteFriendGroup(context.params.id, {
    dataRoot: context.dataRoot,
    logger: context.logger,
  });
  return { status: HTTP_OK, body: removeResult };
}

async function handleSessionEventsRoute(context) {
  const events = await readSessionEvents(context.params.id, {
    dataRoot: context.dataRoot,
    logger: context.logger,
    // 聊天流按群隔离：只返回属于该群的事件；不传返回全部
    groupId: parseGroupId(context.incomingRequest),
  });
  return { status: HTTP_OK, body: { events } };
}

async function handleSessionStatsRoute(context) {
  const rows = await readRequestRows({
    dataRoot: context.dataRoot,
    logger: context.logger,
    sessionId: context.params.id,
    // 聊天流按群隔离：只返回 account.id === groupId 的行；不传返回全部
    groupId: parseGroupId(context.incomingRequest),
    limit: parseLimit(context.incomingRequest),
  });
  // §10 出参裁剪：startedAtMs / usage 是内部字段，只留契约里的字段 + sessionId
  return { status: HTTP_OK, body: { rows: rows.map(toPublicRequestRow) } };
}

async function handleGlobalStatsRoute(context) {
  const rows = await readRequestRows({ dataRoot: context.dataRoot, logger: context.logger });
  return { status: HTTP_OK, body: buildGlobalStats(rows) };
}

function handleExportRoute(context) {
  return { status: HTTP_OK, body: exportGroups(context.config) };
}

async function handleImportRoute(context) {
  const importResult = await importGroups(context.body, {
    dataRoot: context.dataRoot,
    logger: context.logger,
    mode: context.body?.mode ?? 'merge',
    confirm: context.body?.confirm === true,
  });
  return { status: HTTP_OK, body: importResult };
}

// 事件写入是 best-effort：失败只告警，不能让"切换模型"整体失败
async function appendEventSafely(context, sessionEvent) {
  try {
    await appendSessionEvent(context.params.id, sessionEvent, { dataRoot: context.dataRoot });
  } catch (eventError) {
    context.logger.warn(`会话事件写入失败：${describeFailure(eventError)}`);
  }
}

// ---------- 路由表 ----------

export const ROUTES = Object.freeze([
  { method: 'POST', pattern: '/v1/chat/completions', handler: handleChatCompletionsRoute },
  { method: 'GET', pattern: '/v1/models', handler: handleModelListRoute },
  { method: 'GET', pattern: `${API_PREFIX}/drivers`, handler: handleDriversRoute },
  { method: 'GET', pattern: `${API_PREFIX}/platforms`, handler: handlePlatformListRoute },
  { method: 'POST', pattern: `${API_PREFIX}/models/probe`, handler: handleModelProbeRoute },
  // 顺序敏感：current 是保留字，必须排在 :id 前面，否则会被当成 id 抢走
  { method: 'GET', pattern: `${API_PREFIX}/sessions/current`, handler: handleCurrentSessionRoute },
  { method: 'GET', pattern: `${API_PREFIX}/sessions/:id`, handler: handleSessionDetailRoute },
  { method: 'GET', pattern: `${API_PREFIX}/groups`, handler: handleGroupListRoute },
  { method: 'POST', pattern: `${API_PREFIX}/groups`, handler: handleGroupCreateRoute },
  { method: 'GET', pattern: `${API_PREFIX}/groups/:id`, handler: handleGroupDetailRoute },
  { method: 'DELETE', pattern: `${API_PREFIX}/groups/:id`, handler: handleGroupRemoveRoute },
  { method: 'GET', pattern: `${API_PREFIX}/friend-groups`, handler: handleFriendGroupListRoute },
  { method: 'POST', pattern: `${API_PREFIX}/friend-groups`, handler: handleFriendGroupSaveRoute },
  { method: 'DELETE', pattern: `${API_PREFIX}/friend-groups/:id`, handler: handleFriendGroupRemoveRoute },
  { method: 'GET', pattern: `${API_PREFIX}/groups/:id/models`, handler: handleGroupModelsRoute },
  { method: 'POST', pattern: `${API_PREFIX}/groups/:id/verify`, handler: handleGroupVerifyRoute },
  { method: 'GET', pattern: `${API_PREFIX}/session/:id/model`, handler: handleSessionModelReadRoute },
  { method: 'PUT', pattern: `${API_PREFIX}/session/:id/model`, handler: handleSessionModelWriteRoute },
  { method: 'GET', pattern: `${API_PREFIX}/session/:id/target`, handler: handleSessionTargetReadRoute },
  { method: 'PUT', pattern: `${API_PREFIX}/session/:id/target`, handler: handleSessionTargetWriteRoute },
  { method: 'GET', pattern: `${API_PREFIX}/session/:id/events`, handler: handleSessionEventsRoute },
  { method: 'GET', pattern: `${API_PREFIX}/stats/session/:id`, handler: handleSessionStatsRoute },
  { method: 'GET', pattern: `${API_PREFIX}/stats/global`, handler: handleGlobalStatsRoute },
  { method: 'GET', pattern: `${API_PREFIX}/export`, handler: handleExportRoute },
  { method: 'POST', pattern: `${API_PREFIX}/import`, handler: handleImportRoute },
  // 客户端元信息（契约 02 §2.9 #26）：只读、无副作用，客户端启动取一次
  { method: 'GET', pattern: `${API_PREFIX}/meta`, handler: handleMetaRoute },
].map((route) => ({ ...route, segments: route.pattern.split('/').filter((segment) => segment.length > 0) })));

// 单段匹配：`:` 开头为参数占位，其余按字面比较
function matchRoutePattern(patternSegments, pathSegments) {
  if (patternSegments.length !== pathSegments.length) {
    return null;
  }
  const routeParams = {};
  for (const [segmentIndex, patternSegment] of patternSegments.entries()) {
    if (patternSegment.startsWith(':')) {
      routeParams[patternSegment.slice(1)] = decodeURIComponent(pathSegments[segmentIndex]);
      continue;
    }
    if (patternSegment !== pathSegments[segmentIndex]) {
      return null;
    }
  }
  return routeParams;
}

// 分发：先找得到路径，再看方法；路径命中但方法不对要报 405 而不是 404
export function findRoute(method, pathname) {
  const pathSegments = pathname.split('/').filter((segment) => segment.length > 0);
  let methodMismatch = false;
  for (const route of ROUTES) {
    const routeParams = matchRoutePattern(route.segments, pathSegments);
    if (!routeParams) {
      continue;
    }
    if (route.method !== method) {
      methodMismatch = true;
      continue;
    }
    return { route, params: routeParams };
  }
  return methodMismatch ? { methodMismatch: true } : null;
}
