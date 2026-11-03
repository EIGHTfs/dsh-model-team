// 调度引擎用例（docs/11 §50-62）：轮询推进与回绕、游标持久化（INV-12）、失败顺延、
// fallback 主备与冷却、全冷却硬试主、单模型直连（绝不进轮换）、平台解析禁止猜测。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MEMBER_COOLDOWN_MS,
  dispatchWithRotation,
  resetMemberCooldowns,
  resolveModelPlatform,
} from '../src/gateway/dispatcher.js';
import { GatewayError } from '../src/gateway/errors.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

// 三个群的配置：g1/g2 有同名模型（用于多义性用例），g3 独有
function buildConfig(overrides = {}) {
  return {
    groups: [
      { id: 'g1', name: '群1', driver: 'openai-compatible', models: { static: ['m-shared'] } },
      { id: 'g2', name: '群2', driver: 'openai-compatible', models: { static: ['m-shared'] } },
      { id: 'g3', name: '群3', driver: 'openai-compatible', models: { static: ['only-g3'] } },
    ],
    friendGroups: [
      {
        id: 'rr-group',
        name: '轮询组',
        strategy: 'round-robin',
        members: [
          { platformId: 'g1', modelId: 'm1' },
          { platformId: 'g2', modelId: 'm2' },
          { platformId: 'g3', modelId: 'm3' },
        ],
      },
      {
        id: 'fb-group',
        name: '故障转移组',
        strategy: 'fallback',
        members: [
          { platformId: 'g1', modelId: 'm1' },
          { platformId: 'g2', modelId: 'm2' },
        ],
      },
    ],
    ...overrides,
  };
}

// 记录每次尝试的假 invoke；succeedFor 决定哪些成员成功
function createFakeInvoke({ succeedFor = () => true } = {}) {
  const attempts = [];
  const invoke = async (attempt) => {
    attempts.push(attempt);
    return succeedFor(attempt)
      ? { ok: true, status: 200, response: { model: attempt.modelId } }
      : { ok: false, status: 429, error: { code: 'UPSTREAM_HTTP_ERROR', message: '限流', upstreamStatus: 429 } };
  };
  return { attempts, invoke };
}

test('round-robin：连续三次按成员顺序轮转，第四次回绕到第一个', async (t) => {
  resetMemberCooldowns();
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const config = buildConfig();
  const { attempts, invoke } = createFakeInvoke();

  for (let requestIndex = 0; requestIndex < 4; requestIndex += 1) {
    const dispatchResult = await dispatchWithRotation({
      config,
      target: { type: 'group', id: 'rr-group' },
      dataRoot,
      logger,
      invoke,
    });
    assert.equal(dispatchResult.ok, true);
  }

  assert.deepEqual(attempts.map((attempt) => attempt.platformId), ['g1', 'g2', 'g3', 'g1']);
  // 游标推进到第 4 次尝试后的位置（1）并已落盘
  const stateText = await fs.readFile(path.join(dataRoot, 'groups-state.json'), 'utf8');
  assert.equal(JSON.parse(stateText).cursors['rr-group'], 1);
});

test('游标持久化：新实例从上次位置继续（INV-12，模拟重启）', async (t) => {
  resetMemberCooldowns();
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const config = buildConfig();

  const firstRunInvoke = createFakeInvoke();
  await dispatchWithRotation({ config, target: { type: 'group', id: 'rr-group' }, dataRoot, logger, invoke: firstRunInvoke.invoke });
  await dispatchWithRotation({ config, target: { type: 'group', id: 'rr-group' }, dataRoot, logger, invoke: firstRunInvoke.invoke });
  assert.deepEqual(firstRunInvoke.attempts.map((attempt) => attempt.platformId), ['g1', 'g2']);

  // 重启：换一份全新的 invoke/模块实例，只靠磁盘状态
  const secondRunInvoke = createFakeInvoke();
  await dispatchWithRotation({ config, target: { type: 'group', id: 'rr-group' }, dataRoot, logger, invoke: secondRunInvoke.invoke });

  assert.deepEqual(secondRunInvoke.attempts.map((attempt) => attempt.platformId), ['g3'], '不能从 0 重新开始');
});

test('round-robin：成员失败自动顺延下一位，且请求最终成功', async (t) => {
  resetMemberCooldowns();
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const config = buildConfig();
  const { attempts, invoke } = createFakeInvoke({ succeedFor: (attempt) => attempt.platformId === 'g2' });

  const dispatchResult = await dispatchWithRotation({
    config,
    target: { type: 'group', id: 'rr-group' },
    dataRoot,
    logger,
    invoke,
  });

  assert.equal(dispatchResult.ok, true);
  assert.deepEqual(attempts.map((attempt) => attempt.platformId), ['g1', 'g2']);
  assert.equal(dispatchResult.attempt.modelId, 'm2');
  assert.equal(dispatchResult.errors.length, 1);
});

test('fallback：主成功不碰备；主 429 顺延备；之后主进入冷却被跳过', async (t) => {
  resetMemberCooldowns();
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const config = buildConfig();

  const healthyInvoke = createFakeInvoke();
  await dispatchWithRotation({ config, target: { type: 'group', id: 'fb-group' }, dataRoot, logger, invoke: healthyInvoke.invoke });
  assert.deepEqual(healthyInvoke.attempts.map((attempt) => attempt.platformId), ['g1'], '主可用时不该碰备');

  const primaryFailingInvoke = createFakeInvoke({ succeedFor: (attempt) => attempt.platformId === 'g2' });
  const failoverResult = await dispatchWithRotation({
    config,
    target: { type: 'group', id: 'fb-group' },
    dataRoot,
    logger,
    invoke: primaryFailingInvoke.invoke,
  });
  assert.equal(failoverResult.ok, true);
  assert.deepEqual(primaryFailingInvoke.attempts.map((attempt) => attempt.platformId), ['g1', 'g2'], '主失败顺延备');

  // 主刚失败过 → 进入冷却，下一次直接走备
  const afterCooldownInvoke = createFakeInvoke();
  await dispatchWithRotation({ config, target: { type: 'group', id: 'fb-group' }, dataRoot, logger, invoke: afterCooldownInvoke.invoke });
  assert.deepEqual(afterCooldownInvoke.attempts.map((attempt) => attempt.platformId), ['g2'], '冷却期内跳过主成员');
});

test('fallback：全部成员冷却 → 用主成员硬试一次（不返回"无可用成员"）', async (t) => {
  resetMemberCooldowns();
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const config = buildConfig();

  // 先让主备都失败一次，双双进入冷却
  const allFailingInvoke = createFakeInvoke({ succeedFor: () => false });
  await dispatchWithRotation({ config, target: { type: 'group', id: 'fb-group' }, dataRoot, logger, invoke: allFailingInvoke.invoke });

  const hardTryInvoke = createFakeInvoke();
  const hardTryResult = await dispatchWithRotation({
    config,
    target: { type: 'group', id: 'fb-group' },
    dataRoot,
    logger,
    invoke: hardTryInvoke.invoke,
  });

  assert.equal(hardTryResult.ok, true);
  assert.deepEqual(hardTryInvoke.attempts.map((attempt) => attempt.platformId), ['g1'], '全冷却时硬试主成员');
  assert.equal(hardTryResult.usedPrimaryAsLastResort, true);
  assert.equal(logger.hasLine('warn', '全部成员冷却中'), true);
});

test('单模型目标：直连一次，绝不进轮换池', async (t) => {
  resetMemberCooldowns();
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const config = buildConfig();
  const { attempts, invoke } = createFakeInvoke();

  const dispatchResult = await dispatchWithRotation({
    config,
    target: { type: 'model', id: 'only-g3' },
    dataRoot,
    logger,
    invoke,
  });

  assert.equal(dispatchResult.ok, true);
  assert.deepEqual(attempts.map((attempt) => attempt.platformId), ['g3']);
  assert.equal(dispatchResult.attempt.groupId, null, '单模型没有 groupId');
});

test('平台解析：多群同名模型 → 400 ambiguous-model + 候选；单群 → 兜底并打日志', async (t) => {
  const logger = createRecordingLogger();
  const config = buildConfig();

  await assert.rejects(
    async () => resolveModelPlatform({ config, target: { type: 'model', id: 'm-shared' }, logger }),
    (resolveError) => resolveError instanceof GatewayError
      && resolveError.code === 'ambiguous-model'
      && resolveError.details.candidates.length === 2,
  );

  const singleGroupConfig = { groups: [config.groups[0]] };
  const platformId = resolveModelPlatform({ config: singleGroupConfig, target: { type: 'model', id: 'unknown-model' }, logger });
  assert.equal(platformId, 'g1');
  assert.equal(logger.hasLine('info', '按唯一群兜底'), true);

  // 显式 platformId 直接用，不查列表
  assert.equal(resolveModelPlatform({ config, target: { type: 'model', id: 'whatever', platformId: 'g2' }, logger }), 'g2');
});

test('旧结构 {platform, model} 归一后按单模型派发', async (t) => {
  resetMemberCooldowns();
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const config = buildConfig();
  const { attempts, invoke } = createFakeInvoke();

  await dispatchWithRotation({
    config,
    target: { platform: 'g2', model: 'm2' },
    dataRoot,
    logger,
    invoke,
  });

  assert.deepEqual(attempts, [{ groupId: null, platformId: 'g2', modelId: 'm2' }]);
});

test('冷却常量具名且为 60000ms（docs/11 §61）', () => {
  assert.equal(MEMBER_COOLDOWN_MS, 60_000);
});
