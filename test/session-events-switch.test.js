// 会话切换事件用例：切换落两条（@目标 + 系统提示）、都带 ISO 的 at、历史事件补 null、读回按 at 升序。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startGatewayHarness, selectModelRequest } from './helpers/gateway-harness.js';

// ISO 8601：带本地偏移或 Z 都算合法（裁决后新写入用 +HH:MM，历史行可能是 Z）
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
// 新写入的 at 必须是带偏移形态（与 updatedAt 一致），不能是 Z
const OFFSET_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+\d{2}:\d{2}$/;

function eventsPath(dataRoot, sessionId) {
  return path.join(dataRoot, 'sessions', `${encodeURIComponent(sessionId)}.events.jsonl`);
}

async function appendRawEvent(dataRoot, sessionId, event) {
  const filePath = eventsPath(dataRoot, sessionId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
}

test('PUT target（单模型）：self-message + system 两条事件，文案精确、at 合法', async (t) => {
  const harness = await startGatewayHarness(t);

  const putResponse = await harness.request('/_team/session/sess-switch-model/target', {
    method: 'PUT',
    body: { type: 'model', id: 'model-a', platformId: 'agnes' },
  });
  assert.equal(putResponse.status, 200);

  const eventsResponse = await harness.request('/_team/session/sess-switch-model/events');
  const events = eventsResponse.body.events;

  const selfMessage = events.find((event) => event.type === 'self-message');
  const systemEvent = events.find((event) => event.type === 'system');

  assert.notEqual(selfMessage, undefined, '要有 self-message');
  assert.notEqual(systemEvent, undefined, '要有 system 提示（刷新后不丢）');
  assert.equal(selfMessage.text, '@model-a');
  assert.equal(systemEvent.text, '你 @ 了 model-a 并切换了当前会话模型');
  assert.match(selfMessage.at, ISO_PATTERN);
  assert.match(systemEvent.at, ISO_PATTERN);
  // 统一形态：带本地偏移（形如 2026-11-02T20:07:30+08:00），不是 UTC 的 Z
  assert.match(selfMessage.at, OFFSET_ISO_PATTERN);
  assert.equal(selfMessage.at, systemEvent.at, '同一次切换的两条事件共用一个时间点');
});

test('PUT target（分组）：system 文案含分组名与策略', async (t) => {
  const harness = await startGatewayHarness(t);
  await harness.request('/_team/friend-groups', {
    method: 'POST',
    body: {
      id: 'ha-group',
      name: '高可用组',
      strategy: 'round-robin',
      members: [{ platformId: 'agnes', modelId: 'model-a' }],
    },
  });

  const putResponse = await harness.request('/_team/session/sess-switch-group/target', {
    method: 'PUT',
    body: { type: 'group', id: 'ha-group' },
  });
  assert.equal(putResponse.status, 200);

  const events = (await harness.request('/_team/session/sess-switch-group/events')).body.events;
  const systemEvent = events.find((event) => event.type === 'system');

  assert.notEqual(systemEvent, undefined);
  assert.equal(systemEvent.text, '已切换路由至：高可用组（策略：轮询）');
  assert.match(systemEvent.at, ISO_PATTERN);
  assert.match(systemEvent.at, OFFSET_ISO_PATTERN);
});

test('兼容入口 PUT model：同样落 self-message + system 两条', async (t) => {
  const harness = await startGatewayHarness(t);
  await harness.request('/_team/session/sess-switch-legacy/model', selectModelRequest('agnes', 'model-b'));

  const events = (await harness.request('/_team/session/sess-switch-legacy/events')).body.events;
  const systemEvent = events.find((event) => event.type === 'system');

  assert.notEqual(systemEvent, undefined);
  assert.equal(systemEvent.text, '你 @ 了 model-b 并切换了当前会话模型');
});

test('历史事件没有 at：读回补 null（字段仍在，不是 undefined）', async (t) => {
  const harness = await startGatewayHarness(t);
  await appendRawEvent(harness.dataRoot, 'sess-legacy-events', {
    time: '09:00:00',
    type: 'system',
    text: '旧版本写的提示',
  });

  const events = (await harness.request('/_team/session/sess-legacy-events/events')).body.events;
  const legacyEvent = events.find((event) => event.text === '旧版本写的提示');

  assert.notEqual(legacyEvent, undefined);
  assert.equal('at' in legacyEvent, true, '字段不能消失');
  assert.strictEqual(legacyEvent.at, null);
});

test('events 按 at 升序返回：at 为 null 的历史事件排最前', async (t) => {
  const harness = await startGatewayHarness(t);
  const sessionId = 'sess-event-order';
  await appendRawEvent(harness.dataRoot, sessionId, {
    time: '12:00:00',
    at: '2026-11-02T12:00:00.000Z',
    type: 'system',
    text: '第三条(12:00)',
  });
  await appendRawEvent(harness.dataRoot, sessionId, {
    time: '08:00:00',
    type: 'system',
    text: '第一条(无 at)',
  });
  await appendRawEvent(harness.dataRoot, sessionId, {
    time: '10:00:00',
    at: '2026-11-02T10:00:00.000Z',
    type: 'system',
    text: '第二条(10:00)',
  });

  const events = (await harness.request(`/_team/session/${sessionId}/events`)).body.events;

  assert.deepEqual(events.map((event) => event.text), ['第一条(无 at)', '第二条(10:00)', '第三条(12:00)']);
});
