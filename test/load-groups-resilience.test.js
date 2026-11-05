// G-regression：群列表"接口有数据、界面空"。
// 断链有两处必须先被单测钉住：
//   ① loadGroups 用 Promise.all，任一接口失败就把四份数据全丢掉 → 群列表变空；
//   ② apiJson 把 HTTP 非 2xx / JSON 解析失败 / 网络异常一律吞成 null，界面看不出"加载失败"。
// 这两个文件都是分片（不是 ES 模块），这里用 new Function 执行源码 + 垫片。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// store 已拆成装配层 + 6 个模块：单测要按构建顺序拼起来执行，等价于浏览器里的同一份作用域
// messages.js 提供 buildMessages / formatMessageTime（构建时排在 store 之前），
// 少了它 loadChat 会抛 ReferenceError——所以按构建顺序一起拼。
const STORE_MODULE_FILES = [
  'view/messages.js', 'store/state.js', 'store/persist.js', 'store/events.js',
  'store/groups.js', 'store/chat.js', 'store/stats.js',
  'store/session.js', 'store/dispatch.js', 'store/index.js',
];
const STORE_SOURCE = (await Promise.all(STORE_MODULE_FILES.map(
  (fileName) => fs.readFile(new URL(`../ui/js/${fileName}`, import.meta.url), 'utf8'),
))).join('\n');
const API_SOURCE = await fs.readFile(new URL('../lib/client-parts/foundation/api.js', import.meta.url), 'utf8');
const RENDER_SOURCE = await fs.readFile(new URL('../ui/js/view/render.js', import.meta.url), 'utf8');

const THREE_GROUPS = [
  { id: 'agnes', name: 'agnes', driver: 'openai-compatible', summary: '官方接入' },
  { id: 'agnes2', name: 'agnes2', driver: 'openai-compatible', summary: '官方接入' },
  { id: 'sa6400', name: 'sa6400', driver: 'openai-compatible', summary: '—' },
];

/** 造一个 store：只关心 loadGroups 的行为，持久化与渲染都用空实现 */
function createStoreWith(apiStub) {
  // store 里的 reportError 会写 document.documentElement.dataset；Node 里给最小垫片
  globalThis.document = { documentElement: { dataset: {} } };
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${STORE_SOURCE}
;return { createTeamStore: createTeamStore };`);
  const store = factory().createTeamStore({
    api: apiStub,
    storage: { read: () => null, write: () => {} },
    sessionSource: null,
    onRender: () => {},
  });
  return store;
}

test('回归①：四个接口里有一个 reject，其它三份数据仍要进 state（不许一败全清）', async () => {
  const store = createStoreWith({
    getGroups: () => Promise.resolve(THREE_GROUPS),
    // drivers 挂掉：真实事故里最可能的一块（它只是驱动元信息，不该拖垮群列表）
    getDrivers: () => Promise.reject(new Error('drivers 500')),
    getFriendGroups: () => Promise.resolve({ groups: [{ id: 'g1', name: '强模型组', members: [] }] }),
    getPlatforms: () => Promise.resolve([{ id: 'agnes', name: 'Agnes' }]),
  });

  await store.dispatch({ type: 'load-groups' });

  const state = store.getState();
  assert.equal(state.groups.length, 3, '群列表必须保留，不能因为 drivers 失败被清空');
  assert.equal(state.currentGroupId, 'agnes', '首个群应被选为当前群');
  assert.equal(state.friendGroups.length, 1, '分组数据照常进入 state');
  assert.equal(state.platforms.length, 1, '平台预置照常进入 state');
  assert.equal(state.lastGroupsError, null, '群接口本身成功 → 不算群列表加载失败');
  assert.equal(state.errors.length >= 1, true, '失败必须被记录（state.errors 可见）');
});

test('回归①：群接口失败 → 记录 lastGroupsError，且不覆盖已有群数据', async () => {
  const store = createStoreWith({
    getGroups: () => Promise.reject(new Error('groups 502')),
    getDrivers: () => Promise.resolve([{ id: 'openai-compatible', name: 'OpenAI 兼容' }]),
    getFriendGroups: () => Promise.resolve({ groups: [] }),
    getPlatforms: () => Promise.resolve([]),
  });

  await store.dispatch({ type: 'load-groups' });

  const state = store.getState();
  assert.equal(state.groups.length, 0, '失败时保持空数组（而不是塞 undefined）');
  assert.match(String(state.lastGroupsError), /groups 502/, '失败原因要落到 state，界面才能区分"失败"与"空"');
  assert.equal(state.drivers.length, 1, '其它接口成功时照常写入');
});

test('回归②：apiJson 三类失败都要上报原因（HTTP / JSON / 网络），不许静默 null', async () => {
  const failures = [];
  globalThis.API_PREFIX = '/_team';
  globalThis.API_TIMEOUT_MS = 5000;
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${API_SOURCE}
;return { apiJson: apiJson, apiSetErrorReporter: apiSetErrorReporter };`);
  const layer = factory();
  layer.apiSetErrorReporter((failure) => failures.push(failure));

  globalThis.fetch = () => Promise.resolve({ ok: false, status: 503 });
  assert.equal(await layer.apiJson('/groups'), null);

  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('bad json')) });
  assert.equal(await layer.apiJson('/groups'), null);

  globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED'));
  assert.equal(await layer.apiJson('/groups'), null);

  assert.deepEqual(failures.map((failure) => failure.kind), ['http-status', 'json-parse', 'network']);
  assert.match(failures[0].detail, /503/);
});

test('回归③：群列表空 + 有失败原因 → 渲染"加载失败"，不许显示"0 个群"', () => {
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${RENDER_SOURCE}
;return { renderGroupList: renderGroupList };`);
  const render = factory();

  const failedHtml = render.renderGroupList([], null, '', { loadError: 'groups 502' });
  assert.match(failedHtml, /加载失败/, '空列表 + 失败原因必须显式提示');
  assert.match(failedHtml, /btnReloadGroups/, '要给出可点的重试入口');
  assert.equal(failedHtml.includes('0 个群'), false, '失败态不能伪装成"确实没有数据"');
  assert.equal(failedHtml.includes('groups 502'), true, '失败原因要展示出来');

  // 正常空数据（没有失败原因）仍显示 0 个群：两种状态必须可区分
  const emptyHtml = render.renderGroupList([], null, '', {});
  assert.equal(emptyHtml.includes('0 个群'), true);
  assert.equal(emptyHtml.includes('加载失败'), false);

  // 有数据时照常渲染，且驱动列用 group.driver
  const filledHtml = render.renderGroupList(THREE_GROUPS, 'agnes', '', {});
  assert.equal((filledHtml.match(/class="group-item/g) || []).length, 3);
  assert.match(filledHtml, /openai-compatible/);
});

test('回归①（真实链路）：/groups 返回 500 → apiJson 吞成 null，但 state 仍要标出加载失败', async () => {
  // 这条覆盖最隐蔽的一层：apiJson 对 500 只上报不 reject，所以"Promise 成功但值是 null"。
  // 只看 Promise 状态会把它当成"确实没有群"，界面继续显示「0 个群」（真机就是这样）。
  globalThis.API_PREFIX = '/_team';
  globalThis.API_TIMEOUT_MS = 5000;
  globalThis.document = { documentElement: { dataset: {} } };
  globalThis.fetch = (url) => {
    if (String(url).endsWith('/groups')) return Promise.resolve({ ok: false, status: 500 });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
  };
  // api.js 与 store.js 必须在**同一作用域**里求值：store 通过 apiSetErrorReporter 注册上报通道，
  // 分成两个 new Function 会各自持有一份函数，store 永远看不到 api 的实现（也就收不到失败）。
  // eslint-disable-next-line no-new-func
  const combinedFactory = new Function(`${API_SOURCE}
${STORE_SOURCE}
;return { apiJson: apiJson, apiSetErrorReporter: apiSetErrorReporter, createTeamStore: createTeamStore };`);
  const apiLayer = combinedFactory();
  const store = apiLayer.createTeamStore({
    // 直接复用真实 apiJson，让 500 → null → 上报 这条链路原样跑一遍
    api: {
      getGroups: () => apiLayer.apiJson('/groups'),
      getDrivers: () => Promise.resolve([{ id: 'openai-compatible', name: 'OpenAI 兼容' }]),
      getFriendGroups: () => Promise.resolve({ groups: [] }),
      getPlatforms: () => Promise.resolve([]),
    },
    storage: { read: () => null, write: () => {} },
    sessionSource: null,
    onRender: () => {},
  });

  await store.dispatch({ type: 'load-groups' });

  const state = store.getState();
  assert.equal(state.groups.length, 0);
  assert.match(String(state.lastGroupsError), /500/, 'HTTP 500 必须落到 lastGroupsError（界面才有"加载失败"可显示）');
  assert.equal(state.drivers.length, 1, 'drivers 成功时照常写入，不受 /groups 失败影响');
});

test('G-B：群友数区分「未加载」与「确实 0 个」（未加载显示 —，加载后 0 就显示 0）', () => {
  // eslint-disable-next-line no-new-func
  const render = new Function(`${RENDER_SOURCE}
;return { renderChat: renderChat };`)();
  const group = { id: 'agnes', name: 'agnes' };

  // 未加载 / 加载失败：必须显示 —（否则"未知"被当成 0，就是 G-13 那个坑）
  assert.match(render.renderChat(group, [], [], null, 'loading'), /\[群友: —\]/);
  assert.match(render.renderChat(group, [], [], null, 'error'), /\[群友: —\]/);

  // 已加载且确实 0 个：显示 0
  assert.match(render.renderChat(group, [], [], null, 'loaded'), /\[群友: 0\]/);

  // 已加载 N 个：显示 N
  const models = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.match(render.renderChat(group, models, [], null, 'loaded'), /\[群友: 3\]/);

  // 缺省（老调用方不传状态）：按已加载处理，保持既有行为
  assert.match(render.renderChat(group, models, [], null, undefined), /\[群友: 3\]/);
});

test('G-B：loadChat 会把每个群的加载状态写进 modelsStatus（loading → loaded / error）', async () => {
  const store = createStoreWith({
    getGroups: () => Promise.resolve(THREE_GROUPS),
    getDrivers: () => Promise.resolve([]),
    getFriendGroups: () => Promise.resolve({ groups: [] }),
    getPlatforms: () => Promise.resolve([]),
    getSessionStats: () => Promise.resolve({ rows: [] }),
    getGroupModels: () => Promise.resolve([{ id: 'm1' }]),
    getSessionEvents: () => Promise.resolve({ events: [] }),
  });

  const loading = store.dispatch({ type: 'load-chat', groupId: 'agnes' });
  // 同步阶段就应标成 loading（渲染这一刻还拿不到结果）
  assert.equal(store.getState().modelsStatus.agnes, 'loading');
  await loading;
  assert.equal(store.getState().modelsStatus.agnes, 'loaded');
  assert.equal(store.getState().models.agnes.length, 1);
});
