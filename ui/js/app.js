// app.js —— 视图层：只读 store 状态 + 渲染 + 事件委托。所有写入走 store.dispatch（契约 docs/13）。
// 渲染只有一个出口 renderApp(state)：由 store 在事件广播后调用；视图内的"我还想重画"用 store.render()。

var store = null;                          // boot 时创建
var state = null;                          // store.getState() 的只读引用（视图取值用）
var viewState = {                          // 纯 UI 局部状态（表单草稿 / @ 选择器 / 搜索词），不参与业务真相
  addForm: { platformId: '', name: '', values: {} },   // platformId 对应 /_team/platforms 里的平台
  // 模型目录（只在加群页用，不进全局 store）：mode=auto 提交走 endpoint，manual 提交走 static
  modelCatalog: { mode: 'auto', models: [], probe: { loading: false, error: '' } },
  atPicker: { open: false, activeIndex: 0, triggerIndex: -1, items: [] },
  groupFilter: ''
};

// ---------------------------------------------------------------- 基础工具
const CLOCK_PAD_WIDTH = 2;
const TOAST_VISIBLE_MS = 2200;

function findElement(selector) { return document.querySelector(selector); }
function findElements(selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); }

function nowTime() {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(function (value) { return String(value).padStart(CLOCK_PAD_WIDTH, '0'); }).join(':');
}

function toast(text) {
  // 宿主壳不保证带 #toast 节点（实测：全仓没有任何地方创建它，导致所有提示静默丢失）。
  // 这里懒创建：样式在 ui/css/panels.css 的 .toast，挂到 body 上即可用。
  let toastNode = findElement('#toast');
  if (!toastNode) {
    toastNode = document.createElement('div');
    toastNode.id = 'toast';
    toastNode.className = 'toast';
    document.body.appendChild(toastNode);
  }
  toastNode.textContent = text;
  toastNode.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(function () { toastNode.classList.remove('show'); }, TOAST_VISIBLE_MS);
}

function showModal(title, bodyHtml) {
  const modalMask = document.createElement('div');
  modalMask.className = 'modal-mask';
  modalMask.innerHTML = `<div class="modal">
    <div class="modal-head"><span>${escapeHtml(title)}</span><button class="modal-close" id="modalClose" type="button">×</button></div>
    <div class="modal-body">${bodyHtml}</div>
  </div>`;
  document.body.appendChild(modalMask);
  findElement('#modalClose').addEventListener('click', function () { modalMask.remove(); });
  modalMask.addEventListener('click', function (event) {
    if (event.target === modalMask) modalMask.remove();
  });
  // 交回遮罩节点：调用方要往弹窗里装表单、重画正文（好友分组表单就这么用）
  return modalMask;
}

// ---------------------------------------------------------------- 读取辅助（只读 state）
function ensureState() {
  if (!state && store) state = store.getState();
  return state;
}

function currentGroup() {
  const current = ensureState();
  if (!current) return null;
  return current.groups.filter(function (group) { return group.id === current.currentGroupId; })[0] || current.groups[0] || null;
}
function currentMessages() {
  const current = ensureState();
  return (current && current.messages[current.currentGroupId]) || [];
}
function modelsOf(groupId) {
  const current = ensureState();
  return (current && current.models[groupId]) || [];
}
// 「接活平台」= effectiveTarget 所属群对应的平台（不是当前打开的群）。
// 为什么要在渲染出口算：球上的头像代表"这次请求会发给谁"，目标切到别的群时头像必须跟着走；
// 在 float.js 里重新推导一遍群列表会与这里形成第二个真相源。
function activePlatformInfo(current) {
  const target = current && current.effectiveTarget;
  if (!target) return null;
  if (target.type === 'model' && target.platformId) {
    const targetGroup = (current.groups || []).filter(function (group) {
      return group.id === target.platformId;
    })[0];
    return platformOf(targetGroup);
  }
  // 分组跨平台，没有唯一平台：给一个中性名字，首字母牌显示「好」
  if (target.type === 'group') return { avatar: '', name: '好友分组' };
  return null;
}

function platformOf(group) {
  const current = ensureState();
  if (!group || !current) return null;
  // GET /_team/groups 的驱动字段名是 driver（契约 02 §3.1：写入与读出同名）；
  // 旧代码只读 driverId → 平台名恒空、球内字母牌回落成 "?"。两处都认，避免再被字段名绊一次。
  const driverKey = group.driverId || group.driver;
  const drivers = (current && current.drivers) || [];
  const driver = drivers.filter(function (item) { return item.id === driverKey; })[0];
  return {
    avatar: group.avatar || (driver ? driver.avatar : '[G]'),
    // 驱动名形如「OpenAI 兼容（配置型）」：去掉全角/半角括号里的补充说明，只留主名
    name: driver ? String(driver.name).split(/[（(]/)[0].trim() : (driverKey || '')
  };
}
// 目标文案：分组 → @分组名；单模型 → 模型名（去 global: 前缀）；空 → —
// 目标显示名：用「实际生效的目标」（effectiveTarget），不是本会话显式绑定的 target。
// 否则新会话（未绑定）会出现"面板有目标、球是 —"的不一致。
function targetLabel() {
  const current = ensureState();
  const target = current && (current.effectiveTarget || current.target);
  // 文案口径在 ui-format.js（唯一实现）
  return formatTargetLabel(target, current ? current.friendGroups : []);
}

// 来源提示：只有「本会话没显式绑定、由后端回落」时才显示（浅色小字，跟在目标名后面）。
// 文案映射与请求卡片共用 ui/js/target-source.js，两处各写一份必然漂移。
function targetSourceHint() {
  const current = ensureState();
  if (!current || !current.effectiveTarget) return '';
  if (current.target) return '';                       // 显式绑定过 → 不带提示
  return targetSourceHintOf(current.targetSource);
}

// ---------------------------------------------------------------- 渲染（唯一出口）
// options.keepChatScroll：展开请求行时保持聊天区滚动位置
function renderApp(nextState, options) {
  if (nextState) state = nextState;
  const current = ensureState();
  if (!current) return;

  const viewRoot = findElement('#viewRoot');
  if (!viewRoot) return;
  const viewName = findElement('#viewName');
  const previousStream = findElement('#chatStream');
  const keptScrollTop = options && options.keepChatScroll && previousStream ? previousStream.scrollTop : null;

  if (current.view === 'chat' && !current.currentGroupId) {
    viewRoot.innerHTML = '<div class="loading">正在加载会话…</div>';
    return;
  }

  if (current.view === 'list') {
    // 过滤口径在 list-rules.js（name/summary/driver/id 任一命中，大小写不敏感）
    const visibleGroups = filterGroups(current.groups, viewState.groupFilter);

    // 焦点只在"本来就在搜索框里"时恢复：不能无条件 focus，
    // 否则每次进群聊界面都会把焦点塞进搜索框（移动端直接弹键盘）。
    const activeElement = document.activeElement;
    const hadSearchFocus = !!activeElement && activeElement.id === 'groupSearch';
    const caretStart = hadSearchFocus ? activeElement.selectionStart : null;
    const caretEnd = hadSearchFocus ? activeElement.selectionEnd : null;

    viewRoot.innerHTML = renderGroupList(
      visibleGroups,
      current.currentGroupId,
      viewState.groupFilter || '',
      { loadError: current.lastGroupsError || (current.groups && current.groups.length ? '' : '') },
    );

    if (hadSearchFocus) {
      const searchInput = findElement('#groupSearch');
      if (searchInput) {
        searchInput.focus();
        // 光标位置原样恢复：直接 focus 会把光标甩到末尾，连续输入时体验很差
        if (caretStart !== null && caretEnd !== null) searchInput.setSelectionRange(caretStart, caretEnd);
      }
    }
    viewName.textContent = '消息';
  } else if (current.view === 'chat') {
    const activeGroup = currentGroup();
    viewRoot.innerHTML = renderChat(
      activeGroup,
      modelsOf(activeGroup.id),
      currentMessages(),
      platformOf(activeGroup),
      current.modelsStatus ? current.modelsStatus[activeGroup.id] : undefined,
    );
    viewName.textContent = '群聊';
  } else if (current.view === 'add') {
    const addFormSnapshot = viewState.addForm.skipRestoreOnce ? null : captureAddFormSnapshot();
    viewRoot.innerHTML = renderAddGroup(
      current.platforms,
      current.drivers,
      viewState.addForm.platformId,
      viewState.addForm.values,
      viewState.addForm.name,
      viewState.modelCatalog,
      reversePanelState()
    );
    restoreAddFormSnapshot(addFormSnapshot);
    viewState.addForm.skipRestoreOnce = false;
    viewName.textContent = '加群';
    loadReverseAccountsForAddForm();
  } else if (current.view === 'contacts') {
    // 成员头像/来自谁只跟平台群有关（member.platformId 是群 id），不再传 drivers
    viewRoot.innerHTML = renderAddressBook(current.friendGroups, current.groups);
    viewName.textContent = '通讯录';
  } else {
    viewRoot.innerHTML = renderProfile(current.groups);
    viewName.textContent = '我的';
  }

  const chatStream = findElement('#chatStream');
  if (chatStream) chatStream.scrollTop = keptScrollTop == null ? chatStream.scrollHeight : keptScrollTop;

  // 悬浮窗（球/标题/目标/pill/统计）也由同一个渲染出口派生，不再有"手动补丁"函数
  renderFloat(current, activePlatformInfo(current));
  renderTabs(current);
}

// 主题契约自检（docs/18 §5.2）：换主题时立刻知道漏了哪个钩子。
// 缺失只 console.error + 记入 store 错误出口，不阻断启动。
const THEME_CONTRACT_SELECTORS = [
  '#floatDock', '#floatBall', '#floatPanel',
  '#fpSession', '#fpModel', '#fpTarget', '#fpRate', '#fpTotal', '#fpEnter',
  '#viewRoot', '.team-app', '.team-tabbar', '.team-tab[data-view]'
];

function assertThemeContract() {
  const missing = THEME_CONTRACT_SELECTORS.filter(function (selector) {
    return !document.querySelector(selector);
  });
  if (!missing.length) return missing;
  const message = '主题契约缺少元素：' + missing.join('、');
  if (typeof console !== 'undefined' && typeof console.error === 'function') {
    console.error('[dsh-model-team] ' + message);
  }
  if (store && typeof store.reportError === 'function') store.reportError('theme', message);
  return missing;
}

// 底边栏选中态：chat/add 都归到「消息」tab，其余按 view 一一对应（契约条款 22）
const TAB_VIEW_BY_STATE = { list: 'list', chat: 'list', add: 'list', contacts: 'contacts', profile: 'profile' };

function renderTabs(current) {
  const activeTabView = TAB_VIEW_BY_STATE[current.view] || 'list';
  findElements('.team-tab').forEach(function (tab) {
    tab.setAttribute('aria-selected', tab.dataset.view === activeTabView ? 'true' : 'false');
  });
}

// ---------------------------------------------------------------- 视图动作（只发 dispatch）
function switchView(nextView) {
  closeAtPop();
  if (nextView !== 'add') stopReversePoll();
  store.dispatch({ type: 'open-view', view: nextView });
}

function openChat(groupId) {
  closeAtPop();
  store.dispatch({ type: 'open-view', view: 'chat', groupId: groupId });
}

function rerender() {
  if (store) store.render();
}

// ---------------------------------------------------------------- 事件委托
// 全部挂在稳定的容器上：#viewRoot（视图内容）+ .team-tabbar（底边栏），render() 重建内容后无需重绑
function initViewEvents() {
  const viewRoot = findElement('#viewRoot');

  // 头像图片加载失败（404 / 域名不可达）→ 降级为文本占位，避免出现破图。
  // error 事件不冒泡，必须用捕获阶段监听；节点由 renderAvatar() 生成（带 data-fallback）。
  document.addEventListener('error', function (event) {
    const failedImage = event.target;
    if (!failedImage || failedImage.tagName !== 'IMG' || !failedImage.classList.contains('avatar-img')) return;
    const fallback = document.createElement('span');
    fallback.className = 'avatar-fallback';
    fallback.textContent = failedImage.dataset.fallback || '?';
    if (failedImage.parentNode) failedImage.parentNode.replaceChild(fallback, failedImage);
  }, true);

  // 底边栏三 tab：点击即切视图（契约条款 21-24）；顶栏不再有通讯录/数据库按钮
  const tabBar = findElement('.team-tabbar');
  if (tabBar) {
    tabBar.addEventListener('click', function (event) {
      const tab = event.target.closest('.team-tab');
      if (!tab || !tab.dataset.view) return;
      store.dispatch({ type: 'open-view', view: tab.dataset.view });
    });
  }

  viewRoot.addEventListener('click', function (event) {
    // 点消息流头像 = 快捷插入 @名字
    const mentionAvatar = event.target.closest('[data-mention]');
    if (mentionAvatar) {
      const messageInput = findElement('#msgInput');
      if (messageInput) {
        messageInput.value = messageInput.value.replace(/@[^\s]*$/, '') + '@' + mentionAvatar.dataset.mention + ' ';
        messageInput.focus();
        closeAtPop();
      }
      return;
    }
    const requestBubble = event.target.closest('.req-bubble');
    if (requestBubble) {
      const rowIndex = Number(requestBubble.dataset.rowIndex);
      store.dispatch({ type: 'toggle-row', groupId: state.currentGroupId, rowIndex: rowIndex })
        .then(function () {
          renderApp(null, { keepChatScroll: true });
          const expandedBubble = findElement('.req-bubble[data-row-index="' + rowIndex + '"]');
          if (expandedBubble && expandedBubble.getAttribute('aria-expanded') === 'true') {
            expandedBubble.scrollIntoView({ block: 'nearest' });
          }
        });
      return;
    }
    const groupItem = event.target.closest('.group-item');
    if (groupItem) { openChat(groupItem.dataset.groupId); return; }
    // 通讯录：新建 / 编辑好友分组都走同一个弹窗（表单与校验在 friend-group-form.js）
    if (event.target.closest('#btnCreateGroup')) { openFriendGroupModal('create', null); return; }
    const editGroupButton = event.target.closest('[data-edit-group]');
    if (editGroupButton) {
      const friendGroupsNow = (ensureState() || { friendGroups: [] }).friendGroups;
      const editingFriendGroup = friendGroupsNow.filter(function (friendGroup) {
        return friendGroup.id === editGroupButton.dataset.editGroup;
      })[0];
      if (editingFriendGroup) openFriendGroupModal('edit', editingFriendGroup);
      return;
    }
    const atItem = event.target.closest('.at-item');
    if (atItem) {
      const picked = viewState.atPicker.items[Number(atItem.dataset.index)];
      if (picked) insertMention(picked);
      return;
    }

    // 模型目录：删行
    const removeModelButton = event.target.closest('[data-model-remove]');
    if (removeModelButton) {
      removeModelRow(Number(removeModelButton.dataset.modelRemove));
      return;
    }

    const clickedButton = event.target.closest('button');
    const buttonId = clickedButton ? clickedButton.id : '';
    if (buttonId === 'btnProbeModels') { probeModelCatalog(); return; }
    if (buttonId === 'btnResetModels') { resetModelCatalog(); return; }
    if (buttonId === 'btnReloadGroups') { store.dispatch({ type: 'load-groups' }); return; }
    if (buttonId === 'btnAddModelRow') { addModelRow(); return; }
    if (buttonId === 'btnAddGroup') switchView('add');
    else if (buttonId === 'btnChatBack' || buttonId === 'btnAddBack' || buttonId === 'btnDatabaseBack' || buttonId === 'btnContactsBack') switchView('list');
    else if (buttonId === 'btnAt') {
      const messageInput = findElement('#msgInput');
      if (messageInput) { messageInput.focus(); openAtPop(); }
    }
    else if (buttonId === 'btnSend') sendMessage();
    else if (buttonId === 'btnSubmitGroup') submitNewGroup();
    else if (buttonId === 'btnReverseLogin') startReverseLogin();
    else if (buttonId === 'btnExport') exportDatabase();
    else if (buttonId === 'btnImport') importDatabase();
  });

  viewRoot.addEventListener('input', function (event) {
    const target = event.target;
    // 模型目录行：就地更新数据，不重渲染（否则输入框会失焦）
    if (target.dataset && target.dataset.modelId !== undefined) {
      const modelIndex = Number(target.dataset.modelId);
      if (viewState.modelCatalog.models[modelIndex]) {
        viewState.modelCatalog.models[modelIndex].id = target.value;
        viewState.modelCatalog.mode = 'manual';
      }
      return;
    }
    if (target.dataset && target.dataset.modelName !== undefined) {
      const nameIndex = Number(target.dataset.modelName);
      if (viewState.modelCatalog.models[nameIndex]) {
        viewState.modelCatalog.models[nameIndex].name = target.value;
      }
      return;
    }
    if (target.id === 'msgInput') syncAtByInput(target);
    else if (target.id === 'groupSearch') {
      viewState.groupFilter = target.value;
      rerender();
    }
    else if (target.id === 'groupNameInput') { viewState.addForm.name = target.value; viewState.addForm.nameEdited = true; }
    else if (target.dataset && target.dataset.authKey) viewState.addForm.values[target.dataset.authKey] = target.value;
  });

  viewRoot.addEventListener('change', function (event) {
    if (event.target.id === 'reverseAccountSelect') { reversePanelState().selectedAccountId = event.target.value; return; }
    if (event.target.id === 'platformSelect') {
      // 切换平台：清掉上一平台填过的值，让 renderAddGroup 用新平台的默认值重新预填；
      // 模型目录也重置（模型属于平台，不能沿用上一个平台的目录）
      stopReversePoll(); resetReversePanel();
      viewState.addForm.platformId = event.target.value;
      viewState.addForm.values = {};
      if (!viewState.addForm.nameEdited) viewState.addForm.name = '';   // 手改过的名字切平台时保留
      viewState.addForm.skipRestoreOnce = true;                          // 切平台要按新平台重新预填
      viewState.modelCatalog = { mode: 'auto', models: [], probe: { loading: false, error: '' } };
      rerender();
      return;
    }
    const authFieldKey = event.target.dataset ? event.target.dataset.authKey : '';
    if (authFieldKey && event.target.tagName === 'SELECT') {
      viewState.addForm.values[authFieldKey] = event.target.value;
      rerender();
    }
  });

  viewRoot.addEventListener('submit', function (event) {
    if (event.target.id === 'addGroupForm') {
      event.preventDefault();
      submitNewGroup();
    }
  });

  // Enter 发送 / Shift+Enter 换行；@ 选择器打开时 Enter 上屏选中项
  viewRoot.addEventListener('keydown', function (event) {
    if (event.target.id !== 'msgInput') return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (viewState.atPicker.open) {
        const pickedItem = viewState.atPicker.items[viewState.atPicker.activeIndex];
        if (pickedItem) insertMention(pickedItem);
        return;
      }
      sendMessage();
      return;
    }
    if (!viewState.atPicker.open) return;
    const pickerItems = viewState.atPicker.items;
    if (!pickerItems.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      viewState.atPicker.activeIndex = (viewState.atPicker.activeIndex + 1) % pickerItems.length;
      syncAtActive();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      viewState.atPicker.activeIndex = (viewState.atPicker.activeIndex - 1 + pickerItems.length) % pickerItems.length;
      syncAtActive();
    } else if (event.key === 'Escape') {
      closeAtPop();
    }
  });
}

// ---------------------------------------------------------------- 启动
function boot() {
  if (window.__dshModelTeamBooted) return;
  window.__dshModelTeamBooted = true;

  initDrag();
  initFloatControls();
  initViewEvents();

  store = createTeamStore({
    api: api,
    storage: {
      read: function (key) { return window.localStorage.getItem(key); },
      write: function (key, value) { window.localStorage.setItem(key, value); }
    },
    // 会话 id 由槽位桥（apply.js 注册的 SessionBridge）推进来，不做任何轮询
    sessionSource: null,
    onRender: function (nextState) { renderApp(nextState); }
  });
  window.__teamStore = store;            // 供验收脚本读取 errors / state
  // 主题若已在等：主动通知（事件驱动，不轮询）。主题晚挂的情况由它自己读 __teamStore。
  if (typeof window.__dmtThemeAttachStore === "function") window.__dmtThemeAttachStore(store);

  const viewRoot = findElement('#viewRoot');
  if (viewRoot) viewRoot.innerHTML = '<div class="loading">正在加载模型团队数据…</div>';

  store.dispatch({ type: 'start' }).then(function () {
    const current = store.getState();
    // 请求完成事件流：启动成功后挂一次（唯一订阅点，SSE，不轮询）
    if (!window.__dmtGatewayStream) window.__dmtGatewayStream = attachGatewayStream({ store: store });
    // 默认选中第一项：优先平台预置（preset:<id>），没有预置则用第一个驱动的通用入口（driver:<id>）
    if (!viewState.addForm.platformId) {
      if (current.platforms.length) viewState.addForm.platformId = 'preset:' + current.platforms[0].id;
      else if (current.drivers.length) viewState.addForm.platformId = 'driver:' + current.drivers[0].id;
    }
    assertThemeContract();   // 启动后自检一次主题契约
  });
}

// 头像图片加载失败的换候选逻辑在 format/avatar-chain.js（同一职责集中一处）
installAvatarErrorFallback();

document.addEventListener('DOMContentLoaded', boot);
