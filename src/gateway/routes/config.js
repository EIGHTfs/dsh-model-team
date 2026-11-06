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
  findGroup,
  importGroups,
  listGroupsWithSummary,
  removeGroup,
  verifyGroup,
} from '../group/groups.js';
import { handleStreamingChatCompletions } from '../transport/streaming.js';
import { formatIsoWithOffset } from '../clock.js';
import { describeFailure } from '../logger.js';
import { exportBackup, restoreCredentialFiles } from '../config/backup.js';

// 成功状态码
const HTTP_OK = 200;
const HTTP_CREATED = 201;

// ---------- 配置与导入导出 ----------

async function handlePlatformListRoute(context) {
  const platforms = await loadPlatformPresets({ dataRoot: context.dataRoot, logger: context.logger });
  return { status: HTTP_OK, body: { platforms } };
}

// 导出：完整备份（配置 + 凭据本体）。收集规则与护栏都在 config/backup.js
async function handleExportRoute(context) {
  const backup = await exportBackup({
    config: context.config,
    dataRoot: context.dataRoot,
    logger: context.logger,
  });
  return { status: HTTP_OK, body: backup };
}

// 导入：先还原凭据文件，再合并群配置。
// 顺序有讲究——群配置里的 apiKeyRef 指向这些文件，先落文件才不会出现"群已导入但凭证还缺"的中间态
async function handleImportRoute(context) {
  const { restoredCredentialFiles, skippedRefs } = await restoreCredentialFiles({
    credentialFiles: context.body?.credentialFiles,
    dataRoot: context.dataRoot,
    logger: context.logger,
  });
  const importResult = await importGroups(context.body, {
    dataRoot: context.dataRoot,
    logger: context.logger,
    mode: context.body?.mode ?? 'merge',
    confirm: context.body?.confirm === true,
  });
  return { status: HTTP_OK, body: { ...importResult, restoredCredentialFiles, skippedRefs } };
}

// ---------- 路由表 ----------

export { handlePlatformListRoute, handleExportRoute, handleImportRoute };