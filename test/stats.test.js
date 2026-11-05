// 请求行用例（INV-07 / docs/09 §5·§8）：12 字段齐全且无空串、格式化规则、环形截断、正序读回。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_REQUEST_ROWS,
  appendRequestRow,
  buildGlobalStats,
  buildRequestRow,
  enforceRingTruncation,
  formatCacheHit,
  formatCredit,
  formatTokens,
  readRequestRows,
  statusTextFor,
  toPublicRequestRow,
} from '../src/gateway/stats/index.js';
import { formatClockTime } from '../src/gateway/clock.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

// 固定起始时刻：断言 time 字段时用 formatClockTime 复算，避免依赖测试机时区
const FIXED_START_MS = Date.UTC(2026, 10, 2, 5, 30, 0);

const FULL_ROW_INPUT = {
  sessionId: 'sess-1',
  statusCode: 200,
  model: 'agnes-3.0-flash',
  account: { name: 'agnes(本机)', id: 'agnes' },
  ipAddress: '10.0.0.7',
  userAgent: 'curl/8.0',
  startedAtMs: FIXED_START_MS,
  finishedAtMs: FIXED_START_MS + 1234,
  usage: { promptTokens: 10000, completionTokens: 2600, totalTokens: 12600, cacheHit: 9990 },
  credit: 0.52,
  requestId: 'req-7e8c519feca4',
};

test('stats：12 个字段全部有值，且没有空串/undefined（INV-07）', () => {
  const requestRow = buildRequestRow(FULL_ROW_INPUT);

  const requiredFields = ['time', 'status', 'statusText', 'model', 'account', 'ip', 'ua', 'latency', 'tokens', 'credit', 'cacheHit', 'requestId', 'title'];
  for (const fieldName of requiredFields) {
    assert.notEqual(requestRow[fieldName], undefined, `字段缺失：${fieldName}`);
    if (typeof requestRow[fieldName] === 'string') {
      assert.notEqual(requestRow[fieldName], '', `字段为空串：${fieldName}`);
    }
  }

  assert.equal(requestRow.time, formatClockTime(FIXED_START_MS));
  assert.equal(requestRow.status, 200);
  assert.equal(requestRow.statusText, '成功');
  assert.equal(requestRow.model, 'agnes-3.0-flash');
  assert.deepEqual(requestRow.account, { name: 'agnes(本机)', id: 'agnes' });
  assert.equal(requestRow.latency, '1.23s');
  assert.equal(requestRow.tokens, '12.6k');
  assert.equal(requestRow.cacheHit, '99.9%');
  assert.equal(requestRow.credit, '0.52');
  assert.equal(requestRow.title.includes('agnes(本机)(agnes)'), true, 'title 必须含会话账号');
  assert.equal(requestRow.title.includes('req-7e8c519feca4'), true);
});

test('stats：字段全缺时统一降级为 —，不留空串', () => {
  const requestRow = buildRequestRow({ statusCode: 0, startedAtMs: FIXED_START_MS, finishedAtMs: FIXED_START_MS + 10 });

  assert.equal(requestRow.model, '—');
  assert.equal(requestRow.ip, '—');
  assert.equal(requestRow.ua, '—');
  assert.equal(requestRow.tokens, '—');
  assert.equal(requestRow.credit, '—');
  assert.equal(requestRow.cacheHit, '—');
  assert.equal(requestRow.requestId, '—');
  assert.deepEqual(requestRow.account, { name: '—', id: '—' });
  assert.equal(requestRow.statusText, '未转发');
});

test('stats：格式化规则（tokens / 命中率 / credit / 状态文案）', () => {
  assert.equal(formatTokens({ totalTokens: 999 }), '999');
  assert.equal(formatTokens({ totalTokens: 1000 }), '1.0k');
  assert.equal(formatTokens({ totalTokens: 252600 }), '252.6k');
  assert.equal(formatTokens(null), '—');

  assert.equal(formatCacheHit({ promptTokens: 10000, cacheHit: 9990 }), '99.9%');
  assert.equal(formatCacheHit({ promptTokens: 0, cacheHit: 10 }), '—');
  assert.equal(formatCacheHit({}), '—');

  assert.equal(formatCredit(0), '0');
  assert.equal(formatCredit(null), '—');

  assert.equal(statusTextFor(200), '成功');
  assert.equal(statusTextFor(401), '未授权');
  assert.equal(statusTextFor(429), '限流');
  assert.equal(statusTextFor(502), '上游错误');
  assert.equal(statusTextFor(400, '无模型映射'), '无模型映射');
});

test('stats：追加后按时间正序读回，可按会话过滤', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();

  for (const [index, sessionId] of ['sess-a', 'sess-b', 'sess-a'].entries()) {
    const startedAtMs = FIXED_START_MS + index * 1000;
    await appendRequestRow(
      buildRequestRow({ ...FULL_ROW_INPUT, sessionId, startedAtMs, finishedAtMs: startedAtMs + 500 }),
      { dataRoot, logger },
    );
  }

  const allRows = await readRequestRows({ dataRoot, logger });
  assert.deepEqual(allRows.map((requestRow) => requestRow.sessionId), ['sess-a', 'sess-b', 'sess-a']);

  const sessionRows = await readRequestRows({ dataRoot, logger, sessionId: 'sess-a' });
  assert.equal(sessionRows.length, 2);
  assert.equal(sessionRows[0].startedAtMs < sessionRows[1].startedAtMs, true, '必须时间正序');
});

test('stats：环形截断 —— 超过 maxRows 后只保留最近一半', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const maxRows = 4;

  for (let rowIndex = 0; rowIndex < maxRows + 1; rowIndex += 1) {
    const startedAtMs = FIXED_START_MS + rowIndex * 1000;
    await appendRequestRow(
      buildRequestRow({ ...FULL_ROW_INPUT, sessionId: `sess-${rowIndex}`, startedAtMs, finishedAtMs: startedAtMs + 100 }),
      { dataRoot, logger, maxRows },
    );
  }

  const remainingRows = await readRequestRows({ dataRoot, logger });
  assert.equal(remainingRows.length <= maxRows, true, `行数必须不超过 ${maxRows}`);
  assert.equal(remainingRows.length, Math.floor(maxRows / 2));
  assert.equal(logger.hasLine('info', '已截断保留最近'), true, '截断必须打 info 日志');

  const truncateResult = await enforceRingTruncation({ dataRoot, logger, maxRows });
  assert.equal(truncateResult.truncated, false, '已经在上限内，不应再截断');
});

test('stats：全局统计形状与数值', async (t) => {
  const emptyStats = buildGlobalStats([]);
  assert.deepEqual(emptyStats, {
    totalRows: 0,
    totalTokens: 0,
    cacheHitPercent: '—',
    byStatus: {},
    abortedRows: 0,
    since: null,
  });

  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  for (const [index, statusCode] of [200, 200, 429].entries()) {
    const startedAtMs = FIXED_START_MS + index * 1000;
    await appendRequestRow(
      buildRequestRow({ ...FULL_ROW_INPUT, statusCode, startedAtMs, finishedAtMs: startedAtMs + 100 }),
      { dataRoot, logger },
    );
  }

  const globalStats = buildGlobalStats(await readRequestRows({ dataRoot, logger }));
  assert.equal(globalStats.totalRows, 3);
  assert.equal(globalStats.totalTokens, 12600 * 3);
  assert.equal(globalStats.cacheHitPercent, '99.9%');
  assert.deepEqual(globalStats.byStatus, { 200: 2, 429: 1 });
  assert.equal(globalStats.abortedRows, 0);
  assert.match(globalStats.since, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test('stats：出参裁剪只去 startedAtMs 与 usage，保留 sessionId（docs/09 §10）', () => {
  const requestRow = buildRequestRow(FULL_ROW_INPUT);
  const publicRequestRow = toPublicRequestRow(requestRow);

  assert.equal('startedAtMs' in publicRequestRow, false);
  assert.equal('usage' in publicRequestRow, false);
  assert.equal(publicRequestRow.sessionId, 'sess-1');
  assert.equal(publicRequestRow.tokens, '12.6k');
  assert.equal(requestRow.startedAtMs, FIXED_START_MS, '裁剪必须是复制，不能改原行');
});

test('stats：上游没返回缓存字段时全局命中率给 —（不编造 0%）', () => {
  const rowsWithoutCacheFields = [
    { status: 200, startedAtMs: FIXED_START_MS, usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 } },
    { status: 200, startedAtMs: FIXED_START_MS + 1000, usage: { promptTokens: 50, completionTokens: 1, totalTokens: 51 } },
  ];

  const globalStats = buildGlobalStats(rowsWithoutCacheFields);

  assert.equal(globalStats.cacheHitPercent, '—');
  assert.equal(globalStats.totalTokens, 156);
});

test('stats：中断行不计入 byStatus，单独计 abortedRows', () => {
  const mixedRows = [
    { status: 200, startedAtMs: FIXED_START_MS, usage: { totalTokens: 10 } },
    { status: 0, aborted: true, startedAtMs: FIXED_START_MS + 1000, usage: null },
  ];

  const globalStats = buildGlobalStats(mixedRows);

  assert.deepEqual(globalStats.byStatus, { 200: 1 }, '中断不能算成成功');
  assert.equal(globalStats.abortedRows, 1);
  assert.equal(globalStats.totalRows, 2);
  assert.equal(globalStats.totalTokens, 10);
});

test('stats：中断行在会话 stats 里照常返回（带 aborted 标记）', () => {
  const abortedRow = buildRequestRow({
    ...FULL_ROW_INPUT,
    statusCode: 0,
    statusText: '客户端中断',
    aborted: true,
  });

  assert.equal(abortedRow.status, 0);
  assert.equal(abortedRow.statusText, '客户端中断');
  assert.equal(abortedRow.aborted, true);
  assert.equal('startedAtMs' in abortedRow, true, '存储行保留内部字段，裁剪只在出参层做');
});

test('stats：默认上限是 5000（docs/09 §8）', () => {
  assert.equal(DEFAULT_MAX_REQUEST_ROWS, 5000);
});

test('stats：出参带 completionTokens 与 latencySeconds（生成速度原料，不是吞吐）', () => {
  const requestRow = buildRequestRow(FULL_ROW_INPUT);
  const publicRequestRow = toPublicRequestRow(requestRow);

  assert.equal(publicRequestRow.completionTokens, 2600, '输出 token 必须与 usage.completionTokens 一致');
  assert.equal(publicRequestRow.latencySeconds, 1.23, '耗时秒数保留两位小数');
  assert.equal(typeof publicRequestRow.latencySeconds, 'number');
  // 裁剪规则不变：内部字段仍不外露
  assert.equal('usage' in publicRequestRow, false);
  assert.equal('startedAtMs' in publicRequestRow, false);
});

test('stats：没有 usage 时两个数值字段给 null（不是破折号）', () => {
  const requestRow = buildRequestRow({
    sessionId: 'sess-no-usage',
    statusCode: 200,
    model: 'm1',
    startedAtMs: FIXED_START_MS,
    finishedAtMs: FIXED_START_MS + 4560,
    usage: null,
  });
  const publicRequestRow = toPublicRequestRow(requestRow);

  assert.equal(publicRequestRow.completionTokens, null);
  assert.equal(publicRequestRow.latencySeconds, 4.56);
  assert.equal(publicRequestRow.tokens, '—', '展示字段仍用破折号');
});

test('stats：历史行缺两个数值字段时，出参归一成 null（不是 undefined）', () => {
  // 模拟旧版本写入的行：没有 completionTokens / latencySeconds
  const legacyRequestRow = {
    time: '10:00:00',
    status: 200,
    statusText: '成功',
    model: 'm1',
    account: { name: 'g', id: 'g' },
    ip: '127.0.0.1',
    ua: 'ua',
    latency: '1.00s',
    tokens: '10',
    credit: '—',
    cacheHit: '—',
    requestId: 'req-legacy',
    title: '...',
    sessionId: 'sess-legacy',
  };

  const publicRequestRow = toPublicRequestRow(legacyRequestRow);

  assert.strictEqual(publicRequestRow.completionTokens, null, '缺字段必须补 null，不能漏成 undefined');
  assert.strictEqual(publicRequestRow.latencySeconds, null);
  // JSON 序列化后字段仍然存在（undefined 会被 JSON 直接丢掉）
  const serialized = JSON.parse(JSON.stringify(publicRequestRow));
  assert.equal('completionTokens' in serialized, true);
  assert.equal(serialized.completionTokens, null);
  assert.equal('latencySeconds' in serialized, true);
});
