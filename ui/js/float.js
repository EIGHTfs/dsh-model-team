// float.js —— 悬浮球与悬浮面板：定位、开合、关闭与召回、拖拽。
// 球常驻屏幕、可拖动；点球展开统计面板；× 关闭后留一个「呼出模型团队」入口。
// 拖动：球用 transform 单帧跟随（rAF 合并，不重排），松手才落 left/top 并持久化锚点；
//       面板标题条拖动仍直接改 left/top（面板位置不持久化）。

const PANEL_GAP_PX = 12;             // 面板与球的间距
const VIEWPORT_MARGIN_PX = 12;       // 面板离视口边缘的最小距离
const DRAG_THRESHOLD_PX = 4;         // 位移超过它才算拖动，否则视为点击
const DOCK_EDGE_KEEP_PX = 8;         // 球离视口边缘的最小距离
const BALL_VIEWPORT_KEEP_PX = 70;    // 球本身占位，避免拖出可视区
const PANEL_FALLBACK_WIDTH = 384;    // 面板未渲染完成时的兜底尺寸
const PANEL_FALLBACK_HEIGHT = 210;

let dragState = null;                // 当前拖动上下文（球或面板）
let dragFrameId = 0;                 // rAF 句柄：同一帧只写一次 transform
let dragPendingPosition = null;      // 等待写入的位置
let dockElement = null;              // 缓存球容器，拖动中不逐帧 querySelector

// 面板贴在球左上方，上方放不下就翻到下方，最后夹进视口
function positionPanel() {
  const floatPanel = findElement('#floatPanel');
  const floatDock = findElement('#floatDock');
  if (!floatPanel || !floatDock || floatPanel.classList.contains('hidden')) return;
  const dockRect = floatDock.getBoundingClientRect();
  const panelWidth = floatPanel.offsetWidth || PANEL_FALLBACK_WIDTH;
  const panelHeight = floatPanel.offsetHeight || PANEL_FALLBACK_HEIGHT;
  let leftPosition = dockRect.right - panelWidth;
  let topPosition = dockRect.top - panelHeight - PANEL_GAP_PX;
  if (topPosition < VIEWPORT_MARGIN_PX) topPosition = dockRect.bottom + PANEL_GAP_PX;
  leftPosition = Math.max(VIEWPORT_MARGIN_PX, Math.min(leftPosition, window.innerWidth - panelWidth - VIEWPORT_MARGIN_PX));
  topPosition = Math.max(VIEWPORT_MARGIN_PX, Math.min(topPosition, window.innerHeight - panelHeight - VIEWPORT_MARGIN_PX));
  floatPanel.style.left = leftPosition + 'px';
  floatPanel.style.top = topPosition + 'px';
}

function showPanel() {
  findElement('#floatPanel').classList.remove('hidden');
  positionPanel();
}

function hidePanel() {
  findElement('#floatPanel').classList.add('hidden');
}

// 锚点只从 store 读（契约 R1：持久化项的唯一真相源在工厂，视图不再自己读写 localStorage）
function readDockAnchor() {
  const current = ensureState();
  const anchor = current && current.anchor;
  if (!anchor || typeof anchor.left !== 'number' || typeof anchor.top !== 'number') return null;
  const maxLeft = window.innerWidth - BALL_VIEWPORT_KEEP_PX;
  const maxTop = window.innerHeight - BALL_VIEWPORT_KEEP_PX;
  if (anchor.left < DOCK_EDGE_KEEP_PX || anchor.top < DOCK_EDGE_KEEP_PX) return null;
  if (anchor.left > maxLeft || anchor.top > maxTop) return null;
  return { left: anchor.left, top: anchor.top };
}

// 存锚点走工厂（去抖 150ms + 退出 flush 由 store 负责）
function saveDockAnchor(anchor) {
  if (store) store.dispatch({ type: 'set-anchor', anchor: anchor });
}

// 落位：清 transform、写 left/top（只在松手/恢复锚点时发生）
function commitDockPosition(left, top) {
  const floatDock = findElement('#floatDock');
  if (!floatDock) return;
  floatDock.style.transform = '';
  floatDock.style.left = left + 'px';
  floatDock.style.top = top + 'px';
  positionPanel();
}

// 同一帧多次 pointermove 只写一次：球写 transform，面板写 left/top
function scheduleDockFrame(left, top) {
  dragPendingPosition = { left: left, top: top };
  if (dragFrameId) return;
  dragFrameId = requestAnimationFrame(function () {
    dragFrameId = 0;
    if (!dragPendingPosition || !dragState || !dockElement) return;
    const nextPosition = dragPendingPosition;
    const startRect = dragState.startRect;
    if (dragState.kind === 'panel') {
      const floatPanel = findElement('#floatPanel');
      if (floatPanel) {
        floatPanel.style.left = nextPosition.left + 'px';
        floatPanel.style.top = nextPosition.top + 'px';
      }
      return;
    }
    dockElement.style.transform = 'translate3d('
      + Math.round(nextPosition.left - startRect.left) + 'px, '
      + Math.round(nextPosition.top - startRect.top) + 'px, 0)';
  });
}

// 松手前把最后一帧立刻写出去：只 cancel 会丢掉最后一次 pointermove 的位移
function flushDockFrame() {
  if (dragFrameId) {
    cancelAnimationFrame(dragFrameId);
    dragFrameId = 0;
    if (dragPendingPosition && dragState && dockElement) {
      const nextPosition = dragPendingPosition;
      const startRect = dragState.startRect;
      if (dragState.kind === 'panel') {
        const floatPanel = findElement('#floatPanel');
        if (floatPanel) {
          floatPanel.style.left = nextPosition.left + 'px';
          floatPanel.style.top = nextPosition.top + 'px';
        }
      } else {
        dockElement.style.transform = 'translate3d('
          + Math.round(nextPosition.left - startRect.left) + 'px, '
          + Math.round(nextPosition.top - startRect.top) + 'px, 0)';
      }
    }
  }
  dragPendingPosition = null;
}

// 拖拽：超过阈值才算拖动；球没被拖动时松手视为点击，切换面板开合
function initDrag() {
  const floatDock = findElement('#floatDock');
  dockElement = floatDock;             // 缓存给 rAF 回调，拖动中不再 querySelector
  const floatBall = findElement('#floatBall');
  const floatPanel = findElement('#floatPanel');
  const panelHead = findElement('#fpHead');

  // 锚点恢复不在这里做：initDrag 早于 store 创建，读不到 state.anchor；
  // 由首帧渲染后的 applyStoredAnchorOnce() 统一落位（见下）。

  floatBall.addEventListener('pointerdown', function (event) {
    event.preventDefault();
    // 这里只记录"按下时面板是开还是关"，不立刻收起：
    // 立刻收起会让 pointerup 的 toggle 永远走"展开"，点球就收不起来了（只能重复展开）。
    dragState = {
      kind: 'ball',
      startX: event.clientX,
      startY: event.clientY,
      startRect: floatDock.getBoundingClientRect(),
      panelWasOpen: !floatPanel.classList.contains('hidden'),
      moved: false,
      last: null
    };
    try { floatDock.setPointerCapture(event.pointerId); } catch (error) { /* 捕获失败不影响拖动 */ }
  });

  panelHead.addEventListener('pointerdown', function (event) {
    if (event.target.closest('.fp-btn')) return;
    event.preventDefault();
    dragState = {
      kind: 'panel',
      startX: event.clientX,
      startY: event.clientY,
      startRect: floatPanel.getBoundingClientRect(),
      moved: false
    };
  });

  document.addEventListener('pointermove', function (event) {
    if (!dragState) return;
    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;
    if (!dragState.moved) {
      if (Math.abs(deltaX) + Math.abs(deltaY) <= DRAG_THRESHOLD_PX) return;
      dragState.moved = true;
      floatDock.classList.add('is-dragging');
      // 真正进入拖动才收起面板：球动而面板停在原地会显得"拖不动"
      if (dragState.kind === 'ball' && dragState.panelWasOpen) hidePanel();
    }

    if (dragState.kind === 'panel') {
      const nextLeft = Math.max(VIEWPORT_MARGIN_PX, Math.min(dragState.startRect.left + deltaX, window.innerWidth - floatPanel.offsetWidth - VIEWPORT_MARGIN_PX));
      const nextTop = Math.max(VIEWPORT_MARGIN_PX, Math.min(dragState.startRect.top + deltaY, window.innerHeight - floatPanel.offsetHeight - VIEWPORT_MARGIN_PX));
      dragState.last = { left: nextLeft, top: nextTop };
      scheduleDockFrame(nextLeft, nextTop);
      return;
    }

    const nextLeft = Math.max(DOCK_EDGE_KEEP_PX, Math.min(dragState.startRect.left + deltaX, window.innerWidth - BALL_VIEWPORT_KEEP_PX));
    const nextTop = Math.max(DOCK_EDGE_KEEP_PX, Math.min(dragState.startRect.top + deltaY, window.innerHeight - BALL_VIEWPORT_KEEP_PX));
    dragState.last = { left: nextLeft, top: nextTop };
    scheduleDockFrame(nextLeft, nextTop);
  });

  document.addEventListener('pointerup', function () {
    if (!dragState) return;
    const finishedDrag = dragState;
    dragState = null;
    floatDock.classList.remove('is-dragging');
    // 没超过阈值 = 点击：按"按下时"的状态切换，开着就关、关着就开
    if (!finishedDrag.moved) {
      if (finishedDrag.panelWasOpen) hidePanel(); else showPanel();
      return;
    }
    flushDockFrame();                    // 最后一帧不能丢，否则手感"差一点"
    if (finishedDrag.kind !== 'ball') return;
    const targetPosition = finishedDrag.last || { left: finishedDrag.startRect.left, top: finishedDrag.startRect.top };
    commitDockPosition(targetPosition.left, targetPosition.top);
    saveDockAnchor({ left: Math.round(targetPosition.left), top: Math.round(targetPosition.top) });
  });
}

// 面板按钮：收起 / 关闭整个悬浮窗 / 进群聊，以及关闭后的召回
function initFloatControls() {
  findElement('#fpMin').addEventListener('click', hidePanel);
  findElement('#fpClose').addEventListener('click', function () {
    hidePanel();
    findElement('#floatDock').classList.add('hidden');
    findElement('#floatRecall').classList.remove('hidden');
  });
  findElement('#floatRecall').addEventListener('click', function () {
    findElement('#floatDock').classList.remove('hidden');
    findElement('#floatRecall').classList.add('hidden');
    showPanel();
  });
  findElement('#fpEnter').addEventListener('click', function () {
    hidePanel();
    openChat(state.currentGroupId);
    // 进入主窗口后把焦点移出输入控件：否则焦点会落在群列表搜索框上，移动端直接弹键盘
    const activeElement = document.activeElement;
    if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
      activeElement.blur();
    }
  });
  // 面板标题左侧「👤 我的模型团队」：点击打开主窗口并进数据库页（契约条款 2）
  findElement('#fpTitle').addEventListener('click', function () {
    hidePanel();
    const timApp = findElement('#timApp');
    if (timApp) timApp.hidden = false;
    switchView('profile');
  });
  // 悬浮窗里的通讯录入口（左侧边栏入口在顶栏，两者都通）
  findElement('#btnContacts').addEventListener('click', function () {
    hidePanel();
    switchView('contacts');
  });
  window.addEventListener('resize', positionPanel);
}

// 悬浮球/面板显示的当前目标：单模型 → 模型名（过长截断），分组 → @分组名，未设置 → —
const BALL_TARGET_MAX_CHARS = 9;

function formatBallTarget(label) {
  if (!label || label === '—') return '—';
  if (label.length <= BALL_TARGET_MAX_CHARS) return label;
  return label.slice(0, BALL_TARGET_MAX_CHARS) + '…';
}

// 悬浮窗渲染（契约 §4.4）：所有显示值都从 state 派生，没有"补丁式"单独刷新函数。
// 由 renderApp() 调用——同一个渲染出口，事件广播后自动重放。
// 首帧后按 state.anchor 落位一次：initDrag 早于 store 创建，读不到锚点，所以放到渲染后做
let anchorApplied = false;

function applyStoredAnchorOnce() {
  if (anchorApplied) return;
  const restoredAnchor = readDockAnchor();
  if (!restoredAnchor) return;
  anchorApplied = true;
  commitDockPosition(restoredAnchor.left, restoredAnchor.top);
}

// 悬浮窗文本统一走这里：空值一律落回占位符（禁止空字符串），元素缺失走 store.reportError
// （契约 §8：找不到元素属于"代码 bug 类"，不能静默跳过，否则某次渲染后就永远不更新）
const FLOAT_PLACEHOLDER = '—';

// 目标行专用：名称 + 可选的浅色来源提示（「继承上一会话」等）
function setFloatTarget(selector, label, hint) {
  const node = findElement(selector);
  if (!node) {
    if (store && typeof store.reportError === 'function') {
      store.reportError('float', '缺少元素 ' + selector);
    }
    return;
  }
  const name = String(label == null ? '' : label).trim() || FLOAT_PLACEHOLDER;
  node.innerHTML = escapeHtml(name)
    + (hint ? '<span class="fp-target-source">' + escapeHtml(hint) + '</span>' : '');
}

function setFloatText(selector, value, fallback) {
  const node = findElement(selector);
  if (!node) {
    if (store && typeof store.reportError === 'function') {
      store.reportError('float', '缺少元素 ' + selector);
    }
    return;
  }
  const text = value == null ? '' : String(value).trim();
  node.textContent = text || (fallback || FLOAT_PLACEHOLDER);
}

// 会话行：有标题显示「标题（短 id）」，没标题只显示短 id，没有会话显示 —
// 短 id 取「去掉 session- 前缀后的前 8 位」——直接取原串前 8 位会永远是 "session-"，无法区分会话
function formatSessionLabel(current) {
  const sessionId = current && current.sessionId;
  if (!sessionId) return FLOAT_PLACEHOLDER;
  const shortId = String(sessionId).replace(/^session-/, '').slice(0, 8);
  const title = current.sessionTitle;
  return title ? title + '（' + shortId + '）' : shortId;
}

function renderFloat(current) {
  applyStoredAnchorOnce();
  if (!current) return;
  const label = targetLabel();

  const ballTarget = findElement('#floatBall [data-fb-target]');
  if (ballTarget) ballTarget.textContent = formatBallTarget(label);
  setFloatText('#fpModel', '模型 ' + label);
  setFloatText('#floatPill .pill-model', '( ' + label + ' )');

  const activeGroup = currentGroup();
  setFloatText('#fpGroup', activeGroup ? activeGroup.name : '');
  setFloatText('#fpSession', formatSessionLabel(current));
  setFloatTarget('#fpTarget', label, targetSourceHint());
  setFloatText('#fpRate', current.rate, '— tok/s');
  setFloatText('#fpTotal', current.global && current.global.text);
}
