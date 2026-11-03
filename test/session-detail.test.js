// 按 id 查会话端点用例：已知 id 返回标题、未知/服务缺失一律 404、current 不被 :id 抢走、title 缺失省略字段。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayServer } from '../src/gateway/http-server.js';
import { API_PREFIX } from '../src/gateway/constants.js';
import { ROUTES } from '../src/gateway/routes.js';
import { createHostSessionLookup, createHostSessionSource } from '../src/gateway/session-current.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

const KNOWN_SESSION = {
  sessionId: 'session-known-1',
  title: '只回复两个字：收到',
  activeAtMs: Date.parse('2026-11-02T21:00:00.000Z'),
};

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

async function startServer(t, options = {}) {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const server = createGatewayServer({ dataRoot, logger, ...options });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test('已知 id：200 + title 与 activeAt', async (t) => {
  const { baseUrl } = await startServer(t, {
    sessionLookup: async (sessionId) => (sessionId === KNOWN_SESSION.sessionId ? KNOWN_SESSION : null),
  });

  const response = await fetch(`${baseUrl}${API_PREFIX}/sessions/${KNOWN_SESSION.sessionId}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.sessionId, KNOWN_SESSION.sessionId);
  assert.equal(body.title, '只回复两个字：收到');
  assert.match(body.activeAt, ISO_PATTERN);
});

test('未知 id：404 + session-not-found', async (t) => {
  const { baseUrl } = await startServer(t, { sessionLookup: async () => null });

  const response = await fetch(`${baseUrl}${API_PREFIX}/sessions/session-does-not-exist`);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, 'session-not-found');
  assert.equal(typeof body.error.hint, 'string');
});

test('sessions 服务缺失或抛错：仍是 404，不变成 500', async (t) => {
  const missingServiceLookup = createHostSessionLookup({ getSessionService: () => undefined });
  const firstServer = await startServer(t, { sessionLookup: missingServiceLookup });
  const missingResponse = await fetch(`${firstServer.baseUrl}${API_PREFIX}/sessions/anything`);
  assert.equal(missingResponse.status, 404);
  assert.equal((await missingResponse.json()).error.code, 'session-not-found');

  const throwingServiceLookup = createHostSessionLookup({
    getSessionService: () => {
      throw new Error('sessions 服务不可用');
    },
  });
  const secondServer = await startServer(t, { sessionLookup: throwingServiceLookup });
  const throwingResponse = await fetch(`${secondServer.baseUrl}${API_PREFIX}/sessions/anything`);
  assert.equal(throwingResponse.status, 404);
  assert.equal(throwingResponse.status < 500, true);
});

test('路由顺序：/_team/sessions/current 仍走当前会话逻辑，不被 :id 抢走', async (t) => {
  const currentSessionRoute = ROUTES.find((route) => route.pattern === `${API_PREFIX}/sessions/current`);
  const detailRoute = ROUTES.find((route) => route.pattern === `${API_PREFIX}/sessions/:id`);
  assert.notEqual(currentSessionRoute, undefined);
  assert.notEqual(detailRoute, undefined);
  assert.equal(
    ROUTES.indexOf(currentSessionRoute) < ROUTES.indexOf(detailRoute),
    true,
    'current 必须排在 :id 之前',
  );

  const { baseUrl } = await startServer(t, {
    sessionSource: createHostSessionSource({
      getSessionService: () => ({
        list: async () => [{ id: 'session-current-1', title: '当前会话', updatedAt: '2026-11-02T21:05:00.000Z', status: 'running' }],
      }),
    }),
    // 按 id 查询故意查不到：证明 current 没有走 :id
    sessionLookup: async () => null,
  });

  const response = await fetch(`${baseUrl}${API_PREFIX}/sessions/current`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.sessionId, 'session-current-1');
  assert.equal(body.title, '当前会话');
});

test('title 缺失：出参不含 title 字段（不是 null / 空串）', async (t) => {
  const { baseUrl } = await startServer(t, {
    sessionLookup: async (sessionId) => ({ sessionId, title: undefined, activeAtMs: null }),
  });

  const response = await fetch(`${baseUrl}${API_PREFIX}/sessions/session-no-title`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal('title' in body, false, 'title 缺失要省略字段');
  assert.equal(body.activeAt, null, 'activeAt 缺失给 null');
});

test('宿主适配：按 id 从 list 里捞出对应会话（复用同一套归一）', async () => {
  const lookup = createHostSessionLookup({
    getSessionService: () => ({
      list: async () => [
        { id: 'session-a', title: 'A 会话', updatedAt: '2026-11-02T10:00:00.000Z' },
        { id: 'session-b', title: 'B 会话', updatedAt: '2026-11-02T11:00:00.000Z' },
      ],
    }),
  });

  const found = await lookup('session-b');
  const missing = await lookup('session-c');

  assert.equal(found.sessionId, 'session-b');
  assert.equal(found.title, 'B 会话');
  assert.equal(missing, null);
});
