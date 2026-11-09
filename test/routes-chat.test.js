// 端到端用例（docs/09 §9 的 7 条验收要点）：虚拟模型、会话隔离、错误语义、请求行、顺序、环形截断。
// 全部用本地 stub 上游 + 真 http 网关，零外网、零真实 Key。

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VIRTUAL_MODEL_ID } from '../src/gateway/transport/router.js';
import { createFixedClock } from '../src/gateway/clock.js';
import { DEFAULT_CHAT_COMPLETION, buildDefaultUpstreamRoutes, chatAs, selectModelRequest, startGatewayHarness } from './helpers/gateway-harness.js';

// 断言 12 字段齐全且非空串（INV-07）
function assertCompleteRequestRow(requestRow) {
  const requiredFields = ['time', 'status', 'statusText', 'model', 'account', 'ip', 'ua', 'latency', 'tokens', 'credit', 'cacheHit', 'requestId', 'title'];
  for (const fieldName of requiredFields) {
    assert.notEqual(requestRow[fieldName], undefined, `请求行缺字段：${fieldName}`);
    if (typeof requestRow[fieldName] === 'string') {
      assert.notEqual(requestRow[fieldName], '', `请求行字段为空串：${fieldName}`);
    }
  }
  assert.equal(typeof requestRow.account.name, 'string');
  assert.equal(typeof requestRow.account.id, 'string');
}

test('验收1：GET /v1/models 只返回一个虚拟模型（INV-01）', async (t) => {
  const harness = await startGatewayHarness(t);

  const modelList = await harness.request('/v1/models');

  assert.equal(modelList.status, 200);
  assert.equal(modelList.body.object, 'list');
  assert.equal(modelList.body.data.length, 1, 'dsh 侧只能看到一个模型');
  assert.equal(modelList.body.data[0].id, DEFAULT_VIRTUAL_MODEL_ID);
});

test('验收1b：config.virtualModel 可覆盖虚拟模型名', async (t) => {
  const harness = await startGatewayHarness(t, { config: { virtualModel: 'my-virtual-model' } });

  const modelList = await harness.request('/v1/models');

  assert.equal(modelList.body.data[0].id, 'my-virtual-model');
});

test('验收2：两个会话分别选不同模型，各自请求改写到正确模型（INV-02）', async (t) => {
  const harness = await startGatewayHarness(t);

  await harness.request('/_team/session/sess-a/model', selectModelRequest('agnes', 'agnes-3.0-flash'));
  await harness.request('/_team/session/sess-b/model', selectModelRequest('agnes', 'agnes-2.5-flash'));

  const chatA = await harness.request('/v1/chat/completions', chatAs('sess-a'));
  const chatB = await harness.request('/v1/chat/completions', chatAs('sess-b'));

  assert.equal(chatA.status, 200);
  assert.equal(chatB.status, 200);
  assert.equal(chatA.body.choices[0].message.content, '收到');

  const upstreamModels = harness.stubUpstream.requests
    .filter((upstreamRequest) => upstreamRequest.method === 'POST')
    .map((upstreamRequest) => JSON.parse(upstreamRequest.bodyText).model);
  assert.deepEqual(upstreamModels, ['agnes-3.0-flash', 'agnes-2.5-flash'], '请求体里的 model 必须按会话改写');
});

test('验收3：缺会话标识返回 400 + 明确错误码（不静默）', async (t) => {
  const harness = await startGatewayHarness(t);

  const chatResult = await harness.request('/v1/chat/completions', chatAs(null));

  assert.equal(chatResult.status, 400);
  assert.equal(chatResult.body.error.code, 'session-unresolved');
  assert.equal(typeof chatResult.body.error.hint, 'string');
  assert.equal(harness.stubUpstream.requests.length, 0, '识别不到会话时不应向上游发请求');
});

test('验收3b：配了 fallbackGroupId 时可无会话头跑通（第三级回退）', async (t) => {
  const harness = await startGatewayHarness(t, {
    groupOverrides: { defaultModel: 'agnes-2.5-flash' },
    config: { session: { fallbackGroupId: 'agnes' } },
  });

  const chatResult = await harness.request('/v1/chat/completions', chatAs(null));

  assert.equal(chatResult.status, 200);
  assert.equal(chatResult.body.choices[0].message.content, '收到');
  const upstreamBody = JSON.parse(harness.stubUpstream.requests[0].bodyText);
  assert.equal(upstreamBody.model, 'agnes-2.5-flash', '兜底群 + defaultModel 生效');
});

test('验收3c：会话从未切换过模型时，用兜底群的 defaultModel', async (t) => {
  const harness = await startGatewayHarness(t, {
    groupOverrides: { defaultModel: 'agnes-2.5-flash' },
    config: { session: { fallbackGroupId: 'agnes' } },
  });

  // 有会话头（会话可识别）但没有任何映射：模型走兜底群的 defaultModel
  const chatResult = await harness.request('/v1/chat/completions', chatAs('sess-never-switched'));

  assert.equal(chatResult.status, 200);
  const upstreamBody = JSON.parse(harness.stubUpstream.requests[0].bodyText);
  assert.equal(upstreamBody.model, 'agnes-2.5-flash');

  const sessionStats = await harness.request('/_team/stats/session/sess-never-switched');
  assert.equal(sessionStats.body.rows[0].model, 'agnes-2.5-flash');
  assert.equal(sessionStats.body.rows[0].sessionId, 'sess-never-switched');
});

test('验收3d：既无映射也无 defaultModel → 400 model-unresolved，并落失败请求行', async (t) => {
  const harness = await startGatewayHarness(t);

  const chatResult = await harness.request('/v1/chat/completions', chatAs('sess-no-mapping'));

  assert.equal(chatResult.status, 400);
  assert.equal(chatResult.body.error.code, 'model-unresolved');

  const sessionStats = await harness.request('/_team/stats/session/sess-no-mapping');
  assert.equal(sessionStats.body.rows.length, 1);
  assert.equal(sessionStats.body.rows[0].status, 400);
  assert.equal(sessionStats.body.rows[0].statusText, '无模型映射');
  assertCompleteRequestRow(sessionStats.body.rows[0]);
});

test('验收4：上游 401/429/500 不打死网关，请求行记录上游真实状态码', async (t) => {
  const failingRoutes = {
    ...buildDefaultUpstreamRoutes(),
    'POST /v1/chat/completions': ({ outgoingResponse, bodyText }) => {
      const requestedModel = JSON.parse(bodyText || '{}').model ?? '';
      const statusByModel = { 'upstream-401': 401, 'upstream-429': 429, 'upstream-500': 500 };
      const statusCode = statusByModel[requestedModel] ?? 200;
      outgoingResponse.writeHead(statusCode, { 'content-type': 'application/json' });
      outgoingResponse.end(JSON.stringify(statusCode === 200 ? DEFAULT_CHAT_COMPLETION : { error: { message: 'boom' } }));
    },
  };
  const harness = await startGatewayHarness(t, { routes: failingRoutes });

  for (const [sessionId, modelName, expectedStatus] of [
    ['sess-401', 'upstream-401', 401],
    ['sess-429', 'upstream-429', 429],
    ['sess-500', 'upstream-500', 500],
  ]) {
    await harness.request(`/_team/session/${sessionId}/model`, selectModelRequest('agnes', modelName));
    const chatResult = await harness.request('/v1/chat/completions', chatAs(sessionId));

    assert.equal(chatResult.status, 502, `上游 ${expectedStatus} 时客户端应拿到 502`);
    assert.equal(chatResult.body.error.code, 'upstream-error');
    assert.equal(chatResult.body.error.upstreamStatus, expectedStatus);

    const sessionStats = await harness.request(`/_team/stats/session/${sessionId}`);
    assert.equal(sessionStats.body.rows[0].status, expectedStatus, '请求行记录的是上游真实状态码');
  }

  // 上游失败后网关仍然可用
  const healthCheck = await harness.request('/v1/models');
  assert.equal(healthCheck.status, 200);
});

test('验收5：请求行 12 字段齐全且 title 含会话账号（INV-07）', async (t) => {
  // 固定时钟每次读取推进 40ms：让 latencySeconds 是真实正数（缺省固定时钟步进为 0）
  const harness = await startGatewayHarness(t, { clock: createFixedClock({ stepMs: 40 }) });
  await harness.request('/_team/session/sess-row/model', selectModelRequest('agnes', 'agnes-3.0-flash'));

  await harness.request('/v1/chat/completions', {
    ...chatAs('sess-row'),
    headers: {
      'X-Tim-Session-Id': 'sess-row',
      'user-agent': 'dsh-test-agent/1.0',
      'x-forwarded-for': '203.0.113.3, 203.0.113.4',
    },
  });

  const sessionStats = await harness.request('/_team/stats/session/sess-row');
  const requestRow = sessionStats.body.rows[0];

  assertCompleteRequestRow(requestRow);
  assert.equal(requestRow.status, 200);
  assert.equal(requestRow.statusText, '成功');
  assert.equal(requestRow.model, 'agnes-3.0-flash');
  assert.equal(requestRow.account.id, 'agnes');
  assert.equal(requestRow.ip, '203.0.113.3', 'x-forwarded-for 取首段');
  assert.equal(requestRow.ua, 'dsh-test-agent/1.0');
  assert.equal(requestRow.tokens, '12.6k');
  assert.equal(requestRow.cacheHit, '99.9%');
  assert.equal(requestRow.credit, '—', '上游没返回 credit 时必须给 —');
  assert.equal(requestRow.requestId, 'chatcmpl-e2e', '优先用上游响应 id');
  // 生成速度原料：输出 token 与耗时秒数（前端用 completionTokens / latencySeconds）
  assert.equal(requestRow.completionTokens, 2600);
  assert.equal(typeof requestRow.latencySeconds, 'number');
  assert.equal(requestRow.latencySeconds > 0, true);
  assert.equal(requestRow.title.includes('agnes(本机)(agnes)'), true);
});

test('验收6：stats 端点返回顺序稳定（时间正序），且内部字段已裁剪', async (t) => {
  const harness = await startGatewayHarness(t, { clock: createFixedClock({ stepMs: 1000 }) });
  await harness.request('/_team/session/sess-order/model', selectModelRequest('agnes', 'agnes-3.0-flash'));

  await harness.request('/v1/chat/completions', chatAs('sess-order'));
  await harness.request('/v1/chat/completions', chatAs('sess-order'));
  await harness.request('/v1/chat/completions', chatAs('sess-order'));

  const sessionStats = await harness.request('/_team/stats/session/sess-order');
  const orderRows = sessionStats.body.rows;

  assert.equal(orderRows.length, 3);
  const orderTimes = orderRows.map((requestRow) => requestRow.time);
  assert.deepEqual(orderTimes, [...orderTimes].sort(), '必须按时间正序返回');
  for (const requestRow of orderRows) {
    assert.equal('startedAtMs' in requestRow, false, '§10 出参裁剪：startedAtMs 不得出现');
    assert.equal('usage' in requestRow, false, '§10 出参裁剪：usage 不得出现');
    assert.equal(typeof requestRow.sessionId, 'string', 'sessionId 要保留给前端按会话过滤');
  }
});

test('验收7：环形截断 —— 灌入 maxRows+1 条后行数不超过 maxRows', async (t) => {
  const harness = await startGatewayHarness(t, { config: { stats: { maxRows: 2 } } });
  await harness.request('/_team/session/sess-ring/model', selectModelRequest('agnes', 'agnes-3.0-flash'));

  for (let requestIndex = 0; requestIndex < 3; requestIndex += 1) {
    await harness.request('/v1/chat/completions', chatAs('sess-ring'));
  }

  const globalStats = await harness.request('/_team/stats/global');
  assert.equal(globalStats.body.totalRows <= 2, true, '行数不得超过 maxRows');
  assert.equal(globalStats.body.totalRows, 1, '超限后保留最近一半（maxRows=2 → 1 条）');
  assert.equal(harness.logger.hasLine('info', '已截断保留最近'), true);
});

test('全局统计：形状与累计值', async (t) => {
  const harness = await startGatewayHarness(t);
  await harness.request('/_team/session/sess-global/model', selectModelRequest('agnes', 'agnes-3.0-flash'));
  await harness.request('/v1/chat/completions', chatAs('sess-global'));
  await harness.request('/v1/chat/completions', chatAs('sess-global'));

  const globalStats = await harness.request('/_team/stats/global');

  assert.equal(globalStats.status, 200);
  assert.equal(globalStats.body.totalRows, 2);
  assert.equal(globalStats.body.totalTokens, 25200);
  assert.equal(globalStats.body.cacheHitPercent, '99.9%');
  assert.deepEqual(globalStats.body.byStatus, { 200: 2 });
  assert.match(globalStats.body.since, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});
