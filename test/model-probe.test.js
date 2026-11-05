// 模型探测用例（docs/21）：成功/401/404/超时映射、绝不落盘、缺 baseURL 400。
// 用外挂桩驱动模拟上游各种失败，不依赖真实网络。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createGatewayServer } from '../src/gateway/transport/http-server.js';
import { writeConfig } from '../src/gateway/config/config.js';
import { API_PREFIX } from '../src/gateway/config/constants.js';
import { loadExternalDrivers, resetDriverRegistry } from '../src/gateway/drivers/index.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

// 桩驱动文件：按 baseURL 里的关键词决定行为，便于覆盖四种映射
const STUB_DRIVER_SOURCE = `
export default {
  id: 'probe-stub',
  name: 'probe-stub',
  accessMode: 'official',
  authSchema: [],
  async fetchModels(context) {
    const marker = String(context?.group?.baseURL ?? '');
    if (marker.includes('nocreds')) {
      const missingCredentialError = new Error('no credential');
      missingCredentialError.code = 'MISSING_CREDENTIAL';
      missingCredentialError.status = 0;
      throw missingCredentialError;
    }
    if (marker.includes('timeout')) {
      const timeoutError = new Error('timed out');
      timeoutError.code = 'UPSTREAM_TIMEOUT';
      throw timeoutError;
    }
    if (marker.includes('unauthorized')) {
      const authError = new Error('upstream rejected');
      authError.code = 'UPSTREAM_ERROR';
      authError.status = 401;
      throw authError;
    }
    if (marker.includes('notfound')) {
      const notFoundError = new Error('upstream missing');
      notFoundError.code = 'UPSTREAM_ERROR';
      notFoundError.status = 404;
      throw notFoundError;
    }
    return [{ id: 'model-1', name: 'Model One' }, 'model-2'];
  },
};
`;

async function prepareProbeEnvironment(t) {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const driversDir = path.join(dataRoot, 'drivers');
  await fs.mkdir(driversDir, { recursive: true });
  await fs.writeFile(path.join(driversDir, 'probe-stub.js'), STUB_DRIVER_SOURCE, 'utf8');
  await writeConfig({ groups: [] }, { dataRoot });

  resetDriverRegistry();
  await loadExternalDrivers({ driversDir, logger });
  t.after(() => resetDriverRegistry());

  const server = createGatewayServer({ dataRoot, logger });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const probe = async (body) => {
    const response = await fetch(`${baseUrl}${API_PREFIX}/models/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { dataRoot, logger, probe };
}

test('①探测成功：返回 { id, name } 列表与 count', async (t) => {
  const { probe } = await prepareProbeEnvironment(t);

  const result = await probe({ driverId: 'probe-stub', baseURL: 'https://stub.example/v1' });

  assert.equal(result.status, 200);
  assert.equal(result.body.count, 2);
  assert.deepEqual(result.body.models, [
    { id: 'model-1', name: 'Model One' },
    { id: 'model-2', name: 'model-2' },
  ]);
});

test('②401 → probe-unauthorized（不回传上游原文）', async (t) => {
  const { probe } = await prepareProbeEnvironment(t);

  const result = await probe({ driverId: 'probe-stub', baseURL: 'https://unauthorized.example/v1', apiKey: 'plaintext-key' });

  assert.equal(result.status, 401);
  assert.equal(result.body.error.code, 'probe-unauthorized');
  assert.equal(JSON.stringify(result.body).includes('upstream rejected'), false, '不能回传上游原始错误');
});

test('③404 → probe-not-found', async (t) => {
  const { probe } = await prepareProbeEnvironment(t);

  const result = await probe({ driverId: 'probe-stub', baseURL: 'https://notfound.example/v1' });

  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, 'probe-not-found');
});

test('④超时 → probe-timeout', async (t) => {
  const { probe } = await prepareProbeEnvironment(t);

  const result = await probe({ driverId: 'probe-stub', baseURL: 'https://timeout.example/v1' });

  assert.equal(result.status, 504);
  assert.equal(result.body.error.code, 'probe-timeout');
});

test('⑤绝不落盘：config.json 与 credentials/ 内容不变', async (t) => {
  const { dataRoot, probe } = await prepareProbeEnvironment(t);
  const configPath = path.join(dataRoot, 'config.json');
  const credentialsDir = path.join(dataRoot, 'credentials');

  const configBefore = await fs.readFile(configPath, 'utf8');
  const configStatBefore = await fs.stat(configPath);
  const credentialsExistedBefore = await fs.stat(credentialsDir).then(() => true).catch(() => false);

  const result = await probe({ driverId: 'probe-stub', baseURL: 'https://stub.example/v1', apiKey: 'plaintext-never-persisted' });
  assert.equal(result.status, 200);

  const configAfter = await fs.readFile(configPath, 'utf8');
  const configStatAfter = await fs.stat(configPath);
  const credentialsExistedAfter = await fs.stat(credentialsDir).then(() => true).catch(() => false);

  assert.equal(configAfter, configBefore, 'config.json 内容不能变');
  assert.equal(configStatAfter.mtimeMs, configStatBefore.mtimeMs, 'config.json mtime 不能变');
  assert.equal(credentialsExistedAfter, credentialsExistedBefore, '不能新建 credentials/');
  assert.equal(configAfter.includes('plaintext-never-persisted'), false, '明文 Key 不能进配置');
});

test('⑥缺 baseURL → 400 明确错误', async (t) => {
  const { probe } = await prepareProbeEnvironment(t);

  const result = await probe({ driverId: 'probe-stub' });

  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'invalid-request');
  assert.equal(result.body.error.message.includes('baseURL'), true);
});

test('⑦驱动报缺凭证（status=0）→ probe-unauthorized，而不是 probe-failed', async (t) => {
  const { probe } = await prepareProbeEnvironment(t);

  const result = await probe({ driverId: 'probe-stub', baseURL: 'https://nocreds.example/v1' });

  assert.equal(result.status, 401);
  assert.equal(result.body.error.code, 'probe-unauthorized');
  assert.equal(result.body.error.hint.includes('apiKey'), true);
});
