// 会话目标回落用例（docs/19）：explicit → parent（递归向上）→ last-session → fallback-group；
// 外加：服务缺失跳过父链、请求行 targetSource 落盘、GET target 出参带 effectiveTarget/targetSource。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findLatestBoundSession,
  readParentChain,
  resolveSessionTargetWithFallback,
  TARGET_SOURCE,
} from '../src/gateway/session-fallback.js';
import { writeSessionTarget } from '../src/gateway/session-store.js';
import { buildRequestRow, toPublicRequestRow } from '../src/gateway/stats.js';
import { startGatewayHarness, chatAs, selectModelRequest } from './helpers/gateway-harness.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

// 假宿主会话服务：只实现 get(id)，返回带 header 的活会话对象
function buildSessionService(sessionsById) {
  return { get: async (sessionId) => sessionsById.get(sessionId) ?? null };
}

function buildLiveSession(sessionId, parentSession = null) {
  return { id: sessionId, header: parentSession ? { parentSession } : {}, snapshotEvents: () => [] };
}

const MODEL_TARGET = { type: 'model', id: 'model-a', platformId: 'agnes' };
const PARENT_TARGET = { type: 'model', id: 'model-parent', platformId: 'agnes' };
const GRANDPARENT_TARGET = { type: 'model', id: 'model-grandparent', platformId: 'agnes' };

test('1) 本会话有映射：source=explicit，target 原样', async (t) => {
  const dataRoot = await createTempDirectory(t);
  await writeSessionTarget('sess-self', MODEL_TARGET, { dataRoot });

  const resolution = await resolveSessionTargetWithFallback({
    sessionId: 'sess-self',
    dataRoot,
    config: {},
    sessionService: buildSessionService(new Map()),
    logger: createRecordingLogger(),
  });

  assert.equal(resolution.source, TARGET_SOURCE.EXPLICIT);
  assert.deepEqual(resolution.target, MODEL_TARGET);
});

test('2) 无本会话映射、父有映射：source=parent', async (t) => {
  const dataRoot = await createTempDirectory(t);
  await writeSessionTarget('sess-parent', PARENT_TARGET, { dataRoot });
  const sessionService = buildSessionService(new Map([
    ['sess-child', buildLiveSession('sess-child', 'sess-parent')],
    ['sess-parent', buildLiveSession('sess-parent')],
  ]));

  const resolution = await resolveSessionTargetWithFallback({
    sessionId: 'sess-child',
    dataRoot,
    config: {},
    sessionService,
    logger: createRecordingLogger(),
  });

  assert.equal(resolution.source, TARGET_SOURCE.PARENT);
  assert.deepEqual(resolution.target, PARENT_TARGET);
});

test('3) 父无映射但祖父有：source=parent（递归向上）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  await writeSessionTarget('sess-grandparent', GRANDPARENT_TARGET, { dataRoot });
  const sessionService = buildSessionService(new Map([
    ['sess-child', buildLiveSession('sess-child', 'sess-parent')],
    ['sess-parent', buildLiveSession('sess-parent', 'sess-grandparent')],
    ['sess-grandparent', buildLiveSession('sess-grandparent')],
  ]));

  const chain = await readParentChain('sess-child', sessionService);
  const resolution = await resolveSessionTargetWithFallback({
    sessionId: 'sess-child',
    dataRoot,
    config: {},
    sessionService,
    logger: createRecordingLogger(),
  });

  assert.deepEqual(chain, ['sess-parent', 'sess-grandparent'], '父链就近在前');
  assert.equal(resolution.source, TARGET_SOURCE.PARENT);
  assert.deepEqual(resolution.target, GRANDPARENT_TARGET);
});

test('4) 无映射、无父：取其它会话中 updatedAt 最新者（排除本会话）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  await writeSessionTarget('sess-older', { type: 'model', id: 'model-older', platformId: 'agnes' }, {
    dataRoot,
    updatedAt: '2026-11-01T00:00:00+08:00',
  });
  await writeSessionTarget('sess-newer', { type: 'model', id: 'model-newer', platformId: 'agnes' }, {
    dataRoot,
    updatedAt: '2026-11-02T10:00:00+08:00',
  });

  const latestBound = await findLatestBoundSession({ dataRoot, excludeSessionId: 'sess-self' });
  const resolution = await resolveSessionTargetWithFallback({
    sessionId: 'sess-self',
    dataRoot,
    config: {},
    sessionService: buildSessionService(new Map([['sess-self', buildLiveSession('sess-self')]])),
    logger: createRecordingLogger(),
  });

  assert.equal(latestBound.sessionId, 'sess-newer');
  assert.equal(resolution.source, TARGET_SOURCE.LAST_SESSION);
  assert.equal(resolution.target.id, 'model-newer');
});

test('5) 全都没有但有 fallbackGroupId：source=fallback-group（既有行为不回归）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const config = {
    groups: [{ id: 'agnes', name: 'agnes', defaultModel: 'model-default' }],
    session: { fallbackGroupId: 'agnes' },
  };

  const resolution = await resolveSessionTargetWithFallback({
    sessionId: 'sess-self',
    dataRoot,
    config,
    sessionService: buildSessionService(new Map()),
    logger: createRecordingLogger(),
  });

  assert.equal(resolution.source, TARGET_SOURCE.FALLBACK_GROUP);
  assert.deepEqual(resolution.target, { type: 'model', id: 'model-default', platformId: 'agnes' });
});

test('6) 全都没有且无兜底群：target=null；请求链路报 model-unresolved', async (t) => {
  const dataRoot = await createTempDirectory(t);

  const resolution = await resolveSessionTargetWithFallback({
    sessionId: 'sess-self',
    dataRoot,
    config: {},
    sessionService: buildSessionService(new Map()),
    logger: createRecordingLogger(),
  });
  assert.equal(resolution.target, null);
  assert.equal(resolution.source, null);

  const harness = await startGatewayHarness(t);
  const chatResponse = await harness.request('/v1/chat/completions', chatAs('sess-unbound'));
  assert.equal(chatResponse.status, 400);
  assert.equal(chatResponse.body.error.code, 'model-unresolved');
});

test('7) 宿主 sessions 服务缺失：跳过父链，走到 last-session', async (t) => {
  const dataRoot = await createTempDirectory(t);
  await writeSessionTarget('sess-other', { type: 'model', id: 'model-other', platformId: 'agnes' }, {
    dataRoot,
    updatedAt: '2026-11-02T09:00:00+08:00',
  });

  const resolution = await resolveSessionTargetWithFallback({
    sessionId: 'sess-self',
    dataRoot,
    config: {},
    sessionService: null,
    logger: createRecordingLogger(),
  });

  assert.deepEqual(await readParentChain('sess-self', null), [], '无服务时父链为空');
  assert.equal(resolution.source, TARGET_SOURCE.LAST_SESSION);
  assert.equal(resolution.target.id, 'model-other');
});

test('8) 请求行 targetSource：落盘后出参可见', async (t) => {
  // 单元层：buildRequestRow 带上就给、不给就不写
  const rowWithSource = buildRequestRow({
    sessionId: 'sess-row',
    statusCode: 200,
    model: 'model-a',
    startedAtMs: 1_000_000,
    finishedAtMs: 1_001_000,
    usage: null,
    credit: null,
    requestId: 'req-1',
    targetSource: TARGET_SOURCE.PARENT,
  });
  assert.equal(toPublicRequestRow(rowWithSource).targetSource, 'parent');
  assert.equal('targetSource' in toPublicRequestRow(buildRequestRow({
    sessionId: 'sess-row-2', statusCode: 200, model: 'm', startedAtMs: 1_000_000, finishedAtMs: 1_001_000,
    usage: null, credit: null, requestId: 'req-2',
  })), false);

  // 端到端：显式目标请求 → 请求行里 targetSource === explicit
  const harness = await startGatewayHarness(t);
  await harness.request('/_team/session/sess-row/model', selectModelRequest('agnes', 'agnes-3.0-flash'));
  await harness.request('/v1/chat/completions', chatAs('sess-row'));
  const rows = (await harness.request('/_team/stats/session/sess-row')).body.rows;
  assert.equal(rows.at(-1).targetSource, TARGET_SOURCE.EXPLICIT);
});

test('9) GET /_team/session/:id/target：出参带 effectiveTarget 与 targetSource', async (t) => {
  const harness = await startGatewayHarness(t, {
    // 本会话无映射，父会话有映射：GET target 应该能看到"实际会用父的模型"
    getSessionService: () => buildSessionService(new Map([
      ['sess-read-child', buildLiveSession('sess-read-child', 'sess-read-parent')],
      ['sess-read-parent', buildLiveSession('sess-read-parent')],
    ])),
  });
  await writeSessionTarget('sess-read-parent', PARENT_TARGET, { dataRoot: harness.dataRoot });

  const response = await harness.request('/_team/session/sess-read-child/target');
  const body = response.body;

  assert.equal(response.status, 200);
  assert.equal(body.target, null, '显式目标仍是 null（不改 target 语义）');
  assert.deepEqual(body.effectiveTarget, PARENT_TARGET);
  assert.equal(body.targetSource, TARGET_SOURCE.PARENT);
});

test('10) 非流式 chat 也走父链回落：请求行 targetSource=parent', async (t) => {
  const sessionService = buildSessionService(new Map([
    ['sess-chat-child', buildLiveSession('sess-chat-child', 'sess-chat-parent')],
    ['sess-chat-parent', buildLiveSession('sess-chat-parent')],
  ]));
  const harness = await startGatewayHarness(t, { getSessionService: () => sessionService });
  await writeSessionTarget('sess-chat-parent', PARENT_TARGET, { dataRoot: harness.dataRoot });

  const chatResponse = await harness.request('/v1/chat/completions', chatAs('sess-chat-child'));
  const rows = (await harness.request('/_team/stats/session/sess-chat-child')).body.rows;

  assert.equal(chatResponse.status, 200);
  assert.equal(rows.at(-1).targetSource, TARGET_SOURCE.PARENT, '非流式路径必须把 getSessionService 传下去');
  assert.equal(rows.at(-1).model, PARENT_TARGET.id);
});
