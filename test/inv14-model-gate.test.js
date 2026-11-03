// INV-14 判定用例：客户端不再写死 provider / 模型名，判定依据来自 GET /_team/meta（契约 02 §3.8）。
// 加载方式与 test/rate.test.js 一致：直接执行 ui/js/session-bridge.js 文本，不引入框架与 DOM。
// 该分片依赖 warnOnce / api / applyDockDecision 三个外部符号（构建时由其它分片提供），
// 这里用最小的 globalThis 垫片把它们换成可观测的桩。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const BRIDGE_SOURCE = await fs.readFile(new URL('../ui/js/session-bridge.js', import.meta.url), 'utf8');
const CLIENT_SOURCE = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

// 每次加载都重新执行一遍源码：分片里的 meta 缓存是模块级的，用例之间不能互相污染
function loadBridge() {
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${BRIDGE_SOURCE}
;return {
  decideDock: decideDock,
  rememberDockInputs: rememberDockInputs,
  loadTeamMetaOnce: loadTeamMetaOnce,
  currentMetaInput: currentMetaInput
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

test('INV-14 判定⑥：meta 拉取失败 → degraded（显示 + 只告警一次，不重试）', async () => {
  const bridge = loadBridge();
  // 纯函数层：失败标记与"还没到"必须区分开
  assert.equal(bridge.decideDock({ selection: OURS_SELECTION, meta: { failed: true } }), 'degraded');
  assert.equal(bridge.decideDock({ selection: OURS_SELECTION, meta: null }), 'unknown');

  // 集成层：apiJson 把非 2xx / 网络异常都吞成 null，null 必须落到 degraded
  const recorded = installClientShims({ metaPayload: null });
  const loadingBridge = loadBridge();
  loadingBridge.rememberDockInputs(OURS_SELECTION, true);
  loadingBridge.loadTeamMetaOnce();
  loadingBridge.loadTeamMetaOnce();   // 第二次必须被"只取一次"挡住：不重试
  await flushPromises();

  assert.equal(recorded.metaRequests, 1, 'meta 只允许请求一次，失败后不重试');
  assert.deepEqual(recorded.decisions, ['degraded'], '失败必须把 degraded 下发（常显）');
  assert.equal(recorded.warnings.length, 1, '降级只告警一次');
  assert.deepEqual(loadingBridge.currentMetaInput(), { failed: true });
});

test('INV-14 判定⑦：meta 迟到 —— 先 unknown 后 ours（重算生效）', async () => {
  const recorded = installClientShims({ metaPayload: READY_META });
  const bridge = loadBridge();

  // 首帧：meta 还没到 → unknown（不显示）
  const firstDecision = bridge.rememberDockInputs(OURS_SELECTION, true);
  assert.equal(firstDecision, 'unknown');
  // 桥的 useEffect 在这里不会跑（测试不渲染 React），手动下发首帧结论
  globalThis.applyDockDecision(firstDecision);
  assert.deepEqual(recorded.decisions, ['unknown']);

  // meta 到达：selection 没变、React 不会重渲染，必须由重算入口补一次
  bridge.loadTeamMetaOnce();
  await flushPromises();

  assert.deepEqual(recorded.decisions, ['unknown', 'ours'], 'meta 到达必须重算并重新下发显隐');
});

test('INV-14 判定：宿主没有 useProjection → degraded（保持降级常显语义）', () => {
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
