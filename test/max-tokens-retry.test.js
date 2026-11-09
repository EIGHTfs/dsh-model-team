// 撞上限的取证与重发语义（B11c / B11d）：独立成文件是因为原用例已到 400 行门槛，
// 也因为这一段是"上游边界排他"的证据链，值得单独成篇。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createLimitsStore } from '../src/gateway/config/limits.js';
import {
  buildCappedRequestBody,
  createLimitWarningTracker,
  retryIfMaxTokensExceeded,
} from '../src/plugin/adapter/attempt-limits.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

function buildFailedResult(message) {
  return { ok: false, status: 400, events: null, error: { code: 'UPSTREAM_HTTP_ERROR', message } };
}

function createDriverStub(responses) {
  const calls = [];
  return {
    calls,
    driver: {
      async streamCompletions(context, body) {
        calls.push(JSON.parse(JSON.stringify(body)));
        return responses[Math.min(calls.length - 1, responses.length - 1)];
      },
    },
  };
}

// ---- B11c：撞上限取证日志（只加日志，判断分支不变） ----
// 判据：`requested > learned` → decision=retry 且 cappedTo=learned；
//       `requested === learned` → decision=no-retry 且 cappedTo=null（这正是要取证的那一档）。

function readLimitTraceLines(logger) {
  return logger.lines
    .filter((line) => line.level === 'info' && line.message.startsWith('max_tokens 上限命中 '))
    .map((line) => JSON.parse(line.message.slice('max_tokens 上限命中 '.length)));
}

test('B11c：above（requested > learned）产生一条日志，decision=retry 且 cappedTo=learned', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const limitsStore = createLimitsStore({ dataRoot, logger });
  const stub = createDriverStub([
    buildFailedResult('max_tokens 不能超过 1024'),
    { ok: true, status: 200, events: [], error: null },
  ]);

  await retryIfMaxTokensExceeded({
    driver: stub.driver,
    driverContext: {},
    requestBody: { max_tokens: 65536 },
    result: buildFailedResult('max_tokens 不能超过 1024'),
    group: { id: 'agnes' },
    model: 'model-above',
    limitsStore,
    logger,
    warnOnce: createLimitWarningTracker(),
    signal: undefined,
  });

  const traces = readLimitTraceLines(logger);
  assert.equal(traces.length, 1, '一次命中只记一条');
  assert.deepEqual(traces[0], {
    group: 'agnes',
    model: 'model-above',
    requested: 65536,
    learned: 1024,
    effective: 1023,
    retriedTo: 1023,
    decision: 'retry',
    retried: true,
    status: 400,
  });
});

test('B11d：equal（requested === learned）→ 按「上限 − 1」重发一次（上游边界排他）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const limitsStore = createLimitsStore({ dataRoot, logger });
  const stub = createDriverStub([{ ok: true, status: 200, events: [], error: null }]);
  const originalResult = buildFailedResult('max_tokens 不能超过 1024');

  const returned = await retryIfMaxTokensExceeded({
    driver: stub.driver,
    driverContext: {},
    requestBody: { max_tokens: 1024 },
    result: originalResult,
    group: { id: 'agnes2' },
    model: 'agnes-3.0-flash',
    limitsStore,
    logger,
    warnOnce: createLimitWarningTracker(),
    signal: undefined,
  });

  const traces = readLimitTraceLines(logger);
  assert.equal(traces.length, 1, '一次命中只记一条');
  assert.deepEqual(traces[0], {
    group: 'agnes2',
    model: 'agnes-3.0-flash',
    requested: 1024,
    learned: 1024,
    effective: 1023,
    retriedTo: 1023,
    decision: 'retry',
    retried: true,
    status: 400,
  });
  assert.equal(stub.calls.length, 1, 'equal 这一档必须重发一次');
  assert.equal(stub.calls[0].max_tokens, 1023, '重发值 = 声明上限 − 1');
  assert.equal(returned.ok, true, '重发成功要把成功结果交回去');
});

test('B11c：没有 logger 时静默跳过（日志缺失不影响请求处理）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const limitsStore = createLimitsStore({ dataRoot, logger: createRecordingLogger() });
  const stub = createDriverStub([buildFailedResult('max_tokens 不能超过 1024')]);

  const returned = await retryIfMaxTokensExceeded({
    driver: stub.driver,
    driverContext: {},
    requestBody: { max_tokens: 1024 },
    result: buildFailedResult('max_tokens 不能超过 1024'),
    group: { id: 'agnes' },
    model: 'model-no-logger',
    limitsStore,
    logger: undefined,
    warnOnce: createLimitWarningTracker(),
    signal: undefined,
  });

  assert.equal(returned.ok, false, '没有 logger 也不能抛错');
  assert.equal(returned.status, 400);
});

test('B11d：下限保护 —— 上限 − 1 低于 256 时不重发，原样把 400 交回', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const limitsStore = createLimitsStore({ dataRoot, logger });
  const stub = createDriverStub([{ ok: true, status: 200, events: [], error: null }]);
  const originalResult = buildFailedResult('max_tokens 不能超过 256');

  const returned = await retryIfMaxTokensExceeded({
    driver: stub.driver,
    driverContext: {},
    requestBody: { max_tokens: 100000 },
    result: originalResult,
    group: { id: 'agnes' },
    model: 'model-floor',
    limitsStore,
    logger,
    warnOnce: createLimitWarningTracker(),
    signal: undefined,
  });

  assert.equal(returned, originalResult, '低于下限 → 不重发，原样返回 400');
  assert.equal(stub.calls.length, 0, '一次都不该发');
  const trace = readLimitTraceLines(logger)[0];
  assert.equal(trace.decision, 'no-retry');
  assert.equal(trace.retried, false);
  assert.equal(trace.retriedTo, null);
  assert.equal(trace.learned, 256);
});

test('B11d：第二个请求起直接用 effective（不再先撞 400）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const limitsStore = createLimitsStore({ dataRoot, logger });
  await limitsStore.learnLimit('agnes', 'model-a', 65536, { effective: 65535 });

  const { body, capped } = await buildCappedRequestBody({
    options: { maxTokens: 100000 },
    modelId: 'model-a',
    imageUrls: [],
    group: { id: 'agnes' },
    model: 'model-a',
    limitsStore,
  });

  assert.equal(body.max_tokens, 65535, '直接发可用值，不必再撞一次 400');
  assert.equal(capped.source, 'effective', 'source 要能指出生效的是 effective 这一档');
});

test('B11d：重发成功后才记住 effective（进程内存）；下一个请求直接用 effective（不再撞 400）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const limitsStore = createLimitsStore({ dataRoot, logger });
  const stub = createDriverStub([{ ok: true, status: 200, events: [], error: null }]);

  const firstResult = buildFailedResult('max_tokens 不能超过 4096');
  const finalResult = await retryIfMaxTokensExceeded({
    driver: stub.driver,
    driverContext: {},
    requestBody: { max_tokens: 4096 },
    result: firstResult,
    group: { id: 'agnes2' },
    model: 'agnes-3.0-flash',
    limitsStore,
    logger,
    warnOnce: createLimitWarningTracker(),
    signal: undefined,
  });

  assert.equal(finalResult.ok, true, '按 learned-1 重发成功');
  assert.equal(stub.calls[0].max_tokens, 4095, '重发值 = 声明上限 − 1');
  assert.equal(await limitsStore.getLimit('agnes2', 'agnes-3.0-flash'), 4096, '声明上限记在内存（证据）');
  assert.equal(await limitsStore.getEffectiveLimit('agnes2', 'agnes-3.0-flash'), 4095, '可用值记在内存');

  // 第二个请求：不再撞 400，直接发 effective
  const { body, capped } = await buildCappedRequestBody({
    options: { maxTokens: 4096 },
    modelId: 'agnes-3.0-flash',
    imageUrls: [],
    group: { id: 'agnes2' },
    model: 'agnes-3.0-flash',
    limitsStore,
  });
  assert.equal(body.max_tokens, 4095, '第二个请求直接发可用值');
  assert.equal(capped.source, 'effective');
});

test('B11d：重发仍失败时只记声明上限，不把未验证的降值当可用值', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const limitsStore = createLimitsStore({ dataRoot, logger });
  const stub = createDriverStub([buildFailedResult('quota exceeded')]);

  const finalResult = await retryIfMaxTokensExceeded({
    driver: stub.driver,
    driverContext: {},
    requestBody: { max_tokens: 2048 },
    result: buildFailedResult('max_tokens 不能超过 2048'),
    group: { id: 'agnes' },
    model: 'model-retry-fail',
    limitsStore,
    logger,
    warnOnce: createLimitWarningTracker(),
    signal: undefined,
  });

  assert.equal(finalResult.ok, false, '重发失败要如实返回失败');
  assert.equal(await limitsStore.getLimit('agnes', 'model-retry-fail'), 2048, '声明上限仍要留下');
  assert.equal(await limitsStore.getEffectiveLimit('agnes', 'model-retry-fail'), null, '未验证成功的降值不写 effective');
});
