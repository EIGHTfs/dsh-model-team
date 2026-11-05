// ui-format.js —— 跨视图共用的「纯展示口径」小工具。
// 为什么单独成文件：球（float.js）、@ 选择器（render.js）、切换提示（chat.js）三处都要用，
// 各写一份必然在边界上漂移（未知值怎么显示、字母怎么取），而且 render.js 已到 400 行上限，
// 把这些"口径"搬出来比压行更符合约定。

// 球内目标标记（G6）：有 URL 头像就只显示图、不显示任何文字；没有头像就用平台首字母圆牌。
// 为什么不另写一套首字母规则：renderAvatar 已经封装了「URL 判定 + 首字母 + 转义」，
// 复制一份必然在"空名/小写/非 URL"这些边界上漂移。
function renderFloatTargetMarkup(platform) {
  const avatarText = platform && platform.avatar;
  const platformName = platform && platform.name;
  const renderedAvatar = renderAvatar(avatarText, platformName);
  if (renderedAvatar.indexOf('<img') === 0) return renderedAvatar;
  return '<span class="fb-initial">' + renderedAvatar + '</span>';
}

// 上下文窗口的展示口径：未知一律 —（契约 02 §3.7：缺失不填，不许编造）
// 128000 → 128K、1048576 → 1M、0/负数/NaN/空 → —
function formatContextLength(contextLength) {
  const numericValue = typeof contextLength === 'number' ? contextLength : Number(contextLength);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return '—';
  if (numericValue >= 1000000) return (numericValue / 1000000).toFixed(numericValue % 1000000 === 0 ? 0 : 1) + 'M';
  if (numericValue >= 1000) return Math.round(numericValue / 1000) + 'K';
  return String(numericValue);
}
