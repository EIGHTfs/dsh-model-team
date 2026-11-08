// 速率：**值由服务端算、显示由界面做**（契约要求值与显示分离）。
//
// 本文件只测两件事：
//   1) 声明式加载器：按声明的模块标识动态加载，缺省标识可用，失败降级为 null 且只 warn 一次
//   2) 服务端出口 computeSessionRate 只返回 { tps, exact }——不带单位、不带「≈」、不带措辞
//
// 显示（单位与 ≈）由客户端负责，见 client 侧用例；这里刻意断言"没有字符串"，
// 防止以后有人把格式化又塞回服务端。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RATE_FORMULA_MODULE,
  computeSessionRate,
  createRateFormulaLoader,
} from '../src/gateway/stats/rate-formula.js';

// 构造一行"有解码段"的输入：精确桶
function exactRow(completionTokens, decodeMs) {
  return { completionTokens, decodeMs, latencySeconds: 99 };
}

// 构造一行"只有整步耗时"的输入：下界桶
function spanRow(completionTokens, latencySeconds) {
  return { completionTokens, latencySeconds };
}

test('缺省公式模块可加载，且算出来的是值（不含单位/近似标记）', async () => {
  const rate = await computeSessionRate([exactRow(100, 2000)]);
  assert.equal(typeof rate, 'object');
  assert.equal(Number.isFinite(rate.tps), true);
  assert.equal(rate.exact, true);
  // 值里不允许混入展示成分
  assert.equal(JSON.stringify(rate).includes('tok/s'), false);
  assert.equal(JSON.stringify(rate).includes('≈'), false);
  assert.equal(typeof rate.tps, 'number');
});

test('只有整步耗时的行 → exact=false（下界由界面加标记，服务端不改文案）', async () => {
  const rate = await computeSessionRate([spanRow(100, 10)]);
  assert.equal(rate.exact, false);
  assert.equal(rate.tps, 10);
});

test('没有可用行 → null（界面显示占位，不编造数值）', async () => {
  assert.equal(await computeSessionRate([]), null);
  assert.equal(await computeSessionRate([{ latencySeconds: 3 }]), null);
});

test('按群筛好的行只影响数值：公式层不认识"群"，只认同一个 rows 数组', async () => {
  const COMPLETION = 100;
  const DECODE_MS = 2000;
  const HEAVY_COMPLETION = 900;

  const onlyGroupA = [exactRow(COMPLETION, DECODE_MS), exactRow(COMPLETION, DECODE_MS)];
  const mixedGroups = [...onlyGroupA, exactRow(HEAVY_COMPLETION, DECODE_MS)];

  // 期望值由输入推导（不手抄结果）：sum(completion) / sum(decodeMs/1000)
  const expectedA = (COMPLETION * 2) / ((DECODE_MS * 2) / 1000);
  const expectedMixed = (COMPLETION * 2 + HEAVY_COMPLETION) / ((DECODE_MS * 3) / 1000);

  const rateA = await computeSessionRate(onlyGroupA);
  const rateMixed = await computeSessionRate(mixedGroups);
  assert.equal(rateA.tps, expectedA);
  assert.equal(rateMixed.tps, expectedMixed);
  assert.notEqual(rateA.tps, rateMixed.tps, '筛法不同就必须算出不同数值，说明过滤责任在调用方');
});

test('公式模块缺失 → 降级为 null，且只 warn 一次', async () => {
  const warnings = [];
  const loader = createRateFormulaLoader({
    specifier: 'lib/shared/does-not-exist.mjs',
    logger: { warn(message) { warnings.push(message); } },
  });
  const first = await computeSessionRate([exactRow(10, 1000)], { loader });
  const second = await computeSessionRate([exactRow(10, 1000)], { loader });
  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(warnings.length, 1, '同一个标识只提醒一次，避免每次请求刷日志');
});

test('导出形状不对（没有 aggregateGenerationRate）→ 视为不可用', async () => {
  const loader = createRateFormulaLoader({
    specifier: 'ignored',
    importer: async () => ({ formatRate: () => 'x' }),
    logger: { warn() {} },
  });
  assert.equal(await computeSessionRate([exactRow(10, 1000)], { loader }), null);
});

test('模块标识是声明出来的，可换实现而不改调用方', async () => {
  const customModule = {
    aggregateGenerationRate: () => ({ tps: 123, exact: true }),
  };
  const loader = createRateFormulaLoader({
    specifier: 'any-declared-id',
    importer: async () => customModule,
    logger: { warn() {} },
  });
  const rate = await computeSessionRate([exactRow(1, 1000)], { loader });
  assert.deepEqual(rate, { tps: 123, exact: true });
  assert.equal(DEFAULT_RATE_FORMULA_MODULE, 'lib/shared/rate.mjs', '缺省标识仍是声明值，不是写死的绝对路径');
});
