// store-dispatch.js —— 动作分派表（视图只能通过它改状态，契约 docs/13 §3.5）。
// 这里只做"动作名 → 实现"的映射与参数整理，逻辑都在各自模块里；
// 分派表保持一行一个动作，新增动作时不会把别处的实现一起改乱。
//
// 表驱动而不是 switch/if 链：动作数继续增长时分支复杂度不再上涨，新增动作只加一行，
// 回滚也只删那一行。每个处理函数都返回 Promise（同步动作包成已决议的），调用方不必区分。

function createActionHandlers(deps) {
  var state = deps.state;
  var persist = deps.persist;
  var renderNow = deps.renderNow;
  var actions = deps.actions;      // { start, stop, applySessionChanged, loadGroups, ... }

  return {
    start: function () { return actions.start(); },
    // stop 是同步动作：包成已决议的 Promise，保证 dispatch 的返回类型对调用方一致
    stop: function () { actions.stop(); return Promise.resolve(); },
    'session-changed': function (action) { return actions.applySessionChanged(action.sessionId, action.sessionTitle); },
    'load-groups': function () { return actions.loadGroups(); },
    'load-chat': function (action) { return actions.loadChat(action.groupId); },
    'load-stats': function () { return actions.loadStats(); },
    'open-view': function (action) { return actions.openView(action.view, action.groupId); },
    'refresh-platforms': function () { return actions.loadPlatforms(); },
    'switch-target': function (action) { return actions.switchTarget(action.target); },
    'send-message': function (action) { return actions.sendMessage(action.text); },
    'toggle-row': function (action) {
      // 没带群 id 的点击落到当前打开的群（视图只负责传行号，来源判定留在这里）
      return actions.toggleRow(action.groupId || state.currentGroupId, action.rowIndex);
    },
    'set-anchor': function (action) {
      state.anchor = action.anchor;
      persist(ANCHOR_STORAGE_KEY, JSON.stringify(action.anchor));
      return Promise.resolve();
    },
    // 表单类动作：实现只调接口，结果（或错误）原样交回调用方，不落 state
    'add-group': function (action) { return actions.addGroup(action.payload); },
    'probe-models': function (action) { return actions.probeModels(action.input); },
    'export-config': function () { return actions.exportConfig(); },
    'import-config': function (action) { return actions.importConfig(action.payload); },
    'reverse-accounts': function (action) { return actions.loadReverseAccounts(action.platformId); },
    'reverse-login-start': function (action) { return actions.startReverseLogin(action.platformId); },
    'reverse-login-poll': function (action) { return actions.pollReverseLogin(action.platformId); },
    'save-friend-group': function (action) { return actions.saveFriendGroup(action.payload); },
    'delete-friend-group': function (action) { return actions.deleteFriendGroup(action.groupId); },
    'group-models': function (action) { return actions.loadGroupModels(action.groupId); },
    'view:rebuilt': function () { renderNow(); return Promise.resolve(); }
  };
}

function createDispatcher(deps) {
  var handlers = createActionHandlers(deps);

  function dispatch(action) {
    if (!action || typeof action.type !== 'string') return Promise.resolve();
    // hasOwnProperty 判定：避免 'toString' 这类原型键被当成动作名取到函数
    var handler = Object.prototype.hasOwnProperty.call(handlers, action.type) ? handlers[action.type] : null;
    return handler ? handler(action) : Promise.resolve();
  }

  return { dispatch: dispatch };
}
