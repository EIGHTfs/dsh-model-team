// 上游错误认领（docs/02 §九）：通用层只登记与询问，平台差异在各自单文件里。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  claimStreamError,
  listRegisteredStreamErrorClaimers,
  registerStreamErrorClaimer,
  resetStreamErrorClaimersForTest,
} from '../src/gateway/drivers/stream-error-claimers.js';
import { attachStreamErrorClaimers, activateBuiltInStreamErrorClaimers } from '../src/gateway/drivers/index.js';
import { claimers as qoderClaimers } from '../src/reverse/platforms/qoder/claimers.js';
import { buildRequestRow } from '../src/gateway/stats/index.js';
import { noteFirstToken } from '../src/plugin/adapter/adapter.js';
import { createTempDirectory, createRecordingLogger } from './helpers/test-environment.js';

const QODER_CLAIMER = qoderClaimers[0];

function buildQoderFrame(overrides = {}) {
  return { code: '112', message: '{"pricingUrl":"https://example.invalid/pricing"}', ...overrides };
}

test('未登记任何认领者：不认任何帧（行为与原实现一致）', () => {
  resetStreamErrorClaimersForTest();
  assert.equal(claimStreamError(buildQoderFrame(), { driverId: 'any' }), null);
  assert.deepEqual(listRegisteredStreamErrorClaimers(), []);
});

test('登记后命中：返回统一形状，message 原样给出', () => {
  resetStreamErrorClaimersForTest();
  registerStreamErrorClaimer({ id: 'demo#only', claim: () => ({ code: 'X', message: '人话', reason: 'demo:1', status: 418 }) });

  const claimed = claimStreamError({}, { driverId: 'demo' });
  assert.equal(claimed.code, 'X');
  assert.equal(claimed.message, '人话');
  assert.equal(claimed.reason, 'demo:1');
  assert.equal(claimed.status, 418);
});

test('多个认领者：按登记顺序，首个命中生效（后登记的不抢）', () => {
  resetStreamErrorClaimersForTest();
  registerStreamErrorClaimer({ id: 'first', claim: () => ({ code: 'FIRST', message: 'first', reason: 'r1' }) });
  registerStreamErrorClaimer({ id: 'second', claim: () => ({ code: 'SECOND', message: 'second', reason: 'r2' }) });

  assert.equal(claimStreamError({}, {}).code, 'FIRST');
});

test('重复 id 登记即抛错；注销后不再命中', () => {
  resetStreamErrorClaimersForTest();
  const disposeFirst = registerStreamErrorClaimer({ id: 'dup', claim: () => ({ code: 'A', message: 'a', reason: 'a' }) });
  assert.throws(() => registerStreamErrorClaimer({ id: 'dup', claim: () => ({ code: 'B', message: 'b', reason: 'b' }) }), /重复/);

  assert.equal(claimStreamError({}, {}).code, 'A');
  disposeFirst();
  assert.equal(claimStreamError({}, {}), null, '注销后不再命中');
});

test('Qoder：code 112 → 额度不足（402）；其它 code → 业务错误（502）', () => {
  assert.deepEqual(
    QODER_CLAIMER.claim(buildQoderFrame(), {}),
    {
      code: 'UPSTREAM_QUOTA_EXHAUSTED',
      message: '额度/权益不足：{"pricingUrl":"https://example.invalid/pricing"}',
      reason: 'qoder-code:112',
      status: 402,
    },
  );

  const otherCode = QODER_CLAIMER.claim(buildQoderFrame({ code: '5001', message: 'boom' }), {});
  assert.equal(otherCode.code, 'UPSTREAM_BUSINESS_ERROR');
  assert.equal(otherCode.reason, 'qoder-code:5001');
  assert.equal(otherCode.status, undefined, '其它 code 用缺省状态');
});

test('Qoder：usage-only 尾帧与正常内容帧都不认', () => {
  assert.equal(QODER_CLAIMER.claim({ usage: { total_tokens: 10 }, choices: [] }, {}), null);
  assert.equal(QODER_CLAIMER.claim({ choices: [{ delta: { content: 'hi' } }] }, {}), null);
  assert.equal(QODER_CLAIMER.claim({}, {}), null);
});

test('官方驱动错误帧：UPSTREAM_ERROR_FRAME（同一套机制，不是反代专用）', async () => {
  resetStreamErrorClaimersForTest();
  const logger = createRecordingLogger();
  const disposers = await activateBuiltInStreamErrorClaimers({ logger });
  assert.equal(listRegisteredStreamErrorClaimers().includes('openai-compatible#error-frame'), true);

  const claimed = claimStreamError({ error: { message: 'bad key', type: 'invalid_request_error', code: 'invalid_api_key' } }, { driverId: 'openai-compatible' });
  assert.equal(claimed.code, 'UPSTREAM_ERROR_FRAME');
  assert.equal(claimed.reason, 'openai-error:invalid_request_error');
  assert.equal(claimed.status, 502);

  for (const dispose of disposers) dispose();
});

test('动态加载：只加文件 + 声明一行即可接入新平台；注销后消失', async (t) => {
  resetStreamErrorClaimersForTest();
  const fakePlatformDir = await createTempDirectory(t);
  const claimerFile = path.join(fakePlatformDir, 'claimers.js');
  await fs.writeFile(claimerFile, `export const claimers = [{ id: 'fake-error', claim: (payload) => (payload?.fakeError ? { code: 'FAKE_ERROR', message: '假平台错误', reason: 'fake:1', status: 400 } : null) }];\n`, 'utf8');

  const logger = createRecordingLogger();
  const disposers = await attachStreamErrorClaimers({
    baseUrl: pathToFileURL(path.join(fakePlatformDir, 'platform.js')).href,
    moduleSpecifier: './claimers.js',
    idPrefix: 'fake-driver',
    logger,
  });

  assert.deepEqual(listRegisteredStreamErrorClaimers(), ['fake-driver#fake-error']);
  assert.equal(claimStreamError({ fakeError: true }, {}).code, 'FAKE_ERROR');
  assert.equal(logger.lines.filter((line) => line.level === 'warn').length, 0, '正常加载不该有 warn');

  for (const dispose of disposers) dispose();
  assert.equal(claimStreamError({ fakeError: true }, {}), null, '注销后不再命中');
});

test('加载失败降级：文件缺失 / 导出非法 → warn 一次并跳过，不抛', async (t) => {
  resetStreamErrorClaimersForTest();
  const emptyDir = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const baseUrl = pathToFileURL(path.join(emptyDir, 'platform.js')).href;

  const missing = await attachStreamErrorClaimers({ baseUrl, moduleSpecifier: './not-there.js', idPrefix: 'broken', logger });
  assert.deepEqual(missing, []);

  const illegalFile = path.join(emptyDir, 'illegal.js');
  await fs.writeFile(illegalFile, 'export const claimers = "not-an-array";\n', 'utf8');
  const illegal = await attachStreamErrorClaimers({ baseUrl, moduleSpecifier: './illegal.js', idPrefix: 'illegal', logger });
  assert.deepEqual(illegal, []);

  assert.equal(logger.lines.filter((line) => line.level === 'warn').length, 2, '两种情况各 warn 一次');
  assert.deepEqual(listRegisteredStreamErrorClaimers(), [], '失败不留下半登记状态');
});

test('请求行：claimedReason 只在命中时出现，title 模板不被改动', () => {
  const baseRowInput = {
    sessionId: 's1',
    statusCode: 402,
    statusText: undefined,
    model: 'qfmodel',
    account: { name: 'Qoder', id: 'qoder' },
    ipAddress: '—',
    userAgent: '—',
    startedAtMs: 1_000,
    finishedAtMs: 1_500,
    usage: null,
    credit: null,
    requestId: 'req-1',
  };

  const withReason = buildRequestRow({ ...baseRowInput, claimedReason: 'qoder-code:112' });
  assert.equal(withReason.claimedReason, 'qoder-code:112');
  assert.equal(withReason.title.includes('认领'), false, 'title 顺序固定，不追加认领段');

  const withoutReason = buildRequestRow(baseRowInput);
  assert.equal('claimedReason' in withoutReason, false, '未命中时该字段不出现');

  // Bug 2：首字时刻要能算进 decodeMs（速率精确分母），否则永远只有下界
  const withFirstToken = buildRequestRow({ ...baseRowInput, firstTokenAtMs: 1_200 });
  assert.equal(withFirstToken.decodeMs, 300, 'decodeMs = 结束时刻 - 首字时刻');
  assert.equal(buildRequestRow(baseRowInput).decodeMs, null, '没有首字时刻就是 null（下界语义）');
});

test('首字时刻：只带 role 的开场帧不算，首个内容帧才记（只记一次）', () => {
  const streamState = {};
  let nowMs = 1_000;
  const clock = () => nowMs;

  noteFirstToken(streamState, { choices: [{ delta: { role: 'assistant' } }] }, clock);
  assert.equal(streamState.firstTokenAtMs, undefined, 'role 开场帧不算首字');

  noteFirstToken(streamState, { choices: [{ delta: { content: '' } }] }, clock);
  assert.equal(streamState.firstTokenAtMs, undefined, '空 content 帧不算首字');

  nowMs = 1_250;
  noteFirstToken(streamState, { choices: [{ delta: { content: '你' } }] }, clock);
  assert.equal(streamState.firstTokenAtMs, 1_250);

  nowMs = 1_400;
  noteFirstToken(streamState, { choices: [{ delta: { content: '好' } }] }, clock);
  assert.equal(streamState.firstTokenAtMs, 1_250, '首字时刻不会被后续帧覆盖');
});

test('通用层不含平台名/路径（契约 §9.6-4）', async () => {
  const genericLayerSource = await fs.readFile(new URL('../src/gateway/drivers/stream-error-claimers.js', import.meta.url), 'utf8');
  assert.equal(/qoder|openai|\.js/i.test(genericLayerSource), false);
});
