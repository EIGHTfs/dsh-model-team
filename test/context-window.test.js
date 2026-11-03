// T24 容量申报与超限检查的用例。
// 覆盖三类必测点：申报值必须是正数（含兜底与最小值）、探测失败要降级、超限判断的边界（等于窗口放行）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONTEXT_WINDOW_FALLBACK,
  collectConfiguredContextWindows,
  normalizeContextLength,
  pickDeclaredContextWindow,
} from '../src/gateway/model-capacity.js';
import { resolveDeclaredContextWindow, resetContextWindowCache } from '../src/plugin/context-window.js';
import {
  buildContextOverflowMessage,
  estimateMessagesTokens,
  evaluateContextGuard,
  isContextGuardEnabled,
} from '../src/plugin/context-guard.js';
import { createModelTimAdapter } from '../src/plugin/adapter.js';
import { writeConfig } from '../src/gateway/config.js';
import { createFixedClock } from '../src/gateway/clock.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

class StubLlmAdapter {}
class StubLlmError extends Error {}

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
