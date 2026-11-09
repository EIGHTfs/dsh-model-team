// SSE 端点 GET /_team/stream：真起 HTTP 服务，验事件到达、sessionId 过滤、断开后订阅数归零。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { handleStreamRoute } from '../src/gateway/routes/stream.js';
import { EVENT_REQUEST_COMPLETED, getEventHub, resetEventHubForTest } from '../src/gateway/events/hub.js';

/** 只挂一条 SSE 路由的最小服务：避开整套网关依赖，聚焦流行为 */
function startStreamServer() {
  const server = createServer((incomingRequest, outgoingResponse) => {
    const requestUrl = new URL(incomingRequest.url, 'http://127.0.0.1');
    if (requestUrl.pathname !== '/_team/stream') {
      outgoingResponse.writeHead(404).end();
      return;
    }
    const query = Object.fromEntries(requestUrl.searchParams);
    handleStreamRoute({ incomingRequest, outgoingResponse, query });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function waitFor(subscribe) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等事件超时')), 3000);
    subscribe((value) => { clearTimeout(timer); resolve(value); });
  });
}

test('订阅后能收到 request:completed（事件名与 data 都是契约形状）', async (t) => {
  resetEventHubForTest();
  const { server, port } = await startStreamServer();
  t.after(() => server.close());

  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/_team/stream`, { signal: controller.signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  const reading = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (chunk.startsWith('event:')) events.push(chunk);
      }
    }
  })();

  // 等连接建立（首帧注释）
  await new Promise((resolve) => setTimeout(resolve, 100));
  getEventHub().publish(EVENT_REQUEST_COMPLETED, { sessionId: 'session-1', groupId: 'g1', row: { time: '10:00:00', status: 200 } });
  // 连上后服务端先发就绪事件（event: ready，前端据此拉首屏，不靠超时重试）；
  // 这里要的是其中的 request:completed，所以等到出现该事件的 chunk 为止。
  const chunk = await waitFor((resolve) => {
    const timer = setInterval(() => {
      const matched = events.find((item) => /^event: request:completed$/m.test(item));
      if (matched) { clearInterval(timer); resolve(matched); }
    }, 10);
  });

  assert.match(chunk, /^event: request:completed$/m);
  const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'));
  assert.deepEqual(JSON.parse(dataLine.slice('data:'.length)), { sessionId: 'session-1', groupId: 'g1', row: { time: '10:00:00', status: 200 } });

  controller.abort();
  await reading.catch(() => {});
});

test('连上后先发就绪事件（event: ready）：前端据此拉首屏，不靠超时重试', async (t) => {
  resetEventHubForTest();
  const { server, port } = await startStreamServer();
  t.after(() => server.close());

  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/_team/stream`, { signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('event: ready')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  controller.abort();
  assert.match(text, /^event: ready$/m, '就绪事件必须存在（它是首屏加载的触发源）');
  assert.match(text, /data: \{"ready":true\}/);
});

test('带 sessionId 只推该会话；不带则推全部', async (t) => {
  resetEventHubForTest();
  const { server, port } = await startStreamServer();
  t.after(() => server.close());

  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/_team/stream?sessionId=session-A`, { signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const reading = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  })();

  await new Promise((resolve) => setTimeout(resolve, 100));
  getEventHub().publish(EVENT_REQUEST_COMPLETED, { sessionId: 'session-B', groupId: 'g2', row: {} });
  getEventHub().publish(EVENT_REQUEST_COMPLETED, { sessionId: 'session-A', groupId: 'g1', row: {} });
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(text.includes('session-B'), false, '别的会话不该收到');
  assert.equal(text.includes('session-A'), true);

  controller.abort();
  await reading.catch(() => {});
});

test('客户端断开后 hub 订阅数回到 0（不留 listener）', async (t) => {
  resetEventHubForTest();
  const { server, port } = await startStreamServer();
  t.after(() => server.close());

  const controller = new AbortController();
  await fetch(`http://127.0.0.1:${port}/_team/stream`, { signal: controller.signal }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(getEventHub().subscriberCount(EVENT_REQUEST_COMPLETED), 1, '连接期间应有 1 个订阅者');

  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(getEventHub().subscriberCount(EVENT_REQUEST_COMPLETED), 0, '断开后必须退订');
});
