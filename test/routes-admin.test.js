// 管理端点用例：驱动列表、群增删改查、模型列表、测试连接、会话映射与事件、导入导出、错误矩阵。
// 全部打真网关（监听 0 端口）+ 本地 stub 上游，覆盖 docs/09 §6/§7 的端点与错误形状。

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGroup, startGatewayHarness } from './helpers/gateway-harness.js';

// 加群请求体：默认指向 stub 上游
function buildGroupPayload(baseURL, overrides = {}) {
  return {
    id: 'new-group',
    name: '新群',
    accessMode: 'official',
    driver: 'openai-compatible',
    baseURL,
    auth: { type: 'bearer', apiKeyRef: 'env:DSH_MODEL_TEAM_TEST_API_KEY' },
    models: { static: ['m1'] },
    ...overrides,
  };
}

test('驱动端点：返回 DriverMeta[]，official 排在前', async (t) => {
  const harness = await startGatewayHarness(t);

  const driversResponse = await harness.request('/_team/drivers');

  assert.equal(driversResponse.status, 200);
  assert.equal(Array.isArray(driversResponse.body), true);
  assert.equal(driversResponse.body[0].accessMode, 'official');
  assert.equal(driversResponse.body.some((driverMeta) => driverMeta.id === 'openai-compatible'), true);
});

test('群列表与详情：含渲染后的 summary', async (t) => {
  const harness = await startGatewayHarness(t, {
    groupOverrides: { summary: { template: '模型 {modelCount} 个 · {accessMode}', source: null } },
  });

  const listResponse = await harness.request('/_team/groups');
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.body.groups.length, 1);
  assert.equal(listResponse.body.groups[0].summary, '模型 2 个 · official');

  const detailResponse = await harness.request('/_team/groups/agnes');
  assert.equal(detailResponse.status, 200);
  assert.equal(detailResponse.body.group.id, 'agnes');

  const missingResponse = await harness.request('/_team/groups/not-exist');
  assert.equal(missingResponse.status, 404);
  assert.equal(missingResponse.body.error.code, 'group-not-found');
});

test('加群：201 落盘后可读；重复 id 409；非法结构 400；明文凭证 400', async (t) => {
  const harness = await startGatewayHarness(t);
  const groupPayload = buildGroupPayload(harness.stubUpstream.baseURL);

  const createResponse = await harness.request('/_team/groups', { method: 'POST', body: groupPayload });
  assert.equal(createResponse.status, 201);
  assert.equal(createResponse.body.group.id, 'new-group');

  const createdDetail = await harness.request('/_team/groups/new-group');
  assert.equal(createdDetail.body.group.name, '新群');

  const duplicateResponse = await harness.request('/_team/groups', { method: 'POST', body: groupPayload });
  assert.equal(duplicateResponse.status, 409);
  assert.equal(duplicateResponse.body.error.code, 'group-exists');

  const invalidResponse = await harness.request('/_team/groups', {
    method: 'POST',
    body: buildGroupPayload(harness.stubUpstream.baseURL, { id: 'bad id with space' }),
  });
  assert.equal(invalidResponse.status, 400);
  assert.equal(invalidResponse.body.error.code, 'invalid-request');

  const plaintextResponse = await harness.request('/_team/groups', {
    method: 'POST',
    body: buildGroupPayload(harness.stubUpstream.baseURL, {
      id: 'plain-group',
      // apiKey 现在是允许的入参（会落盘为凭证文件）；仍禁止其它明文凭证字段
      auth: { type: 'bearer', token: 'plaintext-should-be-rejected' },
    }),
  });
  assert.equal(plaintextResponse.status, 400);
  assert.equal(plaintextResponse.body.error.message.includes('明文凭证'), true);
});

test('删群：成功 200，重复删 404', async (t) => {
  const harness = await startGatewayHarness(t);

  const removeResponse = await harness.request('/_team/groups/agnes', { method: 'DELETE' });
  assert.equal(removeResponse.status, 200);
  assert.equal(removeResponse.body.removed, 'agnes');

  const secondRemove = await harness.request('/_team/groups/agnes', { method: 'DELETE' });
  assert.equal(secondRemove.status, 404);
});

test('群的模型列表：走上游 /models；测试连接只回报结论', async (t) => {
  const harness = await startGatewayHarness(t, { groupOverrides: { models: { endpoint: '/models' } } });

  const modelsResponse = await harness.request('/_team/groups/agnes/models');
  assert.equal(modelsResponse.status, 200);
  assert.deepEqual(modelsResponse.body.models.map((modelEntry) => modelEntry.id), ['agnes-3.0-flash', 'agnes-2.5-flash']);

  const verifyResponse = await harness.request('/_team/groups/agnes/verify', { method: 'POST' });
  assert.equal(verifyResponse.status, 200);
  assert.equal(verifyResponse.body.ok, true);

  // verify 不该产生请求行
  const statsResponse = await harness.request('/_team/stats/global');
  assert.equal(statsResponse.body.totalRows, 0);
});

test('会话映射：读缺失 404、写成功后读得到、事件流同步追加 @消息', async (t) => {
  const harness = await startGatewayHarness(t);

  const missingMapping = await harness.request('/_team/session/sess-01/model');
  assert.equal(missingMapping.status, 200, 'docs/09 §10：无映射返回空值，不用 404 当正常态');
  assert.deepEqual(missingMapping.body, { platform: null, model: null });

  const writeMapping = await harness.request('/_team/session/sess-01/model', {
    method: 'PUT',
    body: { platform: 'agnes', model: 'agnes-3.0-flash' },
  });
  assert.equal(writeMapping.status, 200);
  assert.equal(writeMapping.body.model, 'agnes-3.0-flash');
  assert.equal(writeMapping.body.platform, 'agnes');
  // 写 model 等价于写 { type:'model', id, platformId } 的会话目标（docs/11 §76）
  assert.deepEqual(writeMapping.body.target, { type: 'model', id: 'agnes-3.0-flash', platformId: 'agnes' });

  const readMapping = await harness.request('/_team/session/sess-01/model');
  assert.equal(readMapping.body.platform, 'agnes');

  const eventsResponse = await harness.request('/_team/session/sess-01/events');
  const sessionEvents = eventsResponse.body.events;
  assert.equal(sessionEvents.length, 2, '一次切换落两条：@目标 + 系统提示（刷新后不丢）');
  assert.equal(sessionEvents[0].type, 'self-message');
  assert.equal(sessionEvents[0].text, '@agnes-3.0-flash');
  assert.equal(sessionEvents[1].type, 'system');
  assert.equal(sessionEvents[1].text, '你 @ 了 agnes-3.0-flash 并切换了当前会话模型');
  assert.match(sessionEvents[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test('会话映射：缺字段 400、群不存在 404、sessionId 路径穿越 400', async (t) => {
  const harness = await startGatewayHarness(t);

  const missingFields = await harness.request('/_team/session/sess-02/model', {
    method: 'PUT',
    body: { model: 'agnes-3.0-flash' },
  });
  assert.equal(missingFields.status, 400);
  assert.equal(missingFields.body.error.code, 'invalid-request');

  const unknownGroup = await harness.request('/_team/session/sess-02/model', {
    method: 'PUT',
    body: { platform: 'not-a-group', model: 'm' },
  });
  assert.equal(unknownGroup.status, 404);

  const pathTraversal = await harness.request('/_team/session/..%2F..%2Fetc/model');
  assert.equal(pathTraversal.status, 400);
  assert.equal(pathTraversal.body.error.code, 'invalid-request');
});

test('导出与导入：合并 upsert / 明文凭证被拒 / replace 需确认', async (t) => {
  const harness = await startGatewayHarness(t);

  const exportResponse = await harness.request('/_team/export');
  assert.equal(exportResponse.status, 200);
  assert.equal(exportResponse.body.version, 1);
  assert.equal(exportResponse.body.groups.length, 1);

  const importResponse = await harness.request('/_team/import', {
    method: 'POST',
    body: {
      groups: [
        buildGroupPayload(harness.stubUpstream.baseURL, { id: 'imported-group' }),
        buildGroupPayload(harness.stubUpstream.baseURL, { id: 'agnes', name: '改过名的群' }),
        { id: 'leaky-group', name: '带明文', accessMode: 'official', driver: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', auth: { apiKey: 'sk-leak' } },
      ],
    },
  });
  assert.equal(importResponse.status, 200);
  assert.equal(importResponse.body.imported, 1);
  assert.equal(importResponse.body.updated, 1);
  assert.equal(importResponse.body.rejected.length, 1);
  assert.equal(importResponse.body.rejected[0].index, 2);
  assert.equal(importResponse.body.rejected[0].reason.includes('明文凭证'), true);

  const updatedDetail = await harness.request('/_team/groups/agnes');
  assert.equal(updatedDetail.body.group.name, '改过名的群');

  const replaceWithoutConfirm = await harness.request('/_team/import', {
    method: 'POST',
    body: { mode: 'replace', groups: [] },
  });
  assert.equal(replaceWithoutConfirm.status, 409);
  assert.equal(replaceWithoutConfirm.body.error.code, 'confirmation-required');

  const replaceWithConfirm = await harness.request('/_team/import', {
    method: 'POST',
    body: { mode: 'replace', confirm: true, groups: [buildGroupPayload(harness.stubUpstream.baseURL, { id: 'only-group' })] },
  });
  assert.equal(replaceWithConfirm.status, 200);
  const groupsAfterReplace = await harness.request('/_team/groups');
  assert.deepEqual(groupsAfterReplace.body.groups.map((group) => group.id), ['only-group']);
});

test('错误矩阵：404 未知端点、405 方法不符、400 非法 JSON，形状统一', async (t) => {
  const harness = await startGatewayHarness(t);

  const notFound = await harness.request('/_team/nope');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error.code, 'not-found');
  assert.equal(typeof notFound.body.error.hint, 'string');

  const methodNotAllowed = await harness.request('/_team/import');
  assert.equal(methodNotAllowed.status, 405);
  assert.equal(methodNotAllowed.body.error.code, 'method-not-allowed');

  const invalidJsonResponse = await fetch(`${harness.gatewayUrl}/_team/groups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ 这不是 JSON',
  });
  assert.equal(invalidJsonResponse.status, 400);
  const invalidJsonBody = await invalidJsonResponse.json();
  assert.equal(invalidJsonBody.error.code, 'invalid-json');
});

test('会话统计支持 limit 参数：只回最近 N 条', async (t) => {
  const harness = await startGatewayHarness(t);
  await harness.request('/_team/session/sess-limit/model', { method: 'PUT', body: { platform: 'agnes', model: 'agnes-3.0-flash' } });

  for (let requestIndex = 0; requestIndex < 3; requestIndex += 1) {
    await harness.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'X-Tim-Session-Id': 'sess-limit' },
      body: { model: 'dsh-model-team', messages: [{ role: 'user', content: 'hi' }] },
    });
  }

  const limitedStats = await harness.request('/_team/stats/session/sess-limit?limit=2');
  assert.equal(limitedStats.body.rows.length, 2);
});

test('默认群配置里的 accessMode=reverse 也能正常展示（official 优先排序）', async (t) => {
  const harness = await startGatewayHarness(t, {
    groups: [
      buildGroup({ id: 'reverse-group', name: '反代群', accessMode: 'reverse', baseURL: 'http://127.0.0.1:9/v1' }),
      buildGroup({ id: 'official-group', name: '官方群', accessMode: 'official', baseURL: 'http://127.0.0.1:9/v1' }),
    ],
  });

  const groupsResponse = await harness.request('/_team/groups');
  assert.deepEqual(groupsResponse.body.groups.map((group) => group.id).sort(), ['official-group', 'reverse-group']);
});
