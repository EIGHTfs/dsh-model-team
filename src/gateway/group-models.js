// 群模型列表：@ 选择器与"测试连接"共用的取模型链路。
// 需求意图：驱动允许抛错（docs/04），但调用方只想要"要么拿到列表、要么拿到明确错误"，
//          所以在这一层统一把异常收敛成 GatewayError，绝不把异常原样丢给 HTTP 客户端。
// 思路：解引用凭证 → 调驱动 fetchModels → 失败按上游错误 502 上抛；配置问题（驱动缺失/凭证缺失）单独分类。

import { getDriver } from './drivers/index.js';
import { resolveGroupCredentials } from './credentials.js';
import { normalizeModelList } from './model-catalog.js';
import { defaultLogger, describeFailure } from './logger.js';
import { ERROR_CODES, GatewayError } from './errors.js';

// safeFetchModels：驱动允许抛错，这里统一收敛成结构化结果（docs/04 要求网关必须包装）
export async function safeFetchModels({ driver, context, logger = defaultLogger }) {
  if (!driver || typeof driver.fetchModels !== 'function') {
    return { ok: false, models: [], error: { code: ERROR_CODES.DRIVER_FAILED, message: '驱动不支持模型列表' } };
  }
  try {
    const models = await driver.fetchModels(context);
    return { ok: true, models: Array.isArray(models) ? models : [], error: null };
  } catch (fetchError) {
    logger.warn(`驱动模型列表获取失败：${describeFailure(fetchError)}`);
    return {
      ok: false,
      models: [],
      error: {
        code: fetchError?.code ?? ERROR_CODES.UPSTREAM_ERROR,
        message: describeFailure(fetchError),
        upstreamStatus: fetchError?.status,
      },
    };
  }
}

// 取某个群的模型列表：凭证缺失与上游错误都转成业务异常
export async function fetchGroupModels(group, { dataRoot, logger = defaultLogger, fetchImpl } = {}) {
  const driver = getDriver(group.driver);
  if (!driver) {
    throw new GatewayError(ERROR_CODES.DRIVER_NOT_FOUND, `驱动未加载：${group.driver}`);
  }
  const credentialResult = await resolveGroupCredentials(group, { dataRoot });
  if (!credentialResult.ok) {
    throw new GatewayError(ERROR_CODES.DRIVER_FAILED, `群 ${group.id} 凭证不可用：${credentialResult.error.message}`, {
      hint: '检查 apiKeyRef 指向的环境变量或凭证文件',
    });
  }
  const modelsResult = await safeFetchModels({
    driver,
    context: { group, credentials: credentialResult.credentials, logger, fetchImpl },
    logger,
  });
  if (!modelsResult.ok) {
    throw new GatewayError(ERROR_CODES.UPSTREAM_ERROR, modelsResult.error.message, {
      hint: '上游返回异常，检查 baseURL 与凭证是否有效',
      upstreamStatus: modelsResult.error.upstreamStatus,
    });
  }
  // 统一出参形状：{ id, name }（static 群也走同一归一，docs/21）
  return normalizeModelList(modelsResult.models, { logger });
}
