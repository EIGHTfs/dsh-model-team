// 悬浮球判定优先级：低信息量的挂载不得覆盖高信息量的结论。
//
// 真机事实（B4b 诊断，2026-11-09）：桥被多次挂载，第一次挂载判出 ours（球应显示），
// 后续"没有 projection"的挂载把它依次改写成 unknown → degraded，最终态隐藏。
// 修法：判定按信息量分级 ours/other(2) > unknown(1) > degraded(0)，低级别不覆盖高级别。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const BRIDGE_SOURCE = await fs.readFile(new URL('../ui/js/interaction/session-bridge.js', import.meta.url), 'utf8');

function loadPriorityLayer() {
  // 只取判定相关的最小作用域：源码是普通分片（无 import），用 Function 求值后取函数
  return new Function(`${BRIDGE_SOURCE}
;return { evaluateDock, dockDecisionLevel, shouldApplyDockDecision };`)();
}

const bridge = loadPriorityLayer();

/** 模拟桥的 reportDockDecision 对显隐的影响（不碰 DOM） */
function createApplier() {
  let lastDecision = null;
  return {
    apply(result) {
      if (bridge.shouldApplyDockDecision(result.decision, lastDecision)) {
        lastDecision = result.decision;
      }
      return lastDecision;
    },
    get decision() { return lastDecision; },
  };
}

const META = { virtualModel: 'dsh-model-team', providerIds: ['dsh-model-team'] };
const OURS_SELECTION = { next: { provider: 'dsh-model-team', model: 'dsh-model-team' }, lastUsed: null };
const OTHER_SELECTION = { next: { provider: 'other', model: 'other-model' }, lastUsed: null };

test('信息量分级：ours/other > unknown > degraded', () => {
  assert.equal(bridge.dockDecisionLevel('ours'), 2);
  assert.equal(bridge.dockDecisionLevel('other'), 2);
  assert.equal(bridge.dockDecisionLevel('unknown'), 1);
  // unknown 与 degraded 同级：都表示"没有可用值"，差别只在日志；同级可互相更新
  assert.equal(bridge.dockDecisionLevel('degraded'), 1);
  assert.equal(bridge.dockDecisionLevel('未知值'), 1, '未知结论按"没有可用值"处理');
});

test('三次挂载 ours → unknown → degraded：最终仍是 ours（球保持显示）', () => {
  const applier = createApplier();

  applier.apply(bridge.evaluateDock({ selection: OURS_SELECTION, meta: META, projectionAvailable: true }));
  assert.equal(applier.decision, 'ours');

  // 无 projection 的挂载：selection 为空 → unknown，不得覆盖
  applier.apply(bridge.evaluateDock({ selection: undefined, meta: META, projectionAvailable: true }));
  assert.equal(applier.decision, 'ours', 'unknown 不得覆盖 ours');

  // 连通道都没有的挂载：degraded，同样不得覆盖
  applier.apply(bridge.evaluateDock({ selection: undefined, meta: META, projectionAvailable: false }));
  assert.equal(applier.decision, 'ours', 'degraded 不得覆盖 ours');
});

test('同级可覆盖：other → ours 必须更新为 ours', () => {
  const applier = createApplier();
  applier.apply(bridge.evaluateDock({ selection: OTHER_SELECTION, meta: META, projectionAvailable: true }));
  assert.equal(applier.decision, 'other');

  applier.apply(bridge.evaluateDock({ selection: OURS_SELECTION, meta: META, projectionAvailable: true }));
  assert.equal(applier.decision, 'ours', '同级（都有值）必须允许更新');
});

test('同级反向：ours → other 也必须更新（切走要能隐藏）', () => {
  const applier = createApplier();
  applier.apply(bridge.evaluateDock({ selection: OURS_SELECTION, meta: META, projectionAvailable: true }));
  assert.equal(applier.decision, 'ours');

  applier.apply(bridge.evaluateDock({ selection: OTHER_SELECTION, meta: META, projectionAvailable: true }));
  assert.equal(applier.decision, 'other', '切到别的模型必须能隐藏');
});

test('首个结论是低信息量时仍要生效（否则初始态无从落地）', () => {
  const applier = createApplier();
  applier.apply(bridge.evaluateDock({ selection: undefined, meta: null, projectionAvailable: false }));
  assert.equal(applier.decision, 'degraded');

  applier.apply(bridge.evaluateDock({ selection: OURS_SELECTION, meta: META, projectionAvailable: true }));
  assert.equal(applier.decision, 'ours', '高信息量可覆盖低信息量');
});

test('判定语义未变：provider/model 完全匹配才是 ours', () => {
  assert.equal(bridge.evaluateDock({ selection: OURS_SELECTION, meta: META, projectionAvailable: true }).decision, 'ours');
  assert.equal(bridge.evaluateDock({
    selection: { next: { provider: 'dsh-model-team', model: 'other-model' } }, meta: META, projectionAvailable: true,
  }).decision, 'other', 'model 不匹配 → other');
  assert.equal(bridge.evaluateDock({
    selection: { next: { provider: 'other', model: 'dsh-model-team' } }, meta: META, projectionAvailable: true,
  }).decision, 'other', 'provider 不匹配 → other');
});
