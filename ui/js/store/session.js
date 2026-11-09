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
      // 启动兜底只用于「界面先有个会话可显示」，来源标记为 fallback。
      // 它来自服务端的「最近活跃会话」推断，**不是本界面正在看的会话**（docs/14 §1.3），
      // 因此不允许用它写目标 —— 否则会把目标写进另一个会话（真机实测过「写 A 跑 B」）。
      if (sessionId) {
        state.sessionId = sessionId;
        state.sessionIdSource = 'fallback';
        persist(SESSION_STORAGE_KEY, sessionId);
      } else {
        state.sessionId = state.lastSessionId;
        state.sessionIdSource = state.sessionId ? 'fallback' : 'none';
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
    // 只认槽位给的会话 id：fallback 值是「最近活跃」推断，写进去会落到别的会话上
    if (!state.sessionId || state.sessionIdSource !== 'slot') {
      return Promise.reject(new Error('当前会话尚未就绪（等宿主槽位同步），请稍后重试'));
    }
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
      // 即使 id 相同，也要把来源升级为「槽位确认」：启动兜底先给了同值，来源仍是 fallback，
      // 不升级的话 switchTarget 会一直拒绝写目标（表现为「切了没反应」）。
      if (nextSessionId && state.sessionIdSource !== 'slot') {
        state.sessionIdSource = 'slot';
        broadcast('session:changed', { sessionId: nextSessionId, previous: previous });
        return Promise.resolve();
      }
      // 会话没变但标题可能后到（useSessions 异步就绪）——标题变了也要广播，否则「会话」行一直空着
      if (nextTitle === previousTitle) return Promise.resolve();
      state.sessionTitle = nextTitle;
      broadcast('session:changed', { sessionId: nextSessionId, previous: previous });
      return Promise.resolve();
    }
    state.sessionId = nextSessionId;
    state.sessionIdSource = nextSessionId ? 'slot' : 'none';
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
