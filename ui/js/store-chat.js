// store-chat.js —— 单群聊天数据与消息动作（群友清单 / 请求行 / 我发出的 @）。
// modelsStatus 与 models 分开记：models 缺省是 []，"还没拉到"与"确实 0 个"必须能区分。

function createChatLoaders(deps) {
  var api = deps.api;
  var state = deps.state;
  var broadcast = deps.broadcast;
  var reportError = deps.reportError;

  function loadChat(groupId) {
    var targetGroupId = groupId || state.currentGroupId;
    if (!targetGroupId) return Promise.resolve();
    // 先标 'loading'：视图据此区分"还没拉到"与"确实 0 个群友"
    state.modelsStatus[targetGroupId] = 'loading';
    return Promise.all([
      api.getSessionStats(targetGroupId),
      api.getGroupModels(targetGroupId),
      api.getSessionEvents(targetGroupId)
    ]).then(function (results) {
      state.models[targetGroupId] = results[1] || [];
      state.modelsStatus[targetGroupId] = 'loaded';
      // 消息合并/排序只在工厂内：视图拿到的是唯一的一份有序数组
      state.messages[targetGroupId] = buildMessages(targetGroupId, results[0].rows, results[2].events);
      broadcast('chat:updated', { groupId: targetGroupId, messages: state.messages[targetGroupId] });
    }).catch(function (error) {
      // 失败也要给状态，否则界面永远停在"未知"；错误本身照常上报
      state.modelsStatus[targetGroupId] = 'error';
      reportError('load-chat:' + targetGroupId, error);
      throw error;
    });
  }

  // 发送消息：先本地乐观插一条（用 concat 生成新数组，不 push 原数组），随后由 loadChat 用后端数据覆盖。
  // 系统提示一律来自后端事件，这里不插任何 system 文案（契约 §六）。
  function sendMessage(text) {
    var groupId = state.currentGroupId;
    if (!groupId) return Promise.resolve();
    var existing = state.messages[groupId] || [];
    state.messages[groupId] = existing.concat([{
      type: 'mine',
      text: text,
      time: formatMessageTime({ at: new Date().toISOString() })
    }]);
    broadcast('chat:updated', { groupId: groupId, messages: state.messages[groupId] });
    return loadChat(groupId);
  }

  // 展开/收起请求行：属于消息数据的一部分，由工厂改并广播，视图不直接改 state
  function toggleRow(groupId, rowIndex) {
    var messageList = state.messages[groupId] || [];
    state.messages[groupId] = messageList.map(function (message) {
      if (message.type !== 'row' || message.rowIndex !== rowIndex) return message;
      return { type: 'row', row: message.row, rowIndex: message.rowIndex, expanded: !message.expanded, time: message.time };
    });
    broadcast('chat:updated', { groupId: groupId, messages: state.messages[groupId] });
    return Promise.resolve();
  }

  return { loadChat: loadChat, sendMessage: sendMessage, toggleRow: toggleRow };
}
