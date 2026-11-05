// 请求行（RequestRow）组装与存取：群友消息的数据来源（docs/09 §5/§8）。
// 需求意图：前端只渲染成品字段，所以"时间/状态/token/命中率/悬浮 title"的拼装必须只在这里做一份，
//          否则前后端各写一遍必然漂移；字段缺失一律给 `—`，绝不留空串或 undefined。
// 思路：buildRequestRow 是纯函数（时间与耗时从入参来，便于测试固定）；写侧 append + 环形截断，
//      读侧按 sessionId 过滤并按时间正序。持久化行里额外带 sessionId/startedAtMs/usage 三个内部字段
//      （前端可忽略），用于会话过滤与全局统计，避免再从格式化字符串反解析数值。

import fs from 'node:fs/promises';
import { getDataRoot, getRequestRowsPath, getStatsDirectory } from '../config/paths.js';
import { defaultLogger, describeFailure } from '../logger.js';
import { formatClockTime, formatIsoWithOffset, formatLatency } from '../clock.js';

// 环形截断阈值缺省值（docs/09 §8：config.stats.maxRows）
export const DEFAULT_MAX_REQUEST_ROWS = 5000;

// 超过上限时保留"最近一半"
const TRUNCATE_KEEP_RATIO = 0.5;

// 字段缺失占位：统一破折号，禁止空串/undefined（docs/09 §5）
export const MISSING_FIELD_PLACEHOLDER = '—';

// token 数紧凑显示：≥1000 用 252.6k 形式
const TOKEN_COMPACT_THRESHOLD = 1000;
const TOKEN_COMPACT_DECIMAL_PLACES = 1;
const TOKEN_COMPACT_SUFFIX = 'k';

// 耗时换算成秒用的两个常量（latencySeconds 字段）
const MILLISECONDS_PER_SECOND = 1000;
const LATENCY_DECIMAL_PLACES = 2;

// 命中率显示：一位小数 + %
const PERCENT_DECIMAL_PLACES = 1;
const PERCENT_SUFFIX = '%';
// 百分比换算基数（0~1 → 0~100）
const PERCENT_SCALE = 100;

// title 各段分隔符（悬浮还原原始日志用）
export const TITLE_FIELD_SEPARATOR = ' | ';

// 上游状态码 → 中文文案（docs/09 §5 的状态映射）
export const STATUS_TEXT_BY_CODE = Object.freeze({
  0: '未转发',
  200: '成功',
  201: '成功',
  204: '成功',
  400: '请求无效',
  401: '未授权',
  403: '禁止访问',
  404: '未找到',
  409: '冲突',
  413: '请求体过大',
  429: '限流',
  500: '网关异常',
  502: '上游错误',
  503: '上游不可用',
  504: '上游超时',
});

// 状态文案：调用方给了 override 就优先（例如 model-unresolved 的"无模型映射"）
export function statusTextFor(statusCode, overrideText) {
  if (typeof overrideText === 'string' && overrideText.length > 0) {
    return overrideText;
  }
  if (STATUS_TEXT_BY_CODE[statusCode]) {
    return STATUS_TEXT_BY_CODE[statusCode];
  }
  return statusCode >= 500 ? '上游错误' : '失败';
}

// tokens 字段：无 usage 给 —，≥1000 走 k 缩略
export function formatTokens(usage) {
  const totalTokens = usage?.totalTokens;
  if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens)) {
    return MISSING_FIELD_PLACEHOLDER;
  }
  if (totalTokens >= TOKEN_COMPACT_THRESHOLD) {
    return `${(totalTokens / TOKEN_COMPACT_THRESHOLD).toFixed(TOKEN_COMPACT_DECIMAL_PLACES)}${TOKEN_COMPACT_SUFFIX}`;
  }
  return String(totalTokens);
}

// 命中率字段：cached / prompt 的百分比；缺数据或分母为 0 给 —
export function formatCacheHit(usage) {
  const cachedTokens = usage?.cacheHit;
  const promptTokens = usage?.promptTokens;
  if (typeof cachedTokens !== 'number' || typeof promptTokens !== 'number' || promptTokens <= 0) {
    return MISSING_FIELD_PLACEHOLDER;
  }
  const hitRatio = (cachedTokens / promptTokens) * PERCENT_SCALE;
  return `${hitRatio.toFixed(PERCENT_DECIMAL_PLACES)}${PERCENT_SUFFIX}`;
}

// credit 字段：平台返回则用，未返回给 —（不估算、不编造）
export function formatCredit(creditValue) {
  if (creditValue === null || creditValue === undefined || creditValue === '') {
    return MISSING_FIELD_PLACEHOLDER;
  }
  return String(creditValue);
}

// 耗时换算成秒（保留两位小数）：取不到时间差时返回 null
function toLatencySeconds(elapsedMilliseconds) {
  if (typeof elapsedMilliseconds !== 'number' || !Number.isFinite(elapsedMilliseconds)) {
    return null;
  }
  const elapsedSeconds = Math.max(0, elapsedMilliseconds) / MILLISECONDS_PER_SECOND;
  return Number(elapsedSeconds.toFixed(LATENCY_DECIMAL_PLACES));
}

// title：按"时间 | 状态 | 模型 | 会话账号 | IP | UA | 耗时 | tokens | credit | 命中 | req-id"拼接
export function buildRequestTitle(requestRow) {
  const statusSegment = `${requestRow.status} ${requestRow.statusText}`;
  const accountSegment = `${requestRow.account.name}(${requestRow.account.id})`;
  return [
    requestRow.time,
    statusSegment,
    requestRow.model,
    accountSegment,
    requestRow.ip,
    requestRow.ua,
    requestRow.latency,
    requestRow.tokens,
    requestRow.credit,
    requestRow.cacheHit,
    requestRow.requestId,
  ].join(TITLE_FIELD_SEPARATOR);
}

// 组装一条请求行：所有字段落到成品值，纯函数便于逐字段断言
export function buildRequestRow({
  sessionId,
  statusCode,
  statusText,
  model,
  account,
  ipAddress,
  userAgent,
  startedAtMs,
  finishedAtMs,
  usage,
  credit,
  requestId,
  aborted,
  groupId,
  targetSource,
}) {
  const requestRow = {
    time: formatClockTime(startedAtMs),
    status: statusCode,
    statusText: statusTextFor(statusCode, statusText),
    model: model ?? MISSING_FIELD_PLACEHOLDER,
    account: {
      name: account?.name ?? MISSING_FIELD_PLACEHOLDER,
      id: account?.id ?? MISSING_FIELD_PLACEHOLDER,
    },
    ip: ipAddress ?? MISSING_FIELD_PLACEHOLDER,
    ua: userAgent ?? MISSING_FIELD_PLACEHOLDER,
    latency: formatLatency(finishedAtMs - startedAtMs),
    // 数值型耗时与输出 token：前端算“生成速度”（completionTokens / latencySeconds），
    // 不能用 tokens(含输入) / latency 算 —— 那是吞吐量，量级会差上百倍
    latencySeconds: toLatencySeconds(finishedAtMs - startedAtMs),
    completionTokens: typeof usage?.completionTokens === 'number' ? usage.completionTokens : null,
    tokens: formatTokens(usage),
    credit: formatCredit(credit),
    cacheHit: formatCacheHit(usage),
    requestId: requestId ?? MISSING_FIELD_PLACEHOLDER,
    title: '',
    // 以下为存储层附加字段：会话过滤与全局统计要用，前端不渲染
    sessionId: sessionId ?? null,
    startedAtMs,
    usage: usage ?? null,
  };
  requestRow.title = buildRequestTitle(requestRow);
  // 分组派发时记录"本轮由哪个分组派出去"（INV-11：model 仍是真实模型，groupId 只补来源）
  if (typeof groupId === 'string' && groupId.length > 0) {
    requestRow.groupId = groupId;
  }
  // 目标来源（explicit|parent|last-session|fallback-group）：排查"这个模型是谁定的"要看它
  if (typeof targetSource === 'string' && targetSource.length > 0) {
    requestRow.targetSource = targetSource;
  }
  // 中断标记只在真中断时出现：没有这个字段就代表"请求有明确结局"
  if (aborted === true) {
    requestRow.aborted = true;
  }
  return requestRow;
}

// 读全部行：文件不存在返回空数组；损坏行跳过并告警（不让一行坏数据拖垮整张表）
async function readAllRequestRows({ dataRoot, logger, warnPrefix = '请求行' }) {
  const requestRowsPath = getRequestRowsPath(dataRoot);
  let rawRowsText;
  try {
    rawRowsText = await fs.readFile(requestRowsPath, 'utf8');
  } catch (readError) {
    if (readError?.code !== 'ENOENT') {
      logger.warn(`${warnPrefix}读取失败：${describeFailure(readError)}`);
    }
    return [];
  }
  const requestRows = [];
  for (const lineText of rawRowsText.split('\n')) {
    if (lineText.trim().length === 0) {
      continue;
    }
    try {
      requestRows.push(JSON.parse(lineText));
    } catch {
      logger.warn(`${warnPrefix}里有一行损坏，已跳过`);
    }
  }
  return requestRows;
}

// 环形截断：超过 maxRows 就只留最近一半，并打 info 日志（禁止无限增长）
export async function enforceRingTruncation({ dataRoot = getDataRoot(), logger = defaultLogger, maxRows = DEFAULT_MAX_REQUEST_ROWS } = {}) {
  const requestRows = await readAllRequestRows({ dataRoot, logger });
  if (requestRows.length <= maxRows) {
    return { truncated: false, rowCount: requestRows.length };
  }

  const keepRowCount = Math.max(1, Math.floor(maxRows * TRUNCATE_KEEP_RATIO));
  const keptRows = requestRows.slice(-keepRowCount);
  const requestRowsPath = getRequestRowsPath(dataRoot);
  const temporaryPath = `${requestRowsPath}.${process.pid}.tmp`;
  const serializedRows = keptRows.map((requestRow) => JSON.stringify(requestRow)).join('\n');

  await fs.mkdir(getStatsDirectory(dataRoot), { recursive: true });
  await fs.writeFile(temporaryPath, `${serializedRows}\n`, 'utf8');
  await fs.rename(temporaryPath, requestRowsPath);
  logger.info(`请求行超过上限 ${maxRows} 条，已截断保留最近 ${keepRowCount} 条`);
  return { truncated: true, rowCount: keepRowCount };
}

// 追加一条请求行，随后执行环形截断
export async function appendRequestRow(
  requestRow,
  { dataRoot = getDataRoot(), logger = defaultLogger, maxRows = DEFAULT_MAX_REQUEST_ROWS } = {},
) {
  await fs.mkdir(getStatsDirectory(dataRoot), { recursive: true });
  await fs.appendFile(getRequestRowsPath(dataRoot), `${JSON.stringify(requestRow)}\n`, 'utf8');
  await enforceRingTruncation({ dataRoot, logger, maxRows });
  return requestRow;
}

// 读请求行：可按会话过滤，返回时间正序（旧 → 新）；limit 取最近 N 条
export async function readRequestRows(
  { dataRoot = getDataRoot(), logger = defaultLogger, sessionId = null, groupId = null, limit = null } = {},
) {
  const requestRows = await readAllRequestRows({ dataRoot, logger });
  // 会话过滤 + 群过滤（account.id 即群 id）：不传群就返回该会话全部（兼容旧调用）
  const filteredRows = requestRows.filter((requestRow) => {
    if (sessionId !== null && requestRow.sessionId !== sessionId) {
      return false;
    }
    if (groupId !== null && requestRow.account?.id !== groupId) {
      return false;
    }
    return true;
  });
  const orderedRows = filteredRows.sort((leftRow, rightRow) => (leftRow.startedAtMs ?? 0) - (rightRow.startedAtMs ?? 0));
  if (typeof limit === 'number' && limit >= 0) {
    return orderedRows.slice(-limit);
  }
  return orderedRows;
}

// 出参裁剪（docs/09 §10）：内部字段不出网
// sessionId 必须保留——前端按会话过滤要用；startedAtMs 与 usage 是实现细节，暴露出去就等于把内部结构变成契约
export const INTERNAL_REQUEST_ROW_FIELDS = Object.freeze(['startedAtMs', 'usage']);

// 把存储行裁剪成对外 RequestRow
export function toPublicRequestRow(requestRow) {
  const publicRequestRow = {
    ...requestRow,
    // 历史行没有这两个字段（它们是写入时落盘的）；契约要求 null 而不是 undefined——
    // JSON 序列化时 undefined 字段会直接消失，与"值为 null"语义不同，前端排查会踩坑
    completionTokens: requestRow.completionTokens ?? null,
    latencySeconds: requestRow.latencySeconds ?? null,
  };
  for (const internalField of INTERNAL_REQUEST_ROW_FIELDS) {
    delete publicRequestRow[internalField];
  }
  return publicRequestRow;
}

// 全局统计（docs/09 §6，形状由契约冻结）：totalTokens 给原始数值，格式化归前端
export function buildGlobalStats(requestRows) {
  const statusCounts = {};
  let totalTokens = 0;
  let cacheablePromptTokens = 0;
  let totalCachedTokens = 0;
  let hasCacheHitData = false;
  let abortedRows = 0;
  let earliestStartedAtMs = null;

  for (const requestRow of requestRows) {
    // 中断行没有上游最终状态（status=0），不能计入 byStatus——否则会把失败统计成成功
    if (requestRow.aborted === true || requestRow.status === 0) {
      abortedRows += 1;
    } else {
      const statusKey = String(requestRow.status);
      statusCounts[statusKey] = (statusCounts[statusKey] ?? 0) + 1;
    }

    const rowUsage = requestRow.usage ?? {};
    if (typeof rowUsage.totalTokens === 'number') {
      totalTokens += rowUsage.totalTokens;
    }
    // 只有上游确实回了缓存字段才计入：否则会把"没有数据"算成"命中率 0%"，等于编造结论
    if (
      typeof rowUsage.cacheHit === 'number'
      && typeof rowUsage.promptTokens === 'number'
      && rowUsage.promptTokens > 0
    ) {
      totalCachedTokens += rowUsage.cacheHit;
      cacheablePromptTokens += rowUsage.promptTokens;
      hasCacheHitData = true;
    }
    if (typeof requestRow.startedAtMs === 'number') {
      earliestStartedAtMs = earliestStartedAtMs === null
        ? requestRow.startedAtMs
        : Math.min(earliestStartedAtMs, requestRow.startedAtMs);
    }
  }

  const cacheHitPercent = hasCacheHitData && cacheablePromptTokens > 0
    ? `${((totalCachedTokens / cacheablePromptTokens) * 100).toFixed(PERCENT_DECIMAL_PLACES)}${PERCENT_SUFFIX}`
    : MISSING_FIELD_PLACEHOLDER;

  return {
    totalRows: requestRows.length,
    totalTokens,
    cacheHitPercent,
    byStatus: statusCounts,
    abortedRows,
    since: earliestStartedAtMs === null ? null : formatIsoWithOffset(earliestStartedAtMs),
  };
}
