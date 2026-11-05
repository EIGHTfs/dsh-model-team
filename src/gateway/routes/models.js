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

// ---------- 模型与平台元信息 ----------

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

export { handleModelListRoute, handleDriversRoute, handleMetaRoute, handleModelProbeRoute };