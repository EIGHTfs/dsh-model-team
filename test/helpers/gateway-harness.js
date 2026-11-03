// 端到端测试脚手架：临时数据根 + stub 上游 + 真网关（监听 0 端口），退出时全部关闭。
// 目的：用真 HTTP 跑通"dsh -> 网关 -> 上游"整条链路，同时保持零外网、零真实 Key。

import { createGatewayServer } from '../../src/gateway/http-server.js';
import { createFixedClock } from '../../src/gateway/clock.js';
import { writeConfig } from '../../src/gateway/config.js';
import { createRecordingLogger, createTempDirectory, setEnvironmentVariableForTest } from './test-environment.js';
import { startStubUpstream, writeJson } from './stub-upstream.js';

// 假 Key：仅用于断言鉴权头，不具备真实访问能力
export const TEST_API_KEY = 'test-key-not-real';
export const TEST_API_KEY_ENV_NAME = 'DSH_MODEL_TEAM_TEST_API_KEY';

// 上游默认响应：两个选项 + 带缓存的 usage（覆盖 tokens / cacheHit 两条规则）
export const DEFAULT_CHAT_COMPLETION = {
  id: 'chatcmpl-e2e',
  object: 'chat.completion',
  model: 'agnes-3.0-flash',
  choices: [{ index: 0, message: { role: 'assistant', content: '收到' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10000, completion_tokens: 2600, total_tokens: 12600, prompt_tokens_details: { cached_tokens: 9990 } },
};

// 上游默认路由表
export function buildDefaultUpstreamRoutes(chatCompletion = DEFAULT_CHAT_COMPLETION) {
  return {
    'GET /v1/models': ({ outgoingResponse }) =>
      writeJson(outgoingResponse, 200, {
        data: [{ id: 'agnes-3.0-flash', name: 'Agnes 3.0 Flash' }, { id: 'agnes-2.5-flash', name: 'Agnes 2.5 Flash' }],
      }),
    'POST /v1/chat/completions': ({ outgoingResponse, bodyText }) => {
      const requestBody = JSON.parse(bodyText || '{}');
      writeJson(outgoingResponse, 200, { ...chatCompletion, model: requestBody.model ?? chatCompletion.model });
    },
  };
}

// 默认群配置：静态模型列表，避免每个用例都额外打一次 /models
export function buildGroup(overrides = {}) {
  return {
    id: 'agnes',
    name: 'agnes(本机)',
    accessMode: 'official',
    driver: 'openai-compatible',
    baseURL: 'http://127.0.0.1:9/v1',
    auth: { type: 'bearer', header: 'Authorization', apiKeyRef: `env:${TEST_API_KEY_ENV_NAME}` },
    models: { static: ['agnes-3.0-flash', 'agnes-2.5-flash'] },
    request: { modelField: 'model', extraHeaders: {} },
    response: { usagePath: 'usage' },
    ...overrides,
  };
}

// 起一套完整环境；返回的 request() 直接打网关
export async function startGatewayHarness(t, options = {}) {
  setEnvironmentVariableForTest(t, TEST_API_KEY_ENV_NAME, TEST_API_KEY);

  const dataRoot = await createTempDirectory(t);
  const stubUpstream = await startStubUpstream({ routes: options.routes ?? buildDefaultUpstreamRoutes() });
  // groupOverrides 在"默认群 + stub 地址"之上打补丁，用例不必自己记 baseURL
  const groups = options.groups ?? [buildGroup({ baseURL: stubUpstream.baseURL, ...options.groupOverrides })];
  // 默认打开外部 OpenAI 兼容入口（docs/09 §11 缺省关闭）：端到端用例都要显式开启；
  // "缺省关闭"这条行为由专门用例自己写 config 覆盖验证
  const configOverrides = {
    ...options.config,
    http: { externalOpenAiCompat: true, ...(options.config?.http ?? {}), ...(options.http ?? {}) },
    groups,
  };
  await writeConfig(configOverrides, { dataRoot });

  const logger = createRecordingLogger();
  const clock = options.clock ?? createFixedClock();
  // getSessionService：目标回落（父链）用例要注入假宿主服务
  const server = createGatewayServer({
    dataRoot,
    logger,
    clock,
    fetchImpl: globalThis.fetch,
    getSessionService: options.getSessionService,
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const gatewayPort = server.address().port;
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

  t.after(async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
    await stubUpstream.close();
  });

  // 统一请求封装：返回 { status, body, raw }
  const request = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`${gatewayUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const rawText = await response.text();
    let parsedBody = null;
    try {
      parsedBody = rawText.length > 0 ? JSON.parse(rawText) : null;
    } catch {
      parsedBody = rawText;
    }
    return { status: response.status, body: parsedBody, raw: rawText };
  };

  // 流式请求封装：逐块记录到达时间，用于断言"边收边写"而不是攒完一次性返回
  const requestStream = async (path, { body, headers = {} } = {}) => {
    const startedAtMs = Date.now();
    const response = await fetch(`${gatewayUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
      body: JSON.stringify(body ?? {}),
    });
    const chunkRecords = [];
    const textDecoder = new TextDecoder();
    let rawText = '';
    for await (const byteChunk of response.body) {
      const chunkText = textDecoder.decode(byteChunk, { stream: true });
      rawText += chunkText;
      chunkRecords.push({ text: chunkText, receivedAtMs: Date.now() });
    }
    return {
      status: response.status,
      chunks: chunkRecords,
      rawText,
      startedAtMs,
      firstChunkAtMs: chunkRecords.length > 0 ? chunkRecords[0].receivedAtMs : null,
    };
  };

  return { dataRoot, stubUpstream, gatewayUrl, logger, clock, groups, request, requestStream };
}

// 常用：带会话头的聊天请求
export function chatAs(sessionId, body = { messages: [{ role: 'user', content: 'hi' }] }) {
  return {
    method: 'POST',
    headers: sessionId ? { 'X-Tim-Session-Id': sessionId } : {},
    body: { model: 'dsh-model-team', ...body },
  };
}

// 常用：给会话选模型
export function selectModelRequest(platform, model) {
  return { method: 'PUT', body: { platform, model } };
}
