// dock.js —— 把 ui/ 的界面装进宿主：DOM 骨架由 build.cjs 从 ui/index.html 抽取并内联，
// 交互与渲染全部复用 ui/js/*。这里只做三件事：注入骨架、把主窗口默认收起、点「进入群聊界面」时显示主窗口并触发 boot。
// 注意：不要在本地再维护一份骨架字符串——改 ui/index.html 后重跑 node build.cjs 即可。

// 重复挂载保护：宿主 HMR / 重复 apply 时可能已经挂过一份骨架。
// 关键：**复用已有 DOM**，而不是清掉重建——重建出来的新节点没有监听、也不在渲染链路里，
// 会一直停在初始占位（真机表现就是"切会话后面板空白"）。只有旧节点已不在文档里时才重建。
function mountUiDom() {
  var existingHost = document.querySelector(".dmt-host");
  if (existingHost && document.getElementById("floatDock")) {
    mountStyle();
    return existingHost;
  }
  // 孤儿节点（宿主清过 body 但残留单个 #floatDock）：先清掉，保证全局只有一份
  var orphanDock = document.getElementById("floatDock");
  if (orphanDock && orphanDock.parentNode) orphanDock.parentNode.removeChild(orphanDock);

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
  setTimeout(function () {
    if (typeof switchView === "function") switchView("list");
  }, 0);
}

function mountDock() {
  mountStyle();
  var host = mountUiDom();
  dockMountedHost = host;
  // 默认隐藏：首帧 projection 还没到，先不显示；由槽位桥判定后显式打开（降级路径见 apply.js）
  setDockVisibility(false);
  // meta 是异步拉的（契约 02 §2.9，启动取一次）：到达后由 session-bridge 的重算入口落地显隐
  loadTeamMetaOnce();
  // 判定可能发生在 mount 之前（重复 apply / 宿主重建 DOM）：这里补一次最新结论，
  // 否则那次 applyDockDecision 会因为 dockMountedHost 还是 null 被丢掉，显隐停在"隐藏"。
  if (lastDockDecision) applyDockDecision(lastDockDecision);

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

function setDockVisibility(visible) {
  if (!dockMountedHost) return;
  dockMountedHost.style.display = visible === false ? "none" : "";
}

// 槽位桥（session-bridge.js）在 session 作用域里判定"当前是否选中本插件虚拟模型"，结果从这里落下去
function applyDockVisibility(visible) {
  setDockVisibility(visible !== false);
}

// 最近一次判定结论：mount 晚于判定时靠它补应用（见 mountDock）
var lastDockDecision = null;

// 判定结论 → 显隐：'ours' 显示；'degraded'（判不了）也显示，保持降级语义；'other' / 'unknown' 不显示。
// 单独一层是为了让"判定"与"显示策略"分开：桥只管算，显示口径只在这一处。
function applyDockDecision(decision) {
  lastDockDecision = decision;
  applyDockVisibility(decision === "ours" || decision === "degraded");
}
