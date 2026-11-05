// 凭证引用用例：env:/file: 两条成功路径 + 六类失败路径，全部要求"返回明确错误、不抛异常"。
// 测试只用假 Key（test-key-not-real），任何真实凭证都不进仓库。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CREDENTIALS_API_KEY_FIELD,
  CREDENTIAL_FAILURE_CODES,
  resolveApiKeyRef,
  resolveGroupCredentials,
} from '../src/gateway/config/credentials.js';
import { createTempDirectory } from './helpers/test-environment.js';

// 假凭证：只用于断言解析结果，不具备任何真实访问能力
const FAKE_API_KEY = 'test-key-not-real';

test('凭证：env: 引用解析成功并带上来源', async () => {
  const resolved = await resolveApiKeyRef('env:AGNES_API_KEY', { environment: { AGNES_API_KEY: FAKE_API_KEY } });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.value, FAKE_API_KEY);
  assert.equal(resolved.source, 'env:AGNES_API_KEY');
});

test('凭证：env: 变量未设置时返回 ENV_NOT_SET，不抛错', async () => {
  const resolved = await resolveApiKeyRef('env:AGNES_API_KEY_MISSING', { environment: {} });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, CREDENTIAL_FAILURE_CODES.ENV_NOT_SET);
  assert.match(resolved.message, /AGNES_API_KEY_MISSING/);
});

test('凭证：env: 变量值为空白视为未设置', async () => {
  const resolved = await resolveApiKeyRef('env:BLANK_KEY', { environment: { BLANK_KEY: '   ' } });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, CREDENTIAL_FAILURE_CODES.ENV_NOT_SET);
});

test('凭证：env: 后缺少变量名返回 EMPTY_TARGET', async () => {
  const resolved = await resolveApiKeyRef('env:', { environment: {} });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, CREDENTIAL_FAILURE_CODES.EMPTY_TARGET);
});

test('凭证：file: 相对路径以数据根为基准解析，并裁掉文件末尾换行', async (t) => {
  const dataRoot = await createTempDirectory(t);
  await fs.writeFile(path.join(dataRoot, 'agnes.key'), `${FAKE_API_KEY}\n`, 'utf8');

  const resolved = await resolveApiKeyRef('file:agnes.key', { dataRoot });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.value, FAKE_API_KEY, '文件末尾换行不属于 Key 本身');
});

test('凭证：file: 绝对路径可用', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const keyFilePath = path.join(dataRoot, 'key.txt');
  await fs.writeFile(keyFilePath, FAKE_API_KEY, 'utf8');

  const resolved = await resolveApiKeyRef(`file:${keyFilePath}`, { dataRoot });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.value, FAKE_API_KEY);
});

test('凭证：file: 文件不存在返回 FILE_NOT_FOUND', async (t) => {
  const dataRoot = await createTempDirectory(t);

  const resolved = await resolveApiKeyRef('file:not-here.key', { dataRoot });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, CREDENTIAL_FAILURE_CODES.FILE_NOT_FOUND);
});

test('凭证：file: 文件内容为空返回 EMPTY_VALUE', async (t) => {
  const dataRoot = await createTempDirectory(t);
  await fs.writeFile(path.join(dataRoot, 'empty.key'), '\n  \n', 'utf8');

  const resolved = await resolveApiKeyRef('file:empty.key', { dataRoot });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, CREDENTIAL_FAILURE_CODES.EMPTY_VALUE);
});

test('凭证：未知前缀被拒绝，绝不把引用串当 Key 发出去', async () => {
  const resolved = await resolveApiKeyRef('vault:agnes', { environment: {} });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, CREDENTIAL_FAILURE_CODES.UNSUPPORTED_SCHEME);
});

test('凭证：空引用与缺失引用返回 MISSING_REF', async () => {
  const emptyResolved = await resolveApiKeyRef('   ', { environment: {} });
  const missingResolved = await resolveApiKeyRef(undefined, { environment: {} });

  assert.equal(emptyResolved.code, CREDENTIAL_FAILURE_CODES.MISSING_REF);
  assert.equal(missingResolved.code, CREDENTIAL_FAILURE_CODES.MISSING_REF);
});

test('凭证：群级解析产出 { apiKey }，失败时给出空凭证与错误明细', async () => {
  const successGroup = { id: 'agnes', auth: { type: 'bearer', apiKeyRef: 'env:AGNES_API_KEY' } };
  const successResult = await resolveGroupCredentials(successGroup, { environment: { AGNES_API_KEY: FAKE_API_KEY } });

  assert.equal(successResult.ok, true);
  assert.deepEqual(successResult.credentials, { [CREDENTIALS_API_KEY_FIELD]: FAKE_API_KEY });

  const failureGroup = { id: 'broken', auth: { apiKeyRef: 'env:NOT_SET_ANYWHERE' } };
  const failureResult = await resolveGroupCredentials(failureGroup, { environment: {} });

  assert.equal(failureResult.ok, false);
  assert.deepEqual(failureResult.credentials, {});
  assert.equal(failureResult.error.code, CREDENTIAL_FAILURE_CODES.ENV_NOT_SET);
});
