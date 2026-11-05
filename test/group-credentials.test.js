// 加群表单用例：明文 apiKey 落盘为凭证文件、配置只存 file: 引用、响应不回显；
// 以及 modelSource=auto/manual 如何落到群的 models 上。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startGatewayHarness } from './helpers/gateway-harness.js';
import { readConfig } from '../src/gateway/config/config.js';

// 测试用假明文（不是真实凭据）
const SUBMITTED_API_KEY = 'plaintext-input-for-test-only';
const FORM_GROUP_ID = 'form-group';
const SUBMITTED_API_KEY_REF = 'env:DSH_MODEL_TEAM_TEST_API_KEY';

// 前端按 authSchema 渲染后提交的扁平表单
function buildFormSubmission(baseURL, overrides = {}) {
  return {
    id: FORM_GROUP_ID,
    name: '表单群',
    accessMode: 'official',
    driver: 'openai-compatible',
    baseURL,
    apiKey: SUBMITTED_API_KEY,
    modelSource: 'auto',
    ...overrides,
  };
}

async function readStoredGroup(dataRoot, groupId = FORM_GROUP_ID) {
  const config = await readConfig({ dataRoot });
  return config.groups.find((group) => group.id === groupId) ?? null;
}

test('明文 apiKey：落盘为凭证文件、配置只存 file: 引用、响应不回显', async (t) => {
  const harness = await startGatewayHarness(t);
  const createResponse = await harness.request('/_team/groups', {
    method: 'POST',
    body: buildFormSubmission(harness.stubUpstream.baseURL),
  });

  assert.equal(createResponse.status, 201);
  assert.equal(JSON.stringify(createResponse.body).includes(SUBMITTED_API_KEY), false, '响应绝不回显明文 Key');
  assert.equal(createResponse.body.group.auth.apiKeyRef, `file:credentials/${FORM_GROUP_ID}.key`);

  const storedGroup = await readStoredGroup(harness.dataRoot);
  assert.deepEqual(storedGroup.auth, { type: 'bearer', apiKeyRef: `file:credentials/${FORM_GROUP_ID}.key` });
  const storedConfigText = await fs.readFile(path.join(harness.dataRoot, 'config.json'), 'utf8');
  assert.equal(storedConfigText.includes(SUBMITTED_API_KEY), false, '配置文件里不能出现明文');

  const credentialFile = path.join(harness.dataRoot, 'credentials', `${FORM_GROUP_ID}.key`);
  assert.equal(await fs.readFile(credentialFile, 'utf8'), SUBMITTED_API_KEY, '明文按群落盘且内容一致');
  // 权限尽量收紧（不支持 chmod 的环境只 warn）：弱断言"组/其他位没有可读写"
  const fileStats = await fs.stat(credentialFile);
  assert.equal((fileStats.mode & 0o077) === 0, true);
});

test('落盘的 file: 引用可被真正使用（拉模型列表不报凭证错误）', async (t) => {
  const harness = await startGatewayHarness(t);
  await harness.request('/_team/groups', {
    method: 'POST',
    body: buildFormSubmission(harness.stubUpstream.baseURL, { modelSource: 'manual', manualModels: 'form-model-a' }),
  });

  const modelsResponse = await harness.request(`/_team/groups/${FORM_GROUP_ID}/models`);

  assert.equal(modelsResponse.status, 200);
  assert.deepEqual(modelsResponse.body.models.map((model) => model.id), ['form-model-a']);
});

test('只给 apiKeyRef：行为不变，不产生凭证文件', async (t) => {
  const harness = await startGatewayHarness(t);
  const createResponse = await harness.request('/_team/groups', {
    method: 'POST',
    body: {
      id: 'ref-only-group',
      name: '引用群',
      accessMode: 'official',
      driver: 'openai-compatible',
      baseURL: harness.stubUpstream.baseURL,
      auth: { type: 'bearer', apiKeyRef: SUBMITTED_API_KEY_REF },
      models: { endpoint: '/models' },
    },
  });

  assert.equal(createResponse.status, 201);
  assert.equal(createResponse.body.group.auth.apiKeyRef, SUBMITTED_API_KEY_REF);

  const credentialFile = path.join(harness.dataRoot, 'credentials', 'ref-only-group.key');
  await assert.rejects(() => fs.stat(credentialFile), '只给引用时不该写凭证文件');
});

test('两者都给：以 apiKeyRef 为准，明文不落盘', async (t) => {
  const harness = await startGatewayHarness(t);
  const createResponse = await harness.request('/_team/groups', {
    method: 'POST',
    body: buildFormSubmission(harness.stubUpstream.baseURL, {
      id: 'both-credential-group',
      apiKeyRef: SUBMITTED_API_KEY_REF,
    }),
  });

  assert.equal(createResponse.status, 201);
  assert.equal(createResponse.body.group.auth.apiKeyRef, SUBMITTED_API_KEY_REF);

  const credentialFile = path.join(harness.dataRoot, 'credentials', 'both-credential-group.key');
  await assert.rejects(() => fs.stat(credentialFile), '引用优先时不应把明文落盘');
});

test('modelSource=manual：models.static 按行拆分、去空行', async (t) => {
  const harness = await startGatewayHarness(t);
  const createResponse = await harness.request('/_team/groups', {
    method: 'POST',
    body: buildFormSubmission(harness.stubUpstream.baseURL, {
      id: 'manual-group',
      modelSource: 'manual',
      manualModels: '  glm-5.3-flash  \n\n deepseek-v4.1-flash\n',
    }),
  });

  assert.equal(createResponse.status, 201);
  const storedGroup = await readStoredGroup(harness.dataRoot, 'manual-group');
  // docs/21：static 统一落成 { id, name }（name 缺省 = id）
  assert.deepEqual(storedGroup.models, {
    static: [
      { id: 'glm-5.3-flash', name: 'glm-5.3-flash' },
      { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' },
    ],
  });
});

test('modelSource 缺省（auto）：models.endpoint 落成 /models', async (t) => {
  const harness = await startGatewayHarness(t);
  await harness.request('/_team/groups', {
    method: 'POST',
    body: buildFormSubmission(harness.stubUpstream.baseURL, { id: 'auto-group', modelSource: undefined }),
  });

  const storedGroup = await readStoredGroup(harness.dataRoot, 'auto-group');
  assert.deepEqual(storedGroup.models, { endpoint: '/models' });
});

test('manual 但没填模型名 → 400 明确错误', async (t) => {
  const harness = await startGatewayHarness(t);
  const createResponse = await harness.request('/_team/groups', {
    method: 'POST',
    body: buildFormSubmission(harness.stubUpstream.baseURL, { modelSource: 'manual', manualModels: '   \n  ' }),
  });

  assert.equal(createResponse.status, 400);
  assert.equal(createResponse.body.error.code, 'invalid-request');
  assert.equal(createResponse.body.error.message.includes('模型名'), true);
});

test('apiKey 与 apiKeyRef 都不给 → 400 明确错误', async (t) => {
  const harness = await startGatewayHarness(t);
  const createResponse = await harness.request('/_team/groups', {
    method: 'POST',
    body: {
      id: 'no-credential-group',
      name: '无凭证群',
      accessMode: 'official',
      driver: 'openai-compatible',
      baseURL: harness.stubUpstream.baseURL,
      models: { endpoint: '/models' },
    },
  });

  assert.equal(createResponse.status, 400);
  assert.equal(createResponse.body.error.message.includes('缺少 API Key'), true);
});

// G-11 契约：删除群时回收它独占的凭证文件（移入 <dataRoot>/.trash/，可恢复）。
// 反面教材：删群后 credentials/<id>.key 残留，凭据长期累积无人回收。
test('删群：独占的凭证文件被移入 .trash', async (t) => {
  const harness = await startGatewayHarness(t);
  await harness.request('/_team/groups', {
    method: 'POST',
    body: buildFormSubmission(harness.stubUpstream.baseURL, { id: 'to-remove', name: 'to-remove' }),
  });
  const credentialPath = path.join(harness.dataRoot, 'credentials', 'to-remove.key');
  await fs.access(credentialPath);

  const removed = await harness.request('/_team/groups/to-remove', { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.credentialCleanup.skipped, false);

  await assert.rejects(fs.access(credentialPath));
  const trashEntries = await fs.readdir(path.join(harness.dataRoot, '.trash'));
  assert.equal(trashEntries.some((name) => name.endsWith('to-remove.key')), true);
});

// 其它群仍引用同一凭证文件时不得回收
test('删群：凭证仍被其它群引用时跳过回收', async (t) => {
  const harness = await startGatewayHarness(t);
  await fs.mkdir(path.join(harness.dataRoot, 'credentials'), { recursive: true });
  await fs.writeFile(path.join(harness.dataRoot, 'credentials', 'shared.key'), 'k', 'utf8');
  for (const groupId of ['shared-a', 'shared-b']) {
    await harness.request('/_team/groups', {
      method: 'POST',
      body: {
        id: groupId, name: groupId, accessMode: 'official', driver: 'openai-compatible',
        baseURL: harness.stubUpstream.baseURL,
        auth: { type: 'bearer', apiKeyRef: 'file:credentials/shared.key' },
        models: { static: ['m1'] },
      },
    });
  }

  const removed = await harness.request('/_team/groups/shared-a', { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.credentialCleanup.skipped, true);
  assert.equal(removed.body.credentialCleanup.reason, 'still-referenced');
  await fs.access(path.join(harness.dataRoot, 'credentials', 'shared.key'));
});
