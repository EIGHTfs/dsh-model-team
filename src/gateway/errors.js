// 统一错误形状：网关所有失败都收敛成 { error: { code, message, hint } }（docs/09 §7）。
// 需求意图：前端只按 code 分支、按 hint 给用户下一步；接口层不允许出现裸字符串或堆栈。
// 思路：用 GatewayError 携带 HTTP 状态与业务 code，http-server 统一 toErrorPayload；
//      未预期的内部异常一律 500 且只记日志、不回显细节（避免泄露实现与凭证路径）。

// 错误码常量：前后端共用同一套，避免手写字符串导致拼错
export const ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'invalid-request',
  INVALID_JSON: 'invalid-json',
  SESSION_UNRESOLVED: 'session-unresolved',
  MODEL_UNRESOLVED: 'model-unresolved',
  GROUP_NOT_FOUND: 'group-not-found',
  GROUP_EXISTS: 'group-exists',
  MAPPING_NOT_FOUND: 'mapping-not-found',
  NO_ACTIVE_SESSION: 'no-active-session',
  SESSION_NOT_FOUND: 'session-not-found',
  AMBIGUOUS_MODEL: 'ambiguous-model',
  FRIEND_GROUP_NOT_FOUND: 'friend-group-not-found',
  FRIEND_GROUP_IN_USE: 'friend-group-in-use',
  // 模型探测（POST /_team/models/probe）：只给安全分类，不回传上游原始响应体
  PROBE_UNAUTHORIZED: 'probe-unauthorized',
  PROBE_NOT_FOUND: 'probe-not-found',
  PROBE_TIMEOUT: 'probe-timeout',
  PROBE_FAILED: 'probe-failed',
  DRIVER_NOT_FOUND: 'driver-not-found',
  DRIVER_FAILED: 'driver-failed',
  UPSTREAM_ERROR: 'upstream-error',
  UPSTREAM_TIMEOUT: 'upstream-timeout',
  CONFIRMATION_REQUIRED: 'confirmation-required',
  NOT_FOUND: 'not-found',
  METHOD_NOT_ALLOWED: 'method-not-allowed',
  PAYLOAD_TOO_LARGE: 'payload-too-large',
  INTERNAL_ERROR: 'internal-error',
});

// HTTP 状态缺省值：业务方不指定时按 code 推断
const DEFAULT_STATUS_BY_CODE = Object.freeze({
  [ERROR_CODES.INVALID_REQUEST]: 400,
  [ERROR_CODES.INVALID_JSON]: 400,
  [ERROR_CODES.SESSION_UNRESOLVED]: 400,
  [ERROR_CODES.MODEL_UNRESOLVED]: 400,
  [ERROR_CODES.GROUP_NOT_FOUND]: 404,
  [ERROR_CODES.GROUP_EXISTS]: 409,
  [ERROR_CODES.MAPPING_NOT_FOUND]: 404,
  [ERROR_CODES.NO_ACTIVE_SESSION]: 404,
  [ERROR_CODES.SESSION_NOT_FOUND]: 404,
  [ERROR_CODES.AMBIGUOUS_MODEL]: 400,
  [ERROR_CODES.FRIEND_GROUP_NOT_FOUND]: 404,
  [ERROR_CODES.FRIEND_GROUP_IN_USE]: 409,
  [ERROR_CODES.PROBE_UNAUTHORIZED]: 401,
  [ERROR_CODES.PROBE_NOT_FOUND]: 404,
  [ERROR_CODES.PROBE_TIMEOUT]: 504,
  [ERROR_CODES.PROBE_FAILED]: 502,
  [ERROR_CODES.DRIVER_NOT_FOUND]: 404,
  [ERROR_CODES.DRIVER_FAILED]: 502,
  [ERROR_CODES.UPSTREAM_ERROR]: 502,
  [ERROR_CODES.UPSTREAM_TIMEOUT]: 504,
  [ERROR_CODES.CONFIRMATION_REQUIRED]: 409,
  [ERROR_CODES.NOT_FOUND]: 404,
  [ERROR_CODES.METHOD_NOT_ALLOWED]: 405,
  [ERROR_CODES.PAYLOAD_TOO_LARGE]: 413,
  [ERROR_CODES.INTERNAL_ERROR]: 500,
});

// 业务异常：http-server 只认这个类型做"预期失败"分支
export class GatewayError extends Error {
  constructor(code, message, { hint = '', status, upstreamStatus, details } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.hint = hint;
    this.status = status ?? DEFAULT_STATUS_BY_CODE[code] ?? 500;
    if (upstreamStatus !== undefined) {
      this.upstreamStatus = upstreamStatus;
    }
    if (details !== undefined) {
      this.details = details;
    }
  }
}

// 转成响应体：字段固定三件套，细节（details）只在明确允许时并入
export function toErrorPayload(gatewayError) {
  const errorPayload = {
    code: gatewayError.code,
    message: gatewayError.message,
    hint: gatewayError.hint ?? '',
  };
  if (gatewayError.upstreamStatus !== undefined) {
    errorPayload.upstreamStatus = gatewayError.upstreamStatus;
  }
  if (gatewayError.details !== undefined) {
    errorPayload.details = gatewayError.details;
  }
  return { error: errorPayload };
}

// 判断是否业务异常（用于区分 500 与预期失败）
export function isGatewayError(errorCandidate) {
  return errorCandidate instanceof GatewayError;
}
