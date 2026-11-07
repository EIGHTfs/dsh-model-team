// Qoder SSE 信封剥离（M1 纯函数）：正常帧 / 结束哨兵 / 坏帧三态必须能区分，且坏帧不抛。
import test from 'node:test';
import assert from 'node:assert/strict';

import { ENVELOPE_DONE, unwrapEnvelope } from '../src/reverse/platforms/qoder/envelope.js';

const INNER_CHUNK = '{"choices":[{"index":0,"delta":{"content":"你好"}}]}';

function envelopeFor(bodyText) {
  return JSON.stringify({ headers: { 'content-type': 'text/event-stream' }, statusCode: 200, body: bodyText });
}

test('正常信封：剥掉外层，原样返回内层 body 字符串', () => {
  const rawLine = `data: ${envelopeFor(INNER_CHUNK)}`;

  const unwrapped = unwrapEnvelope(rawLine);

  assert.equal(typeof unwrapped, 'string');
  assert.equal(unwrapped, INNER_CHUNK);
  assert.deepEqual(JSON.parse(unwrapped), JSON.parse(INNER_CHUNK));
});

test('没有 data: 前缀的裸 JSON 也接受（上游/中间件可能已剥一层）', () => {
  assert.equal(unwrapEnvelope(envelopeFor(INNER_CHUNK)), INNER_CHUNK);
});

test('结束哨兵：外层 [DONE] 与内层 body 为 [DONE] 都返回同一个哨兵，且与 null 区分', () => {
  const outerDone = unwrapEnvelope('data: [DONE]');
  const innerDone = unwrapEnvelope(`data: ${envelopeFor('[DONE]')}`);

  assert.equal(outerDone, ENVELOPE_DONE);
  assert.equal(innerDone, ENVELOPE_DONE);
  assert.notEqual(ENVELOPE_DONE, null, '哨兵必须与"坏帧"的 null 区分开');
  assert.equal(Object.isFrozen(ENVELOPE_DONE), true);
});

test('坏帧：非法 JSON / 缺 body / body 不是字符串 → null，且不抛', () => {
  assert.equal(unwrapEnvelope('data: {not json'), null);
  assert.equal(unwrapEnvelope(`data: ${JSON.stringify({ headers: {}, statusCode: 200 })}`), null);
  assert.equal(unwrapEnvelope(`data: ${JSON.stringify({ body: { not: 'string' } })}`), null);
  assert.equal(unwrapEnvelope(`data: ${JSON.stringify({ body: 'not-json-inside' })}`), null);
  assert.equal(unwrapEnvelope(''), null);
  assert.equal(unwrapEnvelope('data:   '), null);
  assert.equal(unwrapEnvelope(null), null);
  assert.equal(unwrapEnvelope(undefined), null);
});

test('内层 body 含转义引号与换行：返回的字符串仍能原样解析回同样的内容', () => {
  const innerPayload = { choices: [{ delta: { content: '第一行\n第二行 "带引号" 与 \\反斜杠' } }] };
  const innerJsonText = JSON.stringify(innerPayload);
  // 外层把内层 JSON 当字符串再序列化一次 —— 这正是上游实际的样子（双重转义）
  const rawLine = `data: ${envelopeFor(innerJsonText)}`;

  const unwrapped = unwrapEnvelope(rawLine);

  assert.equal(unwrapped, innerJsonText, '转义必须原样还原成内层 JSON 文本');
  assert.deepEqual(JSON.parse(unwrapped), innerPayload);
  assert.equal(JSON.parse(unwrapped).choices[0].delta.content.includes('\n'), true);
});
