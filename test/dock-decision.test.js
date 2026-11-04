// G-dock：悬浮球判定（INV-14）的纯逻辑用例。
//
// 为什么单测这层：失败只在真机上表现为"球该显示时不见 / 不该显示时常显"，
// 而 minihost 预览环境拿不到宿主的 projection，真渲染门禁测不到判定本身。
//
// 三个源码片段的加载方式都沿用仓里既有做法：直接执行分片文本 + 最小 globalThis 垫片。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const BRIDGE_SOURCE = await fs.readFile(new URL('../ui/js/session-bridge.js', import.meta.url), 'utf8');
const DOCK_SOURCE = await fs.readFile(new URL('../lib/client-parts/dock.js', import.meta.url), 'utf8');

const READY_META = { virtualModel: 'dsh-model-team', providerIds: ['dsh-model-team'] };
const OURS_SELECTION = { next: { provider: 'dsh-model-team', model: 'dsh-model-team' } };

function installShims() {
  const decisions = [];
  const logs = [];
  globalThis.warnOnce = () => {};
  globalThis.applyDockDecision = (decision) => { decisions.push(decision); };
  globalThis.console = Object.assign({}, console, {
    info: (line) => { logs.push(line); },
  });
  return { decisions, logs };
}

// 每次加载都重新执行：分片里的 meta 缓存是模块级的，用例之间不能互相污染
function loadBridge() {
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${BRIDGE_SOURCE}
;return {
  decideDock: decideDock,
  evaluateDock: evaluateDock,
  rememberDockInputs: rememberDockInputs,
  loadTeamMetaWithRetry: loadTeamMetaWithRetry,
  subscribeModelSelection: subscribeModelSelection,
  currentMetaInput: currentMetaInput
};`);
  return factory();
}

function loadVisibilityRule() {
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${DOCK_SOURCE}
;return { isDockVisibleForDecision: isDockVisibleForDecision };`);
  return factory();
}

// 让 Promise 链与"同步 schedule"跑完
async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('G-dock-①：订阅前就已有值 → 订阅后立即回调并判定 ours（球要显示）', () => {
  const shims = installShims();
  const bridge = loadBridge();
  let callbackCount = 0;
  let received = null;

  // 模拟宿主 projection face：值在订阅之前就已存在，且之后不再有任何变化事件
  const face = {
    subscribe(handler) { this.handler = handler; return () => {}; },
    getSnapshot() { return OURS_SELECTION; },
  };
  const unsubscribe = bridge.subscribeModelSelection({
    session: { projections: { faceOf: () => face } },
    key: 'modelSelection',
    onChange(selection) {
      callbackCount += 1;
      received = selection;
      // 与真实桥一致：拿到值立刻判定并下发
      globalThis.applyDockDecision(bridge.decideDock({ selection, meta: READY_META, projectionAvailable: true }));
    },
  });

  assert.equal(typeof unsubscribe, 'function');
  assert.equal(callbackCount, 1, '订阅成功后必须立刻用快照回调一次');
  assert.deepEqual(received, OURS_SELECTION);
  assert.deepEqual(shims.decisions, ['ours']);
});

test('G-dock-②：meta 连续四次（首次 + 三档重试）都失败 → 判定 degraded，显示口径为隐藏', () => {
  const shims = installShims();
  const bridge = loadBridge();
  const visibility = loadVisibilityRule();
  let requests = 0;
  globalThis.api = { getMeta: () => { requests += 1; return Promise.resolve(null); } };

  // 先模拟"桥已渲染过一帧"：没有这步，重算入口会认为没有输入可算（真实里桥总是先渲染）
  bridge.rememberDockInputs(OURS_SELECTION, true);
  // schedule 换成同步执行：整条重试链在同一个 tick 内跑完，用例不必等真实时间
  bridge.loadTeamMetaWithRetry({ retryDelays: [0, 0, 0], schedule: (run) => run() });
  return flushMicrotasks().then(() => {
    assert.equal(requests, 4, '首次 1 次 + 三档重试 3 次');
    const decision = bridge.decideDock({ selection: OURS_SELECTION, meta: bridge.currentMetaInput() });
    assert.equal(decision, 'degraded', '重试用尽仍不可用 → 不可知');
    assert.equal(visibility.isDockVisibleForDecision(decision), false, '不可知必须隐藏');
    assert.ok(shims.decisions.includes('degraded'));
  });
});

test('G-dock-③：第一次失败、第二次成功 → meta 就绪，判定 ours（球显示）', () => {
  installShims();
  const bridge = loadBridge();
  let requests = 0;
  globalThis.api = {
    getMeta() {
      requests += 1;
      return Promise.resolve(requests === 1 ? null : READY_META);
    },
  };

  bridge.loadTeamMetaWithRetry({ retryDelays: [0, 0, 0], schedule: (run) => run() });
  return flushMicrotasks().then(() => {
    assert.equal(requests, 2, '第一次失败后立刻重试，第二次成功即停');
    assert.equal(bridge.decideDock({ selection: OURS_SELECTION, meta: bridge.currentMetaInput() }), 'ours');
  });
});

test('G-dock-④：宿主没有 useProjection（projectionAvailable=false）→ degraded 且隐藏', () => {
  installShims();
  const bridge = loadBridge();
  const visibility = loadVisibilityRule();

  const decision = bridge.decideDock({ selection: OURS_SELECTION, meta: READY_META, projectionAvailable: false });
  assert.equal(decision, 'degraded');
  assert.equal(visibility.isDockVisibleForDecision(decision), false);
  // 顺带钉住显示口径：只有 ours 才可见
  assert.equal(visibility.isDockVisibleForDecision('ours'), true);
  assert.equal(visibility.isDockVisibleForDecision('other'), false);
  assert.equal(visibility.isDockVisibleForDecision('unknown'), false);
});

test('G-dock-⑤：判定日志只在结论变化时打印，且每行都带 reason', () => {
  const shims = installShims();
  const bridge = loadBridge();
  globalThis.api = { getMeta: () => Promise.resolve(READY_META) };

  bridge.loadTeamMetaWithRetry({ retryDelays: [0], schedule: (run) => run() });
  return flushMicrotasks().then(() => {
    // 同一份输入连续记两次：第二次结论没变，不应再打日志
    bridge.rememberDockInputs(OURS_SELECTION, true);
    bridge.rememberDockInputs(OURS_SELECTION, true);
    const dockLines = shims.logs.filter((line) => line.startsWith('[dock] '));
    assert.equal(dockLines.length, 1, '结论没变不刷屏');
    assert.match(dockLines[0], /^\[dock\] ours ← projection=dsh-model-team$/);
  });
});

