// upstream-client.js —— 转发驱动自己的 HTTP 客户端（不经宿主 fetch）。
//
// 为什么需要它：宿主注入的 fetch 会在转发链里重写 User-Agent，导致我们对上游的身份
// 不可控（上游限流/审计时无法区分，也无法申诉）。所以出站请求自己用 node:http/https 发，
// UA 在客户端**最后合并**，调用方传什么都覆盖不了。
//
// 中立层约束（docs/12 R10 + docs/16 目录约定）：本文件不得 import `reverse/**`，也不读环境变量——
// 是否使用本客户端由调用方（驱动层）决定。
//
// 行为对齐（与非流式 fetch 路径逐项一致）：
//   · 超时：request.setTimeout → destroy（错误码 UPSTREAM_TIMEOUT）
//   · 取消：监听调用方 signal 的 abort → destroy，并清理监听（stop generating 必须真掐断）
//   · 非 2xx：客户端只负责把 status/headers/bodyText 原样带回，收敛在驱动层
//   · SSE：复用 transport/sse.js 的解析器，不写第二份状态机

import http from 'node:http';
import https from 'node:https';

import { DEFAULT_USER_AGENT } from '../config/constants.js';
import { parseSseEvents } from './sse.js';

// 默认超时：与驱动侧 prepared.timeoutMs 同量级；调用方一般会显式传
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30000;

// 错误码：测试与驱动按码断言，避免字符串散落在多处
export const UPSTREAM_ABORTED = 'UPSTREAM_ABORTED';
export const UPSTREAM_TIMEOUT = 'UPSTREAM_TIMEOUT';
export const UPSTREAM_REQUEST_FAILED = 'UPSTREAM_REQUEST_FAILED';
export const INVALID_UPSTREAM_URL = 'INVALID_UPSTREAM_URL';

const SUCCESS_MIN = 200;
const SUCCESS_MAX = 299;

function isSuccessStatus(statusCode) {
  return statusCode >= SUCCESS_MIN && statusCode <= SUCCESS_MAX;
}

/** 拼请求头：调用方的 headers 先铺，UA 与 content-length 由客户端最后定 */
function buildHeaders(headers, bodyText) {
  const merged = { ...(headers || {}) };
  // UA 必须最后写：这是本客户端存在的核心理由，不接受任何上层覆盖
  merged['user-agent'] = DEFAULT_USER_AGENT;
  if (typeof bodyText === 'string' && bodyText.length > 0) {
    merged['content-length'] = String(Buffer.byteLength(bodyText));
  }
  return merged;
}

/**
 * 发起一次请求，返回 { status, headers, incomingMessage }。
 * 出错一律拒绝，错误对象带 code（UPSTREAM_TIMEOUT / UPSTREAM_REQUEST_FAILED / UPSTREAM_ABORTED）。
 */
function performRequest({ url, method, headers, bodyText, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let requestUrl;
    try {
      requestUrl = new URL(url);
    } catch (urlError) {
      const invalidError = new Error(`上游地址不可用：${urlError?.message ?? urlError}`);
      invalidError.code = INVALID_UPSTREAM_URL;
      reject(invalidError);
      return;
    }
    const transport = requestUrl.protocol === 'http:' ? http : https;
    const outgoingRequest = transport.request({
      protocol: requestUrl.protocol,
      hostname: requestUrl.hostname,
      port: requestUrl.port || undefined,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      method,
      headers: buildHeaders(headers, bodyText),
    });

    let settled = false;
    // incomingMessage 只有响应到达后才有；abort 时必须连它一起销毁，否则 read() 永远挂着
    let incomingResponseStream = null;
    const cleanupSignal = () => {
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', handleAbort);
      }
    };
    const failWith = (error) => {
      if (settled) return;
      settled = true;
      cleanupSignal();
      // 响应已到：销毁响应流让消费方的 read() 立即抛，而不是无限等
      if (incomingResponseStream) {
        try { incomingResponseStream.destroy(error); } catch { /* 已销毁 */ }
      }
      try { outgoingRequest.destroy(); } catch { /* 已经断了 */ }
      reject(error);
    };
    // 响应已到达时 promise 早就算 settled 了，但流还在跑：abort 必须仍然销毁流
    const destroyResponseStream = (reason) => {
      if (!incomingResponseStream) return;
      try { incomingResponseStream.destroy(reason); } catch { /* 已销毁 */ }
    };
    const handleAbort = () => {
      const abortError = new Error('上游请求已被调用方取消');
      abortError.code = UPSTREAM_ABORTED;
      if (settled) {
        destroyResponseStream(abortError);
        return;
      }
      failWith(abortError);
    };

    outgoingRequest.on('error', (networkError) => {
      if (settled) return;
      settled = true;
      cleanupSignal();
      const requestError = new Error(`上游请求失败：${networkError?.message ?? networkError}`);
      requestError.code = networkError?.code ?? UPSTREAM_REQUEST_FAILED;
      requestError.cause = networkError;
      reject(requestError);
    });

    // 调用方已经取消：不必再发
    if (signal?.aborted) {
      handleAbort();
      return;
    }
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', handleAbort);
    }

    outgoingRequest.setTimeout(timeoutMs, () => {
      const timeoutError = new Error(`上游请求超时（${timeoutMs}ms）`);
      timeoutError.code = UPSTREAM_TIMEOUT;
      // 同 abort：响应已到（promise 已 settle）时，超时也必须销毁还在读的流
      if (settled) {
        destroyResponseStream(timeoutError);
        return;
      }
      failWith(timeoutError);
    });

    outgoingRequest.on('response', (incomingMessage) => {
      if (settled) return;
      settled = true;
      incomingResponseStream = incomingMessage;
      // 取消监听要留到流结束：abort 可能发生在"响应头已到、正文还在流"的时刻（B13 的根因）
      const cleanupOnStreamEnd = () => cleanupSignal();
      incomingMessage.on('end', cleanupOnStreamEnd);
      incomingMessage.on('close', cleanupOnStreamEnd);
      incomingMessage.on('error', cleanupOnStreamEnd);
      resolve({
        status: incomingMessage.statusCode ?? 0,
        headers: incomingMessage.headers ?? {},
        incomingMessage,
        isSuccess: isSuccessStatus(incomingMessage.statusCode ?? 0),
      });
    });

    if (typeof bodyText === 'string' && bodyText.length > 0) outgoingRequest.write(bodyText);
    outgoingRequest.end();
  });
}

/** 读完整个响应体（文本） */
function readBodyText(incomingMessage) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    incomingMessage.on('data', (chunk) => chunks.push(chunk));
    incomingMessage.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    incomingMessage.on('error', (streamError) => reject(streamError));
  });
}

/** 把 IncomingMessage 包成 async 可迭代的字节块，交给既有 SSE 解析器 */
async function* iterateByteChunks(incomingMessage, signal) {
  // 每轮都检查取消：即使底层 socket 还没反应过来，也保证迭代立刻结束
  const assertNotAborted = () => {
    if (!signal?.aborted) return;
    const abortError = new Error('上游请求已被调用方取消');
    abortError.code = UPSTREAM_ABORTED;
    throw abortError;
  };
  try {
    for await (const chunk of incomingMessage) {
      assertNotAborted();
      yield chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
    }
  } catch (streamError) {
    if (streamError?.code === UPSTREAM_ABORTED) throw streamError;
    // 底层流错误统一收敛成可判定的错误码（适配器据此判 ABORTED / UPSTREAM_ERROR）
    const requestError = new Error(`读取上游响应失败：${streamError?.message ?? streamError}`);
    requestError.code = streamError?.code ?? UPSTREAM_REQUEST_FAILED;
    requestError.cause = streamError;
    throw requestError;
  }
  assertNotAborted();
}

/**
 * 创建客户端。impl 用于测试注入（默认即真实 node 实现）。
 */
export function createUpstreamClient({ timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS } = {}) {
  async function requestJson({ url, method = 'POST', headers, body = null, signal }) {
    const bodyText = typeof body === 'string' ? body : (body == null ? null : JSON.stringify(body));
    const response = await performRequest({ url, method, headers, bodyText, signal, timeoutMs });
    const bodyTextResponse = await readBodyText(response.incomingMessage);
    return { status: response.status, headers: response.headers, bodyText: bodyTextResponse };
  }

  async function requestStream({ url, method = 'POST', headers, body = null, signal }) {
    const bodyText = typeof body === 'string' ? body : (body == null ? null : JSON.stringify(body));
    const response = await performRequest({ url, method, headers, bodyText, signal, timeoutMs });
    const contentType = String(response.headers['content-type'] ?? '');
    const isEventStream = contentType.includes('text/event-stream');
    // 非 2xx 或非 SSE：整段读完交回（驱动层沿用原来的单块事件包装 / 错误收敛）；
    // 只有"2xx 且确实是 event-stream"才做增量解析，避免把普通 JSON 当 SSE 切碎。
    if (!response.isSuccess || !isEventStream) {
      return {
        status: response.status,
        headers: response.headers,
        bodyText: await readBodyText(response.incomingMessage),
        events: null,
        isEventStream,
      };
    }
    return {
      status: response.status,
      headers: response.headers,
      bodyText: null,
      events: parseSseEvents(iterateByteChunks(response.incomingMessage, signal)),
      isEventStream,
    };
  }

  return { requestJson, requestStream };
}
