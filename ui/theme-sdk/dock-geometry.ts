// dock-geometry.ts —— 悬浮件几何与文案口径的**转调层**（薄壳，不持有实现）。
//
// 单一实现住在宿主 `ui/js/float/geometry.js` 与 `ui/js/format/*`：宿主是常驻层，主题可增删，
// **主题不能成为宿主的依赖**，所以规则只能从宿主流向主题，不能反过来。
// 本文件按名字从 `globalThis.dshHostGeometry` / `dshHostUiFormat` / `dshHostTargetSource`
// 取实现，exports 名保持不变（主题代码无需改动）。
//
// 常量在这里再声明一次是**类型需要**（主题直接引用数字）；值必须与宿主一致，
// 由 test/ui-geometry.test.js 逐值比对（两处表达 ⇒ 门禁钉死）。

export const DRAG_THRESHOLD_PX = 4;
export const PANEL_GAP_PX = 12;
export const BALL_FALLBACK_SIZE_PX = 56;
export const PANEL_FALLBACK_SIZE = { width: 384, height: 210 } as const;
export const PLACEHOLDER = '—';
export const RATE_PLACEHOLDER = '— tok/s';
export const DEFAULT_ANCHOR_INSET_PX = 24;
export const DEFAULT_ANCHOR_VERTICAL_RATIO = 0.58;

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  left: number;
  top: number;
}

export interface Rect extends Point, Size {}

export type OpenDirection = 'up-left' | 'up-right' | 'down-left' | 'down-right';

/** 面板一行：label 是行标题，value 是已格式化好的值，title/hint 是值的附属信息 */
export interface PanelField {
  key: string;
  label: string;
  value: string;
  /** D-6：值的身份（完整 sessionId）；空则不打 title 属性 */
  title?: string;
  /** 值的补充说明（目标来源提示）；独立渲染成浅色小字 */
  hint?: string;
}

interface HostGeometry {
  clampDockPosition(left: number, top: number, size: Size, viewSize: Size): Point;
  computeOpenDir(rect: Rect, viewSize: Size): OpenDirection;
  computePanelPosition(dockRect: Rect, panelSize: Size, openDir: OpenDirection, viewSize: Size): Point;
  measureSize(element: { getBoundingClientRect(): { width: number; height: number } } | null, fallback: Size): Size;
  defaultAnchor(ballSize: Size, viewSize: Size): Point;
  shouldStartDrag(deltaX: number, deltaY: number): boolean;
  readViewSize(): Size;
}

const hostGeometry = (): HostGeometry => {
  const host = (globalThis as { dshHostGeometry?: HostGeometry }).dshHostGeometry;
  if (!host) throw new Error('宿主几何实现未加载：ui/js/float/geometry.js 必须先于主题执行');
  return host;
};

const hostUiFormat = () => {
  const host = (globalThis as {
    dshHostUiFormat?: {
      formatSessionLine(sessionId: unknown, sessionTitle: unknown): { text: string; title: string };
      formatTargetLabel(effectiveTarget: unknown, friendGroups: ReadonlyArray<{ id?: unknown; name?: unknown }>): string;
    };
  }).dshHostUiFormat;
  if (!host) throw new Error('宿主文案口径未加载：ui/js/format/ui-format.js 必须先于主题执行');
  return host;
};

const hostPanelFields = () => {
  const host = (globalThis as { dshHostPanelFields?: { buildPanelFields(values: PanelFieldValues): PanelField[] } }).dshHostPanelFields;
  if (!host) throw new Error('宿主面板字段实现未加载：ui/js/float/panel-fields.js 必须先于主题执行');
  return host;
};

const hostTargetSource = () => {
  const host = (globalThis as { dshHostTargetSource?: { targetSourceHint(targetSource: unknown): string } }).dshHostTargetSource;
  if (!host) throw new Error('宿主来源提示未加载：ui/js/float/target-source.js 必须先于主题执行');
  return host;
};

/** 夹取：整块留在视口内（实现在宿主） */
export const clampDockPosition = (left: number, top: number, size: Size, viewSize: Size): Point => hostGeometry().clampDockPosition(left, top, size, viewSize);

/** 象限方向（实现在宿主） */
export const computeOpenDir = (rect: Rect, viewSize: Size): OpenDirection => hostGeometry().computeOpenDir(rect, viewSize);

/** 面板位置 = 锚点 + 面板尺寸 + 展开方向，最后一次夹取（实现在宿主） */
export const computePanelPosition = (dockRect: Rect, panelSize: Size, openDir: OpenDirection, viewSize: Size): Point => hostGeometry().computePanelPosition(dockRect, panelSize, openDir, viewSize);

/** 拖动判定（实现在宿主） */
export const shouldStartDrag = (deltaX: number, deltaY: number): boolean => hostGeometry().shouldStartDrag(deltaX, deltaY);

/** 会话行文案（实现在宿主） */
export const formatSessionLine = (sessionId: unknown, sessionTitle: unknown): { text: string; title: string } => hostUiFormat().formatSessionLine(sessionId, sessionTitle);

/** 当前目标文案（实现在宿主） */
export const formatTargetLabel = (effectiveTarget: unknown, friendGroups: ReadonlyArray<{ id?: unknown; name?: unknown }> = []): string => hostUiFormat().formatTargetLabel(effectiveTarget, friendGroups);

/** 目标来源提示（实现在宿主；未知值由宿主告警一次并不渲染） */
export const targetSourceHint = (targetSource: unknown): string => hostTargetSource().targetSourceHint(targetSource);

/**
 * 面板五行文案：顺序与占位规则见 docs/03 条款 3；**这里保留组装**（面板专属排版，
 * 宿主那份是 DOM 写入路径，两者不共用字符串拼接）。
 */
export interface PanelFieldValues {
  groupName?: unknown;
  sessionText?: unknown;
  sessionTitle?: unknown;
  targetLabel?: unknown;
  targetSourceHintText?: unknown;
  rate?: unknown;
  globalText?: unknown;
}

/** 面板五行文案（实现在宿主 panel-fields.js：标签/顺序/占位唯一一份） */
export const buildPanelFields = (values: PanelFieldValues): PanelField[] => hostPanelFields().buildPanelFields(values);

export const measureSize = (element: unknown, fallback: Size): Size => hostGeometry().measureSize(element as { getBoundingClientRect(): { width: number; height: number } } | null, fallback);

/** 视口尺寸（实现在宿主 geometry.js） */
export const readViewSize = (): Size => hostGeometry().readViewSize();

/** 默认锚点（实现在宿主） */
export const defaultAnchor = (ballSize: Size, viewSize: Size): Point => hostGeometry().defaultAnchor(ballSize, viewSize);
