// 反代驱动注册：**按注册表查表**，本文件不出现任何平台名（M1 铁律 1/2）。
//
// 一个平台一个驱动：driverId 取平台自描述的 driverId（reverse-<id>），accessMode=reverse。
// 本文件只做两件事：把平台元数据映射成驱动形状；把驱动调用转成 reverse 链路调用。
// 新增平台不需要动这里——平台目录 + reverse/index.js 注册表就够了。

import { getDataRoot } from '../gateway/config/paths.js';
import { defaultLogger, describeFailure } from '../gateway/logger.js';
import { registerDriver } from '../gateway/drivers/index.js';
import { createAccountStore } from './core/account-store.js';
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
  return { ok: false, status: extra.upstreamStatus ?? 0, events: null, error: { code, message, ...(extra.upstreamStatus ? { upstreamStatus: extra.upstreamStatus } : {}) } };
}

export function createReverseDriver({ platform, logger = defaultLogger }) {
  // 缺账号只 info 一次（不是 warn 刷屏）：这是"还没登录过"的正常状态，不是故障
  let informedMissingAccount = false;
  return {
    id: platform.driverId,
    name: platform.name ?? platform.id,
    accessMode: REVERSE_ACCESS_MODE,
    // 反代不吃群里的 apiKey 字段：凭据是 account 引用（由 account-store 管理）
    authSchema: [],
    async validateAuth(context = {}) {
      const credential = await resolveGroupReverseCredential(context.group, { dataRoot: context.dataRoot, logger });
      return credential ? { ok: true } : { ok: false, message: '未登录：请先执行 node scripts/reverse-login.mjs --platform ' + platform.id };
    },
    // 模型清单来自平台目录（加密链路的模型 key 是目录 key，不额外请求上游）
    async fetchModels() {
      const catalogKeys = Array.isArray(platform.capabilities?.catalogKeys) ? platform.capabilities.catalogKeys : [];
      return catalogKeys.map((catalogKey) => ({ id: catalogKey, name: catalogKey }));
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
          logger.info(`反代平台 ${platform.id} 尚无可用账号：该平台暂不可用（先 node scripts/reverse-login.mjs --platform ${platform.id} 或走导入）`);
        }
        return buildDriverError('REVERSE_NOT_LOGGED_IN', `未登录：群 ${context.group?.id ?? ''} 的凭据引用不是有效账号（先 node scripts/reverse-login.mjs --platform ${platform.id}）`);
      }

      const model = typeof requestBody.model === 'string' && requestBody.model.length > 0
        ? requestBody.model
        : (platform.capabilities?.catalogKeys?.[0] ?? '');
      const timeoutMs = context.group?.request?.timeoutMs;

      try {
        const inferenceModule = inferenceModules.get(platform.id);
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
        return { ok: true, status, events: chunks, error: null };
      } catch (inferenceError) {
        // 明确失败：不换端点、不降级公开 API、不重试
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
