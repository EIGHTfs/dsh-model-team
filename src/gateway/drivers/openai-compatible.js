// 内置配置型驱动（accessMode=official）：OpenAI 兼容平台用一份配置即可接入，不需要写代码。
// 需求意图：合法接入是默认形态——只走平台公开 API、鉴权用公开 API Key；本项目不提供任何反代/私有接口能力，
//          所以本文件不实现 reverse 相关逻辑。
// 思路：驱动只做"按群配置拼请求 + 解析响应"，凭证解引用由网关先做（context.credentials 已就绪）；
//      chatCompletions 不抛异常，统一返回 { ok, status, response, usage, error }，网关据此写请求行而不中断服务；
//      fetchModels 按契约返回数组，失败时抛带 code/status 的错误，由调用方捕获（网关集中记失败）。

import { DEFAULT_MODELS_ENDPOINT_PATH, DEFAULT_USER_AGENT } from '../config/constants.js';
import { defaultLogger, describeFailure } from '../logger.js';
import { normalizeContextLength, normalizeMaxOutputTokens } from '../model/capacity.js';
import { CREDENTIALS_API_KEY_FIELD } from '../config/credentials.js';
import { AUTH_KINDS } from './auth-kinds.js';
import { createUpstreamClient } from '../transport/upstream-client.js';

// 字段映射与 usage 解析拆到 mapping.js：配置型驱动与统计层共用同一份实现
import {
  DEFAULT_MODEL_FIELD_PATH,
  DEFAULT_USAGE_PATH,
  extractUsage,
  prepareOutboundBody,
  readFieldByPath,
  renderSummaryTemplate,
} from '../mapping.js';

// 兼容旧导入路径：拆分后这些名字仍可从本模块取得，不破坏既有调用方
export { DEFAULT_MODEL_FIELD_PATH, DEFAULT_USAGE_PATH, extractUsage, readFieldByPath, renderSummaryTemplate };

// SSE 解析复用网关同一份实现：流式与非流式只差"要不要等整段"
import { SSE_DONE_MARKER, parseSseEvents } from '../transport/sse.js';

// 上游无视 stream 参数、直接回整段 JSON 时，包成一个事件，避免客户端空等
async function* toSingleSseEvent(rawBodyText) {
  yield { event: null, data: rawBodyText.length > 0 ? rawBodyText : '{}' };
  yield { event: null, data: SSE_DONE_MARKER };
}

// 驱动标识与显示名（配置里 group.driver 引用前者）
export const OPENAI_COMPATIBLE_DRIVER_ID = 'openai-compatible';
export const OPENAI_COMPATIBLE_DRIVER_NAME = 'OpenAI 兼容（配置型）';

// accessMode 取值由 docs/07 冻结；这里不 import 注册表模块，避免与 drivers/index.js 形成循环依赖
export const ACCESS_MODE_OFFICIAL = 'official';

// 鉴权三种形态（docs/08）：bearer 走 Authorization 头，header 自定义头，query 拼查询参数
export const AUTH_TYPES = Object.freeze({
  BEARER: 'bearer',
  HEADER: 'header',
  QUERY: 'query',
});
// 未声明 auth.type 时的缺省形态：OpenAI 兼容平台的事实标准
export const DEFAULT_AUTH_TYPE = AUTH_TYPES.BEARER;
export const DEFAULT_AUTH_HEADER_NAME = 'Authorization';
export const DEFAULT_AUTH_QUERY_PARAMETER = 'api_key';

// 端点缺省值：配置里的 models.endpoint / 无配置时用这两个
export const DEFAULT_CHAT_COMPLETIONS_ENDPOINT_PATH = '/chat/completions';

// 上游超时：长回答常见 30s 起步，给一倍余量；不同平台可在 group.request.timeoutMs 覆盖
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

// 错误信息里附带的原文摘录上限：够定位问题，又不会把整段 HTML 错误页灌进日志
const MAX_ERROR_EXCERPT_LENGTH = 200;

// HTTP 2xx 视为成功；其余状态码原样带回给网关，由请求行体现
export const HTTP_SUCCESS_MIN = 200;
export const HTTP_SUCCESS_MAX = 299;

// 群表单字段：前端按这张 schema 动态渲染（顺序即界面顺序）
// baseURL/apiKey 必填；模型列表可自动拉取，也可手动逐行填写（选 manual 时才显示 manualModels）
export const OPENAI_COMPATIBLE_AUTH_SCHEMA = Object.freeze([
  {
    key: 'baseURL',
    label: 'API 地址',
    type: 'text',
    required: true,
    // 只给通用示例地址，不写任何真实平台域名（平台地址来自 config/platforms.json）
    placeholder: 'https://api.example.com/v1',
  },
  {
    key: 'apiKey',
    label: 'API Key',
    type: 'password',
    required: true,
    placeholder: '粘贴平台控制台里的 Key',
  },
  {
    key: 'modelSource',
    label: '模型列表来源',
    type: 'select',
    required: false,
    options: [
      { value: 'auto', label: '自动拉取（调 /models）' },
      { value: 'manual', label: '手动填写' },
    ],
  },
  {
    key: 'manualModels',
    label: '模型名（每行一个）',
    type: 'textarea',
    required: false,
    placeholder: 'my-model-a\nmy-model-b',
    showWhen: { key: 'modelSource', value: 'manual' },
  },
]);

// 失败结果工厂：status=0 表示请求没有真正发出（凭证/地址问题）
function upstreamFailure(code, message) {
  return { ok: false, status: 0, response: null, usage: null, error: { code, message } };
}

// 出站传输选择（docs/23 O-1）：
//   · 默认走自持客户端（UA 由客户端最后合并，宿主覆盖不到）；
//   · `DSH_MODEL_TEAM_USE_HOST_FETCH=1` 走宿主 fetch —— **永久开关**，供需要宿主代理/证书行为的
//     部署长期使用（不是过渡措施，不要按"临时兼容"对待）；
//   · 注入的不是全局 fetch（= 测试/部署方的自定义桩）时也走 fetch，保证既有桩用例不用改。
//
// 作用范围（重要）：本文件只服务 `rewrite` 模式。默认的 `forward` 模式由宿主官方适配器出站
// （src/plugin/adapter/forward.js），UA 是宿主的，本客户端管不到——所以"UA 已改自持"只对 rewrite 成立。
//
// 为什么放在驱动层而不是客户端里：客户端是中立层，不读环境变量。
function resolveUpstreamTransport(context, timeoutMs) {
  const injectedFetch = context?.fetchImpl;
  const useHostFetchSwitch = Boolean(process.env?.DSH_MODEL_TEAM_USE_HOST_FETCH === '1');
  const hasInjectedStub = typeof injectedFetch === 'function' && injectedFetch !== globalThis.fetch;
  if (useHostFetchSwitch || hasInjectedStub) {
    return { kind: 'fetch', fetchImpl: injectedFetch ?? globalThis.fetch };
  }
  return { kind: 'client', client: createUpstreamClient({ timeoutMs }) };
}

// 驱动错误：让 fetchModels 的调用方能拿到 code/status 而不是只有一句话
function createDriverError(code, message, status = 0) {
  const driverError = new Error(message);
  driverError.code = code;
  driverError.status = status;
  return driverError;
}

// 按用户配置拼鉴权；凭证缺失时返回失败而不是发一个没有 Key 的请求出去
function planAuth(authConfig, credentials) {
  const authType = authConfig?.type ?? DEFAULT_AUTH_TYPE;
  const apiKey = credentials?.[CREDENTIALS_API_KEY_FIELD];

  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return {
      ok: false,
      code: 'MISSING_CREDENTIAL',
      message: '该群未解析到凭证（apiKeyRef 未配置或引用不可用），未发起上游请求',
    };
  }

  if (authType === AUTH_TYPES.BEARER) {
    return { ok: true, headers: { authorization: `Bearer ${apiKey}` }, queryParameters: {} };
  }
  if (authType === AUTH_TYPES.HEADER) {
    const headerName = authConfig?.header ?? DEFAULT_AUTH_HEADER_NAME;
    const headerValue = authConfig?.scheme ? `${authConfig.scheme} ${apiKey}` : apiKey;
    return { ok: true, headers: { [headerName.toLowerCase()]: headerValue }, queryParameters: {} };
  }
  if (authType === AUTH_TYPES.QUERY) {
    const queryParameterName = authConfig?.queryParam ?? DEFAULT_AUTH_QUERY_PARAMETER;
    return { ok: true, headers: {}, queryParameters: { [queryParameterName]: apiKey } };
  }

  return {
    ok: false,
    code: 'UNSUPPORTED_AUTH_TYPE',
    message: `不支持的 auth.type：${authType}（支持 bearer / header / query）`,
  };
}

// 拼上游地址：baseURL 末尾斜杠与端点前导斜杠都要归一，否则会拼出双斜杠
function buildRequestUrl(baseURL, endpointPath, queryParameters) {
  const normalizedBaseUrl = String(baseURL ?? '').replace(/\/+$/, '');
  const normalizedEndpointPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
  const requestUrl = new URL(`${normalizedBaseUrl}${normalizedEndpointPath}`);
  for (const [parameterName, parameterValue] of Object.entries(queryParameters ?? {})) {
    requestUrl.searchParams.set(parameterName, parameterValue);
  }
  return requestUrl.toString();
}

// 读响应体：JSON 优先，非 JSON 原文返回，空体给 null（上游 204 之类）
async function readResponseBody(upstreamResponse) {
  const rawResponseText = await upstreamResponse.text();
  if (rawResponseText.length === 0) {
    return null;
  }
  try {
    return JSON.parse(rawResponseText);
  } catch {
    return rawResponseText;
  }
}

// 文本 → JSON（解析不了就原样返回文本），与 readResponseBody 同口径
function parseJsonOrText(rawText) {
  try {
    return JSON.parse(rawText);
  } catch {
    return rawText;
  }
}

// 组装一次上游请求的要素（鉴权、地址、头、超时）：非流式与流式共用，避免两份拼装漂移
function prepareUpstreamRequest({ context, endpointPath, method }) {
  const logger = context?.logger ?? defaultLogger;
  const fetchImpl = context?.fetchImpl ?? globalThis.fetch;
  const group = context?.group ?? {};
  const groupLabel = typeof group.id === 'string' && group.id.length > 0 ? group.id : '(未命名群)';

  const authPlan = planAuth(group.auth, context?.credentials ?? {});
  if (!authPlan.ok) {
    logger.warn(`[${groupLabel}] 凭证不可用，跳过上游请求：${authPlan.message}`);
    return { ok: false, error: { code: authPlan.code, message: authPlan.message } };
  }

  let requestUrl;
  try {
    requestUrl = buildRequestUrl(group.baseURL, endpointPath, authPlan.queryParameters);
  } catch (urlError) {
    return { ok: false, error: { code: 'INVALID_BASE_URL', message: `baseURL 不可用：${describeFailure(urlError)}` } };
  }

  return {
    ok: true,
    groupLabel,
    fetchImpl,
    method,
    requestUrl,
    requestHeaders: {
      'content-type': 'application/json',
      // 默认 UA 放在 extraHeaders 之前：用户配的 extraHeaders 可以覆盖它
      'user-agent': DEFAULT_USER_AGENT,
      ...authPlan.headers,
      ...(group.request?.extraHeaders ?? {}),
    },
    timeoutMs: Number.isFinite(group.request?.timeoutMs) ? group.request.timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

// 统一的上游请求：网络错误、超时、非 2xx 全部收敛成结构化结果，异常不外泄
async function sendJsonRequest({ context, endpointPath, method, requestBody }) {
  const logger = context?.logger ?? defaultLogger;
  const prepared = prepareUpstreamRequest({ context, endpointPath, method });
  if (!prepared.ok) {
    return upstreamFailure(prepared.error.code, prepared.error.message);
  }

  try {
    const transport = resolveUpstreamTransport(context, prepared.timeoutMs);
    let responseStatus;
    let responseBody;
    if (transport.kind === 'client') {
      const clientResponse = await transport.client.requestJson({
        url: prepared.requestUrl,
        method: prepared.method,
        headers: prepared.requestHeaders,
        body: requestBody === undefined ? null : JSON.stringify(requestBody),
      });
      responseStatus = clientResponse.status;
      responseBody = clientResponse.bodyText.length === 0 ? null : parseJsonOrText(clientResponse.bodyText);
    } else {
      const upstreamResponse = await transport.fetchImpl(prepared.requestUrl, {
        method: prepared.method,
        headers: prepared.requestHeaders,
        body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
        signal: AbortSignal.timeout(prepared.timeoutMs),
      });
      responseBody = await readResponseBody(upstreamResponse);
      responseStatus = upstreamResponse.status;
    }
    const isSuccess = responseStatus >= HTTP_SUCCESS_MIN && responseStatus <= HTTP_SUCCESS_MAX;
    if (!isSuccess) {
      logger.warn(`[${prepared.groupLabel}] 上游返回 ${responseStatus}，按失败记录请求行`);
    }
    return {
      ok: isSuccess,
      status: responseStatus,
      response: responseBody,
      error: isSuccess ? null : { code: 'UPSTREAM_HTTP_ERROR', message: `上游返回 ${responseStatus}` },
    };
  } catch (networkError) {
    // 超时/断网/证书错误都在这里落地：不抛给网关，让它还能记一条失败请求行
    logger.warn(`[${prepared.groupLabel}] 上游请求失败：${describeFailure(networkError)}`);
    return upstreamFailure('UPSTREAM_REQUEST_FAILED', describeFailure(networkError));
  }
}

// 把配置里的模型项统一成 { id, name }；静态列表允许写字符串或 { id, name }
function toModelEntry(modelCandidate) {
  if (typeof modelCandidate === 'string' && modelCandidate.length > 0) {
    return { id: modelCandidate, name: modelCandidate };
  }
  if (modelCandidate && typeof modelCandidate.id === 'string' && modelCandidate.id.length > 0) {
    const modelEntry = {
      id: modelCandidate.id,
      name: typeof modelCandidate.name === 'string' && modelCandidate.name.length > 0 ? modelCandidate.name : modelCandidate.id,
    };
    // 容量字段按契约归一化后承接：上游字段名不统一，缺失就不填（UI 显示 —，绝不编造）
    const contextLength = normalizeContextLength(modelCandidate);
    if (contextLength !== null) modelEntry.contextLength = contextLength;
    const maxOutputTokens = normalizeMaxOutputTokens(modelCandidate);
    if (maxOutputTokens !== null) modelEntry.maxOutputTokens = maxOutputTokens;
    return modelEntry;
  }
  return null;
}

// 从上游响应里取模型数组：兼容 { data: [...] }（OpenAI 形状）与裸数组
function extractModelEntries(responseBody) {
  const modelCandidates = Array.isArray(responseBody) ? responseBody : responseBody?.data;
  if (!Array.isArray(modelCandidates)) {
    throw createDriverError('UPSTREAM_MODELS_SHAPE_INVALID', '上游 models 响应里找不到模型数组');
  }
  return modelCandidates.map(toModelEntry).filter((modelEntry) => modelEntry !== null);
}

// 校验鉴权是否有效：能列出模型即视为有效；失败只返回 false，不抛给调用方
export async function validateAuth(context) {
  const logger = context?.logger ?? defaultLogger;
  try {
    await fetchModels(context);
    return true;
  } catch (validationError) {
    logger.warn(`凭证校验失败：${describeFailure(validationError)}`);
    return false;
  }
}

// 获取模型列表：配置了 models.static 就不发请求（离线/固定清单平台用这个）
export async function fetchModels(context) {
  const group = context?.group ?? {};
  const staticModels = group.models?.static;
  if (Array.isArray(staticModels)) {
    return staticModels.map(toModelEntry).filter((modelEntry) => modelEntry !== null);
  }

  const endpointPath = group.models?.endpoint ?? DEFAULT_MODELS_ENDPOINT_PATH;
  const requestResult = await sendJsonRequest({ context, endpointPath, method: 'GET' });
  if (!requestResult.ok) {
    throw createDriverError(requestResult.error.code, requestResult.error.message, requestResult.status);
  }
  return extractModelEntries(requestResult.response);
}

// 获取摘要串：本轮只做模板变量渲染；summary.source 的上游取数留到统计阶段
export async function fetchSummary(context) {
  const group = context?.group ?? {};
  const staticModelCount = Array.isArray(group.models?.static) ? group.models.static.length : undefined;
  return renderSummaryTemplate(group.summary?.template, {
    id: group.id,
    name: group.name,
    baseURL: group.baseURL,
    accessMode: group.accessMode,
    modelCount: staticModelCount,
  });
}

// 请求转发：上游响应原样带回 + 解析 usage；失败同样返回结构化结果（网关据此写请求行）
export async function chatCompletions(context, body) {
  const group = context?.group ?? {};
  const endpointPath = group.request?.chatCompletionsEndpoint ?? DEFAULT_CHAT_COMPLETIONS_ENDPOINT_PATH;
  const requestResult = await sendJsonRequest({
    context,
    endpointPath,
    method: 'POST',
    requestBody: prepareOutboundBody(body, group.request),
  });
  return {
    ok: requestResult.ok,
    status: requestResult.status,
    response: requestResult.response,
    usage: extractUsage(requestResult.response, group.response?.usagePath ?? DEFAULT_USAGE_PATH),
    error: requestResult.error,
  };
}

// 流式转发（docs/09 §12）：把上游 SSE 原样交出去，调用方必须边收边用、禁止聚合成整段
// 失败不抛异常：返回 { ok:false, status, error }，由上层决定怎么呈现（HTTP 透传 / LlmError）
export async function streamCompletions(context, body, { signal } = {}) {
  const logger = context?.logger ?? defaultLogger;
  const group = context?.group ?? {};
  const endpointPath = group.request?.chatCompletionsEndpoint ?? DEFAULT_CHAT_COMPLETIONS_ENDPOINT_PATH;
  const prepared = prepareUpstreamRequest({ context, endpointPath, method: 'POST' });
  if (!prepared.ok) {
    return { ok: false, status: 0, events: null, error: prepared.error };
  }

  // 上游超时与调用方取消合并：任一方 abort 都要真的掐断请求，而不是只停止写入
  const timeoutSignal = AbortSignal.timeout(prepared.timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  try {
    const transport = resolveUpstreamTransport(context, prepared.timeoutMs);
    const requestBodyText = JSON.stringify({ ...prepareOutboundBody(body, group.request), stream: true });
    const requestHeaders = { ...prepared.requestHeaders, accept: 'text/event-stream' };
    let streamStatus;
    let streamEvents;
    let streamBodyText = '';
    let streamContentType = '';

    if (transport.kind === 'client') {
      const clientStream = await transport.client.requestStream({
        url: prepared.requestUrl,
        method: 'POST',
        headers: requestHeaders,
        body: requestBodyText,
        signal: combinedSignal,
      });
      streamStatus = clientStream.status;
      streamBodyText = clientStream.bodyText ?? '';
      streamContentType = String(clientStream.headers['content-type'] ?? '');
      streamEvents = clientStream.events;
    } else {
      const upstreamResponse = await transport.fetchImpl(prepared.requestUrl, {
        method: 'POST',
        headers: requestHeaders,
        body: requestBodyText,
        signal: combinedSignal,
      });
      streamStatus = upstreamResponse.status;
      streamContentType = upstreamResponse.headers.get('content-type') ?? '';
      if (streamStatus >= HTTP_SUCCESS_MIN && streamStatus <= HTTP_SUCCESS_MAX && streamContentType.includes('text/event-stream')) {
        streamEvents = parseSseEvents(upstreamResponse.body);
      } else {
        streamBodyText = await upstreamResponse.text().catch(() => '');
        streamEvents = null;
      }
    }

    if (streamStatus < HTTP_SUCCESS_MIN || streamStatus > HTTP_SUCCESS_MAX) {
      logger.warn(`[${prepared.groupLabel}] 流式上游返回 ${streamStatus}`);
      return {
        ok: false,
        status: streamStatus,
        events: null,
        error: {
          code: 'UPSTREAM_HTTP_ERROR',
          message: `上游返回 ${streamStatus}${streamBodyText.length > 0 ? `：${streamBodyText.slice(0, MAX_ERROR_EXCERPT_LENGTH)}` : ''}`,
          upstreamStatus: streamStatus,
        },
      };
    }

    if (!streamEvents) {
      logger.warn(`[${prepared.groupLabel}] 上游未按流式返回（content-type: ${streamContentType || '未知'}），已包成单块事件`);
      return { ok: true, status: streamStatus, events: toSingleSseEvent(streamBodyText), error: null };
    }

    return { ok: true, status: streamStatus, events: streamEvents, error: null };
  } catch (networkError) {
    logger.warn(`[${prepared.groupLabel}] 流式上游请求失败：${describeFailure(networkError)}`);
    return { ok: false, status: 0, events: null, error: { code: 'UPSTREAM_REQUEST_FAILED', message: describeFailure(networkError) } };
  }
}

// 驱动实现（默认导出由注册表读取）
export const openAiCompatibleDriver = Object.freeze({
  id: OPENAI_COMPATIBLE_DRIVER_ID,
  // 上游错误帧认领：声明只给字符串路径 + 本模块地址，由驱动注册流程动态加载（不内联函数）
  streamErrorClaimersModule: './openai-compatible.claimers.js',
  streamErrorClaimersBase: import.meta.url,
  name: OPENAI_COMPATIBLE_DRIVER_NAME,
  accessMode: ACCESS_MODE_OFFICIAL,
  // 认证形态显式声明（配置型驱动用 API Key 引用）；写入后"缺省即 api-key"只用于兼容存量外挂驱动
  authKind: AUTH_KINDS.API_KEY,
  authSchema: OPENAI_COMPATIBLE_AUTH_SCHEMA,
  validateAuth,
  fetchModels,
  fetchSummary,
  chatCompletions,
  streamCompletions,
});

export default openAiCompatibleDriver;
