// 第 9 步：同平台复用会话 + 按平台轮询（任何一次授权都不被丢弃）+ 领取幂等。
import test from 'node:test';
import assert from 'node:assert/strict';

import { startGatewayHarness } from './helpers/gateway-harness.js';
import { registerReverse } from '../src/reverse/register.js';
import { createRecordingLogger } from './helpers/test-environment.js';
import { resetReverseLoginSessionsForTest } from '../src/reverse/routes/login.js';

await registerReverse({ logger: createRecordingLogger() });

// 轮询桩：默认 404（未授权）；granted=true 时返回 token + userinfo
function stubLoginUpstream(t) {
  const originalFetch = globalThis.fetch;
  const state = { granted: false, pollCalls: 0 };
  globalThis.fetch = (requestUrl, requestInit) => {
    const url = String(requestUrl);
    if (url.includes('/api/v1/deviceToken/poll')) {
      state.pollCalls += 1;
      if (!state.granted) return Promise.resolve(new Response('{"errorCode":"NotFound"}', { status: 404, headers: { 'content-type': 'application/json' } }));
      return Promise.resolve(new Response(JSON.stringify({ token: 'granted-access-token', refresh_token: 'granted-refresh-token' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (url.includes('/api/v1/userinfo')) {
      return Promise.resolve(new Response(JSON.stringify({ user_id: 'user-reuse-01', name: '复用账号' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return originalFetch(requestUrl, requestInit);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return state;
}

test('同平台 start 两次 → 复用同一会话（reused:true，不新建授权页）', async (t) => {
  resetReverseLoginSessionsForTest();
  stubLoginUpstream(t);
  const harness = await startGatewayHarness(t);

  const first = await harness.request('/_team/reverse/login/start', { method: 'POST', body: { platform: 'qoder' } });
  const second = await harness.request('/_team/reverse/login/start', { method: 'POST', body: { platform: 'qoder' } });

  assert.equal(first.status, 200);
  assert.equal(first.body.reused, false);
  assert.equal(second.body.reused, true, '第二次必须复用');
  assert.equal(second.body.sessionId, first.body.sessionId);
  assert.equal(second.body.loginUrl, first.body.loginUrl, '同一个授权页，用户不会拿到第二个');
});

test('按平台轮询：pending → granted 只入库一次，再调仍 granted 且账号数不变', async (t) => {
  resetReverseLoginSessionsForTest();
  const upstream = stubLoginUpstream(t);
  const harness = await startGatewayHarness(t);

  await harness.request('/_team/reverse/login/start', { method: 'POST', body: { platform: 'qoder' } });

  const pending = await harness.request('/_team/reverse/login/status?platform=qoder');
  assert.equal(pending.status, 200);
  assert.equal(pending.body.status, 'pending');
  assert.equal(pending.body.sessionCount, 1);

  upstream.granted = true;
  const granted = await harness.request('/_team/reverse/login/status?platform=qoder');
  assert.equal(granted.body.status, 'granted');
  assert.equal(granted.body.account.userId, 'user-reuse-01');
  assert.equal(granted.body.account.refreshable, true);
  assert.equal(JSON.stringify(granted.body).includes('granted-access-token'), false, '回执脱敏');

  const again = await harness.request('/_team/reverse/login/status?platform=qoder');
  assert.equal(again.body.status, 'granted');
  assert.equal(again.body.account.accountId, granted.body.account.accountId, '幂等：同一账号');

  const accounts = await harness.request('/_team/reverse/accounts?platform=qoder');
  assert.equal(accounts.body.length, 1, '同一会话只入库一次');
});

test('按平台轮询：没有会话 → expired；未知平台 → 400', async (t) => {
  resetReverseLoginSessionsForTest();
  const harness = await startGatewayHarness(t);

  const expired = await harness.request('/_team/reverse/login/status?platform=qoder');
  assert.equal(expired.status, 200);
  assert.equal(expired.body.status, 'expired');

  const unknown = await harness.request('/_team/reverse/login/status?platform=nope');
  assert.equal(unknown.status, 400);
});
