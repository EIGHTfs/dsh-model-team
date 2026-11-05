// forward 双模式用例（docs/15）：模式解析 / 递归守卫 / 降级 / 等价性。
// 约定：全部用假群名与假 provider 名，不依赖本机配置；期望值由输入推导或由导出常量给出。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODE,
  MODE_FORWARD,
  MODE_REWRITE,
  VALID_MODES,
  resolveMode,
} from '../src/plugin/adapter/mode.js';
import { GROUP_MODE_FIELD, GROUP_MODES } from '../src/gateway/config/constants.js';
import { readConfig, writeConfig } from '../src/gateway/config/config.js';
import {
  FORWARD_SKIP_REASONS,
  NO_ADAPTER_CODE,
  createForwardObservation,
  forwardStream,
  isNoAdapterError,
  planForward,
  toRowUsage,
} from '../src/plugin/adapter/forward.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

// 本插件注册的 provider 路由名：用假值，避免与部署侧的 providerIds 绑定
const SELF_PROVIDER_IDS = ['test-team-provider'];
// 目标群声明的外部 provider（宿主侧路由名）：与上面不同名即"不是自己"
const EXTERNAL_PROVIDER = 'test-host-provider';

// 模式解析用的最小 logger 桩：只收 warn 文本，用来证明"非法值只告警一次"
function createWarningCollector() {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(String(message)) };
}

test('mode：显式 forward 就用 forward', () => {
  const logger = createWarningCollector();
  const mode = resolveMode({ group: { id: 'group-a', mode: MODE_FORWARD, provider: EXTERNAL_PROVIDER }, providerIds: SELF_PROVIDER_IDS, logger });
  assert.equal(mode, MODE_FORWARD);
  assert.equal(logger.warnings.length, 0, '合法值不该告警');
});

test('mode：显式 rewrite 就用 rewrite', () => {
  const logger = createWarningCollector();
  const mode = resolveMode({ group: { id: 'group-a', mode: MODE_REWRITE, provider: EXTERNAL_PROVIDER }, providerIds: SELF_PROVIDER_IDS, logger });
  assert.equal(mode, MODE_REWRITE);
  assert.equal(logger.warnings.length, 0);
});

test('mode：未声明 → 默认值（forward）', () => {
  const logger = createWarningCollector();
  const mode = resolveMode({ group: { id: 'group-a', provider: EXTERNAL_PROVIDER }, providerIds: SELF_PROVIDER_IDS, logger });
  assert.equal(mode, DEFAULT_MODE);
  assert.equal(mode, MODE_FORWARD, 'docs/15 规定默认是 forward');
  assert.equal(logger.warnings.length, 0, '未声明是合法状态，不该告警');
});

test('mode：非法值 → 告警一次并回退默认（不静默当 rewrite）', () => {
  const logger = createWarningCollector();
  const illegalValue = 'forwrad'; // 故意拼错，模拟手写配置
  const mode = resolveMode({ group: { id: 'group-a', mode: illegalValue }, providerIds: SELF_PROVIDER_IDS, logger });

  assert.equal(mode, DEFAULT_MODE);
  assert.notEqual(mode, MODE_REWRITE, '非法值不得被当成 rewrite');
  assert.equal(logger.warnings.length, 1, '一次解析只告警一次');
  assert.equal(logger.warnings[0].includes(JSON.stringify(illegalValue)), true, '告警要带上非法值本身');
  assert.equal(VALID_MODES.includes(illegalValue), false);
});

test('mode：递归守卫——目标 provider 是自己时强制 rewrite（即使显式写了 forward）', () => {
  const logger = createWarningCollector();
  const mode = resolveMode({
    group: { id: 'group-a', mode: MODE_FORWARD, provider: SELF_PROVIDER_IDS[0] },
    providerIds: SELF_PROVIDER_IDS,
    logger,
  });
  assert.equal(mode, MODE_REWRITE, '转发给自己必然打转，必须降回 rewrite');
  assert.equal(logger.warnings.length, 0, '守卫是正常判定，不是配置错误');
});

// ===== config：groups[].mode 校验（docs/15 §一）=====
// 用例只写临时目录，不碰真实数据根；断言按"剔除/保留/告警"三件事分开写。

test('config：合法 mode 原样保留（forward 与 rewrite 都算合法）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const groups = GROUP_MODES.map((modeValue, index) => ({ id: 'group-' + index, name: '群' + index, mode: modeValue }));
  await writeConfig({ groups }, { dataRoot, logger });

  const config = await readConfig({ dataRoot, logger });
  assert.deepEqual(config.groups.map((group) => group.mode), GROUP_MODES);
  assert.equal(logger.hasLine('warn', GROUP_MODE_FIELD), false, '合法值不该产生告警');
});

test('config：非法 mode 被剔除（回到"未声明"），并逐条点名告警', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const illegalValue = 'forwrad';
  await writeConfig({ groups: [{ id: 'group-a', name: '群A', mode: illegalValue }] }, { dataRoot, logger });

  const config = await readConfig({ dataRoot, logger });
  assert.equal(config.groups.length, 1, '只剔除字段，不剔除群');
  assert.equal(GROUP_MODE_FIELD in config.groups[0], false, '非法值必须被删掉而不是改成 rewrite');
  assert.equal(logger.hasLine('warn', illegalValue), true, '告警要带原值');
  assert.equal(logger.hasLine('warn', 'group-a'), true, '告警要带群 id');
});

// ===== forward.js：预检、递归守卫、原样透传 =====
// 全部用桩：不联网、不碰宿主，只验证"调没调 llmStream / 传了什么 / 块有没有被包装"。

// 计数桩：既能断言调用次数，也能按需返回固定块序列
function createLlmStreamStub(chunks) {
  const calls = [];
  const llmStream = async (options) => {
    calls.push(options);
    return (async function* emit() {
      for (const chunk of chunks || []) yield chunk;
    })();
  };
  return { calls, llmStream };
}

test('forward：递归守卫——目标 provider 是自己时判定不能转发，且绝不调用 llmStream', () => {
  const stub = createLlmStreamStub([]);
  const plan = planForward({
    target: { provider: SELF_PROVIDER_IDS[0], model: 'model-a' },
    providerIds: SELF_PROVIDER_IDS,
    deps: stub,
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.reason, FORWARD_SKIP_REASONS.SELF_PROVIDER);
  assert.equal(stub.calls.length, 0, '守卫命中时一次都不许调宿主');
});

test('forward：没有声明 host provider 时判定不能转发（不猜 provider）', () => {
  const stub = createLlmStreamStub([]);
  const plan = planForward({ target: { provider: '', model: 'model-a' }, providerIds: SELF_PROVIDER_IDS, deps: stub });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, FORWARD_SKIP_REASONS.PROVIDER_MISSING);
  assert.equal(stub.calls.length, 0);
});

test('forward：宿主没注入 llmStream 时判定不能转发', () => {
  const plan = planForward({ target: { provider: EXTERNAL_PROVIDER, model: 'model-a' }, providerIds: SELF_PROVIDER_IDS, deps: {} });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, FORWARD_SKIP_REASONS.LLM_STREAM_MISSING);
});

test('forward：只覆盖 provider/model，其余 options 原样透传；块原样 yield（不二次包装）', async () => {
  const passthroughChunk = { type: 'text-delta', index: 0, text: 'hi' };
  const usageChunk = { type: 'usage', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } };
  const finishChunk = { type: 'finish', reason: 'stop' };
  const stub = createLlmStreamStub([passthroughChunk, usageChunk, finishChunk]);

  const observation = createForwardObservation();
  const options = { messages: [{ role: 'user' }], sessionId: 'session-a', provider: 'other-provider', model: 'other-model' };
  const received = [];
  for await (const chunk of forwardStream({
    options,
    target: { provider: EXTERNAL_PROVIDER, model: 'model-a' },
    deps: stub,
    observation,
  })) {
    received.push(chunk);
  }

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].provider, EXTERNAL_PROVIDER, 'provider 必须被换成目标');
  assert.equal(stub.calls[0].model, 'model-a', 'model 必须被换成目标');
  assert.equal(stub.calls[0].sessionId, options.sessionId, '其余 options 原样透传');
  assert.deepEqual(stub.calls[0].messages, options.messages);

  assert.equal(received.length, 3);
  assert.equal(received[0], passthroughChunk, '必须是同一个对象引用（包一层就不是等价链路了）');
  assert.equal(observation.usage, usageChunk.usage, 'usage 只旁路观测');
  assert.equal(observation.finishReason, 'stop');
});

test('forward：NO_ADAPTER 识别只认该错误码', () => {
  assert.equal(isNoAdapterError({ code: NO_ADAPTER_CODE }), true);
  assert.equal(isNoAdapterError({ code: 'AUTH' }), false);
  assert.equal(isNoAdapterError(new Error('boom')), false);
  assert.equal(isNoAdapterError(null), false);
});

test('forward：宿主 TokenUsage → 请求行口径（缺 total 时用加减补，有就用原值）', () => {
  const withTotal = toRowUsage({ inputTokens: 5, outputTokens: 2, totalTokens: 6, cacheReadTokens: 4 });
  assert.deepEqual(withTotal, { promptTokens: 5, completionTokens: 2, totalTokens: 6, cacheHit: 4 });

  const withoutTotal = toRowUsage({ inputTokens: 5, outputTokens: 2 });
  assert.deepEqual(withoutTotal, { promptTokens: 5, completionTokens: 2, totalTokens: 7 });

  assert.equal(toRowUsage(null), null);
});
