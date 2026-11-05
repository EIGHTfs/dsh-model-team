// G-05：请求卡片展示目标来源。
// 被测代码是 ui/js/target-source.js（悬浮球与卡片共用的唯一映射），
// 加载方式与 test/inv14-model-gate.test.js 一致：执行分片源码 + 最小垫片，不引入 DOM 框架。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const SOURCE = await fs.readFile(new URL('../ui/js/float/target-source.js', import.meta.url), 'utf8');

// 每次加载重置垫片：warnOnce 的"只告警一次"是模块级状态，用例之间不能互相影响
function loadFragment() {
  const recorded = { warnings: [] };
  // 与客户端真实 warnOnce 一致：按 label 去重（只告警一次）
  const seenLabels = new Set();
  globalThis.warnOnce = (label) => {
    if (seenLabels.has(label)) return;
    seenLabels.add(label);
    recorded.warnings.push(label);
  };
  globalThis.escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${SOURCE}
;return {
  targetSourceHintOf: targetSourceHintOf,
  renderTargetSourceBadge: renderTargetSourceBadge,
  TARGET_SOURCE_HINTS: TARGET_SOURCE_HINTS
};`);
  return { fragment: factory(), recorded };
}

test('G-05 映射：每个已知来源给出与悬浮球一致的文案', () => {
  const { fragment } = loadFragment();

  assert.equal(fragment.targetSourceHintOf('last-session'), '（继承上一会话）');
  assert.equal(fragment.targetSourceHintOf('parent'), '（继承父会话）');
  assert.equal(fragment.targetSourceHintOf('fallback-group'), '（兜底群默认）');
  // 悬浮球（app.js）与卡片（render.js）都只调用这一个函数，映射表本身只能有一份
  assert.deepEqual(Object.keys(fragment.TARGET_SOURCE_HINTS).sort(), ['fallback-group', 'last-session', 'parent']);
});

test('G-05 映射：显式绑定（空值）不提示，未知值不渲染且只告警一次', () => {
  const { fragment, recorded } = loadFragment();

  for (const emptyValue of [undefined, null, '', 0, {}, []]) {
    assert.equal(fragment.targetSourceHintOf(emptyValue), '', `${String(emptyValue)} 不该有提示`);
  }

  assert.equal(fragment.targetSourceHintOf('brand-new-source'), '');
  assert.equal(recorded.warnings.length, 1, '未知来源要告警（便于发现后端新增来源忘了同步文案）');
  assert.match(recorded.warnings[0], /brand-new-source/);
  // 同一个未知值只告警一次（warnOnce 语义），不能每次渲染都刷一条
  fragment.targetSourceHintOf('brand-new-source');
  assert.equal(recorded.warnings.length, 1);
});

test('G-05 卡片标记：带来源的行输出 span.req-source，显式绑定/未知来源整段不渲染', () => {
  const { fragment } = loadFragment();

  const parentBadge = fragment.renderTargetSourceBadge('parent');
  assert.match(parentBadge, /class="req-source"/);
  assert.match(parentBadge, /（继承父会话）/);

  // 显式绑定：不是"缺失字段"，所以连 span 都不出现（避免出现空标记或孤立分隔点）
  assert.equal(fragment.renderTargetSourceBadge(undefined), '');
  assert.equal(fragment.renderTargetSourceBadge(''), '');
  assert.equal(fragment.renderTargetSourceBadge('unknown-source'), '');
});
