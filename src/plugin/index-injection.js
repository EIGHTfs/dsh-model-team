// 把"静态基线清单"注入 index.html（平台预置 + 驱动元数据）。
//
// 为什么走服务端注入而不是打进 lib/client.js：
//   · 清单是**服务端数据**（`config/platforms.json` + 数据根覆盖），打进产物会让「改配置要重新构建」；
//   · 宿主 webServer 提供 `tapIndex(html => html)`（html→html 变换），每次返回 index.html 都会经过它，
//     于是"文件改了下一次刷新就生效"，产物保持纯代码。
//   · 打不进产物就没有"产物与配置漂移"这一类问题。
//
// 为什么必须是**同步**读：`tapIndex` 的签名是 `(html: string) => string`，变换函数不能返回 Promise。
// 所以这里用 readFileSync 读两个小 JSON（内置 + 用户覆盖），并在 transform 里逐请求重算（文件可能刚被改）。
// 代价是每次 index 请求两次小文件读——这是刻意取舍：换来"改了 platforms.json 刷新即生效"。

import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_PLATFORMS_FILE_URL,
  PLATFORMS_FIELD_NAME,
  USER_PLATFORMS_FILE_NAME,
  normalizePlatformPreset,
} from '../gateway/config/platform-presets.js';
import { getDataRoot } from '../gateway/config/paths.js';
import { listDrivers } from '../gateway/drivers/index.js';
import { defaultLogger, describeFailure } from '../gateway/logger.js';

// 全局变量名：客户端（ui/js/store/groups.js）按这个名字预置 state
export const BASELINE_GLOBAL_NAME = '__DMT_BASELINE__';
const BASELINE_MARKER = `window.${BASELINE_GLOBAL_NAME}`;
const HEAD_CLOSE_TAG = '</head>';

// 同步读一个清单文件：不存在返回 null（交给上层回落），坏 JSON / 读失败 warn 后同样回落
function readPlatformsFileSync(fileTarget, logger, fileLabel) {
  let rawText;
  try {
    rawText = fs.readFileSync(fileTarget, 'utf8');
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

// 基线载荷：平台（用户覆盖 > 内置，逐项校验）+ 驱动元数据（只取元数据，不含实现）
export function buildBaselinePayload({ dataRoot = getDataRoot(), logger = defaultLogger, drivers } = {}) {
  const userPlatforms = readPlatformsFileSync(
    path.join(dataRoot, USER_PLATFORMS_FILE_NAME), logger, '用户平台清单',
  );
  const rawPlatforms = userPlatforms ?? readPlatformsFileSync(DEFAULT_PLATFORMS_FILE_URL, logger, '内置平台清单') ?? [];
  const platforms = rawPlatforms
    .map((rawPreset) => normalizePlatformPreset(rawPreset, logger))
    .filter((preset) => preset !== null);

  return {
    // 顺序与 /_team/platforms、/_team/drivers 一致：都来自同一份数据与同一个 listDrivers()
    platforms,
    drivers: drivers ?? listDrivers(),
  };
}

// 把 JSON 变成可安全放进 <script> 的文本：
// `<` 全转义成 \u003c（否则平台名里出现 `</script>` 会提前闭合脚本，注入即失效且可能被当成 HTML 解析）
// \u2028 / \u2029 是 JS 里的行终结符，原样出现会让脚本语法错误
export function serializeBaselineForScript(payload) {
  return JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// 在 </head> 前插入基线脚本；已有同名标记则不重复插入（幂等）
export function injectBaselineIntoHtml(html, payload) {
  if (typeof html !== 'string' || html.length === 0) return html;
  if (html.includes(BASELINE_MARKER)) return html;

  const scriptTag = `<script>${BASELINE_MARKER}=${serializeBaselineForScript(payload)};</script>`;
  const headCloseIndex = html.lastIndexOf(HEAD_CLOSE_TAG);
  if (headCloseIndex < 0) return `${scriptTag}${html}`;
  return `${html.slice(0, headCloseIndex)}${scriptTag}${html.slice(headCloseIndex)}`;
}
