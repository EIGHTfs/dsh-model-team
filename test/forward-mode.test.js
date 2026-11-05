// forward 双模式用例（docs/15）：模式解析 / 宿主自愈 / 官方库直调 / 降级时机 / 等价性。
// 约定：全部用假群名、假 provider 名与假 bundle；不碰真实宿主文件，不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
  buildRawProviders,
  loadPiAiRuntime,
  openForwardRequest,
  resetPiAiRuntimeCacheForTest,
} from '../src/plugin/adapter/forward.js';
import {
  RESOLVE_PROFILES_EXPORT_LINE,
  ensureHostExport,
  hasResolveProfilesExport,
  resetHostPatchWarningForTest,
} from '../src/plugin/host-patch.js';
import {
  BLOCK_TYPE_REASONING,
  BLOCK_TYPE_TEXT,
  BLOCK_TYPE_TOOL_CALL,
  createStreamChunkBuilder,
} from '../src/plugin/adapter/llm-protocol.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

// 模式解析用的最小 logger 桩：只收 warn 文本，用来证明"非法值只告警一次"
function createWarningCollector() {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(String(message)) };
}

// ===== 模式解析 =====

test('mode：显式 forward 就用 forward', () => {
  const logger = createWarningCollector();
  const mode = resolveMode({ group: { id: 'group-a', mode: MODE_FORWARD }, logger });
  assert.equal(mode, MODE_FORWARD);
  assert.equal(logger.warnings.length, 0, '合法值不该告警');
});

test('mode：显式 rewrite 就用 rewrite', () => {
  const logger = createWarningCollector();
  const mode = resolveMode({ group: { id: 'group-a', mode: MODE_REWRITE }, logger });
  assert.equal(mode, MODE_REWRITE);
  assert.equal(logger.warnings.length, 0);
});

test('mode：未声明 → 默认值（forward）', () => {
  const logger = createWarningCollector();
  const mode = resolveMode({ group: { id: 'group-a' }, logger });
  assert.equal(mode, DEFAULT_MODE);
  assert.equal(mode, MODE_FORWARD, 'docs/15 规定默认是 forward');
  assert.equal(logger.warnings.length, 0, '未声明是合法状态，不该告警');
});

test('mode：非法值 → 告警一次并回退默认（不静默当 rewrite）', () => {
  const logger = createWarningCollector();
  const illegalValue = 'forwrad';
  const mode = resolveMode({ group: { id: 'group-a', mode: illegalValue }, logger });

  assert.equal(mode, DEFAULT_MODE);
  assert.notEqual(mode, MODE_REWRITE, '非法值不得被当成 rewrite');
  assert.equal(logger.warnings.length, 1, '一次解析只告警一次');
  assert.equal(logger.warnings[0].includes(JSON.stringify(illegalValue)), true, '告警要带上非法值本身');
  assert.equal(VALID_MODES.includes(illegalValue), false);
});

// ===== config：groups[].mode 校验 =====

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

// ===== 宿主能力自愈（docs/15 §二点五）=====
// 全部用临时目录里的假 bundle，绝不碰真实宿主文件。

// 造一个假 bundle：模拟宿主 lib/index.js 的最小形态
async function createFakeBundle(t, { exported = false } = {}) {
  const directory = await createTempDirectory(t);
  const bundlePath = path.join(directory, 'index.mjs');
  const baseSource = 'export const name = "fake-pi-ai";\nexport function resolveProfiles() { return new Map(); }\n';
  const sourceText = exported ? `${baseSource}${RESOLVE_PROFILES_EXPORT_LINE}\n` : baseSource;
  await fs.writeFile(bundlePath, sourceText, 'utf8');
  return { bundlePath, sourceText, bundleUrl: pathToFileURL(bundlePath).href };
}

// 假导入器：断言 import 的是同一个 bundle（允许带缓存穿透参数），并按需给出 resolveProfiles
function createBundleImporter(bundleUrl, { exposeResolveProfiles = true } = {}) {
  return async (specifier) => {
    assert.equal(specifier.startsWith(bundleUrl), true, '必须 import 同一个 bundle');
    return exposeResolveProfiles ? { resolveProfiles: () => new Map() } : {};
  };
}

test('host-patch：文件里已有导出 → 什么都不做，也不需要还原', async (t) => {
  resetHostPatchWarningForTest();
  const fixture = await createFakeBundle(t, { exported: true });
  const logger = createRecordingLogger();

  const result = await ensureHostExport({
    logger,
    resolveUrl: () => fixture.bundleUrl,
    importModule: createBundleImporter(fixture.bundleUrl),
  });

  assert.equal(result.patched, false);
  assert.equal(result.reason, 'already-exported');
  assert.equal(await fs.readFile(fixture.bundlePath, 'utf8'), fixture.sourceText, '文件一个字节都不该变');
  await result.restore(); // 没补过：restore 必须是空操作
  assert.equal(await fs.readFile(fixture.bundlePath, 'utf8'), fixture.sourceText);
});

test('host-patch：未导出 → 末尾补一行并验证通过；restore 后逐字节还原', async (t) => {
  resetHostPatchWarningForTest();
  const fixture = await createFakeBundle(t, { exported: false });
  const logger = createRecordingLogger();

  const result = await ensureHostExport({
    logger,
    resolveUrl: () => fixture.bundleUrl,
    importModule: createBundleImporter(fixture.bundleUrl),
  });

  assert.equal(result.patched, true);
  const patchedText = await fs.readFile(fixture.bundlePath, 'utf8');
  assert.equal(patchedText.endsWith(`${RESOLVE_PROFILES_EXPORT_LINE}\n`), true, '只在末尾追加导出行');
  assert.equal(hasResolveProfilesExport(patchedText), true);

  await result.restore();
  assert.equal(await fs.readFile(fixture.bundlePath, 'utf8'), fixture.sourceText, '还原必须逐字节回到原文');
});

test('host-patch：验证不通过 → 回滚原文并只 warn', async (t) => {
  resetHostPatchWarningForTest();
  const fixture = await createFakeBundle(t, { exported: false });
  const logger = createRecordingLogger();

  const result = await ensureHostExport({
    logger,
    resolveUrl: () => fixture.bundleUrl,
    // 导入成功但没给出 resolveProfiles：触发"验证失败"分支
    importModule: createBundleImporter(fixture.bundleUrl, { exposeResolveProfiles: false }),
  });

  assert.equal(result.patched, false);
  assert.equal(result.reason, 'verify-failed');
  assert.equal(await fs.readFile(fixture.bundlePath, 'utf8'), fixture.sourceText, '验证失败必须回滚');
  assert.equal(logger.hasLine('warn', '回滚'), true);
});

test('host-patch：dispose 时内容被别人改过 → 不还原，只 warn', async (t) => {
  resetHostPatchWarningForTest();
  const fixture = await createFakeBundle(t, { exported: false });
  const logger = createRecordingLogger();

  const result = await ensureHostExport({
    logger,
    resolveUrl: () => fixture.bundleUrl,
    importModule: createBundleImporter(fixture.bundleUrl),
  });
  assert.equal(result.patched, true);

  // 模拟宿主升级：文件被整体替换
  const upgradedText = 'export const name = "fake-pi-ai-v2";\n';
  await fs.writeFile(fixture.bundlePath, upgradedText, 'utf8');

  await result.restore();
  assert.equal(await fs.readFile(fixture.bundlePath, 'utf8'), upgradedText, '别人的新文件不许被我们覆盖');
  assert.equal(logger.hasLine('warn', '已被改动'), true);
});

test('host-patch：文件不可写 → warn 一次且不抛错', async (t) => {
  resetHostPatchWarningForTest();
  const fixture = await createFakeBundle(t, { exported: false });
  const logger = createRecordingLogger();
  const permissionError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

  const result = await ensureHostExport({
    logger,
    resolveUrl: () => fixture.bundleUrl,
    writeFile: async () => { throw permissionError; },
    importModule: createBundleImporter(fixture.bundleUrl),
  });

  assert.equal(result.patched, false);
  assert.equal(result.reason, 'write-failed');
  assert.equal(logger.hasLine('warn', 'EACCES'), true, '告警要带原因原文');
  assert.equal(await fs.readFile(fixture.bundlePath, 'utf8'), fixture.sourceText, '写失败时文件保持原样');
});

// ===== 官方库探测与转发编排 =====

const FORWARD_GROUP_ID = 'group-forward';
const REWRITE_GROUP_ID = 'group-rewrite';
const STUB_BASE_URL = 'http://stub.invalid/v1';

function buildGroup(overrides) {
  return Object.assign({
    id: FORWARD_GROUP_ID,
    name: '假群',
    mode: MODE_FORWARD,
    baseURL: STUB_BASE_URL,
  }, overrides);
}

// 假运行时：形状与官方包一致（PiAiAdapter / resolveProfiles / InMemoryCredentialStore）
function createFakeRuntime({ chunks, error } = {}) {
  const calls = [];
  class FakeAdapter {
    constructor(options) {
      this.options = options;
    }

    stream(streamOptions) {
      calls.push({ constructorOptions: this.options, streamOptions });
      return (async function* emit() {
        for (const chunk of chunks ?? []) yield chunk;
        if (error) throw error;
      })();
    }
  }
  return {
    calls,
    runtime: {
      ok: true,
      dshPiAi: {
        PiAiAdapter: FakeAdapter,
        // 与官方同形：入参是原始 providers 对象，返回 Map
        resolveProfiles: (rawProviders) => new Map(Object.entries(rawProviders)),
      },
      piAi: { InMemoryCredentialStore: class FakeCredentialStore {} },
    },
  };
}

function buildOpenParams({ group, target, runtime, recordRow, logger, credential }) {
  return {
    options: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], sessionId: 'session-a' },
    config: { groups: [group] },
    sessionId: 'session-a',
    startedAtMs: 0,
    logger: logger || createRecordingLogger(),
    deps: {},
    resolveTarget: async () => ({ target, source: 'explicit' }),
    resolveCredential: async () => credential ?? { ok: true, credentials: { apiKey: 'sk-test' } },
    runtime,
    recordRow: recordRow || (async () => {}),
  };
}

test('forward：官方运行时探测——import 失败 / 缺 resolveProfiles 都判不可用', async () => {
  resetPiAiRuntimeCacheForTest();
  const importFailed = await loadPiAiRuntime({
    importer: async () => { throw new Error('cannot find module'); },
  });
  assert.equal(importFailed.ok, false);
  assert.equal(importFailed.reason, FORWARD_SKIP_REASONS.RUNTIME_IMPORT_FAILED);

  resetPiAiRuntimeCacheForTest();
  const incomplete = await loadPiAiRuntime({
    // 宿主版本没导出 resolveProfiles：只有 PiAiAdapter
    importer: async () => ({ PiAiAdapter: class {} }),
  });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.reason, FORWARD_SKIP_REASONS.RUNTIME_INCOMPLETE);
  resetPiAiRuntimeCacheForTest();
});

test('forward：群配置 → 官方 resolveProfiles 的原始入参形状', () => {
  const rawProviders = buildRawProviders({ group: buildGroup(), model: 'model-a' });
  assert.deepEqual(Object.keys(rawProviders), [FORWARD_GROUP_ID]);
  assert.equal(rawProviders[FORWARD_GROUP_ID].api, 'openai-completions');
  assert.equal(rawProviders[FORWARD_GROUP_ID].baseURL, STUB_BASE_URL);
  assert.deepEqual(rawProviders[FORWARD_GROUP_ID].models, [{ id: 'model-a' }]);
});

test('forward：显式 rewrite 的群不构造官方适配器', async () => {
  const fake = createFakeRuntime({ chunks: [] });
  const request = await openForwardRequest(buildOpenParams({
    group: buildGroup({ id: REWRITE_GROUP_ID, mode: MODE_REWRITE }),
    target: { type: 'model', id: 'model-a', platformId: REWRITE_GROUP_ID },
    runtime: fake.runtime,
  }));
  assert.equal(request, null);
  assert.equal(fake.calls.length, 0);
});

test('forward：运行时不可用 → 降级 rewrite，且只 warn 一次', async () => {
  const logger = createRecordingLogger();
  const unavailableRuntime = { ok: false, reason: FORWARD_SKIP_REASONS.RUNTIME_INCOMPLETE };
  const params = buildOpenParams({
    group: buildGroup(),
    target: { type: 'model', id: 'model-a', platformId: FORWARD_GROUP_ID },
    runtime: unavailableRuntime,
    logger,
  });

  assert.equal(await openForwardRequest(params), null);
  assert.equal(await openForwardRequest(params), null);
  const warnLines = logger.lines.filter((line) => line.level === 'warn' && line.message.includes('不可用'));
  assert.equal(warnLines.length, 1, '不可用只告警一次，不能每请求刷屏');
});

test('forward：首块前抛错 → 同一次调用内降级（返回 null），不重发', async () => {
  const firstChunkError = Object.assign(new Error('boom before first chunk'), { code: 'NO_ADAPTER' });
  const fake = createFakeRuntime({ chunks: [], error: firstChunkError });
  const logger = createRecordingLogger();

  const request = await openForwardRequest(buildOpenParams({
    group: buildGroup(),
    target: { type: 'model', id: 'model-a', platformId: FORWARD_GROUP_ID },
    runtime: fake.runtime,
    logger,
  }));

  assert.equal(request, null, '首块前失败允许降级');
  assert.equal(fake.calls.length, 1, '降级前只尝试一次');
  assert.equal(logger.lines.some((line) => line.message.includes('首块前失败')), true, '要 warn 含原文');
});

test('forward：首块后抛错 → 原样抛出，已出块保留，不重发', async () => {
  const firstChunk = { type: 'text-delta', index: 0, text: 'partial' };
  const lateError = new Error('stream broke mid-way');
  const fake = createFakeRuntime({ chunks: [firstChunk], error: lateError });

  const request = await openForwardRequest(buildOpenParams({
    group: buildGroup(),
    target: { type: 'model', id: 'model-a', platformId: FORWARD_GROUP_ID },
    runtime: fake.runtime,
  }));
  assert.notEqual(request, null, '首块已拿到，说明已进入转发');

  const received = [];
  await assert.rejects(async () => {
    for await (const chunk of request.chunks) received.push(chunk);
  }, /stream broke mid-way/);
  assert.deepEqual(received, [firstChunk]);
  assert.equal(fake.calls.length, 1, '不许为降级再发一次');
});

// ===== 等价性对拍（docs/15 §五）：六项投影逐项一致 =====

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
const TOOL_ARGUMENTS_FIRST = '{"city":';
const TOOL_ARGUMENTS_SECOND = '"北京"}';

test('等价性：思考 + 正文 + 工具调用 + 块边界 + usage + 完成原因，两模式六项一致', async () => {
  const reasoningText = '想';
  const answerText = '你好';
  const rowUsage = { promptTokens: 5, completionTokens: 2 };

  // rewrite 侧：上游 OpenAI 分片 → 本插件的块构建器
  const builder = createStreamChunkBuilder();
  const openAiPayloads = [
    { choices: [{ delta: { reasoning_content: reasoningText } }] },
    { choices: [{ delta: { content: answerText } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'lookup', arguments: TOOL_ARGUMENTS_FIRST } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: TOOL_ARGUMENTS_SECOND } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const rewriteChunks = [];
  for (const openAiPayload of openAiPayloads) rewriteChunks.push(...builder.appendOpenAiChunk(openAiPayload));
  rewriteChunks.push(...builder.finish({ finishReason: 'tool_calls', usage: rowUsage }));

  // forward 侧：官方库会给出的块（按 StreamChunk 契约独立手工构造，不抄 rewrite 的输出）
  const hostChunks = [
    { type: 'block-start', index: 0, blockType: BLOCK_TYPE_REASONING },
    { type: 'reasoning-delta', index: 0, text: reasoningText },
    { type: 'block-start', index: 1, blockType: BLOCK_TYPE_TEXT },
    { type: 'text-delta', index: 1, text: answerText },
    { type: 'block-start', index: 2, blockType: BLOCK_TYPE_TOOL_CALL },
    { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'lookup', argumentsDelta: TOOL_ARGUMENTS_FIRST },
    { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'lookup', argumentsDelta: TOOL_ARGUMENTS_SECOND },
    { type: 'block-end', index: 0, block: { type: BLOCK_TYPE_REASONING, text: reasoningText } },
    { type: 'block-end', index: 1, block: { type: BLOCK_TYPE_TEXT, text: answerText } },
    {
      type: 'block-end',
      index: 2,
      block: {
        type: BLOCK_TYPE_TOOL_CALL,
        id: 'call-1',
        name: 'lookup',
        arguments: TOOL_ARGUMENTS_FIRST + TOOL_ARGUMENTS_SECOND,
      },
    },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, cacheReadTokens: 0 } },
    { type: 'finish', reason: { kind: FINISH_KIND_TOOL_CALLS } },
  ];

  const fake = createFakeRuntime({ chunks: hostChunks });
  const request = await openForwardRequest(buildOpenParams({
    group: buildGroup(),
    target: { type: 'model', id: 'model-a', platformId: FORWARD_GROUP_ID },
    runtime: fake.runtime,
  }));
  const forwardChunks = [];
  for await (const chunk of request.chunks) forwardChunks.push(chunk);

  assert.deepEqual(projectChunks(forwardChunks), projectChunks(rewriteChunks), '六项投影必须逐项一致');
  // 顺带钉住调用形状：provider 用群 id、model 用真实模型、其余 options 原样透传
  assert.equal(fake.calls[0].streamOptions.provider, FORWARD_GROUP_ID);
  assert.equal(fake.calls[0].streamOptions.model, 'model-a');
  assert.equal(fake.calls[0].streamOptions.sessionId, 'session-a');
});

test('等价性：错误口径——forward 原样透传官方库错误，rewrite 才做状态码归类（设计差异）', async () => {
  const officialError = Object.assign(new Error('official exploded'), { code: 'RATE_LIMIT' });
  const fake = createFakeRuntime({ chunks: [{ type: 'text-delta', index: 0, text: 'x' }], error: officialError });

  const request = await openForwardRequest(buildOpenParams({
    group: buildGroup(),
    target: { type: 'model', id: 'model-a', platformId: FORWARD_GROUP_ID },
    runtime: fake.runtime,
  }));

  await assert.rejects(async () => {
    for await (const chunk of request.chunks) void chunk;
  }, (error) => {
    assert.equal(error, officialError, 'forward 必须原样抛出官方库的错误对象');
    return true;
  });
});
