// 请求依赖缺省值用例：两条入口（独立 HTTP 服务 / 插件内 webServer 路由）必须行为一致。
// 背景：插件侧曾未传 clock，导致所有写路径取 clock.nowMs() 抛错 → 500。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveGatewayDeps } from '../src/gateway/gateway-deps.js';
import { createGatewayServer, handleGatewayRequest } from '../src/gateway/http-server.js';
import { registerGatewayRoutes } from '../src/plugin/web-routes.js';
import { writeConfig } from '../src/gateway/config.js';
import { createRecordingLogger, createTempDirectory, setEnvironmentVariableForTest } from './helpers/test-environment.js';

const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function buildGroupConfig(baseURL) {
  return {
    id: 'agnes',
    name: '群A',
    accessMode: 'official',
    driver: 'openai-compatible',
    baseURL,
    auth: { type: 'bearer', apiKeyRef: 'env:DSH_MODEL_TEAM_TEST_API_KEY' },
    models: { endpoint: '/models' },
  };
}

// 假 res：捕获状态码与响应体
function createMockResponse() {
  return {
    captured: { statusCode: null, body: '' },
    headersSent: false,
    setHeader() {},
    writeHead(statusCode) {
      this.headersSent = true;
      this.captured.statusCode = statusCode;
    },
    write(chunk) {
      this.captured.body += chunk;
    },
    end(chunk) {
      if (chunk !== undefined) {
        this.captured.body += chunk;
      }
      this.headersSent = true;
    },
    on() {},
    off() {},
  };
}

// 假 req：可带 JSON 请求体
function createMockRequest({ method = 'GET', url = '/', body } = {}) {
  const requestBodyText = body === undefined ? '' : JSON.stringify(body);
  return {
    method,
    url,
    headers: { host: 'localhost', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (requestBodyText.length > 0) {
        yield Buffer.from(requestBodyText);
      }
    },
    on() {},
    off() {},
  };
}

// 记录注册参数的假 webServer
function createFakeWebServer() {
  const registrations = [];
  return {
    registrations,
    register(registerOptions) {
      registrations.push(registerOptions);
      return () => {};
    },
  };
}

async function prepareDataRoot(t) {
  // 测试用假 Key（仅用于让凭证解引用通过，不代表任何真实凭据）
  setEnvironmentVariableForTest(t, 'DSH_MODEL_TEAM_TEST_API_KEY', 'test-key-not-real');
  const dataRoot = await createTempDirectory(t);
  await writeConfig({ groups: [buildGroupConfig('http://127.0.0.1:9/v1')] }, { dataRoot });
  return dataRoot;
}

test('resolveGatewayDeps：缺省值集中给出（clock/fetchImpl/jsonlResolver/logger）', () => {
  const deps = resolveGatewayDeps({});

  assert.equal(typeof deps.clock.nowMs, 'function');
  assert.equal(deps.fetchImpl, globalThis.fetch, '缺省用运行时 fetch');
  assert.equal(typeof deps.jsonlResolver, 'function');
  assert.equal(typeof deps.logger.info, 'function');
  assert.equal(typeof deps.dataRoot, 'string');
});

test('resolveGatewayDeps：显式注入优先（同一对象原样透传）', () => {
  const injectedClock = { nowMs: () => 1, formatTime: () => '00:00:00', createRequestId: () => 'req-x' };
  const injectedFetch = async () => null;
  const deps = resolveGatewayDeps({ clock: injectedClock, fetchImpl: injectedFetch, dataRoot: '/tmp/x' });

  assert.equal(deps.clock, injectedClock);
  assert.equal(deps.fetchImpl, injectedFetch);
  assert.equal(deps.dataRoot, '/tmp/x');
});

test('插件入口不传 clock：PUT /_team/session/:id/target 仍 200，updatedAt 是合法 ISO', async (t) => {
  const dataRoot = await prepareDataRoot(t);
  const logger = createRecordingLogger();
  const webServer = createFakeWebServer();

  // 关键：不传 clock / fetchImpl / jsonlResolver，模拟插件侧只给 dataRoot+logger
  await registerGatewayRoutes({ webServer, config: { groups: [buildGroupConfig('http://127.0.0.1:9/v1')] }, dataRoot, logger });

  const routeHandler = webServer.registrations[0].handler;
  const mockResponse = createMockResponse();
  await routeHandler(
    createMockRequest({
      method: 'PUT',
      url: '/_team/session/sess-clk/target',
      body: { type: 'model', id: 'agnes-3.0-flash', platformId: 'agnes' },
    }),
    mockResponse,
  );

  assert.equal(mockResponse.captured.statusCode, 200, '写路径不能因缺 clock 崩');
  const responseBody = JSON.parse(mockResponse.captured.body);
  assert.deepEqual(responseBody.target, { type: 'model', id: 'agnes-3.0-flash', platformId: 'agnes' });

  const mappingFile = path.join(dataRoot, 'sessions', `${encodeURIComponent('sess-clk')}.json`);
  const storedMapping = JSON.parse(await fs.readFile(mappingFile, 'utf8'));
  assert.match(storedMapping.updatedAt, ISO_DATE_TIME_PATTERN, 'updatedAt 必须是合法 ISO 时间');
});

test('两条入口一致性：同一请求经独立服务与插件路由返回相同形状', async (t) => {
  const dataRoot = await prepareDataRoot(t);
  const logger = createRecordingLogger();

  // 入口 A：独立 HTTP 服务
  const server = createGatewayServer({ dataRoot, logger });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const serverPort = server.address().port;
  const standaloneResponse = await fetch(`http://127.0.0.1:${serverPort}/_team/groups`);
  const standaloneBody = await standaloneResponse.json();

  // 入口 B：插件内注册的同一个 handler
  const webServer = createFakeWebServer();
  const pluginConfig = { groups: [buildGroupConfig('http://127.0.0.1:9/v1')] };
  await registerGatewayRoutes({ webServer, config: pluginConfig, dataRoot, logger });
  const mockResponse = createMockResponse();
  await webServer.registrations[0].handler(createMockRequest({ url: '/_team/groups' }), mockResponse);
  const pluginBody = JSON.parse(mockResponse.captured.body);

  assert.equal(standaloneResponse.status, 200);
  assert.equal(mockResponse.captured.statusCode, 200);
  assert.deepEqual(pluginBody, standaloneBody, '两条入口对同一请求必须返回同形状结果');
  assert.equal(Array.isArray(standaloneBody.groups), true);
});

test('fetchImpl 注入生效、缺省回落到全局 fetch', async (t) => {
  const dataRoot = await prepareDataRoot(t);
  const logger = createRecordingLogger();
  const webServer = createFakeWebServer();
  const upstreamCalls = [];

  const stubFetch = async (requestUrl) => {
    upstreamCalls.push(String(requestUrl));
    return new Response(JSON.stringify({ data: [{ id: 'model-from-stub' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await registerGatewayRoutes({
    webServer,
    config: { groups: [buildGroupConfig('http://127.0.0.1:9/v1')] },
    dataRoot,
    logger,
    fetchImpl: stubFetch,
  });

  const mockResponse = createMockResponse();
  await webServer.registrations[0].handler(
    createMockRequest({ url: '/_team/groups/agnes/models' }),
    mockResponse,
  );

  assert.equal(mockResponse.captured.statusCode, 200);
  assert.equal(upstreamCalls.length, 1, '上游请求必须走注入的 fetch');
  assert.equal(JSON.parse(mockResponse.captured.body).models[0].id, 'model-from-stub');
  assert.equal(resolveGatewayDeps({}).fetchImpl, globalThis.fetch, '未注入时缺省仍是全局 fetch');
});
