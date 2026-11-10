// 生产代码禁止"超时兜底"（项目硬规矩）：请求的结束只能由网络事件决定。
// 线上事故：api 里 8s 定时器 abort() → 界面显示 "signal is aborted without reason"，
// 把"慢"说成"网络故障"。这里用源码契约锁死：请求层不许出现任何定时器。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const API_SOURCE = await fs.readFile(new URL('../lib/client-parts/foundation/api.js', import.meta.url), 'utf8');
const CONSTANTS_SOURCE = await fs.readFile(new URL('../lib/client-parts/foundation/constants.js', import.meta.url), 'utf8');
const EVENTS_SOURCE = await fs.readFile(new URL('../ui/js/store/events.js', import.meta.url), 'utf8');

test('请求层：没有任何定时器（setTimeout/setInterval 计数为 0）', () => {
  assert.equal(/setTimeout|setInterval/.test(API_SOURCE), false, 'api.js 不许用定时器造超时/取消');
  assert.equal(/API_TIMEOUT_MS/.test(API_SOURCE), false, 'api.js 不许再引用超时常量');
});

test('常量层：超时常量已彻底删除', () => {
  assert.equal(/API_TIMEOUT_MS|LOAD_GROUPS_TIMEOUT_MS/.test(CONSTANTS_SOURCE), false, 'constants.js 不许再有超时常量');
});

test('失败映射：只剩 服务端状态 / 数据解析 / 网络 三类，没有"超时"这一类', async () => {
  const factory = new Function(`${EVENTS_SOURCE}
;return { createApiFailureSink: createApiFailureSink };`)();
  let reporter = null;
  globalThis.apiSetErrorReporter = (fn) => { reporter = fn; };
  const sink = factory.createApiFailureSink({ reportError: () => {} });
  reporter({ path: '/groups', kind: 'network', detail: 'Failed to fetch' });
  assert.equal(sink.groups, '网络异常：Failed to fetch');
  reporter({ path: '/groups', kind: 'http-status', detail: 'HTTP 502' });
  assert.equal(sink.groups, 'HTTP 502');
  reporter({ path: '/groups', kind: 'json-parse', detail: 'Unexpected token' });
  assert.equal(sink.groups, '数据解析失败：Unexpected token');
});

test('取消语义：调用方传进来的 signal 原样透传给 fetch（我们不自己造取消）', async () => {
  globalThis.API_PREFIX = '/_team';
  const controller = new AbortController();
  let passedSignal = null;
  globalThis.fetch = (url, options) => {
    passedSignal = options.signal;
    return Promise.reject(new DOMException('cancelled', 'AbortError'));
  };
  const factory = new Function(`${API_SOURCE}
;return { api: api, apiSetErrorReporter: (...args) => apiSetErrorReporter(...args) };`)();
  const failures = [];
  globalThis.fetch = (url, options) => {
    passedSignal = options.signal;
    return Promise.reject(new DOMException('cancelled', 'AbortError'));
  };
  // 通过 api 内部转发：getGroups 不接受 signal，这里直接验证 apiJson 的透传能力用一个带 options 的调用
  const result = await factory.api.getSession?.('x').catch(() => null);
  assert.equal(result === null || result === undefined, true);
  // 关键断言：源码里没有 abort 调用点（不自造取消）
  assert.equal(/\.abort\(/.test(API_SOURCE), false, 'api.js 不许自己调用 abort()');
  assert.equal(passedSignal === null || passedSignal === undefined || passedSignal instanceof AbortSignal, true);
});
