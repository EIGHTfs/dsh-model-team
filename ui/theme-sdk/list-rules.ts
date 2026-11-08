// list-rules.ts —— 群列表与三 tab 口径的**转调层**（薄壳，不持有实现）。
//
// 单一实现住在宿主 `ui/js/format/list-rules.js`：宿主常驻、主题可增删，规则只能从宿主流向主题。
// 本文件按名字从 `globalThis.dshHostListRules` 取实现，exports 名保持不变（主题代码无需改动）。

import type { TabKey } from './contract';

export interface GroupLike {
  id?: unknown;
  name?: unknown;
  avatar?: unknown;
  summary?: unknown;
  driver?: unknown;
  lastUpdated?: unknown;
}

export interface ListItemView {
  avatar: unknown;
  title: string;
  /** 空串 = 不渲染副标题（不是渲染空行） */
  subtitle: string;
  meta: string;
  active: boolean;
  onClick: () => void;
}

export type ListStatus = 'loaded' | 'empty' | 'load-failed';

interface HostListRules {
  filterGroups<T extends GroupLike>(groups: readonly T[], keyword: string): T[];
  resolveListStatus(groups: readonly unknown[], loadError: string): ListStatus;
  resolveSummaryText(summary: unknown): string;
  resolveCountText(status: ListStatus, groupCount: number): string;
  formatUpdatedAt(lastUpdated: unknown): string;
  buildListItemView(group: GroupLike, currentGroupId: string, onClick: () => void): ListItemView;
  tabKeyOf(view: string): TabKey;
  titleOf(view: string): string;
}

const hostListRules = (): HostListRules => {
  const host = (globalThis as { dshHostListRules?: HostListRules }).dshHostListRules;
  if (!host) throw new Error('宿主列表规则未加载：ui/js/format/list-rules.js 必须先于主题执行');
  return host;
};

/** 搜索过滤（实现在宿主） */
export const filterGroups = <T extends GroupLike>(groups: readonly T[], keyword: string): T[] => hostListRules().filterGroups(groups, keyword);

/** 三态判据（实现在宿主） */
export const resolveListStatus = (groups: readonly unknown[], loadError: string): ListStatus => hostListRules().resolveListStatus(groups, loadError);

/** 副标题文本（实现在宿主） */
export const resolveSummaryText = (summary: unknown): string => hostListRules().resolveSummaryText(summary);

/** 计数文案（实现在宿主） */
export const resolveCountText = (status: ListStatus, groupCount: number): string => hostListRules().resolveCountText(status, groupCount);

/** 时间列（实现在宿主） */
export const formatUpdatedAt = (lastUpdated: unknown): string => hostListRules().formatUpdatedAt(lastUpdated);

/** 列表行展示数据（实现在宿主） */
export const buildListItemView = (group: GroupLike, currentGroupId: string, onClick: () => void): ListItemView => hostListRules().buildListItemView(group, currentGroupId, onClick);

/** 底边栏三 tab：顺序固定（docs/03 条款 6）。本表是**数据**不是逻辑：
 *  必须与宿主 ui/js/format/list-rules.js 的 TAB_ITEMS 一致，由 test/ui-list-rules.test.js 逐项比对。
 *  （不做成模块加载期读宿主：主题 bundle 可能早于宿主脚本求值时会被误判成错误。） */
export const TAB_ITEMS: ReadonlyArray<{ key: TabKey; label: string; view: string }> = [
  { key: 'messages', label: '消息', view: 'list' },
  { key: 'contacts', label: '通讯录', view: 'contacts' },
  { key: 'profile', label: '我', view: 'profile' },
];

/** store 的 view → 高亮哪个 tab（实现在宿主） */
export const tabKeyOf = (view: string): TabKey => hostListRules().tabKeyOf(view);

/** 视图名 → 顶栏标题（实现在宿主） */
export const titleOf = (view: string): string => hostListRules().titleOf(view);
