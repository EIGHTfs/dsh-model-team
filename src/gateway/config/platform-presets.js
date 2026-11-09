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

// 本地图标的扩展名 → MIME：只认图片，其它后缀当配置错误跳过（不把任意文件塞给客户端）
const ICON_MIME_BY_EXTENSION = Object.freeze({
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
});

// 直接把在线地址/内联数据当候选：这两种形态客户端能直接渲染
function isRenderableIconValue(value) {
  return typeof value === 'string' && (/^https?:\/\//i.test(value) || /^data:/i.test(value));
}

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

  // icons：有序候选（在线 / 本地相对路径 / 文本）；只做"去空 + 去重"，不在这里解析路径
  const declaredIcons = Array.isArray(rawPreset.icons)
    ? rawPreset.icons
    : (toNonEmptyString(rawPreset.icon) === undefined ? [] : [rawPreset.icon]);
  const icons = [];
  for (const iconCandidate of declaredIcons) {
    const normalizedIcon = toNonEmptyString(iconCandidate);
    if (normalizedIcon === undefined || icons.includes(normalizedIcon)) continue;
    icons.push(normalizedIcon);
  }

  return {
    id: toNonEmptyString(rawPreset.id),
    name: toNonEmptyString(rawPreset.name),
    ...(icons.length === 0 ? {} : { icons }),
    ...(toNonEmptyString(rawPreset.avatar) === undefined ? {} : { avatar: toNonEmptyString(rawPreset.avatar) }),
    baseURL: toNonEmptyString(rawPreset.baseURL),
    ...(toNonEmptyString(rawPreset.modelsEndpoint) === undefined ? {} : { modelsEndpoint: toNonEmptyString(rawPreset.modelsEndpoint) }),
    ...(toNonEmptyString(rawPreset.homepage) === undefined ? {} : { homepage: toNonEmptyString(rawPreset.homepage) }),
    ...(toNonEmptyString(rawPreset.summaryTemplate) === undefined ? {} : { summaryTemplate: toNonEmptyString(rawPreset.summaryTemplate) }),
    ...(toNonEmptyString(rawPreset.driverId) === undefined ? {} : { driverId: toNonEmptyString(rawPreset.driverId) }),
  };
}

/**
 * 把一条图标候选变成「客户端能直接渲染」的形态：
 *   · http(s):// 与 data: 原样返回；
 *   · 相对/绝对文件路径 → 读文件转 data: URI（相对路径以声明文件的所在目录为基准）；
 *   · 其它（1~2 个字符的文本）原样返回，交给界面做文本头像；
 *   · 文件读不到 / 后缀不是图片 → 返回 null（调用方跳过这条候选并 warn）。
 */
export async function resolveIconCandidate(iconCandidate, baseDirectory, logger = defaultLogger) {
  const normalizedIcon = toNonEmptyString(iconCandidate);
  if (normalizedIcon === undefined) return null;
  if (isRenderableIconValue(normalizedIcon)) return normalizedIcon;

  const looksLikePath = /\.(svg|png|jpe?g|webp|gif)$/i.test(normalizedIcon)
    || normalizedIcon.startsWith('./')
    || normalizedIcon.startsWith('../')
    || path.isAbsolute(normalizedIcon);
  if (!looksLikePath) return normalizedIcon;   // 文本头像（如 "Q"）

  const iconPath = path.isAbsolute(normalizedIcon) ? normalizedIcon : path.resolve(baseDirectory, normalizedIcon);
  const mimeType = ICON_MIME_BY_EXTENSION[path.extname(iconPath).toLowerCase()];
  if (mimeType === undefined) {
    logger.warn(`平台图标后缀不受支持，已跳过：${normalizedIcon}`);
    return null;
  }
  try {
    const iconBuffer = await fs.readFile(iconPath);
    return `data:${mimeType};base64,${iconBuffer.toString('base64')}`;
  } catch (readError) {
    logger.warn(`平台图标读取失败，已跳过：${iconPath}（${describeFailure(readError)}）`);
    return null;
  }
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
  const fromUserFile = userPlatforms !== null;
  const rawPlatforms = fromUserFile ? userPlatforms : await readPlatformsFile(defaultFileUrl, logger, '内置平台清单');
  // 本地图标路径相对"声明方目录"解析：用户清单在数据根，内置清单在仓库 config/
  const declaringDirectory = fromUserFile
    ? path.dirname(userFilePath)
    : path.dirname(new URL(defaultFileUrl).pathname);

  if (!Array.isArray(rawPlatforms)) {
    return [];
  }

  const platformPresets = rawPlatforms
    .map((rawPreset) => normalizePlatformPreset(rawPreset, logger))
    .filter((preset) => preset !== null);

  // icons：逐条解析（在线/内联原样、本地路径转 data URI、文本原样），失败的候选跳过
  for (const preset of platformPresets) {
    if (!Array.isArray(preset.icons)) continue;
    const resolvedIcons = [];
    for (const iconCandidate of preset.icons) {
      const resolvedIcon = await resolveIconCandidate(iconCandidate, declaringDirectory, logger);
      if (resolvedIcon !== null && !resolvedIcons.includes(resolvedIcon)) resolvedIcons.push(resolvedIcon);
    }
    if (resolvedIcons.length === 0) delete preset.icons;
    else preset.icons = resolvedIcons;
  }

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

/** 把任意来源的图标声明归一成有序候选（去空、去重，保持顺序） */
export function normalizeIconCandidates(...sources) {
  const candidates = [];
  for (const source of sources) {
    const list = Array.isArray(source) ? source : (toNonEmptyString(source) === undefined ? [] : [source]);
    for (const iconCandidate of list) {
      const normalizedIcon = toNonEmptyString(iconCandidate);
      if (normalizedIcon === undefined || candidates.includes(normalizedIcon)) continue;
      candidates.push(normalizedIcon);
    }
  }
  return candidates;
}

// 群列表/详情用：群自己的 icons 在前（可覆盖），平台声明在后；都没有返回 undefined（出参省略该字段）
export function resolveGroupIcons(group, platformPresets = [], extraIconsByDriverId = {}) {
  const preset = findPlatformPresetForGroup(group, platformPresets);
  const driverId = toNonEmptyString(group?.driver);
  const presetIcons = normalizeIconCandidates(preset?.icons, preset?.avatar);
  const pluginIcons = normalizeIconCandidates(driverId ? extraIconsByDriverId?.[driverId] : undefined);
  const candidates = normalizeIconCandidates(group?.icons, group?.avatar, presetIcons, pluginIcons);
  return candidates.length === 0 ? undefined : candidates;
}

// 兼容旧调用点：等价于 icons[0]
export function resolveGroupAvatar(group, platformPresets = [], extraIconsByDriverId = {}) {
  return resolveGroupIcons(group, platformPresets, extraIconsByDriverId)?.[0];
}
