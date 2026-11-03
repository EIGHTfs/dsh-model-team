// 会话标题用例：sessionTitle 服务快照优先、缺失/抛错回退事件流折叠、都没有则省略 title；
// 两个端点（current 与 :id）都要能带出标题。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayServer } from '../src/gateway/http-server.js';
import { API_PREFIX } from '../src/gateway/constants.js';
import { createHostSessionLookup, createHostSessionSource } from '../src/gateway/session-current.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

// 造一个"活会话"：sessionTitle.get() 只认带 snapshotEvents 方法的对象
function buildLiveSession(sessionId, events = [], header = {}) {
  return {
    id: sessionId,
    header,
    events,
    snapshotEvents: () => events,
  };
}

function buildSessionService(liveSessions) {
  return {
    get: async (sessionId) => liveSessions.find((session) => session.id === sessionId) ?? null,
    list: async () => liveSessions,
  };
}

async function startServer(t, options = {}) {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const server = createGatewayServer({ dataRoot, logger, ...options });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test('sessionTitle 返回快照对象：出参 title 取快照里的 title', async (t) => {
  const liveSession = buildLiveSession('session-snapshot', [], { title: 'header 里的旧标题' });
  const sessionLookup = createHostSessionLookup({
    getSessionService: () => buildSessionService([liveSession]),
    getTitleService: () => ({ get: () => ({ title: '快照标题', source: 'rename', eventSeq: 7 }) }),
  });
  const { baseUrl } = await startServer(t, { sessionLookup });

  const response = await fetch(`${baseUrl}${API_PREFIX}/sessions/session-snapshot`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.title, '快照标题');
});

test('sessionTitle 服务缺失：回退事件流里的 session/title', async (t) => {
  const liveSession = buildLiveSession('session-fold', [
    { type: 'session/title', data: { title: '第一次标题' } },
    { type: 'user/message', data: {} },
    { type: 'session/title', data: { title: '折叠出来的标题' } },
  ]);
  const sessionLookup = createHostSessionLookup({
    getSessionService: () => buildSessionService([liveSession]),
    getTitleService: () => undefined,
  });
  const { baseUrl } = await startServer(t, { sessionLookup });

  const body = await (await fetch(`${baseUrl}${API_PREFIX}/sessions/session-fold`)).json();

  assert.equal(body.title, '折叠出来的标题');
});

test('服务与事件流都没有标题：出参不含 title 字段', async (t) => {
  const liveSession = buildLiveSession('session-untitled', []);
  const sessionLookup = createHostSessionLookup({
    getSessionService: () => buildSessionService([liveSession]),
    getTitleService: () => undefined,
  });
  const { baseUrl } = await startServer(t, { sessionLookup });

  const body = await (await fetch(`${baseUrl}${API_PREFIX}/sessions/session-untitled`)).json();

  assert.equal('title' in body, false, '没有标题时必须省略字段');
});

test('sessionTitle.get() 抛错（非 live Session）：不 500，回退事件流', async (t) => {
  const liveSession = buildLiveSession('session-throw', [
    { type: 'session/title', data: { title: '回退标题' } },
  ]);
  const sessionLookup = createHostSessionLookup({
    getSessionService: () => buildSessionService([liveSession]),
    getTitleService: () => ({
      get: () => {
        throw new Error('not a live Session');
      },
    }),
  });
  const { baseUrl } = await startServer(t, { sessionLookup });

  const response = await fetch(`${baseUrl}${API_PREFIX}/sessions/session-throw`);
  const body = await response.json();

  assert.equal(response.status, 200, '服务抛错不能变成 500');
  assert.equal(body.title, '回退标题');
});

test('/sessions/current 与 /sessions/:id 都能带出 title', async (t) => {
  const liveSession = buildLiveSession('session-both', [
    { type: 'session/title', data: { title: '两个端点共用的标题' } },
  ], { title: 'running' });
  liveSession.status = 'running';
  const sessionService = buildSessionService([liveSession]);
  const sessionSource = createHostSessionSource({
    getSessionService: () => sessionService,
    getTitleService: () => undefined,
  });
  const sessionLookup = createHostSessionLookup({
    getSessionService: () => sessionService,
    getTitleService: () => undefined,
  });
  const { baseUrl } = await startServer(t, { sessionSource, sessionLookup });

  const currentBody = await (await fetch(`${baseUrl}${API_PREFIX}/sessions/current`)).json();
  const detailBody = await (await fetch(`${baseUrl}${API_PREFIX}/sessions/session-both`)).json();

  assert.equal(currentBody.title, '两个端点共用的标题');
  assert.equal(detailBody.title, '两个端点共用的标题');
});
