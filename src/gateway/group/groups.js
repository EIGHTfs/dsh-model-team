// 群（平台账号）的校验与增删改查：config.groups[] 的唯一写入口。
// 需求意图：加群是前端最容易传脏数据的地方，校验必须在这一层做一次，别让坏配置进 config.json；
//          同时"凭证只收引用"是硬红线，任何明文 apiKey 一律拒绝。
// 思路：结构校验 + 驱动存在性校验（不探活，探活是 /_team/groups/:id/verify 的事）；
//      summary 渲染走驱动 fetchSummary，任何失败降级为 —，绝不因为一个群拖垮整个列表。

import fs from 'node:fs/promises';
import path from 'node:path';

import { API_PREFIX } from '../config/constants.js';
import { attachLastUpdated } from './last-updated.js';
import { loadPlatformPresets, resolveGroupAvatar } from '../config/platform-presets.js';
import { normalizeModelList } from '../model/catalog.js';
import { buildGroupModels, normalizeGroupSubmission, persistGroupApiKey } from './credentials.js';
import { getDriver } from '../drivers/index.js';
import { ACCESS_MODES } from '../drivers/index.js';
import { readConfig, writeConfig } from '../config/config.js';
import { resolveGroupCredentials } from '../config/credentials.js';
import { defaultLogger, describeFailure } from '../logger.js';
import { ERROR_CODES, GatewayError } from '../errors.js';

// 群 id 会进 URL（/_team/groups/:id）与事件流，只允许安全字符
export const GROUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MAX_GROUP_ID_LENGTH = 64;

// 摘要渲染失败时的降级值（INV-08：不报错、不阻断列表）
export const GROUP_SUMMARY_FALLBACK = '—';

// 配置型驱动的标识：它必须给 baseURL，否则拿不到上游
const CONFIG_DRIVEN_DRIVER_ID = 'openai-compatible';

// 明文凭证字段名：出现即拒绝
const PLAINTEXT_CREDENTIAL_FIELDS = Object.freeze(['apiKey', 'api_key', 'token', 'cookie']);

// 引用前缀：与 credentials.js 的约定保持一致
const CREDENTIAL_REF_PREFIXES = Object.freeze(['env:', 'file:']);

// 校验并归一化一份群配置；非法直接抛 GatewayError（调用方转 400/409）
// 由群名称派生 id：小写、空白转连字符、剔除非法字符，超长截断。
// 只用于"调用方没给 id"的情况；给了 id 就按原样校验，不做静默改写。
export function deriveGroupIdFromName(name) {
  const ascii = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+/, '')
    .slice(0, MAX_GROUP_ID_LENGTH);
  return ascii;
}

// 派生 id 撞车时找下一个可用序号：base → base-2 → base-3 …（上限 99 次，超了直接报错）
export function nextAvailableGroupId(config, baseId) {
  const used = new Set((config?.groups ?? []).map((group) => group.id));
  for (let suffix = 2; suffix <= 100; suffix += 1) {
    const candidate = `${baseId}-${suffix}`;
    if (!used.has(candidate) && candidate.length <= MAX_GROUP_ID_LENGTH) return candidate;
  }
  throw new GatewayError(ERROR_CODES.INVALID_REQUEST, `无法为该名称分配唯一 id：${baseId}`, {
    hint: '请显式提供一个未被占用的 id',
  });
}

/**
 * 由名称派生群 id（契约 §4.1：id 可选，缺省由 name 生成）。
 *
 * **id 生成方法的唯一入口** —— 以后要改「怎么生成 id」只改本函数与它调用的两个函数：
 *   字符规则   deriveGroupIdFromName（名称 → ASCII 安全串）
 *   空结果兜底 本函数（纯中文名派生不出合法串时用时间戳）
 *   撞名避让   nextAvailableGroupId（base → base-2 → base-3）
 *
 * @param {string} name 群名称（可能含中文/空格/符号）
 * @returns {string} 待校验的 id（合法性由 GROUP_ID_PATTERN 判断）
 */
export function deriveGroupId(name) {
  // GROUP_ID_PATTERN 只收 ASCII，纯中文名会派生出空串，用时间戳兜底保证能建群
  return deriveGroupIdFromName(name) || `group-${Date.now().toString(36)}`;
}

export function validateGroupPayload(groupPayload) {
  if (typeof groupPayload !== 'object' || groupPayload === null || Array.isArray(groupPayload)) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, '群配置必须是对象');
  }

  rejectPlaintextCredentials(groupPayload);

  // 契约 §4.1：id 可选，缺省由 name 生成（docs/02）。生成规则必须落在 GROUP_ID_PATTERN 内，
  // 否则前端按契约提交（不带 id）会被误判成"缺 id"，加群恒 400 —— 契约与实现打架时以契约为准。
  const submittedGroupId = groupPayload.id;
  const hasSubmittedId = typeof submittedGroupId === 'string' && submittedGroupId.trim().length > 0;
  // 纯中文名派生不出合法 id（GROUP_ID_PATTERN 只收 ASCII），用时间戳兜底，避免中文群名加不进来；
  // 显式给了 id 时按原样校验，不做静默改写。
  const trimmedGroupId = hasSubmittedId
    ? submittedGroupId.trim()
    : deriveGroupId(groupPayload.name);
  if (trimmedGroupId.length > MAX_GROUP_ID_LENGTH || !GROUP_ID_PATTERN.test(trimmedGroupId)) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, `群 id 不合法：${trimmedGroupId}`, {
      hint: '只允许字母、数字、点、下划线、连字符，且以字母或数字开头',
    });
  }

  if (typeof groupPayload.name !== 'string' || groupPayload.name.trim().length === 0) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, '群配置缺少 name');
  }

  const accessMode = groupPayload.accessMode ?? ACCESS_MODES.OFFICIAL;
  if (!Object.values(ACCESS_MODES).includes(accessMode)) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, `accessMode 必须是 official 或 reverse，收到 ${accessMode}`);
  }

  const driverId = groupPayload.driver;
  if (typeof driverId !== 'string' || driverId.trim().length === 0) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, '群配置缺少 driver');
  }
  if (!getDriver(driverId)) {
    throw new GatewayError(ERROR_CODES.DRIVER_NOT_FOUND, `驱动未加载：${driverId}`, {
      hint: `先确认驱动文件已放进数据根 drivers/ 且加载成功（GET ${API_PREFIX}/drivers 可查）`,
    });
  }

  if (driverId === CONFIG_DRIVEN_DRIVER_ID && (typeof groupPayload.baseURL !== 'string' || groupPayload.baseURL.trim().length === 0)) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, '配置型驱动必须提供 baseURL', {
      hint: '例如 https://api.example.com/v1',
    });
  }

  // 模型列表必须可判定：要么给 endpoint 自动拉取，要么给非空 static
  // static 允许字符串或 { id, name }：落盘统一成 { id, name }（docs/21）
  const modelConfig = groupPayload.models
    ? { ...groupPayload.models, ...(Array.isArray(groupPayload.models.static) ? { static: normalizeModelList(groupPayload.models.static) } : {}) }
    : groupPayload.models;
  const hasStaticModels = Array.isArray(modelConfig?.static) && modelConfig.static.length > 0;
  const hasModelsEndpoint = typeof modelConfig?.endpoint === 'string' && modelConfig.endpoint.trim().length > 0;
  if (!hasStaticModels && !hasModelsEndpoint) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, '群配置缺少 models：给 endpoint（自动拉取）或 static（手动模型名）', {
      hint: '自动拉取填 models: { endpoint: "/models" }；手动填 models: { static: ["my-model-a"] }',
    });
  }

  const apiKeyRef = groupPayload.auth?.apiKeyRef;
  if (apiKeyRef !== undefined && apiKeyRef !== null) {
    if (typeof apiKeyRef !== 'string' || !CREDENTIAL_REF_PREFIXES.some((prefix) => apiKeyRef.startsWith(prefix))) {
      throw new GatewayError(ERROR_CODES.INVALID_REQUEST, 'apiKeyRef 必须是 env:<NAME> 或 file:<相对路径> 引用', {
        hint: '本项目只存引用，不接收明文 Key',
      });
    }
  }

  return { ...groupPayload, id: trimmedGroupId, name: groupPayload.name.trim(), accessMode, driver: driverId, ...(modelConfig ? { models: modelConfig } : {}) };
}

// 递归查明文凭证字段：命中就整条拒绝（导入与加群共用）
export function rejectPlaintextCredentials(value, pathLabel = 'group') {
  if (typeof value !== 'object' || value === null) {
    return;
  }
  for (const [fieldName, fieldValue] of Object.entries(value)) {
    if (PLAINTEXT_CREDENTIAL_FIELDS.includes(fieldName) && typeof fieldValue === 'string' && fieldValue.length > 0) {
      throw new GatewayError(ERROR_CODES.INVALID_REQUEST, `不允许出现明文凭证字段：${pathLabel}.${fieldName}`, {
        hint: '改成 auth.apiKeyRef = env:<NAME> 或 file:<相对路径>',
      });
    }
    rejectPlaintextCredentials(fieldValue, `${pathLabel}.${fieldName}`);
  }
}

// 按 id 找群
export function findGroup(config, groupId) {
  return (config?.groups ?? []).find((group) => group.id === groupId) ?? null;
}

// 渲染单个群的摘要：驱动缺失/凭证缺失/驱动抛错都降级
export async function renderGroupSummary(group, { dataRoot, logger = defaultLogger, fetchImpl } = {}) {
  const driver = getDriver(group.driver);
  if (!driver || typeof driver.fetchSummary !== 'function') {
    return GROUP_SUMMARY_FALLBACK;
  }
  try {
    const credentialResult = await resolveGroupCredentials(group, { dataRoot });
    const summaryText = await driver.fetchSummary({
      group,
      credentials: credentialResult.credentials,
      logger,
      fetchImpl,
    });
    return typeof summaryText === 'string' && summaryText.length > 0 ? summaryText : GROUP_SUMMARY_FALLBACK;
  } catch (summaryError) {
    logger.warn(`群 ${group.id} 摘要渲染失败，已降级：${describeFailure(summaryError)}`);
    return GROUP_SUMMARY_FALLBACK;
  }
}

// 群列表：附渲染后的 summary（前端直接显示成品串）
export async function listGroupsWithSummary(config, options = {}) {
  const groups = config?.groups ?? [];
  const groupsWithSummary = await Promise.all(
    groups.map(async (group) => ({ ...group, summary: await renderGroupSummary(group, options) })),
  );
  // avatar：配置里有就用配置，否则回落到平台预置（清单来自 JSON，代码里没有平台字面量）；都没有则不写该字段
  const platformPresets = await loadPlatformPresets({ dataRoot: options.dataRoot, logger: options.logger });
  const groupsWithAvatar = groupsWithSummary.map((group) => {
    const avatar = resolveGroupAvatar(group, platformPresets);
    return avatar === undefined ? group : { ...group, avatar };
  });
  // lastUpdated 只在列表出参里补：优先级见 group-last-updated.js，其它字段不动
  return attachLastUpdated(groupsWithAvatar, options);
}

// 加群：id 已存在返回 409（不静默覆盖用户已有平台账号）
export async function addGroup(groupPayload, { dataRoot, logger = defaultLogger } = {}) {
  const submission = normalizeGroupSubmission(groupPayload);
  // 先拦住其它明文凭证字段（apiKey 是允许入参，单独走落盘逻辑）
  rejectPlaintextCredentials({
    ...groupPayload,
    apiKey: undefined,
    auth: { ...(groupPayload.auth ?? {}), apiKey: undefined },
  });
  if (!submission.submittedApiKeyRef && !submission.submittedApiKey) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, '缺少 API Key：提交 auth.apiKey 或 auth.apiKeyRef', {
      hint: 'auth.apiKey 会在服务端落盘为凭证文件，配置只留 file: 引用',
    });
  }

  // 先把表单归一成"可校验的群配置"（去掉明文与表单专用字段），再走统一校验
  const candidateGroup = {
    ...groupPayload,
    auth: {
      type: submission.authType,
      ...(submission.submittedApiKeyRef ? { apiKeyRef: submission.submittedApiKeyRef } : {}),
    },
    // 显式给了 models（含 static 对象数组）就原样用；表单提交才按 modelSource/manualModels 生成
    models: Array.isArray(groupPayload.models?.static) || typeof groupPayload.models?.endpoint === 'string'
      ? groupPayload.models
      : buildGroupModels(submission, { logger }),
  };
  delete candidateGroup.apiKey;
  delete candidateGroup.apiKeyRef;
  delete candidateGroup.modelSource;
  delete candidateGroup.manualModels;
  delete candidateGroup.models.manualModels;

  const normalizedGroup = validateGroupPayload(candidateGroup);
  // 标记 id 来源：派生的 id 允许冲突时加序号，显式给的 id 冲突必须 409
  normalizedGroup.idDerived = !(typeof groupPayload.id === 'string' && groupPayload.id.trim().length > 0);
  // 引用优先：两者都给时以 auth.apiKeyRef 为准，明文不落盘
  if (!submission.submittedApiKeyRef) {
    normalizedGroup.auth.apiKeyRef = await persistGroupApiKey(normalizedGroup.id, submission.submittedApiKey.trim(), {
      dataRoot,
      logger,
    });
  }
  const config = await readConfig({ dataRoot, logger });
  if (findGroup(config, normalizedGroup.id)) {
    // 显式给了 id 却撞车 → 409（调用方自己选的 id，不能替他改）；
    // 由 name 派生的 id 撞车 → 加序号（同名前缀的中文名很容易派生出同一个 slug，直接 409 会让用户加不进第二个群）
    if (normalizedGroup.idDerived !== true) {
      throw new GatewayError(ERROR_CODES.GROUP_EXISTS, `群已存在：${normalizedGroup.id}`, {
        hint: `先 DELETE ${API_PREFIX}/groups/:id 再重新添加，或换一个 id`,
      });
    }
    normalizedGroup.id = nextAvailableGroupId(config, normalizedGroup.id);
  }
  delete normalizedGroup.idDerived;
  const nextConfig = { ...config, groups: [...(config.groups ?? []), normalizedGroup] };
  await writeConfig(nextConfig, { dataRoot, logger });
  logger.info(`已添加群：${normalizedGroup.id}（驱动 ${normalizedGroup.driver}）`);
  return normalizedGroup;
}

// 移除群：不存在返回 404
export async function removeGroup(groupId, { dataRoot, logger = defaultLogger } = {}) {
  const config = await readConfig({ dataRoot, logger });
  const allGroups = config.groups ?? [];
  const removedGroup = allGroups.find((group) => group.id === groupId) ?? null;
  const remainingGroups = allGroups.filter((group) => group.id !== groupId);
  if (remainingGroups.length === allGroups.length) {
    throw new GatewayError(ERROR_CODES.GROUP_NOT_FOUND, `群不存在：${groupId}`);
  }
  await writeConfig({ ...config, groups: remainingGroups }, { dataRoot, logger });

  // 删群同时回收它独占的凭证文件（契约 docs/09「删群清理」）：
  //   ① 只处理 file:credentials/<id>.key 形态（env: 引用指向用户环境，不归我们管）
  //   ② 仍有其它群引用同一文件时不删（人为复制场景）
  //   ③ 移入 <dataRoot>/.trash/ 而不是 unlink，保证可恢复
  const credentialCleanup = await releaseGroupCredential({
    removedGroup,
    remainingGroups,
    dataRoot,
    logger,
  });

  logger.info(`已移除群：${groupId}`);
  return { removed: groupId, credentialCleanup };
}

// 回收被删群独占的凭证文件；返回 { skipped, reason } 便于调用方与用例断言
async function releaseGroupCredential({ removedGroup, remainingGroups, dataRoot, logger }) {
  const credentialRef = removedGroup?.auth?.apiKeyRef;
  if (typeof credentialRef !== 'string' || !credentialRef.startsWith('file:')) {
    return { skipped: true, reason: 'no-file-credential' };
  }
  const stillReferenced = (remainingGroups ?? []).some(
    (group) => group?.auth?.apiKeyRef === credentialRef,
  );
  if (stillReferenced) {
    return { skipped: true, reason: 'still-referenced' };
  }
  const relativePath = credentialRef.slice('file:'.length);
  const credentialPath = path.join(dataRoot, relativePath);
  try {
    await fs.access(credentialPath);
  } catch {
    return { skipped: true, reason: 'already-absent' };
  }
  const trashDirectory = path.join(dataRoot, '.trash');
  const trashPath = path.join(trashDirectory, `${Date.now()}-${path.basename(credentialPath)}`);
  try {
    await fs.mkdir(trashDirectory, { recursive: true });
    await fs.rename(credentialPath, trashPath);
    logger.info(`已回收凭证文件：${relativePath} → .trash`);
    return { skipped: false, movedTo: path.relative(dataRoot, trashPath) };
  } catch (cleanupError) {
    // 回收失败不影响删群结果（群已从配置移除），只记录
    logger.warn(`凭证文件回收失败（群已删除）：${describeFailure(cleanupError)}`);
    return { skipped: true, reason: 'cleanup-failed' };
  }
}

// 导出：只含引用，不含明文（本项目本来就不存明文）
export function exportGroups(config) {
  return { version: 1, groups: config?.groups ?? [] };
}

// 导入：默认按 id 合并 upsert；mode=replace 需 confirm=true 二次确认；单条非法只计入 rejected
export async function importGroups(
  importPayload,
  { dataRoot, logger = defaultLogger, mode = 'merge', confirm = false } = {},
) {
  const incomingGroups = Array.isArray(importPayload?.groups) ? importPayload.groups : null;
  if (!incomingGroups) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, '导入内容必须是 { groups: [...] }');
  }
  if (mode === 'replace' && confirm !== true) {
    throw new GatewayError(ERROR_CODES.CONFIRMATION_REQUIRED, '整体替换会删除现有群，需确认后重试', {
      hint: '请求体带 confirm: true 再提交',
    });
  }

  const config = await readConfig({ dataRoot, logger });
  const mergedGroups = mode === 'replace' ? [] : [...(config.groups ?? [])];
  const groupIndexById = new Map(mergedGroups.map((group, index) => [group.id, index]));
  const rejectedEntries = [];
  let importedCount = 0;
  let updatedCount = 0;

  for (const [incomingIndex, incomingGroup] of incomingGroups.entries()) {
    try {
      const normalizedGroup = validateGroupPayload(incomingGroup);
      const existingIndex = groupIndexById.get(normalizedGroup.id);
      if (existingIndex === undefined) {
        groupIndexById.set(normalizedGroup.id, mergedGroups.length);
        mergedGroups.push(normalizedGroup);
        importedCount += 1;
      } else {
        mergedGroups[existingIndex] = normalizedGroup;
        updatedCount += 1;
      }
    } catch (validationError) {
      rejectedEntries.push({
        index: incomingIndex,
        reason: describeFailure(validationError),
      });
    }
  }

  await writeConfig({ ...config, groups: mergedGroups }, { dataRoot, logger });
  logger.info(`导入完成：新增 ${importedCount}，更新 ${updatedCount}，拒绝 ${rejectedEntries.length}`);
  return { imported: importedCount, updated: updatedCount, rejected: rejectedEntries };
}

// 测试连接：调驱动 validateAuth，只返回布尔与原因，不改任何状态
export async function verifyGroup(group, { dataRoot, logger = defaultLogger, fetchImpl } = {}) {
  const driver = getDriver(group.driver);
  if (!driver || typeof driver.validateAuth !== 'function') {
    return { ok: false, detail: `驱动不支持鉴权校验：${group.driver}` };
  }
  const credentialResult = await resolveGroupCredentials(group, { dataRoot });
  try {
    const isValid = await driver.validateAuth({
      group,
      credentials: credentialResult.credentials,
      logger,
      fetchImpl,
    });
    return {
      ok: isValid === true,
      detail: isValid === true ? '鉴权有效' : (credentialResult.ok ? '鉴权无效' : credentialResult.error.message),
    };
  } catch (verifyError) {
    logger.warn(`群 ${group.id} 鉴权校验异常：${describeFailure(verifyError)}`);
    return { ok: false, detail: describeFailure(verifyError) };
  }
}
