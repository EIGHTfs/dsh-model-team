// GET /_team/meta 用例：客户端 INV-14 的判定依据必须来自服务端"实际生效"的两个值（契约 02 §3.8）。
// 覆盖三条通道：真网关 HTTP（独立服务入口）、插件侧 deps 注入（providerIds 单一来源）、缺省回落。

import test from 'node:test';
import assert from 'node:assert/strict';
import { handleGatewayRequest } from '../src/gateway/transport/http-server.js';
import { resolveGatewayDeps } from '../src/gateway/gateway-deps.js';
import { registerGatewayRoutes } from '../src/plugin/web-routes.js';
import { writeConfig } from '../src/gateway/config/config.js';
import { DEFAULT_PROVIDER_ID } from '../src/plugin/adapter/adapter.js';
import { DEFAULT_VIRTUAL_MODEL_ID } from '../src/gateway/transport/router.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';
import { startGatewayHarness } from './helpers/gateway-harness.js';

// 假 res：捕获状态码与响应体（与 gateway-deps.test.js 同款，最小实现）
function createMockResponse() {
  return {
    captured: { statusCode: null, body: '' },
    headersSent: false,
    setHeader() {},
    writeHead(statusCode) {
      this.headersSent = true;
      this.captured.statusCode = statusCode;
    },
    end(chunk) {
      if (chunk !== undefined) this.captured.body += chunk;
      this.headersSent = true;
    },
    on() {},
    off() {},
  };
}

// 假 req：无请求体的 GET
function createMockRequest(url) {
  return {
    method: 'GET',
    url,
    headers: { host: 'localhost' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {},
    on() {},
    off() {},
  };
}

test('GET /_team/meta：缺省给出虚拟模型名与注册路由名，且与 /v1/models 同源', async (t) => {
  const harness = await startGatewayHarness(t);

  const metaResponse = await harness.request('/_team/meta');
  assert.equal(metaResponse.status, 200);
  assert.deepEqual(metaResponse.body, {
    virtualModel: DEFAULT_VIRTUAL_MODEL_ID,
    providerIds: [DEFAULT_PROVIDER_ID],
  });

  // 同一份解析函数：/v1/models 暴露的 id 与 meta 报的 virtualModel 不能分叉
  const modelsResponse = await harness.request('/v1/models');
  assert.equal(modelsResponse.body.data[0].id, metaResponse.body.virtualModel);

  // 无副作用：重复请求结果逐字节一致（不写状态、不读 session）
  const repeatedResponse = await harness.request('/_team/meta');
  assert.equal(repeatedResponse.raw, metaResponse.raw);
});

test('GET /_team/meta：部署方改 config.virtualModel 后客户端拿到的是新值', async (t) => {
  const harness = await startGatewayHarness(t, { config: { virtualModel: 'team-custom' } });

  const metaResponse = await harness.request('/_team/meta');
  assert.equal(metaResponse.body.virtualModel, 'team-custom');

  const modelsResponse = await harness.request('/v1/models');
  assert.equal(modelsResponse.body.data[0].id, 'team-custom', '两个端点必须同源解析 virtualModel');
});

test('GET /_team/meta：插件注入的 providerIds 原样透传到 handler（不在网关另算一份）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  await writeConfig({ groups: [] }, { dataRoot });
  const logger = createRecordingLogger();
  const injectedProviderIds = ['team-a', 'team-b'];

  // 同一个数组必须原样透传：复制一份就可能与 registerAdapter 收到的对不上
  assert.equal(resolveGatewayDeps({ providerIds: injectedProviderIds }).providerIds, injectedProviderIds);
  assert.deepEqual(resolveGatewayDeps({}).providerIds, [DEFAULT_PROVIDER_ID], '独立网关回落成注册缺省');

  const mockResponse = createMockResponse();
  await handleGatewayRequest({
    incomingRequest: createMockRequest('/_team/meta'),
    outgoingResponse: mockResponse,
    dataRoot,
    logger,
    providerIds: injectedProviderIds,
  });

  assert.equal(mockResponse.captured.statusCode, 200);
  assert.deepEqual(JSON.parse(mockResponse.captured.body).providerIds, injectedProviderIds);
});

test('GET /_team/meta：插件 webServer 注册通道同样带上注入的 providerIds', async (t) => {
  const dataRoot = await createTempDirectory(t);
  await writeConfig({ groups: [] }, { dataRoot });
  const logger = createRecordingLogger();
  const injectedProviderIds = ['route-a', 'route-b'];
  const registrations = [];
  const fakeWebServer = {
    register(registerOptions) {
      registrations.push(registerOptions);
      return () => {};
    },
  };

  registerGatewayRoutes({ webServer: fakeWebServer, config: { groups: [] }, dataRoot, logger, providerIds: injectedProviderIds });

  const mockResponse = createMockResponse();
  await registrations[0].handler(createMockRequest('/_team/meta'), mockResponse);

  assert.equal(mockResponse.captured.statusCode, 200);
  assert.deepEqual(JSON.parse(mockResponse.captured.body), {
    virtualModel: DEFAULT_VIRTUAL_MODEL_ID,
    providerIds: injectedProviderIds,
  });
});
