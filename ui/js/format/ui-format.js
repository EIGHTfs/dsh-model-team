// ui-format.js —— 跨视图共用的「纯展示口径」小工具。
// 为什么单独成文件：球（float.js）、@ 选择器（render.js）、切换提示（chat.js）三处都要用，
// 各写一份必然在边界上漂移（未知值怎么显示、字母怎么取），而且 render.js 已到 400 行上限，
// 把这些"口径"搬出来比压行更符合约定。
// 依赖方向：本文件的函数会调用 render.js 的 escapeHtml / renderAvatar，靠的是
// build.cjs 的 UI_PARTS 把它们拼进同一个作用域（format 在前、render 在后，顺序有断言守着）。
// 单独执行本文件（不在 bundle 里）时必须自行垫上这两个函数，别把「依赖同作用域」当隐式约定。

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
// 两个量级阈值提成常量：M/K 各自对应 1000000 / 1000，改口径时不用在表达式里找数字
const CONTEXT_LENGTH_MILLION = 1000000;
const CONTEXT_LENGTH_THOUSAND = 1000;

function formatContextLength(contextLength) {
  const numericValue = typeof contextLength === 'number' ? contextLength : Number(contextLength);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return '—';
  if (numericValue >= CONTEXT_LENGTH_MILLION) {
    const millionText = (numericValue / CONTEXT_LENGTH_MILLION).toFixed(
      numericValue % CONTEXT_LENGTH_MILLION === 0 ? 0 : 1
    );
    return millionText + 'M';
  }
  if (numericValue >= CONTEXT_LENGTH_THOUSAND) return Math.round(numericValue / CONTEXT_LENGTH_THOUSAND) + 'K';
  return String(numericValue);
}

// 副标题（群列表里「接入方式 · 地址」那一行）：内容由后端整串给出，这里只判空、不加工。
// trim 后为空就不输出节点——空 div 会在列表里留一条视觉空行，看起来像「副标题是空白的」（D-4）。
function renderGroupSummaryLine(summaryText) {
  const rawText = String(summaryText == null ? '' : summaryText);
  return rawText.trim() ? `<div class="group-summary">${escapeHtml(rawText)}</div>` : '';
}

// 群友数三态（D-3，docs/24 §八）：status 决定显示什么，不能一律用占位符糊过去。
// loading → `—`（未知，显示成 0 就是把「没拉到」当成「没有群友」）；error → `加载失败`（失败要让用户知道该重试）。
function formatMemberCount(models, modelsStatus) {
  if (modelsStatus === 'error') return '加载失败';
  if (modelsStatus === undefined || modelsStatus === 'loaded') return String(models.length);
  return '—';
}

// 会话行（docs/03 条款 5，D-6）：有标题 →「标题（短 id）」；无标题 →「未命名会话」；
// 完整 id 交给调用方放进 title 属性；草稿（无 id）→ —。
// 短 id 取「去掉 session- 前缀后的前 8 位」——直接取原串前 8 位永远是 "session-"。
function formatSessionLine(sessionId, sessionTitle) {
  const rawId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!rawId) return { text: '—', title: '' };
  const shortId = rawId.replace(/^session-/, '').slice(0, 8);
  const title = typeof sessionTitle === 'string' ? sessionTitle.trim() : '';
  if (!title) return { text: '未命名会话', title: rawId };
  return { text: title + '（' + shortId + '）', title: rawId };
}

// 目标文案：分组 → @分组名（名字取好友分组，取不到回落 id）；单模型 → 去 global: 前缀；空 → —
function formatTargetLabel(effectiveTarget, friendGroups) {
  const target = effectiveTarget;
  if (!target || typeof target !== 'object') return '—';
  if (target.type === 'group') {
    const groups = Array.isArray(friendGroups) ? friendGroups : [];
    const matched = groups.filter(function (friendGroup) { return String(friendGroup.id) === String(target.id); })[0];
    const matchedName = matched && typeof matched.name === 'string' ? matched.name.trim() : '';
    return '@' + (matchedName || String(target.id || ''));
  }
  const modelId = String(target.id || target.model || '').replace(/^global:/, '').trim();
  return modelId || '—';
}

// 主题 SDK 转调入口（唯一实现在这里/配套文件，SDK 不再各写一份）
if (typeof globalThis !== 'undefined') {
  globalThis.dshHostUiFormat = {
    formatSessionLine: formatSessionLine,
    formatTargetLabel: formatTargetLabel,
  };
}
