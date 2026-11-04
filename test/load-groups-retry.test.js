// G-client-retry：启动加载（四接口并发）的有界重试。
//
// 为什么必须重试：启动那一刻宿主路由常还没就绪 / minihost 每请求 fork 冷启慢，
// 只要 `/groups` 那一次失败，state.groups 就永久为空，界面一直显示「0 个群」——
// 用户看到的不是错误，而是"确实没有群"，只能手动刷新。今天三次 ui 抖动都是它的表现。
//
// 重试口径（与 session-bridge 的 meta 重试同风格）：
//   · 只对**失败的接口**重拉，成功的那几份保留（绝不整体回滚）
//   · 500ms / 2000ms 两档退避，最多 3 轮；用尽后保留 lastGroupsError 让界面显示原因
//   · 调度器可注入：单测用同步调度跑完整条链，不真 sleep
//   · 不做定时轮询：只有"本轮有失败"才排下一轮

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const STORE_GROUPS_SOURCE = await fs.readFile(new URL('../ui/js/store-groups.js', import.meta.url), 'utf8');

// 最小依赖桩：state/broadcast/reportError/api 都可控
function createHarness({ api }) {
  const state = {
    groups: [],
    drivers: [],
    friendGroups: [],
    platforms: [],
    currentGroupId: null,
    lastGroupsError: null,
  };
  const broadcasts = [];
  const errors = [];
  const logs = [];
  const apiFailureSink = { groups: null };
  globalThis.console = Object.assign({}, console, { info: (line) => logs.push(line) });
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${STORE_GROUPS_SOURCE}
;return { createGroupLoaders: createGroupLoaders };`);
  const loaders = factory().createGroupLoaders({
    api,
    state,
    broadcast: (name, payload) => broadcasts.push({ name, payload }),
    reportError: (label, reason) => errors.push({ label, reason }),
    apiFailureSink,
  });
  // 同步调度器：把排队的重试立即执行，用例不必等真实 500ms/2000ms
  const scheduleCalls = [];
  const syncSchedule = (run, delayMs) => { scheduleCalls.push(delayMs); run(); };
  return { loaders, state, broadcasts, errors, logs, apiFailureSink, syncSchedule, scheduleCalls };
}

function buildApi(overrides) {
  const calls = { groups: 0, drivers: 0, friendGroups: 0, platforms: 0 };
  const api = {
    getGroups() { calls.groups += 1; return overrides.groups(calls.groups); },
    getDrivers() { calls.drivers += 1; return overrides.drivers(calls.drivers); },
    getFriendGroups() { calls.friendGroups += 1; return overrides.friendGroups(calls.friendGroups); },
    getPlatforms() { calls.platforms += 1; return overrides.platforms(calls.platforms); },
  };
  return { api, calls };
}

const GROUPS_OK = [{ id: 'g1', name: '群一' }];
const DRIVERS_OK = [{ id: 'd1', name: '驱动一' }];
const FRIEND_GROUPS_OK = { groups: [{ id: 'fg1', name: '分组一' }] };
const PLATFORMS_OK = [{ id: 'p1', name: '平台一' }];

test('G-client-retry-①：首个接口第一轮失败、第二轮成功 → 只重试 1 次且数据最终正确', async () => {
  const { api, calls } = buildApi({
    groups: (attempt) => (attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(GROUPS_OK)),
    drivers: () => Promise.resolve(DRIVERS_OK),
    friendGroups: () => Promise.resolve(FRIEND_GROUPS_OK),
    platforms: () => Promise.resolve(PLATFORMS_OK),
  });
  const harness = createHarness({ api });

  const groups = await harness.loaders.loadGroups({ schedule: harness.syncSchedule });

  assert.equal(calls.groups, 2, 'groups 接口应被重试一次');
  assert.equal(calls.drivers, 1, '成功的接口不该被重复请求');
  assert.deepEqual(groups, GROUPS_OK);
  assert.equal(harness.state.lastGroupsError, null, '成功后必须清空失败态');
  assert.deepEqual(harness.scheduleCalls, [500], '第一档退避是 500ms');
  assert.match(harness.logs.join('\n'), /\[groups\] 第 1 轮重试 ← groups/);
});

test('G-client-retry-②：三轮全失败（首次 + 两档重试）→ 不再重试并保留错误态', async () => {
  const { api, calls } = buildApi({
    groups: () => Promise.reject(new Error('always down')),
    drivers: () => Promise.resolve(DRIVERS_OK),
    friendGroups: () => Promise.resolve(FRIEND_GROUPS_OK),
    platforms: () => Promise.resolve(PLATFORMS_OK),
  });
  const harness = createHarness({ api });

  await harness.loaders.loadGroups({ schedule: harness.syncSchedule });

  // 首次 + 两档退避各重试一次 = 3 次请求（retryDelays 长度为 2，最多 2 轮重试）
  assert.equal(calls.groups, 3, `实际调用 ${calls.groups} 次`);
  assert.deepEqual(harness.scheduleCalls, [500, 2000], '两档退避各用一次');
  assert.ok(harness.state.lastGroupsError, '用尽后必须保留失败态供界面显示');
  assert.equal(harness.logs.filter((line) => line.includes('轮重试')).length, 2);
});

test('G-client-retry-③：重试期间成功接口的数据不被清空（不整体回滚）', async () => {
  const { api } = buildApi({
    // groups 一直失败；drivers/platforms 第一次就成功
    groups: () => Promise.reject(new Error('groups down')),
    drivers: () => Promise.resolve(DRIVERS_OK),
    friendGroups: () => Promise.resolve(FRIEND_GROUPS_OK),
    platforms: () => Promise.resolve(PLATFORMS_OK),
  });
  const harness = createHarness({ api });

  await harness.loaders.loadGroups({ schedule: harness.syncSchedule });

  assert.deepEqual(harness.state.drivers, DRIVERS_OK, 'drivers 必须保留第一轮的成功结果');
  assert.deepEqual(harness.state.platforms, PLATFORMS_OK);
  assert.deepEqual(harness.state.friendGroups, FRIEND_GROUPS_OK.groups);
  assert.ok(harness.state.lastGroupsError, '群列表本身失败要留错误态');
  // 每轮都广播过，界面能随成功项渐进更新
  assert.ok(harness.broadcasts.length >= 2);
});
