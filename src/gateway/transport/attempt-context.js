// 单次派发尝试的平台上下文：把 attempt（platformId + modelId）落到具体的群 / 驱动 / 凭证。
// 需求意图：三条派发路径（HTTP 非流式、HTTP 流式、LlmAdapter）都要做同一件"找群→找驱动→解凭证"，
//          收在一处才能保证失败分类与提示完全一致。
// 思路：只做解析、不发请求；失败以结构化 error 返回（不抛），让调度引擎继续换下一个成员。

import { AUTH_KINDS, getDriver } from '../drivers/index.js';
import { resolveGroupCredentials } from '../config/credentials.js';
import { ERROR_CODES } from '../errors.js';
import { defaultLogger } from '../logger.js';

// 解析该尝试对应的上下文：{ ok, group, driver, credentials, error }
export async function resolveAttemptContext({ attempt, config, dataRoot, logger = defaultLogger } = {}) {
  const groups = Array.isArray(config?.groups) ? config.groups : [];
  const group = groups.find((candidate) => candidate.id === attempt?.platformId) ?? null;

  if (!group) {
    return {
      ok: false,
      group: null,
      driver: null,
      credentials: null,
      error: { code: ERROR_CODES.GROUP_NOT_FOUND, message: `群不存在：${attempt?.platformId ?? '(空)'}` },
    };
  }

  const driver = getDriver(group.driver);
  if (!driver) {
    return {
      ok: false,
      group,
      driver: null,
      credentials: null,
      error: { code: ERROR_CODES.DRIVER_FAILED, message: `驱动未加载：${group.driver}` },
    };
  }

  // 账号型驱动（如反代）的凭据不是 API Key：它自己按 auth.apiKeyRef 去账号存储取。
  // 这里若继续走 resolveGroupCredentials 会把它当 API Key 解析（UNSUPPORTED_API_KEY_REF_SCHEME），
  // 导致反代群永远到不了驱动。判定依据是驱动声明，不在网关写平台名。
  if (driver.authKind === AUTH_KINDS.REVERSE_ACCOUNT) {
    return { ok: true, group, driver, credentials: null, error: null };
  }

  const credentialResult = await resolveGroupCredentials(group, { dataRoot });
  if (!credentialResult.ok) {
    logger.warn(`群 ${group.id} 凭证不可用：${credentialResult.error.message}`);
    return {
      ok: false,
      group,
      driver,
      credentials: null,
      error: {
        code: ERROR_CODES.DRIVER_FAILED,
        message: `群 ${group.id} 凭证不可用：${credentialResult.error.message}`,
      },
    };
  }

  return { ok: true, group, driver, credentials: credentialResult.credentials, error: null };
}
