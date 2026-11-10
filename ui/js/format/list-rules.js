// list-rules.js —— 群列表 / 底边栏 tab 的口径（纯函数）：两套主题与 legacy 渲染层共用同一份。
//
// 为什么单独一个分片：这些规则（summary 原样透传、空值不占位、失败不显示 0 个群、tab 顺序）
// 是契约级规则（docs/02 §3.9、docs/03 条款 6/11/12）。
// 以前它们内联在 render.js 里拼字符串——没法单测，主题侧只好再写一遍。
// 现在**唯一实现**在这里，SDK 只做转调（见 ui/theme-sdk/list-rules.ts）。

var TAB_ITEMS = [
  { key: 'messages', label: '消息', view: 'list' },
  { key: 'contacts', label: '通讯录', view: 'contacts' },
  { key: 'profile', label: '我', view: 'profile' }
];
var GROUP_COUNT_SUFFIX = ' 个群 · 每个群 = 一个平台账号';
var LOAD_FAILED_TEXT = '加载失败';

// 搜索过滤：name / summary / driver / id 任一包含关键词即命中（大小写不敏感）；
// 空关键词返回全量（复制一份，调用方改数组不影响原列表）
function filterGroups(groups, keyword) {
  var trimmedKeyword = String(keyword == null ? '' : keyword).trim().toLowerCase();
  var sourceGroups = Array.isArray(groups) ? groups : [];
  if (!trimmedKeyword) return sourceGroups.slice();
  return sourceGroups.filter(function (group) {
    return [group.name, group.summary, group.driver, group.id]
      .map(function (field) { return field == null ? '' : String(field); })
      .join(' ')
      .toLowerCase()
      .indexOf(trimmedKeyword) >= 0;
  });
}

// 三态：空列表 + 有失败原因 = 加载失败；空且无失败才是"确实没有群"
function resolveListStatus(groups, loadError) {
  var groupCount = Array.isArray(groups) ? groups.length : 0;
  if (groupCount > 0) return 'loaded';
  return loadError ? 'load-failed' : 'empty';
}

// 副标题：trim 后为空 → 空串（调用方据此整行不渲染）；判空用 trim、渲染不 trim（原样透传）
function resolveSummaryText(summary) {
  var rawText = summary == null ? '' : String(summary);
  return rawText.trim() ? rawText : '';
}

// 计数文案：失败 → 「加载失败」；否则 「N 个群 · 每个群 = 一个平台账号」
function resolveCountText(status, groupCount) {
  if (status === 'load-failed') return LOAD_FAILED_TEXT;
  return String(groupCount || 0) + GROUP_COUNT_SUFFIX;
}

// 时间列：当天 HH:mm、昨天「昨天」、更早 MM-DD；缺失/非法 → 空串（不渲染）
function formatUpdatedAt(isoText) {
  if (!isoText) return '';
  var when = new Date(isoText);
  if (isNaN(when.getTime())) return '';
  var now = new Date();
  var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  var startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  var stamp = when.getTime();
  if (stamp >= startOfToday) {
    return String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0');
  }
  if (stamp >= startOfYesterday) return '昨天';
  return String(when.getMonth() + 1).padStart(2, '0') + '-' + String(when.getDate()).padStart(2, '0');
}

// 列表行展示数据（主题只排版；判空、格式化都在这做完）
function buildListItemView(group, currentGroupId, onClick) {
  var target = group || {};
  return {
    avatar: target.avatar,
    title: target.name == null ? '' : String(target.name),
    subtitle: resolveSummaryText(target.summary),
    meta: formatUpdatedAt(target.lastUpdated),
    active: target.id != null && String(target.id) === currentGroupId,
    onClick: onClick
  };
}

// store 的 view → 高亮哪个 tab（chat/add/db 都算「消息」语境）
function tabKeyOf(view) {
  if (view === 'contacts') return 'contacts';
  if (view === 'profile') return 'profile';
  return 'messages';
}

// 视图名 → 顶栏标题
function titleOf(view) {
  if (view === 'chat') return '群聊';
  if (view === 'add') return '加群';
  if (view === 'contacts') return '通讯录';
  if (view === 'profile') return '我';
  if (view === 'db') return '数据库';
  return '消息';
}

// 主题 SDK（ui/theme-sdk/list-rules.ts）只是转调这里（唯一实现）。
if (typeof globalThis !== 'undefined') {
  globalThis.dshHostListRules = {
    TAB_ITEMS: TAB_ITEMS,
    GROUP_COUNT_SUFFIX: GROUP_COUNT_SUFFIX,
    LOAD_FAILED_TEXT: LOAD_FAILED_TEXT,
    filterGroups: filterGroups,
    resolveListStatus: resolveListStatus,
    resolveSummaryText: resolveSummaryText,
    resolveCountText: resolveCountText,
    formatUpdatedAt: formatUpdatedAt,
    buildListItemView: buildListItemView,
    tabKeyOf: tabKeyOf,
    titleOf: titleOf,
  };
}
