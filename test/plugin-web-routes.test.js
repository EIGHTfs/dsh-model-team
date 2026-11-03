// 插件 webServer 路由用例：同源挂载 /_team、/v1 门禁、webServer 缺失降级、effect 注销、适配层能真出 JSON。
// 这些是"只有真机装配才暴露"的那一类问题的可测替身：单测用假 webServer，但断言的是真实注册参数与真实响应。

import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/plugin/index.js';
import { OPENAI_ROUTE_PREFIX, TEAM_ROUTE_PREFIX } from '../src/plugin/web-routes.js';
import { writeConfig } from '../src/gateway/config.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

// 桩 LlmAdapter / LlmError：让 apply 能走完 adapter 注册
class StubLlmAdapter {}
class StubLlmError extends Error {}

// 假 webServer：记录注册参数、提供 disposer
function createFakeWebServer({ throwOnRegister } = {}) {
  const registrations = [];
  const disposedPaths = [];
  return {
    registrations,
    disposedPaths,
    register(registerOptions) {
      if (throwOnRegister) {
        throw throwOnRegister;
      }
      registrations.push(registerOptions);
      return () => disposedPaths.push(registerOptions.path);
    },
  };
}

// 假 ctx：实现 inject → callback(webContext)，并在 webContext.effect 里执行工厂（模拟 cordis 的立即生效语义）
function createFakeContext({ webServer, throwOnInject } = {}) {
  const disposableFactories = [];
  const fakeContext = {
    llm: { registerAdapter() {} },
    injectedServiceNames: null,
    inject(serviceNames, injectCallback) {
      fakeContext.injectedServiceNames = serviceNames;
      if (throwOnInject) {
        throw throwOnInject;
      }
      const webContext = {
        get: (serviceName) => (serviceName === 'webServer' ? webServer : undefined),
        effect: (effectFactory) => {
          // cordis 在 fiber 激活时会立刻执行 effect 工厂并持有它返回的 disposer，
          // 假 ctx 必须照同样语义执行，否则"注册发生在 effect 里"会被漏测
          const disposer = effectFactory();
          disposableFactories.push(() => disposer);
        },
      };
      injectCallback(webContext);
    },
  };
  fakeContext.disposableFactories = disposableFactories;
  return fakeContext;
}

// 取出 effect 返回的 disposer（cordis 会在 fiber 销毁时调用它们）
function runEffectFactories(fakeContext) {
  return fakeContext.disposableFactories.map((getDisposer) => getDisposer());
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

// 假 req：GET 无请求体，需要能异步迭代（管道会读一次 body）
function createMockRequest({ method = 'GET', url = '/', host = 'localhost' } = {}) {
  return {
    method,
    url,
    headers: { host, 'user-agent': 'web-server-test' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {},
    on() {},
    off() {},
  };
}

async function preparePlugin(t, { httpConfig = {}, webServer, throwOnInject } = {}) {
  const dataRoot = await createTempDirectory(t);
  await writeConfig({ groups: [], http: httpConfig }, { dataRoot });
  const logger = createRecordingLogger();
  // 先定好 webServer 再建 ctx：webServer 传 null 表示"服务缺失"用例
  const targetWebServer = webServer === undefined ? createFakeWebServer() : webServer;
  const fakeContext = createFakeContext({ webServer: targetWebServer, throwOnInject });

  await apply(fakeContext, {
    dataRoot,
    logger,
    llmModule: { LlmAdapter: StubLlmAdapter, LlmError: StubLlmError },
  });

  return { dataRoot, logger, fakeContext, webServer: targetWebServer };
}

test('webServer 存在：注册 /_team（kind=prefix），externalOpenAiCompat 关闭时不挂 /v1', async (t) => {
  const webServer = createFakeWebServer();
  const { fakeContext } = await preparePlugin(t, { webServer });

  assert.deepEqual(fakeContext.injectedServiceNames, ['webServer'], '必须走 ctx.inject 拿 webServer');
  assert.equal(webServer.registrations.length, 1, '默认只挂 /_team 一条');
  assert.equal(webServer.registrations[0].kind, 'prefix');
  assert.equal(webServer.registrations[0].path, TEAM_ROUTE_PREFIX);
  assert.equal(typeof webServer.registrations[0].handler, 'function');
});

test('externalOpenAiCompat=true 时才额外挂 /v1', async (t) => {
  const webServer = createFakeWebServer();
  await preparePlugin(t, { webServer, httpConfig: { externalOpenAiCompat: true } });

  assert.deepEqual(webServer.registrations.map((registration) => registration.path), [TEAM_ROUTE_PREFIX, OPENAI_ROUTE_PREFIX]);
});

test('webServer 缺失：只 warn 一次、不抛，adapter 注册照常完成', async (t) => {
  const fakeContext = createFakeContext({ webServer: null });
  const dataRoot = await createTempDirectory(t);
  await writeConfig({ groups: [] }, { dataRoot });
  const logger = createRecordingLogger();

  const applyResult = await apply(fakeContext, {
    dataRoot,
    logger,
    llmModule: { LlmAdapter: StubLlmAdapter, LlmError: StubLlmError },
  });

  assert.equal(applyResult, undefined, 'apply 仍返回 undefined');
  assert.equal(logger.hasLine('warn', 'webServer 不可用'), true, '必须有一条可定位的 warn');
  assert.equal(logger.hasLine('info', '已注册模型路由适配器'), true, 'adapter 注册不受影响');
});

test('webServer.register 抛错：只 warn、不抛，adapter 仍然注册成功', async (t) => {
  const webServer = createFakeWebServer({ throwOnRegister: new Error('fiber 已销毁') });
  const { logger } = await preparePlugin(t, { webServer });

  assert.equal(logger.hasLine('warn', '网关路由注册失败'), true);
  assert.equal(logger.hasLine('info', '已注册模型路由适配器'), true);
});

test('effect 注销：disposer 被执行，两条路由都会被注销', async (t) => {
  const webServer = createFakeWebServer();
  const { fakeContext } = await preparePlugin(t, { webServer, httpConfig: { externalOpenAiCompat: true } });

  const disposers = runEffectFactories(fakeContext);
  for (const dispose of disposers) {
    dispose();
  }

  assert.deepEqual(webServer.disposedPaths, [TEAM_ROUTE_PREFIX, OPENAI_ROUTE_PREFIX]);
});

test('适配层：经注册的 handler 调 GET /_team/groups 能返回正确 JSON', async (t) => {
  const webServer = createFakeWebServer();
  await preparePlugin(t, { webServer });

  const routeHandler = webServer.registrations[0].handler;
  const mockRequest = createMockRequest({ method: 'GET', url: '/_team/groups' });
  const mockResponse = createMockResponse();

  await routeHandler(mockRequest, mockResponse);

  assert.equal(mockResponse.captured.statusCode, 200);
  const responseBody = JSON.parse(mockResponse.captured.body);
  assert.equal(Array.isArray(responseBody.groups), true);
  assert.deepEqual(responseBody.groups, []);
});

test('注入 webServer 阶段抛错（ctx.inject 异常）也不影响插件激活', async (t) => {
  const { logger } = await preparePlugin(t, { throwOnInject: new Error('inject 不可用') });

  assert.equal(logger.hasLine('warn', '无法注入 webServer'), true);
  assert.equal(logger.hasLine('info', '已注册模型路由适配器'), true);
});
