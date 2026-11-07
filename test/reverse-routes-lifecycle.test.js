// 第 5 步：transport 不认识反代域，路由只在「域注册过」之后存在。
// 这三条断言钉住生命周期：注册前 404 → 注册后 200 → dispose 后 404。
import test from 'node:test';
import assert from 'node:assert/strict';

import { startGatewayHarness } from './helpers/gateway-harness.js';
import { registerReverse } from '../src/reverse/register.js';
import { createRecordingLogger } from './helpers/test-environment.js';

test('反代路由生命周期：注册前 404 → 注册后 200 → dispose 后 404', async (t) => {
  const harness = await startGatewayHarness(t);
  const logger = createRecordingLogger();

  const before = await harness.request('/_team/reverse/import/sources');
  assert.equal(before.status, 404, '域未挂载时该路径不存在（transport 不自动加载反代）');

  const registration = await registerReverse({ logger });
  const afterRegister = await harness.request('/_team/reverse/import/sources');
  assert.equal(afterRegister.status, 200);
  assert.equal(Array.isArray(afterRegister.body), true);

  registration.dispose();
  const afterDispose = await harness.request('/_team/reverse/import/sources');
  assert.equal(afterDispose.status, 404, 'dispose 后贡献路由撤销');

  // 收尾：把注册表清干净，避免影响同文件后续用例
  const { resetRouteContributorsForTest } = await import('../src/gateway/transport/route-contributors.js');
  resetRouteContributorsForTest();
});
