// 反代平台契约（M1）：形状校验逐条报错、注册表命名空间换算、身份判据常量。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IDENTITY_POLICY,
  REVERSE_DRIVER_PREFIX,
  assertPlatformShape,
  requiredPlatformFields,
} from '../src/gateway/reverse/types.js';
import { fromDriverId, getPlatform, listPlatforms, toDriverId } from '../src/gateway/reverse/index.js';
import { platform as qoderPlatform } from '../src/gateway/reverse/qoder/index.js';

// 合法平台的最小形状：用于逐字段做"删一个 → 必须报错"
function buildValidPlatform(overrides = {}) {
  return {
    id: 'demo',
    driverId: `${REVERSE_DRIVER_PREFIX}demo`,
    endpoints: { openApiBase: 'https://api.example.com' },
    capabilities: { streaming: true },
    createPlatform: () => ({ ok: true }),
    ...overrides,
  };
}

test('合法平台通过校验，且 requiredPlatformFields 覆盖五项', () => {
  assert.equal(assertPlatformShape(buildValidPlatform()).id, 'demo', '校验通过时把平台原样交回，便于注册表直接使用');
  assert.deepEqual([...requiredPlatformFields].sort(),
    ['capabilities', 'createPlatform', 'driverId', 'endpoints', 'id']);
});

test('缺 driverId → 报"缺 driverId"', () => {
  assert.throws(() => assertPlatformShape(buildValidPlatform({ driverId: undefined })), /缺 driverId|缺字段/);
});

test('driverId 不以 reverse- 开头 → 报命名空间错误', () => {
  assert.throws(() => assertPlatformShape(buildValidPlatform({ driverId: 'demo' })), /必须以 reverse- 开头/);
});

test('driverId 与 id 不匹配 → 报不匹配', () => {
  assert.throws(
    () => assertPlatformShape(buildValidPlatform({ id: 'demo', driverId: 'reverse-other' })),
    /不匹配/,
  );
});

test('缺 createPlatform → 报"缺 createPlatform"', () => {
  assert.throws(() => assertPlatformShape(buildValidPlatform({ createPlatform: undefined })), /缺 createPlatform|缺字段/);
});

test('注册表：qoder 已注册，命名空间换算只有一处且可逆', () => {
  const platforms = listPlatforms();

  assert.equal(platforms.length, 1);
  assert.equal(platforms[0].id, 'qoder');
  assert.equal(platforms[0].driverId, 'reverse-qoder');
  assert.equal(getPlatform('qoder'), qoderPlatform);
  assert.equal(getPlatform('not-a-platform'), null);

  assert.equal(toDriverId('qoder'), 'reverse-qoder');
  assert.equal(fromDriverId('reverse-qoder'), 'qoder');
  assert.equal(fromDriverId('qoder'), null, '裸 id 不是对外驱动名');
  assert.equal(fromDriverId('openai-compatible'), null);
});

test('平台元数据自描述：端点/超时/能力都在 platform 对象里，且不含网络实现', () => {
  assert.equal(qoderPlatform.endpoints.openApiBase, 'https://openapi.qoder.com.cn');
  assert.equal(typeof qoderPlatform.timeouts.requestMs, 'number');
  assert.equal(qoderPlatform.capabilities.streaming, true);
  assert.deepEqual([...qoderPlatform.capabilities.catalogKeys], ['qfmodel', 'dmodel']);

  const created = qoderPlatform.createPlatform({});
  // M1：需要网络/加密的方法必须显式"未实现"，不能悄悄发请求
  assert.throws(() => created.startDeviceLogin(), (error) => error.code === 'REVERSE_NOT_IMPLEMENTED');
  assert.throws(() => created.listModels(), (error) => error.code === 'REVERSE_NOT_IMPLEMENTED');
  assert.throws(() => created.encodeRequestBody(), (error) => error.code === 'REVERSE_NOT_IMPLEMENTED');
  // 纯函数已可用
  assert.equal(typeof created.decodeStreamChunk('data: [DONE]'), 'object');
});

test('身份判据（铁律 4）：判重键是 user_id，machine_* 与 access_token 明确不参与', () => {
  assert.equal(IDENTITY_POLICY.identityField, 'user_id');
  assert.equal(IDENTITY_POLICY.notIdentityFields.includes('machine_id'), true);
  assert.equal(IDENTITY_POLICY.notIdentityFields.includes('machine_type'), true);
  assert.equal(IDENTITY_POLICY.notIdentityFields.includes('access_token'), true);
  assert.equal(IDENTITY_POLICY.notIdentityFields.includes('user_id'), false, '判重键自己不能出现在排除名单里');
});
