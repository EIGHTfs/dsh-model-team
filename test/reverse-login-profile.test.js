// 第 8 步：CN 登录补 redirect_uri + profile 化 client_id + machine_id 持久化 + 202 视为 pending。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  NONCE_STYLES,
  buildAuthUrl,
  createDeviceSession,
  pollDeviceLogin,
} from '../src/reverse/platforms/qoder/oauth.js';
import { platform, resolveLoginProfile } from '../src/reverse/platforms/qoder/index.js';
import { deriveUuidFromText, machineIdFilePath, resolveMachineId } from '../src/reverse/platforms/qoder/machine-id.js';
import { createTempDirectory } from './helpers/test-environment.js';

const ENDPOINTS = Object.freeze({ authBase: 'https://qoder.cn', deviceSelectPath: '/device/selectAccounts' });

function buildUrlFor(profileName) {
  const profile = resolveLoginProfile({ platform, profileName, environment: {} });
  const session = createDeviceSession({ machineId: 'machine-fixed', nonceStyle: profile.nonceStyle });
  return { profile, session, url: new URL(buildAuthUrl({ session, endpoints: ENDPOINTS, profile })) };
}

test('profile：cn-python 带 redirect_uri；cn-providers/intl 不带；intl 的 nonce 无横线', () => {
  const cnPython = buildUrlFor('cn-python');
  assert.equal(cnPython.url.searchParams.get('redirect_uri'), 'qoder-work-cn://');
  assert.equal(cnPython.profile.clientId.endsWith('81274a5c'), true);
  assert.match(cnPython.url.searchParams.get('nonce'), /^[0-9a-f-]{36}$/);

  const cnProviders = buildUrlFor('cn-providers');
  assert.equal(cnProviders.url.searchParams.has('redirect_uri'), false);
  assert.equal(cnProviders.profile.clientId.endsWith('b5d0d1fa'), true);

  const intl = buildUrlFor('intl');
  assert.equal(intl.url.searchParams.has('redirect_uri'), false);
  assert.equal(intl.profile.clientId.endsWith('eff5fdcb'), true);
  assert.match(intl.url.searchParams.get('nonce'), /^[0-9a-f]{32}$/, 'intl nonce 为 32 位无横线 hex');
  assert.equal(intl.url.searchParams.get('nonce').includes('-'), false);
});

test('profile 选择：默认 cn-python，环境变量可覆盖，未知名字回落默认', () => {
  assert.equal(resolveLoginProfile({ platform, environment: {} }).id, 'cn-python');
  assert.equal(resolveLoginProfile({ platform, environment: { DSH_MODEL_TEAM_QODER_LOGIN_PROFILE: 'intl' } }).id, 'intl');
  assert.equal(resolveLoginProfile({ platform, environment: { DSH_MODEL_TEAM_QODER_LOGIN_PROFILE: 'nope' } }).id, 'cn-python');
});

test('machine_id：有本机稳定输入时由输入派生（两次调用一致，且不落盘）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const options = { dataRoot, hostname: 'demo-host', networkInterfaces: { eth0: [{ mac: 'AA:BB:CC:DD:EE:FF' }] }, readTextFile: () => { throw new Error('no machine-id'); } };

  const first = await resolveMachineId(options);
  const second = await resolveMachineId(options);

  assert.equal(first.machineId, second.machineId, '同一台机器必须得到同一个 id');
  assert.equal(first.source, 'host-mac');
  assert.equal(first.machineId, deriveUuidFromText('host:demo-host|mac:aa:bb:cc:dd:ee:ff'), '只落哈希派生结果，不用原始 MAC');
  await assert.rejects(() => fs.access(machineIdFilePath({ dataRoot })), '派生出 id 时不需要落盘');
});

test('machine_id：没有任何稳定输入时生成一次并持久化（0600），两次调用仍一致', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const options = { dataRoot, hostname: '', networkInterfaces: {}, readTextFile: () => { throw new Error('no machine-id'); } };

  const first = await resolveMachineId(options);
  assert.equal(first.source, 'generated');
  const filePath = machineIdFilePath({ dataRoot });
  const stats = await fs.stat(filePath);
  assert.equal(stats.mode & 0o777, 0o600, 'machine-id.json 必须 0600');
  assert.equal(path.basename(filePath), 'machine-id.json');

  const second = await resolveMachineId(options);
  assert.equal(second.machineId, first.machineId, '第二次读落盘文件，绝不重新随机');
  assert.equal(second.source, 'persisted');
});

test('轮询：202 与 404 都算 pending，500 是明确错误', async () => {
  const session = createDeviceSession({ machineId: 'machine-fixed' });
  const pollContext = { session, endpoints: { openApiBase: 'https://api.example', deviceTokenPoll: '/api/v1/deviceToken/poll' }, machineType: 'mac-arm64', machineToken: 'mt', machineId: 'machine-fixed' };

  for (const status of [202, 404]) {
    const pending = await pollDeviceLogin({
      pollContext,
      fetchImpl: async () => new Response('{}', { status, headers: { 'content-type': 'application/json' } }),
    });
    assert.deepEqual(pending, { status: 'pending' }, `HTTP ${status} 应当 pending`);
  }

  await assert.rejects(
    () => pollDeviceLogin({
      pollContext,
      fetchImpl: async () => new Response('{"message":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } }),
    }),
    (error) => error.code === 'REVERSE_LOGIN_POLL_FAILED',
  );
});

test('nonce 形态常量：dashed 带横线、hex32 无横线', () => {
  const dashed = createDeviceSession({ machineId: 'm', nonceStyle: NONCE_STYLES.DASHED }).nonce;
  const hex32 = createDeviceSession({ machineId: 'm', nonceStyle: NONCE_STYLES.HEX32 }).nonce;
  assert.equal(dashed.includes('-'), true);
  assert.equal(hex32.includes('-'), false);
  assert.equal(hex32.length, 32);
});
