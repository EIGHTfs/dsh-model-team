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
  openForwardRequest,
  planForward,
  toRowUsage,
} from '../src/plugin/adapter/forward.js';
import {
  BLOCK_TYPE_REASONING,
  BLOCK_TYPE_TEXT,
  BLOCK_TYPE_TOOL_CALL,
  classifyUpstreamFailure,
  createStreamChunkBuilder,
} from '../src/plugin/adapter/llm-protocol.js';
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

// ===== openForwardRequest：分流、降级时机、请求行 =====
// 这些用例直接驱动编排函数，不经过 dsh 的适配器生命周期，因此只依赖两个桩：
// resolveTarget（会话 → 目标）与 deps.llmStream（宿主出口）。

const FORWARD_TARGET_GROUP_ID = 'group-forward';
const REWRITE_TARGET_GROUP_ID = 'group-rewrite';

function buildForwardGroup(overrides) {
  return Object.assign({
    id: FORWARD_TARGET_GROUP_ID,
    name: '假群',
    provider: EXTERNAL_PROVIDER,
    mode: MODE_FORWARD,
  }, overrides);
}

function buildOpenParams({ group, target, llmStream, recordRow }) {
  return {
    options: { messages: [{ role: 'user' }], sessionId: 'session-a' },
    config: { groups: [group] },
    sessionId: 'session-a',
    startedAtMs: 0,
    providerIds: SELF_PROVIDER_IDS,
    logger: createRecordingLogger(),
    deps: { llmStream },
    resolveTarget: async () => ({ target, source: 'explicit' }),
    recordRow: recordRow || (async () => {}),
  };
}

test('forward 分流：群声明了 provider 且 mode=forward → 走转发并原样出块', async () => {
  const chunk = { type: 'text-delta', index: 0, text: 'hello' };
  const stub = createLlmStreamStub([chunk]);
  const rowInputs = [];
  const params = buildOpenParams({
    group: buildForwardGroup(),
    target: { type: 'model', id: 'model-a', platformId: FORWARD_TARGET_GROUP_ID },
    llmStream: stub.llmStream,
    recordRow: async (rowInput) => rowInputs.push(rowInput),
  });

  const request = await openForwardRequest(params);
  assert.notEqual(request, null, '应判定可以转发');
  const received = [];
  for await (const item of request.chunks) received.push(item);

  assert.equal(stub.calls.length, 1, '只允许调一次宿主出口');
  assert.equal(stub.calls[0].provider, EXTERNAL_PROVIDER);
  assert.equal(stub.calls[0].model, 'model-a');
  assert.equal(received[0], chunk, '块必须原样透出');
  assert.equal(rowInputs.length, 1, '完成后记一行');
  assert.equal(rowInputs[0].upstreamStatus, 200);
});

test('forward 分流：群显式 rewrite → 不转发（null），且一次都不调宿主出口', async () => {
  const stub = createLlmStreamStub([]);
  const request = await openForwardRequest(buildOpenParams({
    group: buildForwardGroup({ id: REWRITE_TARGET_GROUP_ID, mode: MODE_REWRITE }),
    target: { type: 'model', id: 'model-a', platformId: REWRITE_TARGET_GROUP_ID },
    llmStream: stub.llmStream,
  }));

  assert.equal(request, null);
  assert.equal(stub.calls.length, 0);
});

test('forward 分流：分组轮换目标（非单模型）不转发', async () => {
  const stub = createLlmStreamStub([]);
  const request = await openForwardRequest(buildOpenParams({
    group: buildForwardGroup(),
    target: { type: 'group', id: 'friend-group-a' },
    llmStream: stub.llmStream,
  }));

  assert.equal(request, null);
  assert.equal(stub.calls.length, 0);
});

test('forward 降级：首个 chunk 之前抛 NO_ADAPTER → 返回 null（改为 rewrite），只尝试一次', async () => {
  const calls = [];
  const llmStream = async (streamOptions) => {
    calls.push(streamOptions);
    const noAdapterError = new Error('no adapter registered');
    noAdapterError.code = NO_ADAPTER_CODE;
    throw noAdapterError;
  };

  const request = await openForwardRequest(buildOpenParams({
    group: buildForwardGroup(),
    target: { type: 'model', id: 'model-a', platformId: FORWARD_TARGET_GROUP_ID },
    llmStream,
  }));

  assert.equal(request, null, '首块前失败才允许降级');
  assert.equal(calls.length, 1, '降级前只尝试一次，不重试');
});

test('forward 不可降级：首块之后抛 NO_ADAPTER → 原样抛出，不重发', async () => {
  const firstChunk = { type: 'text-delta', index: 0, text: 'partial' };
  const calls = [];
  const llmStream = async (streamOptions) => {
    calls.push(streamOptions);
    return (async function* emit() {
      yield firstChunk;
      const noAdapterError = new Error('adapter vanished mid-stream');
      noAdapterError.code = NO_ADAPTER_CODE;
      throw noAdapterError;
    })();
  };

  const request = await openForwardRequest(buildOpenParams({
    group: buildForwardGroup(),
    target: { type: 'model', id: 'model-a', platformId: FORWARD_TARGET_GROUP_ID },
    llmStream,
  }));
  assert.notEqual(request, null, '首块已拿到，说明已进入转发');

  const received = [];
  await assert.rejects(async () => {
    for await (const item of request.chunks) received.push(item);
  }, /adapter vanished mid-stream/);
  assert.deepEqual(received, [firstChunk], '已吐出的块照常交付，且不再重发');
  assert.equal(calls.length, 1, '不许为降级再发一次');
});

// ===== 等价性对拍（docs/15 §六）：同一份内容，两条路径交给 dsh 的可观测结果必须一致 =====

// 只保留"下游真正能观察到"的部分：正文、思考、工具调用序列、块边界、usage、完成原因
function projectChunks(chunks) {
  const joinDeltas = (type) => chunks.filter((chunk) => chunk.type === type).map((chunk) => chunk.text).join('');
  const toolCalls = chunks
    .filter((chunk) => chunk.type === 'tool-call-delta')
    .map((chunk) => ({ id: chunk.id ?? null, name: chunk.name ?? null, argumentsDelta: chunk.argumentsDelta }));
  const blockEnds = chunks
    .filter((chunk) => chunk.type === 'block-end')
    .map((chunk) => ({ index: chunk.index, type: chunk.block?.type }));
  const usageChunk = chunks.filter((chunk) => chunk.type === 'usage').pop() ?? null;
  const finishChunk = chunks.filter((chunk) => chunk.type === 'finish').pop() ?? null;
  return {
    reasoning: joinDeltas('reasoning-delta'),
    text: joinDeltas('text-delta'),
    toolCalls,
    blockEnds,
    usage: usageChunk ? usageChunk.usage : null,
    finishKind: finishChunk ? finishChunk.reason?.kind ?? null : null,
  };
}

const FINISH_KIND_TOOL_CALLS = 'tool-calls';
const REWRITE_TOOL_ARGUMENTS_FIRST = '{"city":';
const REWRITE_TOOL_ARGUMENTS_SECOND = '"北京"}';

test('等价性：思考 + 正文 + 工具调用 + usage + 完成原因，两模式投影逐项一致', async () => {
  const reasoningText = '想';
  const answerText = '你好';
  // 块构建器的 usage 入参是**请求行口径**（promptTokens/completionTokens），不是 OpenAI 原始字段名
  const openAiUsage = { promptTokens: 5, completionTokens: 2 };

  // rewrite 侧：上游 OpenAI 分片 → 本插件的块构建器（这就是 rewrite 链路真正做的事）
  const builder = createStreamChunkBuilder();
  const openAiPayloads = [
    { choices: [{ delta: { reasoning_content: reasoningText } }] },
    { choices: [{ delta: { content: answerText } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'lookup', arguments: REWRITE_TOOL_ARGUMENTS_FIRST } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: REWRITE_TOOL_ARGUMENTS_SECOND } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const rewriteChunks = [];
  for (const openAiPayload of openAiPayloads) {
    rewriteChunks.push(...builder.appendOpenAiChunk(openAiPayload));
  }
  rewriteChunks.push(...builder.finish({ finishReason: 'tool_calls', usage: openAiUsage }));

  // forward 侧：宿主 pi-ai 会给出的块。按 dsh 契约**独立手工构造**（不是把 rewrite 的输出抄一遍），
  // 否则这组对拍就成了自证。字段名与顺序都按 StreamChunk 类型定义写。
  const hostChunks = [
    { type: 'block-start', index: 0, blockType: BLOCK_TYPE_REASONING },
    { type: 'reasoning-delta', index: 0, text: reasoningText },
    { type: 'block-start', index: 1, blockType: BLOCK_TYPE_TEXT },
    { type: 'text-delta', index: 1, text: answerText },
    { type: 'block-start', index: 2, blockType: BLOCK_TYPE_TOOL_CALL },
    { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'lookup', argumentsDelta: REWRITE_TOOL_ARGUMENTS_FIRST },
    // 续块的 id/name 与首块一致（StreamChunk 契约里 id 必填、name 可选；这里给全，避免把"可选"当差异）
    { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'lookup', argumentsDelta: REWRITE_TOOL_ARGUMENTS_SECOND },
    { type: 'block-end', index: 0, block: { type: BLOCK_TYPE_REASONING, text: reasoningText } },
    { type: 'block-end', index: 1, block: { type: BLOCK_TYPE_TEXT, text: answerText } },
    {
      type: 'block-end',
      index: 2,
      block: {
        type: BLOCK_TYPE_TOOL_CALL,
        id: 'call-1',
        name: 'lookup',
        arguments: REWRITE_TOOL_ARGUMENTS_FIRST + REWRITE_TOOL_ARGUMENTS_SECOND,
      },
    },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, cacheReadTokens: 0 } },
    { type: 'finish', reason: { kind: FINISH_KIND_TOOL_CALLS } },
  ];

  const stub = createLlmStreamStub(hostChunks);
  const forwardChunks = [];
  for await (const chunk of forwardStream({
    options: {},
    target: { provider: EXTERNAL_PROVIDER, model: 'model-a' },
    deps: stub,
    observation: createForwardObservation(),
  })) {
    forwardChunks.push(chunk);
  }

  assert.deepEqual(projectChunks(forwardChunks), projectChunks(rewriteChunks), '两条路径的下游可观测结果必须等价');
});

test('等价性：错误口径——forward 原样透传宿主错误，rewrite 才做状态码归类（设计差异，不是回归）', async () => {
  const hostError = Object.assign(new Error('host exploded'), { code: 'RATE_LIMIT' });
  const stub = {
    calls: [],
    llmStream: async (streamOptions) => {
      stub.calls.push(streamOptions);
      throw hostError;
    },
  };

  await assert.rejects(async () => {
    for await (const chunk of forwardStream({
      options: {},
      target: { provider: EXTERNAL_PROVIDER, model: 'model-a' },
      deps: stub,
      observation: createForwardObservation(),
    })) {
      void chunk;
    }
  }, (error) => {
    assert.equal(error, hostError, 'forward 必须原样抛出宿主错误对象（不改文案、不换码）');
    return true;
  });

  // 对照：rewrite 侧的错误码来自状态码归类，两者本来就不同口径
  assert.equal(classifyUpstreamFailure(429), hostError.code, '这一组恰好同名，但分类逻辑属于 rewrite');
  assert.equal(classifyUpstreamFailure(500), 'UPSTREAM_ERROR');
});
