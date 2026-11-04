// store-session.js —— 会话生命周期与目标切换（启动/停止/切会话/切目标/视图动作）。
// 依赖全部注入（api / state / broadcast / persist / loaders / sessionSource），
// 模块内不持有第二个真相源：读写的都是传进来的同一份 state。

function createSessionAndTarget(deps) {
  var api = deps.api;
  var state = deps.state;
  var broadcast = deps.broadcast;
  var persist = deps.persist;
  var loaders = deps.loaders;
  var sessionSource = deps.sessionSource || null;
  var persistence = deps.persistence;

  function start() {
    persistence.loadPersisted();                          // R2：读回早于首帧
    document.addEventListener('visibilitychange', persistence.handlePageExit);
    window.addEventListener('pagehide', persistence.handlePageExit);  // pagehide 的目标是 window，不是 document
    if (sessionSource) sessionSource.start();
    return api.getCurrentSession().then(function (payload) {
      var sessionId = payload && payload.sessionId ? payload.sessionId : null;
      if (sessionId) {
        state.sessionId = sessionId;
        persist(SESSION_STORAGE_KEY, sessionId);
      } else {
        state.sessionId = state.lastSessionId;
      }
      if (typeof api.setActiveSession === 'function' && state.sessionId) api.setActiveSession(state.sessionId);
      broadcast('session:changed', { sessionId: state.sessionId, previous: null });
      return loaders.loadGroups();
    }).then(function () {
      return loaders.loadTargetAndStats();
    });
  }

  function stop() {
    if (sessionSource) sessionSource.stop();
    document.removeEventListener('visibilitychange', persistence.handlePageExit);
    window.removeEventListener('pagehide', persistence.handlePageExit);
    persistence.flushWrites();
  }

  // 视图动作：只改 state + 广播，需要数据的交给 loaders
  function openView(view, groupId) {
    state.view = view || 'list';
    if (groupId) state.currentGroupId = groupId;
    broadcast('view:changed', { view: state.view, groupId: state.currentGroupId });
    if (state.view === 'chat' && state.currentGroupId) return loaders.loadChat(state.currentGroupId);
    // 加群页依赖平台清单：每次进入都重取（数据文件可能刚被改过），失败不阻断渲染
    if (state.view === 'add') return loaders.loadPlatforms().catch(function () { return state.platforms; });
    return Promise.resolve();
  }

  function switchTarget(target) {
    if (!state.sessionId) return Promise.resolve(null);
    return api.putSessionTarget(state.sessionId, target).then(function (nextTarget) {
      state.target = nextTarget || target;
      // 用户显式切换后，实际生效的就是它，来源标记为 explicit
      state.effectiveTarget = state.target;
      state.targetSource = 'explicit';
      broadcast('target:changed', { target: state.effectiveTarget });
      return loaders.loadChat(state.currentGroupId);
    }).then(function () {
      return loaders.loadStats();
    });
  }

  // 会话切换：null 表示「新会话草稿」（槽位 props.session === undefined），
  // 这时要把目标/速率清成 —、聊天清空，不能沿用上一个会话的值。
  // sessionTitle 来自宿主会话列表（槽位 props 的 useSessions），只用于面板「会话」行展示。
  function applySessionChanged(sessionId, sessionTitle) {
    var nextSessionId = typeof sessionId === 'string' && sessionId ? sessionId : null;
    var nextTitle = typeof sessionTitle === 'string' && sessionTitle ? sessionTitle : null;
    var previous = state.sessionId;
    var previousTitle = state.sessionTitle;
    if (nextSessionId === previous) {
      // 会话没变但标题可能后到（useSessions 异步就绪）——标题变了也要广播，否则「会话」行一直空着
      if (nextTitle === previousTitle) return Promise.resolve();
      state.sessionTitle = nextTitle;
      broadcast('session:changed', { sessionId: nextSessionId, previous: previous });
      return Promise.resolve();
    }
    state.sessionId = nextSessionId;
    state.sessionTitle = nextTitle;
    if (nextSessionId) {
      state.lastSessionId = nextSessionId;
      persist(SESSION_STORAGE_KEY, nextSessionId);
    }
    if (typeof api.setActiveSession === 'function') api.setActiveSession(nextSessionId);
    if (!nextSessionId) {
      state.target = null;
      state.effectiveTarget = null;
      state.targetSource = 'none';
      state.models = {};
      state.modelsStatus = {};
      state.messages = {};
      state.rate = RATE_PLACEHOLDER_TEXT;
    }
    broadcast('session:changed', { sessionId: nextSessionId, previous: previous });
    return loaders.loadTargetAndStats();
  }

  return {
    start: start,
    stop: stop,
    openView: openView,
    switchTarget: switchTarget,
    applySessionChanged: applySessionChanged
  };
}
