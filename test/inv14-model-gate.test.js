// INV-14 判定用例：客户端不再写死 provider / 模型名，判定依据来自 GET /_team/meta（契约 02 §3.8）。
// 加载方式与 test/rate.test.js 一致：直接执行 ui/js/session-bridge.js 文本，不引入框架与 DOM。
// 该分片依赖 warnOnce / api / applyDockDecision 三个外部符号（构建时由其它分片提供），
// 这里用最小的 globalThis 垫片把它们换成可观测的桩。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const BRIDGE_SOURCE = await fs.readFile(new URL('../ui/js/interaction/session-bridge.js', import.meta.url), 'utf8');
// 取值通道已抽成适配层（model-selection-source.js）：真实 bundle 里同作用域，测试也要拼起来执行
const SOURCE_LAYER_SOURCE = await fs.readFile(new URL('../ui/js/interaction/model-selection-source.js', import.meta.url), 'utf8');
const CLIENT_SOURCE = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

// 每次加载都重新执行一遍源码：分片里的 meta 缓存是模块级的，用例之间不能互相污染
function loadBridge() {
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${SOURCE_LAYER_SOURCE}
${BRIDGE_SOURCE}
;return {
  decideDock: decideDock,
  rememberDockInputs: rememberDockInputs,
  loadTeamMetaWithRetry: loadTeamMetaWithRetry,
  currentMetaInput: currentMetaInput,
  subscribeModelSelection: subscribeModelSelection
};`);
  return factory();
}

// 最小客户端垫片：记录判定下发、告警与 meta 请求次数
function installClientShims({ metaPayload } = {}) {
  const recordedDecisions = [];
  const recordedWarnings = [];
  const recorded = { decisions: recordedDecisions, warnings: recordedWarnings, metaRequests: 0 };
  globalThis.warnOnce = (label) => { recordedWarnings.push(label); };
  globalThis.applyDockDecision = (decision) => { recordedDecisions.push(decision); };
  globalThis.api = {
    getMeta() {
      recorded.metaRequests += 1;
      return Promise.resolve(metaPayload === undefined ? null : metaPayload);
    },
  };
  return recorded;
}

// 让 api.getMeta 的 then 链跑完
function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

const READY_META = { virtualModel: 'dsh-model-team', providerIds: ['dsh-model-team'] };
const OURS_SELECTION = { next: { provider: 'dsh-model-team', model: 'dsh-model-team' } };
// 别人家的模型：provider 与 model 都对不上 /_team/meta
const OTHER_SELECTION = { next: { provider: 'deepseek', model: 'deepseek-v4' } };

test('INV-14 判定①：selection 无值 → unknown（不显示，且不抛错）', () => {
  const bridge = loadBridge();

  assert.equal(bridge.decideDock({ selection: undefined, meta: READY_META }), 'unknown');
  assert.equal(bridge.decideDock({ selection: null, meta: READY_META }), 'unknown');
  assert.equal(bridge.decideDock({ selection: {}, meta: READY_META }), 'unknown');
  assert.equal(bridge.decideDock({ selection: { next: null, lastUsed: null }, meta: READY_META }), 'unknown');
  assert.equal(bridge.decideDock({}), 'unknown', '入参整个缺失也必须是 unknown 而不是抛错');
});

test('INV-14 判定②：meta 未到 → unknown（先不显示）', () => {
  const bridge = loadBridge();

  assert.equal(bridge.decideDock({ selection: OURS_SELECTION, meta: null }), 'unknown');
  assert.equal(bridge.decideDock({ selection: OURS_SELECTION }), 'unknown', 'meta 缺省等于"还没到"');
  assert.equal(bridge.currentMetaInput(), null, '加载中的 meta 入参必须是 null');
});

test('INV-14 判定③：provider 命中 + model 命中 → ours', () => {
  const bridge = loadBridge();

  assert.equal(bridge.decideDock({ selection: OURS_SELECTION, meta: READY_META }), 'ours');
  // lastUsed 是 next 的回落，同样要认
  assert.equal(
    bridge.decideDock({ selection: { lastUsed: { provider: 'dsh-model-team', model: 'dsh-model-team' } }, meta: READY_META }),
    'ours',
  );
  // 部署方自定义：虚拟模型名与路由名都不是缺省值，判定必须跟着 meta 走
  assert.equal(
    bridge.decideDock({
      selection: { next: { provider: 'team-b', model: 'team-virtual' } },
      meta: { virtualModel: 'team-virtual', providerIds: ['team-a', 'team-b'] },
    }),
    'ours',
  );
});

test('INV-14 判定④：model 不同 → other（同 provider）', () => {
  const bridge = loadBridge();

  assert.equal(
    bridge.decideDock({ selection: { next: { provider: 'dsh-model-team', model: 'agnes-3.0-flash' } }, meta: READY_META }),
    'other',
  );
});

test('INV-14 判定⑤：同 model 不同 provider → other', () => {
  const bridge = loadBridge();

  assert.equal(
    bridge.decideDock({ selection: { next: { provider: 'other-provider', model: 'dsh-model-team' } }, meta: READY_META }),
    'other',
  );
});

test('INV-14 判定⑥：meta 三档重试仍失败 → degraded（隐藏由显示口径决定）', async () => {
  const bridge = loadBridge();
  // 纯函数层：失败标记与"还没到"必须区分开
  assert.equal(bridge.decideDock({ selection: OURS_SELECTION, meta: { failed: true } }), 'degraded');
  assert.equal(bridge.decideDock({ selection: OURS_SELECTION, meta: null }), 'unknown');

  // 集成层：apiJson 把非 2xx / 网络异常都吞成 null，null 必须走有限重试，用尽后判不可知
  const recorded = installClientShims({ metaPayload: null });
  const loadingBridge = loadBridge();
  loadingBridge.rememberDockInputs(OURS_SELECTION, true);
  // schedule 换成同步执行：整条重试链在同一个 tick 里跑完，用例不必真等 7.5 秒
  loadingBridge.loadTeamMetaWithRetry({ retryDelays: [0, 0, 0], schedule: (run) => run() });
  loadingBridge.loadTeamMetaWithRetry({ retryDelays: [0, 0, 0], schedule: (run) => run() });  // 第二次被「只取一次」挡住
  await flushPromises();

  assert.equal(recorded.metaRequests, 4, '首次 + 三档重试，之后不再请求（不轮询）');
  // 断言「最后一次结论」而不是整个数组：中途一定会有一次 unknown（meta 还没到时的首帧判定），
  // 那不属于本用例要守的行为；要守的是「重试用尽后落到 degraded」
  assert.equal(recorded.decisions[recorded.decisions.length - 1], 'degraded', '用尽后下发 degraded（隐藏由 dock.js 口径决定）');
  assert.equal(recorded.warnings.length, 1, '用尽只告警一次，不刷屏');
  assert.deepEqual(loadingBridge.currentMetaInput(), { failed: true });
});

test('INV-14 判定⑦：meta 迟到 —— 先 unknown 后 ours（重算生效）', async () => {
  const recorded = installClientShims({ metaPayload: READY_META });
  const bridge = loadBridge();

  // 首帧：meta 还没到 → unknown（不显示）
  const firstDecision = bridge.rememberDockInputs(OURS_SELECTION, true);
  assert.equal(firstDecision, 'unknown');
  // G-dock A 之后，rememberDockInputs 自己就会把结论下发（含日志），这里不用再手动补一次
  assert.deepEqual(recorded.decisions, ['unknown']);

  // meta 到达：selection 没变、React 不会重渲染，必须由重算入口补一次
  bridge.loadTeamMetaWithRetry({ retryDelays: [0, 0, 0], schedule: (run) => run() });
  await flushPromises();

  assert.equal(recorded.decisions[recorded.decisions.length - 1], 'ours', 'meta 到达后必须重算成 ours');
});

test('INV-14 判定：宿主没有 useProjection → degraded（判不了，按新口径隐藏）', () => {
  const bridge = loadBridge();

  // 没有 projection 时连 selection 都取不到，不能被"selection 无值"误判成 unknown（那样球永远不显示）
  assert.equal(bridge.decideDock({ selection: undefined, meta: null, projectionAvailable: false }), 'degraded');
  assert.equal(bridge.decideDock({ selection: OURS_SELECTION, meta: READY_META, projectionAvailable: false }), 'degraded');
});

test('INV-14 回归守卫：客户端产物里不能再有写死的判定常量', () => {
  // 旧实现用 OUR_PROVIDER_ID / VIRTUAL_MODEL_ID 比对，部署方改配置后球永远不显示；
  // 这里守住"不许再加回来"，判定只能走 decideDock + /_team/meta。
  assert.equal(/OUR_PROVIDER_ID|VIRTUAL_MODEL_ID/.test(CLIENT_SOURCE), false);
  assert.match(BRIDGE_SOURCE, /function decideDock\(/);
  assert.match(CLIENT_SOURCE, /getMeta: function \(\)/);
});

// G-15 回归：宿主不重渲染时，也必须靠订阅 projection face 感知 modelSelection 变化。
// 造一个可选 emit 的假 face，等价于宿主 session.projections.faceOf(key)。
function createFakeProjectionSession(initialSelection) {
  const listeners = [];
  const snapshot = { value: initialSelection };
  const face = {
    getSnapshot: () => snapshot.value,
    subscribe: (callback) => {
      listeners.push(callback);
      return () => { listeners.splice(listeners.indexOf(callback), 1); };
    },
  };
  const session = { sessionId: 'fake-session', projections: { faceOf: () => face } };
  const emit = (nextSelection) => {
    snapshot.value = nextSelection;
    listeners.forEach((callback) => callback());
  };
  return { session, emit, listenerCount: () => listeners.length };
}

test('G-15：selection 变化但不触发组件重渲染 → 判定仍要更新（订阅驱动）', async () => {
  const bridge = loadBridge();
  const recorded = installClientShims({ metaPayload: READY_META });
  // 先把 meta 拉到 ready：否则判定是 unknown（还没到），验不出 selection 的作用
  bridge.loadTeamMetaWithRetry({ retryDelays: [0, 0, 0], schedule: (run) => run() });
  await flushPromises();
  const fake = createFakeProjectionSession(OURS_SELECTION);
  const decisions = [];
  let latestSelection;

  const unsubscribe = bridge.subscribeModelSelection({
    session: fake.session,
    key: 'modelSelection',
    onChange: (selection) => {
      latestSelection = selection;
      decisions.push(bridge.rememberDockInputs(selection, true));
    },
  });

  assert.equal(typeof unsubscribe, 'function');
  assert.equal(fake.listenerCount(), 1, '必须真的订阅宿主的 projection face');

  // 只 emit，不重渲染组件
  fake.emit(OTHER_SELECTION);
  fake.emit(OURS_SELECTION);

  // G-dock A：订阅成功后立刻用快照回调一次（消除「事件发生在订阅之前」的窗口），
  // 所以这里先有 1 次 ours（订阅瞬间的当前值），随后才是 other / ours
  assert.equal(recorded.decisions[0], 'ours', '订阅瞬间必须补发一次当前判定');
  assert.deepEqual(decisions.slice(-2), ['other', 'ours'], '隐藏后切回 ours 必须重新判定为显示');
  assert.equal(latestSelection, OURS_SELECTION);

  unsubscribe();
  assert.equal(fake.listenerCount(), 0, '退订后不能再收到回调');
});

test('G-15：宿主没提供 projections face → 返回 null（退回渲染期取值，不抛错）', () => {
  const bridge = loadBridge();
  installClientShims({ metaPayload: READY_META });

  assert.equal(bridge.subscribeModelSelection({ session: null, key: 'modelSelection', onChange: () => {} }), null);
  assert.equal(bridge.subscribeModelSelection({ session: {}, key: 'modelSelection', onChange: () => {} }), null);
  // faceOf 抛错也不能把桥打挂
  const throwingSession = { projections: { faceOf: () => { throw new Error('face broken'); } } };
  assert.equal(bridge.subscribeModelSelection({ session: throwingSession, key: 'modelSelection', onChange: () => {} }), null);
});
