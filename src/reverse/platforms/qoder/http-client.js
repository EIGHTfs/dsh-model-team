// 反代链路的 HTTP 客户端：超时下沉到 I/O 边界（AbortSignal），失败是明确结局。
//
// 不写 race 兜底：race 会把"请求挂住"变成"悄悄返回一个兜底值"，在推理链路上就是
// 用户看到空回复还以为是模型没说话。这里的规则是——超时就抛 REVERSE_HTTP_TIMEOUT。

export const REVERSE_HTTP_ERROR_CODES = Object.freeze({
  TIMEOUT: 'REVERSE_HTTP_TIMEOUT',
  FAILED: 'REVERSE_HTTP_FAILED',
});

// 单请求默认超时：与官方 CLI 同量级（30s）；可被群配置 group.request.timeoutMs 覆盖
export const DEFAULT_REVERSE_TIMEOUT_MS = 30_000;

export function createReverseHttpClient({ timeoutMs = DEFAULT_REVERSE_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  return async function request(requestUrl, requestInit = {}) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = requestInit.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([requestInit.signal, timeoutSignal])
      : timeoutSignal;
    try {
      return await fetchImpl(requestUrl, { ...requestInit, signal: combinedSignal });
    } catch (networkError) {
      const isTimeout = networkError?.name === 'TimeoutError' || networkError?.name === 'AbortError';
      const requestError = new Error(isTimeout ? `上游请求超时（${timeoutMs}ms）` : `上游请求失败：${networkError?.message ?? networkError}`);
      requestError.code = isTimeout ? REVERSE_HTTP_ERROR_CODES.TIMEOUT : REVERSE_HTTP_ERROR_CODES.FAILED;
      requestError.cause = networkError;
      throw requestError;
    }
  };
}
