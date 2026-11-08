// 缓存命中率的分母口径：不同上游对 `prompt_tokens` 的含法不同，命中率必须按「输入总量」算。
//
// 事故（2026-11-08 实测）：某平台返回 `prompt_tokens: 312`、缓存 `503296`，
// 旧的 `cached / prompt` 算出 **161312.8%**。真实输入总量是两者之和（503608），
// 正确命中率约 99.94%。
//
// 判据：缓存不可能超过输入总量 —— 一旦 cached > prompt，就说明该平台的 prompt 只报"未命中部分"。
// 这个判据同时适用于写入侧归一化与读出侧格式化（历史行按旧口径存过，也要能正确显示）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractUsage, resolvePromptTotal } from '../src/gateway/mapping.js';
import { formatCacheHit } from '../src/gateway/stats/index.js';

test('prompt 只报未命中部分（cached > prompt）→ 分母取两者之和', () => {
  assert.equal(resolvePromptTotal(312, 503296), 312 + 503296);
});

test('prompt 已含缓存（cached <= prompt）→ 分母就是 prompt，旧行为不变', () => {
  assert.equal(resolvePromptTotal(1000, 900), 1000);
  assert.equal(resolvePromptTotal(1000, 1000), 1000);
});

test('没有缓存数据 → 分母仍是 prompt（不因为缺缓存而改变口径）', () => {
  assert.equal(resolvePromptTotal(1000, null), 1000);
  assert.equal(resolvePromptTotal(1000, 0), 1000);
});

test('坏输入 → null（调用方按缺失处理，不编造分母）', () => {
  assert.equal(resolvePromptTotal(undefined, 10), null);
  assert.equal(resolvePromptTotal(-1, 10), null);
  // prompt=0 视为"上游没报输入量"：不能用 cached 反推出一个 100% 的分母
  assert.equal(resolvePromptTotal(0, 10), null);
});

test('extractUsage：把两种口径都归一成输入总量，命中率不再超过 100%', () => {
  const payload = {
    usage: { prompt_tokens: 312, completion_tokens: 774, total_tokens: 504382, prompt_tokens_details: { cached_tokens: 503296 } },
  };
  const usage = extractUsage(payload);
  assert.equal(usage.promptTokens, 312 + 503296, 'prompt 归一为输入总量');
  assert.equal(usage.cacheHit, 503296);

  const hitText = formatCacheHit(usage);
  const hitPercent = Number(hitText.replace('%', ''));
  assert.equal(hitPercent > 0 && hitPercent <= 100, true, `命中率必须在 0~100 之间，实际 ${hitText}`);
});

test('extractUsage：prompt 已含缓存的平台保持原值（不改动既有语义）', () => {
  const payload = { usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, prompt_tokens_details: { cached_tokens: 900 } } };
  const usage = extractUsage(payload);
  assert.equal(usage.promptTokens, 1000);
  assert.equal(formatCacheHit(usage), '90.0%');
});

test('历史行（按旧口径存过）也能正确显示：formatCacheHit 自己会再算一次分母', () => {
  // 模拟库里已有的坏行：promptTokens 只是未命中部分
  const legacyRowUsage = { promptTokens: 312, completionTokens: 774, totalTokens: 504382, cacheHit: 503296 };
  const hitPercent = Number(formatCacheHit(legacyRowUsage).replace('%', ''));
  assert.equal(hitPercent > 0 && hitPercent <= 100, true, '旧行也不能再显示成 161312.8%');
});

test('没有缓存字段 → 命中率显示占位（缺数据不等于 0%）', () => {
  assert.equal(formatCacheHit({ promptTokens: 1000 }), '—');
});

test('全局汇总：命中率也按逐行归一后的分母算，不会超过 100%', async () => {
  const { buildGlobalStats } = await import('../src/gateway/stats/index.js');
  const rows = [
    // 旧口径行：prompt 只是未命中部分
    { status: 200, usage: { promptTokens: 312, completionTokens: 774, totalTokens: 504382, cacheHit: 503296 } },
    // 常见口径行：prompt 已含缓存
    { status: 200, usage: { promptTokens: 1000, completionTokens: 10, totalTokens: 1010, cacheHit: 900 } },
  ];
  const stats = buildGlobalStats(rows);
  const percent = Number(String(stats.cacheHitPercent).replace('%', ''));
  assert.equal(percent > 0 && percent <= 100, true, `全局命中率必须落在 0~100，实际 ${stats.cacheHitPercent}`);
});
