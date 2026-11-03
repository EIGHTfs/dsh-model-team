// 模型目录归一用例（docs/21）：static 同时接受字符串与 { id, name }，落盘统一、出参统一、重复 id 去重。

import test from 'node:test';
import assert from 'node:assert/strict';
import { startGatewayHarness } from './helpers/gateway-harness.js';
import { readConfig } from '../src/gateway/config.js';
import { normalizeModelList } from '../src/gateway/model-catalog.js';
import { createRecordingLogger } from './helpers/test-environment.js';

function buildStaticGroupPayload(baseURL, staticModels, overrides = {}) {
  return {
    id: 'static-group',
    name: '静态模型群',
    accessMode: 'official',
    driver: 'openai-compatible',
    baseURL,
    apiKey: 'test-key-not-real',
    modelSource: 'manual',
    models: { static: staticModels },
    ...overrides,
  };
}

async function readStoredStaticModels(harness, groupId = 'static-group') {
  const config = await readConfig({ dataRoot: harness.dataRoot });
  const group = config.groups.find((entry) => entry.id === groupId);
  return group?.models?.static ?? null;
}

test('①字符串数组：归一后 name = id（落盘也是对象）', async (t) => {
  const harness = await startGatewayHarness(t);
  const createResponse = await harness.request('/_team/groups', {
    method: 'POST',
    body: buildStaticGroupPayload(harness.stubUpstream.baseURL, ['model-a', 'model-b']),
  });

  assert.equal(createResponse.status, 201);
  assert.deepEqual(await readStoredStaticModels(harness), [
    { id: 'model-a', name: 'model-a' },
    { id: 'model-b', name: 'model-b' },
  ]);
});

test('②对象数组：原样保留 name', async (t) => {
  const harness = await startGatewayHarness(t);
  await harness.request('/_team/groups', {
    method: 'POST',
    body: buildStaticGroupPayload(harness.stubUpstream.baseURL, [
      { id: 'model-a', name: '全局 · model-a' },
      { id: 'model-b' },
    ]),
  });

  assert.deepEqual(await readStoredStaticModels(harness), [
    { id: 'model-a', name: '全局 · model-a' },
    { id: 'model-b', name: 'model-b' },
  ]);
});

test('③混合数组：字符串与对象都能归一', async (t) => {
  const harness = await startGatewayHarness(t);
  await harness.request('/_team/groups', {
    method: 'POST',
    body: buildStaticGroupPayload(harness.stubUpstream.baseURL, ['model-a', { id: 'model-b', name: 'B 显示名' }]),
  });

  assert.deepEqual(await readStoredStaticModels(harness), [
    { id: 'model-a', name: 'model-a' },
    { id: 'model-b', name: 'B 显示名' },
  ]);
});

test('④重复 id：只保留第一条，并 warn 一次', async (t) => {
  const harness = await startGatewayHarness(t);
  await harness.request('/_team/groups', {
    method: 'POST',
    body: buildStaticGroupPayload(harness.stubUpstream.baseURL, [
      { id: 'model-a', name: '第一条' },
      { id: 'model-a', name: '第二条应被丢弃' },
    ]),
  });

  assert.deepEqual(await readStoredStaticModels(harness), [{ id: 'model-a', name: '第一条' }]);

  // 单测再确认 warn 只出现一次
  const logger = createRecordingLogger();
  const normalized = normalizeModelList(['dup', 'dup', 'dup'], { logger });
  assert.deepEqual(normalized, [{ id: 'dup', name: 'dup' }]);
  const warnLines = logger.lines.filter((line) => line.level === 'warn' && line.message.includes('模型 id 重复'));
  assert.equal(warnLines.length, 1, '重复只 warn 一次');
});

test('⑤GET /_team/groups/:id/models：static 群返回统一 { id, name }', async (t) => {
  const harness = await startGatewayHarness(t);
  await harness.request('/_team/groups', {
    method: 'POST',
    body: buildStaticGroupPayload(harness.stubUpstream.baseURL, ['model-a', { id: 'model-b', name: 'B 显示名' }]),
  });

  const modelsResponse = await harness.request('/_team/groups/static-group/models');

  assert.equal(modelsResponse.status, 200);
  assert.deepEqual(modelsResponse.body.models, [
    { id: 'model-a', name: 'model-a' },
    { id: 'model-b', name: 'B 显示名' },
  ]);
});
