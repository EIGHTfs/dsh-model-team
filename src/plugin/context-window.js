// 上下文窗口申报（契约 02 §六「容量申报」、实现依据 07 §二点六）。
//
// 为什么需要这一层：dsh 的压缩会调 `resolveModelInfo(provider, model)` 取 `context.contextWindow`，
// 拿不到就抛 TargetPressureConfigError（整轮对话起不来）。而本插件只注册一个虚拟模型，
// 底下可能挂着任意真实模型 —— 只能申报一个**安全下界**，也就是所有已知窗口的最小值。
//
// 三个不能省的约束：
//   1. 申报值必须是正数：0 / 负数 / NaN 会让 dsh 抛 INVALID_MODEL_CONTEXT（崩，不是降级）
//   2. 探测只在首次需要时做一次并缓存在进程内存；失败**不抛错**，退兜底值
//   3. 探测必须 single-flight + 短超时：resolveModel 在请求链路上，不能被网络卡住
//
// 已知窗口有两个来源：群配置的 models.static[]（离线可得）+ endpoint 型群的一次性探测。

import { collectConfiguredContextWindows, pickDeclaredContextWindow, toPositiveInteger } from '../gateway/model-capacity.js';
import { getDriver } from '../gateway/drivers/index.js';
import { safeFetchModels } from '../gateway/group-models.js';
import { normalizeModelList } from '../gateway/model-catalog.js';
import { resolveGroupCredentials } from '../gateway/credentials.js';
import { defaultLogger } from '../gateway/logger.js';

/** 单个群的探测超时：宁可少一个样本，也不能把 turn 卡住 */
export const PROBE_TIMEOUT_MS = 1200;
/** 一次探测的总预算：群多时按顺序探，超预算就带着已有结果返回 */
export const PROBE_TOTAL_BUDGET_MS = 2500;

// 进程内缓存：{ signature, windowsByGroup, allWindows }
// signature 由「群 id + baseURL + endpoint + static 条目」拼成，配置一改就失效（不做定时刷新）
let probeCache = null;
let probeInFlight = null;

/** 测试用：清掉进程内缓存，让下一次调用重新探测 */
export function resetContextWindowCache() {
  probeCache = null;
  probeInFlight = null;
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

/** 给一个 Promise 套超时：超时返回 fallback，不抛错（探测失败一律降级） */
function withTimeout(promise, timeoutMs, fallback) {
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
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
  if (!modelsResult.ok) return [];

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
    const probedWindows = await withTimeout(
      probeSingleGroup(group, { dataRoot, logger, fetchImpl }).catch((probeError) => {
        logger.warn(`上下文窗口探测失败（群 ${groupId}）：${probeError?.message ?? probeError}`);
        return [];
      }),
      PROBE_TIMEOUT_MS,
      [],
    );
    if (probedWindows.length > 0) {
      windowsByGroup[groupId] = probedWindows.map((modelEntry) => modelEntry.contextLength);
    }
  }

  return { windowsByGroup, allWindows: Object.values(windowsByGroup).flat() };
}

/** 拿到（或建立）探测缓存；并发调用共享同一次探测 */
function ensureProbeCache({ config, dataRoot, logger = defaultLogger, fetchImpl }) {
  const signature = buildGroupsSignature(config);
  if (probeCache && probeCache.signature === signature) return Promise.resolve(probeCache);
  if (probeInFlight) return probeInFlight;

  probeInFlight = probeAllGroups({ config, dataRoot, logger, fetchImpl })
    .then(({ windowsByGroup, allWindows }) => {
      probeCache = { signature, windowsByGroup, allWindows };
      return probeCache;
    })
    .catch((probeError) => {
      logger.warn(`上下文窗口探测整体失败，本轮退兜底值：${probeError?.message ?? probeError}`);
      // 失败也写缓存（空样本）：否则每次 resolveModel 都会重试一遍，把请求链路拖慢
      probeCache = { signature, windowsByGroup: {}, allWindows: [] };
      return probeCache;
    })
    .finally(() => {
      probeInFlight = null;
    });
  return probeInFlight;
}

/**
 * 申报窗口：已知窗口最小值；没有任何已知样本时用 config.contextWindowFallback（缺省 262144）。
 * 有静态窗口时不探测（离线可判定，省一次网络）；全都没有才探测一次。
 * @returns {Promise<number>} 一定是正数
 */
export async function resolveDeclaredContextWindow({ config, dataRoot, logger = defaultLogger, fetchImpl } = {}) {
  const configuredWindows = collectConfiguredContextWindows(config);
  const groups = Array.isArray(config?.groups) ? config.groups : [];
  const hasEndpointGroup = groups.some((group) => typeof group?.models?.endpoint === 'string' && group.models.endpoint.length > 0);

  let probedWindows = [];
  if (configuredWindows.length === 0 && hasEndpointGroup) {
    const cache = await ensureProbeCache({ config, dataRoot, logger, fetchImpl });
    probedWindows = cache.allWindows;
  }

  return pickDeclaredContextWindow({
    knownWindows: [...configuredWindows, ...probedWindows],
    fallback: config?.contextWindowFallback,
  });
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
