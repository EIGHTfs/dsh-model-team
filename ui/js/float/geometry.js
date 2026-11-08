// geometry.js —— 悬浮件（球 + 面板）几何纯函数：夹取 / 展开象限 / 面板定位 / 尺寸测量。
//
// 为什么单独一个分片：这些函数被 legacy 渲染层、主题桥接层与单测同时需要；
// 以前它们内联在 float.js 里，主题 SDK 只好再抄一份（两套实现必然漂移）。
// 现在**唯一实现**在这里，SDK 只做转调（见 ui/theme-sdk/dock-geometry.ts）。
//
// 纯函数纪律：不读写全局状态；只有缺省参数才碰 window（单测里直接传值）。

var DRAG_THRESHOLD_PX = 4;             // 位移超过它才算拖动，否则视为点击
var PANEL_GAP_PX = 12;                 // 面板与球的间距
var BALL_FALLBACK_SIZE_PX = 56;        // 取不到球实际尺寸时的兜底（与样式里的球径一致）
var PANEL_FALLBACK_SIZE = { width: 384, height: 210 };
var DEFAULT_ANCHOR_INSET_PX = 24;      // 默认锚点：右下角往内缩 24px
var DEFAULT_ANCHOR_VERTICAL_RATIO = 0.58;   // 默认锚点纵向落在视口 58% 处（改它首帧位置就变）

function readViewportSize(viewSize) {
  if (viewSize) return viewSize;
  return {
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
  };
}

// 位置夹取：**唯一入口**（拖动每帧、松手落位、落盘、恢复锚点、resize、面板定位全走它）。
// 语义：**整块留在视口内**（min=0，max=max(0, 视口 - 尺寸)）；视口比控件还小时按 0 处理。
function clampDockPosition(left, top, size, viewSize) {
  var targetSize = size || { width: BALL_FALLBACK_SIZE_PX, height: BALL_FALLBACK_SIZE_PX };
  var view = readViewportSize(viewSize);
  var maxLeft = Math.max(0, Number(view.width || 0) - Number(targetSize.width || 0));
  var maxTop = Math.max(0, Number(view.height || 0) - Number(targetSize.height || 0));
  return {
    left: Math.min(Math.max(Number(left) || 0, 0), maxLeft),
    top: Math.min(Math.max(Number(top) || 0, 0), maxTop),
  };
}

// 展开方向：锚点中心相对视口中心决定象限（靠右向左、靠下向上，永远朝视口内侧长）
function computeOpenDir(rect, viewSize) {
  var view = readViewportSize(viewSize);
  var centerX = rect.left + rect.width / 2;
  var centerY = rect.top + rect.height / 2;
  var openLeft = centerX >= view.width / 2;
  var openUp = centerY >= view.height / 2;
  return (openUp ? 'up' : 'down') + '-' + (openLeft ? 'left' : 'right');
}

// 面板位置 = 锚点 + 面板尺寸 + 展开方向，最后一次夹取（与球同一口径）
function computePanelPosition(dockRect, panelSize, openDir, viewSize) {
  var openLeftwards = String(openDir || '').indexOf('left') >= 0;
  var openUpwards = String(openDir || '').indexOf('up') >= 0;
  var rawLeft = openLeftwards
    ? dockRect.left + dockRect.width - panelSize.width
    : dockRect.left;
  var rawTop = openUpwards
    ? dockRect.top - panelSize.height - PANEL_GAP_PX
    : dockRect.top + dockRect.height + PANEL_GAP_PX;
  return clampDockPosition(rawLeft, rawTop, panelSize, viewSize);
}

// 测量元素尺寸：取不到（未渲染/display:none）就用兜底值——夹取必须按"当前形态"的尺寸算
function measureSize(element, fallback) {
  var rect = element ? element.getBoundingClientRect() : null;
  if (!rect || !rect.width || !rect.height) return fallback;
  return { width: rect.width, height: rect.height };
}

// 没定过位时的默认锚点：右下角往里缩一点
function defaultAnchor(ballSize, viewSize) {
  var view = readViewportSize(viewSize);
  var targetBallSize = ballSize || { width: BALL_FALLBACK_SIZE_PX, height: BALL_FALLBACK_SIZE_PX };
  return clampDockPosition(
    view.width - targetBallSize.width - DEFAULT_ANCHOR_INSET_PX,
    view.height * DEFAULT_ANCHOR_VERTICAL_RATIO,
    targetBallSize,
    view
  );
}

// 拖动判定：曼哈顿距离（欧氏距离会让斜向轻微移动更迟钝）
function shouldStartDrag(deltaX, deltaY) {
  return Math.abs(Number(deltaX) || 0) + Math.abs(Number(deltaY) || 0) > DRAG_THRESHOLD_PX;
}

// 主题 SDK（ui/theme-sdk/dock-geometry.ts）只是转调这里——它按名字从全局取，别处不要再写第二份实现。
// 用 globalThis 而不是 window：宿主与测试沙箱都能取到。
if (typeof globalThis !== 'undefined') {
  globalThis.dshHostGeometry = {
    DRAG_THRESHOLD_PX: DRAG_THRESHOLD_PX,
    PANEL_GAP_PX: PANEL_GAP_PX,
    BALL_FALLBACK_SIZE_PX: BALL_FALLBACK_SIZE_PX,
    PANEL_FALLBACK_SIZE: PANEL_FALLBACK_SIZE,
    DEFAULT_ANCHOR_INSET_PX: DEFAULT_ANCHOR_INSET_PX,
    DEFAULT_ANCHOR_VERTICAL_RATIO: DEFAULT_ANCHOR_VERTICAL_RATIO,
    clampDockPosition: clampDockPosition,
    computeOpenDir: computeOpenDir,
    computePanelPosition: computePanelPosition,
    measureSize: measureSize,
    defaultAnchor: defaultAnchor,
    shouldStartDrag: shouldStartDrag,
  };
}
