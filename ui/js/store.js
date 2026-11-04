// store.js —— 唯一真相源 + 事件驱动（契约 docs/13）。
// 视图只能：读 getState()、subscribe(事件)、dispatch(action)；所有写入走 dispatch，渲染只由事件广播触发。
var STORE_EVENTS = ['session:changed', 'target:changed', 'chat:updated', 'stats:updated', 'groups:updated', 'platforms:updated', 'view:changed'];
var STORAGE_WRITE_DEBOUNCE_MS = 150;
var RATE_PLACEHOLDER_TEXT = '— tok/s';
// 持久化键由工厂单点持有（视图不再自己读写 localStorage）
var ANCHOR_STORAGE_KEY = 'dsh-model-team:anchor';
var SESSION_STORAGE_KEY = 'dsh-model-team:last-session';

function createTeamStore(options) {
  var api = options.api;
  var storage = options.storage || { read: function () { return null; }, write: function () {} };
  var sessionSource = options.sessionSource || null;
  var onRender = options.onRender || function () {};

  var listeners = {};
  STORE_EVENTS.forEach(function (eventName) { listeners[eventName] = []; });

  var state = {
    sessionId: null,
    sessionTitle: null,
    lastSessionId: null,
    target: null,                 // 本会话显式绑定的目标（可能为 null）
    effectiveTarget: null,        // 实际生效的目标（含后端回落），面板/球/群聊都用它
    targetSource: 'none',         // explicit | parent | last-session | fallback-group | none
    groups: [],
    // drivers / friendGroups 必须在初始 state 里：渲染路径（platformOf）会直接读 state.drivers，
    // 缺字段时抛 TypeError 会把整条 boot 链打断，表现就是"群列表 0 个群但接口有数据"。
    drivers: [],
    friendGroups: [],
    // 群列表最近一次加载失败的原因（null = 没失败）：渲染层据此区分"真的空"与"加载失败"
    lastGroupsError: null,
    platforms: [],
    currentGroupId: '',
    models: {},
    messages: {},
    rate: RATE_PLACEHOLDER_TEXT,
    global: { requests: 0, tokens: 0, text: '—' },
    view: 'list',
    anchor: null,
    errors: []
  };

  // api.js 的失败上报通道：三类失败（HTTP / JSON / 网络）都进 state.errors，
  // 界面上"加载失败"才有依据，而不是静默变成空列表。
  // 本次加载里 /groups 的失败原因：apiJson 对失败只上报不 reject，
  // 只看 Promise 状态会把"500"当成"成功返回空"，界面就仍然显示「0 个群」。
  var pendingGroupsFailure = null;
  if (typeof apiSetErrorReporter === 'function') {
    apiSetErrorReporter(function (failure) {
      var detail = failure && failure.detail ? String(failure.detail) : 'request failed';
      reportError('api:' + (failure && failure.kind) + ':' + (failure && failure.path), { message: detail });
      if (failure && failure.path === '/groups') {
        // detail 自身已带类别信息（http-status 是「HTTP 500」、json-parse 是解析错误原文），
        // 这里只给其余两类补一个可读前缀，避免出现「HTTP HTTP 500」
        pendingGroupsFailure = failure.kind === 'http-status'
          ? detail
          : (failure.kind === 'json-parse' ? '数据解析失败：' : '网络异常：') + detail;
      }
    });
  }

  var loadedOnce = false;
  var pendingWrites = {};
  var writeTimer = null;

  // ---------- 错误出口（§八：预期失败静默，代码 bug 暴露） ----------
  function isExpectedFailure(error) {
    if (!error) return true;
    if (typeof DOMException !== 'undefined' && error instanceof DOMException) return true;
    return /Quota|Security|NotAllowed/.test(String(error.name || ''));
  }

  function reportError(tag, error) {
    if (isExpectedFailure(error)) return;                 // 配额/安全/元素不存在：静默降级
    var message = String(error && error.message ? error.message : error);
    state.errors.push({ tag: tag, message: message });
    try { document.documentElement.dataset.lastStoreError = tag + ': ' + message; }
    catch (ignored) { /* 连 dataset 都写不了就放弃，不能因此中断 */ }
  }

  // ---------- 持久化（§七：去抖 150ms + 退出 flush + loadedOnce 凭证） ----------
  function readRaw(key) {
    try { return storage.read(key); }
    catch (error) { reportError('read:' + key, error); return null; }
  }

  function loadPersisted() {
    var anchorRaw = readRaw(ANCHOR_STORAGE_KEY);
    if (anchorRaw) {
      try {
        var parsedAnchor = JSON.parse(anchorRaw);
        if (parsedAnchor && typeof parsedAnchor.left === 'number' && typeof parsedAnchor.top === 'number') {
          state.anchor = { left: parsedAnchor.left, top: parsedAnchor.top };
        }
      } catch (error) {
        // 脏数据：回落默认（不加锚点），不删键、不影响其它键
        reportError('anchor-json', error);
      }
    }
    state.lastSessionId = readRaw(SESSION_STORAGE_KEY) || null;
    // 读不成功也算"读过"：写入凭证防的是"读失败后写空覆盖"，不是"永远不写"
    loadedOnce = true;
  }

  function persist(key, value) {
    if (!loadedOnce) return;                              // 写入凭证
    pendingWrites[key] = value;
    if (writeTimer) return;
    writeTimer = setTimeout(flushWrites, STORAGE_WRITE_DEBOUNCE_MS);
  }

  function flushWrites() {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    Object.keys(pendingWrites).forEach(function (key) {
      var value = pendingWrites[key];
      delete pendingWrites[key];
      try { storage.write(key, value); }
      catch (error) { reportError('write:' + key, error); }
    });
  }

  function handlePageExit() { flushWrites(); }

  // ---------- 事件广播（渲染也只由这里触发：删掉广播，对应场景就会红） ----------
  function renderNow() {
    try { onRender(state); }
    catch (error) { reportError('render', error); }
  }

  // 渲染器作为每个事件的内部订阅者：没有广播就没有渲染（A7 反向自证靠这一点）
  STORE_EVENTS.forEach(function (eventName) {
    listeners[eventName].push(function () { renderNow(); });
  });

  function broadcast(eventName, payload) {
    var handlers = listeners[eventName] || [];
    for (var index = 0; index < handlers.length; index += 1) {
      try { handlers[index](payload, state); }
      catch (error) { reportError('listener:' + eventName, error); }
    }
  }

  function subscribe(eventName, listener) {
    if (!listeners[eventName]) listeners[eventName] = [];
    listeners[eventName].push(listener);
    return function unsubscribe() {
      var position = listeners[eventName].indexOf(listener);
      if (position >= 0) listeners[eventName].splice(position, 1);
    };
  }

  // ---------- 数据加载（apply：只改 state + 广播，不碰 DOM） ----------
  // 四个接口并发拉，但**任一失败不许清空其它三份**：
  // Promise.all 的"一败全败"会让单个 500（如 platforms 挂掉）把群列表也变成空，
  // 而界面上只会显示"0 个群"，与真实数据矛盾（用户已实测过这个现象）。
  function loadGroups() {
    pendingGroupsFailure = null;
    var requests = [api.getGroups(), api.getDrivers(), api.getFriendGroups(), api.getPlatforms()];
    var requestNames = ['groups', 'drivers', 'friend-groups', 'platforms'];
    return Promise.all(requests.map(function (request) {
      // 每个请求都兜成 settled：allSettled 在旧 WebView 上不一定有，这里不依赖它
      return Promise.resolve(request).then(
        function (value) { return { status: 'fulfilled', value: value }; },
        function (reason) { return { status: 'rejected', reason: reason }; },
      );
    })).then(function (settled) {
      var failed = [];
      settled.forEach(function (entry, index) {
        if (entry.status === 'rejected') {
          failed.push(requestNames[index]);
          reportError('load-groups:' + requestNames[index], entry.reason);
          return;                       // 保留上一份数据，绝不清空
        }
        var value = entry.value;
        if (index === 0) state.groups = value || [];
        else if (index === 1) state.drivers = value || [];
        else if (index === 2) state.friendGroups = value && value.groups ? value.groups : [];
        else state.platforms = value || [];
      });
      // 群列表的成功与失败要分开记：三条来源都算失败——Promise 被 reject、
      // apiJson 上报的 HTTP/JSON/网络失败（它不会 reject）、以及返回 null。
      state.lastGroupsError = pendingGroupsFailure
        || (settled[0].status === 'rejected' ? describeLoadFailure(settled[0].reason) : null);
      if (!state.currentGroupId && state.groups.length) state.currentGroupId = state.groups[0].id;
      broadcast('groups:updated', { groups: state.groups, failed: failed });
      return state.groups;
    });
  }

  // 失败原因给渲染层看的一句话（不含栈，避免把内部细节写进界面）
  function describeLoadFailure(reason) {
    if (!reason) return '接口无响应';
    if (typeof reason === 'string') return reason;
    return reason.message ? String(reason.message) : String(reason);
  }

  // 只刷新平台清单：平台预置是数据文件（config/platforms.json 或 <dataRoot>/platforms.json），
  // 运行时可能被修改，因此每次进入「加群」视图都要重取，不能只在启动时拉一次。
  function loadPlatforms() {
    return api.getPlatforms().then(function (platforms) {
      state.platforms = platforms || [];
      broadcast('platforms:updated', { platforms: state.platforms });
      return state.platforms;
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

  function loadChat(groupId) {
    var targetGroupId = groupId || state.currentGroupId;
    if (!targetGroupId) return Promise.resolve();
    return Promise.all([
      api.getSessionStats(targetGroupId),
      api.getGroupModels(targetGroupId),
      api.getSessionEvents(targetGroupId)
    ]).then(function (results) {
      state.models[targetGroupId] = results[1] || [];
      // 消息合并/排序只在工厂内：视图拿到的是唯一的一份有序数组
      state.messages[targetGroupId] = buildMessages(targetGroupId, results[0].rows, results[2].events);
      broadcast('chat:updated', { groupId: targetGroupId, messages: state.messages[targetGroupId] });
    });
  }

  function loadStats() {
    return api.getGlobalStats().then(function (stats) {
      state.rate = stats && stats.sessionRate ? stats.sessionRate : RATE_PLACEHOLDER_TEXT;
      state.global = {
        requests: stats && typeof stats.totalRows === 'number' ? stats.totalRows : 0,
        tokens: stats && typeof stats.totalTokens === 'number' ? stats.totalTokens : 0,
        text: stats ? stats.globalRequests + ' (' + stats.globalTokens + ')' : '—'
      };
      broadcast('stats:updated', { rate: state.rate, global: state.global });
    });
  }

  // 群聊默认显示「该会话目标所属的群」（契约条款 25）：
  // 目标是单模型 → 切到 target.platformId 对应的群；目标是分组或未设置 → 保留当前群聊；
  // 目标群不存在 → 回落当前群，再回落到第一个群。
  function pickGroupIdForTarget(target, groups, fallbackGroupId) {
    var groupList = groups || [];
    if (target && target.type === 'model' && target.platformId) {
      var matched = groupList.filter(function (group) { return group.id === target.platformId; })[0];
      if (matched) return matched.id;
    }
    if (fallbackGroupId && groupList.some(function (group) { return group.id === fallbackGroupId; })) {
      return fallbackGroupId;
    }
    return (groupList[0] && groupList[0].id) || '';
  }

  function loadTargetAndStats() {
    if (!state.sessionId) {
      state.target = null;
      broadcast('target:changed', { target: null });
      return loadStats();
    }
    return api.getSessionTarget(state.sessionId).then(function (payload) {
      // 后端出参：{ target, effectiveTarget, targetSource }；旧出参已被 api 层归一化成同形
      state.target = payload && payload.target ? payload.target : null;
      state.effectiveTarget = payload && payload.effectiveTarget ? payload.effectiveTarget : state.target;
      state.targetSource = payload && payload.targetSource ? payload.targetSource : 'none';
      // 群聊跟着「实际生效的目标」走（不是显式绑定，否则新会话会落到旧群）
      var nextGroupId = pickGroupIdForTarget(state.effectiveTarget, state.groups, state.currentGroupId);
      if (nextGroupId) state.currentGroupId = nextGroupId;
      broadcast('target:changed', { target: state.effectiveTarget, groupId: state.currentGroupId });
      return loadStats();
    }).then(function () {
      return loadChat(state.currentGroupId);
    });
  }

  function start() {
    loadPersisted();                                      // R2：读回早于首帧
    document.addEventListener('visibilitychange', handlePageExit);
    window.addEventListener('pagehide', handlePageExit);  // pagehide 的目标是 window，不是 document
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
      return loadGroups();
    }).then(function () {
      return loadTargetAndStats();
    });
  }

  function stop() {
    if (sessionSource) sessionSource.stop();
    document.removeEventListener('visibilitychange', handlePageExit);
    window.removeEventListener('pagehide', handlePageExit);
    flushWrites();
  }

  // ---------- 视图动作 ----------
  function openView(view, groupId) {
    state.view = view || 'list';
    if (groupId) state.currentGroupId = groupId;
    broadcast('view:changed', { view: state.view, groupId: state.currentGroupId });
    if (state.view === 'chat' && state.currentGroupId) return loadChat(state.currentGroupId);
    // 加群页依赖平台清单：每次进入都重取（数据文件可能刚被改过），失败不阻断渲染
    if (state.view === 'add') return loadPlatforms().catch(function () { return state.platforms; });
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
      return loadChat(state.currentGroupId);
    }).then(function () {
      return loadStats();
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
      state.messages = {};
      state.rate = RATE_PLACEHOLDER_TEXT;
    }
    broadcast('session:changed', { sessionId: nextSessionId, previous: previous });
    return loadTargetAndStats();
  }

  function dispatch(action) {
    if (!action || typeof action.type !== 'string') return Promise.resolve();
    switch (action.type) {
      case 'start': return start();
      case 'stop': stop(); return Promise.resolve();
      case 'session-changed': return applySessionChanged(action.sessionId, action.sessionTitle);
      case 'load-groups': return loadGroups();
      case 'load-chat': return loadChat(action.groupId);
      case 'load-stats': return loadStats();
      case 'open-view': return openView(action.view, action.groupId);
      case 'refresh-platforms': return loadPlatforms();
      case 'switch-target': return switchTarget(action.target);
      case 'send-message': return sendMessage(action.text);
      case 'toggle-row': return toggleRow(action.groupId || state.currentGroupId, action.rowIndex);
      case 'set-anchor':
        state.anchor = action.anchor;
        persist(ANCHOR_STORAGE_KEY, JSON.stringify(action.anchor));
        return Promise.resolve();
      case 'view:rebuilt': renderNow(); return Promise.resolve();
      default: return Promise.resolve();
    }
  }

  return {
    getState: function () { return state; },
    getErrors: function () { return state.errors.slice(); },
    subscribe: subscribe,
    dispatch: dispatch,
    start: start,
    stop: stop,
    render: renderNow,
    flush: flushWrites,
    // 对外错误出口：视图层发现"元素缺失 / 显示值为空"这类代码 bug 时调用（契约 §8）
    reportError: function (tag, message) { reportError(tag, message); }
  };
}
