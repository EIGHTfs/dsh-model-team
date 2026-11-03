// 模型探测：加群表单点「探测可用模型」时用（docs/21）。核心约束：**绝不落盘**。
// 需求意图：用户还没建群，只想先确认 baseURL + Key 能列出哪些模型；因此这里只构造一个**临时群对象**
//          在内存里走驱动既有的 fetchModels 链路，不写 config.json、不写 credentials/。
// 错误归一：401/403 → probe-unauthorized、404 → probe-not-found、超时 → probe-timeout、其它 → probe-failed；
//          只给安全文案，不回传上游原始响应体（可能含敏感信息）。

import { getDriver } from './drivers/index.js';
import { safeFetchModels } from './group-models.js';
import { normalizeModelList } from './model-catalog.js';
import { CREDENTIALS_API_KEY_FIELD, resolveApiKeyRef } from './credentials.js';
import { defaultLogger } from './logger.js';
import { ERROR_CODES, GatewayError } from './errors.js';

// 缺省驱动与模型列表路径：与配置型驱动的默认值保持一致
const DEFAULT_PROBE_DRIVER_ID = 'openai-compatible';
const DEFAULT_MODELS_ENDPOINT_PATH = '/models';
// 临时群 id：只用于内存里跑一次 fetchModels，永远不会被写入配置
const PROBE_GROUP_ID = '__model_probe__';
const UNAUTHORIZED_STATUS_CODES = Object.freeze([401, 403]);
const NOT_FOUND_STATUS_CODE = 404;
// 超时类错误码/错误名：驱动可能给 code 也可能给 AbortError
const TIMEOUT_ERROR_PATTERN = /timeout|timedout|abort/i;
// 驱动在压根没拿到 Key 时给的错误码（status=0，请求没发出去）
const MISSING_CREDENTIAL_CODE = 'MISSING_CREDENTIAL';

// 上游失败 → 契约里的安全错误分类（不携带上游原文）
function toProbeError(modelsResult) {
  const upstreamStatus = modelsResult.error?.upstreamStatus;
  const upstreamCode = String(modelsResult.error?.code ?? '');

  if (upstreamCode === MISSING_CREDENTIAL_CODE) {
    return new GatewayError(ERROR_CODES.PROBE_UNAUTHORIZED, '缺少可用凭证', {
      hint: '提供 apiKey 或 apiKeyRef 后再探测',
    });
  }
  if (UNAUTHORIZED_STATUS_CODES.includes(upstreamStatus)) {
    return new GatewayError(ERROR_CODES.PROBE_UNAUTHORIZED, '凭证无效或没有模型列表权限', {
      hint: '检查 API Key 是否正确、是否已开通该平台的模型列表权限',
    });
  }
  if (upstreamStatus === NOT_FOUND_STATUS_CODE) {
    return new GatewayError(ERROR_CODES.PROBE_NOT_FOUND, '模型列表接口不存在', {
      hint: '检查 baseURL 是否包含正确的路径前缀，以及 modelsEndpoint（常见为 /models）',
    });
  }
  if (TIMEOUT_ERROR_PATTERN.test(upstreamCode) || TIMEOUT_ERROR_PATTERN.test(String(modelsResult.error?.message ?? ''))) {
    return new GatewayError(ERROR_CODES.PROBE_TIMEOUT, '探测超时', {
      hint: '确认该地址能从本机访问，或稍后重试',
    });
  }
  return new GatewayError(ERROR_CODES.PROBE_FAILED, '探测失败', {
    hint: '检查 baseURL 与网络连通性；上游原始错误已隐藏',
  });
}

// 解析凭证：明文只在内存里用一次；引用走既有解析器（env:/file:）
async function resolveProbeCredentials({ apiKey, apiKeyRef, dataRoot, logger }) {
  const plaintextApiKey = typeof apiKey === 'string' && apiKey.trim().length > 0 ? apiKey.trim() : null;
  if (plaintextApiKey) {
    return { credentials: { [CREDENTIALS_API_KEY_FIELD]: plaintextApiKey }, apiKeyRef: null };
  }

  const normalizedRef = typeof apiKeyRef === 'string' && apiKeyRef.trim().length > 0 ? apiKeyRef.trim() : null;
  if (!normalizedRef) {
    return { credentials: {}, apiKeyRef: null };
  }

  const resolvedRef = await resolveApiKeyRef(normalizedRef, { dataRoot });
  if (!resolvedRef.ok) {
    logger.warn(`探测凭证引用无法解析：${resolvedRef.message}`);
    throw new GatewayError(ERROR_CODES.PROBE_UNAUTHORIZED, '凭证引用无法解析', {
      hint: '检查 apiKeyRef 指向的环境变量或凭证文件是否有效',
    });
  }
  return { credentials: { [CREDENTIALS_API_KEY_FIELD]: resolvedRef.value }, apiKeyRef: normalizedRef };
}

// 探测入口：返回 { models: [{id,name}], count }；任何失败都转成契约错误码
export async function probeModels({ body = {}, dataRoot, logger = defaultLogger, fetchImpl } = {}) {
  const driverId = typeof body.driverId === 'string' && body.driverId.trim().length > 0
    ? body.driverId.trim()
    : DEFAULT_PROBE_DRIVER_ID;
  const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim() : '';
  if (baseURL.length === 0) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, '缺少 baseURL', {
      hint: '形如 { "baseURL": "https://api.example.com/v1" }',
    });
  }
  const modelsEndpoint = typeof body.modelsEndpoint === 'string' && body.modelsEndpoint.trim().length > 0
    ? body.modelsEndpoint.trim()
    : DEFAULT_MODELS_ENDPOINT_PATH;

  const driver = getDriver(driverId);
  if (!driver || typeof driver.fetchModels !== 'function') {
    throw new GatewayError(ERROR_CODES.DRIVER_NOT_FOUND, `驱动未加载或不支持模型列表：${driverId}`, {
      hint: '先确认驱动已安装（GET /_team/drivers 可查）',
    });
  }

  const { credentials, apiKeyRef } = await resolveProbeCredentials({
    apiKey: body.apiKey,
    apiKeyRef: body.apiKeyRef,
    dataRoot,
    logger,
  });

  // 临时群对象：只存在于本次调用的内存里，不写盘
  const probeGroup = {
    id: PROBE_GROUP_ID,
    name: 'model-probe',
    accessMode: 'official',
    driver: driverId,
    baseURL,
    auth: { type: 'bearer', ...(apiKeyRef ? { apiKeyRef } : {}) },
    models: { endpoint: modelsEndpoint },
  };

  const modelsResult = await safeFetchModels({
    driver,
    context: { group: probeGroup, credentials, logger, fetchImpl },
    logger,
  });
  if (!modelsResult.ok) {
    throw toProbeError(modelsResult);
  }

  const models = normalizeModelList(modelsResult.models, { logger });
  return { models, count: models.length };
}
