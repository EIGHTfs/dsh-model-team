// dock-geometry.ts —— 悬浮件（球 + 面板）的几何与文案口径：两套主题必须完全一致的那部分。
//
// 为什么这些必须在 SDK 而不是主题里：位置夹取、展开象限、开合阈值、五行政文
// 都是「换个皮肤不能变」的行为。放进主题意味着两套各写一遍，S-3（功能一致）就只能靠人肉维持。
// 主题只负责把它们算好的值画出来。
//
// 迁自 ui/js/float/float.js 与 dock-state.js，逐条对应历史缺陷：
//   · 整块留视口内（G-dock2：拖出去跳回）—— clampDockPosition 是唯一入口；
//   · 象限决定展开方向（靠右向左、靠下向上）；
//   · 位移 > 4px 才算拖动（否则算点击，F-01：只能开不能关）。

export const DRAG_THRESHOLD_PX = 4;
export const PANEL_GAP_PX = 12;
export const BALL_FALLBACK_SIZE_PX = 56;
export const PANEL_FALLBACK_SIZE = { width: 384, height: 210 } as const;
export const PLACEHOLDER = '—';
export const RATE_PLACEHOLDER = '— tok/s';
/** 默认锚点：右下角往内缩 24px、纵向落在视口 58% 处（数值取自旧实现，改它首帧位置就变） */
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

/** 夹取：整块留在视口内。视口比控件还小时按 0（贴左上角，至少看得见一部分） */
export function clampDockPosition(left: number, top: number, size: Size, viewSize: Size): Point {
  const maxLeft = Math.max(0, Number(viewSize.width || 0) - Number(size.width || 0));
  const maxTop = Math.max(0, Number(viewSize.height || 0) - Number(size.height || 0));
  return {
    left: Math.min(Math.max(Number(left) || 0, 0), maxLeft),
    top: Math.min(Math.max(Number(top) || 0, 0), maxTop),
  };
}

/** 象限方向：球在右半屏 → 面板向左；球在下半屏 → 面板向上（永远朝视口内侧长） */
export function computeOpenDir(rect: Rect, viewSize: Size): OpenDirection {
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const openLeft = centerX >= viewSize.width / 2;
  const openUp = centerY >= viewSize.height / 2;
  return `${openUp ? 'up' : 'down'}-${openLeft ? 'left' : 'right'}` as OpenDirection;
}

/** 面板位置 = 锚点 + 面板尺寸 + 展开方向，最后一次夹取（与球同一口径） */
export function computePanelPosition(dockRect: Rect, panelSize: Size, openDir: OpenDirection, viewSize: Size): Point {
  const openLeftwards = openDir.indexOf('left') >= 0;
  const openUpwards = openDir.indexOf('up') >= 0;
  const rawLeft = openLeftwards ? dockRect.left + dockRect.width - panelSize.width : dockRect.left;
  const rawTop = openUpwards ? dockRect.top - panelSize.height - PANEL_GAP_PX : dockRect.top + dockRect.height + PANEL_GAP_PX;
  return clampDockPosition(rawLeft, rawTop, panelSize, viewSize);
}

/** 拖动判定：曼哈顿距离（与旧实现一致；欧氏距离会让斜向轻微移动更迟钝） */
export function shouldStartDrag(deltaX: number, deltaY: number): boolean {
  return Math.abs(deltaX) + Math.abs(deltaY) > DRAG_THRESHOLD_PX;
}

/**
 * 会话行文案（D-6）：有标题 → `标题（id 前 8 位）`；无标题 → `未命名会话`；
 * 完整 id 进 title 属性（可追溯）；草稿会话（没有 id）→ `—`。
 */
export function formatSessionLine(sessionId: unknown, sessionTitle: unknown): { text: string; title: string } {
  const rawId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!rawId) return { text: PLACEHOLDER, title: '' };
  const shortId = rawId.replace(/^session-/, '').slice(0, 8);
  const title = typeof sessionTitle === 'string' ? sessionTitle.trim() : '';
  if (!title) return { text: '未命名会话', title: rawId };
  return { text: `${title}（${shortId}）`, title: rawId };
}

/**
 * 当前目标文案（与 ui/js/app.js:112 targetLabel 对齐）：
 * group → `@分组名`（名字取好友分组，取不到回落 id）；model → 去掉 `global:` 前缀的 id；无 → `—`。
 */
export function formatTargetLabel(effectiveTarget: unknown, friendGroups: ReadonlyArray<{ id?: unknown; name?: unknown }> = []): string {
  const target = effectiveTarget as { type?: string; id?: string; model?: string } | null;
  if (!target || typeof target !== 'object') return PLACEHOLDER;
  if (target.type === 'group') {
    const matchedGroup = friendGroups.find((friendGroup) => String(friendGroup.id || '') === String(target.id || ''));
    const groupName = matchedGroup && typeof matchedGroup.name === 'string' ? matchedGroup.name.trim() : '';
    return `@${groupName || String(target.id || '')}`;
  }
  const modelId = String(target.id || target.model || '').replace(/^global:/, '').trim();
  return modelId || PLACEHOLDER;
}

/**
 * 目标来源提示：只有三种「后端回落」来源要提示；空值 = 显式绑定（不提示），未知值 = 不渲染。
 * 文案与 ui/js/float/target-source.js 逐字一致，由 test/theme-dock-panel.test.js 比对（同一事实两处表达 ⇒ 门禁）。
 */
export const TARGET_SOURCE_HINTS: Record<string, string> = {
  'last-session': '（继承上一会话）',
  parent: '（继承父会话）',
  'fallback-group': '（兜底群默认）',
};

export function targetSourceHint(targetSource: unknown): string {
  if (typeof targetSource !== 'string' || !targetSource) return '';
  return TARGET_SOURCE_HINTS[targetSource] || '';
}

const trimmedText = (value: unknown): string => (value == null ? '' : String(value).trim());

export interface PanelFieldValues {
  groupName?: unknown;
  sessionText?: unknown;
  sessionTitle?: unknown;
  targetLabel?: unknown;
  targetSourceHintText?: unknown;
  rate?: unknown;
  globalText?: unknown;
}

/**
 * 面板五行的最终文案（与 ui/js/float/float.js:401 buildPanelFieldTexts 逐字等价）。
 * 顺序固定：当前群聊 → 会话 → 当前目标 → 速率 → 全局（docs/03 条款 3）；任何一行都不许是空串。
 * 来源提示走 hint（独立浅色小字），不拼进 value —— 拼进去就没法单独换样式。
 */
export function buildPanelFields(values: PanelFieldValues): PanelField[] {
  return [
    { key: 'fpGroup', label: '当前群聊：', value: trimmedText(values.groupName) || PLACEHOLDER },
    { key: 'fpSession', label: '会话：', value: trimmedText(values.sessionText) || PLACEHOLDER, title: trimmedText(values.sessionTitle) || undefined },
    { key: 'fpTarget', label: '当前目标：', value: trimmedText(values.targetLabel) || PLACEHOLDER, hint: trimmedText(values.targetSourceHintText) || undefined },
    { key: 'fpRate', label: '📊 当前速率：', value: trimmedText(values.rate) || RATE_PLACEHOLDER },
    { key: 'fpTotal', label: '📈 全局请求量：', value: trimmedText(values.globalText) || PLACEHOLDER },
  ];
}

export function readViewSize(): Size {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  return { width: window.innerWidth, height: window.innerHeight };
}

export function measureSize(element: HTMLElement | null, fallback: Size): Size {
  const rect = element ? element.getBoundingClientRect() : null;
  if (!rect || !rect.width || !rect.height) return fallback;
  return { width: rect.width, height: rect.height };
}

/** 没定过位时的默认锚点：右下角往里缩一点（与旧实现一致） */
export function defaultAnchor(ballSize: Size, viewSize: Size): Point {
  return clampDockPosition(
    viewSize.width - ballSize.width - DEFAULT_ANCHOR_INSET_PX,
    viewSize.height * DEFAULT_ANCHOR_VERTICAL_RATIO,
    ballSize,
    viewSize,
  );
}
