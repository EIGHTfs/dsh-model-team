// Qoder 推理链路：加密请求 → 上游 SSE → 剥信封 → 标准 chunk 序列。
//
// 链路只走**加密端点**（agent_chat_generation?Encode=1）。公开的 /model/v1/chat/completions
// 只认一小撮通用模型名，拿不到目录 key 对应的真实模型——所以**任何失败都不许降级到公开端点**：
// 降级会造成"看起来能聊、模型却悄悄换了"的假象，比直接报错难查得多。
//
// 401/403 是明确的失败结局（M4 才做续期）：这里不重试、不换账号、不换端点。

import { ENVELOPE_DONE, unwrapEnvelope } from './envelope.js';
import { createCryptoBackend } from './crypto/index.js';
import { createReverseHttpClient, DEFAULT_REVERSE_TIMEOUT_MS } from './http-client.js';
import { parseSseEvents } from '../../../gateway/transport/sse.js';

export const INFER_ERROR_CODES = Object.freeze({
  AUTH_REQUIRED: 'REVERSE_AUTH_REQUIRED',
  UPSTREAM_FAILED: 'REVERSE_UPSTREAM_FAILED',
  STREAM_FAILED: 'REVERSE_STREAM_FAILED',
});

function inferError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

// 建立一次推理流：返回 { status, chunks }（chunks 是标准 chunk 的异步可迭代）
export async function openInferenceStream({
  credential,
  messages,
  tools,
  model,
  platform,
  signal,
  timeoutMs = DEFAULT_REVERSE_TIMEOUT_MS,
  fetchImpl,
  backendKind,
  environment = process.env,
  dataRoot,
  wasmPath,
} = {}) {
  const cryptoBackend = createCryptoBackend({ kind: backendKind, environment, dataRoot, wasmPath });
  // 加密失败必须冒泡：这里不做任何"换个后端再试"的兜底
  const encryptedRequest = await cryptoBackend.buildEncryptedRequest({
    credential,
    messages,
    tools,
    model,
    inferBase: platform.endpoints.inferBase,
  });

  const httpClient = createReverseHttpClient({ timeoutMs, fetchImpl });
  const response = await httpClient(encryptedRequest.url, {
    method: 'POST',
    headers: encryptedRequest.headers,
    body: encryptedRequest.body,
    ...(signal ? { signal } : {}),
  });

  if (response.status === 401 || response.status === 403) {
    throw inferError(INFER_ERROR_CODES.AUTH_REQUIRED, `反代账号鉴权失败（HTTP ${response.status}）：M4 才做自动续期，请重新登录`, {
      upstreamStatus: response.status,
    });
  }
  if (!response.ok) {
    throw inferError(INFER_ERROR_CODES.UPSTREAM_FAILED, `加密推理端点返回 HTTP ${response.status}`, {
      upstreamStatus: response.status,
    });
  }
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (contentType.length > 0 && !contentType.includes('text/event-stream')) {
    // 非流式响应不是"可以凑合解析"的东西：拿不到流就没有 chunk 序列
    const rawText = await response.text().catch(() => '');
    throw inferError(INFER_ERROR_CODES.STREAM_FAILED, `加密端点未按流式返回（content-type: ${contentType}）：${rawText.slice(0, 200)}`);
  }

  return { status: response.status, chunks: toSseEventStream(decodeChunkStream(response.body)) };
}

// 驱动契约要求 `events` 是 **SSE 事件**（每项形如 { data: '<JSON 文本>' }，结束时 data 为 '[DONE]'）。
// 反代内部解析出的是对象，这里只做形状转换，不改变解析逻辑——
// 否则上层（adapter/网关）按 event.data 读取时会拿到 undefined，整轮对话取不到任何内容。
export async function* toSseEventStream(parsedChunkStream) {
  for await (const parsedChunk of parsedChunkStream) {
    yield { data: JSON.stringify(parsedChunk) };
  }
  // 结束标记：官方驱动同样以 [DONE] 收尾，上层据此判定流正常结束
  yield { data: '[DONE]' };
}

// 把 SSE 字节流解成标准 chunk：每帧剥信封；[DONE] 结束；坏帧跳过（不抛、不中断整条流）
export async function* decodeChunkStream(byteStream) {
  if (!byteStream) return;
  for await (const event of parseSseEvents(byteStream)) {
    const rawData = typeof event?.data === 'string' ? event.data : '';
    const unwrapped = unwrapEnvelope(rawData);
    if (unwrapped === ENVELOPE_DONE) return;
    if (unwrapped === null) continue;
    try {
      yield JSON.parse(unwrapped);
    } catch (parseError) {
      throw inferError(INFER_ERROR_CODES.STREAM_FAILED, `信封内层不是合法 JSON：${parseError?.message ?? parseError}`);
    }
  }
}
