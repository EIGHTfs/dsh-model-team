// store.js —— 唯一真相源（装配层）。
// 视图只能：读 getState()、subscribe(事件)、dispatch(action)；所有写入走 dispatch，渲染只由事件广播触发。
// 拆分后的职责边界（依赖全部通过参数注入，模块之间不共享第二份状态）：
//   store-state.js    初始 state 与事件/键常量
//   store-persist.js  持久化端口（去抖 150ms / 退出 flush / loadedOnce 凭证）
//   store-events.js   错误出口 + 事件总线（渲染只由广播触发）
//   store-loaders.js  数据加载（四个接口逐接口容错、群友加载状态）
//   store-session.js  会话生命周期与目标切换（start/stop/切会话/切目标）
//   store-dispatch.js 动作分派表

function createTeamStore(options) {
  var api = options.api;
  var storage = options.storage || { read: function () { return null; }, write: function () {} };
  var sessionSource = options.sessionSource || null;
  var onRender = options.onRender || function () {};

  var state = createInitialState();
  var errorSink = createErrorSink({ state: state });
  var hub = createEventHub({ state: state, reportError: errorSink.reportError, onRender: onRender });
  var persistence = createPersistencePort({ storage: storage, state: state, reportError: errorSink.reportError });

  // api.js 的失败上报通道（三类失败进 errors；/groups 的失败另存给 loaders 判定"加载失败"）
  var apiFailureSink = createApiFailureSink({ reportError: errorSink.reportError });

  // 三个 loader 工厂各自独立；stats 通过延迟引用拿 chat.loadChat（避免循环依赖）
  var baseDeps = { api: api, state: state, broadcast: hub.broadcast, reportError: errorSink.reportError };
  var chatLoadersRef = null;
  var loaders = Object.assign(
    {},
    createGroupLoaders(Object.assign({}, baseDeps, { apiFailureSink: apiFailureSink })),
    chatLoadersRef = createChatLoaders(baseDeps),
    createStatsLoaders(Object.assign({}, baseDeps, {
      loadChat: function (groupId) { return chatLoadersRef.loadChat(groupId); },
    })),
  );
  var session = createSessionAndTarget({
    api: api,
    state: state,
    broadcast: hub.broadcast,
    persist: persistence.persist,
    persistence: persistence,
    loaders: loaders,
    sessionSource: sessionSource
  });

  var dispatcher = createDispatcher({
    state: state,
    persist: persistence.persist,
    renderNow: hub.renderNow,
    actions: {
      start: session.start,
      stop: session.stop,
      applySessionChanged: session.applySessionChanged,
      openView: session.openView,
      switchTarget: session.switchTarget,
      loadGroups: loaders.loadGroups,
      loadPlatforms: loaders.loadPlatforms,
      loadChat: loaders.loadChat,
      loadStats: loaders.loadStats,
      sendMessage: loaders.sendMessage,
      toggleRow: loaders.toggleRow
    }
  });

  return {
    getState: function () { return state; },
    getErrors: function () { return state.errors.slice(); },
    subscribe: hub.subscribe,
    dispatch: dispatcher.dispatch,
    start: session.start,
    stop: session.stop,
    render: hub.renderNow,
    flush: persistence.flushWrites,
    // 对外错误出口：视图层发现"元素缺失 / 显示值为空"这类代码 bug 时调用（契约 §8）
    reportError: function (tag, message) { errorSink.reportError(tag, message); }
  };
}
