// 静态基线注入用例（G37-A）：
//   服务端：payload 来源与优先级、注入位置、`</script>` 转义、幂等；
//   客户端：有基线则初始 state 非空、网络全失败不清空、网络返回自定义则覆盖；
//   一致性：注入的 payload 与 /_team/platforms、/_team/drivers 的返回同源（同一份数据、同一个 listDrivers）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  buildBaselinePayload,
  injectBaselineIntoHtml,
  serializeBaselineForScript,
} from '../src/plugin/index-injection.js';
import { loadPlatformPresets } from '../src/gateway/config/platform-presets.js';
import { listDrivers } from '../src/gateway/drivers/index.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

// store 分片按构建顺序拼接后执行（与浏览器里同一份作用域）
const STORE_MODULE_FILES = [
  'view/messages.js', 'store/state.js', 'store/persist.js', 'store/events.js',
  'store/groups.js', 'store/chat.js', 'store/stats.js',
  'store/session.js', 'store/dispatch.js', 'store/index.js',
];
const STORE_SOURCE = (await Promise.all(STORE_MODULE_FILES.map(
  (fileName) => fs.readFile(new URL(`../ui/js/${fileName}`, import.meta.url), 'utf8'),
))).join('\n');

const BASELINE_FIXTURE = Object.freeze({
  platforms: [{ id: 'agnes', name: 'Agnes', baseURL: 'https://api.agnes-ai.cn/v1', driverId: 'openai-compatible' }],
  drivers: [{ id: 'openai-compatible', name: 'OpenAI 兼容', accessMode: 'official', authSchema: {} }],
});

function createStoreWith(apiStub) {
  globalThis.document = { documentElement: { dataset: {} } };
  const factory = new Function(`${STORE_SOURCE}
;return { createTeamStore: createTeamStore };`);
  return factory().createTeamStore({
    api: apiStub,
    storage: { read: () => null, write: () => {} },
    sessionSource: null,
    onRender: () => {},
  });
}

// 真实失败形态：apiJson 对 HTTP/网络失败不 reject，而是返回 null 并上报（见 foundation/api.js）
const FAILING_API = {
  getGroups: () => Promise.reject(new Error('groups down')),
  getDrivers: () => Promise.reject(new Error('drivers down')),
  getFriendGroups: () => Promise.reject(new Error('friend-groups down')),
  getPlatforms: () => Promise.resolve(null),
};

// ===== 服务端 payload =====

test('payload：内置平台（agnes）+ 驱动元数据齐全', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const payload = buildBaselinePayload({ dataRoot, logger: createRecordingLogger() });

  assert.equal(payload.platforms.some((platform) => platform.id === 'agnes'), true, '内置平台必须有 agnes');
  const driverIds = payload.drivers.map((driver) => driver.id);
  assert.equal(driverIds.includes('openai-compatible'), true, '驱动元数据必须有 openai-compatible');
  const driverMeta = payload.drivers.find((driver) => driver.id === 'openai-compatible');
  assert.deepEqual(Object.keys(driverMeta).sort(), ['accessMode', 'authSchema', 'id', 'name'], '只给元数据，不含实现');
});

test('payload：数据根 platforms.json 覆盖内置（用户自定义优先）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const customPlatforms = [{ id: 'my-platform', name: '自定义平台', baseURL: 'https://example.com/v1' }];
  await fs.writeFile(path.join(dataRoot, 'platforms.json'), JSON.stringify({ platforms: customPlatforms }), 'utf8');

  const payload = buildBaselinePayload({ dataRoot, logger: createRecordingLogger() });

  assert.equal(payload.platforms.length, 1);
  assert.equal(payload.platforms[0].id, 'my-platform');
  assert.equal(payload.platforms.some((platform) => platform.id === 'agnes'), false, '用户覆盖是整体替换');
});

test('payload：与 /_team/platforms、/_team/drivers 同源（两处不漂移）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();

  const payload = buildBaselinePayload({ dataRoot, logger });
  const endpointPlatforms = await loadPlatformPresets({ dataRoot, logger });

  assert.deepEqual(payload.platforms, endpointPlatforms, '注入的 platforms 必须与接口返回一致');
  assert.deepEqual(payload.drivers, listDrivers(), '注入的 drivers 必须与接口返回一致');
});

// ===== 服务端注入 =====

test('注入：插在 </head> 之前，且只插一次（幂等）', () => {
  const html = '<!doctype html><html><head><title>t</title></head><body>x</body></html>';

  const injected = injectBaselineIntoHtml(html, BASELINE_FIXTURE);
  const injectedAgain = injectBaselineIntoHtml(injected, BASELINE_FIXTURE);

  assert.equal(injected.includes('window.__DMT_BASELINE__'), true);
  assert.equal(injected.indexOf('window.__DMT_BASELINE__') < injected.indexOf('</head>'), true, '必须在 head 内');
  assert.equal(injected.indexOf('</head>') < injected.indexOf('<body>'), true);
  assert.equal(injectedAgain, injected, '重复注入必须字节不变');
  assert.equal(injected.split('window.__DMT_BASELINE__').length - 1, 1, '只能出现一次');
});

test('注入：平台名里的 </script> 被转义，不会提前闭合脚本', () => {
  const hostilePayload = {
    platforms: [{ id: 'evil', name: 'x</script><script>alert(1)</script>', baseURL: 'https://example.com' }],
    drivers: [],
  };
  const html = '<html><head></head><body></body></html>';

  const injected = injectBaselineIntoHtml(html, hostilePayload);
  const scriptBlock = injected.slice(injected.indexOf('<script>'), injected.indexOf('</script>') + '</script>'.length);

  assert.equal(scriptBlock.includes('</script><script>'), false, '危险的连续闭合必须已被转义');
  assert.equal(scriptBlock.includes('\\u003c'), true, '< 要转成 \\u003c');
  // 反向确认：把这段脚本当 JSON 解析回来，名字原样可还原
  const jsonText = scriptBlock.replace(/^<script>window\.__DMT_BASELINE__=/, '').replace(/;<\/script>$/, '');
  assert.equal(JSON.parse(jsonText).platforms[0].name, hostilePayload.platforms[0].name);
});

test('注入：\u2028 / \u2029 也被转义（否则脚本语法错误）', () => {
  const serialized = serializeBaselineForScript({ platforms: [{ id: 'p', name: 'a\u2028b\u2029c' }], drivers: [] });

  assert.equal(serialized.includes('\u2028'), false);
  assert.equal(serialized.includes('\u2029'), false);
  assert.equal(JSON.parse(serialized).platforms[0].name, 'a\u2028b\u2029c');
});

// ===== 客户端种子 =====

test('客户端：有基线时初始 state 非空（不依赖网络）', (t) => {
  globalThis.__DMT_BASELINE__ = BASELINE_FIXTURE;
  t.after(() => { delete globalThis.__DMT_BASELINE__; });

  // 构造后立刻读 state：还没有 dispatch 任何请求
  const store = createStoreWith(FAILING_API);
  const state = store.getState();

  assert.equal(state.platforms.length, 1, '打开加群弹窗前就应有平台项');
  assert.equal(state.platforms[0].id, 'agnes');
  assert.equal(state.drivers.length, 1, '驱动下拉同理');
});

test('客户端：网络全部失败 → platforms/drivers 仍是基线内容（不清空）', async (t) => {
  globalThis.__DMT_BASELINE__ = BASELINE_FIXTURE;
  t.after(() => { delete globalThis.__DMT_BASELINE__; });

  const store = createStoreWith(FAILING_API);
  await store.dispatch({ type: 'load-groups' });
  await store.dispatch({ type: 'refresh-platforms' });

  const state = store.getState();
  assert.equal(state.platforms.length, 1, '失败不许把基线清空');
  assert.equal(state.platforms[0].id, 'agnes');
  assert.equal(state.drivers.length, 1, 'drivers 同样保留基线');
});

test('客户端：网络返回自定义平台 → 覆盖基线（用户自定义优先）', async (t) => {
  globalThis.__DMT_BASELINE__ = BASELINE_FIXTURE;
  t.after(() => { delete globalThis.__DMT_BASELINE__; });

  const customPlatform = { id: 'custom-platform', name: '自定义', baseURL: 'https://example.com/v1' };
  const store = createStoreWith({
    ...FAILING_API,
    getPlatforms: () => Promise.resolve([customPlatform]),
  });
  await store.dispatch({ type: 'refresh-platforms' });

  const state = store.getState();
  assert.deepEqual(state.platforms, [customPlatform], '网络结果覆盖基线');
});
