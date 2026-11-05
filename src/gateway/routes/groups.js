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
import { handleStreamingChatCompletions } from '../transport/streaming.js';
import { formatIsoWithOffset } from '../clock.js';
import { describeFailure } from '../logger.js';

// 成功状态码
const HTTP_OK = 200;
const HTTP_CREATED = 201;

// ---------- 群与好友分组 ----------

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

export { handleGroupListRoute, handleGroupDetailRoute, handleGroupCreateRoute, handleGroupRemoveRoute, handleGroupModelsRoute, handleGroupVerifyRoute, handleFriendGroupListRoute, handleFriendGroupSaveRoute, handleFriendGroupRemoveRoute };