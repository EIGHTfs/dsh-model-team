// theme-epilogue.js —— TSX 主题的运行时接线（**只有配了 theme.source 时**才会被 build.cjs 拼进产物）。
//
// 为什么放在收尾而不是 apply.js 里：apply.js 是 legacy 与主题共用的分片，
// 动它一个字节，未配 theme.source 的产物就不再逐字节相同（M2 立的硬门槛）。
// 所以「主题接线」单独成段、条件产出：没配主题时这段代码根本不存在。
//
// 它做的事：包装 apply —— 先照常跑 legacy（store 与数据装配 boot 都在里面，
// 主题的 hooks 需要那个 store），再把 React 主题挂上去；legacy 悬浮件由主题的 CSS 隐藏。
// M7 把 store 装配提到 apply 层后，这里就只剩「挂主题」。
//
// 失败必须降级（docs/22 §11.3）：主题挂不上就撤掉 html 上的主题标记，界面回到 legacy，绝不白屏。

// 就绪通知的兜底时限：**只用于"事件没来"的告警**，不是等待路径（正常路径是 app.js 主动调用钩子）
var THEME_STORE_READY_WARN_MS = 5000;
var THEME_STORE_HOOK_NAME = "__dmtThemeAttachStore";

function attachThemeStore(themeBundle, isDisposed) {
  var attach = themeBundle.attachStore || themeBundle.__attachStore;
  if (typeof attach !== "function") return null;
  var attached = false;
  var warnTimer = null;

  function cleanup() {
    if (warnTimer !== null) { clearTimeout(warnTimer); warnTimer = null; }
    if (window[THEME_STORE_HOOK_NAME] === onStoreReady) delete window[THEME_STORE_HOOK_NAME];
  }
  function performAttach(store) {
    if (attached || isDisposed() || !store) return;
    attached = true;
    cleanup();
    try { attach(store, STORE_EVENTS); } catch (error) { warnOnce("theme attachStore", error); }
  }
  function onStoreReady(store) { performAttach(store); }

  // 主题晚于 store 装配（热重载等）：直接取当前值，一次即可
  if (window.__teamStore) { performAttach(window.__teamStore); return null; }
  // 正常路径：装配层在 store 就绪那一刻主动调用本钩子（无轮询、无间隔）
  window[THEME_STORE_HOOK_NAME] = onStoreReady;
  // 兜底：只告警"事件没来"，不做任何重试
  warnTimer = setTimeout(function () {
    warnTimer = null;
    if (attached || isDisposed()) return;
    cleanup();
    warnOnce("theme attachStore", new Error("store 就绪通知未在 " + THEME_STORE_READY_WARN_MS + "ms 内到达"));
  }, THEME_STORE_READY_WARN_MS);
  return { dispose: cleanup };
}

// 主题模式下 legacy 的 mountStyle 不会跑，:root 上就没有 --dmt-z-*；
// 这里用同一个函数把变量补上（不复制数值），保证"层级只有一个定义处"。
function ensureZLayerVariables() {
  if (document.querySelector('style[data-dmt-z-layers]')) return;
  if (typeof pluginZLayerCssRoot !== "function") return;
  var layerStyleTag = document.createElement("style");
  layerStyleTag.setAttribute("data-dmt-z-layers", "1");
  layerStyleTag.textContent = pluginZLayerCssRoot();
  document.head.appendChild(layerStyleTag);
}

function mountThemeOverlay() {
  var React = require("react");
  var ReactDomClient = require("react-dom/client");
  var themeBundle = THEME_FACTORY(require);
  var definition = themeBundle && (themeBundle.default || themeBundle);
  if (!definition || typeof definition.Root !== "function") {
    throw new Error("主题导出无效：需要 export default defineTheme({...})");
  }
  var themeId = String((definition.meta && definition.meta.id) || "");
  var container = document.createElement("div");
  container.setAttribute("data-dmt-theme-host", themeId);
  // 层级由**宿主**分配：容器整体放进 app 层（数值来自 z-layers.js 的唯一有序列表），
  // 主题只在自己的容器内部排相对顺序，不持有任何跨宿主的层级数值。
  ensureZLayerVariables();
  container.style.position = "relative";
  container.style.zIndex = "var(--dmt-z-app)";
  document.body.appendChild(container);
  var styleTag = null;
  if (typeof definition.styles === "string" && definition.styles) {
    styleTag = document.createElement("style");
    styleTag.setAttribute("data-theme", themeId);
    styleTag.textContent = definition.styles;
    document.head.appendChild(styleTag);
  }
  // 主题 CSS 靠这个属性隐藏 legacy 悬浮件：同一个界面只能有一套可见的球
  document.documentElement.setAttribute("data-dmt-theme", themeId);
  var disposed = false;
  var storeTimer = attachThemeStore(themeBundle, function () { return disposed; });
  var root = ReactDomClient.createRoot(container);
  root.render(React.createElement(definition.Root, { mount: "overlay" }));
  return {
    dispose: function () {
      disposed = true;
      if (storeTimer && typeof storeTimer.dispose === "function") storeTimer.dispose();
      try { root.unmount(); } catch (error) { warnOnce("theme unmount", error); }
      container.remove();
      if (styleTag) styleTag.remove();
      document.documentElement.removeAttribute("data-dmt-theme");
    }
  };
}

(function wireThemeMount() {
  if (typeof THEME_FACTORY !== "function") return;
  var originalApply = exports.apply;
  exports.apply = function applyWithTheme(ctx) {
    originalApply(ctx);
    ctx.effect(function () {
      var themed = null;
      try {
        themed = mountThemeOverlay();
      } catch (error) {
        // 降级：主题挂不上就回到 legacy（此时 html 上不该留主题标记）。
        // 原因写进 data-dmt-theme-error：没有它，界面上只会「看起来还是旧界面」，
        // 排查时无法区分「没配主题」和「主题挂了但被降级」——两者现象完全一样。
        warnOnce("theme mount", error);
        document.documentElement.removeAttribute("data-dmt-theme");
        document.documentElement.setAttribute("data-dmt-theme-error", String((error && error.message) || error).slice(0, 200));
      }
      return function () {
        if (themed) { try { themed.dispose(); } catch (error) { warnOnce("theme dispose", error); } }
      };
    }, "dsh-model-team: theme");
  };
})();
