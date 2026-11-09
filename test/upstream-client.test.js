// 自持 HTTP 客户端（B12 / docs/23 O-1）：真实本地 http server，不 mock fetch。
// 覆盖：UA 强制、超时、abort、非 2xx 原文、SSE 多块增量、以及"一条事件被拆成两个 chunk"的边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createUpstreamClient, UPSTREAM_ABORTED, UPSTREAM_TIMEOUT } from '../src/gateway/transport/upstream-client.js';
import { DEFAULT_USER_AGENT } from '../src/gateway/config/constants.js';

/** 起一个真实 http server，由 handler 决定响应 */
function startServer(handler) {
  const server = http.createServer(handler);
  // 客户端 abort 会让服务端 socket 报 "socket hang up"：测试里吞掉，否则会变成未捕获异常
  server.on('clientError', () => {});
  server.on('connection', (socket) => { socket.on('error', () => {}); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseURL: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('UA 强制：调用方传的 user-agent 被覆盖成包名/版本', async (t) => {
  const seen = [];
  const { server, baseURL } = await startServer((incomingRequest, outgoingResponse) => {
    seen.push(incomingRequest.headers['user-agent']);
    outgoingResponse.writeHead(200, { 'content-type': 'application/json' });
    outgoingResponse.end('{"ok":true}');
  });
  t.after(() => server.close());

  const client = createUpstreamClient({ timeoutMs: 5000 });
  const response = await client.requestJson({
    url: `${baseURL}/v1/models`,
    method: 'GET',
    headers: { 'user-agent': 'custom-agent/9.9' },
  });

  assert.equal(response.status, 200);
  assert.equal(seen[0], DEFAULT_USER_AGENT, 'UA 必须由客户端决定');
  assert.match(seen[0], /^dsh-model-team\//);
});

test('GET 带 body 也能发（上游目录协议要求）', async (t) => {
  const seen = [];
  const { server, baseURL } = await startServer((incomingRequest, outgoingResponse) => {
    let received = '';
    incomingRequest.on('data', (chunk) => { received += chunk; });
    incomingRequest.on('end', () => {
      seen.push({ method: incomingRequest.method, body: received, length: incomingRequest.headers['content-length'] });
      outgoingResponse.writeHead(200, { 'content-type': 'application/json' });
      outgoingResponse.end('{"data":[]}');
    });
  });
  t.after(() => server.close());

  const client = createUpstreamClient({ timeoutMs: 5000 });
  await client.requestJson({ url: `${baseURL}/catalog`, method: 'GET', headers: {}, body: '{"q":1}' });
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].body, '{"q":1}', 'body 要真的写出去（node:http 允许 GET 带 body）');
  assert.equal(seen[0].length, String(Buffer.byteLength('{"q":1}')));
});

test('超时：request.setTimeout → destroy，错误码 UPSTREAM_TIMEOUT', async (t) => {
  const { server, baseURL } = await startServer(() => { /* 永不响应 */ });
  t.after(() => server.close());

  const client = createUpstreamClient({ timeoutMs: 120 });
  await assert.rejects(
    () => client.requestJson({ url: `${baseURL}/slow`, method: 'POST', headers: {}, body: '{}' }),
    (error) => error.code === 'UPSTREAM_TIMEOUT',
  );
});

test('取消：AbortController.abort() 后请求被掐断，且没有未捕获异常', async (t) => {
  const { server, baseURL } = await startServer((incomingRequest, outgoingResponse) => {
    // 保持连接不响应，等客户端 abort（req/res 都要挂 error 监听，避免 hang up 变未捕获异常）
    incomingRequest.on('error', () => {});
    outgoingResponse.on('error', () => {});
  });
  t.after(() => server.close());

  const client = createUpstreamClient({ timeoutMs: 10000 });
  const controller = new AbortController();
  const pending = client.requestJson({ url: `${baseURL}/hang`, method: 'POST', headers: {}, body: '{}', signal: controller.signal });
  setTimeout(() => controller.abort(), 60);

  await assert.rejects(() => pending, (error) => error.code === 'UPSTREAM_ABORTED');
  // 已 abort 的情形：立刻拒绝，不发请求
  await assert.rejects(
    () => client.requestJson({ url: `${baseURL}/hang`, method: 'POST', headers: {}, body: '{}', signal: controller.signal }),
    (error) => error.code === 'UPSTREAM_ABORTED',
  );
});

test('非 2xx：把原文交回（驱动层据此截断进错误文案）', async (t) => {
  const longFailureText = `upstream exploded: ${'x'.repeat(500)}`;
  const { server, baseURL } = await startServer((incomingRequest, outgoingResponse) => {
    outgoingResponse.writeHead(400, { 'content-type': 'application/json' });
    outgoingResponse.end(longFailureText);
  });
  t.after(() => server.close());

  const client = createUpstreamClient({ timeoutMs: 5000 });
  const response = await client.requestJson({ url: `${baseURL}/v1/chat/completions`, method: 'POST', headers: {}, body: '{}' });
  assert.equal(response.status, 400);
  assert.equal(response.bodyText, longFailureText, '客户端不截断，交给驱动层统一收敛');
});

test('SSE 增量：多块事件按顺序产出', async (t) => {
  const { server, baseURL } = await startServer((incomingRequest, outgoingResponse) => {
    outgoingResponse.writeHead(200, { 'content-type': 'text/event-stream' });
    outgoingResponse.write('data: {"n":1}\n\n');
    setTimeout(() => {
      outgoingResponse.write('data: {"n":2}\n\n');
      outgoingResponse.end('data: [DONE]\n\n');
    }, 30);
  });
  t.after(() => server.close());

  const client = createUpstreamClient({ timeoutMs: 5000 });
  const stream = await client.requestStream({ url: `${baseURL}/v1/chat/completions`, method: 'POST', headers: {}, body: '{}' });
  assert.equal(stream.status, 200);

  const received = [];
  for await (const event of stream.events) received.push(event.data);
  assert.deepEqual(received, ['{"n":1}', '{"n":2}', '[DONE]']);
});

test('SSE 边界：一条事件被拆成两个 chunk 也要正确拼回', async (t) => {
  const { server, baseURL } = await startServer((incomingRequest, outgoingResponse) => {
    outgoingResponse.writeHead(200, { 'content-type': 'text/event-stream' });
    // 故意在事件中间断开：先写半条，隔一拍再写剩下的
    outgoingResponse.write('data: {"half":');
    setTimeout(() => {
      outgoingResponse.write('"value"}\n\n');
      outgoingResponse.end();
    }, 30);
  });
  t.after(() => server.close());

  const client = createUpstreamClient({ timeoutMs: 5000 });
  const stream = await client.requestStream({ url: `${baseURL}/sse`, method: 'POST', headers: {}, body: '{}' });
  const received = [];
  for await (const event of stream.events) received.push(event.data);
  assert.deepEqual(received, ['{"half":"value"}'], '跨 chunk 的事件必须拼成一条，不能切成两条');
});

test('非 SSE 的 2xx：交给调用方包装成单块事件（客户端不解析）', async (t) => {
  const { server, baseURL } = await startServer((incomingRequest, outgoingResponse) => {
    outgoingResponse.writeHead(200, { 'content-type': 'application/json' });
    outgoingResponse.end('{"choices":[{"message":{"content":"hi"}}]}');
  });
  t.after(() => server.close());

  const client = createUpstreamClient({ timeoutMs: 5000 });
  const stream = await client.requestStream({ url: `${baseURL}/v1/chat/completions`, method: 'POST', headers: {}, body: '{}' });
  assert.equal(stream.status, 200);
  assert.equal(stream.events, null, '不是 event-stream 就不产出事件流');
  assert.equal(stream.bodyText, '{"choices":[{"message":{"content":"hi"}}]}');
});

// ---- B13：取消语义（abort 之后流必须结束，不许挂死） ----

test('B13：SSE 流中 abort → 迭代以 UPSTREAM_ABORTED 结束（1s 内）', async (t) => {
  const { server, baseURL } = await startServer((incomingRequest, outgoingResponse) => {
    incomingRequest.on('error', () => {});
    outgoingResponse.on('error', () => {});
    outgoingResponse.writeHead(200, { 'content-type': 'text/event-stream' });
    outgoingResponse.write('data: {"n":1}\n\n');
    // 之后不再写、也不 end：模拟上游挂住
  });
  t.after(() => server.close());

  const client = createUpstreamClient({ timeoutMs: 10000 });
  const controller = new AbortController();
  const stream = await client.requestStream({ url: `${baseURL}/sse`, method: 'POST', headers: {}, body: '{}', signal: controller.signal });

  const startedAt = Date.now();
  await assert.rejects(
    async () => {
      for await (const event of stream.events) {
        void event;
        controller.abort();
      }
    },
    (error) => error.code === UPSTREAM_ABORTED,
  );
  assert.equal(Date.now() - startedAt < 1000, true, 'abort 后必须在 1s 内结束迭代');
});

test('B13：响应头已到、正文未结束 → abort 后 1s 内结束', async (t) => {
  const { server, baseURL } = await startServer((incomingRequest, outgoingResponse) => {
    incomingRequest.on('error', () => {});
    outgoingResponse.on('error', () => {});
    outgoingResponse.writeHead(200, { 'content-type': 'text/event-stream' });
    outgoingResponse.write('data: {"first":true}\n\n');
  });
  t.after(() => server.close());

  const client = createUpstreamClient({ timeoutMs: 10000 });
  const controller = new AbortController();
  const stream = await client.requestStream({ url: `${baseURL}/sse`, method: 'POST', headers: {}, body: '{}', signal: controller.signal });

  const iterator = stream.events[Symbol.asyncIterator]();
  const firstEvent = await iterator.next();
  assert.equal(firstEvent.done, false);

  const abortAt = Date.now();
  controller.abort();
  await assert.rejects(() => iterator.next(), (error) => error.code === UPSTREAM_ABORTED);
  assert.equal(Date.now() - abortAt < 1000, true, 'abort 后必须在 1s 内结束');
});

test('B13：上游发完 finish 后挂住、不 abort → 按 timeout 结束（不无限等）', async (t) => {
  const { server, baseURL } = await startServer((incomingRequest, outgoingResponse) => {
    incomingRequest.on('error', () => {});
    outgoingResponse.on('error', () => {});
    outgoingResponse.writeHead(200, { 'content-type': 'text/event-stream' });
    outgoingResponse.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '完成' }, finish_reason: 'stop' }] })}\n\n`);
    // 不 end：靠客户端超时收尾
  });
  t.after(() => server.close());

  const client = createUpstreamClient({ timeoutMs: 200 });
  const stream = await client.requestStream({ url: `${baseURL}/sse`, method: 'POST', headers: {}, body: '{}' });

  const received = [];
  await assert.rejects(
    async () => {
      for await (const event of stream.events) received.push(event.data);
    },
    (error) => error.code === UPSTREAM_TIMEOUT,
  );
  assert.equal(received.length, 1, 'finish 事件已经收到，之后由超时收尾');
});
