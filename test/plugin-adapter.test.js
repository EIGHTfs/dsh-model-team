// 适配器单测：用桩基类 + 桩错误类验证 docs/10 的行为（单模型、会话映射、流式块、错误分类、请求行）。
// 不 import 宿主包：createModelTimAdapter 的基类/错误类都是注入的，这正是本项目零依赖的口径。

import test from 'node:test';

// 测试必须自带超时（超时 = 失败），不许让门禁陪着无限等：
// 流式用例一旦"结束事件永不到来"，这里会以超时报错并指出是哪个用例，而不是把 gate-all 卡住。
const STREAM_TEST_TIMEOUT_MS = 15_000;
import assert from 'node:assert/strict';
import { buildOpenAiRequestBody, createModelTimAdapter, toOpenAiMessages } from '../src/plugin/adapter/adapter.js';
import { createFixedClock } from '../src/gateway/clock.js';
import { writeConfig } from '../src/gateway/config/config.js';
import { readRequestRows } from '../src/gateway/stats/index.js';
import { writeSessionMapping } from '../src/gateway/session/store.js';
import { createRecordingLogger, createTempDirectory, setEnvironmentVariableForTest } from './helpers/test-environment.js';
import { startStubUpstream, writeJson } from './helpers/stub-upstream.js';
import { registerStreamErrorClaimer, resetStreamErrorClaimersForTest } from '../src/gateway/drivers/stream-error-claimers.js';
import { claimers as qoderClaimers } from '../src/reverse/platforms/qoder/claimers.js';

// 假 Key 环境变量：只用假值
const TEST_KEY_ENV = 'DSH_MODEL_TEAM_TEST_API_KEY';
const TEST_API_KEY = 'test-key-not-real';

// 桩基类：替代 @deepseek-ai/dsh-llm 的 LlmAdapter
class StubLlmAdapter {}

// 桩错误类：形状与 LlmError 一致（message + code + status）
class StubLlmError extends Error {
  constructor(message, code, options = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.status = options.status;
  }
}

function buildGroup(baseURL) {
  return {
    id: 'agnes',
    name: 'agnes(本机)',
    accessMode: 'official',
    driver: 'openai-compatible',
    baseURL,
    auth: { type: 'bearer', apiKeyRef: `env:${TEST_KEY_ENV}` },
    models: { static: ['agnes-3.0-flash', 'agnes-2.5-flash'] },
    request: {},
    response: { usagePath: 'usage' },
  };
}

// 造一条 SSE 上游路由：按给定事件顺序逐条写出
function buildSseRoute(events) {
  return async ({ outgoingResponse }) => {
    outgoingResponse.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const ssePayload of events) {
      outgoingResponse.write(`data: ${JSON.stringify(ssePayload)}\n\n`);
    }
    outgoingResponse.write('data: [DONE]\n\n');
    outgoingResponse.end();
  };
}

async function setupAdapter(t, { routes, groupOverrides = {}, configOverrides = {} } = {}) {
  setEnvironmentVariableForTest(t, TEST_KEY_ENV, TEST_API_KEY);
  const dataRoot = await createTempDirectory(t);
  const stubUpstream = await startStubUpstream({ routes: routes ?? {} });
  const group = { ...buildGroup(stubUpstream.baseURL), ...groupOverrides };
  await writeConfig({ groups: [group], ...configOverrides }, { dataRoot });
  const logger = createRecordingLogger();
  const clock = createFixedClock();
  const ModelTimAdapter = createModelTimAdapter({
    BaseAdapter: StubLlmAdapter,
    LlmErrorClass: StubLlmError,
    deps: { dataRoot, logger, clock },
  });
  t.after(() => stubUpstream.close());
  return { adapter: new ModelTimAdapter(), dataRoot, stubUpstream, logger, clock };
}

async function collectChunks(streamIterable) {
  const chunks = [];
  for await (const streamChunk of streamIterable) {
    chunks.push(streamChunk);
  }
  return chunks;
}

test('适配器：providerInfo 与 listModels 恒返回一条虚拟模型（INV-01）', { timeout: STREAM_TEST_TIMEOUT_MS }, async (t) => {
  const { adapter } = await setupAdapter(t);

  assert.equal(adapter.providerInfo('dsh-model-team').name, '模型团队');
  const models = await adapter.listModels('dsh-model-team');
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'dsh-model-team');
  assert.equal(models[0].provider, 'dsh-model-team');
  assert.equal(typeof models[0].name, 'string');
});

test('INV-13：好友分组不会出现在 listModels 里（分组不是模型）', { timeout: STREAM_TEST_TIMEOUT_MS }, async (t) => {
  const { adapter } = await setupAdapter(t, {
    configOverrides: {
      friendGroups: [
        {
          id: 'ha-group',
          name: '高可用组',
          strategy: 'round-robin',
          members: [{ platformId: 'agnes', modelId: 'agnes-3.0-flash' }],
        },
      ],
    },
  });

  const models = await adapter.listModels('dsh-model-team');

  assert.equal(models.length, 1, '分组再多也只能看到那一条虚拟模型');
  assert.equal(models.some((modelInfo) => modelInfo.id === 'ha-group'), false);
});

test('适配器：按 sessionId 查映射改写模型，并把上游事件转成 StreamChunk', { timeout: STREAM_TEST_TIMEOUT_MS }, async (t) => {
  const sseEvents = [
    { id: 'chatcmpl-a', choices: [{ index: 0, delta: { role: 'assistant', content: '你' } }] },
    { id: 'chatcmpl-a', choices: [{ index: 0, delta: { content: '好' } }] },
    {
      id: 'chatcmpl-a',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102, prompt_tokens_details: { cached_tokens: 90 } },
    },
  ];
  const { adapter, dataRoot, stubUpstream } = await setupAdapter(t, {
    routes: { 'POST /v1/chat/completions': buildSseRoute(sseEvents) },
  });
  await writeSessionMapping('sess-adapter', { platform: 'agnes', model: 'agnes-3.0-flash', updatedAt: '2026-11-02T13:00:00+08:00' }, { dataRoot });

  const chunks = await collectChunks(adapter.stream({
    provider: 'dsh-model-team',
    model: 'dsh-model-team',
    sessionId: 'sess-adapter',
    messages: [{ role: 'user', content: '你好' }],
  }));

  assert.deepEqual(chunks.map((streamChunk) => streamChunk.type), [
    'block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish',
  ]);
  assert.equal(chunks[1].text, '你');
  assert.equal(chunks[3].block.text, '你好');
  assert.deepEqual(chunks[4].usage, { inputTokens: 10, outputTokens: 2, totalTokens: 102, cacheReadTokens: 90 });
  assert.deepEqual(chunks[5].reason, { kind: 'stop' });

  // 上游收到的 model 必须是映射后的真实模型
  const upstreamBody = JSON.parse(stubUpstream.requests[0].bodyText);
  assert.equal(upstreamBody.model, 'agnes-3.0-flash');
  assert.equal(upstreamBody.stream, true);
});

test('适配器：文本 + tool-call + 文本 的块索引严格配对', { timeout: STREAM_TEST_TIMEOUT_MS }, async (t) => {
  const sseEvents = [
    { choices: [{ index: 0, delta: { content: '先查一下' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q"' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }] } }] },
    { choices: [{ index: 0, delta: { content: '好了' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const { adapter, dataRoot } = await setupAdapter(t, {
    routes: { 'POST /v1/chat/completions': buildSseRoute(sseEvents) },
  });
  await writeSessionMapping('sess-tool', { platform: 'agnes', model: 'agnes-3.0-flash', updatedAt: '2026-11-02T13:00:00+08:00' }, { dataRoot });

  const chunks = await collectChunks(adapter.stream({
    model: 'dsh-model-team',
    sessionId: 'sess-tool',
    messages: [{ role: 'user', content: 'hi' }],
  }));

  const blockStarts = chunks.filter((streamChunk) => streamChunk.type === 'block-start');
  const blockEnds = chunks.filter((streamChunk) => streamChunk.type === 'block-end');

  assert.deepEqual(blockStarts.map((chunk) => chunk.index), [0, 1], '文本块与工具块各占一个索引');
  assert.deepEqual(blockEnds.map((chunk) => chunk.index), [0, 1], 'block-start / block-end 索引必须一一配对');
  assert.deepEqual(blockStarts.map((chunk) => chunk.blockType), ['text', 'tool-call']);

  const toolBlock = blockEnds.find((chunk) => chunk.block.type === 'tool-call');
  assert.equal(toolBlock.block.name, 'search');
  // 契约（02 §六 / G-17）：ToolCallBlock.arguments 必须是**原始 JSON 字符串**。
  // 这里曾经断言成对象 { q:'x' }，那正是 G-17 的错法——对象没有 .length，
  // dsh 的 token 估算器会算出 NaN，把整个会话的投影打挂（表现为会话打不开）。
  assert.equal(typeof toolBlock.block.arguments, 'string', 'arguments 必须是字符串');
  assert.equal(toolBlock.block.arguments, '{"q":"x"}', '流式拼接的参数原样透传，不被 parse 后重排');
  assert.equal(chunks[chunks.length - 1].reason.kind, 'tool-calls');
});

test('适配器：purpose=compaction 也走同一套会话映射（次要路径不绕开）', { timeout: STREAM_TEST_TIMEOUT_MS }, async (t) => {
  const sseEvents = [{ choices: [{ index: 0, delta: { content: '压缩' }, finish_reason: 'stop' }] }];
  const { adapter, dataRoot, stubUpstream } = await setupAdapter(t, {
    routes: { 'POST /v1/chat/completions': buildSseRoute(sseEvents) },
  });
  await writeSessionMapping('sess-compact', { platform: 'agnes', model: 'agnes-2.5-flash', updatedAt: '2026-11-02T13:00:00+08:00' }, { dataRoot });

  await collectChunks(adapter.stream({
    model: 'dsh-model-team',
    sessionId: 'sess-compact',
    purpose: 'compaction',
    messages: [{ role: 'user', content: 'summarize' }],
  }));

  assert.equal(JSON.parse(stubUpstream.requests[0].bodyText).model, 'agnes-2.5-flash');
});

test('适配器：未切换过模型的会话走兜底群 defaultModel', { timeout: STREAM_TEST_TIMEOUT_MS }, async (t) => {
  const sseEvents = [{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }];
  const { adapter, stubUpstream } = await setupAdapter(t, {
    routes: { 'POST /v1/chat/completions': buildSseRoute(sseEvents) },
    groupOverrides: { defaultModel: 'agnes-2.5-flash' },
    configOverrides: { session: { fallbackGroupId: 'agnes' } },
  });

  await collectChunks(adapter.stream({ model: 'dsh-model-team', sessionId: 'sess-new', messages: [] }));

  assert.equal(JSON.parse(stubUpstream.requests[0].bodyText).model, 'agnes-2.5-flash');
});

test('适配器：没有映射也没有兜底群 → LlmError(MODEL_UNRESOLVED)，不发上游请求', { timeout: STREAM_TEST_TIMEOUT_MS }, async (t) => {
  const { adapter, stubUpstream } = await setupAdapter(t, { routes: {} });

  await assert.rejects(
    () => collectChunks(adapter.stream({ model: 'dsh-model-team', sessionId: 'sess-orphan', messages: [] })),
    (llmError) => llmError instanceof StubLlmError && llmError.code === 'MODEL_UNRESOLVED',
  );
  assert.equal(stubUpstream.requests.length, 0);
});

test('适配器：上游 401/429 抛带分类的 LlmError（AUTH / RATE_LIMIT）', { timeout: STREAM_TEST_TIMEOUT_MS }, async (t) => {
  for (const [upstreamStatus, expectedCode] of [[401, 'AUTH'], [429, 'RATE_LIMIT']]) {
    const { adapter, dataRoot } = await setupAdapter(t, {
      routes: {
        'POST /v1/chat/completions': ({ outgoingResponse }) => writeJson(outgoingResponse, upstreamStatus, { error: 'boom' }),
      },
    });
    await writeSessionMapping(`sess-${upstreamStatus}`, { platform: 'agnes', model: 'agnes-3.0-flash', updatedAt: '2026-11-02T13:00:00+08:00' }, { dataRoot });

    await assert.rejects(
      () => collectChunks(adapter.stream({ model: 'dsh-model-team', sessionId: `sess-${upstreamStatus}`, messages: [] })),
      (llmError) => llmError instanceof StubLlmError && llmError.code === expectedCode,
    );
  }
});

test('适配器：上游已给 finish_reason 后调用方才 abort → 不得记成中断', { timeout: STREAM_TEST_TIMEOUT_MS }, async (t) => {
  const finishThenHangRoute = async ({ outgoingResponse }) => {
    outgoingResponse.writeHead(200, { 'content-type': 'text/event-stream' });
    // 只发一条"带 finish_reason + usage"的事件，之后故意保持连接（模拟上游还没关流）
    outgoingResponse.write(`data: ${JSON.stringify({
      id: 'chatcmpl-late-abort',
      choices: [{ index: 0, delta: { content: '完成' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    })}\n\n`);
  };
  const { adapter, dataRoot } = await setupAdapter(t, {
    routes: { 'POST /v1/chat/completions': finishThenHangRoute },
  });
  await writeSessionMapping('sess-late-abort', { platform: 'agnes', model: 'agnes-3.0-flash', updatedAt: '2026-11-02T13:00:00+08:00' }, { dataRoot });

  const abortController = new AbortController();
  const receivedChunks = [];
  for await (const streamChunk of adapter.stream({
    model: 'dsh-model-team',
    sessionId: 'sess-late-abort',
    messages: [],
    signal: abortController.signal,
  })) {
    receivedChunks.push(streamChunk);
    // 上游已给完成信号（finish_reason）之后消费者才 abort：模拟宿主"结束后清理/复用 signal"
    if (receivedChunks.length === 1) {
      abortController.abort();
    }
  }

  assert.equal(receivedChunks[receivedChunks.length - 1].type, 'finish', '完成后 abort 仍必须正常收尾');
  const writtenRows = await readRequestRows({ dataRoot });
  assert.equal(writtenRows.length, 1);
  assert.equal(writtenRows[0].aborted, undefined, '完成后 abort 不得记成中断');
  assert.equal(writtenRows[0].status, 200);
});

test('适配器：调用方 abort → LlmError(ABORTED)，请求行记中断', { timeout: STREAM_TEST_TIMEOUT_MS }, async (t) => {
  const slowSseRoute = async ({ outgoingResponse }) => {
    outgoingResponse.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let chunkIndex = 0; chunkIndex < 5; chunkIndex += 1) {
      outgoingResponse.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `x${chunkIndex}` } }] })}\n\n`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));
    }
    outgoingResponse.end();
  };
  const { adapter, dataRoot } = await setupAdapter(t, {
    routes: { 'POST /v1/chat/completions': slowSseRoute },
  });
  await writeSessionMapping('sess-abort-llm', { platform: 'agnes', model: 'agnes-3.0-flash', updatedAt: '2026-11-02T13:00:00+08:00' }, { dataRoot });

  const abortController = new AbortController();
  const streamIterator = adapter.stream({
    model: 'dsh-model-team',
    sessionId: 'sess-abort-llm',
    messages: [],
    signal: abortController.signal,
  })[Symbol.asyncIterator]();

  const firstChunk = await streamIterator.next();
  assert.equal(firstChunk.done, false);
  abortController.abort();

  await assert.rejects(
    async () => {
      for (;;) {
        const nextChunk = await streamIterator.next();
        if (nextChunk.done) {
          return;
        }
      }
    },
    (llmError) => llmError instanceof StubLlmError && llmError.code === 'ABORTED',
  );

  const writtenRows = await readRequestRows({ dataRoot });
  assert.equal(writtenRows.length, 1);
  assert.equal(writtenRows[0].aborted, true);
  assert.equal(writtenRows[0].status, 0);
});

test('适配器：请求行与 HTTP 路径同口径（ua/ip/model/status）', { timeout: STREAM_TEST_TIMEOUT_MS }, async (t) => {
  const sseEvents = [{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }];
  const { adapter, dataRoot } = await setupAdapter(t, {
    routes: { 'POST /v1/chat/completions': buildSseRoute(sseEvents) },
  });
  await writeSessionMapping('sess-row', { platform: 'agnes', model: 'agnes-3.0-flash', updatedAt: '2026-11-02T13:00:00+08:00' }, { dataRoot });

  await collectChunks(adapter.stream({ model: 'dsh-model-team', sessionId: 'sess-row', messages: [] }));

  const writtenRows = await readRequestRows({ dataRoot });
  assert.equal(writtenRows.length, 1);
  assert.equal(writtenRows[0].model, 'agnes-3.0-flash');
  assert.equal(writtenRows[0].ua, 'dsh-llm-adapter');
  assert.equal(writtenRows[0].ip, '—');
  assert.equal(writtenRows[0].status, 200);
  assert.equal(writtenRows[0].sessionId, 'sess-row');
});

test('适配器：消息/请求体转换（system 前置、tools、采样参数）', () => {
  const openAiMessages = toOpenAiMessages(
    [
      { role: 'user', content: 'hi' },
      { role: 'user', content: [{ type: 'text', text: '第一段' }, { type: 'image', data: 'xx' }] },
    ],
    '你是助手',
  );
  assert.deepEqual(openAiMessages, [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: 'hi' },
    { role: 'user', content: '第一段\n[image 内容已省略]' },
  ]);

  const requestBody = buildOpenAiRequestBody(
    {
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.3,
      maxTokens: 256,
      stop: ['\n\n'],
      tools: [{ name: 'search', description: '搜索', parameters: { type: 'object' } }],
    },
    'agnes-3.0-flash',
  );

  assert.equal(requestBody.model, 'agnes-3.0-flash');
  assert.equal(requestBody.stream, true);
  assert.equal(requestBody.temperature, 0.3);
  assert.equal(requestBody.max_tokens, 256);
  assert.deepEqual(requestBody.stop, ['\n\n']);
  assert.equal(requestBody.tools[0].function.name, 'search');
});

test('适配器：上游业务错误帧被认领 → 抛错且请求行记失败（不出现假成功）', { timeout: STREAM_TEST_TIMEOUT_MS }, async (t) => {
  resetStreamErrorClaimersForTest();
  const disposeClaimer = registerStreamErrorClaimer({ id: 'test#quota', claim: qoderClaimers[0].claim });
  t.after(() => { disposeClaimer(); resetStreamErrorClaimersForTest(); });

  const { adapter, dataRoot } = await setupAdapter(t, {
    routes: {
      'POST /v1/chat/completions': buildSseRoute([{ code: '112', message: '{"pricingUrl":"https://example.invalid/pricing"}' }]),
    },
  });
  await writeSessionMapping('sess-claimed', { platform: 'agnes', model: 'agnes-3.0-flash', updatedAt: '2026-11-02T13:00:00+08:00' }, { dataRoot });

  await assert.rejects(
    () => collectChunks(adapter.stream({ model: 'dsh-model-team', sessionId: 'sess-claimed', messages: [{ role: 'user', content: 'hi' }] })),
    (llmError) => llmError instanceof StubLlmError && llmError.code === 'UPSTREAM_QUOTA_EXHAUSTED',
  );

  const rows = await readRequestRows({ dataRoot });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 402, '认领给的状态要落进请求行');
  assert.equal(rows[0].claimedReason, 'qoder-code:112', '认领依据可查');
  assert.equal(rows[0].completionTokens, null);
});

test('适配器：订阅路径也记首字时刻（请求行 decodeMs 不再是 null）', { timeout: STREAM_TEST_TIMEOUT_MS }, async (t) => {
  const { adapter, dataRoot } = await setupAdapter(t, {
    routes: {
      'POST /v1/chat/completions': buildSseRoute([
        { choices: [{ index: 0, delta: { role: 'assistant' } }] },
        { choices: [{ index: 0, delta: { content: '你好' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
      ]),
    },
  });
  await writeSessionMapping('sess-first-token', { platform: 'agnes', model: 'agnes-3.0-flash', updatedAt: '2026-11-02T13:00:00+08:00' }, { dataRoot });

  await collectChunks(adapter.stream({ model: 'dsh-model-team', sessionId: 'sess-first-token', messages: [{ role: 'user', content: 'hi' }] }));

  const rows = await readRequestRows({ dataRoot });
  assert.equal(rows.length, 1);
  assert.equal(typeof rows[0].decodeMs, 'number', '首字时刻要参与 decodeMs 计算');
  assert.equal(rows[0].decodeMs >= 0, true);
  assert.equal(typeof rows[0].completionTokens, 'number');
});
