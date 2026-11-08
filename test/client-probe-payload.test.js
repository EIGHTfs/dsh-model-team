// 「获取可用模型」请求体的构造：**必须按当前选中的驱动分流**。
//
// 事故背景（实测）：加群页下拉有两类值——`preset:<平台id>`（平台预置）与 `driver:<驱动id>`（通用驱动入口）。
// 反代走后者，没有平台预置。旧实现只查 platforms 表，找不到就回落到 platforms[0]，
// 于是点「获取可用模型」会把请求发去第一个平台（Agnes）并带上空 apiKey，
// 服务端/上游回 401 → 界面显示「凭证无效或缺失，请检查 API Key」。
// 用户看到的是"凭据问题"，真实原因是"探测打错了平台"。
//
// 这里直接执行 model-catalog.js 文本（与客户端同样的代码），只取纯函数部分做断言。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const source = await fsp.readFile(new URL('../ui/js/view/model-catalog.js', import.meta.url), 'utf8');

// 只放纯函数需要的垫片：文件顶层没有立即执行的逻辑，取到导出即可
function loadProbeHelpers() {
  const factory = new Function(`${source}
    return { buildProbePayload: buildProbePayload, isAccountAuthDriver: isAccountAuthDriver };`);
  return factory();
}

const helpers = loadProbeHelpers();

const REVERSE_DRIVER = Object.freeze({
  id: 'reverse-qoder',
  name: 'Qoder',
  accessMode: 'reverse',
  authKind: 'reverse-account',
  platformId: 'qoder'
});

const OFFICIAL_PLATFORM = Object.freeze({
  id: 'agnes',
  name: 'Agnes',
  driverId: 'openai-compatible',
  baseURL: 'https://api.example.invalid/v1',
  modelsEndpoint: '/models'
});

const OFFICIAL_DRIVER = Object.freeze({ id: 'openai-compatible', authKind: 'api-key' });

test('账号型驱动：请求体用驱动 id + 账号引用，且不带 baseURL / apiKey', () => {
  const built = helpers.buildProbePayload(
    { platform: null, driver: REVERSE_DRIVER },
    { baseURL: '', apiKey: '' },
    'account-1'
  );
  assert.equal(built.error, undefined);
  assert.deepEqual(built.payload, {
    driverId: 'reverse-qoder',
    apiKeyRef: 'account:qoder/account-1'
  });
  assert.equal('baseURL' in built.payload, false, '账号型驱动不需要地址');
  assert.equal('apiKey' in built.payload, false, '账号型驱动不需要 Key');
});

test('账号型驱动：未选账号时明确报错，不发请求', () => {
  const built = helpers.buildProbePayload({ platform: null, driver: REVERSE_DRIVER }, {}, '');
  assert.match(built.error, /请先登录/);
  assert.equal(built.payload, undefined);
});

test('账号型驱动：不会沿用其它平台的地址与 Key（旧实现就错在这）', () => {
  const built = helpers.buildProbePayload(
    { platform: null, driver: REVERSE_DRIVER },
    { baseURL: 'https://api.agnes-ai.cn/v1', apiKey: '' },
    'account-1'
  );
  assert.equal(built.payload.baseURL, undefined);
  assert.equal(built.payload.apiKey, undefined);
});

test('配置型驱动：保持旧行为（driverId 取平台、带 baseURL 与 apiKey）', () => {
  const built = helpers.buildProbePayload(
    { platform: OFFICIAL_PLATFORM, driver: OFFICIAL_DRIVER },
    { baseURL: '', apiKey: 'sk-test' },
    ''
  );
  assert.deepEqual(built.payload, {
    driverId: 'openai-compatible',
    baseURL: OFFICIAL_PLATFORM.baseURL,
    modelsEndpoint: '/models',
    apiKey: 'sk-test'
  });
});

test('配置型驱动：没有地址时仍要求先填（旧行为不变）', () => {
  const built = helpers.buildProbePayload(
    { platform: null, driver: OFFICIAL_DRIVER },
    { baseURL: '', apiKey: 'sk-test' },
    ''
  );
  assert.match(built.error, /API 地址/);
});
