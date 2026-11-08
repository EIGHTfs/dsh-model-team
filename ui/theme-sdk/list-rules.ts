// list-rules.ts —— 群列表与三 tab 的口径：两套主题必须完全一致的那部分。
//
// 为什么在 SDK 而不是主题里：summary 的「原样透传 / 空值不占位 / 失败不显示 0 个群」是
// 契约级规则（docs/02 §3.9、docs/24 D-4），tab 的顺序与映射是界面条款（docs/03 条款 6）。
// 这些一旦写进主题，两套就得各写一遍，规则漂移只是时间问题。

import type { TabKey } from './contract';

export interface GroupLike {
  id?: unknown;
  name?: unknown;
  avatar?: unknown;
  summary?: unknown;
  driver?: unknown;
  lastUpdated?: unknown;
}

export const GROUP_COUNT_SUFFIX = ' 个群 · 每个群 = 一个平台账号';
export const LOAD_FAILED_TEXT = '加载失败';

/**
 * 搜索过滤：name / summary / driver / id 任一包含关键词即命中（大小写不敏感）。
 * 与 legacy `ui/js/app.js:155` 的过滤口径一致——只搜这四个字段，不搜后端没给的字段。
 */
export function filterGroups<T extends GroupLike>(groups: readonly T[], keyword: string): T[] {
  const trimmedKeyword = String(keyword || '').trim().toLowerCase();
  if (!trimmedKeyword) return [...groups];
  return groups.filter((group) => [group.name, group.summary, group.driver, group.id]
    .map((field) => (field == null ? '' : String(field)))
    .join(' ')
    .toLowerCase()
    .indexOf(trimmedKeyword) >= 0);
}

export type ListStatus = 'loaded' | 'empty' | 'load-failed';

/** 三态判据与 legacy 一致：空列表 + 有失败原因 = 加载失败；空且无失败才是「确实没有群」 */
export function resolveListStatus(groups: readonly unknown[], loadError: string): ListStatus {
  if (groups.length > 0) return 'loaded';
  return loadError ? 'load-failed' : 'empty';
}

/**
 * 副标题文本：trim 后为空 → 空串（调用方据此整行不渲染）；否则返回**原值**。
 * 判空用 trim、渲染不 trim：前后空格属于后端给的内容，吃掉它就算加工（C-1）。
 */
export function resolveSummaryText(summary: unknown): string {
  const rawText = summary == null ? '' : String(summary);
  return rawText.trim() ? rawText : '';
}

/** 计数文案：失败 → 「加载失败」；否则 「N 个群 · 每个群 = 一个平台账号」 */
export function resolveCountText(status: ListStatus, groupCount: number): string {
  if (status === 'load-failed') return LOAD_FAILED_TEXT;
  return `${groupCount}${GROUP_COUNT_SUFFIX}`;
}

/** 时间列：`MM-DD` 短文本；时间非法或缺失则空（不渲染） */
export function formatUpdatedAt(lastUpdated: unknown): string {
  const raw = lastUpdated == null ? '' : String(lastUpdated);
  if (!raw) return '';
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) return '';
  return `${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
}

/** 列表行的展示数据（主题只排版；判空、格式化都在这做完） */
export interface ListItemView {
  avatar: unknown;
  title: string;
  /** 空串 = 不渲染副标题（不是渲染空行） */
  subtitle: string;
  meta: string;
  active: boolean;
  onClick: () => void;
}

export function buildListItemView(group: GroupLike, currentGroupId: string, onClick: () => void): ListItemView {
  return {
    avatar: group.avatar,
    title: group.name == null ? '' : String(group.name),
    subtitle: resolveSummaryText(group.summary),
    meta: formatUpdatedAt(group.lastUpdated),
    active: group.id != null && String(group.id) === currentGroupId,
    onClick,
  };
}

/** 底边栏三 tab：顺序固定（docs/03 条款 6），key 与 store 的 view 名一一对应 */
export const TAB_ITEMS: ReadonlyArray<{ key: TabKey; label: string; view: string }> = [
  { key: 'messages', label: '消息', view: 'list' },
  { key: 'contacts', label: '通讯录', view: 'contacts' },
  { key: 'profile', label: '我', view: 'profile' },
];

/** store 的 view → 高亮哪个 tab（chat/add/db 都算「消息」语境，底栏仍停在第 1 个） */
export function tabKeyOf(view: string): TabKey {
  if (view === 'contacts') return 'contacts';
  if (view === 'profile') return 'profile';
  return 'messages';
}

/** 视图名 → 顶栏标题 */
export function titleOf(view: string): string {
  if (view === 'chat') return '群聊';
  if (view === 'add') return '加群';
  if (view === 'contacts') return '通讯录';
  if (view === 'profile') return '我';
  if (view === 'db') return '数据库';
  return '消息';
}
