// 探测请求体的组装（0.4.0：值归宿主 store/add-form.js）。
//
// 为什么单测这条：请求体字段名是**服务端契约**（driverId / apiKeyRef / baseURL / modelsEndpoint / apiKey），
// 主题不认识它们，全靠这一层组装；组错一个字段，加群页就只会显示"探测失败"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const ADD_FORM_SOURCE = await fs.readFile(new URL('../ui/js/store/add-form.js', import.meta.url), 'utf8');
const DRIVER_VIEW_SOURCE = await fs.readFile(new URL('../ui/js/format/driver-view.js', import.meta.url), 'utf8');

function createHarness({ drivers, platforms }) {
  const calls = [];
  const state = {
    drivers,
    platforms,
    addForm: { optionId: '', driverKey: '', values: {}, advancedField: null },
  };
  const factory = new Function(`${DRIVER_VIEW_SOURCE}\n${ADD_FORM_SOURCE}
;return { createAddFormActions: createAddFormActions };`)();
  const actions = factory.createAddFormActions({
    api: {
      probeModels: (payload) => { calls.push({ kind: 'probe', payload }); return Promise.resolve({ models: [] }); },
      createGroup: (payload) => { calls.push({ kind: 'create', payload }); return Promise.resolve({ group: payload }); },
    },
    state,
    broadcast: () => {},
    reportError: () => {},
  });
  return { actions, state, calls };
}

const CONFIG_DRIVERS = [{ id: 'openai-compatible', name: '通用', authSchema: [] }];
const ACCOUNT_DRIVERS = [{ id: 'reverse-qoder', name: 'Qoder', authKind: 'reverse-account', platformId: 'qoder', authSchema: [] }];

test('配置型：探测体带 driverId + baseURL + modelsEndpoint + apiKey', async () => {
  const harness = createHarness({ drivers: CONFIG_DRIVERS, platforms: [] });
  await harness.actions.selectGroupOption('driver:openai-compatible');
  await harness.actions.setAddFormValue('baseURL', 'https://api.example.com/v1');
  await harness.actions.setAddFormValue('apiKey', 'sk-test');
  await harness.actions.probeAddForm({});
  const probeCall = harness.calls.find((call) => call.kind === 'probe');
  assert.deepEqual(probeCall.payload, {
    driverId: 'openai-compatible',
    baseURL: 'https://api.example.com/v1',
    modelsEndpoint: '/models',
    apiKey: 'sk-test',
  });
});

test('账号型：探测体只带 driverId + apiKeyRef（不带 baseURL/modelsEndpoint）', async () => {
  const harness = createHarness({ drivers: ACCOUNT_DRIVERS, platforms: [] });
  await harness.actions.selectGroupOption('driver:reverse-qoder');
  await harness.actions.probeAddForm({ accountId: 'acc-1' });
  const probeCall = harness.calls.find((call) => call.kind === 'probe');
  assert.deepEqual(probeCall.payload, { driverId: 'reverse-qoder', apiKeyRef: 'account:qoder/acc-1' });
});

test('账号型：没有账号时拒绝探测（错误信息可读）', async () => {
  const harness = createHarness({ drivers: ACCOUNT_DRIVERS, platforms: [] });
  await harness.actions.selectGroupOption('driver:reverse-qoder');
  await assert.rejects(() => harness.actions.probeAddForm({}), /请先选择账号/);
});

test('加群体：配置型带 auth.apiKey 与 models.endpoint；账号型带 auth.apiKeyRef + accessMode', async () => {
  const configHarness = createHarness({ drivers: CONFIG_DRIVERS, platforms: [] });
  await configHarness.actions.selectGroupOption('driver:openai-compatible');
  await configHarness.actions.setAddFormValue('baseURL', 'https://api.example.com/v1');
  await configHarness.actions.setAddFormValue('apiKey', 'sk-test');
  await configHarness.actions.submitAddGroup({ name: '主力组' });
  const configPayload = configHarness.calls.find((call) => call.kind === 'create').payload;
  assert.equal(configPayload.driver, 'openai-compatible');
  assert.equal(configPayload.baseURL, 'https://api.example.com/v1');
  assert.deepEqual(configPayload.auth, { apiKey: 'sk-test' });
  assert.deepEqual(configPayload.models, { endpoint: '/models' });

  const accountHarness = createHarness({ drivers: ACCOUNT_DRIVERS, platforms: [] });
  await accountHarness.actions.selectGroupOption('driver:reverse-qoder');
  await accountHarness.actions.submitAddGroup({ name: 'Qoder 号', accountId: 'acc-1' });
  const accountPayload = accountHarness.calls.find((call) => call.kind === 'create').payload;
  assert.deepEqual(accountPayload.auth, { apiKeyRef: 'account:qoder/acc-1' });
  assert.equal(accountPayload.accessMode, 'reverse');
});

test('预置平台：选中后初值来自平台声明，提交时沿用', async () => {
  const harness = createHarness({
    drivers: CONFIG_DRIVERS,
    platforms: [{ id: 'preset-a', name: '预置甲', driverId: 'openai-compatible', baseURL: 'https://preset.example/v1' }],
  });
  const selection = await harness.actions.selectGroupOption('preset:preset-a');
  assert.equal(selection.driverKey, 'openai-compatible');
  assert.equal(harness.state.addForm.values.baseURL, 'https://preset.example/v1');
});
