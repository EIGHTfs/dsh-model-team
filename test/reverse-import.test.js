// 凭据导入框架用例（通用框架 + 反代落盘 sink）：
//   注册表可扩展、不可用源带原因、导入打 origin/refreshable、重复导入是更新、
//   已存在自己登录的账号不被覆盖、manual 缺字段明确报错、回执与日志都不含 token。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  IMPORT_SOURCE_ERROR_CODES,
  describeImportSources,
  getImportSource,
  importCredential,
  listImportSources,
  registerImportSource,
} from '../src/reverse/core/import/index.js';
import { createAccountStore } from '../src/reverse/core/account-store.js';
import { createReverseImportSink, toPublicAccount } from '../src/reverse/core/import-sink.js';
import { startGatewayHarness } from './helpers/gateway-harness.js';
// 反代路由是「贡献式」的：transport 不再自动挂载，测试里显式注册一次（与插件入口同一入口）
import { registerReverse } from '../src/reverse/register.js';

await registerReverse({ logger: { info() {}, warn() {}, error() {} } });
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

const MANUAL_CREDENTIAL = Object.freeze({
  accessToken: 'imported-access-token',
  refreshToken: 'imported-refresh-token',
  userId: 'user-imported-01',
  nickname: '导入账号',
  machineId: 'machine-imported',
  machineToken: 'machine-token-imported',
  machineType: 'x86_64_linux',
});

function createHarnessDeps(dataRoot, logger, credentials) {
  return { dataRoot, logger, deps: { credentials, sink: createReverseImportSink({ dataRoot, logger }) } };
}

test('注册表：内置两个源，自描述字段齐全，未知源返回 null', () => {
  const sources = listImportSources();
  const sourceIds = sources.map((source) => source.id);
  // 注册表是进程级的：别的用例可能注册了自定义源，这里只断言内置源都在
  assert.equal(sourceIds.includes('host-credentials'), true);
  assert.equal(sourceIds.includes('manual'), true);
  for (const source of sources) {
    assert.equal(typeof source.name, 'string');
    assert.equal(Array.isArray(source.platforms), true);
    assert.equal(typeof source.resolve, 'function');
  }
  assert.equal(getImportSource('nope'), null);
});

test('注册表可扩展：新增源 = 注册一个自描述对象；重复 id 明确报错', () => {
  const customSource = { id: 'custom-env', name: '环境变量', platforms: [], resolve: async () => ({ accessToken: 'x' }) };
  registerImportSource(customSource);
  assert.equal(getImportSource('custom-env'), customSource);
  assert.throws(() => registerImportSource({ id: 'custom-env', name: 'dup' }), /id 重复/);
});

test('可用性：宿主没有凭据服务 → host-credentials 不可用且带原因；manual 始终可用', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const { deps } = createHarnessDeps(dataRoot, logger, null);

  const descriptions = await describeImportSources({ deps });
  const hostSource = descriptions.find((entry) => entry.id === 'host-credentials');
  const manualSource = descriptions.find((entry) => entry.id === 'manual');

  assert.equal(hostSource.available, false);
  assert.equal(typeof hostSource.reason, 'string', '不可用必须给原因');
  assert.equal(manualSource.available, true);
});

test('导入（host-credentials）：只取 ref 指向的值，落盘标 origin/refreshable，回执与日志无 token', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const resolveCalls = [];
  const fakeCredentials = {
    async resolve(ref) {
      resolveCalls.push(ref);
      return { value: JSON.stringify(MANUAL_CREDENTIAL) };
    },
  };
  const { deps } = createHarnessDeps(dataRoot, logger, fakeCredentials);

  const result = await importCredential({ platform: 'qoder', sourceId: 'host-credentials', ref: 'qoder-main', deps });

  assert.deepEqual(resolveCalls, ['qoder-main'], '只按 ref 取值');
  assert.equal(result.outcome, 'imported');
  assert.equal(result.account.origin, 'import:host-credentials');
  assert.equal(result.account.refreshable, false, '导入不接管续期');
  assert.equal(result.account.userId, 'user-imported-01');

  const serializedResult = JSON.stringify(result);
  assert.equal(serializedResult.includes('imported-access-token'), false, '回执里不能有 accessToken');
  assert.equal(serializedResult.includes('imported-refresh-token'), false);
  assert.equal(serializedResult.includes('machine-token-imported'), false, '回执里不能有 machineToken');

  const serializedLogs = JSON.stringify(logger.lines);
  assert.equal(serializedLogs.includes('imported-access-token'), false, '日志里不能出现 token');
  assert.equal(serializedLogs.includes('machine-token-imported'), false);

  const accountStore = createAccountStore({ dataRoot, logger });
  const accounts = await accountStore.listAccounts('qoder');
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].credential.origin, 'import:host-credentials');
  assert.equal(accounts[0].credential.refreshable, false);
  assert.equal(accounts[0].credential.accessToken, 'imported-access-token', '值确实落盘了（只是不回显）');
});

test('导入：同一 userId 二次导入是更新（不新增账号文件）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const { deps } = createHarnessDeps(dataRoot, logger, null);

  const first = await importCredential({ platform: 'qoder', sourceId: 'manual', ref: MANUAL_CREDENTIAL, deps });
  const second = await importCredential({
    platform: 'qoder',
    sourceId: 'manual',
    ref: { ...MANUAL_CREDENTIAL, nickname: '改名后的导入账号' },
    deps,
  });

  assert.equal(first.outcome, 'imported');
  assert.equal(second.outcome, 'updated');
  assert.equal(second.account.accountId, first.account.accountId);
  assert.equal(second.account.nickname, '改名后的导入账号');
  const accounts = await createAccountStore({ dataRoot, logger }).listAccounts('qoder');
  assert.equal(accounts.length, 1, '同 userId 不许出现两个账号文件');
});

test('导入不覆盖自己登录的账号：已存在 refreshable=true → skipped + 原因', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const accountStore = createAccountStore({ dataRoot, logger });
  await accountStore.upsertByUserId('qoder', {
    ...MANUAL_CREDENTIAL,
    origin: 'login',
    refreshable: true,
  });
  const { deps } = createHarnessDeps(dataRoot, logger, null);

  const result = await importCredential({ platform: 'qoder', sourceId: 'manual', ref: MANUAL_CREDENTIAL, deps });

  assert.equal(result.outcome, 'skipped');
  assert.match(result.reason, /自己登录|refreshable/);
  const accounts = await accountStore.listAccounts('qoder');
  assert.equal(accounts[0].credential.accessToken, 'imported-access-token', '原账号内容不被改写');
  assert.equal(accounts[0].credential.refreshable, true);
});

test('manual 源：缺字段时明确报错并列出缺哪些（不猜、不拼半份凭据）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const { deps } = createHarnessDeps(dataRoot, logger, null);

  await assert.rejects(
    () => importCredential({ platform: 'qoder', sourceId: 'manual', ref: { accessToken: 'only-token' }, deps }),
    (error) => {
      assert.equal(error.code, IMPORT_SOURCE_ERROR_CODES.INVALID_CREDENTIAL);
      assert.match(error.message, /machineId/);
      assert.match(error.message, /machineToken/);
      return true;
    },
  );
});

test('未知源 / 缺 platform：明确错误码', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const { deps } = createHarnessDeps(dataRoot, logger, null);

  await assert.rejects(
    () => importCredential({ platform: 'qoder', sourceId: 'nope', deps }),
    (error) => error.code === IMPORT_SOURCE_ERROR_CODES.UNKNOWN_SOURCE,
  );
  await assert.rejects(
    () => importCredential({ sourceId: 'manual', ref: MANUAL_CREDENTIAL, deps }),
    (error) => error.code === IMPORT_SOURCE_ERROR_CODES.INVALID_CREDENTIAL,
  );
});

test('端点：GET /_team/reverse/import/sources 与 POST /_team/reverse/import（回执不含 token）', async (t) => {
  const harness = await startGatewayHarness(t);

  const sourcesResponse = await harness.request('/_team/reverse/import/sources');
  assert.equal(sourcesResponse.status, 200);
  const describedIds = sourcesResponse.body.map((entry) => entry.id);
  assert.equal(describedIds.includes('host-credentials'), true);
  assert.equal(describedIds.includes('manual'), true);
  const hostSource = sourcesResponse.body.find((entry) => entry.id === 'host-credentials');
  assert.equal(hostSource.available, false, '测试 harness 没有宿主凭据服务');

  const importResponse = await harness.request('/_team/reverse/import', {
    method: 'POST',
    body: { platform: 'qoder', sourceId: 'manual', ref: MANUAL_CREDENTIAL },
  });
  assert.equal(importResponse.status, 200);
  assert.equal(importResponse.body.outcome, 'imported');
  assert.equal(importResponse.body.account.refreshable, false);
  assert.equal(JSON.stringify(importResponse.body).includes('imported-access-token'), false);

  const invalidResponse = await harness.request('/_team/reverse/import', {
    method: 'POST',
    body: { platform: 'qoder', sourceId: 'manual', ref: { accessToken: 'x' } },
  });
  assert.equal(invalidResponse.status, 400);
});

test('public 视图：token 字段一律不出现（白名单式输出）', () => {
  const publicAccount = toPublicAccount({
    accountId: 'account-1',
    credential: {
      accessToken: 'a', refreshToken: 'b', machineToken: 'c',
      userId: 'u', nickname: 'n', machineId: 'm', machineType: 't',
      origin: 'import:manual', refreshable: false, updatedAt: '2026-11-07T00:00:00.000Z',
    },
  });
  assert.deepEqual(Object.keys(publicAccount).sort(),
    ['accountId', 'machineId', 'machineType', 'nickname', 'origin', 'refreshable', 'updatedAt', 'userId']);
  assert.equal(JSON.stringify(publicAccount).includes('"a"'), false);
});

test('导入后的账号文件权限仍是 0600（凭据落盘不因导入放宽）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const { deps } = createHarnessDeps(dataRoot, logger, null);
  const result = await importCredential({ platform: 'qoder', sourceId: 'manual', ref: MANUAL_CREDENTIAL, deps });

  const filePath = path.join(dataRoot, 'reverse', 'qoder', `${result.account.accountId}.json`);
  const stats = await fs.stat(filePath);
  assert.equal(stats.mode & 0o777, 0o600);
});

// 账号健康状态文件与账号文件同目录：列表里绝不能把它当账号（线上出现过 accountId="….state" 的脏条目）
test('listAccounts：排除账号健康状态文件（.state.json）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const accountStore = createAccountStore({ dataRoot, logger });
  // 唯一入库入口是 upsertByUserId（按 userId 判重）
  const written = await accountStore.upsertByUserId('qoder', {
    accessToken: 't', refreshToken: 'r', expiresAt: '2030-01-01T00:00:00Z', userId: 'u-real', nickname: '真实账号',
  });
  // 健康状态文件：与账号同目录、同样以 .json 结尾
  const healthDirectory = path.join(dataRoot, 'reverse', 'qoder');
  await fs.mkdir(healthDirectory, { recursive: true });
  await fs.writeFile(path.join(healthDirectory, written.accountId + '.state.json'), '{"hardFailStreak":0}', 'utf8');
  await fs.writeFile(path.join(healthDirectory, 'catalog.json'), '{"models":[]}', 'utf8');

  const accounts = await accountStore.listAccounts('qoder');
  assert.deepEqual(accounts.map((account) => account.accountId), [written.accountId], '只允许真实账号出现（.state 与 catalog 都不是账号）');
});
