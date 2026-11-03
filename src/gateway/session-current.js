// 会话查询：当前会话（/_team/sessions/current）与按 id 查会话（/_team/sessions/:id）共用同一套宿主适配。
// 需求意图：客户端是纯 DOM 挂 body，拿不到宿主 props 里的会话标题；服务端能拿到真实会话，
//          所以由后端按 id 兜底查询，避免前端去猜 store 形状。
// 思路：宿主服务在 apply 时可能还没就绪，因此用**惰性 getter**（每次请求再取）；
//      宿主 API 形状未冻结，这里按常见方法/字段做防御式适配，任何异常都收敛成 null（由路由转 404）。

import { ERROR_CODES, GatewayError } from './errors.js';
import { defaultLogger, describeFailure } from './logger.js';
import { resolveSessionTitle, sessionEventList } from './session-title.js';

// 常见"活跃"判据：状态名或布尔标记
const ACTIVE_STATUS_VALUES = Object.freeze(['running', 'active', 'streaming']);

// 把宿主返回的会话对象归一成我们对外用的最小形状
function toSessionSummary(rawSession, logger = defaultLogger) {
  if (!rawSession || typeof rawSession !== 'object') {
    return null;
  }
  const sessionId = rawSession.sessionId ?? rawSession.id ?? rawSession.key;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return null;
  }

  const title = typeof rawSession.title === 'string' && rawSession.title.length > 0 ? rawSession.title : undefined;
  const rawActiveAt = rawSession.updatedAt ?? rawSession.lastActiveAt ?? rawSession.activeAt ?? rawSession.mtime;
  const activeAtMs = typeof rawActiveAt === 'number' ? rawActiveAt : Date.parse(rawActiveAt ?? '');
  if (Number.isNaN(activeAtMs) && rawActiveAt !== undefined) {
    logger.warn(`会话 ${sessionId} 的活跃时间无法解析，按未知处理`);
  }
  const isActive = rawSession.running === true
    || rawSession.active === true
    || ACTIVE_STATUS_VALUES.includes(rawSession.status);

  return {
    sessionId,
    title,
    isActive,
    activeAtMs: Number.isFinite(activeAtMs) ? activeAtMs : null,
  };
}

// 从宿主服务里尽可能取出一批会话（不同版本可能叫 list / all / recent）
async function collectSessionCandidates(sessionService) {
  const listMethods = [sessionService.list, sessionService.all, sessionService.recent].filter(
    (method) => typeof method === 'function',
  );
  const candidates = [];
  for (const listMethod of listMethods) {
    const listed = await listMethod.call(sessionService);
    if (Array.isArray(listed)) {
      candidates.push(...listed);
    }
  }
  return candidates;
}

// 惰性解析宿主服务（sessions / sessionTitle 同一套口径）：缺失/抛错都按"没有服务"处理，绝不冒泡成 500
function resolveLazyService(getService, logger, serviceLabel) {
  try {
    return getService?.() ?? null;
  } catch (serviceError) {
    logger.warn(`${serviceLabel} 服务解析失败，按无服务处理：${describeFailure(serviceError)}`);
    return null;
  }
}

// 拿"活会话对象"：sessionTitle.get() 只接受真正的 live Session（有 snapshotEvents 方法）
export async function findHostSessionById(sessionService, sessionId) {
  if (typeof sessionService.get === 'function') {
    const directSession = await sessionService.get(sessionId);
    if (directSession) {
      return directSession;
    }
  }
  const candidates = await collectSessionCandidates(sessionService);
  const normalizedCandidates = candidates.map((candidate) => ({ candidate, summary: toSessionSummary(candidate) }));
  return normalizedCandidates.find((entry) => entry.summary?.sessionId === sessionId)?.candidate ?? null;
}

// 在摘要上补标题：优先 sessionTitle 服务，回退事件流折叠；都没有则省略 title 字段
function withResolvedTitle(sessionSummary, { liveSession, titleService }) {
  if (!sessionSummary) {
    return null;
  }
  const resolvedTitle = resolveSessionTitle(titleService, liveSession, sessionEventList(liveSession));
  // 优先级：sessionTitle 服务快照 → 事件流折叠 → 摘要自带 title（兼容旧数据/桩）→ 省略
  return { ...sessionSummary, title: resolvedTitle ?? sessionSummary.title };
}

// 收集归一后的会话：先看 getCurrent，再合并 list/all/recent（按 id 去重，先到先得）
async function collectNormalizedSessions(sessionService, logger) {
  const normalizedSessions = [];
  if (typeof sessionService.getCurrent === 'function') {
    const currentSession = toSessionSummary(await sessionService.getCurrent(), logger);
    if (currentSession) {
      normalizedSessions.push(currentSession);
    }
  }
  const candidates = await collectSessionCandidates(sessionService);
  for (const candidate of candidates) {
    const normalized = toSessionSummary(candidate, logger);
    if (normalized && !normalizedSessions.some((existing) => existing.sessionId === normalized.sessionId)) {
      normalizedSessions.push(normalized);
    }
  }
  return normalizedSessions;
}

// 选"当前会话"：有活跃的取最近活跃的那个；否则退化为最近更新的那个
export function pickCurrentSession(normalizedSessions) {
  const usableSessions = normalizedSessions.filter((session) => session !== null);
  if (usableSessions.length === 0) {
    return null;
  }
  const activeSessions = usableSessions.filter((session) => session.isActive);
  const pool = activeSessions.length > 0 ? activeSessions : usableSessions;
  return pool.reduce((bestSession, session) => {
    const bestTime = bestSession.activeAtMs ?? 0;
    const sessionTime = session.activeAtMs ?? 0;
    return sessionTime > bestTime ? session : bestSession;
  });
}

// 当前会话来源：getSessionService 必须是惰性 getter（apply 时刻服务可能尚未创建）
export function createHostSessionSource({ getSessionService, getTitleService, logger = defaultLogger } = {}) {
  return async function resolveCurrentSession() {
    const sessionService = resolveLazyService(getSessionService, logger, 'sessions');
    if (!sessionService) {
      return null;
    }
    try {
      const currentSession = pickCurrentSession(await collectNormalizedSessions(sessionService, logger));
      if (!currentSession) {
        return null;
      }
      const liveSession = await findHostSessionById(sessionService, currentSession.sessionId);
      return withResolvedTitle(currentSession, {
        liveSession,
        titleService: resolveLazyService(getTitleService, logger, 'sessionTitle'),
      });
    } catch (lookupError) {
      logger.warn(`会话查询失败，按无活跃会话处理：${describeFailure(lookupError)}`);
      return null;
    }
  };
}

// 按 id 查会话：复用同一套适配（getCurrent + list/all/recent），匹配 sessionId
export function createHostSessionLookup({ getSessionService, getTitleService, logger = defaultLogger } = {}) {
  return async function findSessionById(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return null;
    }
    const sessionService = resolveLazyService(getSessionService, logger, 'sessions');
    if (!sessionService) {
      return null;
    }
    try {
      const normalizedSessions = await collectNormalizedSessions(sessionService, logger);
      const matchedSession = normalizedSessions.find((session) => session.sessionId === sessionId) ?? null;
      if (!matchedSession) {
        return null;
      }
      const liveSession = await findHostSessionById(sessionService, sessionId);
      return withResolvedTitle(matchedSession, {
        liveSession,
        titleService: resolveLazyService(getTitleService, logger, 'sessionTitle'),
      });
    } catch (lookupError) {
      logger.warn(`按 id 查询会话失败，按不存在处理：${describeFailure(lookupError)}`);
      return null;
    }
  };
}

// 无来源（独立服务/测试未注入时）：始终没有当前会话
export function createEmptySessionSource() {
  return async () => null;
}

// 无按 id 查询能力时的缺省实现
export function createEmptySessionLookup() {
  return async () => null;
}

// activeAt 统一成 ISO 字符串（缺失给 null，交由调用方决定展示）
function toActiveAtIso(activeAtMs, fallbackNowMs) {
  const resolvedMs = activeAtMs ?? fallbackNowMs ?? null;
  return resolvedMs === null ? null : new Date(resolvedMs).toISOString();
}

// 路由处理器：当前会话（200 或 404 + no-active-session）
export async function handleCurrentSessionRoute(context) {
  const currentSession = await context.sessionSource?.();

  if (!currentSession) {
    throw new GatewayError(ERROR_CODES.NO_ACTIVE_SESSION, '当前没有活跃会话', {
      hint: '先在 DSH 里打开/新建一个会话，再刷新面板',
    });
  }

  return {
    status: 200,
    body: {
      sessionId: currentSession.sessionId,
      ...(currentSession.title ? { title: currentSession.title } : {}),
      activeAt: toActiveAtIso(currentSession.activeAtMs, context.clock.nowMs()),
    },
  };
}

// 路由处理器：按 id 查会话（200 或 404 + session-not-found）
export async function handleSessionDetailRoute(context) {
  const sessionSummary = await context.sessionLookup?.(context.params.id);

  if (!sessionSummary) {
    throw new GatewayError(ERROR_CODES.SESSION_NOT_FOUND, '会话不存在', {
      hint: '确认会话 id；也可以用 GET /_team/sessions/current 取当前活跃会话',
    });
  }

  return {
    status: 200,
    body: {
      sessionId: sessionSummary.sessionId,
      // title 缺失时直接省略字段（不给 null、也不给空串）
      ...(sessionSummary.title ? { title: sessionSummary.title } : {}),
      activeAt: toActiveAtIso(sessionSummary.activeAtMs, null),
    },
  };
}
