// HTTP 入口：node:http 服务 + 请求体解析 + CORS + 统一响应/错误（docs/09 §7/§11）。
// 需求意图：网关既能被宿主内嵌，也能 `node src/gateway/http-server.js` 独立起；
//          所有失败都必须变成 { error: { code, message, hint } }，不允许出现裸字符串或堆栈。
// 思路：本文件只做"管道"——读配置、读体、查路由（表在 routes.js）、调处理器、写响应；
//      业务判断全在 routes.js 与各业务模块；流式响应由处理器自己写完，管道只负责不再重复写。

import { API_PREFIX } from '../config/constants.js';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { readConfig, resolveHttpConfig } from '../config/config.js';
import { resolveGatewayDeps } from '../gateway-deps.js';
import { findRoute } from '../routes/index.js';
import { collectContributedRoutes } from './route-contributors.js';
import { ERROR_CODES, GatewayError, isGatewayError, toErrorPayload } from '../errors.js';
import { defaultLogger, describeFailure } from '../logger.js';
import { getDataRoot } from '../config/paths.js';

// 独立启动时的缺省监听地址（端口优先级：显式参数 → env → config.http.port）
export const PORT_ENV_VAR = 'DSH_MODEL_TEAM_PORT';
export const DEFAULT_HOST = '127.0.0.1';

// 成功/无内容状态码
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;

// CORS 预检允许的请求头与方法：前端要带会话头与 JSON 内容类型
const CORS_ALLOWED_HEADERS = 'content-type, authorization, x-team-session-id, x-tim-session-id';
const CORS_ALLOWED_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';

// 命中白名单才回 CORS 头：禁止 `*`（docs/09 §11），未命中的源按同源策略处理
function resolveAllowedOrigin(incomingRequest, httpConfig) {
  const requestOrigin = incomingRequest.headers.origin;
  if (typeof requestOrigin !== 'string' || requestOrigin.length === 0) {
    return null;
  }
  return httpConfig.corsOrigins.includes(requestOrigin) ? requestOrigin : null;
}

// 写 CORS 响应头：Vary 必须带 Origin，避免反代缓存把 A 源的响应发给 B 源
function applyCorsHeaders(outgoingResponse, allowedOrigin) {
  if (!allowedOrigin) {
    return;
  }
  outgoingResponse.setHeader('access-control-allow-origin', allowedOrigin);
  outgoingResponse.setHeader('vary', 'Origin');
  outgoingResponse.setHeader('access-control-allow-headers', CORS_ALLOWED_HEADERS);
  outgoingResponse.setHeader('access-control-allow-methods', CORS_ALLOWED_METHODS);
}

// 读 JSON 请求体：空体按 {} 处理，非法 JSON 报 400，超限报 413
export async function readJsonBody(incomingRequest, maxBodyBytes) {
  const bodyChunks = [];
  let receivedBytes = 0;
  for await (const bodyChunk of incomingRequest) {
    receivedBytes += bodyChunk.length;
    if (receivedBytes > maxBodyBytes) {
      throw new GatewayError(ERROR_CODES.PAYLOAD_TOO_LARGE, `请求体超过 ${maxBodyBytes} 字节上限`);
    }
    bodyChunks.push(bodyChunk);
  }
  const rawBodyText = Buffer.concat(bodyChunks).toString('utf8');
  if (rawBodyText.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(rawBodyText);
  } catch {
    throw new GatewayError(ERROR_CODES.INVALID_JSON, '请求体不是合法 JSON');
  }
}

// 写响应：字符串按纯文本（上游可能返回非 JSON），其余按 JSON
export function writeJsonResponse(outgoingResponse, statusCode, responseBody) {
  if (outgoingResponse.headersSent) {
    return;
  }
  if (typeof responseBody === 'string') {
    outgoingResponse.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
    outgoingResponse.end(responseBody);
    return;
  }
  const serializedBody = JSON.stringify(responseBody ?? null);
  outgoingResponse.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(serializedBody),
  });
  outgoingResponse.end(serializedBody);
}

// 错误响应：业务异常按其 status，未预期异常一律 500 且不回显细节
function writeErrorResponse({ error, outgoingResponse, logger, requestPath }) {
  if (isGatewayError(error)) {
    if (error.status >= 500) {
      logger.warn(`${requestPath} -> ${error.status} ${error.code}: ${error.message}`);
    }
    writeJsonResponse(outgoingResponse, error.status, toErrorPayload(error));
    return;
  }
  logger.error(`${requestPath} -> 500 未预期异常：${describeFailure(error)}`);
  writeJsonResponse(
    outgoingResponse,
    500,
    toErrorPayload(new GatewayError(ERROR_CODES.INTERNAL_ERROR, '网关内部错误')),
  );
}

// 单个请求的完整处理：读配置 → CORS/预检 → 查路由 → 读体 → 调处理器 → 写响应
// 导出是为了让宿主内嵌场景（插件把 /_team 挂到 DSH webServer）复用同一份管道，不另写一套
export async function handleGatewayRequest(requestOptions) {
  // 依赖缺省值只在这一处解析：独立服务与插件内路由两条入口因此完全等价
  const { incomingRequest, outgoingResponse } = requestOptions;
  const { dataRoot, logger, clock, fetchImpl, jsonlResolver, sessionSource, sessionLookup, getSessionService, providerIds, credentials } = resolveGatewayDeps(requestOptions);
  const requestPath = incomingRequest.url ?? '/';
  try {
    const config = await readConfig({ dataRoot, logger });
    const httpConfig = resolveHttpConfig(config);
    const allowedOrigin = resolveAllowedOrigin(incomingRequest, httpConfig);
    applyCorsHeaders(outgoingResponse, allowedOrigin);

    // 预检：白名单命中直接 204，不进入业务分发
    if ((incomingRequest.method ?? 'GET') === 'OPTIONS' && allowedOrigin) {
      outgoingResponse.writeHead(HTTP_NO_CONTENT);
      outgoingResponse.end();
      return;
    }

    const requestUrl = new URL(requestPath, `http://${incomingRequest.headers.host ?? 'localhost'}`);
    // 路由表 = 静态 ROUTES + 各域贡献的路由（transport 不认识具体域；未挂载时这些路径自然 404）
    const matchedRoute = findRoute(incomingRequest.method ?? 'GET', requestUrl.pathname, collectContributedRoutes({ logger }));
    if (!matchedRoute) {
      throw new GatewayError(ERROR_CODES.NOT_FOUND, `没有这个端点：${requestUrl.pathname}`, {
        hint: `对外入口是 /v1/chat/completions 与 /v1/models，内部端点前缀为 ${API_PREFIX}/`,
      });
    }
    if (matchedRoute.methodMismatch) {
      throw new GatewayError(ERROR_CODES.METHOD_NOT_ALLOWED, `方法不允许：${incomingRequest.method} ${requestUrl.pathname}`);
    }

    const requestBody = await readJsonBody(incomingRequest, httpConfig.maxBodyBytes);
    const handlerResult = await matchedRoute.route.handler({
      incomingRequest,
      outgoingResponse,
      params: matchedRoute.params,
      // 查询参数（只读端点用，如 ?platform=qoder）；写端点仍以 body 为准
      query: Object.fromEntries(requestUrl.searchParams),
      body: requestBody,
      config,
      dataRoot,
      logger,
      clock,
      fetchImpl,
      jsonlResolver,
      sessionSource,
      sessionLookup,
      getSessionService,
      providerIds,
      credentials,
    });
    // 流式处理器自己写完响应，这里只认标记、不再写第二遍
    if (handlerResult?.streamed === true) {
      return;
    }
    writeJsonResponse(outgoingResponse, handlerResult.status ?? HTTP_OK, handlerResult.body);
  } catch (requestError) {
    writeErrorResponse({ error: requestError, outgoingResponse, logger, requestPath });
  }
}

// 创建 http.Server（不监听）：宿主内嵌或测试直接用它
export function createGatewayServer(options = {}) {
  const { logger } = resolveGatewayDeps(options);
  return http.createServer((incomingRequest, outgoingResponse) => {
    handleGatewayRequest({ ...options, incomingRequest, outgoingResponse })
      .catch((fatalError) => {
        logger.error(`请求处理链异常：${describeFailure(fatalError)}`);
        writeJsonResponse(
          outgoingResponse,
          500,
          toErrorPayload(new GatewayError(ERROR_CODES.INTERNAL_ERROR, '网关内部错误')),
        );
      });
  });
}

// 启动并监听：返回 { server, port, url, close }
export async function startGatewayServer({ port, host = DEFAULT_HOST, ...serverOptions } = {}) {
  const logger = serverOptions.logger ?? defaultLogger;
  const dataRoot = serverOptions.dataRoot ?? getDataRoot();
  const config = await readConfig({ dataRoot, logger });
  const httpConfig = resolveHttpConfig(config);
  const requestedPort = port ?? Number(process.env[PORT_ENV_VAR] ?? httpConfig.port);
  const server = createGatewayServer({ ...serverOptions, dataRoot, logger });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(requestedPort, host, resolveListen);
  });
  const listeningAddress = server.address();
  const listeningPort = typeof listeningAddress === 'object' && listeningAddress ? listeningAddress.port : requestedPort;
  const gatewayUrl = `http://${host}:${listeningPort}`;
  logger.info(`网关已启动：${gatewayUrl}（数据根 ${dataRoot}）`);
  return {
    server,
    port: listeningPort,
    url: gatewayUrl,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

// 直接 `node src/gateway/http-server.js` 时自启动；宿主内嵌时不会触发
const isDirectRun = typeof process.argv[1] === 'string' && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  startGatewayServer().catch((startError) => {
    defaultLogger.error(`网关启动失败：${describeFailure(startError)}`);
    process.exitCode = 1;
  });
}
