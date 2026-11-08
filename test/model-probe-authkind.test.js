// 模型探测的凭据分流（按驱动 authKind）：账号型驱动不该被当成 API Key 解析。
import test from 'node:test';
import assert from 'node:assert/strict';

import { AUTH_KINDS, registerDriver, resetDriverRegistry } from '../src/gateway/drivers/index.js';
import { probeModels } from '../src/gateway/model/probe.js';
import { createRecordingLogger, createTempDirectory, setEnvironmentVariableForTest } from './helpers/test-environment.js';

const REVERSE_DRIVER_ID = 'probe-reverse';
const API_KEY_DRIVER_ID = 'probe-api-key';
const LEGACY_DRIVER_ID = 'probe-legacy';

function makeDriver({ id, authKind, fetchModels }) {
  return {
    id,
    name: id,
    accessMode: 'official',
    authSchema: [],
    ...(authKind ? { authKind } : {}),
    fetchModels,
  };
}

function withFreshRegistry(t) {
  resetDriverRegistry();
  t.after(() => resetDriverRegistry());
}

test('账号型驱动：account: 引用不再被当 API Key 解析，清单原样返回', async (t) => {
  withFreshRegistry(t);
  const receivedContexts = [];
  registerDriver(makeDriver({
    id: REVERSE_DRIVER_ID,
    authKind: AUTH_KINDS.REVERSE_ACCOUNT,
    fetchModels: async (context) => {
      receivedContexts.push(context);
      return [{ id: 'qfmodel', name: 'qfmodel' }, { id: 'dmodel', name: 'dmodel' }];
    },
  }));

  const dataRoot = await createTempDirectory(t);
  const result = await probeModels({
    body: { driverId: REVERSE_DRIVER_ID, baseURL: 'https://gateway.example', apiKeyRef: 'account:qoder/account-1' },
    dataRoot,
    logger: createRecordingLogger(),
  });

  assert.deepEqual(result.models, [{ id: 'qfmodel', name: 'qfmodel' }, { id: 'dmodel', name: 'dmodel' }]);
  assert.equal(result.count, 2);
  assert.equal(receivedContexts.length, 1);
  assert.equal(receivedContexts[0].credentials, null, '账号型驱动拿到的 credentials 必须是 null');
  assert.equal(receivedContexts[0].group.auth.apiKeyRef, 'account:qoder/account-1', '引用要原样交给驱动');
});

test('账号型驱动：返回空清单 → 就是空数组（不伪造模型）', async (t) => {
  withFreshRegistry(t);
  registerDriver(makeDriver({ id: REVERSE_DRIVER_ID, authKind: AUTH_KINDS.REVERSE_ACCOUNT, fetchModels: async () => [] }));

  const result = await probeModels({
    body: { driverId: REVERSE_DRIVER_ID, baseURL: 'https://gateway.example', apiKeyRef: 'account:qoder/account-1' },
    dataRoot: await createTempDirectory(t),
    logger: createRecordingLogger(),
  });

  assert.deepEqual(result.models, []);
  assert.equal(result.count, 0);
});

test('账号型驱动：凭据缺失 → probe-failed（不是 probe-unauthorized，文案不提 API Key）', async (t) => {
  withFreshRegistry(t);
  registerDriver(makeDriver({
    id: REVERSE_DRIVER_ID,
    authKind: AUTH_KINDS.REVERSE_ACCOUNT,
    fetchModels: async () => { throw Object.assign(new Error('账号未登录'), { code: 'MISSING_CREDENTIAL' }); },
  }));

  const dataRoot = await createTempDirectory(t);
  await assert.rejects(
    () => probeModels({
      body: { driverId: REVERSE_DRIVER_ID, baseURL: 'https://gateway.example', apiKeyRef: 'account:qoder/account-1' },
      dataRoot,
      logger: createRecordingLogger(),
    }),
    (error) => {
      assert.equal(error.code, 'probe-failed');
      assert.equal(/api\s*key/i.test(`${error.message} ${error.hint ?? ''}`), false, '文案里不许出现 API Key');
      return true;
    },
  );
});

test('api-key 驱动：env: 引用照旧解析并交给驱动', async (t) => {
  withFreshRegistry(t);
  const receivedContexts = [];
  registerDriver(makeDriver({
    id: API_KEY_DRIVER_ID,
    authKind: AUTH_KINDS.API_KEY,
    fetchModels: async (context) => {
      receivedContexts.push(context);
      return [{ id: 'gpt-test', name: 'gpt-test' }];
    },
  }));

  setEnvironmentVariableForTest(t, 'DSH_PROBE_TEST_KEY', 'sk-test-value');

  const result = await probeModels({
    body: { driverId: API_KEY_DRIVER_ID, baseURL: 'https://api.example/v1', apiKeyRef: 'env:DSH_PROBE_TEST_KEY' },
    dataRoot: await createTempDirectory(t),
    logger: createRecordingLogger(),
  });

  assert.equal(result.count, 1);
  assert.match(JSON.stringify(receivedContexts[0].credentials), /sk-test-value/);
});

test('api-key 驱动：缺 key 仍是 probe-unauthorized（旧行为逐字节不变）', async (t) => {
  withFreshRegistry(t);
  registerDriver(makeDriver({
    id: API_KEY_DRIVER_ID,
    authKind: AUTH_KINDS.API_KEY,
    fetchModels: async () => { throw Object.assign(new Error('缺少凭据'), { code: 'MISSING_CREDENTIAL' }); },
  }));

  const dataRoot = await createTempDirectory(t);
  await assert.rejects(
    () => probeModels({
      body: { driverId: API_KEY_DRIVER_ID, baseURL: 'https://api.example/v1' },
      dataRoot,
      logger: createRecordingLogger(),
    }),
    (error) => error.code === 'probe-unauthorized',
  );
});

test('未声明 authKind 的驱动：按 api-key 处理（兼容性），account: 引用仍被拒', async (t) => {
  withFreshRegistry(t);
  registerDriver(makeDriver({ id: LEGACY_DRIVER_ID, fetchModels: async () => [{ id: 'x', name: 'x' }] }));

  const dataRoot = await createTempDirectory(t);
  await assert.rejects(
    () => probeModels({
      body: { driverId: LEGACY_DRIVER_ID, baseURL: 'https://api.example/v1', apiKeyRef: 'account:qoder/account-1' },
      dataRoot,
      logger: createRecordingLogger(),
    }),
    (error) => error.code === 'probe-unauthorized',
  );
});
