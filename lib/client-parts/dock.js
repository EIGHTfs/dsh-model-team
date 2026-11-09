// dock.js —— 把 ui/ 的界面装进宿主：DOM 骨架由 build.cjs 从 ui/index.html 抽取并内联，
// 交互与渲染全部复用 ui/js/*。这里只做三件事：注入骨架、把主窗口默认收起、点「进入群聊界面」时显示主窗口并触发 boot。
// 注意：不要在本地再维护一份骨架字符串——改 ui/index.html 后重跑 node build.cjs 即可。

// 重复挂载保护：宿主 HMR / 重复 apply 时可能已经挂过一份骨架。
// 关键：**复用已有 DOM**，而不是清掉重建——重建出来的新节点没有监听、也不在渲染链路里，
// 会一直停在初始占位（真机表现就是"切会话后面板空白"）。只有旧节点已不在文档里时才重建。
function mountUiDom() {
  var existingHost = document.querySelector(".dmt-host");
  // 已挂载判据：既有宿主容器 + 主题宿主根（0.4.0 起界面由 [data-dmt-theme-host] 渲染）
  if (existingHost && document.querySelector("[data-dmt-theme-host]")) {
    mountStyle();
    return existingHost;
  }
  // 孤儿主题容器（宿主清过 body 但残留单个主题根）：先清掉，保证全局只有一份
  var orphanThemeHost = document.querySelector("[data-dmt-theme-host]");
  if (orphanThemeHost && orphanThemeHost.parentNode) orphanThemeHost.parentNode.removeChild(orphanThemeHost);

  var host = document.createElement("div");
  host.className = "dmt-host";
  host.innerHTML = UI_SKELETON_HTML;

  // 宿主差异适配：预览页里主窗口常驻，插件里默认收起并给一个「× 收起」按钮
  var timApp = host.querySelector(".team-app");
  if (timApp) {
    timApp.id = "timApp";
    timApp.hidden = true;
  }
  var toolBar = host.querySelector(".team-bar");
  if (toolBar) {
    var closeButton = document.createElement("button");
    closeButton.id = "btnCloseApp";
    closeButton.type = "button";
    closeButton.className = "team-bar-btn";
    closeButton.textContent = "× 收起";
    toolBar.appendChild(closeButton);
  }

  document.body.appendChild(host);
  mountStyle();
  return host;
}

// 主窗口显隐：ui 的主窗口在预览页是常驻的，宿主里默认收起
function showAppWindow() {
  var timApp = document.getElementById("timApp");
  if (!timApp) return;
  timApp.hidden = false;
}

// ui 自己的 fpEnter 会调 openChat(currentGroupId)，空会话时进不去群聊；
// 这里延后一拍再切回群列表，保证「进入群聊界面」落地就是列表视图
function enterListView() {
  showAppWindow();
  // 只等"当前调用栈走完"（ui 的 fpEnter 会在同一栈里调 openChat）——微任务即可，不用定时器
  Promise.resolve().then(function () {
    if (typeof switchView === "function") switchView("list");
  });
}

function mountDock() {
  mountStyle();
  var host = mountUiDom();
  dockMountedHost = host;
  // 装配：把"写 DOM"的两个动作注册给状态工厂（显隐 + 位置），随后由工厂 reapply 统一落地。
  // 这样判定发生在 mount 之前也不会丢——工厂记着值，mount 后重放一次即可。
  registerDockAppliers({
    visibility: setDockVisibility,
    anchor: function (anchor) {
      if (typeof applyDockAnchor === "function") applyDockAnchor(anchor);
    },
  });
  // 默认隐藏：首帧 projection 还没到，先不显示；由槽位桥判定后显式打开（降级路径见 apply.js）
  setDockVisible(false);
  reapplyDockDom();
  // meta 是异步拉的（契约 02 §2.9，启动取一次）：到达后由 session-bridge 的重算入口落地显隐
  loadTeamMetaWithRetry();

  var appBooted = false;
  function bootUiOnce() {
    if (appBooted) return;
    appBooted = true;
    resolveSessionId().then(function (sessionId) {
      MOCK_SESSION_ID = sessionId;          // ui 分片靠这个名字取会话
      if (typeof boot === "function") boot(); // app.js：拉数据 + initFloatStats + render
    });
  }
  bootUiOnce();

  var enterButton = document.getElementById("fpEnter");
  var contactsButton = document.getElementById("btnContacts");
  var closeAppButton = document.getElementById("btnCloseApp");
  function onEnter() { enterListView(); }
  function onContacts() { showAppWindow(); if (typeof switchView === "function") switchView("contacts"); }
  function onCloseApp() { hideAppWindow(); }
  if (enterButton) enterButton.addEventListener("click", onEnter);
  if (contactsButton) contactsButton.addEventListener("click", onContacts);
  if (closeAppButton) closeAppButton.addEventListener("click", onCloseApp);

  return {
    dispose: function () {
      if (enterButton) enterButton.removeEventListener("click", onEnter);
      if (contactsButton) contactsButton.removeEventListener("click", onContacts);
      if (closeAppButton) closeAppButton.removeEventListener("click", onCloseApp);
      var styleTag = document.querySelector('style[data-plugin-css="' + CLIENT_STYLE_ID + '"]');
      if (styleTag) styleTag.remove();
      host.remove();
    }
  };
}

function hideAppWindow() {
  var timApp = document.getElementById("timApp");
  if (timApp) timApp.hidden = true;
}

// INV-14：悬浮窗（球 + 面板 + 呼出条）整体显隐。
// 只是切 display，不动 DOM、不销毁监听：反复切换不会重启 UI、也不会丢事件（挂载生命周期保持不变）。
var dockMountedHost = null;

// 只切换**悬浮件**的显隐，不碰整个宿主容器：.dmt-host 里还装着主窗口，
// 把容器 display:none 会连主窗口一起藏掉（实测：会话/输入框全都拿不到焦点）。
//
// 落点（0.4.0 起）：主题宿主根 [data-dmt-theme-host] 上的 data-dock-visible 属性。
// 主题自己用 CSS 响应它（[data-dock-visible="false"] .tim-ball-anchor { display: none }），
// 客户端不再依赖 legacy 骨架里的 #floatDock —— 那个节点会在步 5~7 随 ui/index.html 一起消失。
function setDockVisibility(visible) {
  var themeHost = document.querySelector("[data-dmt-theme-host]");
  if (themeHost) {
    themeHost.setAttribute("data-dock-visible", visible === false ? "false" : "true");
    return;
  }
  // 主题宿主还不存在（主题未挂载 / legacy 路径）时才退回容器级兜底，
  // 保证不会残留一个"判了隐藏却还显示"的入口
  if (!dockMountedHost) return;
  dockMountedHost.style.display = visible === false ? "none" : "";
}

// 槽位桥（session-bridge.js）在 session 作用域里判定"当前是否选中本插件虚拟模型"。
// 注意：这里只是把结论**写进状态工厂**，不直接改 DOM——DOM 由注册的 applier 统一落地。
function applyDockVisibility(visible) {
  setDockVisible(visible !== false);
}

// 判定结论 → 显隐：**只有 'ours' 显示**。
// 'degraded'（判不了）与 'unknown'（还不知道）一律隐藏：契约 INV-14 的口径是
// "任一输入在重试后仍不可用则判为不可知并隐藏"——宁可少显示，也不把不属于本插件的入口摆给用户。
// 'degraded' 仍保留在判定结果里，只用于日志区分"为什么隐藏"。
// 单独一层是为了让"判定"与"显示策略"分开：桥只管算，显示口径只在这一处。
function isDockVisibleForDecision(decision) {
  return decision === "ours";
}

// 判定结果只往状态工厂写一次，DOM 由工厂的 reapply 统一落地（R1：这里不留显示副本）
function applyDockDecision(decision) {
  setDockVisible(isDockVisibleForDecision(decision));
}
