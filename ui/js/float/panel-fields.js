// panel-fields.js —— 悬浮面板五行的字段口径（纯函数）：标签、顺序、占位规则都在这里。
//
// 为什么单独成片：主题 SDK 需要「带标签的字段数组」来排版，legacy 需要「扁平文案」写 DOM。
// 同一份规则两种出口，但**只有一处实现**（SDK 转调这里，见 ui/theme-sdk/dock-geometry.ts）。
// 顺序固定：当前群聊 → 会话 → 当前目标 → 速率 → 全局（docs/03 条款 3）；任何一行都不许是空串。

var PANEL_PLACEHOLDER = '—';
var PANEL_RATE_PLACEHOLDER = '— tok/s';

function trimPanelValue(value) {
  return value == null ? '' : String(value).trim();
}

// 字段数组：key 对应 DOM 钩子 id；title = 值的身份（完整 sessionId），hint = 来源说明
function buildPanelFields(values) {
  var source = values || {};
  return [
    { key: 'fpGroup', label: '当前群聊：', value: trimPanelValue(source.groupName) || PANEL_PLACEHOLDER },
    {
      key: 'fpSession',
      label: '会话：',
      // 两种入参名都认：legacy 给 sessionLabel（扁平），主题给 sessionText（结构化）
      value: trimPanelValue(source.sessionLabel == null ? source.sessionText : source.sessionLabel) || PANEL_PLACEHOLDER,
      title: trimPanelValue(source.sessionTitle) || undefined,
    },
    {
      key: 'fpTarget',
      label: '当前目标：',
      value: trimPanelValue(source.targetLabel) || PANEL_PLACEHOLDER,
      hint: trimPanelValue(source.targetSourceHintText) || undefined,
    },
    { key: 'fpRate', label: '📊 当前速率：', value: trimPanelValue(source.rate) || PANEL_RATE_PLACEHOLDER },
    { key: 'fpTotal', label: '📈 全局请求量：', value: trimPanelValue(source.globalText) || PANEL_PLACEHOLDER },
  ];
}

// 扁平文案：legacy 写 DOM 用（与字段数组同源，逐个映射出来，不再各写一份 trim/占位）
function buildPanelFieldTexts(values) {
  var texts = {};
  var fields = buildPanelFields(values);
  for (var index = 0; index < fields.length; index += 1) {
    texts[fields[index].key] = fields[index].value;
  }
  return texts;
}

// 主题 SDK 转调入口
if (typeof globalThis !== 'undefined') {
  globalThis.dshHostPanelFields = { buildPanelFields: buildPanelFields, buildPanelFieldTexts: buildPanelFieldTexts };
}
