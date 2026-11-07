// 宿主 webServer 的 (req,res) → 我们 handler 吃的 context 适配器。
//
// 为什么需要：宿主只给 `handler(req, res)`（原生 HTTP 对象），而域内 handler 统一吃
// `{ params, query, body, dataRoot, logger, fetchImpl }` 并返回 `{ status, body }`。
// 这一层把两边的差异全部吸收，使得 handler 与 HTTP 框架无关（将来换宿主也不用改 handler）。

import { API_PREFIX } from '../../gateway/config/constants.js';
import { ERROR_CODES, GatewayError, isGatewayError, toErrorPayload } from '../../gateway/errors.js';
import { defaultLogger, describeFailure } from '../../gateway/logger.js';

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_BAD_REQUEST = 400;
const HTTP_SERVER_ERROR = 500;
// 请求体上限：反代端点只收小 JSON（登录/导入），不需要大 payload 能力
const MAX_BODY_BYTES = 256 * 1024;

async function readJsonBody(incomingRequest) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of incomingRequest) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new GatewayError(ERROR_CODES.INVALID_REQUEST, '请求体过大');
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const rawText = Buffer.concat(chunks).toString('utf8').trim();
  if (rawText.length === 0) return {};
  try {
    return JSON.parse(rawText);
  } catch {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, '请求体不是合法 JSON');
  }
}

function writeJson(outgoingResponse, statusCode, payload) {
  const bodyText = JSON.stringify(payload ?? {});
  outgoingResponse.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(bodyText),
  });
  outgoingResponse.end(bodyText);
}

// 路径匹配：支持 ':' 占位（与 model-team 路由表同口径）
function matchPath(pattern, pathname) {
  const patternSegments = pattern.split('/').filter((segment) => segment.length > 0);
  const pathSegments = pathname.split('/').filter((segment) => segment.length > 0);
  if (patternSegments.length !== pathSegments.length) return null;
  const params = {};
  for (const [index, patternSegment] of patternSegments.entries()) {
    if (patternSegment.startsWith(':')) {
      params[patternSegment.slice(1)] = decodeURIComponent(pathSegments[index]);
      continue;
    }
    if (patternSegment !== pathSegments[index]) return null;
  }
  return params;
}

/**
 * 生成宿主可直接使用的 (req,res) 处理器。
 * @param {object} options
 * @param {Array<{method: string, pattern: string, handler: Function}>} options.routes 域内路由（已解析好 handler）
 */
export function createReverseRouteHandler({ routes, dataRoot, logger = defaultLogger, credentials } = {}) {
  return async function handleReverseHttpRequest(incomingRequest, outgoingResponse) {
    const requestUrl = new URL(incomingRequest.url ?? '/', `http://${incomingRequest.headers.host ?? 'localhost'}`);
    const requestMethod = incomingRequest.method ?? 'GET';

    let methodMismatch = false;
    for (const route of routes) {
      const params = matchPath(route.pattern, requestUrl.pathname);
      if (!params) continue;
      if (route.method !== requestMethod) { methodMismatch = true; continue; }
      try {
        const body = await readJsonBody(incomingRequest);
        const handlerResult = await route.handler({
          params,
          query: Object.fromEntries(requestUrl.searchParams),
          body,
          dataRoot,
          logger,
          fetchImpl: globalThis.fetch,
          credentials,
        });
        writeJson(outgoingResponse, handlerResult?.status ?? HTTP_OK, handlerResult?.body ?? {});
      } catch (requestError) {
        const statusCode = isGatewayError(requestError)
          ? (requestError.code === ERROR_CODES.NOT_FOUND ? HTTP_NOT_FOUND
            : requestError.code === ERROR_CODES.METHOD_NOT_ALLOWED ? HTTP_METHOD_NOT_ALLOWED
            : requestError.code === ERROR_CODES.INVALID_REQUEST ? HTTP_BAD_REQUEST
            : HTTP_SERVER_ERROR)
          : HTTP_SERVER_ERROR;
        if (statusCode >= HTTP_SERVER_ERROR) logger.warn(`反代端点异常（${route.method} ${route.pattern}）：${describeFailure(requestError)}`);
        writeJson(outgoingResponse, statusCode, { error: toErrorPayload(requestError) });
      }
      return;
    }

    if (methodMismatch) {
      writeJson(outgoingResponse, HTTP_METHOD_NOT_ALLOWED, { error: { code: ERROR_CODES.METHOD_NOT_ALLOWED, message: `方法不允许：${requestMethod} ${requestUrl.pathname}` } });
      return;
    }
    writeJson(outgoingResponse, HTTP_NOT_FOUND, { error: { code: ERROR_CODES.NOT_FOUND, message: `没有这个端点：${requestUrl.pathname}` } });
  };
}

// 反代在宿主上的挂载前缀（整个域只占一个 prefix 路由）
export const REVERSE_ROUTE_PREFIX = `${API_PREFIX}/reverse`;
