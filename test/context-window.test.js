// T24 容量申报与超限检查的用例。
// 覆盖三类必测点：申报值必须是正数（含兜底与最小值）、探测失败要降级、超限判断的边界（等于窗口放行）。
// 另有三条时间行为用例把「探测不许回到解析同步路径」钉死：冷调用 50ms 内返回、后台探测下次生效、
// 空样本也缓存（连续解析只探一次）——探测一旦被 await 回 resolveModel，第一条就会超时变红。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONTEXT_WINDOW_FALLBACK,
  collectConfiguredContextWindows,
  normalizeContextLength,
  pickDeclaredContextWindow,
} from '../src/gateway/model-capacity.js';
import { peekDeclaredContextWindow, resolveDeclaredContextWindow, resetContextWindowCache } from '../src/plugin/context-window.js';
import {
  buildContextOverflowMessage,
  estimateMessagesTokens,
  evaluateContextGuard,
  isContextGuardEnabled,
} from '../src/plugin/context-guard.js';
import { createModelTimAdapter } from '../src/plugin/adapter.js';
import { writeConfig } from '../src/gateway/config.js';
import { createFixedClock } from '../src/gateway/clock.js';
import { createRecordingLogger, createTempDirectory, setEnvironmentVariableForTest } from './helpers/test-environment.js';

class StubLlmAdapter {}
class StubLlmError extends Error {}

// 假 Key 环境变量：只用假值（探测要先解析凭证才会发请求）
const TEST_API_KEY_ENV = 'DSH_MODEL_TEAM_TEST_API_KEY';
const TEST_API_KEY = 'test-key-not-real';
// 冷调用预算：真实探测是 1000ms 量级（单群超时 1200ms），50ms 差两个数量级，卡住必红
const COLD_RESOLVE_BUDGET_MS = 50;
// 后台链路结算窗口：假 fetch 立即返回，凭证解析 + 响应解析都是微任务，50ms 足够
const PROBE_SETTLE_MS = 50;

// endpoint 型群（没有静态窗口 → 只能探测）；id/baseURL 可覆盖，方便用例之间不共享缓存签名
function buildEndpointGroup(overrides = {}) {
  return {
    id: 'agnes-endpoint',
    name: 'agnes',
    accessMode: 'official',
    driver: 'openai-compatible',
    baseURL: 'https://api.example.com/v1',
    auth: { type: 'bearer', apiKeyRef: `env:${TEST_API_KEY_ENV}` },
    models: { endpoint: '/models' },
    ...overrides,
  };
}

// 上游 /models 响应：与真实 OpenAI 兼容上游同形（data[]）
function buildModelsResponse(models) {
  return new Response(JSON.stringify({ object: 'list', data: models }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function createAdapter({ dataRoot, logger, fetchImpl }) {
  const ModelTimAdapter = createModelTimAdapter({
    BaseAdapter: StubLlmAdapter,
    LlmErrorClass: StubLlmError,
    deps: { dataRoot, logger, clock: createFixedClock(), fetchImpl },
  });
  return new ModelTimAdapter();
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// 时限断言：超时直接抛错（比"等它自然失败"更容易读懂；被测 promise 先完成时清掉定时器，不留悬挂拒绝）
function resolveWithinDeadline(promise, budgetMs, timeoutMessage) {
  let deadlineTimer;
  const deadline = new Promise((resolve, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error(timeoutMessage)), budgetMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(deadlineTimer));
}

function buildStaticGroup(overrides = {}) {
  return {
    id: 'agnes',
    name: 'agnes',
    accessMode: 'official',
    driver: 'openai-compatible',
    baseURL: 'https://api.example.com/v1',
    auth: { type: 'bearer', apiKeyRef: 'env:DSH_MODEL_TEAM_TEST_API_KEY' },
    models: { static: [{ id: 'model-a', name: 'A', contextLength: 1000000 }, { id: 'model-b', name: 'B', contextLength: 300000 }] },
    ...overrides,
  };
}

test('容量归一化：context_length → max_allowed_size → context_window.default，无效值一律 null', () => {
  assert.equal(normalizeContextLength({ context_length: 128000, max_allowed_size: 64000 }), 128000);
  assert.equal(normalizeContextLength({ max_allowed_size: 64000, context_window: { default: 32000 } }), 64000);
  assert.equal(normalizeContextLength({ context_window: { default: 32000 } }), 32000);
  assert.equal(normalizeContextLength({ context_length: 0, max_allowed_size: -1, context_window: { default: Number.NaN } }), null);
  assert.equal(normalizeContextLength({}), null);
});

test('申报窗口：取所有已知窗口的最小值（大模型 + 小模型并存 → 小窗口）', () => {
  const declaredWindow = pickDeclaredContextWindow({ knownWindows: [1000000, 300000, 128000] });
  assert.equal(declaredWindow, 128000);
});

test('申报窗口：一个已知样本都没有 → 兜底 262144；非法兜底值也不许返回 0/NaN', () => {
  assert.equal(pickDeclaredContextWindow({ knownWindows: [] }), DEFAULT_CONTEXT_WINDOW_FALLBACK);
  for (const invalidFallback of [0, -1, Number.NaN, 'not-a-number', undefined]) {
    const declaredWindow = pickDeclaredContextWindow({ knownWindows: [], fallback: invalidFallback });
    assert.equal(declaredWindow, DEFAULT_CONTEXT_WINDOW_FALLBACK);
    assert.equal(Number.isFinite(declaredWindow) && declaredWindow > 0, true);
  }
});

test('配置采集：只认 models.static[] 的 contextLength（endpoint 型群不参与）', () => {
  const windows = collectConfiguredContextWindows({
    groups: [
      buildStaticGroup(),
      { id: 'endpoint-group', models: { endpoint: '/models' } },
    ],
  });
  assert.deepEqual(windows.sort((left, right) => left - right), [300000, 1000000]);
});

test('resolveDeclaredContextWindow：静态窗口够用时直接给最小值，不发网络请求', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  await writeConfig({ groups: [buildStaticGroup()] }, { dataRoot });
  resetContextWindowCache();

  const declaredWindow = await resolveDeclaredContextWindow({
    config: { groups: [buildStaticGroup()] },
    dataRoot,
    logger,
    fetchImpl: async () => { throw new Error('不该发请求'); },
  });
  assert.equal(declaredWindow, 300000);
});

test('resolveDeclaredContextWindow：探测全失败（驱动不存在）→ 退兜底 262144，不抛错', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const endpointGroup = {
    id: 'endpoint-group',
    name: 'endpoint',
    driver: 'driver-not-installed',
    baseURL: 'https://api.example.com/v1',
    auth: { type: 'bearer', apiKeyRef: 'env:DSH_MODEL_TEAM_TEST_API_KEY' },
    models: { endpoint: '/models' },
  };
  await writeConfig({ groups: [endpointGroup] }, { dataRoot });
  resetContextWindowCache();

  const declaredWindow = await resolveDeclaredContextWindow({ config: { groups: [endpointGroup] }, dataRoot, logger });
  assert.equal(declaredWindow, DEFAULT_CONTEXT_WINDOW_FALLBACK);
  assert.equal(declaredWindow > 0, true);
});

test('适配器 resolveModel：必须带正数 context.contextWindow（否则 dsh 压缩抛 TargetProviderConfigError）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const config = { groups: [buildStaticGroup()] };
  await writeConfig(config, { dataRoot });
  resetContextWindowCache();

  const ModelTimAdapter = createModelTimAdapter({
    BaseAdapter: StubLlmAdapter,
    LlmErrorClass: StubLlmError,
    deps: { dataRoot, logger, clock: createFixedClock() },
  });
  const resolvedModel = await new ModelTimAdapter().resolveModel('dsh-model-team', 'dsh-model-team');

  assert.equal(typeof resolvedModel.context?.contextWindow, 'number');
  assert.equal(Number.isFinite(resolvedModel.context.contextWindow), true);
  assert.equal(resolvedModel.context.contextWindow > 0, true);
  assert.equal(resolvedModel.context.contextWindow, 300000);
});

test('超限检查边界：刚好等于窗口放行，明确超过才拦，窗口未知不拦', () => {
  assert.equal(evaluateContextGuard({ estimatedTokens: 128000, windowTokens: 128000 }).blocked, false);
  assert.equal(evaluateContextGuard({ estimatedTokens: 128001, windowTokens: 128000 }).blocked, true);
  assert.equal(evaluateContextGuard({ estimatedTokens: 999999, windowTokens: null }).blocked, false);
  assert.equal(evaluateContextGuard({ estimatedTokens: 999999, windowTokens: 0 }).blocked, false);
});

test('超限错误文案：四个数字齐全（估算 / 上次 prompt_tokens / 窗口 / 模型 id）', () => {
  const message = buildContextOverflowMessage({
    estimatedTokens: 200000,
    lastPromptTokens: 180000,
    windowTokens: 128000,
    modelId: 'model-b',
  });
  for (const fragment of ['200000', '180000', '128000', 'model-b']) {
    assert.equal(message.includes(fragment), true, `错误文案缺少 ${fragment}`);
  }
});

test('消息 token 估算：空消息为 0，有内容为正数', () => {
  assert.equal(estimateMessagesTokens([]), 0);
  assert.equal(estimateMessagesTokens([{ role: 'user', content: 'hello world' }]) > 0, true);
  assert.equal(estimateMessagesTokens([{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(300) }] }]) >= 100, true);
});

test('超限检查开关：缺省开启，只有显式 false 才关闭', () => {
  assert.equal(isContextGuardEnabled({}), true);
  assert.equal(isContextGuardEnabled({ contextGuard: {} }), true);
  assert.equal(isContextGuardEnabled({ contextGuard: { enabled: true } }), true);
  assert.equal(isContextGuardEnabled({ contextGuard: { enabled: false } }), false);
});

test('resolveModel 后台探测：上游报容量后，下一次解析用上新窗口（取两个窗口的最小值）', async (t) => {
  setEnvironmentVariableForTest(t, TEST_API_KEY_ENV, TEST_API_KEY);
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const config = { groups: [buildEndpointGroup()] };
  await writeConfig(config, { dataRoot });
  resetContextWindowCache();

  let fetchCallCount = 0;
  const fetchImpl = async () => {
    fetchCallCount += 1;
    return buildModelsResponse([
      { id: 'model-a', context_length: 1000000 },
      { id: 'model-b', context_length: 60000 },
    ]);
  };
  const adapter = createAdapter({ dataRoot, logger, fetchImpl });

  const coldModel = await adapter.resolveModel('dsh-model-team', 'dsh-model-team');
  assert.equal(coldModel.context.contextWindow, DEFAULT_CONTEXT_WINDOW_FALLBACK, '缓存未命中时先申报兜底');

  await sleep(PROBE_SETTLE_MS);

  const warmModel = await adapter.resolveModel('dsh-model-team', 'dsh-model-team');
  assert.equal(warmModel.context.contextWindow, 60000, '后台探测写入缓存后应取最小窗口');
  assert.equal(fetchCallCount, 1, '第二次解析命中缓存，不该再发上游请求');
});

test('resolveModel 空样本缓存：上游 0 条带容量时，连续解析只探一次', async (t) => {
  setEnvironmentVariableForTest(t, TEST_API_KEY_ENV, TEST_API_KEY);
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const config = { groups: [buildEndpointGroup({ id: 'agnes-no-capacity', baseURL: 'https://no-capacity.example.com/v1' })] };
  await writeConfig(config, { dataRoot });
  resetContextWindowCache();

  let fetchCallCount = 0;
  const fetchImpl = async () => {
    fetchCallCount += 1;
    // 与真实 agnes 的 /v1/models 同形：9 条模型，0 条带容量字段
    const models = Array.from({ length: 9 }, (unused, index) => ({
      id: `agnes-model-${index}`,
      object: 'model',
      created: 0,
      owned_by: 'agnes',
    }));
    return buildModelsResponse(models);
  };
  const adapter = createAdapter({ dataRoot, logger, fetchImpl });

  const declaredWindows = [];
  for (let attemptIndex = 0; attemptIndex < 5; attemptIndex += 1) {
    const resolvedModel = await adapter.resolveModel('dsh-model-team', 'dsh-model-team');
    declaredWindows.push(resolvedModel.context.contextWindow);
    await sleep(PROBE_SETTLE_MS);
  }

  assert.deepEqual([...new Set(declaredWindows)], [DEFAULT_CONTEXT_WINDOW_FALLBACK], '空样本期间一律申报兜底值');
  assert.equal(fetchCallCount, 1, '空样本也必须缓存：连续解析不许每次重探上游');
});

test('resolveModel 冷调用：上游永不返回也要 50ms 内给出兜底值（探测不许回到同步路径）', async (t) => {
  setEnvironmentVariableForTest(t, TEST_API_KEY_ENV, TEST_API_KEY);
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  // 独立签名（id/baseURL 不同）：这条用例故意留下一个悬挂探测，不能影响其它用例的缓存
  const config = { groups: [buildEndpointGroup({ id: 'agnes-never-returns', baseURL: 'https://never-returns.example.com/v1' })] };
  await writeConfig(config, { dataRoot });
  resetContextWindowCache();

  const neverResolvesFetch = () => new Promise(() => {});
  const adapter = createAdapter({ dataRoot, logger, fetchImpl: neverResolvesFetch });

  const startedAtMs = Date.now();
  const resolvedModel = await resolveWithinDeadline(
    adapter.resolveModel('dsh-model-team', 'dsh-model-team'),
    COLD_RESOLVE_BUDGET_MS,
    `冷调用超过 ${COLD_RESOLVE_BUDGET_MS}ms：探测又回到 resolveModel 的同步路径了`,
  );
  const elapsedMs = Date.now() - startedAtMs;

  assert.equal(resolvedModel.context.contextWindow, DEFAULT_CONTEXT_WINDOW_FALLBACK);
  assert.equal(
    elapsedMs < COLD_RESOLVE_BUDGET_MS,
    true,
    `冷调用耗时 ${elapsedMs}ms 超过 ${COLD_RESOLVE_BUDGET_MS}ms：探测又回到 resolveModel 的同步路径了`,
  );
});

// T28：config.contextWindow 显式覆盖（三级取值的①级）。
// 为什么要有这一级：上游不报容量时（agnes 的 /v1/models 0 条带容量字段），运维只能手填真实值，
// 否则永远退兜底，申报值与真实窗口不一致。
test('T28 ①：override 有效 → 压过「已知模型最小值」', () => {
  const declaredWindow = pickDeclaredContextWindow({
    override: 200000,
    knownWindows: [1000000, 128000],
  });
  assert.equal(declaredWindow, 200000);
});

test('T28 ②：override 有效 → 无任何样本时也压过兜底', () => {
  const declaredWindow = pickDeclaredContextWindow({
    override: '307200',
    knownWindows: [],
    fallback: 1048576,
  });
  assert.equal(declaredWindow, 307200);
});

test('T28 ③：override 非法（0 / 负数 / NaN / 非数字串）→ 回退到已知最小值', () => {
  for (const invalidOverride of [0, -1, Number.NaN, 'not-a-number', '', {}]) {
    const declaredWindow = pickDeclaredContextWindow({
      override: invalidOverride,
      knownWindows: [1000000, 128000],
    });
    assert.equal(declaredWindow, 128000, `${String(invalidOverride)} 应视为未设置`);
  }
});

test('T28 ④：override 非法 + 无样本 → 落兜底，且只告警一次（peek 口径）', () => {
  resetContextWindowCache();
  const warnings = [];
  const logger = { info() {}, warn: (message) => warnings.push(message), error() {} };
  const config = { contextWindow: 0, groups: [] };

  assert.equal(peekDeclaredContextWindow({ config, logger }), DEFAULT_CONTEXT_WINDOW_FALLBACK);
  assert.equal(peekDeclaredContextWindow({ config, logger }), DEFAULT_CONTEXT_WINDOW_FALLBACK);
  assert.equal(warnings.length, 1, '非法覆盖值只告警一次，不能每次 resolveModel 都刷');
  assert.match(warnings[0], /contextWindow/);

  // 复位后应重新允许告警（否则测试隔离性差，线上也无法在修好再改坏时看到提示）
  resetContextWindowCache();
  peekDeclaredContextWindow({ config, logger });
  assert.equal(warnings.length, 2);
});

test('T28 ⑤：未设 override → 行为与改动前一致（回归保护）', () => {
  const withWindows = pickDeclaredContextWindow({ knownWindows: [1000000, 300000] });
  assert.equal(withWindows, 300000, '未设 override 仍取最小值');

  const withoutWindows = pickDeclaredContextWindow({ knownWindows: [] });
  assert.equal(withoutWindows, DEFAULT_CONTEXT_WINDOW_FALLBACK, '未设 override 且无样本仍落兜底');

  const customFallback = pickDeclaredContextWindow({ knownWindows: [], fallback: 65536 });
  assert.equal(customFallback, 65536, '未设 override 时自定义兜底仍生效');
});

test('T28 ⑥：适配器 resolveModel 也吃 override（生产路径与 peek 同口径）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  await writeConfig({ contextWindow: 524288, groups: [buildStaticGroup()] }, { dataRoot });
  resetContextWindowCache();

  const ModelTimAdapter = createModelTimAdapter({
    BaseAdapter: StubLlmAdapter,
    LlmErrorClass: StubLlmError,
    deps: { dataRoot, logger, clock: createFixedClock() },
  });
  const resolvedModel = await new ModelTimAdapter().resolveModel('dsh-model-team', 'dsh-model-team');

  // 群里有 1000000 / 300000 两个窗口，override 必须压过最小值
  assert.equal(resolvedModel.context.contextWindow, 524288);
});
