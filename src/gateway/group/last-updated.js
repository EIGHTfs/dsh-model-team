// 群列表的 lastUpdated：优先"这个群最近一次请求"的时间，其次群配置时间，最后 config.json 的 mtime。
// 需求意图：前端要显示「10:30 / 昨天」这类摘要更新时间；服务端只回 ISO，格式化（含时区与相对时间）交给前端本地化。

import fs from 'node:fs/promises';
import { getConfigPath } from '../config/paths.js';
import { defaultLogger } from '../logger.js';
import { readRequestRows } from '../stats/index.js';

// 时间入参可能是毫秒数或 ISO 串；解析不出来一律当作"没有时间"
function toEpochMs(timeValue) {
  if (typeof timeValue === 'number' && Number.isFinite(timeValue)) {
    return timeValue;
  }
  if (typeof timeValue !== 'string' || timeValue.length === 0) {
    return null;
  }
  const parsedMs = Date.parse(timeValue);
  return Number.isFinite(parsedMs) ? parsedMs : null;
}

// 单群计算：请求行（groupId 或 account.id 命中）→ 群配置时间 → config.json mtime → null
export function resolveGroupLastUpdatedIso({ group, requestRows = [], configModifiedAtMs = null }) {
  const latestRequestMs = requestRows.reduce((latestMs, requestRow) => {
    const belongsToGroup = requestRow?.groupId === group.id || requestRow?.account?.id === group.id;
    if (!belongsToGroup) {
      return latestMs;
    }
    const rowMs = toEpochMs(requestRow.startedAtMs) ?? toEpochMs(requestRow.time);
    if (rowMs === null) {
      return latestMs;
    }
    return latestMs === null || rowMs > latestMs ? rowMs : latestMs;
  }, null);

  const configTimeMs = toEpochMs(group.updatedAt)
    ?? toEpochMs(group.createdAt)
    ?? (Number.isFinite(configModifiedAtMs) ? configModifiedAtMs : null);
  const chosenMs = latestRequestMs ?? configTimeMs;

  return chosenMs === null ? null : new Date(chosenMs).toISOString();
}

// config.json 的 mtime：文件不存在等异常只 warn 并当作没有时间
export async function readConfigModifiedAtMs(dataRoot, { logger = defaultLogger } = {}) {
  try {
    const configStats = await fs.stat(getConfigPath(dataRoot));
    return configStats.mtimeMs;
  } catch (statError) {
    logger.warn(`读取 config.json 修改时间失败，lastUpdated 回落为 null：${statError.message}`);
    return null;
  }
}

// 列表用：一次读请求行与 config mtime，逐群补 lastUpdated（其它字段原样保留）
export async function attachLastUpdated(groups, { dataRoot, logger = defaultLogger } = {}) {
  const requestRows = await readRequestRows({ dataRoot, logger }).catch((readError) => {
    logger.warn(`读取请求行失败，lastUpdated 回落为 config 时间：${readError.message}`);
    return [];
  });
  const configModifiedAtMs = await readConfigModifiedAtMs(dataRoot, { logger });

  return groups.map((group) => ({
    ...group,
    lastUpdated: resolveGroupLastUpdatedIso({ group, requestRows, configModifiedAtMs }),
  }));
}
