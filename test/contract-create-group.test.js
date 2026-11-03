// 契约驱动用例：请求体直接取自 docs/02-契约.md §4.1（冻结），打真实网关的 POST /_team/groups。
//
// 为什么必须是真网关而不是 mock：mock 不校验字段名，正是它让「群配置里驱动字段该叫什么」
// 这类错误在本地一路"通过"，到真机才 400。契约 §4.1：**写入与读出都是 driver**（同名透传，无映射层），
// 写成 driverId 会被后端判 400（`driverId` 只属于 models/probe 请求体与 platforms 预置条目）。
// 所以这里两条断言成对存在：契约字段名 → 201 且落盘；写错字段名 → 400 且不落盘。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { startGatewayHarness } from './helpers/gateway-harness.js';

// 契约 §4.1 的请求体（逐字段照抄，字段名一个不改）
function buildContractPayload(overrides = {}) {
  return {
    id: 'contract-group',
    name: 'sa6400',
    accessMode: 'official',
    driver: 'openai-compatible',
    baseURL: 'https://api.example.com/v1',
    auth: { apiKey: 'sk-contract-test-only' },
    models: { endpoint: '/models' },
    avatar: 'https://example.com/logo.svg',
    summary: { template: '官方接入 · {baseURL}' },
    ...overrides,
  };
}

async function readStoredGroups(dataRoot) {
  const configText = await fsp.readFile(path.join(dataRoot, 'config.json'), 'utf8');
  return JSON.parse(configText).groups ?? [];
}

test('契约 §4.1：driver + 顶层 baseURL + auth.apiKey + models.endpoint + summary.template → 201 且落盘', async (t) => {
  const harness = await startGatewayHarness(t);

  const response = await harness.request('/_team/groups', { method: 'POST', body: buildContractPayload() });

  assert.equal(response.status, 201);
  assert.ok(response.body && response.body.group, '响应体应含 { group }');
  assert.equal(response.body.group.id, 'contract-group');
  assert.equal(response.body.group.name, 'sa6400');
  // POST 回显的是写入形状（driver）；读出映射见下一条用例的 GET 断言
  assert.equal(response.body.group.driver, 'openai-compatible');

  const storedGroups = await readStoredGroups(harness.dataRoot);
  const storedGroup = storedGroups.find((group) => group.id === 'contract-group');
  assert.ok(storedGroup, 'config.json 必须真的包含新群（不是只回显）');
  assert.equal(storedGroup.driver, 'openai-compatible');
  assert.equal(storedGroup.baseURL, 'https://api.example.com/v1');
  assert.equal(storedGroup.auth.apiKeyRef.startsWith('file:'), true, '明文 Key 必须落盘为 file: 引用');

  // 明文 Key 不得出现在配置里（凭证只留引用是硬红线）
  const configText = await fsp.readFile(path.join(harness.dataRoot, 'config.json'), 'utf8');
  assert.equal(configText.includes('sk-contract-test-only'), false);
});

test('契约 §4.1：driver 写成 driverId → 400 且不落盘（不许放宽校验）', async (t) => {
  const harness = await startGatewayHarness(t);

  const invalidPayload = buildContractPayload();
  delete invalidPayload.driver;
  invalidPayload.driverId = 'openai-compatible';

  const response = await harness.request('/_team/groups', { method: 'POST', body: invalidPayload });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'invalid-request');
  assert.match(response.body.error.message, /driver/);

  const storedGroups = await readStoredGroups(harness.dataRoot);
  assert.equal(storedGroups.some((group) => group.id === 'contract-group'), false, '被拒绝的请求不能留下群');
});

test('契约 §4.1：缺少 auth 凭证（apiKey / apiKeyRef 都没有）→ 400', async (t) => {
  const harness = await startGatewayHarness(t);

  const invalidPayload = buildContractPayload({ auth: {} });
  const response = await harness.request('/_team/groups', { method: 'POST', body: invalidPayload });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'invalid-request');
  assert.match(response.body.error.message, /API Key/);
});

test('契约 §4.1：建群后 GET /_team/groups 能读回该群（含 summary 为渲染后字符串）', async (t) => {
  const harness = await startGatewayHarness(t);

  await harness.request('/_team/groups', { method: 'POST', body: buildContractPayload() });
  const listResponse = await harness.request('/_team/groups');

  assert.equal(listResponse.status, 200);
  const listedGroup = (listResponse.body.groups || []).find((group) => group.id === 'contract-group');
  assert.ok(listedGroup, '列表里应能读到刚建的群');
  // 读出形状：summary 是渲染后的字符串（不是 { template } 对象）
  assert.equal(typeof listedGroup.summary, 'string');
  assert.equal(listedGroup.driver, 'openai-compatible');
});

test('契约 §4.1：id 可选 —— 不给 id 时由 name 派生（ASCII 名）', async (t) => {
  const harness = await startGatewayHarness(t);

  const payload = buildContractPayload({ id: undefined, name: 't8 derived' });
  delete payload.id;
  const response = await harness.request('/_team/groups', { method: 'POST', body: payload });

  assert.equal(response.status, 201);
  assert.equal(response.body.group.id, 't8-derived', 'id 应由 name 派生');
});

test('契约 §4.1：id 可选 —— 纯中文名派生不出 ASCII id，用 group-<时间> 兜底', async (t) => {
  const harness = await startGatewayHarness(t);

  const payload = buildContractPayload({ id: undefined, name: '验证群' });
  delete payload.id;
  const response = await harness.request('/_team/groups', { method: 'POST', body: payload });

  assert.equal(response.status, 201);
  assert.match(response.body.group.id, /^group-[a-z0-9]+$/, '中文名应有兜底 id');
});

test('契约 §4.1：同名两次建群（都不给 id）→ 第二个派生 id 加序号，不报 409', async (t) => {
  const harness = await startGatewayHarness(t);

  const payload = buildContractPayload({ id: undefined, name: 'dupe name' });
  delete payload.id;
  const first = await harness.request('/_team/groups', { method: 'POST', body: payload });
  const second = await harness.request('/_team/groups', { method: 'POST', body: payload });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.body.group.id, 'dupe-name');
  assert.equal(second.body.group.id, 'dupe-name-2');
});

test('契约 §4.1：显式 id 撞车 → 409（不能替调用方改名）', async (t) => {
  const harness = await startGatewayHarness(t);

  const first = await harness.request('/_team/groups', { method: 'POST', body: buildContractPayload() });
  const second = await harness.request('/_team/groups', { method: 'POST', body: buildContractPayload({ name: '另一个群' }) });

  assert.equal(first.status, 201);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'group-exists');
});
