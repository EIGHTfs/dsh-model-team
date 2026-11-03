// 好友分组（FriendGroup）配置与轮询游标状态（docs/11 §35-48）。
// 需求意图：把跨平台的同名/同类模型聚合成一个"轮换组"，按策略派活（负载均衡 / 容灾）；
//          游标必须按分组全局共享并落盘，重启后从中断处继续（INV-12），否则组内会被反复压到同一个成员。
// 思路：分组配置存 config.json 的 friendGroups[]（复用 config 的原子写）；游标单独落 groups-state.json；
//      删除前统计会话引用，被引用就拒绝（409 + 引用计数），避免删掉别人正在用的分组。

import fs from 'node:fs/promises';
import path from 'node:path';
import { getDataRoot, getGroupStatePath, getSessionsDirectory, SESSION_MAPPING_EXTENSION } from './paths.js';
import { readConfig, writeConfig } from './config.js';
import { JSON_INDENT_WIDTH, TEMPORARY_FILE_SUFFIX } from './constants.js';
import { defaultLogger, describeFailure } from './logger.js';
import { ERROR_CODES, GatewayError } from './errors.js';
import { TARGET_TYPE_GROUP, normalizeSessionTarget } from './session-target.js';

// 两种调度策略（docs/11 §43/§58）
export const STRATEGIES = Object.freeze({
  ROUND_ROBIN: 'round-robin',
  FALLBACK: 'fallback',
});

// 策略的中文展示名：系统事件文案里直出（前端不翻译，避免两边各写一份）
export const FRIEND_GROUP_STRATEGY_LABELS = Object.freeze({
  [STRATEGIES.ROUND_ROBIN]: '轮询',
  [STRATEGIES.FALLBACK]: '故障转移',
});

// 配置字段名（与 groups 平级）
export const FRIEND_GROUPS_FIELD = 'friendGroups';

// 分组 id 会进 URL 与会话目标，只允许安全字符
export const FRIEND_GROUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MAX_FRIEND_GROUP_ID_LENGTH = 64;

// 缺省策略：轮询（docs/11 §43）
export const DEFAULT_STRATEGY = STRATEGIES.ROUND_ROBIN;

// 状态文件的 JSON 缩进与临时文件后缀（与 config 一致，便于人工查看）
// 状态文件里的游标字段
const STATE_CURSORS_FIELD = 'cursors';

// 校验单个成员：平台与模型都必须给
function normalizeMember(memberCandidate, memberIndex) {
  const platformId = memberCandidate?.platformId;
  const modelId = memberCandidate?.modelId;
  if (typeof platformId !== 'string' || platformId.trim().length === 0) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, `members[${memberIndex}] 缺少 platformId`);
  }
  if (typeof modelId !== 'string' || modelId.trim().length === 0) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, `members[${memberIndex}] 缺少 modelId`);
  }
  return { platformId: platformId.trim(), modelId: modelId.trim() };
}

// 校验并归一化一个分组配置
export function normalizeFriendGroup(groupPayload) {
  if (typeof groupPayload !== 'object' || groupPayload === null || Array.isArray(groupPayload)) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, '分组配置必须是对象');
  }
  const groupId = typeof groupPayload.id === 'string' ? groupPayload.id.trim() : '';
  if (groupId.length === 0 || groupId.length > MAX_FRIEND_GROUP_ID_LENGTH || !FRIEND_GROUP_ID_PATTERN.test(groupId)) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, `分组 id 不合法：${groupPayload.id ?? '(空)'}`, {
      hint: '只允许字母、数字、点、下划线、连字符，且以字母或数字开头',
    });
  }
  if (typeof groupPayload.name !== 'string' || groupPayload.name.trim().length === 0) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, '分组缺少 name');
  }
  const strategy = groupPayload.strategy ?? DEFAULT_STRATEGY;
  if (!Object.values(STRATEGIES).includes(strategy)) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, `strategy 必须是 ${STRATEGIES.ROUND_ROBIN} 或 ${STRATEGIES.FALLBACK}`, {
      hint: `收到：${strategy}`,
    });
  }
  if (!Array.isArray(groupPayload.members) || groupPayload.members.length === 0) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, 'members 必须是非空数组', {
      hint: '至少给一个 { platformId, modelId } 成员',
    });
  }

  // 同一成员重复配置没有意义，去重但保留顺序
  const seenMemberKeys = new Set();
  const members = [];
  for (const [memberIndex, memberCandidate] of groupPayload.members.entries()) {
    const member = normalizeMember(memberCandidate, memberIndex);
    const memberKey = `${member.platformId}::${member.modelId}`;
    if (seenMemberKeys.has(memberKey)) {
      continue;
    }
    seenMemberKeys.add(memberKey);
    members.push(member);
  }

  return { id: groupId, name: groupPayload.name.trim(), strategy, members };
}

// 列表：只返回合法条目（脏配置跳过并告警，不拖垮整个列表）
export function listFriendGroups(config, { logger = defaultLogger } = {}) {
  const rawGroups = Array.isArray(config?.[FRIEND_GROUPS_FIELD]) ? config[FRIEND_GROUPS_FIELD] : [];
  const friendGroups = [];
  for (const rawGroup of rawGroups) {
    try {
      friendGroups.push(normalizeFriendGroup(rawGroup));
    } catch (normalizeError) {
      logger.warn(`跳过非法的好友分组配置：${describeFailure(normalizeError)}`);
    }
  }
  return friendGroups;
}

// 按 id 取分组（缺省 null）
export function findFriendGroup(config, groupId, options = {}) {
  return listFriendGroups(config, options).find((friendGroup) => friendGroup.id === groupId) ?? null;
}

// 创建/修改：同 id 覆盖（POST 语义是 upsert）
export async function saveFriendGroup(groupPayload, { dataRoot = getDataRoot(), logger = defaultLogger } = {}) {
  const normalizedGroup = normalizeFriendGroup(groupPayload);
  const config = await readConfig({ dataRoot, logger });
  const existingGroups = Array.isArray(config[FRIEND_GROUPS_FIELD]) ? [...config[FRIEND_GROUPS_FIELD]] : [];
  const existingIndex = existingGroups.findIndex((group) => group?.id === normalizedGroup.id);
  if (existingIndex >= 0) {
    existingGroups[existingIndex] = normalizedGroup;
  } else {
    existingGroups.push(normalizedGroup);
  }
  await writeConfig({ ...config, [FRIEND_GROUPS_FIELD]: existingGroups }, { dataRoot, logger });
  logger.info(`好友分组已保存：${normalizedGroup.id}（策略 ${normalizedGroup.strategy}，成员 ${normalizedGroup.members.length}）`);
  return normalizedGroup;
}

// 统计有多少会话把这个分组当目标（删除前的引用保护）
export async function countSessionsReferencingGroup(groupId, { dataRoot = getDataRoot(), logger = defaultLogger } = {}) {
  const sessionsDirectory = getSessionsDirectory(dataRoot);
  let directoryEntries;
  try {
    directoryEntries = await fs.readdir(sessionsDirectory, { withFileTypes: true });
  } catch (readdirError) {
    if (readdirError?.code !== 'ENOENT') {
      logger.warn(`会话目录读取失败，引用计数按 0 处理：${describeFailure(readdirError)}`);
    }
    return { count: 0, sessionIds: [] };
  }

  const referencingSessionIds = [];
  for (const directoryEntry of directoryEntries) {
    if (!directoryEntry.isFile() || !directoryEntry.name.endsWith(SESSION_MAPPING_EXTENSION)) {
      continue;
    }
    try {
      const rawMappingText = await fs.readFile(`${sessionsDirectory}/${directoryEntry.name}`, 'utf8');
      const storedMapping = JSON.parse(rawMappingText);
      const sessionTarget = normalizeSessionTarget(storedMapping?.target ?? storedMapping);
      if (sessionTarget?.type === TARGET_TYPE_GROUP && sessionTarget.id === groupId) {
        referencingSessionIds.push(storedMapping?.sessionId ?? decodeURIComponent(directoryEntry.name.replace(/\.json$/, '')));
      }
    } catch {
      // 单条脏数据不影响计数
    }
  }
  return { count: referencingSessionIds.length, sessionIds: referencingSessionIds };
}

// 删除：被引用时 409（带引用计数），否则从配置移除
export async function deleteFriendGroup(groupId, { dataRoot = getDataRoot(), logger = defaultLogger } = {}) {
  const referenceStats = await countSessionsReferencingGroup(groupId, { dataRoot, logger });
  if (referenceStats.count > 0) {
    throw new GatewayError(ERROR_CODES.FRIEND_GROUP_IN_USE, `分组 ${groupId} 正被 ${referenceStats.count} 个会话使用`, {
      hint: '先把这些会话切到别的模型/分组再删除',
      details: { referencedSessions: referenceStats.count, sessionIds: referenceStats.sessionIds },
    });
  }

  const config = await readConfig({ dataRoot, logger });
  const existingGroups = Array.isArray(config[FRIEND_GROUPS_FIELD]) ? config[FRIEND_GROUPS_FIELD] : [];
  const remainingGroups = existingGroups.filter((group) => group?.id !== groupId);
  if (remainingGroups.length === existingGroups.length) {
    throw new GatewayError(ERROR_CODES.FRIEND_GROUP_NOT_FOUND, `好友分组不存在：${groupId}`);
  }
  await writeConfig({ ...config, [FRIEND_GROUPS_FIELD]: remainingGroups }, { dataRoot, logger });
  logger.info(`好友分组已删除：${groupId}`);
  return { removed: groupId };
}

// ---------- 游标状态（groups-state.json） ----------

// 读状态：文件不存在/损坏都给空状态（游标从 0 重新开始，不能因此让派发失败）
export async function readGroupState({ dataRoot = getDataRoot(), logger = defaultLogger } = {}) {
  const statePath = getGroupStatePath(dataRoot);
  let rawStateText;
  try {
    rawStateText = await fs.readFile(statePath, 'utf8');
  } catch (readError) {
    if (readError?.code !== 'ENOENT') {
      logger.warn(`分组状态读取失败，按初始状态处理：${describeFailure(readError)}`);
    }
    return { [STATE_CURSORS_FIELD]: {} };
  }
  try {
    const parsedState = JSON.parse(rawStateText);
    const cursors = parsedState?.[STATE_CURSORS_FIELD];
    return { [STATE_CURSORS_FIELD]: typeof cursors === 'object' && cursors !== null ? cursors : {} };
  } catch (parseError) {
    logger.warn(`分组状态损坏，按初始状态处理：${describeFailure(parseError)}`);
    return { [STATE_CURSORS_FIELD]: {} };
  }
}

// 读单个分组的游标（缺省 0）
export async function readGroupCursor(groupId, { dataRoot = getDataRoot(), logger = defaultLogger } = {}) {
  const state = await readGroupState({ dataRoot, logger });
  const storedCursor = state[STATE_CURSORS_FIELD][groupId];
  return Number.isInteger(storedCursor) && storedCursor >= 0 ? storedCursor : 0;
}

// 写单个分组的游标（原子写：同目录临时文件 + rename）
export async function writeGroupCursor(groupId, cursorValue, { dataRoot = getDataRoot(), logger = defaultLogger } = {}) {
  const state = await readGroupState({ dataRoot, logger });
  const nextCursors = { ...state[STATE_CURSORS_FIELD], [groupId]: Math.max(0, Math.trunc(cursorValue)) };
  const statePath = getGroupStatePath(dataRoot);
  const temporaryPath = `${statePath}.${process.pid}${TEMPORARY_FILE_SUFFIX}`;
  const serializedState = `${JSON.stringify({ [STATE_CURSORS_FIELD]: nextCursors }, null, JSON_INDENT_WIDTH)}\n`;

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  try {
    await fs.writeFile(temporaryPath, serializedState, 'utf8');
    await fs.rename(temporaryPath, statePath);
  } catch (writeError) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    logger.warn(`分组状态写入失败（本次派发继续）：${describeFailure(writeError)}`);
  }
  return nextCursors[groupId];
}
