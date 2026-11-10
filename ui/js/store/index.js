// store.js —— 唯一真相源（装配层）。
// 视图只能：读 getState()、subscribe(事件)、dispatch(action)；所有写入走 dispatch，渲染只由事件广播触发。
// 拆分后的职责边界（依赖全部通过参数注入，模块之间不共享第二份状态）：
//   store-state.js    初始 state 与事件/键常量
//   store-persist.js  持久化端口（去抖 150ms / 退出 flush / loadedOnce 凭证）
//   store-events.js   错误出口 + 事件总线（渲染只由广播触发）
//   store-loaders.js  数据加载（四个接口逐接口容错、群友加载状态）
//   store-session.js  会话生命周期与目标切换（start/stop/切会话/切目标）
//   store-dispatch.js 动作分派表

// 三个 loader 工厂的装配：集中在这里，装配层（createTeamStore）只负责"把东西接起来"
function createStoreLoaders(options) {
  var baseDeps = {
    api: options.api,
    state: options.state,
    broadcast: options.broadcast,
    reportError: options.reportError
  };
  // stats 需要 chat.loadChat：用延迟引用打破循环依赖（chat 工厂先建，再让 stats 通过它取）
  var chatLoadersRef = null;
  var chatLoaders = createChatLoaders(baseDeps);
  chatLoadersRef = chatLoaders;
  return Object.assign(
    {},
    createGroupLoaders(Object.assign({}, baseDeps, { apiFailureSink: options.apiFailureSink })),
    chatLoaders,
    createStatsLoaders(Object.assign({}, baseDeps, {
      loadChat: function (groupId) { return chatLoadersRef.loadChat(groupId); },
    })),
  );
}

// 动作表：dispatch 只认"动作名 → 实现"，这里把 loader/session 的方法映射成契约里的动作名
function collectStoreActions(loaders, session, forms, addForm, dbActions) {
  return {
    // 表单类动作（加群/探测/导出导入/反代登录）：只调接口、不写 state
    addGroup: forms.addGroup,
    probeModels: forms.probeModels,
    exportConfig: forms.exportConfig,
    importConfig: forms.importConfig,
    loadReverseAccounts: forms.loadReverseAccounts,
    startReverseLogin: forms.startReverseLogin,
    pollReverseLogin: forms.pollReverseLogin,
    saveFriendGroup: forms.saveFriendGroup,
    deleteFriendGroup: forms.deleteFriendGroup,
    loadGroupModels: forms.loadGroupModels,
    // 加群表单：选中选项 / 字段输入 / 探测 / 提交（payload 全在 add-form.js 里组）
    selectGroupOption: addForm.selectGroupOption,
    setAddFormValue: addForm.setAddFormValue,
    probeAddForm: addForm.probeAddForm,
    submitAddGroup: addForm.submitAddGroup,
    // 数据库页（备份/恢复）
    exportDbBackup: dbActions.exportDbBackup,
    previewDbImport: dbActions.previewDbImport,
    importDbBackup: dbActions.importDbBackup,
    confirmDbReplace: dbActions.confirmDbReplace,
    resetDbPage: dbActions.resetDbPage,
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
  };
}

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

  var loaders = createStoreLoaders({
    api: api,
    state: state,
    broadcast: hub.broadcast,
    reportError: errorSink.reportError,
    apiFailureSink: apiFailureSink
  });
  var session = createSessionAndTarget({
    api: api,
    state: state,
    broadcast: hub.broadcast,
    persist: persistence.persist,
    persistence: persistence,
    loaders: loaders,
    sessionSource: sessionSource
  });

  var forms = createFormActions({ api: api, reportError: errorSink.reportError });
  // 数据库页：值在 store/db.js；下载能力作为端口注入（测试注入桩，不触发真实下载）
  var dbActions = createDbActions({
    api: api,
    state: state,
    broadcast: hub.broadcast,
    download: typeof downloadTextFile === 'function'
      ? downloadTextFile
      : function (fileName, text) { return { fileName: fileName, bytes: String(text || '').length }; }
  });
  // 加群表单的「值」（选项展开、探测体、提交体都在这里，主题不认识内部字段名）
  var addForm = createAddFormActions({
    api: api,
    state: state,
    broadcast: hub.broadcast,
    reportError: errorSink.reportError
  });

  var dispatcher = createDispatcher({
    state: state,
    persist: persistence.persist,
    renderNow: hub.renderNow,
    actions: collectStoreActions(loaders, session, forms, addForm, dbActions)
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
