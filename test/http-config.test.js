// HTTP 配置用例（docs/09 §11）：外部入口默认关闭、CORS 白名单（禁 `*`）、请求体上限、缺省值归一化。

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HTTP_PORT, DEFAULT_MAX_BODY_BYTES, resolveHttpConfig } from '../src/gateway/config.js';
import { chatAs, startGatewayHarness } from './helpers/gateway-harness.js';

test('resolveHttpConfig：缺省值按 §11（外部入口关闭、CORS 空、8MB）', () => {
  assert.deepEqual(resolveHttpConfig({}), {
    port: DEFAULT_HTTP_PORT,
    corsOrigins: [],
    externalOpenAiCompat: false,
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  });
  assert.equal(DEFAULT_HTTP_PORT, 3177);
});

test('resolveHttpConfig：非法类型回落缺省，`*` 被剔除', () => {
  const resolved = resolveHttpConfig({
    http: { port: 'not-a-port', corsOrigins: ['*', 'http://preview.test', ''], externalOpenAiCompat: 'yes', maxBodyBytes: -1 },
  });

  assert.equal(resolved.port, DEFAULT_HTTP_PORT);
  assert.deepEqual(resolved.corsOrigins, ['http://preview.test']);
  assert.equal(resolved.externalOpenAiCompat, false, '字符串 "yes" 不等于 true，不能被当成开启');
  assert.equal(resolved.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
});

test('外部入口默认关闭：/v1/chat/completions 返回 404 并带可执行提示', async (t) => {
  const harness = await startGatewayHarness(t, { http: { externalOpenAiCompat: false } });

  const chatResult = await harness.request('/v1/chat/completions', chatAs('sess-closed'));

  assert.equal(chatResult.status, 404);
  assert.equal(chatResult.body.error.code, 'not-found');
  assert.equal(chatResult.body.error.hint.includes('externalOpenAiCompat'), true);
});

test('CORS：白名单命中回 allow-origin/vary，未命中一律不回', async (t) => {
  const harness = await startGatewayHarness(t, { http: { corsOrigins: ['http://preview.test'] } });

  const allowedResponse = await fetch(`${harness.gatewayUrl}/_team/drivers`, { headers: { origin: 'http://preview.test' } });
  assert.equal(allowedResponse.headers.get('access-control-allow-origin'), 'http://preview.test');
  assert.equal(allowedResponse.headers.get('vary'), 'Origin');

  const deniedResponse = await fetch(`${harness.gatewayUrl}/_team/drivers`, { headers: { origin: 'http://evil.test' } });
  assert.equal(deniedResponse.headers.get('access-control-allow-origin'), null);

  const preflightResponse = await fetch(`${harness.gatewayUrl}/_team/groups`, {
    method: 'OPTIONS',
    headers: { origin: 'http://preview.test', 'access-control-request-method': 'POST' },
  });
  assert.equal(preflightResponse.status, 204);
  assert.equal(preflightResponse.headers.get('access-control-allow-methods').includes('POST'), true);
});

test('CORS：配置里的 `*` 不生效（禁止通配）', async (t) => {
  const harness = await startGatewayHarness(t, { http: { corsOrigins: ['*', 'http://preview.test'] } });

  const wildcardResponse = await fetch(`${harness.gatewayUrl}/_team/drivers`, { headers: { origin: 'http://anything.test' } });

  assert.equal(wildcardResponse.headers.get('access-control-allow-origin'), null);
});

test('maxBodyBytes 可配置：超上限返回 413', async (t) => {
  const harness = await startGatewayHarness(t, { http: { maxBodyBytes: 20 } });

  const oversizedResult = await harness.request('/_team/groups', {
    method: 'POST',
    body: { id: 'oversized', name: '这个请求体肯定超过二十个字节了' },
  });

  assert.equal(oversizedResult.status, 413);
  assert.equal(oversizedResult.body.error.code, 'payload-too-large');
});
