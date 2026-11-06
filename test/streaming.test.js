// 流式透传用例（docs/09 §12）：逐块写出、不聚合、客户端断开真的中止上游、请求行照常落库。

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDefaultUpstreamRoutes, chatAs, selectModelRequest, startGatewayHarness } from './helpers/gateway-harness.js';
import { waitFor } from './helpers/wait-for.mjs';

// 造一条慢速 SSE 上游：每 40ms 一块，便于观察"边收边写"
function buildSlowSseRoutes({ chunkCount = 3, delayMs = 40 } = {}) {
  return {
    'POST /v1/chat/completions': async ({ outgoingResponse }) => {
      outgoingResponse.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const isLast = chunkIndex === chunkCount - 1;
        const ssePayload = {
          id: 'chatcmpl-sse',
          choices: [{ index: 0, delta: { content: `片段${chunkIndex}` } }],
          ...(isLast
            ? { usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102, prompt_tokens_details: { cached_tokens: 90 } } }
            : {}),
        };
        outgoingResponse.write(`data: ${JSON.stringify(ssePayload)}\n\n`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      }
      outgoingResponse.write('data: [DONE]\n\n');
      outgoingResponse.end();
    },
  };
}

test('流式：逐块透传且不聚合（首块明显早于末块到达）', async (t) => {
  const harness = await startGatewayHarness(t, { routes: buildSlowSseRoutes() });
  await harness.request('/_team/session/sess-stream/model', selectModelRequest('agnes', 'agnes-3.0-flash'));

  const streamResult = await harness.requestStream('/v1/chat/completions', {
    ...chatAs('sess-stream'),
    body: { model: 'dsh-model-team', stream: true, messages: [{ role: 'user', content: 'hi' }] },
  });

  assert.equal(streamResult.status, 200);
  assert.equal(streamResult.rawText.includes('data: [DONE]'), true);
  assert.equal(streamResult.chunks.length >= 2, true, '必须分多块到达（聚合实现会只有 1 块）');
  const lastChunkAtMs = streamResult.chunks[streamResult.chunks.length - 1].receivedAtMs;
  assert.equal(streamResult.firstChunkAtMs < lastChunkAtMs, true, '首块必须早于末块');
});

test('流式：请求行记录 usage / req-id / 命中率', async (t) => {
  const harness = await startGatewayHarness(t, { routes: buildSlowSseRoutes() });
  await harness.request('/_team/session/sess-stream-row/model', selectModelRequest('agnes', 'agnes-3.0-flash'));

  await harness.requestStream('/v1/chat/completions', {
    ...chatAs('sess-stream-row'),
    body: { model: 'dsh-model-team', stream: true, messages: [{ role: 'user', content: 'hi' }] },
  });

  const sessionStats = await harness.request('/_team/stats/session/sess-stream-row');
  const requestRow = sessionStats.body.rows[0];

  assert.equal(requestRow.status, 200);
  assert.equal(requestRow.model, 'agnes-3.0-flash');
  assert.equal(requestRow.tokens, '102');
  assert.equal(requestRow.cacheHit, '90.0%');
  assert.equal(requestRow.requestId, 'chatcmpl-sse');
  // 流式路径与非流式共用同一份 IP 解析：落行时 socket 可能已关，值必须在请求开始时抓
  assert.match(requestRow.ip, /127\.0\.0\.1/, '流式请求行不能把 ip 丢成 —');
  assert.equal('startedAtMs' in requestRow, false);
  assert.equal('usage' in requestRow, false);
});

test('流式：客户端断开 → 上游请求被真正中止，请求行标为客户端中断', async (t) => {
  let upstreamClosedAtAll = false;
  const endlessSseRoutes = {
    'POST /v1/chat/completions': ({ outgoingResponse }) => {
      outgoingResponse.writeHead(200, { 'content-type': 'text/event-stream' });
      let sentChunks = 0;
      const timer = setInterval(() => {
        if (outgoingResponse.writableEnded) {
          clearInterval(timer);
          return;
        }
        outgoingResponse.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' } }] })}\n\n`);
        sentChunks += 1;
        if (sentChunks > 100) {
          clearInterval(timer);
          outgoingResponse.end();
        }
      }, 30);
      outgoingResponse.on('close', () => {
        upstreamClosedAtAll = true;
        clearInterval(timer);
      });
    },
  };
  const harness = await startGatewayHarness(t, { routes: endlessSseRoutes });
  await harness.request('/_team/session/sess-abort/model', selectModelRequest('agnes', 'agnes-3.0-flash'));

  const abortController = new AbortController();
  const streamResponse = await fetch(`${harness.gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Tim-Session-Id': 'sess-abort' },
    body: JSON.stringify({ model: 'dsh-model-team', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    signal: abortController.signal,
  });
  const bodyReader = streamResponse.body.getReader();
  const firstChunk = await bodyReader.read();
  assert.equal(firstChunk.done, false, '网关必须先吐出一块再被中断');

  abortController.abort();
  await bodyReader.cancel().catch(() => {});
  // 等具体事实：客户端 close → AbortController → fetch abort → 上游 close 这一串真的走完（等状态，不等毫秒）
  await waitFor(() => upstreamClosedAtAll === true, {
    describe: '客户端断开后上游连接已关闭',
    snapshot: () => ({ upstreamClosedAtAll }),
  });
  await waitFor(async () => (await harness.request('/_team/stats/session/sess-abort')).body.rows.length === 1, {
    describe: '中断请求行已落库',
    snapshot: async () => ({ rows: (await harness.request('/_team/stats/session/sess-abort')).body.rows.map((row) => row.statusText) }),
  });

  assert.equal(upstreamClosedAtAll, true, '客户端断开必须真的中止上游请求');

  const sessionStats = await harness.request('/_team/stats/session/sess-abort');
  const abortedRow = sessionStats.body.rows[0];
  assert.equal(abortedRow.status, 0, '中断没有上游最终状态，status 记 0');
  assert.equal(abortedRow.statusText, '客户端中断');
  assert.equal(abortedRow.aborted, true);

  // 全局统计：中断不计入 byStatus，单独计数
  const globalStats = await harness.request('/_team/stats/global');
  assert.equal(globalStats.body.abortedRows, 1);
  assert.deepEqual(globalStats.body.byStatus, {}, '中断不能被算成一次成功');
  assert.equal(globalStats.body.totalRows, 1);
});

test('流式：客户端在首块之前断开（上游还没回响应头）→ 记中断而不是 502', async (t) => {
  let upstreamClosedAtAll = false;
  let upstreamRequestStarted = false;
  const holdingRoutes = {
    // 故意不回任何字节：模拟"上游还在思考"，此时客户端先断开
    'POST /v1/chat/completions': ({ outgoingResponse }) => {
      upstreamRequestStarted = true;
      outgoingResponse.on('close', () => {
        upstreamClosedAtAll = true;
      });
    },
  };
  const harness = await startGatewayHarness(t, { routes: holdingRoutes });
  await harness.request('/_team/session/sess-abort-early/model', selectModelRequest('agnes', 'agnes-3.0-flash'));

  const abortController = new AbortController();
  // 不能 await fetch：上游还没回响应头，fetch 要等到有响应才 resolve；这里先发起再定时中断
  const pendingFetch = fetch(`${harness.gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Tim-Session-Id': 'sess-abort-early' },
    body: JSON.stringify({ model: 'dsh-model-team', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    signal: abortController.signal,
  }).catch(() => null);
  // 等"请求真的到达上游"这个事实再断开（此刻上游一个 data 都还没发）
  await waitFor(() => upstreamRequestStarted === true, {
    describe: '请求已到达上游（尚未回响应头）',
    snapshot: () => ({ upstreamRequestStarted }),
  });
  abortController.abort();
  await pendingFetch;
  await waitFor(() => upstreamClosedAtAll === true, {
    describe: '客户端断开后上游连接已关闭',
    snapshot: () => ({ upstreamClosedAtAll }),
  });
  await waitFor(async () => (await harness.request('/_team/stats/session/sess-abort-early')).body.rows.length === 1, {
    describe: '中断请求行已落库',
    snapshot: async () => ({ rows: (await harness.request('/_team/stats/session/sess-abort-early')).body.rows.map((row) => row.statusText) }),
  });

  assert.equal(upstreamClosedAtAll, true, '客户端断开必须掐断上游');

  const sessionStats = await harness.request('/_team/stats/session/sess-abort-early');
  const abortedRow = sessionStats.body.rows[0];
  assert.equal(abortedRow.status, 0, '主动中止不能记成上游 502');
  assert.equal(abortedRow.aborted, true);
  assert.equal(abortedRow.statusText, '客户端中断');

  const globalStats = await harness.request('/_team/stats/global');
  assert.deepEqual(globalStats.body.byStatus, {}, '中断行不得进入 byStatus');
  assert.equal(globalStats.body.abortedRows, 1);
});

test('流式：上游无视 stream 参数直接回 JSON 时，包成单块事件不空等', async (t) => {
  const harness = await startGatewayHarness(t, { routes: buildDefaultUpstreamRoutes() });
  await harness.request('/_team/session/sess-nonstream-upstream/model', selectModelRequest('agnes', 'agnes-3.0-flash'));

  const streamResult = await harness.requestStream('/v1/chat/completions', {
    ...chatAs('sess-nonstream-upstream'),
    body: { model: 'dsh-model-team', stream: true, messages: [{ role: 'user', content: 'hi' }] },
  });

  assert.equal(streamResult.status, 200);
  assert.equal(streamResult.rawText.includes('choices'), true, 'JSON 结果必须被包成事件发出去');
  assert.equal(streamResult.rawText.includes('data: [DONE]'), true);
});
