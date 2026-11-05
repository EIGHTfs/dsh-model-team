// rate.js 单测：直接执行 ui/js/format/rate.js 文本（UMD 挂 globalThis），不依赖任何框架与 DOM。
//
// 公式口径（与解码段公式对齐，docs/02 §5.1）：
//   精确值 = completionTokens / 解码段时长（首字 → 结束），分母不含首字等待；
//   退化值 = completionTokens / 整步耗时（含首字等待），只能当下界，必须标 exact=false。
// 断言写法约定：期望值一律由输入常量推导（不手抄结果数字），改公式时这些断言会跟着一起变，
// 下一个改公式的人能立刻看出哪条用例受哪个字段影响。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const rateSource = await fs.readFile(new URL('../ui/js/format/rate.js', import.meta.url), 'utf8');
// eslint-disable-next-line no-new-func
new Function(rateSource)();
const rate = globalThis.ModelTeamRate;

const MS_PER_SECOND = 1000;

// 时间形状取"长思考模型"的典型比例：首字等待 3s、解码 2s（合计 5s）。
// 刻意让 TTFT 比解码段还长：一旦公式误用整步耗时，算出来的值只有精确值的 40%，
// 两条分支的期望值不可能互相冒充，所以这组输入能真正区分"用哪个分母"。
const FIRST_TOKEN_DELAY_MS = 3000;
const DECODE_MS = 2000;
const TOTAL_LATENCY_SECONDS = (FIRST_TOKEN_DELAY_MS + DECODE_MS) / MS_PER_SECOND;
const COMPLETION_TOKENS = 100;
const EXPECTED_EXACT_TPS = COMPLETION_TOKENS / (DECODE_MS / MS_PER_SECOND);
const EXPECTED_SPAN_TPS = COMPLETION_TOKENS / TOTAL_LATENCY_SECONDS;

// 浮点比较：除不尽的值只比 1e-9 内的相对误差，避免字符串化误差把用例变成看运气
function assertClose(actual, expected, message) {
  assert.equal(typeof actual, 'number', `${message}：应得到数字，实际 ${actual}`);
  assert.equal(Math.abs(actual - expected) < 1e-9, true, `${message}：期望 ${expected}，实际 ${actual}`);
}

test('模块挂载到 globalThis', () => {
  assert.equal(typeof rate, 'object');
  for (const name of [
    'parseTokenCount',
    'parseLatencySeconds',
    'computeGenerationRate',
    'aggregateGenerationRate',
    'formatRate',
    'formatRateText',
  ]) {
    assert.equal(typeof rate[name], 'function', name);
  }
});

test('parseTokenCount：k/M 后缀按量级换算，— / 空 / 非法 → null', () => {
  assert.equal(rate.parseTokenCount('40.3k'), 40.3 * 1000);
  assert.equal(rate.parseTokenCount('1.2M'), 1.2 * 1000000);
  assert.equal(rate.parseTokenCount('512'), 512);
  assert.equal(rate.parseTokenCount('—'), null);
  assert.equal(rate.parseTokenCount(''), null);
  assert.equal(rate.parseTokenCount(null), null);
});

test('parseLatencySeconds：s 后缀只是展示格式，— / 空 → null', () => {
  assert.equal(rate.parseLatencySeconds('4.56s'), 4.56);
  assert.equal(rate.parseLatencySeconds('12.07s'), 12.07);
  assert.equal(rate.parseLatencySeconds('—'), null);
  assert.equal(rate.parseLatencySeconds(null), null);
});

test('精确值：有首字时刻时只用解码段做分母', () => {
  const result = rate.computeGenerationRate({
    completionTokens: COMPLETION_TOKENS,
    decodeMs: DECODE_MS,
    latencySeconds: TOTAL_LATENCY_SECONDS,
  });
  assert.equal(result.exact, true, '本行有 decodeMs，必须标精确');
  assertClose(result.tps, EXPECTED_EXACT_TPS, '分母应是解码段');
  // 反证：如果实现偷偷用了整步耗时，值会等于下面这个数
  assert.notEqual(result.tps, EXPECTED_SPAN_TPS, '不得混入首字等待');
});

test('退化值：没有首字时刻时退回整步耗时，并明确标 exact=false（下界）', () => {
  // 同一组 token/整步耗时，只把 decodeMs 拿掉：期望值必须换成整步口径
  const result = rate.computeGenerationRate({
    completionTokens: COMPLETION_TOKENS,
    decodeMs: null,
    latencySeconds: TOTAL_LATENCY_SECONDS,
  });
  assert.equal(result.exact, false, '没有首字时刻只能以下界给出');
  assertClose(result.tps, EXPECTED_SPAN_TPS, '分母应是整步耗时');
  assert.notEqual(result.tps, EXPECTED_EXACT_TPS, '不得冒充精确值');
});

test('两者都缺 → null（禁止用 tokens/latency 字符串兜底）', () => {
  assert.equal(rate.computeGenerationRate({ tokens: '40.3k', latency: '4.56s' }), null);
  assert.equal(rate.computeGenerationRate({ tokens: '40.3k', latency: '4.56s', completionTokens: null }), null);
  assert.equal(rate.computeGenerationRate(null), null);
  // 只有 token、没有任何时长分母
  assert.equal(rate.computeGenerationRate({ completionTokens: COMPLETION_TOKENS }), null);
});

test('分母非正 / token 非正一律不用：0 与负数都要跳过', () => {
  // decodeMs 为 0 / 负数 → 不构成精确值，退回整步口径（而不是算出 Infinity 或负速率）
  for (const invalidDecodeMs of [0, -DECODE_MS]) {
    const fallenBack = rate.computeGenerationRate({
      completionTokens: COMPLETION_TOKENS,
      decodeMs: invalidDecodeMs,
      latencySeconds: TOTAL_LATENCY_SECONDS,
    });
    assert.equal(fallenBack.exact, false, `decodeMs=${invalidDecodeMs} 不能当精确值`);
    assertClose(fallenBack.tps, EXPECTED_SPAN_TPS, `decodeMs=${invalidDecodeMs} 应退回整步口径`);
  }
  // 两个分母都不可用 → null
  assert.equal(rate.computeGenerationRate({ completionTokens: COMPLETION_TOKENS, decodeMs: 0, latencySeconds: 0 }), null);
  assert.equal(
    rate.computeGenerationRate({ completionTokens: COMPLETION_TOKENS, decodeMs: -1, latencySeconds: -TOTAL_LATENCY_SECONDS }),
    null,
  );
  // token 为 0 或缺 → null（没有输出就没有"生成速度"）
  assert.equal(rate.computeGenerationRate({ completionTokens: 0, decodeMs: DECODE_MS, latencySeconds: TOTAL_LATENCY_SECONDS }), null);
  assert.equal(
    rate.computeGenerationRate({ completionTokens: null, decodeMs: DECODE_MS, latencySeconds: TOTAL_LATENCY_SECONDS }),
    null,
  );
});

test('反例自证：decodeMs 与 latencySeconds 不可互换（换了 exact 立刻变）', () => {
  // 误把解码段秒数塞进 latencySeconds：此时没有 decodeMs，必须判成退化值，
  // 即便算出来的数字碰巧一样（这里刻意让两者相等，正是最容易被忽略的错法）
  const swapped = rate.computeGenerationRate({
    completionTokens: COMPLETION_TOKENS,
    latencySeconds: DECODE_MS / MS_PER_SECOND,
  });
  assert.equal(swapped.exact, false, '整步口径不得冒充精确值');
  assertClose(swapped.tps, EXPECTED_EXACT_TPS, '这一组里两种口径的数值相同，所以只能靠 exact 区分');

  // 反向：有 decodeMs 时，整步耗时再大也不得参与精确值
  const exact = rate.computeGenerationRate({
    completionTokens: COMPLETION_TOKENS,
    decodeMs: DECODE_MS,
    latencySeconds: TOTAL_LATENCY_SECONDS * 10,
  });
  assert.equal(exact.exact, true);
  assertClose(exact.tps, EXPECTED_EXACT_TPS, '整步耗时被放大十倍，精确值也不能变');
});

test('历史行缺字段（undefined）与新字段（真机形状）都要正确处理', () => {
  // 旧代码写的行：两个分母压根不存在 → undefined，必须跳过
  assert.equal(rate.computeGenerationRate({ model: 'model-a', tokens: '40.3k', latency: '4.56s' }), null);
  // 只有整步耗时的老行：仍能给出下界，只是带 exact=false
  const legacyRow = { completionTokens: COMPLETION_TOKENS, latencySeconds: TOTAL_LATENCY_SECONDS };
  assert.equal(rate.computeGenerationRate(legacyRow).exact, false);
});

test('聚合多条：sum(token)/sum(解码段)，不是逐行速率的平均', () => {
  // 两行规模差 3 倍：逐行平均与 sum/sum 会给出不同结果，正好用来钉"加权而不是平均"
  const smallRow = { completionTokens: 30, decodeMs: 1000 };
  const largeRow = { completionTokens: 130, decodeMs: 3000, latencySeconds: TOTAL_LATENCY_SECONDS };
  const rows = [
    largeRow,
    // 没有 decodeMs 的行不得进精确桶
    { completionTokens: 999, latencySeconds: TOTAL_LATENCY_SECONDS },
    smallRow,
  ];

  const result = rate.aggregateGenerationRate(rows);
  const sumTokens = largeRow.completionTokens + smallRow.completionTokens;
  const sumDecodeMs = largeRow.decodeMs + smallRow.decodeMs;
  const rowAverage = (
    largeRow.completionTokens / (largeRow.decodeMs / MS_PER_SECOND)
    + smallRow.completionTokens / (smallRow.decodeMs / MS_PER_SECOND)
  ) / 2;

  assert.equal(result.exact, true, '有精确行时聚合结果就是精确值');
  assertClose(result.tps, sumTokens / (sumDecodeMs / MS_PER_SECOND), '总 token / 总解码段');
  assert.notEqual(result.tps, rowAverage, '不得退化成逐行平均');
});

test('聚合：有精确行时优先精确桶，退化行的 token 不进任何分母', () => {
  const exactRow = { completionTokens: COMPLETION_TOKENS, decodeMs: DECODE_MS };
  // 退化行 token 很多、整步耗时很长：如果混进合计，结果会被拉向它的整步口径
  const coarseRow = { completionTokens: COMPLETION_TOKENS * 9, latencySeconds: TOTAL_LATENCY_SECONDS * 90 };
  const result = rate.aggregateGenerationRate([exactRow, coarseRow]);

  assert.equal(result.exact, true);
  assertClose(result.tps, exactRow.completionTokens / (exactRow.decodeMs / MS_PER_SECOND), '只看精确桶');
});

test('聚合：一条精确值都没有时才退化成整步桶（并标 exact=false）', () => {
  const firstRow = { completionTokens: COMPLETION_TOKENS, latencySeconds: TOTAL_LATENCY_SECONDS };
  const secondRow = { completionTokens: COMPLETION_TOKENS * 2, latencySeconds: TOTAL_LATENCY_SECONDS * 2 };
  const result = rate.aggregateGenerationRate([firstRow, secondRow]);

  const sumTokens = firstRow.completionTokens + secondRow.completionTokens;
  const sumSeconds = firstRow.latencySeconds + secondRow.latencySeconds;
  assert.equal(result.exact, false);
  assertClose(result.tps, sumTokens / sumSeconds, '整步桶同样是 sum/sum');
});

test('聚合：空列表 / 全无有效 token → null', () => {
  assert.equal(rate.aggregateGenerationRate([]), null);
  assert.equal(rate.aggregateGenerationRate(null), null);
  assert.equal(rate.aggregateGenerationRate([{ tokens: '40.3k', latency: '4.56s' }]), null);
  assert.equal(rate.aggregateGenerationRate([{ completionTokens: 0, decodeMs: DECODE_MS }]), null);
});

test('formatRate：<100 一位小数、>=100 取整、>=1000 用 k、无效 —', () => {
  const subHundred = 83.12;
  const hundredPlus = 1234;
  assert.equal(rate.formatRate(subHundred), subHundred.toFixed(1));
  assert.equal(rate.formatRate(hundredPlus), (hundredPlus / 1000).toFixed(1) + 'k');
  // 恰好落在 >=100 分支：用期望精确值的倍数构造，避免另抄一个魔数
  const justOverHundred = EXPECTED_EXACT_TPS * 4;
  assert.equal(rate.formatRate(justOverHundred), String(Math.round(justOverHundred)));
  assert.equal(rate.formatRate(null), '—');
  assert.equal(rate.formatRate(undefined), '—');
});

test('formatRateText：精确值不加前缀，退化值带 ≈，空值 —', () => {
  const preciseTps = 40.234;
  const coarseTps = 14.47;
  assert.equal(rate.formatRateText({ tps: preciseTps, exact: true }), preciseTps.toFixed(1));
  assert.equal(rate.formatRateText({ tps: coarseTps, exact: false }), '≈' + coarseTps.toFixed(1));
  assert.equal(rate.formatRateText(null), '—');
  assert.equal(rate.formatRateText({ tps: null, exact: false }), '—');
});
