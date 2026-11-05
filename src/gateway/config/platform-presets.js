// 平台预置加载器（数据来自 JSON，代码里不出现任何平台的 URL / 名称）。
// 数据来源与优先级（契约见 docs/04 末尾「数据来源（禁止硬编码在代码里）」）：
//   1) 用户覆盖：<dataRoot>/platforms.json —— 存在即**整体覆盖**默认
//   2) 内置默认：仓库 config/platforms.json —— 随包分发
// 容错：文件缺失 / JSON 坏 / 全部非法 → 返回 []（端点 200 + 空数组，绝不 500）；单项非法只跳过该项并 warn。

import fs from 'node:fs/promises';
import path from 'node:path';
import { getDataRoot } from './paths.js';
import { defaultLogger, describeFailure } from '../logger.js';

// 用户覆盖文件名（放在数据根下，部署侧可直接改）
export const USER_PLATFORMS_FILE_NAME = 'platforms.json';
// 清单在 JSON 里的顶层字段
export const PLATFORMS_FIELD_NAME = 'platforms';
// 内置默认：用 import.meta.url 相对定位，不写死任何绝对路径
export const DEFAULT_PLATFORMS_FILE_URL = new URL('../../../config/platforms.json', import.meta.url);

// 必填字段：没有这三项就无法用来预填/匹配，直接跳过该项
const REQUIRED_PRESET_FIELDS = Object.freeze(['id', 'name', 'baseURL']);

function toNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

// 单项校验：必填缺失 → null（调用方跳过并 warn）；avatar 允许 URL / Base64 / 短文本，只要求非空字符串
export function normalizePlatformPreset(rawPreset, logger = defaultLogger) {
  if (!rawPreset || typeof rawPreset !== 'object' || Array.isArray(rawPreset)) {
    logger.warn('平台清单里有一项不是对象，已跳过');
    return null;
  }

  const missingFields = REQUIRED_PRESET_FIELDS.filter((fieldName) => toNonEmptyString(rawPreset[fieldName]) === undefined);
  if (missingFields.length > 0) {
    logger.warn(`平台清单项缺少必填字段（${missingFields.join('/')}），已跳过：${JSON.stringify(rawPreset).slice(0, 120)}`);
    return null;
  }

  return {
    id: toNonEmptyString(rawPreset.id),
    name: toNonEmptyString(rawPreset.name),
    ...(toNonEmptyString(rawPreset.avatar) === undefined ? {} : { avatar: toNonEmptyString(rawPreset.avatar) }),
    baseURL: toNonEmptyString(rawPreset.baseURL),
    ...(toNonEmptyString(rawPreset.modelsEndpoint) === undefined ? {} : { modelsEndpoint: toNonEmptyString(rawPreset.modelsEndpoint) }),
    ...(toNonEmptyString(rawPreset.homepage) === undefined ? {} : { homepage: toNonEmptyString(rawPreset.homepage) }),
    ...(toNonEmptyString(rawPreset.summaryTemplate) === undefined ? {} : { summaryTemplate: toNonEmptyString(rawPreset.summaryTemplate) }),
    ...(toNonEmptyString(rawPreset.driverId) === undefined ? {} : { driverId: toNonEmptyString(rawPreset.driverId) }),
  };
}

// 读一个清单文件：返回 platforms 数组；文件不存在返回 null（交给上层回落）；JSON 坏 → warn + null
async function readPlatformsFile(fileTarget, logger, fileLabel) {
  let rawText;
  try {
    rawText = await fs.readFile(fileTarget, 'utf8');
  } catch (readError) {
    if (readError?.code !== 'ENOENT') {
      logger.warn(`${fileLabel}读取失败，按不存在处理：${describeFailure(readError)}`);
    }
    return null;
  }

  try {
    const parsedConfig = JSON.parse(rawText);
    return Array.isArray(parsedConfig?.[PLATFORMS_FIELD_NAME]) ? parsedConfig[PLATFORMS_FIELD_NAME] : [];
  } catch (parseError) {
    logger.warn(`${fileLabel}不是合法 JSON，已回落下一级来源：${describeFailure(parseError)}`);
    return null;
  }
}

// 加载平台清单：用户覆盖优先，其次内置默认；逐项校验后返回数组（可能为空）
export async function loadPlatformPresets({
  dataRoot = getDataRoot(),
  logger = defaultLogger,
  defaultFileUrl = DEFAULT_PLATFORMS_FILE_URL,
} = {}) {
  const userFilePath = path.join(dataRoot, USER_PLATFORMS_FILE_NAME);
  const userPlatforms = await readPlatformsFile(userFilePath, logger, '用户平台清单');
  const rawPlatforms = userPlatforms ?? await readPlatformsFile(defaultFileUrl, logger, '内置平台清单');

  if (!Array.isArray(rawPlatforms)) {
    return [];
  }

  const platformPresets = rawPlatforms
    .map((rawPreset) => normalizePlatformPreset(rawPreset, logger))
    .filter((preset) => preset !== null);

  if (platformPresets.length === 0) {
    logger.warn('平台清单为空或全部非法项，按空清单处理');
  }
  return platformPresets;
}

// 给群匹配预置：驱动一致时按 baseURL / 群 id / 群名任一命中（容忍 "xxx(本机)" 这类带后缀的群名）
export function findPlatformPresetForGroup(group, platformPresets = []) {
  const groupDriverId = toNonEmptyString(group?.driver);
  if (groupDriverId === undefined) {
    return null;
  }
  const normalizedGroupId = String(group?.id ?? '').trim().toLowerCase();
  const normalizedGroupName = String(group?.name ?? '').trim().toLowerCase();
  const groupBaseURL = toNonEmptyString(group?.baseURL);

  return platformPresets.find((preset) => {
    if (preset.driverId !== undefined && preset.driverId !== groupDriverId) {
      return false;
    }
    if (groupBaseURL !== undefined && preset.baseURL === groupBaseURL) {
      return true;
    }
    const presetId = preset.id.toLowerCase();
    const presetName = preset.name.toLowerCase();
    return normalizedGroupId === presetId
      || normalizedGroupId.startsWith(`${presetId}-`)
      || normalizedGroupName === presetName
      || normalizedGroupName.startsWith(presetName);
  }) ?? null;
}

// 群列表/详情用：配置里有 avatar 就用配置，否则回落到预置；都没有返回 undefined（出参省略该字段）
export function resolveGroupAvatar(group, platformPresets = []) {
  if (typeof group?.avatar === 'string' && group.avatar.trim().length > 0) {
    return group.avatar;
  }
  return findPlatformPresetForGroup(group, platformPresets)?.avatar;
}
