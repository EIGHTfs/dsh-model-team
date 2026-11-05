// rate.js 单测：直接执行 ui/js/rate.js 文本（UMD 挂 globalThis），不依赖任何框架与 DOM。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const rateSource = await fs.readFile(new URL('../ui/js/format/rate.js', import.meta.url), 'utf8');
// eslint-disable-next-line no-new-func
new Function(rateSource)();
const rate = globalThis.ModelTeamRate;

test('模块挂载到 globalThis', () => {
  assert.equal(typeof rate, 'object');
  for (const name of ['parseTokenCount', 'parseLatencySeconds', 'computeGenerationRate', 'formatRate']) {
    assert.equal(typeof rate[name], 'function', name);
  }
});

test('parseTokenCount：40.3k → 40300，— / 空 → null', () => {
  assert.equal(rate.parseTokenCount('40.3k'), 40300);
  assert.equal(rate.parseTokenCount('1.2M'), 1200000);
  assert.equal(rate.parseTokenCount('512'), 512);
  assert.equal(rate.parseTokenCount('—'), null);
  assert.equal(rate.parseTokenCount(''), null);
  assert.equal(rate.parseTokenCount(null), null);
});

test('parseLatencySeconds：4.56s → 4.56，— → null', () => {
  assert.equal(rate.parseLatencySeconds('4.56s'), 4.56);
  assert.equal(rate.parseLatencySeconds('12.07s'), 12.07);
  assert.equal(rate.parseLatencySeconds('—'), null);
  assert.equal(rate.parseLatencySeconds(null), null);
});

test('computeGenerationRate：用 completionTokens / latencySeconds', () => {
  const value = rate.computeGenerationRate({ completionTokens: 9, latencySeconds: 4.56 });
  assert.equal(Math.abs(value - 1.9736842105263157) < 1e-9, true);
});

test('反例：只有 total tokens/latency 时必须是 null（禁止 total 兜底）', () => {
  assert.equal(rate.computeGenerationRate({ tokens: '40.3k', latency: '4.56s' }), null);
  assert.equal(rate.computeGenerationRate({ tokens: '40.3k', latency: '4.56s', completionTokens: null }), null);
  assert.equal(rate.computeGenerationRate({ completionTokens: 9, latencySeconds: 0 }), null);
  assert.equal(rate.computeGenerationRate(null), null);
});

test('历史行缺字段（undefined）与新字段（真机值）都要正确处理', () => {
  // 旧代码写的行：两个字段压根不存在 → undefined，必须跳过
  assert.equal(rate.computeGenerationRate({ model: 'x', tokens: '40.3k', latency: '4.56s' }), null);
  // 真机现网数据：completionTokens=10, latencySeconds=0.99 → 10.1 tok/s
  const liveValue = rate.computeGenerationRate({ completionTokens: 10, latencySeconds: 0.99 });
  assert.equal(Math.abs(liveValue - 10.101010101010102) < 1e-9, true);
  assert.equal(rate.formatRate(liveValue), '10.1');
});

test('formatRate：<100 一位小数、>=100 取整、>=1000 用 k、无效 —', () => {
  assert.equal(rate.formatRate(83.12), '83.1');
  assert.equal(rate.formatRate(1234), '1.2k');
  assert.equal(rate.formatRate(1.9736842105263157), '2.0');
  assert.equal(rate.formatRate(null), '—');
  assert.equal(rate.formatRate(undefined), '—');
});

test('选行：最后一行无效时回退到前一条有效行（最多 20 行）', () => {
  const rows = [
    { completionTokens: 91, latencySeconds: 1.0 },   // 有效 → 91
    { completionTokens: null, latencySeconds: 2.0 },  // 无效
    { tokens: '40.3k', latency: '4.56s' }             // 无效（旧格式）
  ];
  let picked = null;
  for (let index = rows.length - 1; index >= 0 && index >= rows.length - 20; index -= 1) {
    const value = rate.computeGenerationRate(rows[index]);
    if (value !== null) { picked = value; break; }
  }
  assert.equal(picked, 91);
});
