// index.ts —— 主题 SDK 的唯一导出面。
//
// 主题只允许从 '../theme-sdk' 这一个入口 import：
// 分组导出看起来只是方便，实际是「什么算稳定契约」的边界——
// 主题作者绕过它去 import './store-bridge' 的具体文件，SDK 内部重构就会伤到别人。

export {
  THEME_CONTRACT_VERSION,
  defineTheme,
  type ThemeDefinition,
  type ThemeMeta,
  type ThemeRootProps,
  type ThemeSetupContext,
} from './contract';

export type { TabKey } from './contract';

export {
  DRAG_THRESHOLD_PX,
  PANEL_GAP_PX,
  BALL_FALLBACK_SIZE_PX,
  PANEL_FALLBACK_SIZE,
  PLACEHOLDER,
  RATE_PLACEHOLDER,
  DEFAULT_ANCHOR_INSET_PX,
  DEFAULT_ANCHOR_VERTICAL_RATIO,
  TARGET_SOURCE_HINTS,
  clampDockPosition,
  computeOpenDir,
  computePanelPosition,
  shouldStartDrag,
  formatSessionLine,
  formatTargetLabel,
  targetSourceHint,
  buildPanelFields,
  readViewSize,
  measureSize,
  defaultAnchor,
  type Size,
  type Point,
  type Rect,
  type OpenDirection,
  type PanelField,
  type PanelFieldValues,
} from './dock-geometry';

export { readDockBridge, useDockState, type DockBridge, type DockStateSnapshot } from './dock-state';

export {
  buildAvatarView,
  nextAvatarView,
  avatarInitial,
  type AvatarView,
} from './avatar';

export {
  isAccountAuthDriver,
  credentialFieldsOf,
  driverDisplayName,
  type DriverMetaLike,
  type DriverCredentialField,
} from './driver-view';

export {
  GROUP_COUNT_SUFFIX,
  LOAD_FAILED_TEXT,
  TAB_ITEMS,
  filterGroups,
  resolveListStatus,
  resolveSummaryText,
  resolveCountText,
  formatUpdatedAt,
  buildListItemView,
  tabKeyOf,
  titleOf,
  type GroupLike,
  type ListStatus,
  type ListItemView,
} from './list-rules';

export {
  attachStore,
  detachStore,
  subscribeThemeStore,
  getStoreVersion,
  getRawState,
  getStateOrEmpty,
  bumpVersion,
  createSelectionCache,
  type TeamStoreLike,
  type StateSelector,
  type EqualityCheck,
  type StoreListener,
} from './store-bridge';

export {
  useTeamState,
  useGroups,
  useGroupsError,
  useDrivers,
  useGroupOptions,
  useAddForm,
  useFriendGroups,
  useTarget,
  useChat,
  useSession,
  useStats,
  useView,
  useDock,
  useErrors,
  readThemeState,
} from './hooks';

export { actions, type ThemeActions, type ViewName, type TargetLike } from './actions';
