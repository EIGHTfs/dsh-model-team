// app.js —— 客户端入口（0.4.0 起）：只做三件事——建 store、把 store 交给主题、订阅"请求完成"事件流。
//
// 为什么这么薄：界面已经**全部**由主题渲染（ui/themes/*.tsx），legacy 的 #viewRoot 渲染层、
// 悬浮件 DOM、加群/通讯录/数据库页的 HTML 拼接都已在 0.4.0 删除。
// 这里保留 boot 的唯一理由是：store 的装配（api 注入、持久化、事件总线）需要一处"只执行一次"的地方，
// 而槽位桥（apply.js）在宿主里拿得到 ctx、却拿不到 DOM 装配时机。
//
// 约束：本文件不出现任何 DOM 结构拼装、不认识任何页面元素。

var store = null;   // boot 时创建；对外通过 window.__teamStore 暴露给主题与验收脚本

function boot() {
  if (window.__dshModelTeamBooted) return;
  window.__dshModelTeamBooted = true;

  store = createTeamStore({
    api: api,
    storage: {
      read: function (key) { return window.localStorage.getItem(key); },
      write: function (key, value) { window.localStorage.setItem(key, value); }
    },
    // 会话 id 由槽位桥（apply.js 注册的 SessionBridge）推进来，不做任何轮询
    sessionSource: null,
    // 主题按 store 事件自行重渲染，这里不需要"重画整页"的钩子
    onRender: function () {}
  });
  window.__teamStore = store;
  // 主题若已在等：主动通知（事件驱动，不轮询）。主题晚挂的情况由它自己读 __teamStore。
  if (typeof window.__dmtThemeAttachStore === "function") window.__dmtThemeAttachStore(store);

  // 请求完成事件流：启动成功后挂一次（唯一订阅点，SSE，不轮询）
  if (!window.__dmtGatewayStream) window.__dmtGatewayStream = attachGatewayStream({ store: store });

  store.dispatch({ type: 'start' }).then(function () {
    assertThemeContract();   // 启动后自检一次主题契约
  });
}

// 主题契约自检（docs/18 §5.2）：主题按需渲染——球隐藏或主窗口收起时锚点还没渲染，
// 不能当成"缺契约"。锚点集合与 check-contract.mjs 的"保留"集合一致。
var DOCK_CONTRACT_SELECTORS = ['#floatBall'];
var WINDOW_CONTRACT_SELECTORS = ['#floatPanel', '#fpHead', '#fpTitle', '#fpEnter', '.team-app', '.team-tabbar', '.team-tab[data-view]'];

function assertThemeContract() {
  var rootSelector = '[data-dmt-theme-host]';
  if (!document.querySelector(rootSelector)) {
    var rootMessage = '主题契约缺少宿主根：' + rootSelector;
    if (store && typeof store.reportError === 'function') store.reportError('theme', rootMessage);
    return [rootSelector];
  }
  var dockVisible = window.__DMT_DOCK__ && window.__DMT_DOCK__.getDockState
    ? window.__DMT_DOCK__.getDockState().visible !== false
    : true;
  var windowRendered = document.querySelector('.tim-app') !== null;
  var selectors = (dockVisible ? DOCK_CONTRACT_SELECTORS : []).concat(windowRendered ? WINDOW_CONTRACT_SELECTORS : []);
  var missing = selectors.filter(function (selector) { return !document.querySelector(selector); });
  if (!missing.length) return missing;
  var message = '主题契约缺少元素：' + missing.join('、');
  if (typeof console !== 'undefined' && typeof console.error === 'function') console.error('[dsh-model-team] ' + message);
  if (store && typeof store.reportError === 'function') store.reportError('theme', message);
  return missing;
}

// 头像图片加载失败的换候选逻辑在 format/avatar-chain.js（同一职责集中一处）
installAvatarErrorFallback();

document.addEventListener('DOMContentLoaded', boot);
