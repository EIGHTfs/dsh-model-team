// 前端事件流模块：事件→动作的决策、连接复用/重开、断线重建、关闭清理。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const SOURCE = await fs.readFile(new URL('../ui/js/interaction/gateway-stream.js', import.meta.url), 'utf8');

function loadModule() {
  return new Function(`${SOURCE}
;return { attachGatewayStream, planStreamRefresh };`)();
}

/** 假 EventSource：记录实例与监听，测试里手动派事件 */
function createFakeEventSource() {
  const instances = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.listeners = new Map();
      instances.push(this);
    }
    addEventListener(name, handler) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(handler);
    }
    emit(name, data) {
      (this.listeners.get(name) || []).forEach((handler) => handler({ data: JSON.stringify(data) }));
    }
    close() { this.readyState = 2; this.closed = true; }
  }
  return { FakeEventSource, instances };
}

function createFakeStore(initialState) {
  const state = { ...initialState };
  const dispatched = [];
  const listeners = [];
  return {
    state,
    dispatched,
    getState: () => state,
    dispatch: (action) => { dispatched.push(action); return Promise.resolve(); },
    subscribe: (listener) => { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1); },
    setSession(sessionId) { state.sessionId = sessionId; listeners.forEach((listener) => listener()); },
  };
}

test('planStreamRefresh：在对应群聊页 → load-chat + load-stats；别的页面只 load-stats', () => {
  const module = loadModule();
  const chatState = { view: 'chat', currentGroupId: 'agnes', sessionId: 's1' };
  assert.deepEqual(module.planStreamRefresh(chatState, { groupId: 'agnes' }), [
    { type: 'load-chat', groupId: 'agnes' },
    { type: 'load-stats' },
  ]);

  assert.deepEqual(module.planStreamRefresh(chatState, { groupId: 'other' }), [{ type: 'load-stats' }], '别的群不串刷');
  assert.deepEqual(module.planStreamRefresh({ view: 'list', currentGroupId: '' }, { groupId: 'agnes' }), [{ type: 'load-stats' }]);
});

test('attachGatewayStream：连当前会话，收到事件按计划 dispatch', () => {
  const module = loadModule();
  const { FakeEventSource, instances } = createFakeEventSource();
  const store = createFakeStore({ view: 'chat', currentGroupId: 'agnes', sessionId: 'session-1' });

  const stream = module.attachGatewayStream({ store, EventSourceImpl: FakeEventSource });
  assert.equal(instances.length, 1);
  assert.equal(instances[0].url, '/_team/stream?sessionId=session-1');

  instances[0].emit('request:completed', { sessionId: 'session-1', groupId: 'agnes' });
  assert.deepEqual(store.dispatched, [{ type: 'load-chat', groupId: 'agnes' }, { type: 'load-stats' }]);

  stream.close();
  assert.equal(instances[0].closed, true, 'close 必须真的关连接');
});

test('会话切换：先关旧连接再开新连接（不泄漏）', () => {
  const module = loadModule();
  const { FakeEventSource, instances } = createFakeEventSource();
  const store = createFakeStore({ view: 'list', currentGroupId: '', sessionId: 'session-1' });
  const stream = module.attachGatewayStream({ store, EventSourceImpl: FakeEventSource });

  store.setSession('session-2');
  assert.equal(instances.length, 2, '新会话要新连接');
  assert.equal(instances[0].closed, true, '旧连接必须关掉');
  assert.equal(instances[1].url, '/_team/stream?sessionId=session-2');

  stream.close();
  assert.equal(instances[1].closed, true);
});

test('页面恢复可见且连接已 CLOSED：重建一次', () => {
  const module = loadModule();
  const { FakeEventSource, instances } = createFakeEventSource();
  const store = createFakeStore({ view: 'list', currentGroupId: '', sessionId: 'session-1' });

  const handlers = [];
  const fakeWindow = {
    document: {
      visibilityState: 'visible',
      addEventListener: (name, handler) => handlers.push(handler),
      removeEventListener: () => {},
    },
  };
  const stream = module.attachGatewayStream({ store, EventSourceImpl: FakeEventSource, windowImpl: fakeWindow });

  instances[0].readyState = 2;               // 浏览器回收了连接
  handlers.forEach((handler) => handler());   // 触发 visibilitychange
  assert.equal(instances.length, 2, '连接已关闭时必须重建');
  assert.equal(instances[1].url, '/_team/stream?sessionId=session-1');

  stream.close();
});

test('解析失败的事件不影响后续事件', () => {
  const module = loadModule();
  const { FakeEventSource, instances } = createFakeEventSource();
  const store = createFakeStore({ view: 'chat', currentGroupId: 'agnes', sessionId: 'session-1' });
  const stream = module.attachGatewayStream({ store, EventSourceImpl: FakeEventSource });

  const listener = instances[0].listeners.get('request:completed')[0];
  listener({ data: 'not-json' });
  assert.deepEqual(store.dispatched, [], '坏数据不触发刷新');

  instances[0].emit('request:completed', { groupId: 'agnes' });
  assert.equal(store.dispatched.filter((action) => action.type === 'load-chat').length, 1);
  stream.close();
});
