// 进程内事件总线：publish/subscribe/退订、订阅者抛错隔离、订阅数可观测（防泄漏）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createEventHub, EVENT_REQUEST_COMPLETED } from '../src/gateway/events/hub.js';

test('publish 只送到订阅了该类型的订阅者，载荷原样传递', () => {
  const hub = createEventHub();
  const gotA = [];
  const gotB = [];
  hub.subscribe('a', (payload) => gotA.push(payload));
  hub.subscribe('b', (payload) => gotB.push(payload));

  assert.equal(hub.publish('a', { n: 1 }), 1);
  assert.deepEqual(gotA, [{ n: 1 }]);
  assert.deepEqual(gotB, [], '其它事件类型收不到');
});

test('退订后不再收到；订阅数回到 0', () => {
  const hub = createEventHub();
  const seen = [];
  const unsubscribe = hub.subscribe(EVENT_REQUEST_COMPLETED, (payload) => seen.push(payload));
  assert.equal(hub.subscriberCount(EVENT_REQUEST_COMPLETED), 1);

  hub.publish(EVENT_REQUEST_COMPLETED, { sessionId: 's1' });
  unsubscribe();
  hub.publish(EVENT_REQUEST_COMPLETED, { sessionId: 's2' });

  assert.equal(seen.length, 1, '退订后不再回调');
  assert.equal(hub.subscriberCount(EVENT_REQUEST_COMPLETED), 0);
});

test('一个订阅者抛错不影响其它订阅者，也不影响 publish 调用方', () => {
  const warnings = [];
  const hub = createEventHub({ logger: { warn: (message) => warnings.push(message) } });
  const delivered = [];
  hub.subscribe(EVENT_REQUEST_COMPLETED, () => { throw new Error('boom'); });
  hub.subscribe(EVENT_REQUEST_COMPLETED, (payload) => delivered.push(payload));

  assert.doesNotThrow(() => hub.publish(EVENT_REQUEST_COMPLETED, { sessionId: 's1' }));
  assert.deepEqual(delivered, [{ sessionId: 's1' }], '后面那个订阅者照样收到');
  assert.equal(warnings.length, 1, '抛错要记一条 warn');
});

test('订阅数超过阈值要 warn（防连接泄漏）', () => {
  const warnings = [];
  const hub = createEventHub({ logger: { warn: (message) => warnings.push(message) } });
  for (let index = 0; index < 40; index += 1) hub.subscribe(EVENT_REQUEST_COMPLETED, () => {});
  assert.equal(warnings.filter((message) => message.includes('订阅数异常')).length > 0, true);
});

test('reset 清空全部订阅（测试隔离用）', () => {
  const hub = createEventHub();
  hub.subscribe('a', () => {});
  hub.reset();
  assert.equal(hub.subscriberCount('a'), 0);
  assert.equal(hub.publish('a', {}), 0);
});
