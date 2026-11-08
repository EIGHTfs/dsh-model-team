// 凭据引用按**驱动声明的认证类型**分流：配置型驱动用 API Key 引用，账号型驱动用账号引用。
//
// 真实故障（2026-11-08）：Qoder 账号登录成功后，建群仍 400「apiKeyRef 必须是 env:/file:」，
// 因为校验写死了两种前缀、且发前解析把 `account:` 当 API Key 解析。
// 判定依据必须是驱动自己的 authKind，不能在这里写平台名。

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateGroupPayload } from '../src/gateway/group/groups.js';
import { getDriver, registerDriver } from '../src/gateway/drivers/index.js';
import { resolveAttemptContext } from '../src/gateway/transport/attempt-context.js';

// 账号型驱动：只需声明 authKind，本用例不关心它的实现细节
function ensureAccountDriver() {
  if (!getDriver('test-reverse-driver')) {
    registerDriver({
      id: 'test-reverse-driver',
      name: '测试账号型驱动',
      authKind: 'reverse-account',
      accessMode: 'reverse',
      authSchema: [],
    });
  }
  return 'test-reverse-driver';
}

function buildAccountGroup(patch = {}) {
  return {
    id: 'acct-group',
    name: '账号群',
    driver: ensureAccountDriver(),
    accessMode: 'reverse',
    auth: { apiKeyRef: 'account:someplatform/account-1' },
    models: { static: ['m1'] },
    ...patch,
  };
}

test('账号型驱动：account 引用通过校验', () => {
  const validated = validateGroupPayload(buildAccountGroup());
  assert.equal(validated.auth.apiKeyRef, 'account:someplatform/account-1');
});

test('账号型驱动：account 引用格式不对仍拒绝（不能带出多级路径）', () => {
  for (const badRef of ['account:', 'account:onlyPlatform', 'account:a/b/c']) {
    assert.throws(
      () => validateGroupPayload(buildAccountGroup({ auth: { apiKeyRef: badRef } })),
      /account 引用格式|apiKeyRef 必须是/,
      `${badRef} 应当被拒绝`,
    );
  }
});

test('配置型驱动：env/file 通过，account 引用被拒', () => {
  const officialGroup = {
    id: 'official-group',
    name: '官方群',
    driver: 'openai-compatible',
    accessMode: 'official',
    baseURL: 'https://example.invalid/v1',
    auth: { apiKeyRef: 'env:SOME_KEY' },
    models: { static: ['m1'] },
  };
  assert.equal(validateGroupPayload(officialGroup).auth.apiKeyRef, 'env:SOME_KEY');
  assert.throws(
    () => validateGroupPayload({ ...officialGroup, auth: { apiKeyRef: 'account:p/a' } }),
    /apiKeyRef 必须是/,
  );
});

test('明文凭证字段一律拒绝（账号型驱动也不例外）', () => {
  assert.throws(
    () => validateGroupPayload(buildAccountGroup({ auth: { apiKey: 'sk-plaintext' } })),
    /不允许出现明文凭证字段/,
  );
});

test('发前上下文：账号型驱动不走 API Key 解析，直接交给驱动', async () => {
  const driverId = ensureAccountDriver();
  const config = { groups: [buildAccountGroup({ driver: driverId })] };
  const resolved = await resolveAttemptContext({
    attempt: { platformId: 'acct-group', modelId: 'm1' },
    config,
    dataRoot: '/nonexistent-data-root',
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.equal(resolved.ok, true, '账号型驱动不应因 API Key 解析失败被判 DRIVER_FAILED');
  assert.equal(resolved.credentials, null, '凭据由驱动自己按账号引用取');
});
