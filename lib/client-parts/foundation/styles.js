// styles.js —— 注入插件的**宿主层样式**：层级变量 + 极少量宿主环境覆盖。
// 业务界面的样式一律来自主题（ui/themes/*.tsx 的 THEME_STYLES，构建期编译进主题 bundle）；
// 0.4.0 起 legacy 的 ui/css/** 已移除，这里不再内联任何 ui 样式。
var CLIENT_STYLE_ID = "dsh-model-team/ui.css";

// 仅覆盖宿主差异：主窗口默认隐藏，点「进入群聊界面」才显示
// 主题根默认隐藏由主题自己控制；这里只保留宿主环境的兜底（历史行为，删掉会让隐藏态失效）
var HOST_OVERRIDE_CSS = "[data-dmt-theme-host][hidden]{display:none!important}";

function mountStyle() {
  if (document.querySelector('style[data-plugin-css="' + CLIENT_STYLE_ID + '"]') !== null) return;
  var tag = document.createElement("style");
  tag.dataset.plugin = LOG_PREFIX;
  tag.dataset.pluginCss = CLIENT_STYLE_ID;
  // 层级变量来自 z-layers.js 的那一个有序列表：样式表里只写 var(--dmt-z-*)，
  // 数字不落在 CSS 里，新增浮层只改列表一处。
  tag.textContent = pluginZLayerCssRoot() + "\n" + HOST_OVERRIDE_CSS;
  document.head.appendChild(tag);
}
