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
import { handleStreamingChatCompletions } from '../transport/streaming.js';
import { formatIsoWithOffset } from '../clock.js';
import { describeFailure } from '../logger.js';

// 成功状态码
const HTTP_OK = 200;
const HTTP_CREATED = 201;

// ---------- 统计 ----------

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

export { handleSessionStatsRoute, handleGlobalStatsRoute };