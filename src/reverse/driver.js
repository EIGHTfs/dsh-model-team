// 反代驱动注册：**按注册表查表**，本文件不出现任何平台名（M1 铁律 1/2）。
//
// 一个平台一个驱动：driverId 取平台自描述的 driverId（reverse-<id>），accessMode=reverse。
// 本文件只做两件事：把平台元数据映射成驱动形状；把驱动调用转成 reverse 链路调用。
// 新增平台不需要动这里——平台目录 + reverse/index.js 注册表就够了。

import { getDataRoot } from '../gateway/config/paths.js';
import { defaultLogger, describeFailure } from '../gateway/logger.js';
import { AUTH_KINDS, registerDriver } from '../gateway/drivers/index.js';
import { createAccountStore } from './core/account-store.js';
import {
  ACCOUNT_COOLDOWN_ERROR_CODES,
  ACCOUNT_COOLDOWN_REASONS,
  createAccountHealthStore,
} from './core/account-health.js';
import { manifest } from './manifest.js';

// 各平台的推理实现按清单动态加载（driver.js 里不出现平台名）
const inferenceModules = new Map();
for (const entry of manifest.platforms) {
  if (typeof entry.inferModule !== 'string') continue;
  try {
    inferenceModules.set(entry.id, await import(entry.inferModule));
  } catch {
    // 加载失败只是该平台不可用；describeReverse 会报出来
  }
}

// accessMode 的 reverse 取值来自 drivers/index.js 的 ACCESS_MODES；这里用字面量避免循环依赖
const REVERSE_ACCESS_MODE = 'reverse';
// 群凭据引用形如 `account:<platformId>/<accountId>`
const ACCOUNT_REF_PREFIX = 'account:';

// 解析 account 引用；格式不对返回 null（由调用方报「未登录」而不是猜一个账号）
export function parseAccountRef(reference) {
  if (typeof reference !== 'string' || !reference.startsWith(ACCOUNT_REF_PREFIX)) return null;
  const remainder = reference.slice(ACCOUNT_REF_PREFIX.length);
  const separatorIndex = remainder.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === remainder.length - 1) return null;
  return { platformId: remainder.slice(0, separatorIndex), accountId: remainder.slice(separatorIndex + 1) };
}

// 群 → 反代凭据（来自 account-store）；拿不到返回 null，绝不用别的账号顶替
export async function resolveGroupReverseCredential(group, { dataRoot = getDataRoot(), logger = defaultLogger } = {}) {
  const accountRef = parseAccountRef(group?.auth?.apiKeyRef);
  if (!accountRef) return null;
  const accountStore = createAccountStore({ dataRoot, logger });
  const account = await accountStore.readAccount(accountRef.platformId, accountRef.accountId);
  return account?.credential ?? null;
}

function buildDriverError(code, message, extra = {}) {
  return {
    ok: false,
    status: extra.upstreamStatus ?? 0,
    events: null,
    error: {
      code,
      message,
      ...(extra.upstreamStatus ? { upstreamStatus: extra.upstreamStatus } : {}),
      ...(extra.cooldownUntilMs ? { cooldownUntilMs: extra.cooldownUntilMs } : {}),
      ...(extra.reason ? { reason: extra.reason } : {}),
    },
  };
}

// 同一账号两次上游请求的最小间隔（秒级常识：并发打同一账号最容易触发风控）
export const DEFAULT_MIN_REQUEST_INTERVAL_MS = 1_000;

// 失败分类：认证类不冷却（要用户重新登录），其余按软限流/硬失败/未知失败分流
export function classifyReverseFailure(inferenceError) {
  const upstreamStatus = inferenceError?.upstreamStatus;
  const code = inferenceError?.code ?? '';
  if (code === 'REVERSE_AUTH_REQUIRED' || upstreamStatus === 401 || upstreamStatus === 403) return 'auth';
  if (upstreamStatus === 429) return 'soft-rate';
  if (upstreamStatus >= 500 || code === 'REVERSE_HTTP_FAILED' || code === 'REVERSE_HTTP_TIMEOUT') return 'hard';
  return 'unknown';
}

// 间隔等待量（纯函数，便于单测；不足 0 表示不用等）
export function computeRequestWaitMs({ lastRequestAtMs, minIntervalMs, nowMs }) {
  if (!lastRequestAtMs || minIntervalMs <= 0) return 0;
  return Math.max(0, lastRequestAtMs + minIntervalMs - nowMs);
}

export function createReverseDriver({
  platform,
  logger = defaultLogger,
  // 测试注入：默认用平台清单里声明的推理实现
  inferenceOverride = null,
  now = () => Date.now(),
  sleep = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); }),
  minRequestIntervalMs = DEFAULT_MIN_REQUEST_INTERVAL_MS,
  dataRoot,
} = {}) {
  // 缺账号只 info 一次（不是 warn 刷屏）：这是"还没登录过"的正常状态，不是故障
  let informedMissingAccount = false;
  // accountId → 上一次上游请求时刻（进程内即可：间隔是"别连着打"，重启后重新计也无害）
  const lastRequestAtMsByAccount = new Map();
  return {
    id: platform.driverId,
    name: platform.name ?? platform.id,
    accessMode: REVERSE_ACCESS_MODE,
    // 上游错误认领：只透传平台声明里的字符串路径与模块地址（本文件不 import 平台实现）
    streamErrorClaimersModule: platform.streamErrorClaimersModule ?? null,
    streamErrorClaimersBase: platform.streamErrorClaimersBase ?? null,
    // 界面判别标记：有它就渲染"账号区"而不是 API Key 输入框
    authKind: AUTH_KINDS.REVERSE_ACCOUNT,
    platformId: platform.id,
    // 反代不吃群里的 apiKey 字段：凭据是 account 引用（由 account-store 管理）
    // options 由 GET /_team/reverse/accounts 动态填充（optionsSource 告诉前端去哪儿取）
    authSchema: [{
      key: 'accountId',
      label: '账号',
      type: 'select',
      required: true,
      options: [],
      optionsSource: 'reverse-accounts',
    }],
    async validateAuth(context = {}) {
      // 契约：驱动返回**布尔值**（网关用 `isValid === true` 判定）。
      // 曾返回 {ok:true} 对象，导致账号存在也一律报「鉴权无效」。
      const credential = await resolveGroupReverseCredential(context.group, { dataRoot: context.dataRoot, logger });
      if (credential) return true;
      logger?.info?.(`反代平台 ${platform.id} 尚无可用账号（群 ${context.group?.id ?? ''}）：先登录或走凭据导入`);
      return false;
    },
    // 模型清单：运行时从上游拉（平台实现负责签名/解析/缓存）。失败必须抛错——
    // 返回空数组会变成"探测成功但零模型"，把真实原因（未登录/403/加密体）藏起来。
    async fetchModels(context = {}) {
      const credential = await resolveGroupReverseCredential(context.group, { dataRoot: context.dataRoot ?? dataRoot, logger });
      if (!credential) {
        throw Object.assign(new Error(`反代平台 ${platform.id} 尚未登录：先在加群页完成登录或导入账号`), { code: 'REVERSE_NOT_LOGGED_IN' });
      }
      const platformImpl = platform.createPlatform({});
      return platformImpl.listModels({
        credential,
        dataRoot: context.dataRoot ?? dataRoot ?? getDataRoot(),
        logger,
        fetchImpl: context.fetchImpl,
      });
    },
    async streamCompletions(context = {}, requestBody = {}, options = {}) {
      let credential;
      try {
        credential = await resolveGroupReverseCredential(context.group, { dataRoot: context.dataRoot, logger });
      } catch (resolveError) {
        return buildDriverError('REVERSE_CREDENTIAL_FAILED', `读取反代凭据失败：${describeFailure(resolveError)}`);
      }
      if (!credential) {
        if (!informedMissingAccount) {
          informedMissingAccount = true;
          logger.info(`反代平台 ${platform.id} 尚无可用账号：该平台暂不可用（界面上点「登录」或走凭据导入）`);
        }
        return buildDriverError('REVERSE_NOT_LOGGED_IN', `未登录：群 ${context.group?.id ?? ''} 的凭据引用不是有效账号（先登录或导入账号）`);
      }

      // 模型名由调用方给（真实模型 key）；目录是运行时数据，这里不再从静态清单兜底
      const model = typeof requestBody.model === 'string' ? requestBody.model.trim() : '';
      const timeoutMs = context.group?.request?.timeoutMs;
      const accountRef = parseAccountRef(context.group?.auth?.apiKeyRef);
      const accountId = accountRef?.accountId ?? '';
      // 适配层给的 driverContext 里没有 dataRoot：必须自己兜底，否则冷却/间隔在真实链路里会静默失效
      const resolvedDataRoot = context.dataRoot ?? dataRoot ?? getDataRoot();
      const healthStore = accountId && resolvedDataRoot
        ? createAccountHealthStore({ dataRoot: resolvedDataRoot, platformId: platform.id, now })
        : null;

      // ① 冷却期内不发请求：直接返回明确错误码（账号级，不是内容级）
      if (healthStore) {
        const cooldown = await healthStore.cooldownOf(accountId);
        if (cooldown.blocked) {
          return buildDriverError(cooldown.code, `账号 ${accountId} 处于冷却期（${cooldown.reason}），解冻时间 ${new Date(cooldown.untilMs).toISOString()}`, {
            cooldownUntilMs: cooldown.untilMs,
            reason: cooldown.reason,
          });
        }
      }

      // ② 同一账号两次请求至少隔 1s：不足就等，不报错
      if (accountId && minRequestIntervalMs > 0) {
        const waitMs = computeRequestWaitMs({
          lastRequestAtMs: lastRequestAtMsByAccount.get(accountId) ?? 0,
          minIntervalMs: minRequestIntervalMs,
          nowMs: now(),
        });
        if (waitMs > 0) await sleep(waitMs);
      }

      try {
        const inferenceModule = inferenceOverride ?? inferenceModules.get(platform.id);
        if (!inferenceModule) return buildDriverError('REVERSE_INFERENCE_FAILED', `平台 ${platform.id} 的推理实现未加载`);
        const { status, chunks } = await inferenceModule.openInferenceStream({
          credential,
          messages: requestBody.messages,
          tools: requestBody.tools,
          model,
          platform,
          signal: options.signal,
          timeoutMs: typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : undefined,
          fetchImpl: context.fetchImpl,
          dataRoot: context.dataRoot,
        });
        if (accountId) lastRequestAtMsByAccount.set(accountId, now());
        if (healthStore) await healthStore.recordSuccess(accountId);
        return { ok: true, status, events: chunks, error: null };
      } catch (inferenceError) {
        if (accountId) lastRequestAtMsByAccount.set(accountId, now());
        // 明确失败：不换端点、不降级公开 API、不重试；但账号健康度要记账
        const failureKind = classifyReverseFailure(inferenceError);
        if (healthStore && accountId) {
          if (failureKind === 'soft-rate') {
            const result = await healthStore.recordSoftRate(accountId);
            return buildDriverError(ACCOUNT_COOLDOWN_ERROR_CODES[ACCOUNT_COOLDOWN_REASONS.SOFT_RATE], `上游限流（429）：账号 ${accountId} 冷却至 ${new Date(result.cooldownUntilMs).toISOString()}`, {
              upstreamStatus: 429,
              cooldownUntilMs: result.cooldownUntilMs,
              reason: ACCOUNT_COOLDOWN_REASONS.SOFT_RATE,
            });
          }
          if (failureKind === 'hard') {
            const result = await healthStore.recordHardFailure(accountId);
            if (result.breaker) {
              return buildDriverError(ACCOUNT_COOLDOWN_ERROR_CODES[ACCOUNT_COOLDOWN_REASONS.BREAKER], `连续硬失败 ${result.streak} 次：账号 ${accountId} 已熔断至 ${new Date(result.cooldownUntilMs).toISOString()}`, {
                upstreamStatus: inferenceError?.upstreamStatus,
                cooldownUntilMs: result.cooldownUntilMs,
                reason: ACCOUNT_COOLDOWN_REASONS.BREAKER,
              });
            }
          }
          if (failureKind === 'unknown') {
            const result = await healthStore.recordUnknownFailure(accountId);
            if (result.degraded) {
              return buildDriverError(ACCOUNT_COOLDOWN_ERROR_CODES[ACCOUNT_COOLDOWN_REASONS.DEGRADE], `连续未知失败 ${result.streak} 次：账号 ${accountId} 已降权至 ${new Date(result.cooldownUntilMs).toISOString()}`, {
                cooldownUntilMs: result.cooldownUntilMs,
                reason: ACCOUNT_COOLDOWN_REASONS.DEGRADE,
              });
            }
          }
        }
        return buildDriverError(inferenceError?.code ?? 'REVERSE_INFERENCE_FAILED', inferenceError?.message ?? String(inferenceError), {
          upstreamStatus: inferenceError?.upstreamStatus,
        });
      }
    },
  };
}

// 注册表 → 驱动列表：只有声明了 encryptedInference 能力且未显式关闭的平台才注册
export function listReverseDrivers({ platforms, logger = defaultLogger } = {}) {
  const platformList = Array.isArray(platforms) ? platforms : [];
  const drivers = [];
  for (const platform of platformList) {
    if (platform?.capabilities?.encryptedInference !== true) continue;
    drivers.push(createReverseDriver({ platform, logger }));
  }
  return drivers;
}

// 把驱动交给网关注册表；重复登记只跳过（插件重载/测试重复调用都安全）
export function registerReverseDrivers({ platforms, logger = defaultLogger } = {}) {
  const registeredIds = [];
  for (const driver of listReverseDrivers({ platforms, logger })) {
    try {
      registerDriver(driver, { originLabel: `反代平台 ${driver.id}` });
      registeredIds.push(driver.id);
    } catch (registerError) {
      logger.warn(`反代驱动未登记：${describeFailure(registerError)}`);
    }
  }
  return registeredIds;
}

// 幂等版：建反代群时兜底登记（独立网关/测试没有插件 apply，也要能建群）
export function ensureReverseDriversRegistered({ platforms, logger = defaultLogger } = {}) {
  const registeredIds = [];
  for (const driver of listReverseDrivers({ platforms, logger })) {
    try {
      registerDriver(driver, { originLabel: `反代平台 ${driver.id}` });
      registeredIds.push(driver.id);
    } catch (registerError) {
      // 已登记过时 registerDriver 会抛重复；这里吞掉并视为成功
      if (!String(registerError?.message ?? '').includes('重复')) {
        logger.warn(`反代驱动未登记：${describeFailure(registerError)}`);
      }
      registeredIds.push(driver.id);
    }
  }
  return registeredIds;
}
