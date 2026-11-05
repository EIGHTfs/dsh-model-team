// 会话存储用例（docs/09 §2·§3·§4）：三级回退、sessionId 安全、映射读写、事件流。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  appendSessionEvent,
  assertSafeSessionId,
  defaultJsonlSessionResolver,
  readSessionEvents,
  readSessionMapping,
  resolveSessionIdentity,
  toSessionFileName,
  writeSessionMapping,
} from '../src/gateway/session/store.js';
import { GatewayError } from '../src/gateway/errors.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

// 把一个 socket 形状的假请求头交给解析器
function fakeRequest(headers) {
  return { headers };
}

test('sessionId 安全：空值/父目录跳转/路径分隔符/超长一律拒绝', () => {
  assert.throws(() => assertSafeSessionId(''), GatewayError);
  assert.throws(() => assertSafeSessionId('   '), GatewayError);
  assert.throws(() => assertSafeSessionId('../etc/passwd'), GatewayError);
  assert.throws(() => assertSafeSessionId('a..b'), GatewayError);
  assert.throws(() => assertSafeSessionId('a/b'), GatewayError);
  assert.throws(() => assertSafeSessionId('a\\b'), GatewayError);
  assert.throws(() => assertSafeSessionId('x'.repeat(600)), GatewayError);
  assert.equal(assertSafeSessionId(' dsh-sess_01 '), 'dsh-sess_01');
});

test('sessionId 编码：编码后再解码必须回到原值，且不含路径分隔符', () => {
  assert.equal(toSessionFileName('dsh sess 1'), 'dsh%20sess%201');
  assert.equal(decodeURIComponent(toSessionFileName('会话-01')), '会话-01');
  assert.equal(toSessionFileName('会话-01').includes('/'), false);
});

test('会话识别：请求头优先（默认头名与自定义头名）', async () => {
  const defaultHeaderResult = await resolveSessionIdentity({
    incomingRequest: fakeRequest({ 'x-tim-session-id': 'sess-header' }),
    config: { session: {} },
  });
  assert.deepEqual(defaultHeaderResult, { sessionId: 'sess-header', fallbackGroupId: null, source: 'header' });

  const customHeaderResult = await resolveSessionIdentity({
    incomingRequest: fakeRequest({ 'x-my-session': 'sess-custom' }),
    config: { session: { headerName: 'X-My-Session' } },
  });
  assert.equal(customHeaderResult.sessionId, 'sess-custom');
});

test('会话识别：请求头非法值直接报 invalid-request（不静默降级）', async () => {
  await assert.rejects(
    () => resolveSessionIdentity({
      incomingRequest: fakeRequest({ 'x-tim-session-id': '../etc/passwd' }),
      config: { session: {} },
    }),
    (sessionError) => sessionError instanceof GatewayError && sessionError.status === 400,
  );
});

test('会话识别：第二级 jsonl 回退（注入 resolver）', async () => {
  const resolved = await resolveSessionIdentity({
    incomingRequest: fakeRequest({}),
    config: { session: { jsonlGlob: '/tmp/whatever/*.jsonl' } },
    jsonlResolver: async () => 'sess-from-jsonl',
  });
  assert.deepEqual(resolved, { sessionId: 'sess-from-jsonl', fallbackGroupId: null, source: 'jsonl' });
  assert.equal(resolved.fallbackGroupId, null);
});

test('会话识别：第三级兜底群；都没有则 session-unresolved', async () => {
  const fallbackResult = await resolveSessionIdentity({
    incomingRequest: fakeRequest({}),
    config: { session: { fallbackGroupId: 'agnes' } },
  });
  assert.deepEqual(fallbackResult, { sessionId: null, fallbackGroupId: 'agnes', source: 'fallback-group' });

  await assert.rejects(
    () => resolveSessionIdentity({ incomingRequest: fakeRequest({}), config: { session: {} } }),
    (sessionError) => sessionError instanceof GatewayError
      && sessionError.code === 'session-unresolved'
      && sessionError.status === 400,
  );
});

test('会话识别：jsonl 回退抛错不致命，继续走兜底群', async () => {
  const logger = createRecordingLogger();
  const resolved = await resolveSessionIdentity({
    incomingRequest: fakeRequest({}),
    config: { session: { jsonlGlob: '/tmp/x/*.jsonl', fallbackGroupId: 'agnes' } },
    logger,
    jsonlResolver: async () => {
      throw new Error('glob 炸弹');
    },
  });
  assert.equal(resolved.fallbackGroupId, 'agnes');
  assert.equal(logger.hasLine('warn', '会话日志回退失败'), true);
});

test('映射读写：原子写后可读回；缺失与损坏都返回 null', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();

  assert.equal(await readSessionMapping('sess-new', { dataRoot, logger }), null);

  const writtenMapping = await writeSessionMapping(
    'sess-01',
    { platform: 'agnes', model: 'agnes-3.0-flash', updatedAt: '2026-11-02T13:40:00+08:00' },
    { dataRoot, logger },
  );
  assert.equal(writtenMapping.platform, 'agnes');

  const readBackMapping = await readSessionMapping('sess-01', { dataRoot, logger });
  assert.deepEqual(readBackMapping, {
    sessionId: 'sess-01',
    platform: 'agnes',
    model: 'agnes-3.0-flash',
    // 新结构：mapping 里带归一后的 target；旧字段仍镜像出来，旧读取方不受影响
    target: { type: 'model', id: 'agnes-3.0-flash', platformId: 'agnes' },
    updatedAt: '2026-11-02T13:40:00+08:00',
  });

  // 损坏文件：告警后按未映射处理，不抛错
  await fs.writeFile(path.join(dataRoot, 'sessions', `${encodeURIComponent('sess-02')}.json`), '{ 坏 JSON', 'utf8');
  assert.equal(await readSessionMapping('sess-02', { dataRoot, logger }), null);
  assert.equal(logger.hasLine('warn', '会话映射损坏'), true);
});

test('事件流：按追加顺序读回，可限制条数', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();

  assert.deepEqual(await readSessionEvents('sess-events', { dataRoot, logger }), []);

  await appendSessionEvent('sess-events', { time: '13:40:00', type: 'self-message', text: '@m1', model: 'm1' }, { dataRoot });
  await appendSessionEvent('sess-events', { time: '13:41:00', type: 'system', text: '提示' }, { dataRoot });

  const events = await readSessionEvents('sess-events', { dataRoot, logger });
  assert.equal(events.length, 2);
  assert.equal(events[0].text, '@m1');
  assert.equal(events[1].type, 'system');

  const limitedEvents = await readSessionEvents('sess-events', { dataRoot, logger, limit: 1 });
  assert.equal(limitedEvents.length, 1);
  assert.equal(limitedEvents[0].type, 'system');
});

test('jsonl 回退实现：取最近修改的文件，首行有 sessionId 就用它', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const olderFile = path.join(dataRoot, 'older.jsonl');
  const newerFile = path.join(dataRoot, 'newer.jsonl');
  await fs.writeFile(olderFile, `${JSON.stringify({ sessionId: 'sess-older' })}\n`, 'utf8');
  await fs.writeFile(newerFile, `${JSON.stringify({ sessionId: 'sess-newer' })}\n`, 'utf8');
  await fs.utimes(olderFile, 1_700_000_000, 1_700_000_000);
  await fs.utimes(newerFile, 1_800_000_000, 1_800_000_000);

  const resolvedSessionId = await defaultJsonlSessionResolver({ jsonlGlob: path.join(dataRoot, '*.jsonl') });
  assert.equal(resolvedSessionId, 'sess-newer');
});

test('jsonl 回退实现：首行不是 JSON 时退回文件名', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const sessionFile = path.join(dataRoot, 'plain-session.jsonl');
  await fs.writeFile(sessionFile, 'not-json-first-line\n', 'utf8');

  const resolvedSessionId = await defaultJsonlSessionResolver({ jsonlGlob: path.join(dataRoot, '*.jsonl') });
  assert.equal(resolvedSessionId, 'plain-session');
});
