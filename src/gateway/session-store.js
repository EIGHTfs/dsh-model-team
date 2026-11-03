// 会话存储：会话 id 三级解析 + 模型映射读写 + 事件追加流（docs/09 §2/§4）。
// 需求意图：dsh 侧只有一个虚拟模型，网关必须知道"这个请求属于哪个会话"，才能查该会话要用的真实模型；
//          同时绝不写 dsh 自己的会话日志（那等于伪造宿主状态），只做只读回退。
// 思路：请求头最准 → dsh JSONL 只读回退（需配置显式开启）→ 兜底群；三级都没有就明确报 session-unresolved。
//      落盘全在本项目数据根；sessionId 先校验再编码成文件名，双重防路径穿越。

import fs from 'node:fs/promises';
import { getSessionEventsPath, getSessionMappingPath, getSessionsDirectory, getDataRoot } from './paths.js';
import { formatIsoWithOffset } from './clock.js';
import { sortSessionEvents } from './event-sort.js';
import { defaultLogger, describeFailure } from './logger.js';
import { ERROR_CODES, GatewayError } from './errors.js';
import { describeSessionTarget, normalizeSessionTarget, toLegacyMapping } from './session-target.js';
import { JSON_INDENT_WIDTH } from './constants.js';

// 读会话日志首行时探测的字节数：header 行远小于这个值，一次读足够
const JSONL_HEADER_PROBE_BYTES = 4096;

// 会话标识请求头缺省名（docs/09 §2 第 1 级），配置里可改
export const DEFAULT_SESSION_HEADER_NAME = 'X-Team-Session-Id';
// 旧客户端仍可能发旧头：读取时一并接受（写入只用新名）
export const LEGACY_SESSION_HEADER_NAMES = Object.freeze(['X-Tim-Session-Id']);

// sessionId 合理长度上限：再长基本可以判定是异常输入，直接拒绝免得撑爆文件名
export const MAX_SESSION_ID_LENGTH = 512;

// 路径分隔符黑名单：Windows 与 POSIX 两种都挡
const PATH_SEPARATOR_PATTERN = /[\\/]/;

// 父目录跳转串：编码前后都要查（双保险）
const PARENT_DIRECTORY_TOKEN = '..';

// 事件读取上限：一次最多回这么多条，避免超长事件流撑爆前端
export const DEFAULT_EVENT_READ_LIMIT = 500;

// 校验 sessionId：非空、长度合理、不含路径分隔符与父目录跳转
export function assertSafeSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, 'sessionId 不能为空', {
      hint: '把会话标识放在请求头，或配置 session.fallbackGroupId 兜底',
    });
  }
  const trimmedSessionId = sessionId.trim();
  if (trimmedSessionId.length > MAX_SESSION_ID_LENGTH) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, `sessionId 超过 ${MAX_SESSION_ID_LENGTH} 字符上限`);
  }
  if (trimmedSessionId === PARENT_DIRECTORY_TOKEN || trimmedSessionId.includes(PARENT_DIRECTORY_TOKEN)) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, 'sessionId 不允许包含 ".."');
  }
  if (PATH_SEPARATOR_PATTERN.test(trimmedSessionId)) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, 'sessionId 不允许包含路径分隔符');
  }
  return trimmedSessionId;
}

// sessionId → 安全文件名；编码后再校验一次解码结果，防止有人用超长/怪字符绕过
export function toSessionFileName(sessionId) {
  const safeSessionId = assertSafeSessionId(sessionId);
  const encodedFileName = encodeURIComponent(safeSessionId);
  const decodedBack = decodeURIComponent(encodedFileName);
  if (decodedBack !== safeSessionId || PATH_SEPARATOR_PATTERN.test(encodedFileName)) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, 'sessionId 无法安全转换成文件名');
  }
  return encodedFileName;
}

// 从请求头取会话标识：Node 已把 header 名小写化，这里按小写查
function readSessionHeader(incomingRequest, headerName) {
  const headers = incomingRequest?.headers ?? {};
  const headerValue = headers[String(headerName).toLowerCase()];
  if (Array.isArray(headerValue)) {
    return headerValue[0];
  }
  return headerValue;
}

// 缺省 JSONL 回退：按配置的 glob 取最近修改的会话日志，从首行 JSON 里拿 sessionId，拿不到就用文件名
// 只读：不追加、不改写任何 dsh 文件
export async function defaultJsonlSessionResolver({ jsonlGlob, logger = defaultLogger }) {
  const globPath = String(jsonlGlob ?? '').trim();
  if (globPath.length === 0) {
    return null;
  }
  const lastSeparatorIndex = Math.max(globPath.lastIndexOf('/'), globPath.lastIndexOf('\\'));
  const directoryPath = lastSeparatorIndex >= 0 ? globPath.slice(0, lastSeparatorIndex) : '.';
  const fileNamePattern = lastSeparatorIndex >= 0 ? globPath.slice(lastSeparatorIndex + 1) : globPath;

  try {
    const directoryEntries = await fs.readdir(directoryPath, { withFileTypes: true });
    const matchedFiles = [];
    for (const directoryEntry of directoryEntries) {
      if (!directoryEntry.isFile() || !matchesSimplePattern(directoryEntry.name, fileNamePattern)) {
        continue;
      }
      const filePath = `${directoryPath}/${directoryEntry.name}`;
      const fileStats = await fs.stat(filePath);
      matchedFiles.push({ filePath, fileName: directoryEntry.name, modifiedAtMs: fileStats.mtimeMs });
    }
    if (matchedFiles.length === 0) {
      return null;
    }
    matchedFiles.sort((leftFile, rightFile) => rightFile.modifiedAtMs - leftFile.modifiedAtMs);
    return await readSessionIdFromFile(matchedFiles[0].filePath, matchedFiles[0].fileName);
  } catch (resolveError) {
    logger.warn(`会话日志回退读取失败，按未识别处理：${describeFailure(resolveError)}`);
    return null;
  }
}

// 只支持 * 与 ? 的简单通配：不引第三方 glob 依赖
function matchesSimplePattern(fileName, globPattern) {
  const escapedPattern = globPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escapedPattern}$`).test(fileName);
}

// 从日志首行找 sessionId；dsh 日志首行通常是 header JSON，找不到就退回文件名（去扩展名）
async function readSessionIdFromFile(filePath, fileName) {
  const fileHandle = await fs.open(filePath, 'r');
  try {
    const firstChunk = Buffer.alloc(JSONL_HEADER_PROBE_BYTES);
    const readResult = await fileHandle.read(firstChunk, 0, firstChunk.length, 0);
    const firstLine = firstChunk.subarray(0, readResult.bytesRead).toString('utf8').split('\n')[0];
    try {
      const headerRecord = JSON.parse(firstLine);
      if (typeof headerRecord?.sessionId === 'string' && headerRecord.sessionId.length > 0) {
        return headerRecord.sessionId;
      }
    } catch {
      // 首行不是 JSON：按文件名兜底，不算错误
    }
    return fileName.replace(/\.jsonl?$/i, '');
  } finally {
    await fileHandle.close();
  }
}

// 兜底群 id：无论会话从哪一级识别出来都要带上——映射缺失时它就是"用哪个群"的唯一线索
function readFallbackGroupId(sessionConfig) {
  const fallbackGroupId = sessionConfig?.fallbackGroupId;
  return typeof fallbackGroupId === 'string' && fallbackGroupId.trim().length > 0 ? fallbackGroupId.trim() : null;
}

// 三级解析会话：返回 { sessionId, fallbackGroupId, source }；三级都没有则抛 session-unresolved
export async function resolveSessionIdentity({
  incomingRequest,
  config,
  logger = defaultLogger,
  jsonlResolver = defaultJsonlSessionResolver,
} = {}) {
  const sessionConfig = config?.session ?? {};
  const headerName = sessionConfig.headerName ?? DEFAULT_SESSION_HEADER_NAME;
  const fallbackGroupId = readFallbackGroupId(sessionConfig);

  // 先读配置/默认头，再依次尝试历史头名（旧客户端兼容；新名优先）
  const headerCandidates = [headerName, ...LEGACY_SESSION_HEADER_NAMES.filter((name) => name !== headerName)];
  for (const candidateName of headerCandidates) {
    const headerSessionId = readSessionHeader(incomingRequest, candidateName);
    if (typeof headerSessionId === 'string' && headerSessionId.trim().length > 0) {
      return { sessionId: assertSafeSessionId(headerSessionId), fallbackGroupId, source: 'header' };
    }
  }

  if (sessionConfig.jsonlGlob) {
    try {
      const jsonlSessionId = await jsonlResolver({ jsonlGlob: sessionConfig.jsonlGlob, logger });
      if (typeof jsonlSessionId === 'string' && jsonlSessionId.trim().length > 0) {
        return { sessionId: assertSafeSessionId(jsonlSessionId), fallbackGroupId, source: 'jsonl' };
      }
    } catch (jsonlError) {
      // 回退失败不致命：继续走兜底群
      logger.warn(`会话日志回退失败：${describeFailure(jsonlError)}`);
    }
  }

  if (fallbackGroupId) {
    return { sessionId: null, fallbackGroupId, source: 'fallback-group' };
  }

  throw new GatewayError(ERROR_CODES.SESSION_UNRESOLVED, '无法从请求头或会话日志确定会话', {
    hint: `在请求头带 ${headerName}，或配置 session.jsonlGlob / session.fallbackGroupId`,
  });
}

// 读映射：文件不存在返回 null（新会话常态），损坏文件告警后也返回 null
export async function readSessionMapping(sessionId, { dataRoot = getDataRoot(), logger = defaultLogger } = {}) {
  const mappingPath = getSessionMappingPath(toSessionFileName(sessionId), dataRoot);
  let rawMappingText;
  try {
    rawMappingText = await fs.readFile(mappingPath, 'utf8');
  } catch (readError) {
    if (readError?.code !== 'ENOENT') {
      logger.warn(`会话映射读取失败，按未映射处理：${describeFailure(readError)}`);
    }
    return null;
  }
  try {
    const storedMapping = JSON.parse(rawMappingText);
    // 新结构存 target；旧结构直接是 { platform, model }——两种都归一后再反推旧字段
    const sessionTarget = normalizeSessionTarget(storedMapping?.target ?? storedMapping);
    if (!sessionTarget) {
      return null;
    }
    return {
      sessionId: storedMapping?.sessionId ?? sessionId,
      ...toLegacyMapping(sessionTarget),
      target: sessionTarget,
      updatedAt: storedMapping?.updatedAt ?? null,
    };
  } catch (parseError) {
    logger.warn(`会话映射损坏，按未映射处理：${mappingPath}（${describeFailure(parseError)}）`);
    return null;
  }
}

// 写映射（旧接口，保留兼容）：等价于写一个 { type:'model', id:model, platformId:platform } 目标
export async function writeSessionMapping(
  sessionId,
  { platform, model, updatedAt },
  { dataRoot = getDataRoot(), logger = defaultLogger } = {},
) {
  return writeSessionTarget(
    sessionId,
    { type: 'model', id: model, platformId: platform },
    { dataRoot, logger, updatedAt },
  );
}

// 读目标（新结构）：文件不存在/损坏返回 null；旧结构自动归一（docs/11 §24-33）
export async function readSessionTarget(sessionId, { dataRoot = getDataRoot(), logger = defaultLogger } = {}) {
  const legacyMapping = await readSessionMapping(sessionId, { dataRoot, logger });
  return legacyMapping?.target ?? null;
}

// 写目标：原子写；旧的 platform/model 字段一并镜像，保证旧读取方（与回滚）仍能读
export async function writeSessionTarget(
  sessionId,
  target,
  { dataRoot = getDataRoot(), logger = defaultLogger, updatedAt } = {},
) {
  const normalizedTarget = normalizeSessionTarget(target);
  if (!normalizedTarget) {
    throw new TypeError('writeSessionTarget 需要合法的会话目标');
  }

  const sessionFileName = toSessionFileName(sessionId);
  const mappingPath = getSessionMappingPath(sessionFileName, dataRoot);
  const temporaryPath = `${mappingPath}.${process.pid}.tmp`;
  const legacyMapping = toLegacyMapping(normalizedTarget);
  const storedMapping = {
    sessionId,
    target: normalizedTarget,
    platform: legacyMapping.platform,
    model: legacyMapping.model,
    updatedAt: updatedAt ?? new Date().toISOString(),
  };

  await fs.mkdir(getSessionsDirectory(dataRoot), { recursive: true });
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(storedMapping, null, JSON_INDENT_WIDTH)}\n`, 'utf8');
    await fs.rename(temporaryPath, mappingPath);
  } catch (writeError) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw writeError;
  }
  logger.info(`会话目标已更新：${sessionId} -> ${describeSessionTarget(normalizedTarget)}`);
  return storedMapping;
}

// 列出所有会话目标（前端展示、删除分组前的引用统计等）
export async function listSessionTargets({ dataRoot = getDataRoot(), logger = defaultLogger } = {}) {
  const sessionsDirectory = getSessionsDirectory(dataRoot);
  let directoryEntries;
  try {
    directoryEntries = await fs.readdir(sessionsDirectory, { withFileTypes: true });
  } catch (readdirError) {
    if (readdirError?.code !== 'ENOENT') {
      logger.warn(`会话目录读取失败：${describeFailure(readdirError)}`);
    }
    return [];
  }

  const sessionTargets = [];
  for (const directoryEntry of directoryEntries) {
    if (!directoryEntry.isFile() || !directoryEntry.name.endsWith('.json')) {
      continue;
    }
    try {
      const rawMappingText = await fs.readFile(`${sessionsDirectory}/${directoryEntry.name}`, 'utf8');
      const storedMapping = JSON.parse(rawMappingText);
      const sessionTarget = normalizeSessionTarget(storedMapping?.target ?? storedMapping);
      if (sessionTarget) {
        // updatedAt 用于"最近绑定过模型的会话"排序（缺失就是 null，排序时排最后）
        sessionTargets.push({
          sessionId: storedMapping?.sessionId ?? null,
          target: sessionTarget,
          updatedAt: typeof storedMapping?.updatedAt === 'string' ? storedMapping.updatedAt : null,
        });
      }
    } catch {
      // 单条脏数据跳过
    }
  }
  return sessionTargets;
}

// 追加事件：一行一条，读侧按行解析；写入失败不阻断主流程（由调用方决定是否吞掉）
export async function appendSessionEvent(sessionId, event, { dataRoot = getDataRoot() } = {}) {
  const eventsPath = getSessionEventsPath(toSessionFileName(sessionId), dataRoot);
  await fs.mkdir(getSessionsDirectory(dataRoot), { recursive: true });
  await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
  return event;
}

// 读事件：按追加顺序返回（旧 → 新），损坏行跳过并告警
export async function readSessionEvents(
  sessionId,
  { dataRoot = getDataRoot(), logger = defaultLogger, groupId = null, limit = DEFAULT_EVENT_READ_LIMIT } = {},
) {
  const eventsPath = getSessionEventsPath(toSessionFileName(sessionId), dataRoot);
  let rawEventsText;
  try {
    rawEventsText = await fs.readFile(eventsPath, 'utf8');
  } catch (readError) {
    if (readError?.code !== 'ENOENT') {
      logger.warn(`会话事件读取失败：${describeFailure(readError)}`);
    }
    return [];
  }

  const events = [];
  for (const lineText of rawEventsText.split('\n')) {
    if (lineText.trim().length === 0) {
      continue;
    }
    try {
      const parsedEvent = JSON.parse(lineText);
      // 历史事件没有 at / platformId：补 null（字段不能消失，前端按 `== null` 判断）
      events.push({
        ...parsedEvent,
        at: parsedEvent.at ?? null,
        platformId: parsedEvent.platformId ?? null,
      });
    } catch {
      logger.warn('会话事件里有一行损坏，已跳过');
    }
  }
  // 按群过滤：只留属于该群的事件（分组切换的 platformId 是 null，指定群时不返回）
  const filteredEvents = groupId === null
    ? events
    : events.filter((event) => event.platformId === groupId);
  return sortSessionEvents(filteredEvents).slice(-limit);
}

// 系统提示事件（docs/09 §6 的 SessionEvent.type='system'）：best-effort，写不进去不影响主流程
export const SYSTEM_EVENT_TYPE = 'system';

export async function appendSystemEvent({
  sessionId,
  text,
  clock,
  platformId = null,
  dataRoot = getDataRoot(),
  logger = defaultLogger,
} = {}) {
  if (!sessionId) {
    return null;
  }
  try {
    const nowMs = clock.nowMs();
    return await appendSessionEvent(
      sessionId,
      { time: clock.formatTime(nowMs), at: formatIsoWithOffset(nowMs), type: SYSTEM_EVENT_TYPE, text, platformId },
      { dataRoot },
    );
  } catch (eventError) {
    logger.warn(`系统事件写入失败：${describeFailure(eventError)}`);
    return null;
  }
}
