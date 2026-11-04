// styles.js —— 注入 ui/ 的样式（构建时内联成 UI_CSS 常量）+ 极少量的宿主环境覆盖。
// 业务界面的样式一律来自 ui/css/*.css，这里只补「主窗口默认收起」这类宿主差异。
var CLIENT_STYLE_ID = "dsh-model-team/ui.css";

// 仅覆盖宿主差异：主窗口默认隐藏，点「进入群聊界面」才显示
var HOST_OVERRIDE_CSS = ".team-app[hidden]{display:none!important}";

function mountStyle() {
  if (document.querySelector('style[data-plugin-css="' + CLIENT_STYLE_ID + '"]') !== null) return;
  var tag = document.createElement("style");
  tag.dataset.plugin = LOG_PREFIX;
  tag.dataset.pluginCss = CLIENT_STYLE_ID;
  // 层级变量来自 z-layers.js 的那一个有序列表：样式表里只写 var(--dmt-z-*)，
  // 数字不落在 CSS 里，新增浮层只改列表一处。
  tag.textContent = pluginZLayerCssRoot() + "\n" + UI_CSS + "\n" + HOST_OVERRIDE_CSS;
  document.head.appendChild(tag);
}
