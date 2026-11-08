// 模型探测的 **baseURL 适用范围**：只有「HTTP 探测型」驱动需要它。
//
// 事故背景（2026-11-08 实测）：反代群在加群页没有地址输入框（它不需要 baseURL），
// 但探测入口无条件要求 baseURL → 点「获取可用模型」必然 400「缺少 baseURL」，
// 用户看到的就是「模型列表获取不了」。baseURL 是探测**去哪个主机**拉 /models 用的，
// 账号型驱动的清单由驱动自己按目录返回，与主机地址无关。

import test from 'node:test';
import assert from 'node:assert/strict';

import { probeModels } from '../src/gateway/model/probe.js';
import { getDriver, registerDriver } from '../src/gateway/drivers/index.js';
import { AUTH_KINDS } from '../src/gateway/drivers/auth-kinds.js';

const logger = { info() {}, warn() {}, error() {} };

// 账号型假驱动：不需要 baseURL，模型清单由自己返回
function ensureAccountDriver() {
  const driverId = 'test-account-probe-driver';
  if (!getDriver(driverId)) {
    registerDriver({
      id: driverId,
      name: '账号型探测驱动',
      // accessMode 是驱动形状的必填位；这里选 reverse 与"账号型凭据"语义一致
      accessMode: 'reverse',
      authKind: AUTH_KINDS.REVERSE_ACCOUNT,
      authSchema: [],
      async fetchModels() {
        return [{ id: 'model-from-driver', name: 'model-from-driver' }];
      },
    });
  }
  return driverId;
}

test('账号型驱动：不要求 baseURL，清单来自驱动本身', async () => {
  const driverId = ensureAccountDriver();
  const result = await probeModels({
    body: { driverId, apiKeyRef: 'account:someplatform/account-1' },
    dataRoot: '/nonexistent-data-root',
    logger,
  });
  assert.equal(Array.isArray(result.models), true);
  assert.deepEqual(result.models.map((model) => model.id), ['model-from-driver']);
});

test('api-key 驱动：仍然要求 baseURL（旧行为不变，避免误配探测到错误主机）', async () => {
  await assert.rejects(
    () => probeModels({
      body: { driverId: 'openai-compatible', apiKeyRef: 'env:SOME_KEY' },
      dataRoot: '/nonexistent-data-root',
      logger,
    }),
    (error) => String(error.message).includes('baseURL'),
  );
});
