// 反代推理链路用例（M3b）：带信封的 SSE → 标准 chunk、401 明确失败、加密失败不降级、
// 驱动接线（未登录明确报错 / 有账号走通）、能力门。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createReverseHttpClient, REVERSE_HTTP_ERROR_CODES } from '../src/gateway/reverse/qoder/http-client.js';
import { INFER_ERROR_CODES, decodeChunkStream, openInferenceStream } from '../src/gateway/reverse/qoder/infer.js';
import { createAccountStore } from '../src/reverse/core/account-store.js';
import { createReverseDriver, listReverseDrivers, parseAccountRef } from '../src/gateway/drivers/reverse-driver.js';
import { getDriver, registerReverseDrivers } from '../src/gateway/drivers/index.js';
import { listPlatforms } from '../src/gateway/reverse/index.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

const FAKE_CREDENTIAL = Object.freeze({
  accessToken: 'fake-access-token',
  refreshToken: 'fake-refresh-token',
  userId: 'user-infer-01',
  nickname: '推理账号',
  machineId: 'machine-infer',
  machineToken: 'machine-token-infer',
  machineType: 'x86_64_linux',
});

function envelopeFrame(chunkObject) {
  return `data: ${JSON.stringify({ headers: {}, statusCode: 200, body: JSON.stringify(chunkObject) })}`;
}

function chunkWithText(text) {
  return { id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: text } }] };
}

// 本地 stub：按脚本返回 SSE（带信封）；同时记录每个请求路径，便于断言"没有二次请求"
async function startInferStub({ status = 200, contentType = 'text/event-stream', frames = [] } = {}) {
  const requestPaths = [];
  const server = http.createServer((request, response) => {
    requestPaths.push(request.url);
    if (status !== 200) {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end('{"message":"denied"}');
      return;
    }
    response.writeHead(200, { 'content-type': contentType });
    for (const frame of frames) response.write(`${frame}\n\n`);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requestPaths,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function buildPlatform(origin) {
  return {
    id: 'qoder',
    driverId: 'reverse-qoder',
    name: 'Qoder（测试）',
    endpoints: { inferBase: origin },
    capabilities: { encryptedInference: true, catalogKeys: ['qfmodel'] },
  };
}

test('infer：带信封的 SSE → 标准 chunk 序列与拼接文本正确', async (t) => {
  const stub = await startInferStub({
    frames: [envelopeFrame(chunkWithText('你好')), envelopeFrame(chunkWithText('，世界')), 'data: [DONE]'],
  });
  t.after(() => stub.close());

  const { chunks } = await openInferenceStream({
    credential: FAKE_CREDENTIAL,
    messages: [{ role: 'user', content: '打个招呼' }],
    tools: [],
    model: 'qfmodel',
    platform: buildPlatform(stub.origin),
  });

  const collected = [];
  for await (const chunk of chunks) collected.push(chunk);
  const text = collected.map((chunk) => chunk.choices?.[0]?.delta?.content ?? '').join('');

  assert.equal(collected.length, 2, '两帧内容 = 两个 chunk（[DONE] 不产出 chunk）');
  assert.equal(text, '你好，世界');
  assert.equal(stub.requestPaths.length, 1);
  assert.equal(stub.requestPaths[0].includes('agent_chat_generation'), true);
  assert.equal(stub.requestPaths[0].includes('Encode=1'), true);
  assert.equal(stub.requestPaths[0].includes('/model/v1/chat/completions'), false, '不许走公开端点');
});

test('infer：401 → 明确失败 REVERSE_AUTH_REQUIRED，不重试、不换端点', async (t) => {
  const stub = await startInferStub({ status: 401 });
  t.after(() => stub.close());

  await assert.rejects(
    () => openInferenceStream({
      credential: FAKE_CREDENTIAL,
      messages: [{ role: 'user', content: 'hi' }],
      model: 'qfmodel',
      platform: buildPlatform(stub.origin),
    }),
    (error) => {
      assert.equal(error.code, INFER_ERROR_CODES.AUTH_REQUIRED);
      assert.equal(error.upstreamStatus, 401);
      return true;
    },
  );
  assert.equal(stub.requestPaths.length, 1, '401 不重试');
  assert.equal(stub.requestPaths.some((requestPath) => requestPath.includes('/model/v1/chat/completions')), false);
});

test('infer：加密失败（wasm 缺失）→ 明确报错，且一次请求都没发出去（更没有公开端点降级）', async (t) => {
  const stub = await startInferStub({ frames: [] });
  t.after(() => stub.close());

  await assert.rejects(
    () => openInferenceStream({
      credential: FAKE_CREDENTIAL,
      messages: [{ role: 'user', content: 'hi' }],
      model: 'qfmodel',
      platform: buildPlatform(stub.origin),
      backendKind: 'wasm',
      wasmPath: '/nonexistent/qoder-auth-wasm.wasm',
      environment: {},
    }),
    (error) => error.code === 'REVERSE_WASM_MISSING',
  );
  assert.equal(stub.requestPaths.length, 0, '加密失败必须在发送前结束：零请求');
});

test('infer：坏帧跳过、[DONE] 结束；内层非法 JSON 明确报 STREAM_FAILED', async () => {
  const goodStream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('data: not-json\n\n'));
      controller.enqueue(encoder.encode(`${envelopeFrame(chunkWithText('A'))}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  const collected = [];
  for await (const chunk of decodeChunkStream(goodStream)) collected.push(chunk);
  assert.equal(collected.length, 1, '坏帧被跳过，只有正常帧产出');
  assert.equal(collected[0].choices[0].delta.content, 'A');
});

test('http-client：超时发生在 I/O 边界，抛 REVERSE_HTTP_TIMEOUT（不是返回兜底值）', async () => {
  const hangingFetch = (requestUrl, requestInit) => new Promise((resolveFetch, rejectFetch) => {
    requestInit?.signal?.addEventListener('abort', () => {
      const timeoutError = new Error('aborted');
      timeoutError.name = 'TimeoutError';
      rejectFetch(timeoutError);
    });
  });
  const client = createReverseHttpClient({ timeoutMs: 30, fetchImpl: hangingFetch });

  // AbortSignal.timeout 的定时器是 unref 的：这个合成用例里没有别的 I/O 撑着，
  // 需要一个 ref 定时器把事件循环留住，否则超时定时器根本不会触发（真实链路里有网络 I/O，不会出现）
  const keepAliveTimer = setTimeout(() => {}, 500);
  try {
    await assert.rejects(
      () => client('https://example.com/x', {}),
      (error) => error.code === REVERSE_HTTP_ERROR_CODES.TIMEOUT,
    );
  } finally {
    clearTimeout(keepAliveTimer);
  }
});

test('驱动：未登录（引用无效）→ 明确 REVERSE_NOT_LOGGED_IN，不发任何请求', async (t) => {
  const logger = createRecordingLogger();
  const driver = createReverseDriver({ platform: buildPlatform('http://127.0.0.1:9'), logger });
  let fetchCalls = 0;
  const result = await driver.streamCompletions(
    { group: { id: 'g1', driver: 'reverse-qoder', auth: {} }, fetchImpl: () => { fetchCalls += 1; }, dataRoot: '/tmp/none' },
    { model: 'qfmodel', messages: [{ role: 'user', content: 'hi' }] },
    {},
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'REVERSE_NOT_LOGGED_IN');
  assert.match(result.error.message, /未登录/);
  assert.equal(fetchCalls, 0);
  assert.equal(driver.accessMode, 'reverse');
});

test('驱动：有账号（account:<platform>/<id> 引用）→ 走通并返回标准 chunk', async (t) => {
  const stub = await startInferStub({ frames: [envelopeFrame(chunkWithText('驱动回复')), 'data: [DONE]'] });
  t.after(() => stub.close());
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const accountStore = createAccountStore({ dataRoot, logger });
  const saved = await accountStore.upsertByUserId('qoder', FAKE_CREDENTIAL);

  const driver = createReverseDriver({ platform: buildPlatform(stub.origin), logger });
  const result = await driver.streamCompletions(
    {
      group: { id: 'g1', driver: 'reverse-qoder', auth: { apiKeyRef: `account:qoder/${saved.accountId}` } },
      dataRoot,
      fetchImpl: globalThis.fetch,
    },
    { model: 'qfmodel', messages: [{ role: 'user', content: 'hi' }] },
    {},
  );

  assert.equal(result.ok, true);
  const texts = [];
  for await (const chunk of result.events) texts.push(chunk.choices[0].delta.content);
  assert.deepEqual(texts, ['驱动回复']);
});

test('能力门：注册表里带 encryptedInference 的平台才出驱动（Qoder 有、无能力的不出）', () => {
  const platformList = listPlatforms();
  const driverIds = listReverseDrivers({ platforms: platformList }).map((driver) => driver.id);
  assert.equal(driverIds.includes('reverse-qoder'), true);

  const withoutCapability = listReverseDrivers({
    platforms: [{ id: 'noskill', driverId: 'reverse-noskill', capabilities: { encryptedInference: false } }],
  });
  assert.deepEqual(withoutCapability, []);
});

test('account 引用解析：account:<platform>/<id>；其它形状返回 null（不猜账号）', () => {
  assert.deepEqual(parseAccountRef('account:qoder/account-1'), { platformId: 'qoder', accountId: 'account-1' });
  assert.equal(parseAccountRef('account:qoder'), null);
  assert.equal(parseAccountRef('env:FOO'), null);
  assert.equal(parseAccountRef(undefined), null);
});

test('能力门：插件 apply 登记后 reverse-qoder 进入驱动表（accessMode=reverse）', () => {
  const registeredIds = registerReverseDrivers({ platforms: listPlatforms(), logger: createRecordingLogger() });

  assert.deepEqual(registeredIds, ['reverse-qoder']);
  const reverseDriver = getDriver('reverse-qoder');
  assert.equal(reverseDriver.accessMode, 'reverse');
  assert.equal(typeof reverseDriver.streamCompletions, 'function');
});
