// store-events.js —— 错误出口 + 事件总线（渲染只由广播触发，契约 docs/13 §3.4/§八）。
// 为什么和 store.js 分开：这两块是"所有模块都要用"的基础设施，留在装配文件里会把
// createTeamStore 撑回几百行；分出来后装配文件只负责接线。

/** 错误出口：预期失败（配额/安全/元素不存在）静默，其余进 state.errors 并留一条 dataset 线索 */
function createErrorSink(options) {
  var state = options.state;

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

  return { isExpectedFailure: isExpectedFailure, reportError: reportError };
}

/** 事件总线：订阅表 + 广播。渲染器作为每个事件的内部订阅者——没有广播就没有渲染 */
function createEventHub(options) {
  var state = options.state;
  var reportError = options.reportError;
  var onRender = options.onRender;

  var listeners = {};
  STORE_EVENTS.forEach(function (eventName) { listeners[eventName] = []; });

  function renderNow() {
    try { onRender(state); }
    catch (error) { reportError('render', error); }
  }

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

  return { renderNow: renderNow, broadcast: broadcast, subscribe: subscribe };
}

/**
 * api.js 的失败上报接线：三类失败（HTTP / JSON / 网络）都进 state.errors；
 * 另外把 /groups 的失败单独留在 sink 里——apiJson 对失败只上报不 reject，
 * 只按 Promise 状态判断会把 500 当成"成功返回空"，界面就继续显示「0 个群」。
 * @returns {{groups: string|null}} 供 loaders 读取的失败直通槽
 */
function createApiFailureSink(options) {
  var reportError = options.reportError;
  var sink = { groups: null };
  if (typeof apiSetErrorReporter !== 'function') return sink;
  apiSetErrorReporter(function (failure) {
    var detail = failure && failure.detail ? String(failure.detail) : 'request failed';
    reportError('api:' + (failure && failure.kind) + ':' + (failure && failure.path), { message: detail });
    if (failure && failure.path === '/groups') {
      // detail 自身已带类别信息（http-status 是「HTTP 500」、json-parse 是解析错误原文），
      // 这里只给其余两类补一个可读前缀，避免出现「HTTP HTTP 500」
      sink.groups = failure.kind === 'http-status'
        ? detail
        : (failure.kind === 'json-parse' ? '数据解析失败：' : '网络异常：') + detail;
    }
  });
  return sink;
}
