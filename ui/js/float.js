// float.js —— 悬浮球与悬浮面板：定位、开合、关闭与召回、拖拽。
// 球常驻屏幕、可拖动；点球展开统计面板；× 关闭后留一个「呼出模型团队」入口。
// 拖动：球用 transform 单帧跟随（rAF 合并，不重排），松手才落 left/top 并持久化锚点；
//       面板标题条拖动仍直接改 left/top（面板位置不持久化）。

const PANEL_GAP_PX = 12;             // 面板与球的间距
const VIEWPORT_MARGIN_PX = 12;       // 面板离视口边缘的最小距离
const DRAG_THRESHOLD_PX = 4;         // 位移超过它才算拖动，否则视为点击
const BALL_FALLBACK_SIZE_PX = 56;    // 取不到球实际尺寸时的兜底（与样式里的球径一致）
const PANEL_FALLBACK_WIDTH = 384;    // 面板未渲染完成时的兜底尺寸
const PANEL_FALLBACK_HEIGHT = 210;

let dragState = null;                // 当前拖动上下文（球或面板）
let dragFrameId = 0;                 // rAF 句柄：同一帧只写一次 transform
let dragPendingPosition = null;      // 等待写入的位置
let dockElement = null;              // 缓存球容器，拖动中不逐帧 querySelector

// 位置夹取：**唯一入口**（拖动每帧、松手落位、落盘、恢复锚点、resize、面板定位全走它）。
// 语义：**整块留在视口内**（min=0，max=max(0, 视口 - 尺寸)）。
// 为什么不是"至少留 8px 可抓"：那样球能被拖到只剩一条边露在外面，松手/刷新再被夹回，
// 用户看到的是"被拉出去又跳回固定位置"。整块在内既不会丢，也不需要事后纠正。
// 视口比控件还小时 max 会小于 min：此时按 0 处理（贴左上角，至少能看见一部分）。
// 纯函数：不读全局状态，viewSize 缺省才用 window（单测里直接传）。
function clampDockPosition(left, top, size, viewSize) {
  const targetSize = size || { width: BALL_FALLBACK_SIZE_PX, height: BALL_FALLBACK_SIZE_PX };
  const view = viewSize || {
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
  };
  const maxLeft = Math.max(0, Number(view.width || 0) - Number(targetSize.width || 0));
  const maxTop = Math.max(0, Number(view.height || 0) - Number(targetSize.height || 0));
  return {
    left: Math.min(Math.max(Number(left) || 0, 0), maxLeft),
    top: Math.min(Math.max(Number(top) || 0, 0), maxTop),
  };
}

// 取球的实际尺寸（取不到就用兜底值）：夹取需要它算"至少留 8px"的下界
function readDockSize() {
  const floatDock = dockElement || findElement('#floatDock');
  const rect = floatDock ? floatDock.getBoundingClientRect() : null;
  if (!rect || !rect.width || !rect.height) {
    return { width: BALL_FALLBACK_SIZE_PX, height: BALL_FALLBACK_SIZE_PX };
  }
  return { width: rect.width, height: rect.height };
}

// 展开方向：锚点中心相对视口中心决定象限（照 ModelStage 的 placeForForm 口径）。
//   openLeft = 球在右半边 → 面板向左长、文本在球的左侧（朝视口内侧）
//   openUp   = 球在下半边 → 面板向上长
// 拖动松手、resize、恢复锚点后都要重算，否则拖到另一半屏后方向还是旧的。
function computeOpenDir(rect, viewSize) {
  const view = viewSize || { width: window.innerWidth, height: window.innerHeight };
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const openLeft = centerX >= view.width / 2;
  const openUp = centerY >= view.height / 2;
  return (openUp ? 'up' : 'down') + '-' + (openLeft ? 'left' : 'right');
}

// 把方向写到 DOM：CSS 用 [data-open-dir$="right"] 决定文本在球的哪一侧
function applyOpenDir(openDir) {
  const floatDock = findElement('#floatDock');
  if (floatDock && openDir) floatDock.dataset.openDir = openDir;
  if (typeof setDockOpenDir === 'function' && openDir) setDockOpenDir(openDir);
}

// 按球的当前实际位置重算方向（拖动中不调，松手/resize 才调：拖动中算会让文本左右跳）
function refreshOpenDir() {
  const floatDock = findElement('#floatDock');
  if (!floatDock) return '';
  const openDir = computeOpenDir(floatDock.getBoundingClientRect());
  applyOpenDir(openDir);
  return openDir;
}

// 面板尺寸：优先取实际渲染尺寸，取不到用兜底常量（夹取要按"当前形态"的尺寸算）
function readPanelSize() {
  const floatPanel = findElement('#floatPanel');
  const width = floatPanel && floatPanel.offsetWidth ? floatPanel.offsetWidth : PANEL_FALLBACK_WIDTH;
  const height = floatPanel && floatPanel.offsetHeight ? floatPanel.offsetHeight : PANEL_FALLBACK_HEIGHT;
  return { width, height };
}

// 面板相对球展开：**永远朝视口中心方向长**——
// 球在右半边就向左展开、在下半边就向上展开；写死一个方向必然有一半位置放不下。
// 位置最后统一过 clampDockPosition（同一套「整块在视口内」的语义）。
function positionPanel() {
  const floatPanel = findElement('#floatPanel');
  const floatDock = findElement('#floatDock');
  if (!floatPanel || !floatDock || floatPanel.classList.contains('hidden')) return;
  const dockRect = floatDock.getBoundingClientRect();
  const panelSize = readPanelSize();
  const openDir = (typeof getDockState === 'function' && getDockState().openDir) || computeOpenDir(dockRect);
  const openLeftwards = openDir.indexOf('left') >= 0;
  const openUpwards = openDir.indexOf('up') >= 0;
  const rawLeft = openLeftwards ? dockRect.right - panelSize.width : dockRect.left;
  const rawTop = openUpwards ? dockRect.top - panelSize.height - PANEL_GAP_PX : dockRect.bottom + PANEL_GAP_PX;
  const clamped = clampDockPosition(rawLeft, rawTop, panelSize);
  floatPanel.style.left = clamped.left + 'px';
  floatPanel.style.top = clamped.top + 'px';
}

function showPanel() {
  findElement('#floatPanel').classList.remove('hidden');
  positionPanel();
}

function hidePanel() {
  findElement('#floatPanel').classList.add('hidden');
}

// 锚点只从状态工厂读（R1：持久化与显示值的唯一真相源是 dock-state.js，视图不再自己读写 storage）
function readDockAnchor() {
  const dockState = typeof getDockState === 'function' ? getDockState() : null;
  const anchor = dockState && dockState.anchor;
  if (!anchor || typeof anchor.left !== 'number' || typeof anchor.top !== 'number') return null;
  // 恢复时也过一遍夹取：窗口比存的时候小了，旧锚点可能越界
  return clampDockPosition(anchor.left, anchor.top, readDockSize());
}

// 存锚点走状态工厂（内部负责持久化与通知）
function saveDockAnchor(anchor) {
  if (typeof setDockAnchor === 'function') setDockAnchor(anchor);
}

// 状态工厂的 anchor applier：装配方（dock.js）在 mount 时注册，由工厂 reapply 调用。
// 只负责"把值摆到 DOM 上"，不判断该不该摆（判断在工厂里）。
function applyDockAnchor(anchor) {
  const floatDock = findElement('#floatDock');
  if (!floatDock) return;
  if (!anchor) {
    // 没有锚点 = 从没拖过：保持骨架里的默认位置（右下角），不写死坐标
    floatDock.style.transform = '';
    return;
  }
  const clamped = clampDockPosition(anchor.left, anchor.top, readDockSize());
  commitDockPosition(clamped.left, clamped.top);
  refreshOpenDir();
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

// 窗口尺寸变化后把球夹回视口：这条路径以前完全没人管，缩窗/换显示器后球会停在视口外，
// 表现为"球消失了"。夹完要落位 + 落盘，否则下次启动还是旧位置。
function reclampDockOnResize() {
  const floatDock = findElement('#floatDock');
  if (!floatDock) return;
  const rect = floatDock.getBoundingClientRect();
  const clamped = clampDockPosition(rect.left, rect.top, { width: rect.width, height: rect.height });
  const movedX = Math.round(clamped.left) !== Math.round(rect.left);
  const movedY = Math.round(clamped.top) !== Math.round(rect.top);
  if (!movedX && !movedY) return;
  commitDockPosition(clamped.left, clamped.top);
  saveDockAnchor({ left: Math.round(clamped.left), top: Math.round(clamped.top) });
  refreshOpenDir();
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
      // 面板也按"自己尺寸"整块留在视口内（与球同一函数、不同尺寸）
      const clampedPanel = clampDockPosition(
        dragState.startRect.left + deltaX,
        dragState.startRect.top + deltaY,
        { width: dragState.startRect.width, height: dragState.startRect.height },
      );
      dragState.last = clampedPanel;
      scheduleDockFrame(clampedPanel.left, clampedPanel.top);
      return;
    }

    // 拖动每帧都夹：不夹的话球能被拖到视口外，且落盘后刷新也找不回来
    const clampedPosition = clampDockPosition(
      dragState.startRect.left + deltaX,
      dragState.startRect.top + deltaY,
      { width: dragState.startRect.width, height: dragState.startRect.height },
    );
    dragState.last = clampedPosition;
    scheduleDockFrame(clampedPosition.left, clampedPosition.top);
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
    const rawPosition = finishedDrag.last || { left: finishedDrag.startRect.left, top: finishedDrag.startRect.top };
    // 落位与落盘各夹一次：落位影响视觉，落盘影响下次启动；两处都用同一口径
    const committed = clampDockPosition(rawPosition.left, rawPosition.top, readDockSize());
    commitDockPosition(committed.left, committed.top);
    saveDockAnchor({ left: Math.round(committed.left), top: Math.round(committed.top) });
    // 松手才重算方向：拖动中算会让文本在球的左右来回跳
    refreshOpenDir();
    positionPanel();
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
  // 窗口尺寸变化：先重夹球（缩窗后球可能整个跑到视口外），再重摆面板
  window.addEventListener('resize', function () {
    reclampDockOnResize();
    positionPanel();
  });
}

// 悬浮球/面板显示的当前目标：单模型 → 模型名（过长截断），分组 → @分组名，未设置 → —
const BALL_TARGET_MAX_CHARS = 9;


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

// 面板五个字段的最终文案（纯函数：不读 DOM、不读 store）。
// 抽出来是为了让 check-render 能在 node:vm 里直接断言「五字段非空且不是加载中」，
// 而不需要起浏览器、也不需要宿主的 projection。float.js 的 DOM 写入与门禁共用这一份。
function buildPanelFieldTexts(values) {
  const source = values || {};
  const trimmed = function (value) {
    return value == null ? '' : String(value).trim();
  };
  return {
    fpGroup: trimmed(source.groupName) || FLOAT_PLACEHOLDER,
    fpSession: trimmed(source.sessionLabel) || FLOAT_PLACEHOLDER,
    fpTarget: trimmed(source.targetLabel) || FLOAT_PLACEHOLDER,
    fpRate: trimmed(source.rate) || (FLOAT_PLACEHOLDER + ' tok/s'),
    fpTotal: trimmed(source.globalText) || FLOAT_PLACEHOLDER,
  };
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

function renderFloat(current, activePlatform) {
  applyStoredAnchorOnce();
  if (!current) return;
  const label = targetLabel();

  // 球内显示"接活平台"的头像/首字母（G6）：不再显示模型名文字，溢出问题从设计上消失。
  // data-fb-target 是 docs/03 §2.1 的 DOM 钩子，必须保留这个容器与属性名。
  const ballTarget = findElement('#floatBall [data-fb-target]');
  if (ballTarget) ballTarget.innerHTML = renderFloatTargetMarkup(activePlatform);

  // 图不承载语义：title / aria-label 兜住"目标名 · 平台名"，否则读屏只剩一个装饰圆
  const ball = findElement('#floatBall');
  if (ball) {
    const platformName = activePlatform && activePlatform.name ? String(activePlatform.name) : '';
    const accessibleLabel = platformName ? label + ' · ' + platformName : label;
    ball.setAttribute('title', accessibleLabel);
    ball.setAttribute('aria-label', accessibleLabel);
  }
  setFloatText('#fpModel', '模型 ' + label);
  setFloatText('#floatPill .pill-model', '( ' + label + ' )');

  const activeGroup = currentGroup();
  // 五字段文案统一由纯函数算（check-render 断言的就是这一份），这里只负责写进 DOM
  const panelFieldTexts = buildPanelFieldTexts({
    groupName: activeGroup ? activeGroup.name : '',
    sessionLabel: formatSessionLabel(current),
    targetLabel: label,
    rate: current.rate,
    globalText: current.global && current.global.text,
  });
  setFloatText('#fpGroup', panelFieldTexts.fpGroup);
  setFloatText('#fpSession', panelFieldTexts.fpSession);
  setFloatTarget('#fpTarget', panelFieldTexts.fpTarget, targetSourceHint());
  setFloatText('#fpRate', panelFieldTexts.fpRate);
  setFloatText('#fpTotal', panelFieldTexts.fpTotal);
}
