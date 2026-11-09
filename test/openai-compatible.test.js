// 内置配置型驱动用例：用本地 stub 上游验证鉴权头、模型列表、字段改写、usage 解析与各类失败分支。
// 全程零外网、零真实 Key：假 Key 固定为 test-key-not-real，端口由 stub 随机分配。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AUTH_HEADER_NAME,
  chatCompletions,
  extractUsage,
  fetchModels,
  fetchSummary,
  readFieldByPath,
  renderSummaryTemplate,
  validateAuth,
} from '../src/gateway/drivers/openai-compatible.js';
import { resolveDefaultUserAgent } from '../src/gateway/config/constants.js';
import { createRecordingLogger } from './helpers/test-environment.js';
import { startStubUpstream, writeJson } from './helpers/stub-upstream.js';

// 假凭证：仅用于断言请求头，无法访问任何真实平台
const FAKE_API_KEY = 'test-key-not-real';

// 群配置骨架：各用例只覆盖自己关心的字段
function buildGroup(overrides = {}) {
  return {
    id: 'agnes',
    name: 'agnes(本机)',
    accessMode: 'official',
    driver: 'openai-compatible',
    baseURL: 'http://127.0.0.1:9/v1',
    auth: { type: 'bearer', header: DEFAULT_AUTH_HEADER_NAME, apiKeyRef: 'env:AGNES_API_KEY' },
    models: { endpoint: '/models' },
    request: {},
    response: { usagePath: 'usage' },
    ...overrides,
  };
}

// 组装 DriverContext：凭证在这里"已解引用好"，驱动不关心 env:/file: 细节
function buildContext(group, extraContext = {}) {
  return {
    group,
    credentials: { apiKey: FAKE_API_KEY },
    logger: createRecordingLogger(),
    fetchImpl: globalThis.fetch,
    ...extraContext,
  };
}

test('fetchModels：GET <baseURL>/models，带 Bearer 头，返回 { id, name } 列表', async (t) => {
  const stub = await startStubUpstream({
    routes: {
      'GET /v1/models': ({ outgoingResponse }) =>
        writeJson(outgoingResponse, 200, {
          data: [{ id: 'agnes-3.0-flash', name: 'Agnes 3.0 Flash' }, { id: 'agnes-2.5-flash' }],
        }),
    },
  });
  t.after(() => stub.close());

  const models = await fetchModels(buildContext(buildGroup({ baseURL: stub.baseURL })));

  assert.deepEqual(models, [
    { id: 'agnes-3.0-flash', name: 'Agnes 3.0 Flash' },
    { id: 'agnes-2.5-flash', name: 'agnes-2.5-flash' },
  ]);
  assert.equal(stub.requests.length, 1);
  assert.equal(stub.requests[0].method, 'GET');
  assert.equal(stub.requests[0].pathname, '/v1/models');
  assert.equal(stub.requests[0].headers.authorization, `Bearer ${FAKE_API_KEY}`);
});

test('fetchModels：配置了 models.static 时不发任何请求', async (t) => {
  const stub = await startStubUpstream({ routes: {} });
  t.after(() => stub.close());
  const group = buildGroup({ baseURL: stub.baseURL, models: { static: ['model-a', { id: 'model-b', name: '模型 B' }] } });

  const models = await fetchModels(buildContext(group));

  assert.deepEqual(models, [
    { id: 'model-a', name: 'model-a' },
    { id: 'model-b', name: '模型 B' },
  ]);
  assert.equal(stub.requests.length, 0);
});

test('fetchModels：上游异常时抛带 code/status 的错误（由网关捕获记录）', async (t) => {
  const stub = await startStubUpstream({
    routes: { 'GET /v1/models': ({ outgoingResponse }) => writeJson(outgoingResponse, 500, { error: 'boom' }) },
  });
  t.after(() => stub.close());

  await assert.rejects(
    () => fetchModels(buildContext(buildGroup({ baseURL: stub.baseURL }))),
    (driverError) => {
      assert.equal(driverError.code, 'UPSTREAM_HTTP_ERROR');
      assert.equal(driverError.status, 500);
      return true;
    },
  );
});

test('chatCompletions：转发 body、原样返回响应并解析 usage', async (t) => {
  const upstreamBody = {
    id: 'chatcmpl-demo',
    choices: [{ index: 0, message: { role: 'assistant', content: '你好' } }],
    usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46, prompt_tokens_details: { cached_tokens: 8 } },
  };
  const stub = await startStubUpstream({
    routes: { 'POST /v1/chat/completions': ({ outgoingResponse }) => writeJson(outgoingResponse, 200, upstreamBody) },
  });
  t.after(() => stub.close());
  const group = buildGroup({ baseURL: stub.baseURL, request: { extraHeaders: { 'x-platform': 'demo' } } });
  const requestBody = { model: 'agnes-3.0-flash', messages: [{ role: 'user', content: 'hi' }] };

  const result = await chatCompletions(buildContext(group), requestBody);

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.response, upstreamBody);
  assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 34, totalTokens: 46, cacheHit: 8 });

  const upstreamRequest = stub.requests[0];
  assert.equal(upstreamRequest.method, 'POST');
  assert.equal(upstreamRequest.pathname, '/v1/chat/completions');
  assert.equal(upstreamRequest.headers.authorization, `Bearer ${FAKE_API_KEY}`);
  assert.equal(upstreamRequest.headers['x-platform'], 'demo');
  assert.deepEqual(JSON.parse(upstreamRequest.bodyText), requestBody);
});

test('chatCompletions：request.modelField 可把模型字段改写到嵌套路径', async (t) => {
  const stub = await startStubUpstream({
    routes: { 'POST /v1/chat/completions': ({ outgoingResponse }) => writeJson(outgoingResponse, 200, { ok: true }) },
  });
  t.after(() => stub.close());
  const group = buildGroup({ baseURL: stub.baseURL, request: { modelField: 'parameters.model' } });

  await chatCompletions(buildContext(group), { model: 'agnes-2.5-flash', messages: [] });

  const forwardedBody = JSON.parse(stub.requests[0].bodyText);
  assert.equal(forwardedBody.parameters.model, 'agnes-2.5-flash');
  assert.equal('model' in forwardedBody, false, '改写到嵌套路径后不应再保留顶层 model');
});

test('chatCompletions：上游非 2xx 时带回原响应与状态码，不抛异常', async (t) => {
  const upstreamBody = { error: { message: 'invalid api key', type: 'auth_error' } };
  const stub = await startStubUpstream({
    routes: { 'POST /v1/chat/completions': ({ outgoingResponse }) => writeJson(outgoingResponse, 401, upstreamBody) },
  });
  t.after(() => stub.close());

  const result = await chatCompletions(buildContext(buildGroup({ baseURL: stub.baseURL })), { model: 'm', messages: [] });

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.deepEqual(result.response, upstreamBody);
  assert.equal(result.error.code, 'UPSTREAM_HTTP_ERROR');
  assert.equal(result.usage, null);
});

test('chatCompletions：缺凭证时直接返回错误，绝不发无 Key 请求', async (t) => {
  const stub = await startStubUpstream({ routes: {} });
  t.after(() => stub.close());
  const contextWithoutCredentials = buildContext(buildGroup({ baseURL: stub.baseURL }), { credentials: {} });

  const result = await chatCompletions(contextWithoutCredentials, { model: 'm', messages: [] });

  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.error.code, 'MISSING_CREDENTIAL');
  assert.equal(stub.requests.length, 0);
});

test('chatCompletions：baseURL 非法与网络不可达都收敛成结构化失败', async (t) => {
  const invalidUrlResult = await chatCompletions(buildContext(buildGroup({ baseURL: 'not-a-url' })), { model: 'm' });
  assert.equal(invalidUrlResult.error.code, 'INVALID_BASE_URL');

  const unreachableStub = await startStubUpstream({ routes: {} });
  const unreachableBaseUrl = unreachableStub.baseURL;
  await unreachableStub.close();
  const unreachableResult = await chatCompletions(buildContext(buildGroup({ baseURL: unreachableBaseUrl })), { model: 'm' });

  assert.equal(unreachableResult.ok, false);
  assert.equal(unreachableResult.error.code, 'UPSTREAM_REQUEST_FAILED');
});

test('validateAuth：模型列表可取即 true，鉴权失败 false 且不抛', async (t) => {
  const healthyStub = await startStubUpstream({
    routes: { 'GET /v1/models': ({ outgoingResponse }) => writeJson(outgoingResponse, 200, { data: [{ id: 'agnes-3.0-flash' }] }) },
  });
  const rejectedStub = await startStubUpstream({
    routes: { 'GET /v1/models': ({ outgoingResponse }) => writeJson(outgoingResponse, 401, { error: 'unauthorized' }) },
  });
  t.after(async () => {
    await healthyStub.close();
    await rejectedStub.close();
  });

  assert.equal(await validateAuth(buildContext(buildGroup({ baseURL: healthyStub.baseURL }))), true);
  assert.equal(await validateAuth(buildContext(buildGroup({ baseURL: rejectedStub.baseURL }))), false);
});

test('extractUsage：支持嵌套 usagePath、驼峰字段与"无 usage"降级', () => {
  assert.deepEqual(extractUsage({ meta: { usage: { promptTokens: 1, completionTokens: 2 } } }, 'meta.usage'), {
    promptTokens: 1,
    completionTokens: 2,
    totalTokens: 3,
  });
  assert.equal(extractUsage({ choices: [] }), null);
  assert.deepEqual(extractUsage({ usage: { completion_tokens: 5 } }), {
    promptTokens: null,
    completionTokens: 5,
    totalTokens: null,
  });
});

test('摘要模板：变量缺失降级为 —，不抛错（INV-08）', async () => {
  assert.equal(renderSummaryTemplate('模型 {modelCount} 个 · 接入 {accessMode}', { accessMode: 'official' }), '模型 — 个 · 接入 official');
  assert.equal(renderSummaryTemplate('', {}), '');

  const group = buildGroup({ summary: { template: '模型 {modelCount} 个', source: null }, models: { static: ['a', 'b'] } });
  assert.equal(await fetchSummary(buildContext(group)), '模型 2 个');
});

test('readFieldByPath：路径中间不是对象时返回 undefined', () => {
  assert.equal(readFieldByPath({ a: 'text' }, 'a.b'), undefined);
  assert.equal(readFieldByPath(null, 'a'), undefined);
  assert.equal(readFieldByPath({ a: { b: 3 } }, 'a.b'), 3);
});

// ---------------------------------------------------------------- G-ua：出站默认 User-Agent
// 背景：undici 缺 UA 时会发字面量 `node`，上游无法把「正规客户端」与「滥用脚本」区分开。
// 这里走真实 stub 上游抓请求头，断的是**真正发出去的字节**，不是拼装函数的返回值。

test('G-ua-①：默认请求带 dsh-model-team/<version>，且不是字面量 node', async (t) => {
  const stub = await startStubUpstream({
    routes: {
      'POST /v1/chat/completions': ({ outgoingResponse }) =>
        writeJson(outgoingResponse, 200, {
          id: 'chatcmpl-ua',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
    },
  });
  t.after(() => stub.close());

  await chatCompletions(buildContext(buildGroup({ baseURL: stub.baseURL })), {
    model: 'agnes-2.5-flash',
    messages: [{ role: 'user', content: 'hi' }],
  });

  const sentUserAgent = stub.requests[0].headers['user-agent'];
  assert.match(sentUserAgent, /^dsh-model-team\/\d+\.\d+\.\d+/, `实际 UA：${sentUserAgent}`);
  assert.notEqual(sentUserAgent, 'node', 'undici 的裸 node 默认值必须被覆盖');
});

// B12 / docs/23 O-1：UA 由谁决定，取决于出站走哪条传输。
// 同一条用例按开关断言两种行为（不写两个文件，避免"两份真相"):
//   · 默认（自持客户端，服务 rewrite 模式）：UA 强制 = dsh-model-team/<version>，extraHeaders 覆盖无效
//   · DSH_MODEL_TEAM_USE_HOST_FETCH=1（永久开关，宿主 fetch 路径）：保留旧行为，extraHeaders 可覆盖
// 注意：forward 模式（默认）由宿主官方适配器出站，UA 是宿主的，与本用例无关。
test('B12：UA 归属按传输路径断言（默认强制 / 开关=1 可覆盖）', { timeout: 15000 }, async (t) => {
  const stub = await startStubUpstream({
    routes: {
      'POST /v1/chat/completions': ({ outgoingResponse }) =>
        writeJson(outgoingResponse, 200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
    },
  });
  t.after(() => stub.close());

  await chatCompletions(
    buildContext(buildGroup({ baseURL: stub.baseURL, request: { extraHeaders: { 'user-agent': 'custom-agent/9.9' } } })),
    { model: 'agnes-2.5-flash', messages: [{ role: 'user', content: 'hi' }] },
  );

  const observedUserAgent = stub.requests[0].headers['user-agent'] || '';
  if (process.env.DSH_MODEL_TEAM_USE_HOST_FETCH === '1') {
    assert.equal(observedUserAgent, 'custom-agent/9.9', '开关=1（宿主 fetch 路径）时保留旧行为：extraHeaders 可覆盖 UA');
    return;
  }
  assert.match(observedUserAgent, /^dsh-model-team\//, `默认路径 UA 必须是包名/版本，实际：${observedUserAgent}`);
  assert.equal(observedUserAgent === 'custom-agent/9.9', false, '默认路径 extraHeaders 不再能覆盖 UA');
});

test('G-ua-③：读不到 package.json 版本时回落成包名（不会让插件起不来）', () => {
  assert.equal(resolveDefaultUserAgent(() => { throw new Error('ENOENT'); }), 'dsh-model-team');
  assert.equal(resolveDefaultUserAgent(() => ''), 'dsh-model-team');
  assert.equal(resolveDefaultUserAgent(() => '9.9.9'), 'dsh-model-team/9.9.9');
});
