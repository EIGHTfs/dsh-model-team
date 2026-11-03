// 调度引擎：把会话目标变成"按策略尝试哪些成员"，并维护轮询游标 / 冷却（docs/11 §50-62）。
// 需求意图：单平台限流或额度耗尽时自动换平台继续干活；round-robin 要真正轮转（INV-12 重启不回退），
//          fallback 要"主优先、失败冷却、全冷却也硬试主"（宁可失败也不让请求无处可去）。
// 思路：本模块只管"选谁、试几次、游标怎么推进"，不碰 HTTP/凭证/驱动；
//      真正调用由 invoke(attempt) 注入，HTTP / 流式 / LlmAdapter 三条路径共用这一份调度语义。

import { API_PREFIX } from './constants.js';
import { modelIdOf } from './model-catalog.js';
import { ERROR_CODES, GatewayError } from './errors.js';
import { defaultLogger } from './logger.js';
import {
  STRATEGIES,
  findFriendGroup,
  readGroupCursor,
  writeGroupCursor,
} from './friend-groups.js';
import { TARGET_TYPE_GROUP, normalizeSessionTarget } from './session-target.js';

// 失败成员的冷却时长（docs/11 §61：缺省 60000ms，不做主动探活）
export const MEMBER_COOLDOWN_MS = 60_000;

// 单次请求最多尝试的成员次数：缺省 = 成员数（docs/11 §56）
export const DEFAULT_MAX_ROTATION_ATTEMPTS = null;

// 冷却为进程内状态（重启即清空）：这里刻意不落盘——落盘会让重启后继续跳过主成员，
// 与"重启即恢复"的运维预期相反。若要改成持久化，必须先改 docs/11 的语义再动这里。
const memberCooldownDeadlines = new Map();

// 冷却键：同一分组内成员唯一
function buildMemberKey(groupId, member) {
  return `${groupId}::${member.platformId}::${member.modelId}`;
}

// 测试用：清空所有冷却
export function resetMemberCooldowns() {
  memberCooldownDeadlines.clear();
}

// 某成员是否还在冷却
export function isMemberCoolingDown(memberKey, nowMs) {
  const deadlineMs = memberCooldownDeadlines.get(memberKey);
  return typeof deadlineMs === 'number' && deadlineMs > nowMs;
}

// 标记成员进入冷却
export function markMemberCooldown(memberKey, nowMs, cooldownMs = MEMBER_COOLDOWN_MS) {
  memberCooldownDeadlines.set(memberKey, nowMs + cooldownMs);
}

// 解析 {type:'model', id} 的所属平台（docs/10/11 口径：禁止猜）
// 1) 显式 platformId 直接用  2) 精确匹配各群模型列表（0 个报错 / 1 个用它 / 多个报 ambiguous + 候选）
// 3) 整个配置只有一个群才允许兜底，并打 info 说明
export function resolveModelPlatform({ config, target, logger = defaultLogger }) {
  if (typeof target?.platformId === 'string' && target.platformId.length > 0) {
    return target.platformId;
  }

  const groups = Array.isArray(config?.groups) ? config.groups : [];
  const matchedPlatformIds = [];
  for (const group of groups) {
    const staticModels = Array.isArray(group?.models?.static) ? group.models.static : [];
    const modelIds = staticModels.map((modelEntry) => modelIdOf(modelEntry));
    if (typeof group?.defaultModel === 'string') {
      modelIds.push(group.defaultModel);
    }
    if (modelIds.filter((modelId) => modelId === target?.id).length > 0) {
      matchedPlatformIds.push(group.id);
    }
  }

  if (matchedPlatformIds.length === 1) {
    return matchedPlatformIds[0];
  }
  if (matchedPlatformIds.length > 1) {
    throw new GatewayError(ERROR_CODES.AMBIGUOUS_MODEL, `模型 ${target.id} 在多个群中存在，无法确定平台`, {
      hint: `给会话目标补 platformId（PUT ${API_PREFIX}/session/:id/target）`,
      details: { candidates: matchedPlatformIds.map((platformId) => ({ platformId, modelId: target.id })) },
    });
  }
  if (groups.length === 1) {
    logger.info(`模型 ${target.id} 未在群模型列表命中，但配置里只有一个群，按唯一群兜底：${groups[0].id}`);
    return groups[0].id;
  }
  throw new GatewayError(ERROR_CODES.MODEL_UNRESOLVED, `无法确定模型 ${target.id} 所属平台`, {
    hint: `给会话目标补 platformId，或先拉取该群模型列表（GET ${API_PREFIX}/groups/:id/models）`,
  });
}

// 单模型目标：一次尝试
async function dispatchModelTarget({ config, target, invoke, logger }) {
  const platformId = resolveModelPlatform({ config, target, logger });
  const attempt = { groupId: null, platformId, modelId: target.id };
  const invokeResult = await invoke(attempt);
  return {
    ok: invokeResult.ok === true,
    target,
    attempt,
    result: invokeResult,
    attemptsTried: [attempt],
    errors: invokeResult.ok === true ? [] : [invokeResult.error ?? null],
  };
}

// round-robin：游标全局共享，每次尝试都推进（成功/失败都 +1），成功即停
async function dispatchRoundRobin({ friendGroup, invoke, dataRoot, logger, maxAttempts }) {
  const members = friendGroup.members;
  const attemptLimit = Math.min(members.length, maxAttempts ?? members.length);
  const startingCursor = (await readGroupCursor(friendGroup.id, { dataRoot, logger })) % members.length;
  const attemptsTried = [];
  const errors = [];
  let currentCursor = startingCursor;

  for (let attemptIndex = 0; attemptIndex < attemptLimit; attemptIndex += 1) {
    const member = members[currentCursor];
    const attempt = { groupId: friendGroup.id, platformId: member.platformId, modelId: member.modelId };
    attemptsTried.push(attempt);

    const invokeResult = await invoke(attempt);
    // 无论成败都推进游标并落盘：崩溃/重启后不会重复压同一个成员（INV-12）
    currentCursor = (currentCursor + 1) % members.length;
    await writeGroupCursor(friendGroup.id, currentCursor, { dataRoot, logger });

    if (invokeResult.ok === true) {
      return { ok: true, target: null, attempt, result: invokeResult, attemptsTried, errors };
    }
    errors.push(invokeResult.error ?? null);
  }

  return {
    ok: false,
    attempt: attemptsTried[attemptsTried.length - 1] ?? null,
    result: null,
    attemptsTried,
    errors,
  };
}

// fallback：主优先，失败成员进入冷却，全冷却时用主成员硬试一次
async function dispatchFallback({ friendGroup, invoke, now, logger }) {
  const members = friendGroup.members;
  const nowMs = now();
  const primaryMember = members[0];
  const healthyMembers = members.filter(
    (member) => !isMemberCoolingDown(buildMemberKey(friendGroup.id, member), nowMs),
  );
  const attemptedMembers = healthyMembers.length > 0 ? healthyMembers : [primaryMember];
  const usedPrimaryAsLastResort = healthyMembers.length === 0;
  if (usedPrimaryAsLastResort) {
    logger.warn(`分组 ${friendGroup.id} 全部成员冷却中，按主成员硬试一次`);
  }

  const attemptsTried = [];
  const errors = [];
  for (const member of attemptedMembers) {
    const attempt = { groupId: friendGroup.id, platformId: member.platformId, modelId: member.modelId };
    attemptsTried.push(attempt);

    const invokeResult = await invoke(attempt);
    if (invokeResult.ok === true) {
      return { ok: true, attempt, result: invokeResult, attemptsTried, errors, usedPrimaryAsLastResort };
    }
    errors.push(invokeResult.error ?? null);
    markMemberCooldown(buildMemberKey(friendGroup.id, member), nowMs);
  }

  return {
    ok: false,
    attempt: attemptsTried[attemptsTried.length - 1] ?? null,
    result: null,
    attemptsTried,
    errors,
    usedPrimaryAsLastResort,
  };
}

// 调度入口：返回 { ok, attempt, result, attemptsTried, errors }
// invoke(attempt) 由调用方提供，返回 { ok:boolean, error?: {code,message,upstreamStatus?}, ... }
export async function dispatchWithRotation({
  config,
  target,
  dataRoot,
  logger = defaultLogger,
  now = Date.now,
  invoke,
  maxAttempts = DEFAULT_MAX_ROTATION_ATTEMPTS,
} = {}) {
  const normalizedTarget = normalizeSessionTarget(target);
  if (!normalizedTarget) {
    throw new GatewayError(ERROR_CODES.MODEL_UNRESOLVED, '会话没有可用的模型目标', {
      hint: `先 PUT ${API_PREFIX}/session/:id/target 或 PUT /_team/session/:id/model`,
    });
  }

  if (normalizedTarget.type !== TARGET_TYPE_GROUP) {
    return dispatchModelTarget({ config, target: normalizedTarget, invoke, logger });
  }

  const friendGroup = findFriendGroup(config, normalizedTarget.id, { logger });
  if (!friendGroup) {
    throw new GatewayError(ERROR_CODES.FRIEND_GROUP_NOT_FOUND, `好友分组不存在：${normalizedTarget.id}`);
  }

  const dispatchResult = friendGroup.strategy === STRATEGIES.FALLBACK
    ? await dispatchFallback({ friendGroup, invoke, now, logger })
    : await dispatchRoundRobin({ friendGroup, invoke, dataRoot, logger, maxAttempts });

  return { ...dispatchResult, target: normalizedTarget };
}
