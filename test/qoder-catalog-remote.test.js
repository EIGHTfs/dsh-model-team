// Qoder 模型目录：运行时远端拉取（GET 带 body + COSY 头）+ TTL 缓存，不再有静态清单。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  CATALOG_ERROR_CODES,
  CATALOG_PATH,
  catalogCacheFilePath,
  fetchRemoteCatalog,
  parseCatalogPayload,
  resetCatalogCacheForTest,
} from '../src/reverse/platforms/qoder/catalog.js';
import { qoderEncode } from '../src/reverse/platforms/qoder/crypto/native.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

const ENDPOINTS = Object.freeze({ inferBase: 'https://gateway.example' });
const CREDENTIAL = Object.freeze({
  accountId: 'account-1',
  userId: 'user-1',
  accessToken: 'access-token',
  machineId: 'machine-id',
  machineToken: 'machine-token',
  machineType: 'machine-type',
});

function buildStubFetch({ status = 200, bodyText, calls = [] } = {}) {
  return async (requestUrl, requestInit) => {
    calls.push({ url: String(requestUrl), method: requestInit?.method, headers: requestInit?.headers, body: requestInit?.body });
    return { status, text: async () => bodyText };
  };
}

test('远端目录：解析 payload.chat，补 id/name，其它字段原样保留', async (t) => {
  resetCatalogCacheForTest();
  const calls = [];
  const bodyText = JSON.stringify({ chat: [
    { key: 'model-a', display_name: 'A 模型', price_factor: 2, is_free: false, enabled: true, minimal_version: '1.1.70' },
    { key: 'model-b' },
  ] });
  const fetchImpl = buildStubFetch({ bodyText, calls });

  const result = await fetchRemoteCatalog({
    platformId: 'qoder',
    credential: CREDENTIAL,
    endpoints: ENDPOINTS,
    dataRoot: await createTempDirectory(t),
    logger: createRecordingLogger(),
    fetchImpl,
    allowFetchImplForCatalog: true,   // 显式声明"这是测试桩"：生产永不把 fetch 当客户端
  });

  assert.equal(result.models.length, 2);
  assert.equal(result.models[0].id, 'model-a');
  assert.equal(result.models[0].name, 'A 模型');
  assert.equal(result.models[0].price_factor, 2, '其它字段必须原样保留');
  assert.equal(result.models[0].enabled, true);
  assert.equal(result.models[1].name, 'model-b', '没有 display_name 时回落到 key');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /\/algo\/api\/v2\/model\/list\?Encode=1$/);
  assert.equal(calls[0].body, qoderEncode(Buffer.from('{}', 'utf8')), 'GET 也要带签名 body');
  assert.equal(calls[0].headers.accept, 'application/json', 'sse=False 语义');
  assert.equal('cache-control' in calls[0].headers, false, '不该带 no-cache');
});

test('远端目录：响应不是明文 JSON → REVERSE_CATALOG_UNDECRYPTABLE（不猜、不回落）', async (t) => {
  resetCatalogCacheForTest();
  const dataRoot = await createTempDirectory(t);
  await assert.rejects(
    () => fetchRemoteCatalog({
      platformId: 'qoder',
      credential: CREDENTIAL,
      endpoints: ENDPOINTS,
      dataRoot,
      logger: createRecordingLogger(),
      fetchImpl: buildStubFetch({ bodyText: '\u0001\u0002 encrypted-bytes' }),
      allowFetchImplForCatalog: true,
    }),
    (error) => error.code === CATALOG_ERROR_CODES.UNDECRYPTABLE,
  );
});

test('远端目录：HTTP 403 → 带状态码的明确错误（不回落静态表）', async (t) => {
  resetCatalogCacheForTest();
  const dataRoot = await createTempDirectory(t);
  await assert.rejects(
    () => fetchRemoteCatalog({
      platformId: 'qoder',
      credential: CREDENTIAL,
      endpoints: ENDPOINTS,
      dataRoot,
      logger: createRecordingLogger(),
      fetchImpl: buildStubFetch({ status: 403, bodyText: '{"message":"forbidden"}' }),
      allowFetchImplForCatalog: true,
    }),
    (error) => error.code === CATALOG_ERROR_CODES.UPSTREAM_FAILED && error.status === 403,
  );
});

test('缓存：同进程两次只打一次上游；TTL 过期后重拉', async (t) => {
  resetCatalogCacheForTest();
  const dataRoot = await createTempDirectory(t);
  const calls = [];
  const fetchImpl = buildStubFetch({ bodyText: JSON.stringify({ chat: [{ key: 'model-a' }] }), calls });
  let nowMs = 1_000_000;

  const first = await fetchRemoteCatalog({ platformId: 'qoder', credential: CREDENTIAL, endpoints: ENDPOINTS, dataRoot, logger: createRecordingLogger(), fetchImpl, allowFetchImplForCatalog: true, now: () => nowMs });
  const second = await fetchRemoteCatalog({ platformId: 'qoder', credential: CREDENTIAL, endpoints: ENDPOINTS, dataRoot, logger: createRecordingLogger(), fetchImpl, allowFetchImplForCatalog: true, now: () => nowMs });
  assert.equal(calls.length, 1, 'TTL 内只打一次上游');
  assert.equal(second.fromCache, true);
  assert.deepEqual(second.models, first.models);

  // 磁盘缓存文件带 fetchedAt 与 0600
  const cacheFile = catalogCacheFilePath({ dataRoot, platformId: 'qoder' });
  const cacheStats = await fs.stat(cacheFile);
  assert.equal(cacheStats.mode & 0o777, 0o600);

  nowMs += 11 * 60 * 1000;   // TTL 10 分钟之后
  resetCatalogCacheForTest();  // 模拟"进程内缓存也没了"（换进程/重启），此时应读盘判断过期
  await fetchRemoteCatalog({ platformId: 'qoder', credential: CREDENTIAL, endpoints: ENDPOINTS, dataRoot, logger: createRecordingLogger(), fetchImpl, allowFetchImplForCatalog: true, now: () => nowMs });
  assert.equal(calls.length, 2, '过期后必须重拉');
});

test('目录解析：缺少 chat 数组 → SHAPE_INVALID', () => {
  assert.throws(() => parseCatalogPayload('{"data":{}}'), (error) => error.code === CATALOG_ERROR_CODES.SHAPE_INVALID);
});

test('源码里不许再出现写死的模型名（防止有人把静态清单塞回来）', async () => {
  const sourceRoot = new URL('../src/', import.meta.url);
  const offenders = [];
  const walk = async (directoryUrl) => {
    const entries = await fs.readdir(directoryUrl, { withFileTypes: true });
    for (const entry of entries) {
      const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directoryUrl);
      if (entry.isDirectory()) {
        await walk(entryUrl);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const sourceText = await fs.readFile(entryUrl, 'utf8');
      if (/qfmodel|dmodel/.test(sourceText)) offenders.push(path.relative(new URL('../', import.meta.url).pathname, entryUrl.pathname));
    }
  };
  await walk(sourceRoot);
  assert.deepEqual(offenders, []);
});
