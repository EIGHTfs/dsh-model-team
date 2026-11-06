// PATCH /_team/groups/:id（部分更新）用例：只改传入字段、id 不可变、明文 Key 仍拒收、移除模型给 warnings。
// 全部打真网关（监听 0 端口）+ 临时数据根；改造后用 GET 读回、用真实凭据解析确认引用生效。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { startGatewayHarness } from './helpers/gateway-harness.js';
import { resolveApiKeyRef } from '../src/gateway/config/credentials.js';
import { writeSessionMapping } from '../src/gateway/session/store.js';

const PATCH_GROUP_PATH = '/_team/groups/agnes';

// 写回时 models.static 会按导入/建群同一套规则归一成 { id, name }，比较时只看 id 列表
function modelIdsOf(group) {
  return (group?.models?.static ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.id));
}

async function readGroup(harness) {
  const detail = await harness.request(PATCH_GROUP_PATH);
  assert.equal(detail.status, 200);
  return detail.body.group;
}

test('PATCH：只改 name，其它字段（尤其 auth 引用）保持不变', async (t) => {
  const harness = await startGatewayHarness(t);
  const before = await readGroup(harness);

  const patched = await harness.request(PATCH_GROUP_PATH, { method: 'PATCH', body: { name: '改过名的群' } });

  assert.equal(patched.status, 200);
  assert.equal(patched.body.group.name, '改过名的群');
  assert.deepEqual(patched.body.group.auth, before.auth, 'auth 不带 apiKeyRef 时不能清空');
  assert.equal(patched.body.group.baseURL, before.baseURL);
  assert.deepEqual(modelIdsOf(patched.body.group), modelIdsOf(before), '未传 models 时模型清单不能变');
  assert.deepEqual(patched.body.group.request, before.request);

  const after = await readGroup(harness);
  assert.equal(after.name, '改过名的群', 'GET 要读回新名字');
});

test('PATCH：改 baseURL 生效且只动该字段', async (t) => {
  const harness = await startGatewayHarness(t);
  const before = await readGroup(harness);
  const nextBaseURL = 'http://127.0.0.1:12345/v2';

  const patched = await harness.request(PATCH_GROUP_PATH, { method: 'PATCH', body: { baseURL: nextBaseURL } });

  assert.equal(patched.status, 200);
  assert.equal(patched.body.group.baseURL, nextBaseURL);
  assert.equal(patched.body.group.name, before.name);
  assert.deepEqual(patched.body.group.auth, before.auth);
});

test('PATCH：改 auth.apiKeyRef，写回后凭证仍能解析', async (t) => {
  const harness = await startGatewayHarness(t);
  const relativeKeyPath = 'keys/patch-group.key';
  const keyContent = 'sk-patch-key';
  const absoluteKeyPath = path.join(harness.dataRoot, relativeKeyPath);
  await fs.mkdir(path.dirname(absoluteKeyPath), { recursive: true });
  await fs.writeFile(absoluteKeyPath, keyContent, 'utf8');

  const patched = await harness.request(PATCH_GROUP_PATH, {
    method: 'PATCH',
    body: { auth: { apiKeyRef: `file:${relativeKeyPath}` } },
  });

  assert.equal(patched.status, 200);
  assert.equal(patched.body.group.auth.apiKeyRef, `file:${relativeKeyPath}`);

  const resolved = await resolveApiKeyRef(`file:${relativeKeyPath}`, { dataRoot: harness.dataRoot });
  assert.equal(resolved.ok, true, '引用必须仍可解析');
  assert.equal(resolved.value, keyContent);
});

test('PATCH：改 models 整体替换；被移除且被会话目标引用的模型进 warnings', async (t) => {
  const harness = await startGatewayHarness(t);
  const removedModelId = 'agnes-2.5-flash';
  // 造一条指向"将被移除的模型"的会话目标：warnings 应点名这个会话
  await writeSessionMapping('session-uses-removed-model', {
    platform: 'agnes',
    model: removedModelId,
    updatedAt: '2026-11-06T10:00:00+08:00',
  }, { dataRoot: harness.dataRoot });

  const patched = await harness.request(PATCH_GROUP_PATH, {
    method: 'PATCH',
    body: { models: { static: ['agnes-3.0-flash'] } },
  });

  assert.equal(patched.status, 200);
  assert.deepEqual(modelIdsOf(patched.body.group), ['agnes-3.0-flash']);
  assert.equal(Array.isArray(patched.body.warnings), true);
  assert.equal(patched.body.warnings.length, 1);
  assert.equal(patched.body.warnings[0].includes(removedModelId), true, 'warnings 要点名被移除的模型');
  assert.equal(patched.body.warnings[0].includes('session-uses-removed-model'), true, '能扫到会话就点名');
  assert.equal(patched.body.warnings[0].includes('MODEL_UNRESOLVED'), true);
});

test('PATCH：模型没变时不给 warnings（不制造噪音）', async (t) => {
  const harness = await startGatewayHarness(t);

  const patched = await harness.request(PATCH_GROUP_PATH, {
    method: 'PATCH',
    body: { models: { static: ['agnes-3.0-flash', 'agnes-2.5-flash'] } },
  });

  assert.equal(patched.status, 200);
  assert.equal('warnings' in patched.body, false);
});

test('PATCH：群不存在 → 404', async (t) => {
  const harness = await startGatewayHarness(t);

  const patched = await harness.request('/_team/groups/not-here', { method: 'PATCH', body: { name: 'x' } });

  assert.equal(patched.status, 404);
  assert.equal(patched.body.error.code, 'group-not-found');
});

test('PATCH：body 里的 id 与路径不一致 → 400（id 不可改）', async (t) => {
  const harness = await startGatewayHarness(t);

  const patched = await harness.request(PATCH_GROUP_PATH, { method: 'PATCH', body: { id: 'another-id', name: 'x' } });

  assert.equal(patched.status, 400);
  assert.equal(patched.body.error.code, 'invalid-request');
});

test('PATCH：明文 apiKey 仍拒收 → 400', async (t) => {
  const harness = await startGatewayHarness(t);

  const patched = await harness.request(PATCH_GROUP_PATH, {
    method: 'PATCH',
    body: { auth: { apiKey: 'sk-leak' } },
  });

  assert.equal(patched.status, 400);
  assert.equal(patched.body.error.code, 'invalid-request');
  assert.equal(patched.body.error.message.includes('明文凭证'), true);
});

test('PATCH：字段类型非法 → 400，且原群不被改动', async (t) => {
  const harness = await startGatewayHarness(t);
  const before = await readGroup(harness);

  const patched = await harness.request(PATCH_GROUP_PATH, { method: 'PATCH', body: { models: { static: [] } } });

  assert.equal(patched.status, 400);
  assert.equal(patched.body.error.code, 'invalid-request');
  const after = await readGroup(harness);
  assert.deepEqual(after, before, '校验失败不能留下半改状态');
});
