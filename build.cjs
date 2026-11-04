/**
 * 构建脚本：拼接 lib/client-parts/ 片段 + 直接复用 ui/ 的样式与渲染层 → 单文件 lib/client.js。
 *
 * - 顺序由 PART_ORDER 里两组数组显式声明（文件名语义化、不带序号）
 * - ui CSS 由本脚本内联成 UI_CSS 常量（按 ui/app.css 的 @import 顺序），避免运行时依赖外部文件
 * - ui 的 render/chat/admin/float/app 分片原样拼入（唯一一套界面实现，禁止再手写第二套）
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
  // target-source.js 必须排在 render/app 之前：两处都只调用它，但分片是顺序拼接的
  // store-* 必须按依赖顺序排在 store.js 前面（装配层调用各工厂）
  "js/rate.js", "js/messages.js", "js/target-source.js", "js/ui-format.js",
  "js/store-state.js", "js/store-persist.js", "js/store-events.js",
  "js/store-groups.js", "js/store-chat.js", "js/store-stats.js",
  "js/store-session.js", "js/store-dispatch.js", "js/store.js",
  "js/model-catalog.js", "js/session-bridge.js",
  // 好友分组：规则层（form）→ 视图层（view）→ 接线层（modal）。
  // 三者都排在 render.js 之后（复用它的 STRATEGY_LABELS 与成员行 class），
  // 排在 app.js 之前（app.js 的点击委托直接调用 openFriendGroupModal）。
  "js/dock-state.js", "js/render.js", "js/friend-group-form.js", "js/friend-group-view.js", "js/friend-group-modal.js",
  "js/chat.js", "js/admin.js", "js/float.js", "js/app.js"
];

// 收尾：DOM 骨架 + apply
const TAIL_PARTS = ["dock.js", "apply.js"];

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
const source = [
  ...CLIENT_PARTS.map(readPart),
  uiCssPart,
  uiSkeletonPart,
  ...UI_PARTS.map(readUiPart),
  ...TAIL_PARTS.map(readPart)
].join("");

const output = HEADER + source;
fs.writeFileSync(clientPath, output, "utf8");

// 断言：防止「又忘了内联 ui 与渲染层」——缺任何一项都直接失败
const requiredSnippets = [
  ['var API_PREFIX = "/_team";', "请求前缀"],
  ["var UI_CSS = ", "ui 样式内联"],
  ["var UI_SKELETON_HTML = ", "ui/index.html 骨架内联"],
  [".req-bubble", "ui/css/views.css 特征选择器"],
  ["function renderChat", "ui/js/render.js"],
  ["ModelTeamRate", "ui/js/rate.js（速率唯一实现）"],
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

console.log("[build] lib/client.js ← " + (CLIENT_PARTS.length + UI_PARTS.length + TAIL_PARTS.length)
  + " 片段（含 ui 样式 " + readThemeCss().length + " 字符），共 " + output.split("\n").length + " 行"
  + "；主题来源 " + theme.source + (theme.configPath ? "（" + theme.configPath + "）" : "（默认 ui/）"));
