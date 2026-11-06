// 群的部分更新（PATCH /_team/groups/:id）：**合并且只改传入字段**，id 不可变。
//
// 为什么要有它：今天唯一的"改"是整包导入（merge/upsert），为改一个 baseURL 要把整份配置重发一遍，
// 粒度太粗且容易把没打算动的字段一起覆盖。
//
// 三条语义细节（都是"少改坏"的取舍）：
//   1) `auth: {}`（没带 apiKeyRef）→ **保留原引用**，避免一次误提交把群变成"没凭证"；
//   2) `models` 是整体替换，不做逐项合并——模型清单位置很重要（顺序决定默认模型）；
//   3) 模型被移除时给 warnings：扫得到会话目标就点名，扫不到只给通用提示（不猜）。

import fs from 'node:fs/promises';
import path from 'node:path';
import { getSessionsDirectory } from '../config/paths.js';
import { readConfig, writeConfig } from '../config/config.js';
import { ERROR_CODES, GatewayError } from '../errors.js';
import { defaultLogger, describeFailure } from '../logger.js';
import { findGroup, rejectPlaintextCredentials, validateGroupPayload } from './groups.js';

// 允许通过 PATCH 修改的字段（id 明确不在其中：它是凭据文件名与会话目标的锚点）
export const UPDATABLE_GROUP_FIELDS = Object.freeze([
  'name',
  'accessMode',
  'driver',
  'baseURL',
  'auth',
  'models',
  'defaultModel',
  'request',
  'response',
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 只挑白名单字段；id 出现在 body 里由调用方先做"是否与路径一致"的判断
function pickUpdatableFields(patch) {
  const picked = {};
  for (const fieldName of UPDATABLE_GROUP_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, fieldName)) {
      picked[fieldName] = patch[fieldName];
    }
  }
  return picked;
}

// auth 合并：没给 apiKeyRef 就保留原值（空串/非字符串同样视为"没给"）
function mergeAuth(previousAuth, nextAuth) {
  if (nextAuth === undefined) return previousAuth;
  if (!isPlainObject(nextAuth)) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, 'auth 必须是对象');
  }
  const mergedAuth = { ...(previousAuth ?? {}), ...nextAuth };
  const nextApiKeyRef = nextAuth.apiKeyRef;
  if (typeof nextApiKeyRef !== 'string' || nextApiKeyRef.trim().length === 0) {
    if (previousAuth && typeof previousAuth.apiKeyRef === 'string' && previousAuth.apiKeyRef.length > 0) {
      mergedAuth.apiKeyRef = previousAuth.apiKeyRef;
    } else {
      delete mergedAuth.apiKeyRef;
    }
  } else {
    mergedAuth.apiKeyRef = nextApiKeyRef.trim();
  }
  return mergedAuth;
}

// 模型清单里的 id（static 允许字符串或 { id }）
function collectModelIds(models) {
  const staticModels = Array.isArray(models?.static) ? models.static : [];
  return staticModels
    .map((entry) => (typeof entry === 'string' ? entry : entry?.id))
    .filter((modelId) => typeof modelId === 'string' && modelId.length > 0);
}

// 扫会话目标：尽力而为，读不到就返回空 Map（调用方只给通用提示，不编造具体会话）
async function findSessionsTargetingModels({ groupId, modelIds, dataRoot, logger }) {
  const sessionsDirectory = getSessionsDirectory(dataRoot);
  const hits = new Map();
  let fileNames;
  try {
    fileNames = await fs.readdir(sessionsDirectory);
  } catch {
    return hits;
  }
  for (const fileName of fileNames) {
    if (!fileName.endsWith('.json')) continue;
    try {
      const rawText = await fs.readFile(path.join(sessionsDirectory, fileName), 'utf8');
      const parsedMapping = JSON.parse(rawText);
      for (const candidateTarget of [parsedMapping?.target, parsedMapping?.effectiveTarget]) {
        if (candidateTarget?.platformId !== groupId) continue;
        if (!modelIds.includes(candidateTarget.id)) continue;
        hits.set(candidateTarget.id, fileName.replace(/\.json$/, ''));
      }
    } catch (readError) {
      // 单个会话文件坏掉不该挡住更新；只留一行 warn 便于排查
      logger.warn(`扫描会话目标时跳过 ${fileName}：${describeFailure(readError)}`);
    }
  }
  return hits;
}

// 模型被移除时的提醒：能点名会话就点名，点不到就只给通用提示
async function buildModelRemovalWarnings({ previousGroup, nextGroup, dataRoot, logger }) {
  const previousModelIds = collectModelIds(previousGroup.models);
  const nextModelIds = collectModelIds(nextGroup.models);
  const removedModelIds = previousModelIds.filter((modelId) => !nextModelIds.includes(modelId));
  if (removedModelIds.length === 0) return [];

  const sessionHits = await findSessionsTargetingModels({
    groupId: nextGroup.id,
    modelIds: removedModelIds,
    dataRoot,
    logger,
  });
  return removedModelIds.map((modelId) => {
    const sessionId = sessionHits.get(modelId);
    if (sessionId) {
      return `模型 ${modelId} 已从清单移除，会话 ${sessionId} 的目标指向它，下次请求会 MODEL_UNRESOLVED`;
    }
    return `模型 ${modelId} 已从清单移除，若有会话目标指向它，下次请求会 MODEL_UNRESOLVED`;
  });
}

// PATCH 主流程：读配置 → 找群（404）→ 合并 → 整体校验（400）→ 写回 → 回执
export async function updateGroup(groupId, patch, { dataRoot, logger = defaultLogger } = {}) {
  if (!isPlainObject(patch)) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, '更新内容必须是对象');
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'id') && patch.id !== groupId) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, '群 id 不可修改', {
      hint: 'id 是凭据文件名与会话目标的锚点；要换 id 请新建群再删旧群',
    });
  }
  // 明文 apiKey 仍按红线拒收：换密钥走导入的 credentialFiles 或手工写文件
  rejectPlaintextCredentials(patch);

  const config = await readConfig({ dataRoot, logger });
  const existingGroups = config.groups ?? [];
  const previousGroup = findGroup(config, groupId);
  if (!previousGroup) {
    throw new GatewayError(ERROR_CODES.GROUP_NOT_FOUND, `群不存在：${groupId}`);
  }

  const pickedFields = pickUpdatableFields(patch);
  const mergedGroup = {
    ...previousGroup,
    ...pickedFields,
    id: previousGroup.id,
    auth: mergeAuth(previousGroup.auth, pickedFields.auth),
  };
  // 整体再验一次：部分更新也不能把群改成非法配置（缺 driver / 缺 models / 模型名非法等）
  const validatedGroup = validateGroupPayload(mergedGroup);
  const warnings = await buildModelRemovalWarnings({
    previousGroup,
    nextGroup: validatedGroup,
    dataRoot,
    logger,
  });

  const nextGroups = existingGroups.map((group) => (group.id === groupId ? validatedGroup : group));
  await writeConfig({ ...config, groups: nextGroups }, { dataRoot, logger });
  logger.info(`已更新群：${groupId}（字段 ${Object.keys(pickedFields).join('、') || '无'}）`);

  return { group: validatedGroup, warnings };
}
