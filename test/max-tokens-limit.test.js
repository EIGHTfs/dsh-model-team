// 上游 max_tokens 上限自适应学习：解析 / 夹取 / 同轮重试 / 进程内记忆 / 端到端闭环。
// 全部用假 Key 与本地 stub 上游，不碰外网；学习值**只在进程内存里**（不落盘）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  capMaxTokens,
  createLimitsStore,
  parseMaxTokensLimit,
} from '../src/gateway/config/limits.js';
import { buildCappedRequestBody, createLimitWarningTracker, retryIfMaxTokensExceeded } from '../src/plugin/adapter/attempt-limits.js';
import { createModelTimAdapter } from '../src/plugin/adapter/adapter.js';
import { createFixedClock } from '../src/gateway/clock.js';
import { writeConfig } from '../src/gateway/config/config.js';
import { writeSessionMapping } from '../src/gateway/session/store.js';
import { createRecordingLogger, createTempDirectory, setEnvironmentVariableForTest } from './helpers/test-environment.js';
import { startStubUpstream, writeJson } from './helpers/stub-upstream.js';

const TEST_KEY_ENV = 'DSH_MODEL_TEAM_MAX_TOKENS_TEST_KEY';
const TEST_API_KEY = 'test-key-not-real';
const UPSTREAM_LIMIT = 1024;

test('解析：中文「max_tokens 不能超过 N」', () => {
  assert.equal(parseMaxTokensLimit('400 {"message":"max_tokens 不能超过 65536","code":"invalid_request"}'), 65536);
});

test('解析：英文 exceed / at most / greater than 三种写法', () => {
  assert.equal(parseMaxTokensLimit('max_tokens must not exceed 4096'), 4096);
  assert.equal(parseMaxTokensLimit('max_tokens should be at most 2048 tokens'), 2048);
  assert.equal(parseMaxTokensLimit('Max Tokens greater than 8192'), 8192);
});

test('解析：maximum 在前与 limit/cap 在后的写法（复验发现的漏网）', () => {
  assert.equal(parseMaxTokensLimit('maximum max tokens is 4096'), 4096);
  assert.equal(parseMaxTokensLimit('the maximum number of tokens allowed is 2048'), 2048);
  assert.equal(parseMaxTokensLimit('max output tokens limit: 8192'), 8192);
  assert.equal(parseMaxTokensLimit('tokens cap 4096'), 4096);
});

test('解析：误判护栏——不含 token 短语的 400 一律 null；过小的数字也不认', () => {
  assert.equal(parseMaxTokensLimit('rate limit exceeded'), null, '不能因为出现 limit 就认');
  assert.equal(parseMaxTokensLimit('invalid api key'), null);
  assert.equal(parseMaxTokensLimit('max tokens 3 retries'), null, '低于合理性下限的数字不当作上限');
});

test('解析：与上限无关的文案一律返回 null（据此不重试）', () => {
  assert.equal(parseMaxTokensLimit('rate limit exceeded'), null);
  assert.equal(parseMaxTokensLimit('max_tokens 不能超过'), null);
  assert.equal(parseMaxTokensLimit(''), null);
  assert.equal(parseMaxTokensLimit(undefined), null);
});

test('夹取①：还没学到上限时，配置值原样发送（用来自证上游是否已放宽）', () => {
  assert.deepEqual(
    capMaxTokens({ requested: 65536, configured: 8192 }),
    { maxTokens: 8192, source: 'configured' },
  );
  assert.deepEqual(capMaxTokens({ requested: 9000 }), { maxTokens: 9000, source: 'requested' });
  assert.deepEqual(capMaxTokens({}), { maxTokens: null, source: 'none' });
});

test('夹取②：学到上限后，配置更高也要被学习值封顶', () => {
  assert.deepEqual(
    capMaxTokens({ requested: 65536, configured: 8192, learned: 1024 }),
    { maxTokens: 1024, source: 'learned' },
  );
  // 没有配置时同样封顶宿主原值
  assert.deepEqual(capMaxTokens({ requested: 9000, learned: 2000 }), { maxTokens: 2000, source: 'learned' });
  assert.deepEqual(capMaxTokens({ requested: 500, learned: 2000 }), { maxTokens: 500, source: 'learned' });
});

test('夹取③：学到上限后，配置比学习值更小则按配置（source=configured）', () => {
  assert.deepEqual(
    capMaxTokens({ requested: 65536, configured: 512, learned: 1024 }),
    { maxTokens: 512, source: 'configured' },
  );
});

test('进程内记忆：学到后同进程可读回；**不落盘**', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const store = createLimitsStore({ dataRoot, logger });

  assert.equal(await store.getLimit('agnes', 'model-a'), null, '没有记录时返回 null');
  await store.learnLimit('agnes', 'model-a', UPSTREAM_LIMIT);

  assert.equal(await store.getLimit('agnes', 'model-a'), UPSTREAM_LIMIT, '同进程可读回声明上限');
  assert.equal(await store.getEffectiveLimit('agnes', 'model-a'), UPSTREAM_LIMIT - 1, '默认可用值 = 上限 − 1');

  // 明确断言：不产生任何文件（用户口径：撞到即学、秒级完成，不落盘）
  const filesInDataRoot = await fs.readdir(dataRoot).catch(() => []);
  assert.deepEqual(filesInDataRoot, [], `数据根不该出现 limits 文件，实际：${filesInDataRoot.join(',')}`);
});

test('进程内 store 重建（模拟重启）后为空：会再撞一次 400（预期行为，不是缺陷）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const beforeRestart = createLimitsStore({ dataRoot, logger });
  await beforeRestart.learnLimit('agnes2', 'agnes-3.0-flash', 65536, { effective: 65535 });

  // 重启 = 新进程 = 新 store：内存清空，于是下一次请求会先撞 400 再学
  const afterRestart = createLimitsStore({ dataRoot, logger });
  assert.equal(await afterRestart.getLimit('agnes2', 'agnes-3.0-flash'), null, '重启后声明上限丢失');
  assert.equal(await afterRestart.getEffectiveLimit('agnes2', 'agnes-3.0-flash'), null, '重启后可用值丢失');
});

// 重试逻辑用的驱动桩：记录每次请求体，按预设的响应序列返回
function createDriverStub(responses) {
  const calls = [];
  return {
    calls,
    driver: {
      async streamCompletions(context, body) {
        calls.push(JSON.parse(JSON.stringify(body)));
        const response = responses[Math.min(calls.length - 1, responses.length - 1)];
        return response;
      },
    },
  };
}

function buildFailedResult(message) {
  return { ok: false, status: 400, events: null, error: { code: 'UPSTREAM_HTTP_ERROR', message } };
}

test('重试：只有"上限类 400"会在同一次调用内按上限重发一次，成功即返回', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const limitsStore = createLimitsStore({ dataRoot, logger });
  const warnOnce = createLimitWarningTracker();
  const successResult = { ok: true, status: 200, events: [], error: null };
  const stub = createDriverStub([buildFailedResult('max_tokens 不能超过 1024'), successResult]);

  const firstResult = await stub.driver.streamCompletions({}, { max_tokens: 65536 });
  const finalResult = await retryIfMaxTokensExceeded({
    driver: stub.driver,
    driverContext: {},
    requestBody: { max_tokens: 65536 },
    result: firstResult,
    group: { id: 'agnes' },
    model: 'model-a',
    limitsStore,
    logger,
    warnOnce,
    signal: undefined,
  });

  assert.equal(finalResult.ok, true, '重发成功要把成功结果交回去');
  assert.equal(stub.calls.length, 2, '只允许重发一次');
  assert.equal(stub.calls[1].max_tokens, UPSTREAM_LIMIT - 1, '重发时 max_tokens = 声明上限 − 1（上游边界排他）');
  assert.equal(await limitsStore.getLimit('agnes', 'model-a'), UPSTREAM_LIMIT, '声明上限记在进程内存（证据）');
  assert.equal(await limitsStore.getEffectiveLimit('agnes', 'model-a'), UPSTREAM_LIMIT - 1, '可用值 = 上限 − 1 也记住');

  // 同一 (群,模型) 再撞一次：不再重复告警
  const warnCountBefore = logger.lines.filter((line) => line.level === 'warn').length;
  await retryIfMaxTokensExceeded({
    driver: stub.driver,
    driverContext: {},
    requestBody: { max_tokens: 65536 },
    result: buildFailedResult('max_tokens 不能超过 1024'),
    group: { id: 'agnes' },
    model: 'model-a',
    limitsStore,
    logger,
    warnOnce,
    signal: undefined,
  });
  const warnCountAfter = logger.lines.filter((line) => line.level === 'warn').length;
  assert.equal(warnCountAfter, warnCountBefore, '同一个 (群,模型) 只告警一次');
});

test('重试：非上限类 400 不重试，原样返回', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const limitsStore = createLimitsStore({ dataRoot, logger: createRecordingLogger() });
  const stub = createDriverStub([buildFailedResult('bad request: missing model')]);
  const originalResult = buildFailedResult('bad request: missing model');

  const finalResult = await retryIfMaxTokensExceeded({
    driver: stub.driver,
    driverContext: {},
    requestBody: { max_tokens: 4096 },
    result: originalResult,
    group: { id: 'agnes' },
    model: 'model-a',
    limitsStore,
    logger: createRecordingLogger(),
    warnOnce: createLimitWarningTracker(),
    signal: undefined,
  });

  assert.equal(finalResult, originalResult, '非上限类失败要原样返回');
  assert.equal(stub.calls.length, 0, '不允许发起重发（驱动一次都没被再调）');
});

test('重试：重发仍失败 → 返回失败结果（不无限重试）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const limitsStore = createLimitsStore({ dataRoot, logger: createRecordingLogger() });
  const retryFailure = buildFailedResult('still failing');
  const stub = createDriverStub([buildFailedResult('max_tokens 不能超过 1024'), retryFailure]);

  const firstResult = await stub.driver.streamCompletions({}, { max_tokens: 65536 });
  const finalResult = await retryIfMaxTokensExceeded({
    driver: stub.driver,
    driverContext: {},
    requestBody: { max_tokens: 65536 },
    result: firstResult,
    group: { id: 'agnes' },
    model: 'model-a',
    limitsStore,
    logger: createRecordingLogger(),
    warnOnce: createLimitWarningTracker(),
    signal: undefined,
  });

  assert.equal(finalResult.ok, false);
  assert.equal(stub.calls.length, 2, '最多两次（原始 + 一次重发）');
});

test('实际发送：configured 高于 learned 时，请求体里被学习值封顶', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const limitsStore = createLimitsStore({ dataRoot, logger: createRecordingLogger() });
  await limitsStore.learnLimit('agnes', 'model-a', 1024);

  const { body } = await buildCappedRequestBody({
    options: { maxTokens: 65536, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    modelId: 'model-a',
    imageUrls: undefined,
    group: { id: 'agnes', request: { maxTokens: 4096 } },
    model: 'model-a',
    limitsStore,
  });

  // 学到之后，天花板是 effective（= 声明上限 − 1），配置值同样被它封顶
  assert.equal(body.max_tokens, 1023, '学到上限后，配置值也被可用值封顶');
});

// ===== 端到端闭环：真适配器 + 真驱动 + 本地 stub 上游（首次 400，第二次成功）=====

class StubLlmAdapter {}
class StubLlmError extends Error {
  constructor(message, code, options = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.status = options.status;
  }
}

function buildSseRoute(events) {
  return async ({ outgoingResponse }) => {
    outgoingResponse.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const ssePayload of events) outgoingResponse.write(`data: ${JSON.stringify(ssePayload)}\n\n`);
    outgoingResponse.write('data: [DONE]\n\n');
    outgoingResponse.end();
  };
}

test('闭环：首次 400 带上限 → 自动重发 → 客户端拿到成功流，上游只被打两次、第二次已夹住', async (t) => {
  setEnvironmentVariableForTest(t, TEST_KEY_ENV, TEST_API_KEY);
  const dataRoot = await createTempDirectory(t);

  const successEvents = [
    { id: 'chatcmpl-limit', choices: [{ index: 0, delta: { role: 'assistant', content: '好' } }] },
    { id: 'chatcmpl-limit', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
  ];
  const stubUpstream = await startStubUpstream({
    routes: {
      'POST /v1/chat/completions': async (stubContext) => {
        const isFirstCall = stubContext.requests.filter((item) => item.pathname === '/v1/chat/completions').length === 1;
        if (isFirstCall) {
          writeJson(stubContext.outgoingResponse, 400, { message: `max_tokens 不能超过 ${UPSTREAM_LIMIT}`, code: 'invalid_request' });
          return;
        }
        await buildSseRoute(successEvents)(stubContext);
      },
    },
  });
  t.after(() => stubUpstream.close());

  await writeConfig({
    groups: [{
      id: 'agnes',
      name: 'agnes(本机)',
      accessMode: 'official',
      driver: 'openai-compatible',
      baseURL: stubUpstream.baseURL,
      auth: { type: 'bearer', apiKeyRef: `env:${TEST_KEY_ENV}` },
      models: { static: ['model-a'] },
      response: { usagePath: 'usage' },
    }],
  }, { dataRoot });
  await writeSessionMapping('sess-limit', { platform: 'agnes', model: 'model-a', updatedAt: '2026-11-06T10:00:00+08:00' }, { dataRoot });

  const logger = createRecordingLogger();
  const ModelTimAdapter = createModelTimAdapter({
    BaseAdapter: StubLlmAdapter,
    LlmErrorClass: StubLlmError,
    deps: { dataRoot, logger, clock: createFixedClock() },
  });
  const adapter = new ModelTimAdapter();

  const chunks = [];
  for await (const chunk of adapter.stream({
    provider: 'dsh-model-team',
    model: 'dsh-model-team',
    sessionId: 'sess-limit',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 65536,
  })) {
    chunks.push(chunk);
  }

  const textDeltas = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
  assert.equal(textDeltas, '好', '客户端要拿到成功流');
  assert.equal(stubUpstream.requests.length, 2, '上游只允许被打两次');

  const firstBody = JSON.parse(stubUpstream.requests[0].bodyText);
  const secondBody = JSON.parse(stubUpstream.requests[1].bodyText);
  assert.equal(firstBody.max_tokens, 65536, '首次按宿主原值发');
  assert.equal(secondBody.max_tokens, UPSTREAM_LIMIT - 1, '重发时 = 声明上限 − 1');

  // 同一进程内的第二个请求：学习值在内存里，首发就直接用 effective（不再撞 400）
  const secondChunks = [];
  for await (const chunk of adapter.stream({
    provider: 'dsh-model-team',
    model: 'dsh-model-team',
    sessionId: 'sess-limit',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 65536,
  })) {
    secondChunks.push(chunk);
  }
  assert.equal(stubUpstream.requests.length, 3, '第二个请求只打一次上游（不再有 400 重发）');
  const thirdBody = JSON.parse(stubUpstream.requests[2].bodyText);
  assert.equal(thirdBody.max_tokens, UPSTREAM_LIMIT - 1, '第二个请求首发即用 effective');
  assert.equal(secondChunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), '好');
});
