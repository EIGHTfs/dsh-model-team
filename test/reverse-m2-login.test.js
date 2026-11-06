// 反代 M2（登录闭环）用例：账号落盘（0600 / 按 userId 判重 / 损坏容错）、登录状态机（幂等/超时/取消）、
// 以及 Qoder 设备码协议在本地 stub 上的全流程。全部不联网；真上游用例用 QODER_E2E=1 门控。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { createAccountStore } from '../src/gateway/reverse/account-store.js';
import { createLoginSessionManager, LOGIN_STATUS } from '../src/gateway/reverse/login-session.js';
import {
  buildAuthUrl,
  buildPollUrl,
  createDeviceSession,
  pollDeviceLogin,
  startDeviceLogin,
} from '../src/gateway/reverse/qoder/oauth.js';
import { getPlatform } from '../src/gateway/reverse/index.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

const STUB_CLIENT_ID = 'test-client-id';

// 起一个只服务"轮询 + userinfo"的本地 stub；pollScript 控制前几次返回 404
async function startLoginStub({ pendingRounds = 1, token = 'stub-access-token', userInfo = { user_id: 'user-42', name: '测试账号' } } = {}) {
  const pollRequests = [];
  const userInfoRequests = [];
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    const writeJson = (statusCode, payload) => {
      const bodyText = JSON.stringify(payload);
      response.writeHead(statusCode, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyText) });
      response.end(bodyText);
    };
    if (requestUrl.pathname === '/api/v1/deviceToken/poll') {
      pollRequests.push({ url: requestUrl.pathname, query: Object.fromEntries(requestUrl.searchParams) });
      if (pollRequests.length <= pendingRounds) {
        writeJson(404, { errorCode: 'NotFound' });
        return;
      }
      writeJson(200, { token, refresh_token: 'stub-refresh-token', expires_at: '2026-12-31T00:00:00Z' });
      return;
    }
    if (requestUrl.pathname === '/api/v1/userinfo') {
      userInfoRequests.push({ authorization: request.headers.authorization });
      writeJson(200, userInfo);
      return;
    }
    writeJson(500, { message: 'unexpected path' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    pollRequests,
    userInfoRequests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function stubEndpoints(origin) {
  return {
    openApiBase: origin,
    authBase: origin,
    deviceSelectPath: '/device/selectAccounts',
    deviceTokenPoll: '/api/v1/deviceToken/poll',
    userInfo: '/api/v1/userinfo',
  };
}

// ===== 账号落盘 =====

test('account-store：落盘权限 0600，且目录在 <dataRoot>/reverse/<platformId>/ 下', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const store = createAccountStore({ dataRoot, logger: createRecordingLogger() });

  const saved = await store.upsertByUserId('demoplatform', {
    accessToken: 'access-token-value', refreshToken: 'refresh-token-value', userId: 'user-42', machineId: 'machine-1', machineType: 'mac-arm64',
  });

  const stats = await fs.stat(saved.filePath);
  assert.equal(stats.mode & 0o777, 0o600, '账号文件必须只有属主可读写');
  assert.equal(saved.filePath.startsWith(path.join(dataRoot, 'reverse', 'demoplatform')), true);
  const parsed = JSON.parse(await fs.readFile(saved.filePath, 'utf8'));
  assert.equal(parsed.accessToken, 'access-token-value');
  assert.equal(parsed.userId, 'user-42');
  assert.equal(typeof parsed.updatedAt, 'string');
  assert.equal('expiresAt' in parsed, false, '未知过期时间不编造（不写字段）');
});

test('account-store：同一 userId 二次登录是"更新"不是"新增"', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const store = createAccountStore({ dataRoot, logger: createRecordingLogger() });

  const first = await store.upsertByUserId('demoplatform', { accessToken: 'token-1', userId: 'user-42', machineId: 'm1', machineType: 'mac' });
  const second = await store.upsertByUserId('demoplatform', { accessToken: 'token-2', userId: 'user-42', machineId: 'm1', machineType: 'mac' });

  assert.equal(first.created, true);
  assert.equal(second.created, false, '第二次是更新');
  assert.equal(second.merged, true);
  assert.equal(second.accountId, first.accountId, 'accountId 是文件名锚点，更新时不能变');
  const accounts = await store.listAccounts('demoplatform');
  assert.equal(accounts.length, 1, '同 userId 不能出现两个账号文件');
  assert.equal(accounts[0].credential.accessToken, 'token-2', '内容被新值覆盖');
});

test('account-store：缺 userId 只新增不去重，且只 warn 一次', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const store = createAccountStore({ dataRoot, logger });

  const first = await store.upsertByUserId('demoplatform', { accessToken: 'token-a', machineId: 'm1', machineType: 'mac' });
  const second = await store.upsertByUserId('demoplatform', { accessToken: 'token-b', machineId: 'm1', machineType: 'mac' });

  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.notEqual(first.accountId, second.accountId);
  assert.equal((await store.listAccounts('demoplatform')).length, 2);
  const warnedLines = logger.lines.filter((line) => line.level === 'warn' && line.message.includes('缺少 userId'));
  assert.equal(warnedLines.length, 1, '只 warn 一次，不每次刷屏');
});

test('account-store：损坏文件按"未登录"处理，不抛也不删', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const store = createAccountStore({ dataRoot, logger });
  const brokenPath = path.join(dataRoot, 'reverse', 'demoplatform', 'account-broken.json');
  await fs.mkdir(path.dirname(brokenPath), { recursive: true });
  await fs.writeFile(brokenPath, '{not json', 'utf8');

  const accounts = await store.listAccounts('demoplatform');
  assert.deepEqual(accounts, [], '坏文件不算账号');
  assert.equal(await store.readAccount('demoplatform', 'account-broken'), null);
  assert.equal(logger.lines.some((line) => line.level === 'warn' && line.message.includes('按未登录处理')), true);
  assert.equal((await fs.stat(brokenPath)).isFile(), true, '不替用户删文件');
});

test('account-store：原子写不留下临时文件', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const store = createAccountStore({ dataRoot, logger: createRecordingLogger() });
  await store.upsertByUserId('demoplatform', { accessToken: 'token', userId: 'user-42', machineId: 'm', machineType: 'mac' });

  const fileNames = await fs.readdir(path.join(dataRoot, 'reverse', 'demoplatform'));
  assert.deepEqual(fileNames.filter((name) => name.endsWith('.tmp')), [], '不允许残留临时文件');
});

// ===== 登录状态机（平台无关）=====

function createManager({ pollResults, nowRef }) {
  let pollCalls = 0;
  const manager = createLoginSessionManager({
    startLogin: async () => ({ loginUrl: 'https://example.com/authorize', pollContext: {}, intervalMs: 10, expiresAtMs: 1000 }),
    pollLogin: async () => {
      const result = pollResults[Math.min(pollCalls, pollResults.length - 1)];
      pollCalls += 1;
      return typeof result === 'function' ? result() : result;
    },
    timeoutMs: 1000,
    now: () => nowRef.value,
  });
  return { manager, getPollCalls: () => pollCalls };
}

test('login-session：pending → granted；granted 之后幂等且不再打上游', async () => {
  const nowRef = { value: 0 };
  const { manager, getPollCalls } = createManager({
    pollResults: [{ status: 'pending' }, { status: 'granted', credential: { userId: 'user-42' } }],
    nowRef,
  });

  const started = await manager.start();
  assert.equal(started.loginUrl, 'https://example.com/authorize');
  assert.equal(started.intervalMs, 10);
  assert.equal((await manager.poll(started.sessionId)).status, LOGIN_STATUS.PENDING);
  const granted = await manager.poll(started.sessionId);
  assert.equal(granted.status, LOGIN_STATUS.GRANTED);
  assert.equal(granted.credential.userId, 'user-42');

  const callsAfterGrant = getPollCalls();
  const again = await manager.poll(started.sessionId);
  assert.equal(again.status, LOGIN_STATUS.GRANTED);
  assert.equal(again.credential.userId, 'user-42', '二次 poll 返回同一份凭据');
  assert.equal(getPollCalls(), callsAfterGrant, 'granted 之后不许再打上游');
});

test('login-session：超时 → expired，且之后保持终态', async () => {
  const nowRef = { value: 0 };
  const { manager } = createManager({ pollResults: [{ status: 'pending' }], nowRef });
  const started = await manager.start();

  nowRef.value = 1000; // 恰好到期
  assert.equal((await manager.poll(started.sessionId)).status, LOGIN_STATUS.EXPIRED);
  nowRef.value = 0; // 时间回拨也不复活
  assert.equal((await manager.poll(started.sessionId)).status, LOGIN_STATUS.EXPIRED);
});

test('login-session：取消 → cancelled；未知会话 → expired', async () => {
  const nowRef = { value: 0 };
  const { manager } = createManager({ pollResults: [{ status: 'pending' }], nowRef });
  const started = await manager.start();

  assert.equal(manager.cancel(started.sessionId).status, LOGIN_STATUS.CANCELLED);
  assert.equal((await manager.poll(started.sessionId)).status, LOGIN_STATUS.CANCELLED);
  assert.equal((await manager.poll('no-such-session')).status, LOGIN_STATUS.EXPIRED);
});

// ===== Qoder 协议（本地 stub）=====

test('qoder oauth：授权 URL 带齐 challenge/nonce/machine_id/client_id（不需要用户输码）', () => {
  const session = createDeviceSession({ machineId: 'machine-fixed' });
  const loginUrl = buildAuthUrl({ session, endpoints: { authBase: 'https://auth.example', deviceSelectPath: '/device/selectAccounts' }, clientId: STUB_CLIENT_ID });
  const parsedUrl = new URL(loginUrl);

  assert.equal(parsedUrl.pathname, '/device/selectAccounts');
  assert.equal(parsedUrl.searchParams.get('challenge'), session.pkce.challenge);
  assert.equal(parsedUrl.searchParams.get('challenge_method'), 'S256');
  assert.equal(parsedUrl.searchParams.get('nonce'), session.nonce);
  assert.equal(parsedUrl.searchParams.get('machine_id'), 'machine-fixed');
  assert.equal(parsedUrl.searchParams.get('client_id'), STUB_CLIENT_ID);
  assert.equal(/[=]$/.test(session.pkce.challenge), false, 'challenge 不能带 base64 padding');
});

test('qoder oauth：轮询 URL 挂 openApiBase，带 nonce/verifier', () => {
  const session = createDeviceSession({ machineId: 'machine-fixed' });
  const pollUrl = buildPollUrl({ session, endpoints: { openApiBase: 'https://api.example', deviceTokenPoll: '/api/v1/deviceToken/poll' } });
  const parsedUrl = new URL(pollUrl);

  assert.equal(parsedUrl.origin, 'https://api.example');
  assert.equal(parsedUrl.searchParams.get('nonce'), session.nonce);
  assert.equal(parsedUrl.searchParams.get('verifier'), session.pkce.verifier);
  assert.equal(parsedUrl.searchParams.get('challenge_method'), 'S256');
});

test('qoder oauth：404 继续 pending，拿到 token 后补 userinfo 得到 userId（全流程 stub）', async (t) => {
  const stub = await startLoginStub({ pendingRounds: 2 });
  t.after(() => stub.close());
  const endpoints = stubEndpoints(stub.origin);

  const started = startDeviceLogin({
    endpoints,
    login: { clientId: STUB_CLIENT_ID, machineType: 'mac-arm64', pollIntervalMs: 10, timeoutMs: 5000 },
  });
  assert.equal(started.loginUrl.startsWith(`${stub.origin}/device/selectAccounts?`), true);

  const firstPoll = await pollDeviceLogin({ pollContext: started.pollContext, fetchImpl: globalThis.fetch });
  assert.equal(firstPoll.status, 'pending', '404 = 用户还没授权');

  await pollDeviceLogin({ pollContext: started.pollContext, fetchImpl: globalThis.fetch });
  const granted = await pollDeviceLogin({ pollContext: started.pollContext, fetchImpl: globalThis.fetch });

  assert.equal(granted.status, 'granted');
  assert.equal(granted.credential.accessToken, 'stub-access-token');
  assert.equal(granted.credential.refreshToken, 'stub-refresh-token');
  assert.equal(granted.credential.userId, 'user-42', '判重键取自 userinfo');
  assert.equal(granted.credential.nickname, '测试账号');
  assert.equal(granted.credential.machineType, 'mac-arm64');
  assert.equal(typeof granted.credential.machineToken, 'string');
  assert.equal(granted.credential.machineToken.length > 0, true, 'machineToken 由登录生成，不能用 machineId 顶替');
  assert.notEqual(granted.credential.machineToken, granted.credential.machineId);
  assert.equal(stub.userInfoRequests[0].authorization, 'Bearer stub-access-token');
});

test('qoder oauth：userinfo 失败 → 明确错误码（不静默丢 userId）', async (t) => {
  const stub = await startLoginStub({ pendingRounds: 0, userInfo: null });
  // 覆盖：让 userinfo 返回 500
  stub.close();
  const failingServer = http.createServer((request, response) => {
    if (request.url.startsWith('/api/v1/deviceToken/poll')) {
      const bodyText = JSON.stringify({ token: 'stub-access-token' });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyText) });
      response.end(bodyText);
      return;
    }
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end('{"message":"boom"}');
  });
  await new Promise((resolve) => failingServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => failingServer.close(resolve)));

  const endpoints = stubEndpoints(`http://127.0.0.1:${failingServer.address().port}`);
  const started = startDeviceLogin({ endpoints, login: { clientId: STUB_CLIENT_ID, machineType: 'mac', pollIntervalMs: 10, timeoutMs: 5000 } });

  await assert.rejects(
    () => pollDeviceLogin({ pollContext: started.pollContext, fetchImpl: globalThis.fetch }),
    (error) => error.code === 'REVERSE_LOGIN_USERINFO_FAILED',
  );
});

// ===== e2e 门控（铁律 12）=====

test('真上游登录：只有 QODER_E2E=1 时才跑（默认 skip）', { skip: process.env.QODER_E2E !== '1' }, async () => {
  const platform = getPlatform('qoder');
  const platformImpl = platform.createPlatform({});
  const started = platformImpl.startDeviceLogin({});
  assert.equal(started.loginUrl.startsWith('https://qoder.cn/device/selectAccounts?'), true);
});
