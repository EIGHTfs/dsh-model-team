// 反代域自己的测试替身：模拟宿主 webServer（只实现 register(kind/path/handler)），
// 并把注册到的 handler 真正挂到本地 http server 上——这样测试走的是**真实注册路径**，
// 而不是 model-team 的路由表（第 10 步起两者已解耦）。
import http from 'node:http';

import { registerReverse, resetReverseRegistrationForTest } from '../../src/reverse/register.js';
import { createTempDirectory, createRecordingLogger } from './test-environment.js';

function matchesPrefix(routePath, pathname) {
  return pathname === routePath || pathname.startsWith(`${routePath}/`);
}

export async function startReverseHarness(t, { credentials = null } = {}) {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const registrations = [];

  const fakeWebServer = {
    register(route) {
      const entry = { ...route, active: true };
      registrations.push(entry);
      return () => { entry.active = false; };
    },
  };

  const server = http.createServer((incomingRequest, outgoingResponse) => {
    const requestUrl = new URL(incomingRequest.url ?? '/', `http://${incomingRequest.headers.host ?? 'localhost'}`);
    const matched = registrations.find((entry) => entry.active
      && (entry.kind === 'prefix' ? matchesPrefix(entry.path, requestUrl.pathname) : entry.path === requestUrl.pathname));
    if (!matched) {
      outgoingResponse.writeHead(404, { 'content-type': 'application/json' });
      outgoingResponse.end('{"error":{"code":"not-found"}}');
      return;
    }
    Promise.resolve(matched.handler(incomingRequest, outgoingResponse)).catch(() => {
      if (!outgoingResponse.headersSent) {
        outgoingResponse.writeHead(500, { 'content-type': 'application/json' });
        outgoingResponse.end('{"error":{"code":"internal"}}');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  resetReverseRegistrationForTest();
  const registration = await registerReverse({
    ctx: { get: (name) => (name === 'webServer' ? fakeWebServer : null) },
    dataRoot,
    logger,
    credentials,
  });

  t.after(async () => {
    registration.dispose?.();
    await new Promise((resolve) => server.close(resolve));
  });

  return {
    dataRoot,
    logger,
    origin,
    registrations,
    registration,
    async request(path, { method = 'GET', body } = {}) {
      const response = await fetch(origin + path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
  };
}
