// "当前会话"端点用例：活跃优先、退化到最近更新、无数据 404、服务缺失 404（绝 500）、路径挂在前缀下。
// 另含两条前端会用到的空数据兜底：未知会话的 events / stats 必须返回空数组而不是 500。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayServer } from '../src/gateway/transport/http-server.js';
import { ROUTES } from '../src/gateway/routes/index.js';
import { API_PREFIX } from '../src/gateway/config/constants.js';
import { createHostSessionSource, pickCurrentSession } from '../src/gateway/session/current.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

// 起一个真 HTTP 服务（与独立入口同一条管道）
async function startServer(t, { sessionSource } = {}) {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const server = createGatewayServer({ dataRoot, logger, sessionSource });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, dataRoot, logger };
}

test('端点路径：挂在 API_PREFIX 下（不是字面量拼出来的第二套）', () => {
  const currentSessionRoute = ROUTES.find((route) => route.pattern.endsWith('/sessions/current'));
  assert.notEqual(currentSessionRoute, undefined);
  assert.equal(currentSessionRoute.pattern, `${API_PREFIX}/sessions/current`);
  assert.equal(currentSessionRoute.method, 'GET');
});

test('有活跃会话：200 + 合法 sessionId/title/activeAt', async (t) => {
  const sessionSource = async () => ({
    sessionId: 'session-abc123',
    title: '群聊 A',
    activeAtMs: Date.parse('2026-11-02T18:00:00.000Z'),
  });
  const { baseUrl } = await startServer(t, { sessionSource });

  const response = await fetch(`${baseUrl}${API_PREFIX}/sessions/current`);
  const responseBody = await response.json();

  assert.equal(response.status, 200);
  assert.equal(responseBody.sessionId, 'session-abc123');
  assert.equal(responseBody.title, '群聊 A');
  assert.match(responseBody.activeAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('没有会话：404 + no-active-session', async (t) => {
  const { baseUrl } = await startServer(t, { sessionSource: async () => null });

  const response = await fetch(`${baseUrl}${API_PREFIX}/sessions/current`);
  const responseBody = await response.json();

  assert.equal(response.status, 404);
  assert.equal(responseBody.error.code, 'no-active-session');
  assert.equal(typeof responseBody.error.hint, 'string');
});

test('sessions 服务缺失或抛错：仍 404，不变成 500', async (t) => {
  const missingServiceSource = createHostSessionSource({ getSessionService: () => undefined });
  const firstServer = await startServer(t, { sessionSource: missingServiceSource });
  const missingResponse = await fetch(`${firstServer.baseUrl}${API_PREFIX}/sessions/current`);
  assert.equal(missingResponse.status, 404);
  assert.equal((await missingResponse.json()).error.code, 'no-active-session');

  const throwingServiceSource = createHostSessionSource({
    getSessionService: () => {
      throw new Error('sessions 服务不可用');
    },
  });
  const secondServer = await startServer(t, { sessionSource: throwingServiceSource });
  const throwingResponse = await fetch(`${secondServer.baseUrl}${API_PREFIX}/sessions/current`);
  assert.equal(throwingResponse.status, 404);
  assert.equal(throwingResponse.status < 500, true, '服务缺失必须是 404 而不是 500');
});

test('宿主会话适配：优先运行中的会话，否则取最近更新时间', () => {
  const runningSession = { sessionId: 'running-1', isActive: true, activeAtMs: 1000 };
  const newerIdleSession = { sessionId: 'idle-2', isActive: false, activeAtMs: 9999 };

  assert.equal(pickCurrentSession([newerIdleSession, runningSession]).sessionId, 'running-1');
  assert.equal(pickCurrentSession([newerIdleSession]).sessionId, 'idle-2');
  assert.equal(pickCurrentSession([]), null);
});

test('宿主适配：兼容 list()/getCurrent() 形状并归一字段', async () => {
  const fakeService = {
    getCurrent: async () => null,
    list: async () => [
      { id: 'session-old', title: '旧会话', updatedAt: '2026-11-02T10:00:00.000Z' },
      { id: 'session-new', title: '新会话', updatedAt: '2026-11-02T12:00:00.000Z', status: 'running' },
    ],
  };

  const source = createHostSessionSource({ getSessionService: () => fakeService });
  const currentSession = await source();

  assert.equal(currentSession.sessionId, 'session-new');
  assert.equal(currentSession.title, '新会话');
});

test('空数据兜底：未知会话的 events / stats 返回空数组而不是 500', async (t) => {
  const { baseUrl } = await startServer(t);

  const eventsResponse = await fetch(`${baseUrl}${API_PREFIX}/session/never-existed/events`);
  const statsResponse = await fetch(`${baseUrl}${API_PREFIX}/stats/session/never-existed`);

  assert.equal(eventsResponse.status, 200);
  assert.deepEqual(await eventsResponse.json(), { events: [] });
  assert.equal(statsResponse.status, 200);
  assert.deepEqual((await statsResponse.json()).rows, []);
});
