// 好友分组端到端用例（docs/11 §69-76）：4 个端点、引用保护、单模型/分组并存切换、旧结构派发。

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGroup, chatAs, selectModelRequest, startGatewayHarness } from './helpers/gateway-harness.js';
import { writeSessionMapping } from '../src/gateway/session/store.js';

// 两个群共用同一个 stub 上游：靠"模型名"区分实际由谁接活
function buildTwoGroupConfig(stubBaseURL, friendGroups = []) {
  return {
    groups: [
      buildGroup({ id: 'agnes', name: '群A', baseURL: stubBaseURL, models: { static: ['model-a', 'model-b'] } }),
      buildGroup({ id: 'workbuddy', name: '群B', baseURL: stubBaseURL, models: { static: ['model-c', 'model-d'] } }),
    ],
    friendGroups,
  };
}

const ROUND_ROBIN_GROUP = {
  id: 'ha-group',
  name: '高可用组',
  strategy: 'round-robin',
  members: [
    { platformId: 'agnes', modelId: 'model-a' },
    { platformId: 'workbuddy', modelId: 'model-c' },
  ],
};

async function startHarnessWithGroups(t, friendGroups = [ROUND_ROBIN_GROUP]) {
  const harness = await startGatewayHarness(t, { groups: [] });
  // harness 先建了临时数据根与 stub 上游，这里按 stub 地址写入完整配置
  const { writeConfig } = await import('../src/gateway/config/config.js');
  await writeConfig(
    { ...buildTwoGroupConfig(harness.stubUpstream.baseURL, friendGroups), http: { externalOpenAiCompat: true } },
    { dataRoot: harness.dataRoot },
  );
  return harness;
}

test('分组端点：创建 201、列表带成员与游标、非法配置 400', async (t) => {
  const harness = await startHarnessWithGroups(t);

  const createResult = await harness.request('/_team/friend-groups', {
    method: 'POST',
    body: ROUND_ROBIN_GROUP,
  });
  assert.equal(createResult.status, 201);
  assert.equal(createResult.body.group.id, 'ha-group');

  const listResult = await harness.request('/_team/friend-groups');
  assert.equal(listResult.status, 200);
  assert.equal(listResult.body.groups.length, 1);
  assert.equal(listResult.body.groups[0].members.length, 2);
  assert.equal(listResult.body.groups[0].cursor, 0, '列表要能看到当前游标位置');

  const invalidResult = await harness.request('/_team/friend-groups', {
    method: 'POST',
    body: { id: 'bad-group', name: '空组', strategy: 'round-robin', members: [] },
  });
  assert.equal(invalidResult.status, 400);
  assert.equal(invalidResult.body.error.code, 'invalid-request');
});

test('删除分组：被会话引用时 409 + 引用计数，切走后可删', async (t) => {
  const harness = await startHarnessWithGroups(t);

  await harness.request('/_team/session/sess-using-group/target', {
    method: 'PUT',
    body: { type: 'group', id: 'ha-group' },
  });

  const blockedDelete = await harness.request('/_team/friend-groups/ha-group', { method: 'DELETE' });
  assert.equal(blockedDelete.status, 409);
  assert.equal(blockedDelete.body.error.code, 'friend-group-in-use');
  assert.equal(blockedDelete.body.error.details.referencedSessions, 1);

  await harness.request('/_team/session/sess-using-group/model', selectModelRequest('agnes', 'model-a'));
  const successDelete = await harness.request('/_team/friend-groups/ha-group', { method: 'DELETE' });
  assert.equal(successDelete.status, 200);
  assert.deepEqual(successDelete.body, { removed: 'ha-group' });
});

test('并存切换：单模型 → 分组 → 再回单模型，三次派发各走对应路径', async (t) => {
  const harness = await startHarnessWithGroups(t);

  // 1) 单模型
  await harness.request('/_team/session/sess-switch/model', selectModelRequest('agnes', 'model-a'));
  const firstChat = await harness.request('/v1/chat/completions', chatAs('sess-switch'));
  assert.equal(firstChat.status, 200);
  let upstreamBody = JSON.parse(harness.stubUpstream.requests.at(-1).bodyText);
  assert.equal(upstreamBody.model, 'model-a', '单模型必须直连');

  // 2) 切到分组（轮换组）
  const groupTargetResult = await harness.request('/_team/session/sess-switch/target', {
    method: 'PUT',
    body: { type: 'group', id: 'ha-group' },
  });
  assert.equal(groupTargetResult.status, 200);
  assert.deepEqual(groupTargetResult.body.target, { type: 'group', id: 'ha-group' });

  const groupChat = await harness.request('/v1/chat/completions', chatAs('sess-switch'));
  assert.equal(groupChat.status, 200);
  upstreamBody = JSON.parse(harness.stubUpstream.requests.at(-1).bodyText);
  assert.equal(['model-a', 'model-c'].includes(upstreamBody.model), true, '分组派发要落到真实成员模型上');

  const groupRow = (await harness.request('/_team/stats/session/sess-switch')).body.rows.at(-1);
  assert.equal(groupRow.groupId, 'ha-group', '请求行要能看出本轮由分组派出');
  assert.equal(['model-a', 'model-c'].includes(groupRow.model), true, 'INV-11：model 记真实模型而不是分组名');

  // 3) 再切回单模型：必须恢复直连
  await harness.request('/_team/session/sess-switch/model', selectModelRequest('workbuddy', 'model-d'));
  const thirdChat = await harness.request('/v1/chat/completions', chatAs('sess-switch'));
  assert.equal(thirdChat.status, 200);
  upstreamBody = JSON.parse(harness.stubUpstream.requests.at(-1).bodyText);
  assert.equal(upstreamBody.model, 'model-d', '切回单模型后不得再走轮换');
});

test('旧结构 {platform, model} 仍能正常派发（兼容历史数据）', async (t) => {
  const harness = await startHarnessWithGroups(t);
  await writeSessionMapping(
    'sess-legacy',
    { platform: 'agnes', model: 'model-b', updatedAt: '2026-11-02T18:00:00+08:00' },
    { dataRoot: harness.dataRoot },
  );

  const chatResult = await harness.request('/v1/chat/completions', chatAs('sess-legacy'));

  assert.equal(chatResult.status, 200);
  assert.equal(JSON.parse(harness.stubUpstream.requests.at(-1).bodyText).model, 'model-b');
});

test('分组目标不存在时 PUT 直接 404；单模型目标给未知群也 404', async (t) => {
  const harness = await startHarnessWithGroups(t);

  const unknownGroup = await harness.request('/_team/session/sess-x/target', {
    method: 'PUT',
    body: { type: 'group', id: 'not-exist-group' },
  });
  assert.equal(unknownGroup.status, 404);
  assert.equal(unknownGroup.body.error.code, 'friend-group-not-found');

  const unknownPlatform = await harness.request('/_team/session/sess-x/target', {
    method: 'PUT',
    body: { type: 'model', id: 'whatever', platformId: 'not-exist-platform' },
  });
  assert.equal(unknownPlatform.status, 404);
  assert.equal(unknownPlatform.body.error.code, 'group-not-found');
});
