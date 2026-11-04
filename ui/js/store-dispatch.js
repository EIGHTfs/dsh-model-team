// store-dispatch.js —— 动作分派表（视图只能通过它改状态，契约 docs/13 §3.5）。
// 这里只做"动作名 → 实现"的映射与参数整理，逻辑都在各自模块里；
// 分派表保持一行一个动作，新增动作时不会把别处的实现一起改乱。

function createDispatcher(deps) {
  var state = deps.state;
  var persist = deps.persist;
  var renderNow = deps.renderNow;
  var actions = deps.actions;      // { start, stop, applySessionChanged, loadGroups, ... }

  function dispatch(action) {
    if (!action || typeof action.type !== 'string') return Promise.resolve();
    switch (action.type) {
      case 'start': return actions.start();
      case 'stop': actions.stop(); return Promise.resolve();
      case 'session-changed': return actions.applySessionChanged(action.sessionId, action.sessionTitle);
      case 'load-groups': return actions.loadGroups();
      case 'load-chat': return actions.loadChat(action.groupId);
      case 'load-stats': return actions.loadStats();
      case 'open-view': return actions.openView(action.view, action.groupId);
      case 'refresh-platforms': return actions.loadPlatforms();
      case 'switch-target': return actions.switchTarget(action.target);
      case 'send-message': return actions.sendMessage(action.text);
      case 'toggle-row': return actions.toggleRow(action.groupId || state.currentGroupId, action.rowIndex);
      case 'set-anchor':
        state.anchor = action.anchor;
        persist(ANCHOR_STORAGE_KEY, JSON.stringify(action.anchor));
        return Promise.resolve();
      case 'view:rebuilt': renderNow(); return Promise.resolve();
      default: return Promise.resolve();
    }
  }

  return { dispatch: dispatch };
}
