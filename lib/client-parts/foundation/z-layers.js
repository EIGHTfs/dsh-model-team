// z-layers.js —— 插件自有浮层的上下层关系：一处分配，CSS 只引用变量。
//
// 为什么要有这个函数：
//   1) 宿主界面自己就用了极端大的 z-index，按契约条款 4，整块插件界面必须压住宿主所有界面，
//      所以基数只能是 2147482000 这一档；但"我们自己几个部件之间谁高谁低"跟宿主无关，
//      不该把基数+1/+2 这类偏移抄到每条 CSS 里——新增一层就要翻遍所有样式文件。
//   2) 层级错位只会在真实渲染里暴露：弹窗被主窗口整块盖住、提示条藏在主窗口后面，
//      这类问题单测与接口检查都看不见。把顺序集中成一个有序列表后，顺序错了改一行就行。
//
// 这里只排插件自己的部件；宿主界面元素的层级不归我们管，也不要去改。

// 契约条款 4：插件界面必须压住宿主所有界面（宿主自己也用这一档，故取同一数量级）
var PLUGIN_Z_BASE = 2147482000;

// 由低到高排列。新增浮层时插到正确位置即可，其余层的相对关系自动保持。
//   dock   悬浮球
//   recall 收起后的"再次呼出"按钮（与球互斥，同档即可）
//   panel  悬浮面板（点球展开的那块）
//   app    模型团队主窗口
//   modal  主窗口里点开的弹窗（必须压过主窗口，否则表单会被主窗口盖住）
//   toast  轻提示（必须最上：保存成功/失败都要能在弹窗之上被看见）
var PLUGIN_Z_LAYER_ORDER = ['dock', 'recall', 'panel', 'app', 'modal', 'toast'];

// CSS 变量名统一前缀，样式里按 --dmt-z-<层名> 引用
var PLUGIN_Z_CSS_VAR_PREFIX = '--dmt-z-';

// 取某一层的层级值。未知层名退回基数：宁可它是"最底层但可见"，
// 也不要返回 undefined —— 那样这条 z-index 声明会整条失效，浮层可能被宿主盖住。
function pluginZIndex(layerName) {
  var layerIndex = PLUGIN_Z_LAYER_ORDER.indexOf(String(layerName));
  if (layerIndex < 0) return PLUGIN_Z_BASE;
  return PLUGIN_Z_BASE + layerIndex + 1;
}

// 生成 :root{--dmt-z-...} 规则，随样式一起注入（见 foundation/styles.js 的 mountStyle）。
// 用变量而不是把数字写进各条 CSS，是为了让"顺序"只有一个定义处。
function pluginZLayerCssRoot() {
  var declarations = PLUGIN_Z_LAYER_ORDER.map(function (layerName) {
    return PLUGIN_Z_CSS_VAR_PREFIX + layerName + ':' + pluginZIndex(layerName);
  }).join(';');
  return ':root{' + declarations + ';}';
}
