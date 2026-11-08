// Qoder 登录的**成套不变量**：授权站 + client_id + redirect_uri + UA 属于同一套客户端身份。
//
// 真实故障（2026-11-08）：我们把两套 CN 配置混用了 —— 授权站取 A 家、client_id 取 B 家，
// 现象是浏览器在授权页显示「登录成功」，插件却一直 pending（轮询 404）直到超时。
// 两套参考配置各自成套：
//   · Python  CN：网站 qoder.com.cn / client_id 1c5e33e1… / redirect_uri qoder-work-cn:// / UA QoderWork
//   · providers CN：authBase qoder.cn / client_id 732aef47… / 不带 redirect_uri / UA qoder/1.0.0
// 这条用例钉死「profile 自带 authBase 与 UA」，切换 profile 就是成套切换。

import assert from 'node:assert/strict';
import test from 'node:test';

import { platform, resolveLoginProfile } from '../src/reverse/platforms/qoder/index.js';
import { buildAuthUrl, buildPollUrl, createDeviceSession } from '../src/reverse/platforms/qoder/oauth.js';

function buildAuthUrlFor(profileName) {
  const profile = resolveLoginProfile({ platform, profileName, environment: {} });
  const session = createDeviceSession({ machineId: 'machine-fixed', nonceStyle: profile.nonceStyle });
  return { profile, url: new URL(buildAuthUrl({ session, endpoints: platform.endpoints, profile })) };
}

test('每个 CN profile 都自带授权站与 UA（成套，不允许只带一半）', () => {
  for (const profileName of ['cn-python', 'cn-providers', 'intl']) {
    const profile = resolveLoginProfile({ platform, profileName, environment: {} });
    assert.equal(typeof profile.authBase, 'string', `${profileName} 缺 authBase`);
    assert.equal(profile.authBase.startsWith('https://'), true, `${profileName} 的 authBase 不是 https`);
    assert.equal(typeof profile.userAgent, 'string', `${profileName} 缺 userAgent`);
    assert.equal(profile.userAgent.length > 0, true, `${profileName} 的 userAgent 为空`);
  }
});

test('cn-python：授权站、client_id、redirect_uri 三者属于同一套（Python 参考）', () => {
  const { profile, url } = buildAuthUrlFor('cn-python');
  assert.equal(url.origin, 'https://qoder.com.cn');
  assert.equal(profile.clientId, '1c5e33e1-364d-4ce6-b02c-acaa81274a5c');
  assert.equal(url.searchParams.get('redirect_uri'), 'qoder-work-cn://');
});

test('cn-providers：授权站换成 qoder.cn 且不带 redirect_uri（与自家 client_id 配套）', () => {
  const { profile, url } = buildAuthUrlFor('cn-providers');
  assert.equal(url.origin, 'https://qoder.cn');
  assert.equal(profile.clientId, '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa');
  assert.equal(url.searchParams.has('redirect_uri'), false);
});

test('授权站跟随 profile：换 profile 后授权 URL 的域随之切换（不是写死一个域）', () => {
  const pythonUrl = buildAuthUrlFor('cn-python').url;
  const providersUrl = buildAuthUrlFor('cn-providers').url;
  assert.notEqual(pythonUrl.origin, providersUrl.origin, '两套 profile 的授权站必须不同，否则等于只有一套');
});

test('轮询仍挂 openApiBase：授权站与轮询站允许不同域，靠 profile 成套而不是靠同域', () => {
  const { profile } = buildAuthUrlFor('cn-python');
  const session = createDeviceSession({ machineId: 'machine-fixed', nonceStyle: profile.nonceStyle });
  const pollUrl = new URL(buildPollUrl({ session, endpoints: platform.endpoints }));
  assert.equal(pollUrl.origin, 'https://openapi.qoder.com.cn');
  assert.equal(pollUrl.searchParams.get('challenge_method'), 'S256');
});
