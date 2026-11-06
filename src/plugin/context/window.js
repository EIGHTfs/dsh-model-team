// 上下文窗口申报（契约 02 §六「容量申报」、实现依据 07 §二点六）。
//
// 为什么需要这一层：dsh 的压缩会调 `resolveModelInfo(provider, model)` 取 `context.contextWindow`，
// 拿不到就抛 TargetPressureConfigError（整轮对话起不来）。而本插件只注册一个虚拟模型，
// 底下可能挂着任意真实模型 —— 只能申报一个**安全下界**，也就是所有已知窗口的最小值。
//
// 三个不能省的约束：
//   1. 申报值必须是正数：0 / 负数 / NaN 会让 dsh 抛 INVALID_MODEL_CONTEXT（崩，不是降级）
//   2. 解析路径只读缓存：命中就用缓存里的最小值，未命中**先返回兜底**、把探测甩到后台（失败不抛错）
//   3. 探测必须 single-flight + 短超时 + TTL：结果（含空样本）都写进程内缓存，过期后由后台刷新
//
// 为什么解析路径一秒都不能等：resolveModel 位于「用户切换模型」这条同步链路上，冷缓存时等一次上游
// 就是切一下卡 1 秒（实测 1007ms），而上游根本不一定报容量——这一秒收益经常为零。
//
// 已知窗口有两个来源：群配置的 models.static[]（离线可得）+ endpoint 型群的一次性探测。

import { collectConfiguredContextWindows, pickDeclaredContextWindow, toPositiveInteger } from '../../gateway/model/capacity.js';
import { getDriver } from '../../gateway/drivers/index.js';
import { safeFetchModels } from '../../gateway/group/models.js';
import { normalizeModelList } from '../../gateway/model/catalog.js';
import { resolveGroupCredentials } from '../../gateway/config/credentials.js';
import { defaultLogger } from '../../gateway/logger.js';

/** 单个群的探测超时：宁可少一个样本，也不能把 turn 卡住 */
export const PROBE_TIMEOUT_MS = 1200;
/** 一次探测的总预算：群多时按顺序探，超预算就带着已有结果返回 */
export const PROBE_TOTAL_BUDGET_MS = 2500;
/** 空样本的缓存寿命：上游这次没报容量不代表永远不报，到期让后台再探一次（仍然不许阻塞解析） */
export const PROBE_CACHE_TTL_EMPTY_MS = 10 * 60 * 1000;
/** 有样本的缓存寿命：真实容量基本不变，缓存久一点，免得反复打上游 */
export const PROBE_CACHE_TTL_FILLED_MS = 6 * 60 * 60 * 1000;

// 进程内缓存：{ signature, windowsByGroup, allWindows, recordedAtMs }
// signature 由「群 id + baseURL + endpoint + static 条目」拼成，配置一改就失效；
// 再叠一层 TTL 兜住「配置没变但这次上游空手」——只按签名失效会一次空手、之后永远空手。
let probeCache = null;
let probeInFlight = null;
// 「非法 config.contextWindow」的告警旗标：配置错误只需报一次，别在每次 resolveModel 时刷屏
let warnedInvalidOverride = false;

/** 测试用：清掉进程内缓存，让下一次调用重新探测（告警旗标一并复位，用例之间互不污染） */
export function resetContextWindowCache() {
  probeCache = null;
  probeInFlight = null;
  warnedInvalidOverride = false;
}

function buildGroupsSignature(config) {
  const groups = Array.isArray(config?.groups) ? config.groups : [];
  return JSON.stringify(groups.map((group) => [
    group?.id ?? '',
    group?.baseURL ?? '',
    group?.models?.endpoint ?? '',
    Array.isArray(group?.models?.static) ? group.models.static.map((modelEntry) => [modelEntry?.id, modelEntry?.contextLength ?? null]) : null,
  ]));
}

/** 只有「配置里没有静态窗口 + 存在 endpoint 型群」才需要网络样本；两条解析路径共用这一个判据 */
function shouldProbeEndpointGroups(config) {
  const configuredWindows = collectConfiguredContextWindows(config);
  const groups = Array.isArray(config?.groups) ? config.groups : [];
  const hasEndpointGroup = groups.some((group) => typeof group?.models?.endpoint === 'string' && group.models.endpoint.length > 0);
  return configuredWindows.length === 0 && hasEndpointGroup;
}

/** 同步读缓存：签名一致、且没过期才算命中；解析路径唯一允许的取值方式（绝不发起网络） */
function readFreshProbeCache(config) {
  if (!probeCache || probeCache.signature !== buildGroupsSignature(config)) return null;
  const ttlMs = probeCache.allWindows.length > 0 ? PROBE_CACHE_TTL_FILLED_MS : PROBE_CACHE_TTL_EMPTY_MS;
  return Date.now() - probeCache.recordedAtMs < ttlMs ? probeCache : null;
}

// 探测超时的失败原因（日志与排查都按这个字面值找）
export const PROBE_TIMEOUT_REASON = '探测超时';

/**
 * 探测用的 fetch 包装：**超时下沉到 I/O 边界**（AbortSignal），不再在外面 race 一个 fallback。
 * 为什么必须这样：race + fallback 会把"探测挂住"变成"悄悄用兜底值"，而兜底值直接决定申报给宿主的
 * 上下文窗口（用户可见）；超时应当是一次**明确的失败结局**（结果为空的样本 + 带原因的日志），
 * 而不是一次"看起来成功"的解析。驱动自己也带 signal（更长），用 AbortSignal.any 取交集，先到者生效。
 */
function createProbeFetch(fetchImpl, timeoutMs) {
  const baseFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  return (requestUrl, requestInit = {}) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = requestInit.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([requestInit.signal, timeoutSignal])
      : timeoutSignal;
    return baseFetch(requestUrl, { ...requestInit, signal: combinedSignal });
  };
}

/** 失败原因归一：超时类错误统一说成「探测超时」，其它保留原始信息 */
function describeProbeFailure(error) {
  const errorName = error?.name;
  if (errorName === 'TimeoutError' || errorName === 'AbortError') return PROBE_TIMEOUT_REASON;
  return error?.message ?? String(error);
}

/** 探测单个群：返回 [{ id, contextLength }]；任何失败都返回空数组 */
async function probeSingleGroup(group, { dataRoot, logger, fetchImpl }) {
  const driver = getDriver(group?.driver);
  if (!driver || typeof driver.fetchModels !== 'function') return [];

  const credentialResult = await resolveGroupCredentials(group, { dataRoot });
  const credentials = credentialResult?.credentials ?? {};
  const modelsResult = await safeFetchModels({
    driver,
    context: { group, credentials, logger, fetchImpl },
    logger,
  });
  if (!modelsResult.ok) {
    // safeFetchModels 已把驱动异常收敛成结构化结果（不抛），所以"超时"要在这里归类并留日志：
    // 日志里必须能一眼看出是超时，而不是一条含义模糊的"获取失败"
    const failureText = String(modelsResult.error?.message ?? '');
    const reason = /abort|timeout|超时/i.test(failureText) ? PROBE_TIMEOUT_REASON : failureText;
    logger.warn(`上下文窗口探测失败（群 ${group?.id ?? ''}，原因：${reason}）；本轮按空样本处理`);
    return [];
  }

  const models = normalizeModelList(modelsResult.models, { logger });
  return models
    .map((modelEntry) => ({ id: modelEntry.id, contextLength: toPositiveInteger(modelEntry.contextLength) }))
    .filter((modelEntry) => modelEntry.contextLength !== null);
}

/** 一次性探测所有 endpoint 型群（有 static 的群不需要网络）。single-flight + 总预算。 */
async function probeAllGroups({ config, dataRoot, logger, fetchImpl }) {
  const groups = Array.isArray(config?.groups) ? config.groups : [];
  const windowsByGroup = {};
  const startedAtMs = Date.now();
  // 每个探测请求自带超时：超时是"这次探测失败了"，会作为空样本落进缓存（不会留任何窗口值）
  const probeFetch = createProbeFetch(fetchImpl, PROBE_TIMEOUT_MS);

  for (const group of groups) {
    if (Date.now() - startedAtMs > PROBE_TOTAL_BUDGET_MS) {
      logger.warn('上下文窗口探测超出总预算，剩余群跳过（本轮用已拿到的样本）');
      break;
    }
    const groupId = String(group?.id ?? '');
    if (groupId.length === 0) continue;
    // 已有静态窗口的群不探测：配置里的容量是落盘事实，为它再发一次网络请求只会拖慢 resolveModel
    const staticWindows = collectConfiguredContextWindows({ groups: [group] });
    if (staticWindows.length > 0) {
      windowsByGroup[groupId] = staticWindows;
      continue;
    }
    const probedWindows = await probeSingleGroup(group, { dataRoot, logger, fetchImpl: probeFetch })
      .catch((probeError) => {
        logger.warn(`上下文窗口探测失败（群 ${groupId}，原因：${describeProbeFailure(probeError)}）；本轮按空样本处理`);
        return [];
      });
    if (probedWindows.length > 0) {
      windowsByGroup[groupId] = probedWindows.map((modelEntry) => modelEntry.contextLength);
    }
  }

  return { windowsByGroup, allWindows: Object.values(windowsByGroup).flat() };
}

/** 拿到（或建立）探测缓存；并发调用共享同一次探测 */
function ensureProbeCache({ config, dataRoot, logger = defaultLogger, fetchImpl }) {
  const signature = buildGroupsSignature(config);
  const freshCache = readFreshProbeCache(config);
  if (freshCache) return Promise.resolve(freshCache);
  if (probeInFlight) return probeInFlight;

  probeInFlight = probeAllGroups({ config, dataRoot, logger, fetchImpl })
    .then(({ windowsByGroup, allWindows }) => {
      probeCache = { signature, windowsByGroup, allWindows, recordedAtMs: Date.now() };
      return probeCache;
    })
    .catch((probeError) => {
      logger.warn(`上下文窗口探测整体失败，本轮退兜底值：${probeError?.message ?? probeError}`);
      // 失败也写缓存（空样本）：否则每次 resolveModel 都会重试一遍，把请求链路拖慢
      probeCache = { signature, windowsByGroup: {}, allWindows: [], recordedAtMs: Date.now() };
      return probeCache;
    })
    .finally(() => {
      probeInFlight = null;
    });
  return probeInFlight;
}

/**
 * 申报窗口（同步）：三级取值 —— 显式覆盖 → 已知最小值 → 兜底。**绝不发起网络**。
 * 为什么必须同步：调用它在 resolveModel 里，那条链路是「用户切换模型」的同步路径。
 * @param {{config?: object, logger?: object}} [input]
 * @returns {number} 一定是正数（兜底 config.contextWindowFallback，缺省 1048576）
 */
export function peekDeclaredContextWindow({ config, logger = defaultLogger } = {}) {
  const overrideValue = config?.contextWindow;
  const hasOverride = overrideValue !== undefined && overrideValue !== null;
  // 非法覆盖值只告警一次：每次 resolveModel 都刷一条会把日志淹掉，而且这是配置错误、不是运行时故障
  if (hasOverride && toPositiveInteger(overrideValue) === null && !warnedInvalidOverride) {
    warnedInvalidOverride = true;
    if (logger && typeof logger.warn === "function") {
      logger.warn(`config.contextWindow 非法（${String(overrideValue)}），已忽略并回退到模型最小值/兜底`);
    }
  }

  const configuredWindows = collectConfiguredContextWindows(config);
  const probedWindows = shouldProbeEndpointGroups(config) ? readFreshProbeCache(config)?.allWindows ?? [] : [];
  return pickDeclaredContextWindow({
    knownWindows: [...configuredWindows, ...probedWindows],
    fallback: config?.contextWindowFallback,
    override: hasOverride ? overrideValue : undefined,
  });
}

/**
 * 诊断/测试用：读一份探测缓存快照（**只读，绝不触发探测**）。
 * 为什么需要它：后台探测是异步的，"探测结果已经落定"这个事实只存在于缓存里；
 * 用例据此等具体状态，而不是等一个"大概够了"的毫秒数。
 * @returns {{hasCache: boolean, windows: number[], recordedAtMs: number|null}}
 */
export function peekContextWindowProbeCache(config) {
  const freshCache = readFreshProbeCache(config);
  if (!freshCache) return { hasCache: false, windows: [], recordedAtMs: null };
  return { hasCache: true, windows: [...freshCache.allWindows], recordedAtMs: freshCache.recordedAtMs };
}

/**
 * 后台预热探测：调用方**不要 await**（返回值只给测试/诊断，业务路径一律丢弃）。
 * 缓存新鲜时立刻返回，所以解析路径可以无条件调用——空样本缓存不会被误判成"没探过"而反复重探。
 * 异常全部吞掉只 warn：探测失败永远只该退兜底，不能影响调用方。
 * @returns {Promise<object>|null} 本次/进行中的探测；不需要探测（有静态窗口或缓存新鲜）时 null
 */
export function startContextWindowProbe({ config, dataRoot, logger = defaultLogger, fetchImpl } = {}) {
  if (!shouldProbeEndpointGroups(config)) return null;
  if (readFreshProbeCache(config)) return null;
  ensureProbeCache({ config, dataRoot, logger, fetchImpl }).catch((probeError) => {
    // ensureProbeCache 已兜过一次，这里只防"兜底逻辑自身出错"把未处理拒绝丢给宿主
    logger.warn(`上下文窗口后台探测异常（继续按兜底值申报）：${probeError?.message ?? probeError}`);
  });
  return probeInFlight;
}

/**
 * 申报窗口（会等网络）：只在调用方明确接受等待时用（诊断/测试）。
 * 业务解析路径请用 peekDeclaredContextWindow + startContextWindowProbe，别把网络放回同步链路上。
 * @returns {Promise<number>} 一定是正数
 */
export async function resolveDeclaredContextWindow({ config, dataRoot, logger = defaultLogger, fetchImpl } = {}) {
  if (shouldProbeEndpointGroups(config)) {
    await ensureProbeCache({ config, dataRoot, logger, fetchImpl });
  }
  // 诊断路径与生产路径必须同口径（含非法 override 的告警去处）
  return peekDeclaredContextWindow({ config, logger });
}

/**
 * 查某个真实模型的窗口（超限检查与 UI 提示用）。未知返回 null —— 调用方必须按"不知道"处理，
 * 不能拿兜底值当真实窗口（那会把超限检查变成误报机器）。
 * @returns {Promise<number|null>}
 */
export async function resolveModelContextWindow({ config, groupId, modelId, dataRoot, logger = defaultLogger, fetchImpl } = {}) {
  const groups = Array.isArray(config?.groups) ? config.groups : [];
  const group = groups.find((candidate) => candidate?.id === groupId);
  if (!group) return null;

  const staticModels = Array.isArray(group?.models?.static) ? group.models.static : [];
  const matchedModel = staticModels.find((modelEntry) => modelEntry?.id === modelId);
  const configuredWindow = toPositiveInteger(matchedModel?.contextLength);
  if (configuredWindow !== null) return configuredWindow;

  if (typeof group?.models?.endpoint !== 'string' || group.models.endpoint.length === 0) return null;
  const cache = await ensureProbeCache({ config, dataRoot, logger, fetchImpl });
  const groupWindows = cache.windowsByGroup[String(groupId)] ?? [];
  // 探测结果只有窗口列表，没有 id 映射时按最小窗口保守处理（不编造具体模型的窗口）
  return groupWindows.length > 0 ? Math.min(...groupWindows) : null;
}
