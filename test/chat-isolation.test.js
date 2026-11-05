// 聊天流按群隔离用例：请求行按 account.id 过滤、事件按 platformId 过滤；历史事件补 platformId=null。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startGatewayHarness } from './helpers/gateway-harness.js';
import { appendRequestRow, buildRequestRow } from '../src/gateway/stats/index.js';

const SESSION_ID = 'sess-isolation';
const STARTED_AT_MS = Date.parse('2026-11-02T10:00:00.000Z');

// 往同一会话写两条请求行，分别属于两个群
async function writeTwoGroupRows(dataRoot) {
  const rowForGroup = (groupId, requestId, offsetMs) => buildRequestRow({
    sessionId: SESSION_ID,
    statusCode: 200,
    model: `model-of-${groupId}`,
    account: { name: groupId.toUpperCase(), id: groupId },
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
    startedAtMs: STARTED_AT_MS + offsetMs,
    finishedAtMs: STARTED_AT_MS + offsetMs + 1000,
    usage: null,
    credit: null,
    requestId,
  });
  await appendRequestRow(rowForGroup('agnes', 'req-a', 0), { dataRoot });
  await appendRequestRow(rowForGroup('workbuddy', 'req-b', 5000), { dataRoot });
}

async function appendRawEvent(dataRoot, sessionId, event) {
  const filePath = path.join(dataRoot, 'sessions', `${encodeURIComponent(sessionId)}.events.jsonl`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
}

test('会话统计：?groupId 只返回该群的行，不传返回全部', async (t) => {
  const harness = await startGatewayHarness(t);
  await writeTwoGroupRows(harness.dataRoot);

  const filtered = await harness.request(`/_team/stats/session/${SESSION_ID}?groupId=agnes`);
  const all = await harness.request(`/_team/stats/session/${SESSION_ID}`);

  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.rows.length, 1, '按群隔离后只剩该群一条');
  assert.equal(filtered.body.rows[0].account.id, 'agnes');
  assert.equal(filtered.body.rows[0].model, 'model-of-agnes');

  assert.equal(all.body.rows.length, 2, '不传 groupId 时保持旧行为（全部）');
  assert.deepEqual(all.body.rows.map((row) => row.account.id).sort(), ['agnes', 'workbuddy']);
});

test('会话统计：groupId 命中不存在的群 → 200 + 空数组', async (t) => {
  const harness = await startGatewayHarness(t);
  await writeTwoGroupRows(harness.dataRoot);

  const response = await harness.request(`/_team/stats/session/${SESSION_ID}?groupId=no-such-group`);

  assert.equal(response.status, 200, '不存在的群不是 404');
  assert.deepEqual(response.body.rows, []);
});

test('事件写入：单模型带目标群 platformId，分组带 null', async (t) => {
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

  await harness.request('/_team/session/sess-model-switch/target', {
    method: 'PUT',
    body: { type: 'model', id: 'model-a', platformId: 'agnes' },
  });
  await harness.request('/_team/session/sess-group-switch/target', {
    method: 'PUT',
    body: { type: 'group', id: 'ha-group' },
  });

  const modelEvents = (await harness.request('/_team/session/sess-model-switch/events')).body.events;
  const groupEvents = (await harness.request('/_team/session/sess-group-switch/events')).body.events;

  assert.deepEqual(modelEvents.map((event) => event.platformId), ['agnes', 'agnes']);
  assert.deepEqual(groupEvents.map((event) => event.platformId), [null, null], '分组事件不归属单群');
});

test('事件读取：?groupId 过滤生效，分组切换的 null 事件不返回', async (t) => {
  const harness = await startGatewayHarness(t);
  const sessionId = 'sess-event-filter';
  await appendRawEvent(harness.dataRoot, sessionId, { time: '10:00:00', at: '2026-11-02T10:00:00+08:00', type: 'system', text: '群A事件', platformId: 'agnes' });
  await appendRawEvent(harness.dataRoot, sessionId, { time: '10:01:00', at: '2026-11-02T10:01:00+08:00', type: 'system', text: '分组事件', platformId: null });
  await appendRawEvent(harness.dataRoot, sessionId, { time: '10:02:00', at: '2026-11-02T10:02:00+08:00', type: 'system', text: '群B事件', platformId: 'workbuddy' });

  const filtered = await harness.request(`/_team/session/${sessionId}/events?groupId=agnes`);
  const all = await harness.request(`/_team/session/${sessionId}/events`);

  assert.deepEqual(filtered.body.events.map((event) => event.text), ['群A事件']);
  assert.equal(all.body.events.length, 3, '不传 groupId 返回全部（兼容）');
});

test('历史事件没有 platformId：出参补 null（字段仍在）', async (t) => {
  const harness = await startGatewayHarness(t);
  const sessionId = 'sess-legacy-platform';
  await appendRawEvent(harness.dataRoot, sessionId, { time: '09:00:00', type: 'system', text: '旧事件' });

  const events = (await harness.request(`/_team/session/${sessionId}/events`)).body.events;

  assert.equal(events.length, 1);
  assert.equal('platformId' in events[0], true, '字段不能消失');
  assert.strictEqual(events[0].platformId, null);

  const filtered = await harness.request(`/_team/session/${sessionId}/events?groupId=agnes`);
  assert.deepEqual(filtered.body.events, [], '没有群归属的历史事件在指定群时不返回');
});
