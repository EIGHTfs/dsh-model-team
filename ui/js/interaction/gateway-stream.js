// gateway-stream.js —— 「请求完成」事件的唯一订阅点（SSE，docs/09）。
//
// 为什么要有这个模块：请求是否完成只有网关知道，宿主不保证通知我们的挂载点。
// 因此由后端把这件事广播出来（GET /_team/stream），前端在这里订阅一次，
// 收到事件就按"当前是否在该群聊页"决定刷新什么。**不轮询**，也不依赖任何宿主 hook。
//
// 三条纪律：
//   ① 连接只有一条：会话切换/页面卸载必须先关旧连接再开新连接，不许泄漏；
//   ② 事件→动作：在群聊页且群匹配 → load-chat + load-stats；否则只 load-stats；
//   ③ 断线由 EventSource 自带重连；页面恢复可见时若已 CLOSED 则重建。

var GATEWAY_STREAM_PATH = '/_team/stream';
var REQUEST_COMPLETED_EVENT = 'request:completed';
var READY_EVENT = 'ready';

/** 由 store 状态与事件载荷决定要 dispatch 什么（纯函数，便于单测） */
function planStreamRefresh(state, payload) {
  var actions = [];
  if (!state) return actions;
  // 坏数据/空载荷直接忽略：宁可这次不刷，也不要按"没有会话"去乱拉一轮
  if (!payload || typeof payload !== 'object') return actions;
  var inTargetChat = state.view === 'chat'
    && typeof state.currentGroupId === 'string' && state.currentGroupId.length > 0
    && payload && payload.groupId === state.currentGroupId;
  if (inTargetChat) actions.push({ type: 'load-chat', groupId: state.currentGroupId });
  // 统计与速率不论在哪个页面都要刷：面板与列表都在显示它们
  actions.push({ type: 'load-stats' });
  return actions;
}

/**
 * 建立订阅。返回 { close }，重复调用只保留一条连接。
 * @param {{store: object, EventSourceImpl?: Function, windowImpl?: object}} options
 */
function attachGatewayStream(options) {
  var settings = options || {};
  var store = settings.store;
  var EventSourceImpl = settings.EventSourceImpl
    || (typeof EventSource === 'function' ? EventSource : null);
  var windowImpl = settings.windowImpl || (typeof window !== 'undefined' ? window : null);
  if (!store || !EventSourceImpl) return { close: function () {} };

  var currentSource = null;
  var currentSessionId = null;

  function closeSource() {
    if (!currentSource) return;
    try { currentSource.close(); } catch (closeError) { /* 已经断了 */ }
    currentSource = null;
  }

  function openFor(sessionId) {
    closeSource();
    currentSessionId = sessionId || null;
    var target = GATEWAY_STREAM_PATH + (currentSessionId ? '?sessionId=' + encodeURIComponent(currentSessionId) : '');
    try {
      currentSource = new EventSourceImpl(target);
    } catch (createError) {
      currentSource = null;   // 建不起来就当没有实时刷新，用户动作仍会刷新
      return;
    }
    // 就绪事件：首屏数据在这里拉，而不是靠"失败后按超时重试"
    currentSource.addEventListener(READY_EVENT, function () {
      if (typeof settings.onReady === 'function') {
        try { settings.onReady(); } catch (readyError) { /* 拉数据失败由各自的错误出口负责 */ }
      }
    });
    currentSource.addEventListener(REQUEST_COMPLETED_EVENT, function (event) {
      var payload = null;
      try { payload = JSON.parse(event.data); } catch (parseError) { payload = null; }
      var actions = planStreamRefresh(store.getState(), payload);
      for (var index = 0; index < actions.length; index += 1) {
        var action = actions[index];
        Promise.resolve(store.dispatch(action)).catch(function () { /* 单次刷新失败不影响后续事件 */ });
      }
    });
  }

  openFor(store.getState().sessionId);

  // 会话切换：关旧开新（会话过滤在服务端，连接必须跟着换）
  var unsubscribeStore = typeof store.subscribe === 'function'
    ? store.subscribe(function () {
      var nextSessionId = store.getState().sessionId || null;
      if (nextSessionId !== currentSessionId) openFor(nextSessionId);
    })
    : function () {};

  // 页面从后台回来：EventSource 可能已被浏览器回收成 CLOSED，这时重建一次
  function handleVisibilityChange() {
    if (!windowImpl || windowImpl.document?.visibilityState !== 'visible') return;
    if (!currentSource || currentSource.readyState === 2 /* CLOSED */) openFor(currentSessionId);
  }
  if (windowImpl && typeof windowImpl.document?.addEventListener === 'function') {
    windowImpl.document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  return {
    close: function () {
      if (windowImpl && typeof windowImpl.document?.removeEventListener === 'function') {
        windowImpl.document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      unsubscribeStore();
      closeSource();
    },
    get source() { return currentSource; },
  };
}

if (typeof globalThis !== 'undefined') {
  globalThis.dshHostGatewayStream = { attachGatewayStream: attachGatewayStream, planStreamRefresh: planStreamRefresh };
}
