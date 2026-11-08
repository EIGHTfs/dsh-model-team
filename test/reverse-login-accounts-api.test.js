// 第 6 步：反代登录与账号端点（声明式登记在 src/reverse/manifest.js）。
// 全部走真网关（harness）+ 临时数据根；只把"上游轮询"打桩成 404（= 用户还没授权），不打真上游。
import test from 'node:test';
import assert from 'node:assert/strict';

import { startGatewayHarness } from './helpers/gateway-harness.js';
import { registerReverse } from '../src/reverse/register.js';
import { createRecordingLogger } from './helpers/test-environment.js';

// 反代路由是贡献式的：测试里显式走插件同一入口注册一次
await registerReverse({ logger: createRecordingLogger() });

// 把设备码轮询打桩成 404（pending），避免测试打真上游
function stubDevicePollFetch(t) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (requestUrl, requestInit) => {
    if (String(requestUrl).includes('/api/v1/deviceToken/poll')) {
      return Promise.resolve(new Response(JSON.stringify({ errorCode: 'NotFound' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }));
    }
    return originalFetch(requestUrl, requestInit);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
}

test('登录接口：start → pending → cancel → cancelled（幂等），loginUrl 参数齐全', async (t) => {
  stubDevicePollFetch(t);
  const harness = await startGatewayHarness(t);

  const startResponse = await harness.request('/_team/reverse/login/start', {
    method: 'POST',
    body: { platform: 'qoder' },
  });
  assert.equal(startResponse.status, 200);
  assert.equal(typeof startResponse.body.sessionId, 'string');
  // 授权站由登录 profile 决定（成套配置），不在这里写死某个域
  assert.match(startResponse.body.loginUrl, /^https:\/\/qoder\.(cn|com\.cn)\/device\/selectAccounts\?/);
  assert.match(startResponse.body.loginUrl, /challenge=/);
  assert.equal(typeof startResponse.body.expiresAtMs, 'number');

  const pendingResponse = await harness.request(`/_team/reverse/login/${startResponse.body.sessionId}`);
  assert.equal(pendingResponse.status, 200);
  assert.equal(pendingResponse.body.status, 'pending');
  assert.equal('account' in pendingResponse.body, false);

  const cancelResponse = await harness.request(`/_team/reverse/login/${startResponse.body.sessionId}/cancel`, {
    method: 'POST',
    body: {},
  });
  assert.equal(cancelResponse.status, 200);
  assert.equal(cancelResponse.body.status, 'cancelled');

  const afterCancel = await harness.request(`/_team/reverse/login/${startResponse.body.sessionId}`);
  assert.equal(afterCancel.body.status, 'cancelled', '取消是终态，再次轮询仍是 cancelled');
});

test('登录接口：未知平台 400、缺平台 400、未知会话 404', async (t) => {
  const harness = await startGatewayHarness(t);

  const unknownPlatform = await harness.request('/_team/reverse/login/start', { method: 'POST', body: { platform: 'nope' } });
  assert.equal(unknownPlatform.status, 400);
  assert.match(unknownPlatform.body.error.message, /未知的反代平台/);

  const missingPlatform = await harness.request('/_team/reverse/login/start', { method: 'POST', body: {} });
  assert.equal(missingPlatform.status, 400);

  const missingSession = await harness.request('/_team/reverse/login/not-a-session');
  assert.equal(missingSession.status, 404);
});

test('账号接口：无账号返回 []；缺 platform/未知平台 400', async (t) => {
  const harness = await startGatewayHarness(t);

  const emptyList = await harness.request('/_team/reverse/accounts?platform=qoder');
  assert.equal(emptyList.status, 200);
  assert.deepEqual(emptyList.body, []);

  const missingPlatform = await harness.request('/_team/reverse/accounts');
  assert.equal(missingPlatform.status, 400);

  const unknownPlatform = await harness.request('/_team/reverse/accounts?platform=nope');
  assert.equal(unknownPlatform.status, 400);
});

test('回执脱敏：四个端点的回执里搜不到任何 token 字段或明文', async (t) => {
  stubDevicePollFetch(t);
  const harness = await startGatewayHarness(t);

  const startResponse = await harness.request('/_team/reverse/login/start', { method: 'POST', body: { platform: 'qoder' } });
  const pollResponse = await harness.request(`/_team/reverse/login/${startResponse.body.sessionId}`);
  const cancelResponse = await harness.request(`/_team/reverse/login/${startResponse.body.sessionId}/cancel`, { method: 'POST', body: {} });
  const accountsResponse = await harness.request('/_team/reverse/accounts?platform=qoder');

  const serialized = JSON.stringify([startResponse.body, pollResponse.body, cancelResponse.body, accountsResponse.body]);
  for (const forbidden of ['accessToken', 'refreshToken', 'machineToken', 'access_token', 'refresh_token', 'machine_token']) {
    assert.equal(serialized.includes(forbidden), false, `回执里出现了 ${forbidden}`);
  }
});
