// dock-state.js —— 悬浮件（球 + 面板）的 UI 状态单一真相源。
//
// 为什么要它：显隐与位置原本散在三处（dock.js 的 lastDockDecision、float.js 的 DOM 读写、
// store 里的一份 anchor），任何一处不同步就会出现「判定说隐藏、界面还亮着」「拖出去再刷新跳回固定位置」。
// 这里按 ModelStage 的 ui-state 契约收敛：
//   R1 单一真相源：显示值只有一个来源（本模块），控件不留显示副本；
//   R2 读回早于首次渲染：模块加载时就把持久化值读进内存，早于任何 DOM 构建；
//   R3 apply 与 render 分离：setXxx 只改值 + 通知；真正写 DOM 由装配方注册的 applier 落地（幂等可重放）。
// 依赖方向单向：本模块**不 import** float.js / dock.js / session-bridge.js，谁要写 DOM 谁自己注册。

// 新的持久化键；旧键（dsh-model-team:anchor）由 store-persist 写过，加载时迁移并删除
var DOCK_STATE_STORAGE_KEY = 'dsh-model-team:dock-state-v2';
var LEGACY_ANCHOR_STORAGE_KEY = 'dsh-model-team:anchor';

// 形态：ball=只有球；panel=面板展开（面板位置由锚点 + 方向算出，不单独持久化）
var DOCK_SHAPES = { BALL: 'ball', PANEL: 'panel' };

var dockState = {
  visible: false,          // 球是否显示（INV-14 判定的唯一落点）
  anchor: null,            // 收起态锚点（球左上角）{left, top}；null = 还没定过位（用默认右下角）
  // 主窗口位置（左上角 {left, top}）：主题拖动后写这里，由宿主持久化（主题不碰 localStorage）
  windowAnchor: null,
  shape: DOCK_SHAPES.BALL, // 当前形态，决定按谁的尺寸夹取
  // 展开方向：锚点中心相对视口中心决定象限。文本侧与面板展开方向都由它推出来，
  // 拖动松手/窗口 resize 后必须重算（用户可能拖到另一半屏再展开）。
  openDir: (typeof window === 'undefined') ? 'down-left' : 'down-left',
};

var dockStateListeners = [];
var dockAppliers = { visibility: null, anchor: null };

function cloneDockAnchor(anchor) {
  if (!anchor || typeof anchor.left !== 'number' || typeof anchor.top !== 'number') return null;
  return { left: anchor.left, top: anchor.top };
}

function getDockState() {
  return {
    visible: dockState.visible,
    anchor: cloneDockAnchor(dockState.anchor),
    windowAnchor: cloneDockAnchor(dockState.windowAnchor),
    shape: dockState.shape,
    openDir: dockState.openDir,
  };
}

// 立即回调一次当前值：订阅者不该为了"拿首帧值"再写一套读取逻辑（R2）
function subscribeDockState(listener) {
  if (typeof listener !== 'function') return function () {};
  dockStateListeners.push(listener);
  try { listener(getDockState()); } catch (error) { /* 订阅者自身异常不能打断别人 */ }
  return function unsubscribe() {
    var index = dockStateListeners.indexOf(listener);
    if (index >= 0) dockStateListeners.splice(index, 1);
  };
}

function notifyDockState() {
  var snapshot = getDockState();
  dockStateListeners.slice().forEach(function (listener) {
    try { listener(snapshot); } catch (error) { /* 同上 */ }
  });
}

// 装配方注册 DOM 落地函数（浮动球显隐 / 位置）；重复注册以最后一次为准，便于宿主重建 DOM 后重挂
function registerDockAppliers(appliers) {
  var next = appliers || {};
  if (typeof next.visibility === 'function') dockAppliers.visibility = next.visibility;
  if (typeof next.anchor === 'function') dockAppliers.anchor = next.anchor;
  reapplyDockDom();
}

// 按当前值重画已存在的 DOM（幂等、可重放）：DOM 重建后调它就能补齐显示态
function reapplyDockDom() {
  var snapshot = getDockState();
  if (dockAppliers.visibility) {
    try { dockAppliers.visibility(snapshot.visible); } catch (error) { /* 落地失败不影响状态 */ }
  }
  if (dockAppliers.anchor) {
    try { dockAppliers.anchor(snapshot.anchor, snapshot.shape, snapshot.openDir); } catch (error) { /* 同上 */ }
  }
}

function setDockVisible(visible) {
  var nextVisible = visible === true;
  if (dockState.visible === nextVisible) {
    reapplyDockDom();   // 值没变也要重放一次：DOM 可能刚被重建过
    return;
  }
  dockState.visible = nextVisible;
  reapplyDockDom();
  notifyDockState();
}

// 展开方向变化也要重画（文本换到球的另一侧、面板换方向），但不落盘：位置真相只有锚点
function setDockOpenDir(openDir) {
  var nextDir = String(openDir || '').trim();
  if (!/^(up|down)-(left|right)$/.test(nextDir)) return;
  if (dockState.openDir === nextDir) return;
  dockState.openDir = nextDir;
  reapplyDockDom();
  notifyDockState();
}

function setDockShape(shape) {
  var nextShape = shape === DOCK_SHAPES.PANEL ? DOCK_SHAPES.PANEL : DOCK_SHAPES.BALL;
  if (dockState.shape === nextShape) return;
  dockState.shape = nextShape;
  reapplyDockDom();
  notifyDockState();
}

// 位置只存锚点（球的左上角）；面板位置由锚点 + 展开方向算出来，不落盘
// 主窗口位置：主题拖动结束写一次；与球锚点分开存（两者是不同部件，共用一个字段会互相顶掉）
function setWindowAnchor(anchor) {
  var nextAnchor = cloneDockAnchor(anchor);
  if (nextAnchor) {
    nextAnchor.left = Math.round(nextAnchor.left);
    nextAnchor.top = Math.round(nextAnchor.top);
  }
  var previous = dockState.windowAnchor;
  var unchanged = (previous === null && nextAnchor === null)
    || (previous && nextAnchor && previous.left === nextAnchor.left && previous.top === nextAnchor.top);
  if (unchanged) return;
  dockState.windowAnchor = nextAnchor;
  persistDockState();
  notifyDockState();
}

function setDockAnchor(anchor) {
  var nextAnchor = cloneDockAnchor(anchor);
  if (nextAnchor) {
    nextAnchor.left = Math.round(nextAnchor.left);
    nextAnchor.top = Math.round(nextAnchor.top);
  }
  var previous = dockState.anchor;
  var unchanged = (previous === null && nextAnchor === null)
    || (previous && nextAnchor && previous.left === nextAnchor.left && previous.top === nextAnchor.top);
  if (unchanged) return;
  dockState.anchor = nextAnchor;
  persistDockState();
  reapplyDockDom();
  notifyDockState();
}

// ---------------------------------------------------------------- 持久化（R2：加载即读）

function readStorage(storage) {
  try { return storage && typeof storage.getItem === 'function' ? storage : null; } catch (error) { return null; }
}

function parseAnchor(rawValue) {
  if (!rawValue) return null;
  try {
    var parsed = JSON.parse(rawValue);
    if (parsed && typeof parsed.left === 'number' && typeof parsed.top === 'number') {
      return { left: parsed.left, top: parsed.top };
    }
  } catch (error) { /* 脏数据当没有 */ }
  return null;
}

function loadDockStateFromStorage(storage) {
  var target = readStorage(storage);
  if (!target) return;
  var stored = null;
  try { stored = target.getItem(DOCK_STATE_STORAGE_KEY); } catch (error) { stored = null; }
  if (stored) {
    var parsedState = null;
    try { parsedState = JSON.parse(stored); } catch (error) { parsedState = null; }
    if (parsedState && parsedState.anchor) {
      dockState.anchor = cloneDockAnchor(parsedState.anchor);
    }
    if (parsedState && parsedState.windowAnchor) {
      dockState.windowAnchor = cloneDockAnchor(parsedState.windowAnchor);
    }
    // 只有两个锚点会持久化：显隐与形态是运行时事实，不该跨会话恢复
    return;
  }
  // 迁移旧键：读出来 → 写进新键 → 删旧键（避免两份真相并存）
  var legacyRaw = null;
  try { legacyRaw = target.getItem(LEGACY_ANCHOR_STORAGE_KEY); } catch (error) { legacyRaw = null; }
  var legacyAnchor = parseAnchor(legacyRaw);
  if (!legacyAnchor) return;
  dockState.anchor = legacyAnchor;
  persistDockState(target);
  try { target.removeItem(LEGACY_ANCHOR_STORAGE_KEY); } catch (error) { /* 删不掉也不影响值 */ }
}

function persistDockState(storage) {
  var target = readStorage(storage) || readStorage(typeof window === 'undefined' ? null : window.localStorage);
  if (!target) return;
  try {
    // 只持久化两个锚点：显隐/形态是运行时事实，不跨会话恢复
    target.setItem(DOCK_STATE_STORAGE_KEY, JSON.stringify({ anchor: dockState.anchor, windowAnchor: dockState.windowAnchor }));
  } catch (error) { /* 存储不可用（隐私模式/配额）时装不了不影响运行 */ }
}

// R2：模块一加载就把值读回内存，早于任何 DOM 构建
if (typeof window !== 'undefined' && window.localStorage) {
  loadDockStateFromStorage(window.localStorage);
}

// 预览/自检通道：真渲染门禁需要能"先让球可见再点它"（预览垫片没有宿主 projection）。
// 只暴露状态工厂本身，不提供任何伪造判定结果的入口。
if (typeof window !== 'undefined') {
  window.__DMT_DOCK__ = {
    getDockState: getDockState,
    subscribeDockState: subscribeDockState,
    setDockVisible: setDockVisible,
    setDockAnchor: setDockAnchor,
    setWindowAnchor: setWindowAnchor,
    setDockShape: setDockShape,
    setDockOpenDir: setDockOpenDir,
    reapplyDockDom: reapplyDockDom,
    registerDockAppliers: registerDockAppliers,
  };
}
