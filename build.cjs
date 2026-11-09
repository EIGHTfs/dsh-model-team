/**
 * 构建脚本：拼接 lib/client-parts/ 片段 + 直接复用 ui/ 的样式与渲染层 → 单文件 lib/client.js。
 *
 * - 顺序由 PART_ORDER 里两组数组显式声明（文件名语义化、不带序号）
 * - ui CSS 由本脚本内联成 UI_CSS 常量（按 ui/app.css 的 @import 顺序），避免运行时依赖外部文件
 * - ui 的 render/chat/admin/float/app 分片原样拼入（唯一一套界面实现，禁止再手写第二套）
 * - 配了 theme.source 时，额外把 TSX 主题编译成 THEME_BUNDLE 段插在 UI 分片之后、收尾分片之前；
 *   没配则产物**逐字节不变**（legacy 门槛，见 docs/03 §7.4 最后一行）
 * - 产物头写明「自动生成，勿手改」
 * - 幂等：同样输入 → 逐字节相同的产物
 *
 * 用法：node build.cjs
 */
const fs = require("fs");
const path = require("path");
const themeConfig = require("./scripts/lib/theme-config.cjs");

const root = __dirname;
const partsDir = path.join(root, "lib", "client-parts");
const uiDir = path.join(root, "ui");
const clientPath = path.join(root, "lib", "client.js");

// 插件侧分片（先声明基础能力）
const CLIENT_PARTS = [
  "foundation/loader.js",
  "foundation/constants.js",
  "foundation/utils.js",
  "foundation/session.js",
  "foundation/api.js",
  // 层级分配要在 styles.js 之前：mountStyle() 注入样式时会把这一层算出的 :root 变量带上
  "foundation/z-layers.js",
  "foundation/styles.js"
];

// 设计稿分片：直接读 ui/js/*，不复制副本（改 ui 即改客户端）。
// 顺序即依赖：rate（速率纯函数）→ messages（消息合并纯函数）→ store（唯一真相源）→ session-bridge → 视图 → app。
const UI_PARTS = [
  // 顺序即依赖（数组顺序 = 拼接顺序，没有 import）：
  // format（纯函数）→ view 的 messages → float/target-source → store 各工厂 → store 装配
  // → view 的 model-catalog → interaction/session-bridge → float/dock-state → view/render
  // → friend-group 三层 → interaction/chat → view/admin → float/float → app 入口
  // 速率不再有客户端分片：公式在 lib/shared/rate.mjs（可拷复用的纯模块），
  // 由服务端按声明动态加载后算出 { tps, exact }，客户端只做显示（单位与 ≈）。
  "js/view/messages.js", "js/float/target-source.js", "js/format/ui-format.js", "js/format/list-rules.js", "js/format/driver-view.js", "js/format/avatar-chain.js",
  "js/store/state.js", "js/store/persist.js", "js/store/events.js", "js/store/forms.js",
  "js/store/groups.js", "js/store/chat.js", "js/store/stats.js",
  "js/store/session.js", "js/store/dispatch.js", "js/store/index.js",
  "js/view/model-catalog.js", "js/interaction/model-selection-source.js", "js/interaction/session-bridge.js",
  "js/float/dock-state.js", "js/float/geometry.js", "js/float/panel-fields.js", "js/view/reverse-account.js", "js/view/render.js",
  "js/friend-group/form.js", "js/friend-group/view.js", "js/friend-group/modal.js",
  "js/interaction/chat.js", "js/view/admin.js", "js/interaction/reverse-login.js", "js/float/float.js", "js/app.js"
];

// 收尾：DOM 骨架 + apply
const TAIL_PARTS = ["dock.js", "apply.js"];

// 拼接前自检：分片不是模块，数组顺序就是依赖顺序——错了只有运行时才炸。
// 把"文件存在"与"关键顺序"变成构建期失败，别指望注释维持。
function assertPartList(partNames, baseDirectory, listLabel) {
  const missing = partNames.filter((name) => !fs.existsSync(path.join(baseDirectory, name)));
  if (missing.length > 0) throw new Error(`[build] ${listLabel} 里有不存在的分片：${missing.join("、")}`);
}

function assertPartOrder() {
  const pairs = [
    [CLIENT_PARTS, "foundation/z-layers.js", "foundation/styles.js", "z-layers 必须早于 styles"],
    [UI_PARTS, "js/store/state.js", "js/store/index.js", "store/state 必须早于 store/index"],
    [UI_PARTS, "js/float/dock-state.js", "js/float/float.js", "dock-state 必须早于 float"],
    // ui-format 提供跨视图展示口径（群友数三态、副标题判空），render 是它们的调用方：
    // 拼接顺序反了就会在真实产物里变成「调用先于定义」（函数声明能提升，但 const/let 不能）。
    [UI_PARTS, "js/format/ui-format.js", "js/view/render.js", "ui-format 必须早于 render"],
    [UI_PARTS, "js/format/list-rules.js", "js/view/render.js", "list-rules 必须早于 render"],
    [UI_PARTS, "js/format/avatar-chain.js", "js/view/render.js", "avatar-chain 必须早于 render"],
    [UI_PARTS, "js/float/geometry.js", "js/float/float.js", "geometry 必须早于 float"],
    [UI_PARTS, "js/float/panel-fields.js", "js/float/float.js", "panel-fields 必须早于 float"],
    [UI_PARTS, "js/interaction/model-selection-source.js", "js/interaction/session-bridge.js", "model-selection-source 必须早于 session-bridge"],
  ];
  for (const [list, early, late, reason] of pairs) {
    const earlyIndex = list.indexOf(early);
    const lateIndex = list.indexOf(late);
    if (earlyIndex < 0 || lateIndex < 0) throw new Error(`[build] 顺序断言找不到分片：${early} / ${late}`);
    if (earlyIndex > lateIndex) throw new Error(`[build] 分片顺序错误：${reason}（${early}=${earlyIndex} > ${late}=${lateIndex}）`);
  }
}

assertPartList(CLIENT_PARTS, partsDir, "CLIENT_PARTS");
assertPartList(UI_PARTS, uiDir, "UI_PARTS");
assertPartList(TAIL_PARTS, partsDir, "TAIL_PARTS");
assertPartOrder();

const HEADER = [
  "// ⚠️ 本文件由 build.cjs 自动生成（拼接 lib/client-parts/ 与 ui/js/ 片段），请勿手改——",
  "// 手改会在下次 node build.cjs 时被覆盖。改代码请改对应源文件后重新 build。",
  ""
].join("\n");

// 主题（HTML 骨架 + 样式清单）由 scripts/lib/theme-config.cjs 解析：
// 优先级 --config → DSH_MODEL_TEAM_HOME/config.json → 仓库 config/config.json，都没有才回落 ui/ 的默认路径。
// 配了但无效（文件缺失 / 缺标记 / styles 里缺一个）会在那里直接抛错——不静默回落。
const theme = themeConfig.resolveThemeConfig({ argv: process.argv.slice(2), repoRoot: root });

// 按主题给的样式清单顺序读，剥掉 design-only 段后拼成一个 CSS 字符串常量
function readThemeCss() {
  return themeConfig.readThemeStyles(theme.stylePaths).join("\n");
}

function readPart(relativePath) {
  return fs.readFileSync(path.join(partsDir, relativePath), "utf8");
}

// 从 ui/index.html 抽出界面骨架（<body> 到第一个 <script> 之间），客户端不再手抄一份 DOM。
// 设计稿专用装饰（.desk 垫场层）用 design-only 注释包住，构建时整段剥掉，绝不进宿主；
// 剥完还要做白名单断言，防止以后往 index.html 加装饰又漏进宿主。
const SKELETON_REQUIRED = ['id="floatDock"', 'id="floatPanel"', 'class="team-app"'];
const SKELETON_FORBIDDEN = ['class="desk"', 'desk-bar', 'desk-card', 'desk-tip'];

function readUiSkeleton(htmlPath) {
  const html = themeConfig.assertThemeHtml(fs.readFileSync(htmlPath, "utf8"), htmlPath);
  const bodyStart = html.indexOf("<body>");
  const scriptStart = html.indexOf("<script");
  if (bodyStart < 0 || scriptStart < 0 || scriptStart <= bodyStart) {
    throw new Error("[build] 无法从主题 HTML 提取骨架（<body> / <script> 标记缺失）：" + htmlPath);
  }
  const skeleton = themeConfig.stripDesignOnly(html.slice(bodyStart + "<body>".length, scriptStart)).trim();

  const missing = SKELETON_REQUIRED.filter((marker) => skeleton.indexOf(marker) < 0);
  if (missing.length) {
    throw new Error("[build] 骨架缺少必需块：" + missing.join("、"));
  }
  const leaked = SKELETON_FORBIDDEN.filter((marker) => skeleton.indexOf(marker) >= 0);
  if (leaked.length) {
    throw new Error("[build] 设计稿专用内容漏进骨架：" + leaked.join("、")
      + "（请用 <!-- design-only:begin/end --> 包起来）");
  }
  return skeleton;
}

function readUiPart(relativePath) {
  return fs.readFileSync(path.join(uiDir, relativePath), "utf8");
}

const uiCssPart = "// 由 build.cjs 内联的 ui 样式（勿手改）\nvar UI_CSS = " + JSON.stringify(readThemeCss()) + ";\n";
const uiSkeletonPart = "// 由 build.cjs 从 ui/index.html 抽取的界面骨架（勿手改）\nvar UI_SKELETON_HTML = "
  + JSON.stringify(readUiSkeleton(theme.htmlPath)) + ";\n";

// TSX 主题段：只有配置了 theme.source 才产出。
// 为什么包成 factory：esbuild 的 cjs 产物里是 require("react")，
// ModuleLoader 的签名恰好是 function (require)，原样塞进函数体就零适配（docs/03 §7.3）。
function buildThemePart(built) {
  return "// 由 scripts/build-theme.mjs 编译的 TSX 主题（esbuild-wasm 产物，勿手改）\n"
    + "var THEME_META = " + JSON.stringify(built.meta) + ";\n"
    + "var THEME_FACTORY = function (require) {\n"
    + "  var module = { exports: {} };\n"
    + "  var exports = module.exports;\n"
    + built.bundleCode
    + "\n  return module.exports;\n"
    + "};\n";
}

async function readThemeBundlePart() {
  if (!theme.themeSourcePath) return "";
  const buildTheme = await import("./scripts/build-theme.mjs");
  const built = await buildTheme.buildThemeBundle(theme.themeSourcePath);
  console.log("[build] TSX 主题已编译：" + built.bytes + " 字节（meta.id=" + built.meta.id + "）");
  return buildThemePart(built);
}

// 把主题接线语句插到 apply 的导出之后（那时 exports.apply 已经是真函数，且还没 return）
function insertThemeEpilogue(sourceText) {
  const anchor = "exports.apply = apply;";
  if (sourceText.indexOf(anchor) < 0) {
    throw new Error("[build] 找不到 exports.apply = apply;，无法接入主题接线（apply.js 结构变了？）");
  }
  const epilogue = readPart("theme-epilogue.js");
  return sourceText.replace(anchor, anchor + "\n" + epilogue);
}

async function main() {
  const themeBundlePart = await readThemeBundlePart();
  const source = [
    ...CLIENT_PARTS.map(readPart),
    uiCssPart,
    uiSkeletonPart,
    ...UI_PARTS.map(readUiPart),
    ...(themeBundlePart ? [themeBundlePart] : []),
    ...TAIL_PARTS.map(readPart)
  ].join("");

  // 主题接线：必须是**语句**、插在 `exports.apply = apply;` 之后、`return module.exports;` 之前。
  // 放在收尾分片之后是错的——apply.js 末尾就 return 了，那之后的代码永远不会执行（踩过）。
  const themedSource = themeBundlePart ? insertThemeEpilogue(source) : source;

  const output = HEADER + themedSource;
  fs.writeFileSync(clientPath, output, "utf8");

// 断言：防止「又忘了内联 ui 与渲染层」——缺任何一项都直接失败
const requiredSnippets = [
  ['var API_PREFIX = "/_team";', "请求前缀"],
  ["var UI_CSS = ", "ui 样式内联"],
  ["var UI_SKELETON_HTML = ", "ui/index.html 骨架内联"],
  [".req-bubble", "ui/css/views.css 特征选择器"],
  ["function renderChat", "ui/js/render.js"],
  ["function apiFormatSessionRate", "foundation/api.js（速率显示：值来自服务端）"],
  ["function targetSourceHintOf", "ui/js/target-source.js（来源文案唯一口径）"],
  ["function renderFloatTargetMarkup", "ui/js/ui-format.js（跨视图展示口径）"],
  ["function createPersistencePort", "ui/js/store-persist.js（持久化端口）"],
  ["function createGroupLoaders", "ui/js/store-groups.js（群列表加载）"],
  ["function createChatLoaders", "ui/js/store-chat.js（单群聊天加载）"],
  ["function createStatsLoaders", "ui/js/store-stats.js（统计与目标）"],
  ["function createSessionAndTarget", "ui/js/store-session.js（会话与目标）"],
  ["function createDispatcher", "ui/js/store-dispatch.js（动作分派）"],
  ["function createInitialState", "ui/js/store-state.js（状态形状）"],
  ["function createEventHub", "ui/js/store-events.js（事件总线与错误出口）"],
  ["function mountDock", "dock.js"]
];
  const missing = requiredSnippets.filter(([snippet]) => output.indexOf(snippet) < 0);
  if (missing.length) {
    console.error("[build] 产物缺少必需内容：" + missing.map(([, label]) => label).join("、"));
    process.exit(1);
  }

  // TSX 主题的产物断言（docs/03 §7.4）：段必须在 UI 分片之后、收尾分片之前，
  // 且主题根标记已经进产物——顺序错了会在运行期变成「用了未定义的东西」，这里提前失败。
  if (themeBundlePart) {
    const themeIndex = output.indexOf("var THEME_FACTORY = ");
    const uiTailIndex = output.indexOf("function mountDock");
    if (themeIndex < 0) {
      console.error("[build] 配了 theme.source 但产物里没有 THEME_FACTORY 段");
      process.exit(1);
    }
    if (uiTailIndex >= 0 && themeIndex > uiTailIndex) {
      console.error("[build] THEME_BUNDLE 位置不对：必须在收尾分片（dock/apply）之前");
      process.exit(1);
    }
    if (output.indexOf("data-theme-root") < 0) {
      console.error("[build] 产物里没有 data-theme-root 标记：主题根节点没被内联");
      process.exit(1);
    }
  }

  console.log("[build] lib/client.js ← " + (CLIENT_PARTS.length + UI_PARTS.length + TAIL_PARTS.length)
    + " 片段（含 ui 样式 " + readThemeCss().length + " 字符），共 " + output.split("\n").length + " 行"
    + "；主题来源 " + theme.source + (theme.configPath ? "（" + theme.configPath + "）" : "（默认 ui/）")
    + (theme.themeSourcePath ? "；TSX 主题 " + theme.themeSourcePath : ""));
}

main().catch((error) => {
  console.error("[build] 失败：" + (error && error.message ? error.message : error));
  process.exit(1);
});
