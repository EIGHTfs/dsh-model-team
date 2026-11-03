// 会话目标回落：本会话没绑定时，按顺序推断该用哪个模型（契约见 docs/19-会话目标回落规则.md）。
// 顺序：本会话映射 → 父链递归向上（最近命中）→ 其它已绑定会话中 updatedAt 最新者 → session.fallbackGroupId 的 defaultModel。
// 原则：全程 try/catch——宿主服务缺失、映射文件损坏都只是**跳过该级**，绝不 500；
//      推断结果不写回本会话映射（避免把推断冒充成用户显式选择），只由调用方记 targetSource。

import { ERROR_CODES, GatewayError } from './errors.js';
import { defaultLogger, describeFailure } from './logger.js';
import { findHostSessionById } from './session-current.js';
import { listSessionTargets, readSessionTarget } from './session-store.js';

// 目标来源标记：与请求行/端点出参同名同值
export const TARGET_SOURCE = Object.freeze({
  EXPLICIT: 'explicit',
  PARENT: 'parent',
  LAST_SESSION: 'last-session',
  FALLBACK_GROUP: 'fallback-group',
});

// 父链最多向上找这么多层：防止异常数据构造出超长链（同时兜住成环）
const MAX_PARENT_DEPTH = 32;

// 取父会话 id：兼容 header.parentSession 与 header.parentSessionId 两种字段
function readParentSessionId(hostSession) {
  const header = hostSession?.header ?? hostSession ?? null;
  const rawParentId = header?.parentSession ?? header?.parentSessionId;
  if (typeof rawParentId !== 'string') {
    return null;
  }
  const trimmedParentId = rawParentId.trim();
  return trimmedParentId.length > 0 ? trimmedParentId : null;
}

// 父链（就近在前）：[父, 祖父, …]；拿不到宿主会话对象或没有父时返回 []
export async function readParentChain(sessionId, sessionService, { logger = defaultLogger } = {}) {
  if (!sessionId || !sessionService) {
    return [];
  }

  const parentChain = [];
  const visitedSessionIds = new Set([sessionId]);
  let currentSessionId = sessionId;

  while (parentChain.length < MAX_PARENT_DEPTH) {
    let hostSession;
    try {
      hostSession = await findHostSessionById(sessionService, currentSessionId);
    } catch (lookupError) {
      logger.warn(`父链查询失败，按无父会话处理：${describeFailure(lookupError)}`);
      break;
    }

    const parentSessionId = readParentSessionId(hostSession);
    if (!parentSessionId || visitedSessionIds.has(parentSessionId)) {
      break;
    }
    parentChain.push(parentSessionId);
    visitedSessionIds.add(parentSessionId);
    currentSessionId = parentSessionId;
  }

  return parentChain;
}

// 其它已绑定会话中 updatedAt 最新的那个（排除本会话）；没有返回 null
export async function findLatestBoundSession({ dataRoot, excludeSessionId = null, logger = defaultLogger } = {}) {
  const sessionTargets = await listSessionTargets({ dataRoot, logger });
  const candidates = sessionTargets
    .filter((entry) => entry.target && entry.sessionId && entry.sessionId !== excludeSessionId)
    .map((entry) => ({ ...entry, updatedAtMs: Date.parse(entry.updatedAt ?? '') }))
    .filter((entry) => Number.isFinite(entry.updatedAtMs))
    .sort((leftEntry, rightEntry) => rightEntry.updatedAtMs - leftEntry.updatedAtMs);

  return candidates[0] ?? null;
}

// 完整回落链：返回 { target, source }；一级都没有时 target 为 null
export async function resolveSessionTargetWithFallback({
  sessionId,
  dataRoot,
  config,
  sessionService = null,
  logger = defaultLogger,
} = {}) {
  // 1) 本会话映射
  try {
    if (sessionId) {
      const explicitTarget = await readSessionTarget(sessionId, { dataRoot, logger });
      if (explicitTarget) {
        return { target: explicitTarget, source: TARGET_SOURCE.EXPLICIT };
      }
    }
  } catch (readError) {
    logger.warn(`本会话映射读取失败，继续回落：${describeFailure(readError)}`);
  }

  // 2) 父链递归向上：取最近命中的祖先
  try {
    const parentChain = await readParentChain(sessionId, sessionService, { logger });
    for (const parentSessionId of parentChain) {
      try {
        const parentTarget = await readSessionTarget(parentSessionId, { dataRoot, logger });
        if (parentTarget) {
          return { target: parentTarget, source: TARGET_SOURCE.PARENT };
        }
      } catch (parentReadError) {
        logger.warn(`父会话 ${parentSessionId} 映射读取失败，继续向上：${describeFailure(parentReadError)}`);
      }
    }
  } catch (chainError) {
    logger.warn(`父链解析失败，继续回落：${describeFailure(chainError)}`);
  }

  // 3) 其它会话中最近绑定过模型的那个
  try {
    const latestBoundSession = await findLatestBoundSession({ dataRoot, excludeSessionId: sessionId, logger });
    if (latestBoundSession) {
      return { target: latestBoundSession.target, source: TARGET_SOURCE.LAST_SESSION };
    }
  } catch (latestError) {
    logger.warn(`最近绑定会话查询失败，继续回落：${describeFailure(latestError)}`);
  }

  // 4) 兜底群 defaultModel（既有行为）：配置了群却找不到 → 明确报 404，而不是静默跳过
  const fallbackGroupId = config?.session?.fallbackGroupId ?? null;
  if (fallbackGroupId) {
    const fallbackGroup = (config?.groups ?? []).find((group) => group.id === fallbackGroupId) ?? null;
    if (!fallbackGroup) {
      throw new GatewayError(ERROR_CODES.GROUP_NOT_FOUND, `兜底群不存在：${fallbackGroupId}`);
    }
    if (typeof fallbackGroup.defaultModel === 'string' && fallbackGroup.defaultModel.length > 0) {
      return {
        target: { type: 'model', id: fallbackGroup.defaultModel, platformId: fallbackGroup.id },
        source: TARGET_SOURCE.FALLBACK_GROUP,
      };
    }
  }

  return { target: null, source: null };
}
