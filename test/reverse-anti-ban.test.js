// 反代防封（M4 前置）：指纹稳定、失败治理（软限流/熔断/降权）、请求间隔。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveFingerprint,
  deriveMachineToken,
  deriveMachineType,
  mergeFingerprint,
} from '../src/reverse/platforms/qoder/fingerprint.js';
import {
  BREAKER_THRESHOLD,
  DEGRADE_THRESHOLD,
  breakerBackoffSeconds,
  createAccountHealthStore,
  degradeBackoffSeconds,
  softRateBackoffSeconds,
} from '../src/reverse/core/account-health.js';
import { computeRequestWaitMs, createReverseDriver } from '../src/reverse/driver.js';
import { createAccountStore } from '../src/reverse/core/account-store.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

const PLATFORM = Object.freeze({ id: 'qoder', driverId: 'reverse-qoder', name: 'Qoder', capabilities: { catalogKeys: ['qfmodel'] } });

test('指纹：同一 uid 派生恒等，形态与参考实现一致', () => {
  const first = deriveFingerprint('user-42');
  const second = deriveFingerprint('user-42');
  const other = deriveFingerprint('user-43');

  assert.equal(first.machineToken, second.machineToken, '同一账号两次登录必须同一 token');
  assert.equal(first.machineType, second.machineType);
  assert.notEqual(first.machineToken, other.machineToken);
  assert.equal(first.machineType.length, 18);
  assert.match(first.machineType, /^[0-9a-f]{18}$/);
  assert.equal(first.machineToken.length, 43);
  assert.equal(first.machineToken, deriveMachineToken('user-42'));
  assert.equal(first.machineType, deriveMachineType('user-42'));
});

test('指纹合并：老账号已有值优先，缺了才补派生值', () => {
  const derived = deriveFingerprint('user-42');
  const kept = mergeFingerprint({ machineToken: 'legacy-token', machineType: 'legacy-type' }, derived);
  assert.equal(kept.machineToken, 'legacy-token');
  assert.equal(kept.machineType, 'legacy-type');

  const filled = mergeFingerprint({ machineToken: '', machineType: undefined }, derived);
  assert.equal(filled.machineToken, derived.machineToken);
  assert.equal(filled.machineType, derived.machineType);
});

test('退避式：按参考实现递增并封顶', () => {
  assert.deepEqual([1, 2, 3, 4, 20].map(softRateBackoffSeconds), [600, 1200, 2400, 4800, 7200]);
  assert.deepEqual([3, 4, 5, 30].map(breakerBackoffSeconds), [1800, 3600, 7200, 21600]);
  assert.deepEqual([5, 6, 30].map(degradeBackoffSeconds), [600, 1200, 7200]);
});

test('429 冷却：写入冷却窗口，期内 blocked，过期后解冻', async (t) => {
  const dataRoot = await createTempDirectory(t);
  let nowMs = 1_000_000;
  const store = createAccountHealthStore({ dataRoot, platformId: 'qoder', now: () => nowMs });

  const result = await store.recordSoftRate('account-1');
  assert.equal(result.cooldownUntilMs, nowMs + 600_000);
  const blocked = await store.cooldownOf('account-1');
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.code, 'REVERSE_ACCOUNT_SOFT_LIMIT');

  nowMs += 600_001;
  assert.equal((await store.cooldownOf('account-1')).blocked, false, '过期自动解冻');
});

test('熔断与降权：阈值触发、成功复位', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const store = createAccountHealthStore({ dataRoot, platformId: 'qoder', now: () => 1_000 });

  for (let attempt = 1; attempt < BREAKER_THRESHOLD; attempt += 1) {
    const result = await store.recordHardFailure('account-1');
    assert.equal(result.breaker, false, `第 ${attempt} 次不该熔断`);
  }
  const breaker = await store.recordHardFailure('account-1');
  assert.equal(breaker.breaker, true, `连续 ${BREAKER_THRESHOLD} 次硬失败应熔断`);
  assert.equal((await store.cooldownOf('account-1')).code, 'REVERSE_ACCOUNT_BREAKER');

  await store.recordSuccess('account-1');
  assert.equal((await store.cooldownOf('account-1')).blocked, false, '成功即复位');
  const state = await store.readState('account-1');
  assert.deepEqual([state.hardFailStreak, state.softRateStreak, state.unknownFailStreak], [0, 0, 0]);

  for (let attempt = 1; attempt < DEGRADE_THRESHOLD; attempt += 1) await store.recordUnknownFailure('account-1');
  const degraded = await store.recordUnknownFailure('account-1');
  assert.equal(degraded.degraded, true);
  assert.equal((await store.cooldownOf('account-1')).code, 'REVERSE_ACCOUNT_DEGRADED');
});

test('间隔：不足 1s 要等待（注入时钟与 sleep，不真等）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const accountStore = createAccountStore({ dataRoot, logger });
  const saved = await accountStore.upsertByUserId('qoder', { userId: 'user-42', accessToken: 't', machineId: 'm', machineToken: 'mt', machineType: 'x' });

  let nowMs = 10_000;
  const sleeps = [];
  const calls = [];
  const inference = {
    openInferenceStream: async () => { calls.push(nowMs); return { status: 200, chunks: (async function* () { yield { data: '{}' }; })() }; },
  };
  const driver = createReverseDriver({
    platform: PLATFORM,
    logger,
    inferenceOverride: inference,
    now: () => nowMs,
    sleep: async (ms) => { sleeps.push(ms); nowMs += ms; },   // 注入的 sleep 只推进时钟
    minRequestIntervalMs: 1000,
  });
  const context = { group: { id: 'g', driver: 'reverse-qoder', auth: { apiKeyRef: `account:qoder/${saved.accountId}` } }, dataRoot, fetchImpl: globalThis.fetch };
  const requestBody = { model: 'qfmodel', messages: [{ role: 'user', content: 'hi' }] };

  const first = await driver.streamCompletions(context, requestBody, {});
  assert.equal(first.ok, true);
  nowMs += 100;   // 只过了 100ms 就发第二次
  const second = await driver.streamCompletions(context, requestBody, {});

  assert.equal(second.ok, true);
  assert.deepEqual(sleeps, [900], '不足 1s 应等 900ms 而不是报错');
  assert.equal(calls.length, 2);
  assert.equal(computeRequestWaitMs({ lastRequestAtMs: 10_000, minIntervalMs: 1000, nowMs: 10_100 }), 900);
});

test('冷却期内不发请求：429 后第二次直接返回冷却错误码', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const accountStore = createAccountStore({ dataRoot, logger });
  const saved = await accountStore.upsertByUserId('qoder', { userId: 'user-42', accessToken: 't', machineId: 'm', machineToken: 'mt', machineType: 'x' });

  let upstreamCalls = 0;
  const inference = {
    openInferenceStream: async () => {
      upstreamCalls += 1;
      const error = new Error('上游限流');
      error.code = 'REVERSE_UPSTREAM_FAILED';
      error.upstreamStatus = 429;
      throw error;
    },
  };
  const driver = createReverseDriver({ platform: PLATFORM, logger, inferenceOverride: inference, now: () => 1_000, sleep: async () => {} });
  const context = { group: { id: 'g', driver: 'reverse-qoder', auth: { apiKeyRef: `account:qoder/${saved.accountId}` } }, dataRoot };

  const first = await driver.streamCompletions(context, { model: 'qfmodel', messages: [] }, {});
  assert.equal(first.ok, false);
  assert.equal(first.error.code, 'REVERSE_ACCOUNT_SOFT_LIMIT');
  assert.equal(typeof first.error.cooldownUntilMs, 'number');

  const second = await driver.streamCompletions(context, { model: 'qfmodel', messages: [] }, {});
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'REVERSE_ACCOUNT_SOFT_LIMIT', '冷却期内直接拒绝');
  assert.equal(upstreamCalls, 1, '冷却期内不许再打上游');
});
