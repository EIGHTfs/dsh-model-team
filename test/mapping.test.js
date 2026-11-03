// 字段映射用例：点号路径读写、usage 归一化（含 totalTokens 兜底）、modelField 改写、摘要降级。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractUsage,
  prepareOutboundBody,
  readFieldByPath,
  renderSummaryTemplate,
  writeFieldByPath,
} from '../src/gateway/mapping.js';

test('mapping：点号路径读写的正常路径与越界路径', () => {
  assert.equal(readFieldByPath({ a: { b: { c: 7 } } }, 'a.b.c'), 7);
  assert.equal(readFieldByPath({ a: 'text' }, 'a.b'), undefined);
  assert.equal(readFieldByPath(null, 'a'), undefined);

  const target = {};
  writeFieldByPath(target, 'parameters.model', 'agnes-3.0-flash');
  assert.deepEqual(target, { parameters: { model: 'agnes-3.0-flash' } });
});

test('mapping：usage 优先取 total_tokens，缺失时用两项相加，缺项给 null', () => {
  assert.deepEqual(extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  });
  assert.deepEqual(extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } }), {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  });
  assert.deepEqual(extractUsage({ usage: { completion_tokens: 5 } }), {
    promptTokens: null,
    completionTokens: 5,
    totalTokens: null,
  });
  assert.equal(extractUsage({ error: 'no usage' }), null);
});

test('mapping：usagePath 支持嵌套，缓存命中字段兼容三种写法', () => {
  const nested = extractUsage({ meta: { usage: { prompt_tokens: 4, completion_tokens: 1, cache_read_input_tokens: 2 } } }, 'meta.usage');
  assert.equal(nested.cacheHit, 2);

  const details = extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 8 } } });
  assert.equal(details.cacheHit, 8);
});

test('mapping：modelField 改写为嵌套路径且不污染入参', () => {
  const originalBody = { model: 'agnes-3.0-flash', messages: [] };
  const rewrittenBody = prepareOutboundBody(originalBody, { modelField: 'parameters.model' });

  assert.equal(rewrittenBody.parameters.model, 'agnes-3.0-flash');
  assert.equal('model' in rewrittenBody, false);
  assert.deepEqual(originalBody, { model: 'agnes-3.0-flash', messages: [] }, '入参必须保持不变');

  const untouchedBody = prepareOutboundBody(originalBody, {});
  assert.equal(untouchedBody.model, 'agnes-3.0-flash');
});

test('mapping：摘要模板缺失变量降级为 —，空模板返回空串', () => {
  assert.equal(renderSummaryTemplate('模型 {modelCount} 个 · {accessMode}', { accessMode: 'official' }), '模型 — 个 · official');
  assert.equal(renderSummaryTemplate('', { accessMode: 'official' }), '');
  assert.equal(renderSummaryTemplate(undefined, {}), '');
});
