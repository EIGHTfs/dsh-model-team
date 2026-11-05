// ⚠️ 本文件由 build.cjs 自动生成（拼接 lib/client-parts/ 与 ui/js/ 片段），请勿手改——
// 手改会在下次 node build.cjs 时被覆盖。改代码请改对应源文件后重新 build。
// loader.js —— 客户端模块注册头：__ModuleLoader__.load 包装；工厂体内装配后续分片。
// 本文件只是开头，结尾（apply 与 module.exports）在 lib/client-parts/apply.js。
window.__ModuleLoader__.load({
  id: "dsh-model-team",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
// constants.js —— 客户端常量：请求前缀单点声明，防漂移测试读产物里的这一行。
// 持久化键（anchor / last-session）归 store.js 持有，这里不再重复定义。
var API_PREFIX = "/_team"; // 与服务端 src/gateway/constants.js 保持一致（有测试守护）
var API_TIMEOUT_MS = 8000;
var LOG_PREFIX = "dsh-model-team";
var STATS_REFRESH_MS = 30000;

// INV-14 的判定依据（虚拟模型名 / 注册路由名）不在客户端写死：
// 两者都可由部署方改（config.virtualModel / options.providerIds），改完客户端必须跟着走，
// 所以启动时从 GET /_team/meta 取（契约 02 §3.8）。
// 宿主 projection 的取键（ui-model-selection 插件负责投影）
var MODEL_SELECTION_PROJECTION_KEY = "modelSelection";
// utils.js —— 插件侧的小工具：数字格式化与一次性告警（DOM/转义/提示由 ui 分片自带，避免重复声明）。
function formatTokenCount(totalTokens) {
  if (typeof totalTokens !== "number" || !isFinite(totalTokens) || totalTokens <= 0) return "0";
  if (totalTokens >= 1000000) return (totalTokens / 1000000).toFixed(1) + "M";
  if (totalTokens >= 1000) return (totalTokens / 1000).toFixed(1) + "k";
  return String(totalTokens);
}

// 同一类故障只告警一次，避免刷新时刷屏
var WARNED = {};
function warnOnce(label, error) {
  if (WARNED[label]) return;
  WARNED[label] = true;
  if (typeof console === "undefined" || typeof console.warn !== "function") return;
  console.warn("[" + LOG_PREFIX + "] " + label + " disabled: " + (error && error.message ? error.message : String(error)));
}
// session.js —— 当前会话 id 解析：优先后端 /_team/sessions/current；失败退上次记录与宿主探测；都失败返回 null（只读模式）。
// 为什么按这个顺序：纯 DOM 挂 body 拿不到槽位的 useSession，后端 active-session 是最权威的一条。
function readStoredSessionId() {
  try { return window.localStorage.getItem(SESSION_STORAGE_KEY) || null; }
  catch (error) { return null; }
}

function writeStoredSessionId(sessionId) {
  try { window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId); }
  catch (error) { /* 隐私模式忽略 */ }
}

// 宿主版本不同键名也不同，逐个尽力探测；再兜底 URL query
function detectGlobalSessionId() {
  try {
    var candidates = [window.__DSH_ACTIVE_SESSION_ID__, window.__DSH_SESSION_ID__, window.dshActiveSessionId];
    for (var index = 0; index < candidates.length; index += 1) {
      if (typeof candidates[index] === "string" && candidates[index]) return candidates[index];
    }
    var query = new URLSearchParams(window.location.search);
    return query.get("session") || query.get("sessionId") || null;
  } catch (error) { return null; }
}

// 统一的入口：拿到就缓存，拿不到就 null（调用方按只读模式降级）
function resolveSessionId() {
  return api.getCurrentSession().then(function (payload) {
    if (payload && typeof payload.sessionId === "string" && payload.sessionId) {
      writeStoredSessionId(payload.sessionId);
      return payload.sessionId;
    }
    var stored = readStoredSessionId();
    if (stored) return stored;
    var detected = detectGlobalSessionId();
    if (detected) {
      writeStoredSessionId(detected);
      return detected;
    }
    return null;
  });
}
// api.js —— 数据层唯一实现：接口名、请求路径、返回结构都只写在这里。
// 新增接口只改本文件一处。
// 当前会话由 store 通过 setActiveSession() 注入。
// 注意：本文件的分片与 ui/js/* 合并进同一作用域，变量名不要与 ui 分片的顶层 const 重名
// （同名的 var 与 const 会让后加载的脚本整体 SyntaxError 不执行，踩过）。
var activeSessionId = null;
function setActiveSession(sessionId) {
  activeSessionId = typeof sessionId === "string" && sessionId ? sessionId : null;
}

// 失败上报通道：api.js 不能直接依赖 store（分片顺序里它更靠前），
// 由 store 在 createTeamStore 时注入；没注入就退化成 console.warn，绝不静默。
var apiErrorReporter = null;
function apiSetErrorReporter(reporter) {
  apiErrorReporter = typeof reporter === "function" ? reporter : null;
}
function reportApiFailure(path, kind, detail) {
  var payload = { path: path, kind: kind, detail: detail };
  if (apiErrorReporter) {
    try { apiErrorReporter(payload); return; } catch (ignored) { /* 上报本身失败不能影响返回 */ }
  }
  if (typeof console !== "undefined" && console.warn) console.warn("[api] " + kind + " " + path + ": " + detail);
}

// 三个失败类别要分开报：HTTP 非 2xx / JSON 解析失败 / 网络异常。
// 旧实现把三者一并吞成 null，视图层再 `|| []`，界面上完全看不出"是加载失败还是真的空"。
function apiJson(path, options) {
  if (typeof fetch !== "function") return Promise.resolve(null);
  var requestOptions = options || {};
  var controller = typeof AbortController === "function" ? new AbortController() : null;
  var timer = setTimeout(function () { if (controller) controller.abort(); }, API_TIMEOUT_MS);
  if (controller) requestOptions.signal = controller.signal;
  return fetch(API_PREFIX + path, requestOptions)
    .then(function (response) {
      if (!response.ok) {
        reportApiFailure(path, "http-status", "HTTP " + response.status);
        return null;
      }
      return response.json().catch(function (parseError) {
        reportApiFailure(path, "json-parse", parseError && parseError.message ? parseError.message : String(parseError));
        return null;
      });
    })
    .catch(function (networkError) {
      reportApiFailure(path, "network", networkError && networkError.message ? networkError.message : String(networkError));
      return null;
    })
    .then(function (payload) {
      clearTimeout(timer);
      return payload === undefined ? null : payload;
    });
}

// 需要读 4xx 错误体（code/message/hint）的接口不能用 apiJson（它把非 2xx 判成 null）。
// method 缺省 POST；DELETE 等也要走这里，因为唯一需要"连错误体一起交回调用方"的能力就在这里。
function apiPostRaw(path, payload, method) {
  if (typeof fetch !== "function") return Promise.resolve(null);
  var controller = typeof AbortController === "function" ? new AbortController() : null;
  var timer = setTimeout(function () { if (controller) controller.abort(); }, API_TIMEOUT_MS);
  return fetch(API_PREFIX + path, {
    method: method || "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
    signal: controller ? controller.signal : undefined
  })
    .then(function (response) {
      return response.json().catch(function () { return null; });
    })
    .catch(function () { return null; })
    .then(function (body) {
      clearTimeout(timer);
      return body;
    });
}

function apiPost(path, payload, method) {
  return apiJson(path, {
    method: method || "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  });
}

// 把 { error: { code, message, hint } } 抬成一个带 code/hint 的 Error：
// 页面只要 catch 到它，就能把服务端原文写进弹窗（而不是自己编一句"保存失败"）。
function readServerErrorField(body, fieldName) {
  const serverError = body && body.error;
  if (!serverError) return "";
  return serverError[fieldName] || "";
}

function apiServerError(body, fallbackMessage, fallbackCode) {
  const error = new Error(readServerErrorField(body, "message") || fallbackMessage);
  error.code = readServerErrorField(body, "code") || fallbackCode || "SERVER_ERROR";
  error.status = body && typeof body.status === "number" ? body.status : 0;
  const serverHint = readServerErrorField(body, "hint");
  // hint 只在服务端真给了才挂：空字符串挂上去会让界面显示一个空的"提示"
  if (serverHint) error.hint = serverHint;
  return error;
}

// 后端可能返回裸数组，也可能包一层 { groups: [...] }，统一成数组
function apiList(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload[key])) return payload[key];
  return [];
}

// 契约 §15：群聊视图按「群」进入——session id 用当前会话，群 id 走 ?groupId= 过滤。
// 传进来的如果本身就是 session id（悬浮窗等会话级调用），就不加过滤（返回该会话全部）。
function apiSessionScope(candidate) {
  var looksLikeSession = typeof candidate === "string" && candidate.indexOf("session-") === 0;
  var sessionId = looksLikeSession ? candidate : activeSessionId;
  if (!sessionId) return null;
  return { sessionId: sessionId, groupId: looksLikeSession ? null : candidate };
}

function apiSessionPath(prefix, suffix, scope) {
  var path = prefix + encodeURIComponent(scope.sessionId) + suffix;
  if (scope.groupId) path += "?groupId=" + encodeURIComponent(scope.groupId);
  return path;
}

function apiTargetLabel(target, friendGroups) {
  if (!target) return "—";
  if (target.type === "group") {
    var matched = (friendGroups || []).filter(function (friendGroup) { return friendGroup.id === target.id; })[0];
    return "@" + (matched ? matched.name : target.id);
  }
  return String(target.id || target.model || "").replace(/^global:/, "") || "—";
}

// 速率统一走 ui/js/format/rate.js（唯一实现）：输出 token / 分母，
// 有首字时刻用解码段（精确），没有就退回整步耗时（下界，带 ≈）。
// 不是 total/latency（吞吐）——长上下文下 total 里 99% 是输入，会算出高两个数量级的假值。
// 会话级取最近 RATE_LOOKBACK_ROWS 行的**合计**（sum token / sum 分母）：
// 逐行平均会让只有几个 token 的短回复和长回复同权，把长回复的速度带偏。
var RATE_LOOKBACK_ROWS = 20;
var RATE_PLACEHOLDER_TEXT = "— tok/s";
var RATE_UNIT_SUFFIX = " tok/s";

function apiEstimateRate(rows) {
  if (!rows || !rows.length) return RATE_PLACEHOLDER_TEXT;
  var aggregate = ModelTeamRate.aggregateGenerationRate(rows.slice(-RATE_LOOKBACK_ROWS));
  if (!aggregate) return RATE_PLACEHOLDER_TEXT;
  return ModelTeamRate.formatRateText(aggregate) + RATE_UNIT_SUFFIX;
}

var api = {
  // store 在会话确定/切换时调用；之后的会话级请求都用这个 id
  setActiveSession: setActiveSession,
  getCurrentSession: function () {
    return apiJson("/sessions/current");
  },
  // GET /_team/meta（契约 02 §3.8）：INV-14 的判定依据，客户端启动取一次（失败按降级处理，不重试）
  getMeta: function () {
    return apiJson("/meta");
  },
  getDrivers: function () {
    return apiJson("/drivers").then(function (payload) { return apiList(payload, "drivers"); });
  },
  // 平台预置：名称 / 图标 / 基址 / 摘要模板，前端不写死任何平台信息
  // POST /_team/models/probe —— 探测可用模型（不落盘）
  probeModels: function (payload) {
    return apiPostRaw("/models/probe", payload);
  },
  getPlatforms: function () {
    return apiJson("/platforms").then(function (payload) { return apiList(payload, "platforms"); });
  },
  getGroups: function () {
    return apiJson("/groups").then(function (payload) { return apiList(payload, "groups"); });
  },
  getGroup: function (groupId) {
    return apiJson("/groups/" + encodeURIComponent(groupId)).then(function (payload) {
      return payload && payload.group ? payload.group : payload;
    });
  },
  getGroupModels: function (groupId) {
    return apiJson("/groups/" + encodeURIComponent(groupId) + "/models")      .then(function (payload) { return apiList(payload, "models"); });
  },
  getSessionModel: function (sessionId) {
    if (!sessionId) return Promise.resolve(null);
    return apiJson("/session/" + encodeURIComponent(sessionId) + "/target").then(function (target) {
      if (!target) return null;
      return { platform: target.platformId || null, model: target.id || target.model || null };
    });
  },
  putSessionModel: function (sessionId, platform, model) {
    return api.putSessionTarget(sessionId, { type: "model", id: model, platformId: platform });
  },
  // 后端没设目标时返回 { target: null }，这里统一解包成 null / 目标对象
  // 目标出参（契约 docs/19 §三）：{ target, effectiveTarget, targetSource }
  // target = 本会话显式绑定的（可能 null）；effectiveTarget = 实际生效的（含回落）；
  // targetSource = explicit | parent | last-session | fallback-group | none
  getSessionTarget: function (sessionId) {
    return apiJson("/session/" + encodeURIComponent(sessionId) + "/target").then(function (payload) {
      if (!payload) return null;
      if (Object.prototype.hasOwnProperty.call(payload, "target")) {
        var explicitTarget = payload.target || null;
        var effectiveTarget = payload.effectiveTarget || explicitTarget;
        var source = payload.targetSource || (explicitTarget ? "explicit" : "none");
        return { target: explicitTarget, effectiveTarget: effectiveTarget, targetSource: source };
      }
      // 兼容旧出参：直接就是一个 target 对象
      return { target: payload, effectiveTarget: payload, targetSource: "explicit" };
    });
  },
  // 切换目标：响应可能是 target 本身、{ target } 包裹，或只有 { ok: true }；
  // 统一归一化成 target 对象返回（拿不到就回退成请求入参），调用方据此直接更新 state，不再二次请求
  putSessionTarget: function (sessionId, target) {
    return apiPost("/session/" + encodeURIComponent(sessionId) + "/target", target, "PUT")
      .then(function (payload) {
        if (!payload) return target || null;
        if (Object.prototype.hasOwnProperty.call(payload, "target")) return payload.target || target || null;
        if (typeof payload.type === "string" && payload.id) return payload;
        return target || null;
      });
  },
  getFriendGroups: function () {
    return apiJson("/friend-groups").then(function (payload) { return { groups: apiList(payload, "groups") }; });
  },
  // POST /_team/groups —— 新建群（平台账号）
  // 必须让调用方拿到"被后端拒绝"的原因：apiJson 把非 2xx 一律吞成 null，
  // 加群失败时界面只能看到"没有群信息"，看不到 400 的具体 message（如字段名写错）。
  // 所以这里走能读错误体的 apiPostRaw，并把服务端 message 抬成 reject。
  createGroup: function (payload) {
    return apiPostRaw("/groups", payload).then(function (body) {
      if (body && body.group) return body;
      throw apiServerError(body, "服务端未返回群信息", "CREATE_GROUP_FAILED");
    });
  },
  // POST /_team/friend-groups —— 新建/修改好友分组（同 id 覆盖，201 回 { group }）
  // 与 createGroup 同一个理由走 apiPostRaw：apiJson 把 400/409 吞成 null，
  // 弹窗里就只剩一句"保存失败"，看不到后端到底哪一条字段不合格。
  createFriendGroup: function (payload) {
    return apiPostRaw("/friend-groups", payload).then(function (body) {
      if (body && body.group) return body;
      throw apiServerError(body, "服务端未返回分组信息", "CREATE_FRIEND_GROUP_FAILED");
    });
  },
  // DELETE /_team/friend-groups/:id —— 被会话引用时后端回 409 + 引用计数，
  // 那条 message（"分组 x 正被 N 个会话使用"）必须原样交给界面显示，不能改写成通用文案。
  deleteFriendGroup: function (groupId) {
    return apiPostRaw("/friend-groups/" + encodeURIComponent(groupId), null, "DELETE")
      .then(function (body) {
        if (body && body.removed) return body;
        throw apiServerError(body, "服务端未返回删除结果", "DELETE_FRIEND_GROUP_FAILED");
      });
  },
  getSessionStats: function (candidate) {
    var scope = apiSessionScope(candidate);
    if (!scope) return Promise.resolve({ rows: [] });
    return apiJson(apiSessionPath("/stats/session/", "", scope))
      .then(function (payload) { return { rows: apiList(payload, "rows") }; });
  },
  getSessionEvents: function (candidate) {
    var scope = apiSessionScope(candidate);
    if (!scope) return Promise.resolve({ events: [] });
    return apiJson(apiSessionPath("/session/", "/events", scope))
      .then(function (payload) { return { events: apiList(payload, "events") }; });
  },
  // ui 的面板按 currentModel / sessionRate / globalRequests / globalTokens 四个字段取数
  getGlobalStats: function () {
    var sessionId = activeSessionId;
    return Promise.all([
      apiJson("/stats/global"),
      sessionId ? api.getSessionTarget(sessionId) : Promise.resolve(null),
      sessionId ? api.getSessionStats(sessionId) : Promise.resolve({ rows: [] }),
      api.getFriendGroups()
    ]).then(function (results) {
      var stats = results[0] || {};
      var rows = results[2].rows;
      return {
        currentModel: apiTargetLabel(results[1], results[3].groups),
        sessionRate: apiEstimateRate(rows),
        globalRequests: (typeof stats.totalRows === "number" ? stats.totalRows : 0) + " 次",
        globalTokens: "总计 " + formatTokenCount(stats.totalTokens) + " tok",
        totalRows: stats.totalRows,
        totalTokens: stats.totalTokens
      };
    });
  },
  exportConfig: function () {
    return apiJson("/export");
  },
  importConfig: function (payload) {
    return apiPost("/import", payload);
  }
};
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
// 由 build.cjs 内联的 ui 样式（勿手改）
var UI_CSS = "/* layout.css —— 窗体外壳：主题变量、垫场背景、悬浮球与悬浮面板、模型团队主窗口。\n   视觉基调：蓝白、圆角、柔和投影；内容页样式在 views.css / panels.css。 */\n\n/* 主题变量集中一处，改色只动这里 */\n:root {\n  /* 主窗口尺寸：主题可覆盖这两个变量，默认 760×540（契约条款 26） */\n  --team-window-width: min(760px, 92vw);\n  --team-window-height: min(540px, 86vh);\n  --team-blue: #12a7f5;          /* 主色：亮蓝 */\n  --team-blue-deep: #0b8bd0;     /* 主色深一档，用于渐变收尾 */\n  --team-blue-soft: #e8f5ff;     /* 主色淡底，用于选中态、hover */\n  --team-text: #1f2329;          /* 主文字 */\n  --team-text-2: #6b7785;        /* 次要文字 */\n  --team-text-3: #9aa6b2;        /* 弱提示 */\n  --team-line: #e6ebf0;          /* 分割线 */\n  --team-bg: #f5f8fb;            /* 窗口内底色 */\n  --team-white: #ffffff;\n  --team-green: #20b26c;         /* 成功 / 在线 */\n  --team-orange: #f0a020;        /* 限流 */\n  --team-red: #e8513d;           /* 失败 */\n  --team-radius: 10px;\n  --team-shadow: 0 10px 30px rgba(16, 58, 96, 0.14);\n  --team-shadow-lg: 0 18px 48px rgba(16, 58, 96, 0.22);\n}\n\n* { box-sizing: border-box; }\n\nhtml, body {\n  height: 100%;\n  margin: 0;\n}\n\nbody {\n  /* 淡蓝白渐变，衬托白色卡片与悬浮件 */\n  background: linear-gradient(160deg, #eef5fc 0%, #dfe9f4 55%, #d6e3f1 100%);\n  color: var(--team-text);\n  font: 14px/1.6 \"PingFang SC\", \"Microsoft YaHei\", \"Hiragino Sans GB\", system-ui, -apple-system, sans-serif;\n  overflow: hidden;\n}\n\n\n\n/* ---------------------------------------------------------------- 悬浮球 */\n.float-dock {\n  position: fixed;\n  left: calc(100% - 320px);      /* 初始位置：右下角往内缩一点 */\n  top: 58%;\n  z-index: var(--dmt-z-dock, 1);  /* 层级见 lib/client-parts/foundation/z-layers.js */\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  user-select: none;\n}\n/* 关闭整个悬浮窗时用：球与 pill 一起隐藏，只留右下角\"呼出模型团队\"按钮 */\n.float-dock.hidden { display: none; }\n\n/* 展开方向 → 文本在球的哪一侧：球靠右半屏时文本在左（默认 DOM 顺序就是 pill 在球前），\n   球靠左半屏时用 row-reverse 把文本换到球的右侧——等价于「文本永远朝视口内侧」。\n   方向由 float.js 的 computeOpenDir() 写到 data-open-dir，拖动松手/resize 后重算。 */\n.float-dock[data-open-dir$=\"right\"] { flex-direction: row-reverse; }\n\n/* 动效口径：只过渡尺寸/透明度/位移；left/top 不参与过渡，否则拖拽会发飘 */\n.float-pill {\n  transition: width 220ms cubic-bezier(0.16, 1, 0.3, 1),\n              opacity 180ms ease,\n              transform 220ms cubic-bezier(0.16, 1, 0.3, 1);\n}\n.float-dock.is-dragging .float-pill { transition: none; }\n\n.float-ball {\n  position: relative;\n  width: 56px;\n  height: 56px;\n  padding: 0;\n  border: none;\n  border-radius: 50%;\n  cursor: grab;\n  touch-action: none;            /* 触控/触控板下别让浏览器把手势当滚动，否则拖动会被抢走 */\n  color: #fff;\n  font-size: 16px;\n  font-weight: 600;\n  letter-spacing: 0.05em;\n  background: linear-gradient(145deg, #38bdf8, var(--team-blue) 55%, var(--team-blue-deep));\n  box-shadow: 0 10px 22px rgba(12, 122, 186, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.45);\n  transition: transform 0.16s ease, box-shadow 0.16s ease;\n}\n/* 拖动中禁掉球自身的缩放/过渡，否则跟手会被 hover/active 动画拖住 */\n.float-dock.is-dragging .float-ball { transition: none; transform: none; }\n.float-ball:hover {\n  transform: translateY(-2px) scale(1.03);\n  box-shadow: 0 14px 28px rgba(12, 122, 186, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.5);\n}\n.float-ball:active { cursor: grabbing; transform: scale(0.97); }\n/* 球内显示\"接活平台\"的头像或首字母牌（G6）：不再有文字，容器撑满球心并裁掉溢出，\n   保证图片/字母都不会撑破球体（F-06 的验收口径是 scrollWidth <= clientWidth）。 */\n.fb-target {\n  position: absolute;\n  inset: 0;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  overflow: hidden;\n  border-radius: 50%;\n  font-size: 18px;\n  line-height: 1;\n  letter-spacing: 0;\n}\n/* 头像铺满球心：object-fit 防拉伸，球本身的渐变留作无图时的底 */\n.fb-target img {\n  width: 100%;\n  height: 100%;\n  object-fit: cover;\n  border-radius: 50%;\n}\n.fb-initial {\n  text-transform: uppercase;\n  text-shadow: 0 1px 2px rgba(6, 55, 84, 0.35);\n}\n/* 球的呼吸光晕，暗示\"有实时统计在跳\" */\n.fb-dot {\n  position: absolute;\n  right: 4px;\n  bottom: 6px;\n  width: 10px;\n  height: 10px;\n  border-radius: 50%;\n  background: var(--team-green);\n  border: 2px solid #fff;\n}\n\n.float-pill {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  max-width: 260px;             /* 模型名极长时省略，不把球推出视口 */\n  padding: 7px 12px;\n  border-radius: 999px;\n  background: rgba(255, 255, 255, 0.92);\n  border: 1px solid rgba(18, 167, 245, 0.28);\n  box-shadow: 0 6px 16px rgba(16, 58, 96, 0.12);\n  font-size: 12px;\n  color: var(--team-text-2);\n  white-space: nowrap;\n}\n.pill-model {\n  font-family: \"JetBrains Mono\", \"SFMono-Regular\", Consolas, monospace;\n  color: var(--team-blue-deep);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.pill-dot {\n  width: 7px;\n  height: 7px;\n  border-radius: 50%;\n  background: var(--team-green);\n  box-shadow: 0 0 0 3px rgba(32, 178, 108, 0.16);\n}\n\n/* ------------------------------------------------------------ 悬浮面板 */\n.float-panel {\n  position: fixed;\n  z-index: var(--dmt-z-panel, 1); /* 面板压在球之上，两者都在宿主界面之上 */\n  width: 384px;\n  border-radius: 12px;\n  background: var(--team-white);\n  border: 1px solid var(--team-line);\n  box-shadow: var(--team-shadow-lg);\n  overflow: hidden;\n  /* 开合动画：只过渡透明度与位移，不做尺寸动画（宽度固定，避免抖动） */\n  transition: opacity 160ms ease, transform 180ms cubic-bezier(0.16, 1, 0.3, 1), visibility 0s;\n}\n.float-panel.hidden {\n  visibility: hidden;\n  opacity: 0;\n  transform: translateY(6px) scale(0.98);\n  pointer-events: none;\n  transition: opacity 140ms ease, transform 160ms ease, visibility 0s linear 160ms;\n}\n/* 拖动中禁掉过渡，否则跟手会被平滑掉 */\n.float-dock.is-dragging { transition: none; will-change: transform; }\n\n.fp-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 10px 12px;\n  background: linear-gradient(120deg, #eaf7ff, #f7fbff);\n  border-bottom: 1px solid var(--team-line);\n  cursor: move;                 /* 面板标题条可拖拽 */\n  user-select: none;\n  touch-action: none;           /* 同上：拖动标题条时不被浏览器手势接管 */\n}\n.fp-title-btn {\n  padding: 0;\n  border: none;\n  background: transparent;\n  color: inherit;\n  font: inherit;\n  font-weight: 600;\n  cursor: pointer;\n}\n.fp-title-btn:hover { color: var(--team-blue-deep); }\n\n/* 目标行的来源提示：本会话未显式绑定、由后端回落时显示（浅色小字，不抢目标名） */\n.fp-target-source {\n  margin-left: 4px;\n  color: var(--team-text-3);\n  font-weight: 400;\n  font-size: 11px;\n}\n\n.fp-title { font-weight: 600; font-size: 13px; }\n.fp-model {\n  margin-left: auto;\n  font-size: 12px;\n  color: var(--team-text-2);\n  font-family: \"JetBrains Mono\", Consolas, monospace;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  max-width: 150px;\n}\n.fp-ops { display: flex; gap: 2px; flex: none; }\n.fp-btn {\n  width: 22px;\n  height: 22px;\n  padding: 0;\n  border: none;\n  border-radius: 5px;\n  background: transparent;\n  color: var(--team-text-2);\n  font-size: 14px;\n  line-height: 1;\n  cursor: pointer;\n}\n.fp-btn:hover { background: rgba(18, 167, 245, 0.14); color: var(--team-blue-deep); }\n\n.fp-body { padding: 12px 14px; }\n.fp-row {\n  display: flex;\n  gap: 6px;\n  padding: 4px 0;\n  font-size: 13px;\n}\n.fp-k { color: var(--team-text-2); flex: none; }\n.fp-v {\n  color: var(--team-text);\n  font-weight: 600;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.fp-foot { padding: 0 14px 12px; }\n.fp-enter {\n  width: 100%;\n  padding: 9px 0;\n  border: 1px solid rgba(18, 167, 245, 0.4);\n  border-radius: 8px;\n  background: linear-gradient(120deg, #eaf7ff, #f4fbff);\n  color: var(--team-blue-deep);\n  font-size: 13px;\n  font-weight: 600;\n  cursor: pointer;\n}\n.fp-enter:hover { background: linear-gradient(120deg, #dcf1ff, #eeF9ff); }\n\n/* 关闭悬浮窗后的再次呼出按钮 */\n.float-recall {\n  position: fixed;\n  right: 24px;\n  bottom: 24px;\n  z-index: var(--dmt-z-recall, 1);\n  padding: 10px 16px;\n  border: 1px solid rgba(18, 167, 245, 0.35);\n  border-radius: 999px;\n  background: #fff;\n  color: var(--team-blue-deep);\n  font-size: 13px;\n  box-shadow: var(--team-shadow);\n  cursor: pointer;\n}\n.float-recall.hidden { display: none; }\n\n/* ------------------------------------------------------ 模型团队主窗口 */\n.team-app {\n  position: fixed;\n  left: 50%;\n  top: 50%;\n  z-index: var(--dmt-z-app, 1);   /* 主窗口压在悬浮件之上（契约条款 4） */\n  transform: translate(-50%, -50%);\n  width: var(--team-window-width);\n  height: var(--team-window-height);\n  display: flex;\n  flex-direction: column;\n  background: var(--team-white);\n  border: 1px solid rgba(255, 255, 255, 0.9);\n  border-radius: 14px;\n  box-shadow: var(--team-shadow-lg);\n  overflow: hidden;\n}\n\n.team-bar {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  height: 48px;\n  padding: 0 14px;\n  flex: none;\n  background: linear-gradient(120deg, #f2f9ff, #ffffff);\n  border-bottom: 1px solid var(--team-line);\n}\n.team-logo {\n  padding: 2px 8px;\n  border-radius: 6px;\n  background: linear-gradient(145deg, #38bdf8, var(--team-blue-deep));\n  color: #fff;\n  font-size: 12px;\n  font-weight: 700;\n  letter-spacing: 0.08em;\n}\n.team-view-name { font-size: 14px; font-weight: 600; }\n.team-bar-btn {\n  margin-left: auto;\n  padding: 6px 12px;\n  border: 1px solid var(--team-line);\n  border-radius: 999px;\n  background: #fff;\n  color: var(--team-text-2);\n  font-size: 12px;\n  cursor: pointer;\n}\n.team-bar-btn:hover { border-color: rgba(18, 167, 245, 0.4); color: var(--team-blue-deep); }\n\n.team-body {\n  flex: 1;\n  min-height: 0;                /* 关键：让内部滚动区正确收缩 */\n  overflow: hidden;             /* 内容在视图内部滚动，底边栏与顶栏不动 */\n  background: var(--team-bg);\n  display: flex;\n  flex-direction: column;\n}\n\n/* 底部三 tab（契约条款 21-24）：图标在上文字在下，固定高度、不随内容滚动 */\n.team-tabbar {\n  flex: none;\n  display: flex;\n  height: 54px;\n  border-top: 1px solid var(--team-line);\n  background: #fff;\n}\n.team-tab {\n  flex: 1;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  justify-content: center;\n  gap: 3px;\n  padding: 0;\n  border: none;\n  background: transparent;\n  color: var(--team-text-3);\n  font-size: 11px;\n  line-height: 1;\n  cursor: pointer;\n  transition: color 140ms ease;\n}\n.team-tab svg { width: 22px; height: 22px; }\n.team-tab:hover { color: var(--team-blue-deep); }\n.team-tab[aria-selected=\"true\"] {\n  color: var(--team-blue-deep);\n  font-weight: 600;\n}\n.team-tab-label { font-size: 11px; }\n\n.noscript {\n  position: fixed;\n  left: 50%;\n  top: 12px;\n  transform: translateX(-50%);\n  color: var(--team-red);\n}\n\n/* 小屏兜底：窗口贴边，悬浮球躲到左下，避免遮挡输入区 */\n@media (max-width: 720px) {\n  .team-app {\n    width: 100vw;\n    height: 100vh;\n    border-radius: 0;\n    top: 0;\n    left: 0;\n    transform: none;\n  }\n  .float-dock { left: 16px; top: unset; bottom: 96px; }\n  .float-panel { width: calc(100vw - 32px); }\n}\n\n/* views.css —— 窗口内内容页：群列表、群聊（气泡 / 请求行 / 输入区）。\n   加群与数据库在 panels.css，@ 选择器在 mention.css，外壳在 layout.css。 */\n\n/* 每个视图都是纵向 flex，中间滚动区自行 min-height:0 */\n.view {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n}\n\n/* 数据未就绪时的占位 */\n.loading {\n  flex: 1;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  color: var(--team-text-3);\n  font-size: 13px;\n}\n\n/* 视图内的通用头部（群聊 / 加群 / 数据库共用） */\n.view-head {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  flex: none;\n  padding: 10px 14px;\n  background: #fff;\n  border-bottom: 1px solid var(--team-line);\n}\n.view-head .head-title {\n  font-size: 14px;\n  font-weight: 600;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.btn-back {\n  flex: none;\n  padding: 4px 10px;\n  border: 1px solid var(--team-line);\n  border-radius: 999px;\n  background: #fff;\n  color: var(--team-text-2);\n  font-size: 12px;\n  cursor: pointer;\n}\n.btn-back:hover { border-color: rgba(18, 167, 245, 0.4); color: var(--team-blue-deep); }\n\n/* 通用头像占位：字符串头像，不引用任何外部图片 */\n.avatar {\n  flex: none;\n  width: 38px;\n  height: 38px;\n  border-radius: 10px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  background: linear-gradient(145deg, #e8f5ff, #d4ecff);\n  color: var(--team-blue-deep);\n  font-size: 13px;\n  font-weight: 700;\n  letter-spacing: 0.02em;\n}\n.avatar.round { border-radius: 50%; }\n.avatar.big { width: 56px; height: 56px; font-size: 16px; border-radius: 14px; }\n\n/* 头像换成图片时保持原尺寸与圆角，不破坏布局（平台图标来自后端预置的 URL） */\n.avatar-img {\n  width: 100%;\n  height: 100%;\n  border-radius: inherit;\n  object-fit: cover;\n  display: block;\n}\n\n/* 视图一：群列表（= 平台账号列表） */\n.list-head {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  flex: none;\n  padding: 12px 16px 8px;\n}\n.list-head h2 {\n  margin: 0;\n  font-size: 15px;\n  font-weight: 700;\n}\n.list-count {\n  font-size: 12px;\n  color: var(--team-text-3);\n}\n.btn-add {\n  margin-left: auto;\n  padding: 6px 14px;\n  border: none;\n  border-radius: 999px;\n  background: linear-gradient(120deg, #38bdf8, var(--team-blue-deep));\n  color: #fff;\n  font-size: 12px;\n  font-weight: 600;\n  cursor: pointer;\n  box-shadow: 0 4px 12px rgba(12, 122, 186, 0.28);\n}\n.btn-add:hover { filter: brightness(1.05); }\n\n/* 群列表顶部：搜索框（占剩余宽度）+「我」入口（契约条款 5 / 8） */\n.group-search {\n  flex: 1;\n  min-width: 120px;\n  max-width: 280px;\n  padding: 6px 12px;\n  border: 1px solid var(--team-line);\n  border-radius: 999px;\n  background: #fff;\n  font-size: 12px;\n  color: var(--team-text);\n  outline: none;\n}\n.group-search:focus { border-color: rgba(18, 167, 245, 0.55); }\n.btn-me {\n  padding: 6px 12px;\n  border: 1px solid var(--team-line);\n  border-radius: 999px;\n  background: #fff;\n  color: var(--team-text-2);\n  font-size: 12px;\n  cursor: pointer;\n}\n.btn-me:hover { border-color: rgba(18, 167, 245, 0.4); color: var(--team-blue-deep); }\n.list-head .btn-add { margin-left: 0; }\n\n.group-list {\n  flex: 1;\n  min-height: 0;\n  overflow-y: auto;\n  list-style: none;\n  margin: 0;\n  padding: 4px 10px 14px;\n}\n.group-item {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  padding: 10px 10px;\n  border-radius: 10px;\n  cursor: pointer;\n  transition: background 0.14s ease;\n}\n.group-item:hover { background: #fff; box-shadow: 0 2px 10px rgba(16, 58, 96, 0.06); }\n.group-item.active { background: var(--team-blue-soft); }\n.group-main { flex: 1; min-width: 0; }   /* min-width:0 是超长文本能省略的前提 */\n.group-line {\n  display: flex;\n  align-items: baseline;\n  gap: 8px;\n  min-width: 0;                 /* 让长群名在 flex 里能真正收缩到容器宽度 */\n}\n.group-name {\n  flex: 1;\n  min-width: 0;                 /* 配合 overflow 才能出省略号，否则会撑破整行 */\n  font-size: 14px;\n  font-weight: 600;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n/* 右侧竖排：时间在上、驱动名在下，避免和摘要行抢宽度 */\n.group-right {\n  flex: none;\n  display: flex;\n  flex-direction: column;\n  align-items: flex-end;\n  gap: 2px;\n}\n.group-time {\n  font-size: 11px;\n  color: var(--team-text-3);\n  font-variant-numeric: tabular-nums;\n}\n.group-summary {\n  margin-top: 2px;\n  font-size: 12px;\n  color: var(--team-text-2);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.group-driver {\n  padding: 0 6px;\n  border-radius: 4px;\n  background: #f0f5fa;\n  color: var(--team-text-3);\n  font-size: 10px;\n  line-height: 15px;\n}\n\n/* 视图二：群聊（请求记录行 = 群友消息） */\n.chat-head { display: flex; align-items: center; gap: 10px; }\n.chat-head .group-tag {\n  flex: none;\n  padding: 1px 7px;\n  border-radius: 999px;\n  background: var(--team-blue-soft);\n  color: var(--team-blue-deep);\n  font-size: 11px;\n}\n.chat-head .head-sub {\n  margin-left: auto;\n  font-size: 11px;\n  color: var(--team-text-3);\n}\n\n.chat-stream {\n  flex: 1;\n  min-height: 0;\n  overflow-y: auto;\n  padding: 14px 16px 6px;\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n}\n\n/* 单条消息的通用行：头像 + 气泡 */\n.msg { display: flex; align-items: flex-start; gap: 8px; max-width: 100%; }\n.msg-left { justify-content: flex-start; }\n.msg-right { justify-content: flex-end; }\n.msg-right .avatar { order: 2; }\n.msg-right .bubble { order: 1; }\n.msg-sys { justify-content: center; }\n\n.bubble {\n  position: relative;\n  max-width: min(78%, 620px);\n  padding: 9px 12px;\n  border-radius: 10px;\n  font-size: 13px;\n  line-height: 1.55;\n  word-break: break-word;             /* 超长无空格串也要换行，不撑破气泡 */\n  box-shadow: 0 2px 8px rgba(16, 58, 96, 0.06);\n}\n.msg-left .bubble {\n  background: #fff;\n  border: 1px solid var(--team-line);\n  border-top-left-radius: 3px;\n}\n.msg-right .bubble {\n  background: linear-gradient(135deg, #45c2fb, var(--team-blue-deep));\n  border: none;\n  border-top-right-radius: 3px;\n  color: #fff;\n}\n.msg-right .bubble .mention-inline { color: #fff; font-weight: 600; }\n\n/* 请求记录行：默认单行折叠，点击展开 */\n.req-bubble { cursor: pointer; transition: box-shadow 0.14s ease, transform 0.14s ease; }\n.req-bubble:hover {\n  box-shadow: 0 6px 18px rgba(16, 58, 96, 0.12);\n  transform: translateY(-1px);\n}\n/* 群列表加载失败态：必须和\"确实没有群\"看起来不同，否则用户不知道该重试还是该加群 */\n.list-error {\n  margin: 16px;\n  padding: 18px;\n  border: 1px solid rgba(248, 113, 113, 0.45);\n  border-radius: 10px;\n  background: rgba(248, 113, 113, 0.08);\n  text-align: center;\n}\n.list-error-title { font-size: 13px; font-weight: 600; color: #f87171; }\n.list-error-detail { margin-top: 6px; font-size: 11px; color: var(--team-text-3); word-break: break-all; }\n.btn-retry {\n  margin-top: 12px;\n  padding: 6px 14px;\n  border: 1px solid var(--team-line);\n  border-radius: 8px;\n  background: transparent;\n  color: var(--team-text);\n  font-size: 12px;\n  cursor: pointer;\n}\n.btn-retry:hover { border-color: var(--team-blue); color: var(--team-blue); }\n\n.req-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n}\n.req-model {\n  font-family: \"JetBrains Mono\", Consolas, monospace;\n  font-size: 12.5px;\n  font-weight: 600;\n  color: var(--team-text);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n/* 目标来源标记：只在\"由后端回落\"时出现，弱化到不抢模型名与时间的位置 */\n.req-source {\n  flex: none;\n  font-size: 11px;\n  color: var(--team-text-3);\n  white-space: nowrap;\n}\n.req-time {\n  margin-left: auto;\n  flex: none;\n  font-size: 11px;\n  color: var(--team-text-3);\n  font-variant-numeric: tabular-nums;\n}\n/* 右上角的小三角：提示\"这一行能点开看的\"，用 CSS 边框画，不依赖字体字形 */\n.req-caret {\n  flex: none;\n  width: 0;\n  height: 0;\n  margin-top: 2px;\n  border-left: 4px solid transparent;\n  border-right: 4px solid transparent;\n  border-top: 5px solid var(--team-text-3);\n}\n.req-bubble.expanded .req-caret {\n  border-top: none;\n  border-bottom: 5px solid var(--team-blue-deep);\n}\n/* 折叠态：状态 + 关键的四个数字挤在同一行，超出省略 */\n.req-meta {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  margin-top: 3px;\n  font-size: 11.5px;\n  color: var(--team-text-2);\n  overflow: hidden;\n  white-space: nowrap;\n  text-overflow: ellipsis;\n}\n.req-meta .sep { color: #cbd5df; }\n.st {\n  flex: none;\n  padding: 0 6px;\n  border-radius: 4px;\n  font-size: 11px;\n  font-weight: 600;\n}\n.st-ok { background: rgba(32, 178, 108, 0.12); color: var(--team-green); }\n.st-warn { background: rgba(240, 160, 32, 0.14); color: #b5730a; }\n.st-err { background: rgba(232, 81, 61, 0.12); color: var(--team-red); }\n\n/* 展开态：气泡下面追加一张明细表 */\n.req-detail {\n  margin-top: 8px;\n  padding-top: 8px;\n  border-top: 1px dashed var(--team-line);\n  display: grid;\n  grid-template-columns: 74px 1fr;\n  gap: 4px 10px;\n  font-size: 12px;\n}\n.req-detail .k { color: var(--team-text-3); }\n.req-detail .v {\n  color: var(--team-text);\n  font-family: \"JetBrains Mono\", Consolas, monospace;\n  word-break: break-all;              /* UA / req-id 很长，允许任意断行 */\n}\n/* 分组轮换时的\"谁接的活\"轻提示 */\n.req-served {\n  margin-top: 6px;\n  font-size: 11px;\n  color: var(--team-text-3);\n}\n/* 系统提示：灰色居中细条 */\n.sys-tip {\n  align-self: center;\n  padding: 3px 10px;\n  border-radius: 999px;\n  background: rgba(31, 35, 41, 0.06);\n  color: var(--team-text-3);\n  font-size: 11.5px;\n}\n/* 每条消息的展示时间：系统提示在细条右侧、我的气泡在气泡内右下，低调不抢内容 */\n.msg-time {\n  align-self: center;\n  margin-left: 8px;\n  font-size: 10.5px;\n  color: var(--team-text-3);\n  font-variant-numeric: tabular-nums;\n}\n.msg-right .msg-time {\n  display: block;\n  margin: 2px 0 0;\n  text-align: right;\n  font-size: 10.5px;\n  opacity: 0.75;\n}\n\n/* 模型目录（加群页第三段）：id/name 两列 + 删除；窄屏也保持不挤压 */\n.form-step-title .step-actions {\n  margin-left: auto;\n  display: flex;\n  gap: 8px;\n}\n.btn-ghost {\n  padding: 4px 10px;\n  border: 1px solid var(--team-line);\n  border-radius: 999px;\n  background: #fff;\n  color: var(--team-text-2);\n  font-size: 12px;\n  cursor: pointer;\n}\n.btn-ghost:hover:not(:disabled) { border-color: rgba(18, 167, 245, 0.4); color: var(--team-blue-deep); }\n.btn-ghost:disabled { opacity: 0.6; cursor: not-allowed; }\n.model-mode {\n  margin: 6px 0 8px;\n  font-size: 11.5px;\n  color: var(--team-text-3);\n}\n.model-table { display: flex; flex-direction: column; gap: 6px; }\n.model-row {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 36px;\n  gap: 8px;\n  align-items: center;\n}\n.model-row input {\n  min-width: 0;\n  height: 32px;\n  padding: 0 10px;\n  border: 1px solid var(--team-line);\n  border-radius: 8px;\n  font-size: 12.5px;\n  background: #fff;\n  outline: none;\n}\n.model-row input:focus { border-color: rgba(18, 167, 245, 0.55); }\n.model-row-head {\n  font-size: 11px;\n  color: var(--team-text-3);\n}\n.model-remove {\n  width: 30px;\n  height: 30px;\n  border: 1px solid var(--team-line);\n  border-radius: 8px;\n  background: #fff;\n  color: var(--team-text-3);\n  font-size: 14px;\n  line-height: 1;\n  cursor: pointer;\n}\n.model-remove:hover { border-color: rgba(220, 80, 80, 0.5); color: #c0392b; }\n.probe-feedback {\n  margin-top: 8px;\n  min-height: 16px;\n  font-size: 11.5px;\n  color: var(--team-text-3);\n}\n.probe-feedback.probe-error { color: #c0392b; }\n\n/* 输入区 */\n.chat-input {\n  position: relative;\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 10px 12px;\n  background: #fff;\n  border-top: 1px solid var(--team-line);\n}\n.btn-at {\n  flex: none;\n  width: 32px;\n  height: 32px;\n  border: 1px solid var(--team-line);\n  border-radius: 8px;\n  background: #fff;\n  color: var(--team-text-2);\n  font-size: 14px;\n  font-weight: 700;\n  cursor: pointer;\n}\n.btn-at:hover { color: var(--team-blue-deep); border-color: rgba(18, 167, 245, 0.4); }\n#msgInput {\n  flex: 1;\n  min-width: 0;\n  height: 36px;\n  max-height: 88px;\n  padding: 9px 12px;\n  border: 1px solid var(--team-line);\n  border-radius: 8px;\n  background: var(--team-bg);\n  font-size: 13px;\n  line-height: 18px;\n  color: var(--team-text);\n  outline: none;\n  resize: none;                  /* Shift+Enter 换行，但不允许手动拖高 */\n  overflow-y: auto;\n}\n#msgInput:focus { border-color: rgba(18, 167, 245, 0.55); background: #fff; }\n.btn-send {\n  flex: none;\n  height: 36px;\n  padding: 0 18px;\n  border: none;\n  border-radius: 8px;\n  background: linear-gradient(120deg, #38bdf8, var(--team-blue-deep));\n  color: #fff;\n  font-size: 13px;\n  font-weight: 600;\n  cursor: pointer;\n}\n.btn-send:hover { filter: brightness(1.05); }\n\n/* @ 选择器见 mention.css；加群表单与数据库页见 panels.css */\n\n/* panels.css —— 表单与浮层：加群动态表单、我的数据库、轻提示、导入结果弹层。 */\n\n/* ========================================================================\n   视图三：加群（两步动态表单）\n   ==================================================================== */\n.form-body {\n  flex: 1;\n  min-height: 0;\n  overflow-y: auto;\n  padding: 16px 18px 20px;\n  background: #fff;\n}\n.form-step {\n  margin-bottom: 18px;\n  padding: 14px;\n  border: 1px solid var(--team-line);\n  border-radius: 10px;\n  background: #fbfdff;\n}\n.form-step-title {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  margin-bottom: 10px;\n  font-size: 13px;\n  font-weight: 600;\n}\n.step-no {\n  width: 20px;\n  height: 20px;\n  border-radius: 50%;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  background: var(--team-blue-soft);\n  color: var(--team-blue-deep);\n  font-size: 11px;\n}\n.field { margin-bottom: 12px; }\n.field:last-child { margin-bottom: 0; }\n.field-label {\n  display: block;\n  margin-bottom: 5px;\n  font-size: 12.5px;\n  color: var(--team-text-2);\n}\n.field-label .req-mark { color: var(--team-red); margin-left: 2px; }\n\n/* 动态字段：text / password 用 input，textarea 单独放宽高度 */\n.field input[type=\"text\"],\n.field input[type=\"password\"],\n.field textarea,\n.driver-select,\n.group-name-input {\n  width: 100%;\n  padding: 8px 10px;\n  border: 1px solid var(--team-line);\n  border-radius: 8px;\n  background: #fff;\n  font-size: 13px;\n  font-family: inherit;\n  color: var(--team-text);\n  outline: none;\n}\n.field input:focus, .field textarea:focus,\n.driver-select:focus, .group-name-input:focus {\n  border-color: rgba(18, 167, 245, 0.55);\n  box-shadow: 0 0 0 3px rgba(18, 167, 245, 0.1);\n}\n.field textarea { min-height: 74px; resize: vertical; }\n.driver-hint {\n  margin-top: 6px;\n  font-size: 11.5px;\n  color: var(--team-text-3);\n}\n/* 提交栏固定在表单底部：字段随 driver 变多时按钮始终可见，也不压住最后一个字段 */\n.form-footer {\n  flex: none;\n  padding: 10px 18px 12px;\n  text-align: center;\n  background: #fff;\n  border-top: 1px solid var(--team-line);\n}\n.btn-primary {\n  min-width: 180px;\n  padding: 10px 22px;\n  border: none;\n  border-radius: 9px;\n  background: linear-gradient(120deg, #38bdf8, var(--team-blue-deep));\n  color: #fff;\n  font-size: 13.5px;\n  font-weight: 600;\n  cursor: pointer;\n  box-shadow: 0 6px 16px rgba(12, 122, 186, 0.26);\n}\n.btn-primary:hover { filter: brightness(1.05); }\n.form-note {\n  margin-top: 10px;\n  font-size: 11.5px;\n  color: var(--team-text-3);\n}\n\n/* 下拉字段（如「模型列表来源」）：与输入框同宽同高，保持一行内对齐 */\n.field-select {\n  width: 100%;\n  padding: 8px 10px;\n  border: 1px solid var(--team-line);\n  border-radius: 8px;\n  background: #fff;\n  font-size: 13px;\n  font-family: inherit;\n  color: var(--team-text);\n  outline: none;\n  cursor: pointer;\n}\n.field-select:focus {\n  border-color: rgba(18, 167, 245, 0.55);\n  box-shadow: 0 0 0 3px rgba(18, 167, 245, 0.1);\n}\n\n/* ========================================================================\n   视图四：我的模型团队（导入 / 导出）\n   ==================================================================== */\n.profile-body {\n  flex: 1;\n  min-height: 0;\n  overflow-y: auto;\n  padding: 18px;\n}\n.profile-card {\n  display: flex;\n  align-items: center;\n  gap: 14px;\n  padding: 16px;\n  border-radius: 12px;\n  background: linear-gradient(120deg, #f2f9ff, #ffffff);\n  border: 1px solid var(--team-line);\n}\n.profile-main { min-width: 0; }\n.profile-name { font-size: 15px; font-weight: 700; }\n.profile-sub {\n  margin-top: 2px;\n  font-size: 12px;\n  color: var(--team-text-2);\n}\n.profile-actions {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 10px;\n  margin-left: auto;\n}\n.btn-outline {\n  padding: 8px 14px;\n  border: 1px solid rgba(18, 167, 245, 0.42);\n  border-radius: 8px;\n  background: #fff;\n  color: var(--team-blue-deep);\n  font-size: 12.5px;\n  cursor: pointer;\n}\n.btn-outline:hover { background: var(--team-blue-soft); }\n\n.conn-title {\n  margin: 18px 0 8px;\n  font-size: 12.5px;\n  color: var(--team-text-2);\n  font-weight: 600;\n}\n.conn-list {\n  border: 1px solid var(--team-line);\n  border-radius: 10px;\n  overflow: hidden;\n  background: #fff;\n}\n.conn-item {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  padding: 10px 12px;\n  border-bottom: 1px solid var(--team-line);\n}\n.conn-item:last-child { border-bottom: none; }\n.conn-name { font-size: 13px; font-weight: 600; }\n.conn-meta {\n  margin-left: auto;\n  font-size: 11.5px;\n  color: var(--team-text-3);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  max-width: 55%;\n  text-align: right;\n}\n/* 头像下方那行驱动名：不靠右、不省略 */\n.conn-meta-compact {\n  margin: 0;\n  max-width: none;\n  text-align: left;\n}\n\n/* ========================================================================\n   轻提示（toast）：导出成功、表单校验失败等短反馈\n   ==================================================================== */\n.toast {\n  position: fixed;\n  left: 50%;\n  bottom: 34px;\n  transform: translate(-50%, 12px);\n  z-index: var(--dmt-z-toast, 1);  /* 必须最高：提示要能在弹窗之上被看见 */\n  padding: 9px 18px;\n  border-radius: 999px;\n  background: rgba(31, 35, 41, 0.88);\n  color: #fff;\n  font-size: 12.5px;\n  opacity: 0;\n  pointer-events: none;\n  transition: opacity 0.2s ease, transform 0.2s ease;\n}\n.toast.show { opacity: 1; transform: translate(-50%, 0); }\n\n/* ========================================================================\n   导入结果弹层：展示 JSON 解析结果，不阻塞页面\n   ==================================================================== */\n.modal-mask {\n  position: fixed;\n  inset: 0;\n  /* 必须高于插件主窗口：弹窗是从主窗口里点开的，层高低于它就会被整块盖住\n     （实测：表单字段全被遮住，只剩标题和底部按钮）。具体数值由\n     lib/client-parts/foundation/z-layers.js 的层级列表统一分配，这里只引用变量。 */\n  z-index: var(--dmt-z-modal, 1);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  background: rgba(16, 40, 66, 0.34);\n}\n.modal {\n  width: min(640px, calc(100vw - 48px));\n  max-height: 76vh;\n  display: flex;\n  flex-direction: column;\n  border-radius: 12px;\n  background: #fff;\n  box-shadow: var(--team-shadow-lg);\n  overflow: hidden;\n}\n.modal-head {\n  display: flex;\n  align-items: center;\n  padding: 12px 14px;\n  font-size: 13.5px;\n  font-weight: 600;\n  border-bottom: 1px solid var(--team-line);\n  background: linear-gradient(120deg, #f2f9ff, #ffffff);\n}\n.modal-x {\n  margin-left: auto;\n  width: 24px;\n  height: 24px;\n  padding: 0;\n  border: none;\n  border-radius: 6px;\n  background: transparent;\n  color: var(--team-text-2);\n  font-size: 15px;\n  cursor: pointer;\n}\n.modal-x:hover { background: rgba(18, 167, 245, 0.14); color: var(--team-blue-deep); }\n.modal-body {\n  padding: 14px;\n  overflow: auto;\n  font-size: 12.5px;\n}\n.modal-p { margin: 0 0 8px; color: var(--team-text-2); }\n.modal-table {\n  width: 100%;\n  border-collapse: collapse;\n  font-size: 12px;\n}\n.modal-table th, .modal-table td {\n  padding: 6px 8px;\n  border-bottom: 1px solid var(--team-line);\n  text-align: left;\n  word-break: break-all;\n}\n.modal-table th { color: var(--team-text-3); font-weight: 600; background: #fafcfe; }\n\n/* ========================================================================\n   好友分组表单（弹窗内）：字段错误与服务端失败原文必须看得见，不靠颜色区分\n   ==================================================================== */\n.friend-group-form .fg-picker {\n  display: flex;\n  gap: 8px;\n  align-items: center;\n  flex-wrap: wrap;\n}\n.friend-group-form .fg-picker .field-select { flex: 1 1 140px; min-width: 0; }\n.fg-error {\n  margin-top: 4px;\n  min-height: 14px;\n  font-size: 11.5px;\n  color: var(--team-red);\n}\n.fg-form-error {\n  margin: 4px 0 10px;\n  padding: 8px 10px;\n  border: 1px solid rgba(217, 45, 32, 0.35);\n  border-radius: 8px;\n  background: rgba(217, 45, 32, 0.06);\n  font-size: 12px;\n  color: var(--team-red);\n  word-break: break-all;\n}\n.fg-remove {\n  margin-left: 8px;\n  padding: 2px 6px;\n  border: 1px solid var(--team-line);\n  border-radius: 6px;\n  background: #fff;\n  font-size: 11.5px;\n  color: var(--team-text-2);\n  cursor: pointer;\n}\n.fg-actions {\n  display: flex;\n  gap: 10px;\n  align-items: center;\n  justify-content: flex-end;\n  margin-top: 14px;\n  padding-top: 12px;\n  border-top: 1px solid var(--team-line);\n}\n.fg-actions .btn-primary { min-width: 96px; padding: 8px 16px; }\n.btn-danger {\n  padding: 8px 14px;\n  border: 1px solid rgba(217, 45, 32, 0.45);\n  border-radius: 9px;\n  background: #fff;\n  color: var(--team-red);\n  font-size: 12.5px;\n  font-weight: 600;\n  cursor: pointer;\n}\n.btn-danger:hover { background: rgba(217, 45, 32, 0.08); }\n\n/* ========================================================================\n   视图五：通讯录（好友分组管理）\n   ==================================================================== */\n.contacts-body {\n  flex: 1;\n  min-height: 0;\n  overflow-y: auto;\n  padding: 14px 16px;\n}\n.contacts-label {\n  margin-bottom: 8px;\n  font-size: 12.5px;\n  color: var(--team-text-2);\n  font-weight: 600;\n}\n.contact-list { display: flex; flex-direction: column; gap: 14px; }\n.contacts-empty {\n  padding: 24px;\n  text-align: center;\n  color: var(--team-text-3);\n  font-size: 12.5px;\n}\n.contact-row { border-bottom: 1px dashed var(--team-line); padding-bottom: 8px; }\n.contact-row:last-child { border-bottom: none; }\n.contact-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 4px 0 6px;\n}\n.contact-name { font-size: 13px; font-weight: 600; }\n.contact-strategy { font-size: 11.5px; color: var(--team-text-2); }\n.contact-edit {\n  margin-left: auto;\n  flex: none;\n  padding: 2px 8px;\n  border: 1px solid var(--team-line);\n  border-radius: 6px;\n  background: #fff;\n  color: var(--team-text-2);\n  font-size: 11.5px;\n  cursor: pointer;\n}\n.contact-edit:hover { border-color: rgba(18, 167, 245, 0.4); color: var(--team-blue-deep); }\n.contact-members { padding-left: 8px; }\n.contact-member {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  padding: 3px 0;\n  font-size: 12px;\n}\n.contact-branch { color: var(--team-text-3); font-family: monospace; }\n.contact-member-model {\n  font-family: \"JetBrains Mono\", Consolas, monospace;\n  font-weight: 600;\n}\n.contact-member-from {\n  color: var(--team-text-3);\n  font-size: 11px;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.contact-role { flex: none; font-size: 11px; color: var(--team-text-3); }\n.contact-role-main { color: var(--team-blue-deep); font-weight: 600; }\n.contacts-foot {\n  flex: none;\n  padding: 10px 16px 12px;\n  border-top: 1px solid var(--team-line);\n  background: #fff;\n  text-align: center;\n}\n.fp-contacts { margin-top: 8px; }\n\n/* mention.css —— @ 选择群友的浮层：列表、悬停/键盘高亮、模型名省略。\n   浮层贴在输入区上方，宽度受输入框限制。 */\n\n.at-pop {\n  position: absolute;\n  left: 12px;\n  bottom: 56px;\n  width: min(320px, 70%);\n  /* 两块列表（本群群友 + 好友分组）要一屏放得下，太矮分组块会被裁掉 */\n  max-height: 320px;\n  overflow-y: auto;\n  padding: 6px;\n  border-radius: 10px;\n  background: #fff;\n  border: 1px solid var(--team-line);\n  box-shadow: var(--team-shadow);\n  z-index: 20;\n}\n.at-pop.hidden { display: none; }\n.at-pop-title {\n  padding: 4px 8px 6px;\n  font-size: 11px;\n  color: var(--team-text-3);\n}\n.at-item {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 7px 8px;\n  border-radius: 7px;\n  cursor: pointer;\n  font-size: 12.5px;\n}\n.at-item:hover, .at-item.active { background: var(--team-blue-soft); }\n.at-item .at-model {\n  font-family: \"JetBrains Mono\", Consolas, monospace;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.at-item .at-tag { margin-left: auto; flex: none; font-size: 10px; color: var(--team-text-3); }\n\n/* 模型项的小头像，比群列表头像小一号 */\n.at-avatar {\n  width: 26px;\n  height: 26px;\n  border-radius: 7px;\n  font-size: 11px;\n}\n/* 分组项头像用圆角胶囊色，和单模型区分开 */\n.at-avatar-group {\n  background: linear-gradient(145deg, #fff4e6, #ffe7c7);\n  color: #b5730a;\n}\n/* 两块列表的分区标题 */\n.at-section {\n  padding: 6px 8px 3px;\n  font-size: 11px;\n  color: var(--team-text-3);\n  border-top: 1px solid var(--team-line);\n  margin-top: 4px;\n}\n.at-section:first-child { border-top: none; margin-top: 0; }\n";
// 由 build.cjs 从 ui/index.html 抽取的界面骨架（勿手改）
var UI_SKELETON_HTML = "<!-- 悬浮窗收起态：模型 pill + 圆球，整体可拖动 -->\n  <div class=\"float-dock\" id=\"floatDock\">\n    <!-- pill 在球左侧，球拖到屏幕最右边时不会被挤出视口 -->\n    <div class=\"float-pill\" id=\"floatPill\">\n      <span class=\"pill-model\">( — )</span>\n      <span class=\"pill-dot\"></span>\n    </div>\n    <button class=\"float-ball\" id=\"floatBall\" type=\"button\" title=\"点击展开模型团队悬浮窗（可拖动）\">\n      <span class=\"fb-target\" data-fb-target>—</span>\n      <span class=\"fb-dot\"></span>\n    </button>\n  </div>\n\n  <!-- 悬浮窗展开态：当前群聊 / 当前目标 / 当前速率 / 全局请求量 -->\n  <section class=\"float-panel hidden\" id=\"floatPanel\" aria-label=\"模型团队悬浮窗\">\n    <header class=\"fp-head\" id=\"fpHead\">\n      <button class=\"fp-title-btn\" id=\"fpTitle\" type=\"button\" title=\"进入我的数据库\">👤 我的模型团队</button>\n      <span class=\"fp-model\" id=\"fpModel\">模型 —</span>\n      <span class=\"fp-ops\">\n        <button class=\"fp-btn\" id=\"fpMin\" type=\"button\" title=\"收起为悬浮球\">—</button>\n        <button class=\"fp-btn\" id=\"fpClose\" type=\"button\" title=\"关闭悬浮窗\">×</button>\n      </span>\n    </header>\n    <div class=\"fp-body\">\n      <div class=\"fp-row\"><span class=\"fp-k\">当前群聊：</span><span class=\"fp-v\" id=\"fpGroup\">—</span></div>\n      <div class=\"fp-row\"><span class=\"fp-k\">会话：</span><span class=\"fp-v\" id=\"fpSession\">—</span></div>\n      <div class=\"fp-row\"><span class=\"fp-k\">当前目标：</span><span class=\"fp-v\" id=\"fpTarget\">—</span></div>\n      <div class=\"fp-row\"><span class=\"fp-k\">📊 当前速率：</span><span class=\"fp-v\" id=\"fpRate\">— tok/s</span></div>\n      <div class=\"fp-row\"><span class=\"fp-k\">📈 全局请求量：</span><span class=\"fp-v\" id=\"fpTotal\">—</span></div>\n    </div>\n    <footer class=\"fp-foot\">\n      <button class=\"fp-enter\" id=\"fpEnter\" type=\"button\">[ 进入群聊界面 &gt; ]</button>\n      <button class=\"fp-enter fp-contacts\" id=\"btnContacts\" type=\"button\">📇 通讯录 · 好友分组</button>\n    </footer>\n  </section>\n\n  <!-- 关闭悬浮窗后的召回入口 -->\n  <button class=\"float-recall hidden\" id=\"floatRecall\" type=\"button\">💬 呼出模型团队</button>\n\n  <!-- 模型团队主窗口：各视图渲染进 #viewRoot；底部固定三 tab（契约条款 21-24） -->\n  <main class=\"team-app\">\n    <header class=\"team-bar\">\n      <span class=\"team-logo\">团队</span>\n      <span class=\"team-view-name\" id=\"viewName\">消息</span>\n    </header>\n    <div class=\"team-body\" id=\"viewRoot\"></div>\n    <nav class=\"team-tabbar\" role=\"tablist\" aria-label=\"主导航\">\n      <button class=\"team-tab\" type=\"button\" role=\"tab\" data-view=\"list\" aria-selected=\"true\">\n        <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">\n          <path d=\"M20.5 14.5a2.5 2.5 0 0 1-2.5 2.5H9l-4.5 3v-3.2A2.5 2.5 0 0 1 3.5 14.5v-7A2.5 2.5 0 0 1 6 5h12a2.5 2.5 0 0 1 2.5 2.5z\"></path>\n          <path d=\"M7.5 9h9M7.5 12.5h6\"></path>\n        </svg>\n        <span class=\"team-tab-label\">消息</span>\n      </button>\n      <button class=\"team-tab\" type=\"button\" role=\"tab\" data-view=\"contacts\" aria-selected=\"false\">\n        <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">\n          <circle cx=\"9.5\" cy=\"8.5\" r=\"3.2\"></circle>\n          <path d=\"M3.8 19.5a5.7 5.7 0 0 1 11.4 0\"></path>\n          <circle cx=\"17.2\" cy=\"9.5\" r=\"2.3\"></circle>\n          <path d=\"M15.4 19.5a4.4 4.4 0 0 1 5.4-4\"></path>\n        </svg>\n        <span class=\"team-tab-label\">通讯录</span>\n      </button>\n      <button class=\"team-tab\" type=\"button\" role=\"tab\" data-view=\"profile\" aria-selected=\"false\">\n        <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">\n          <circle cx=\"12\" cy=\"8\" r=\"3.6\"></circle>\n          <path d=\"M5.2 20a6.8 6.8 0 0 1 13.6 0\"></path>\n        </svg>\n        <span class=\"team-tab-label\">我</span>\n      </button>\n    </nav>\n  </main>\n\n  <noscript><p class=\"noscript\">本预览需要启用 JavaScript 才能看到界面。</p></noscript>\n\n  <!-- 数据层：接口实现只有一份（lib/client-parts 里的 api.js）。本页直接连真实后端，不再有 mock 传输 -->";
// rate.js —— 模型团队速率计算（唯一实现，ui 预览与插件客户端共用）。
//
// 口径（与解码段公式对齐，docs/02 §5.1，别再改回 total/latency）：
//   1) 精确值 = 输出 token / **解码段**（首字 → 结束）：分母去掉首字等待（TTFT），
//      这才是"生成速度"；整步耗时里首字等待可能占一大半，长思考模型会被严重低估
//   2) 退化值 = 输出 token / 整步耗时：拿不到首字时刻时只能这么算，它是**下界**，
//      所以必须返回 exact=false，展示层加 ≈，别让下界冒充精确值
//   3) 禁止用 row.tokens（total，含输入）或 row.latency 字符串兜底：长上下文下 total 里 99% 是
//      promptTokens，40.3k / 4.56s 会算出 8837 tok/s，而真实生成速度只有 83 tok/s
//   4) 取不到 → null，展示层 formatRateText(null) 输出 "—"
//
// 纯函数、零依赖、不碰 DOM。这里刻意不写 IIFE 包装：本文件是"按顺序拼接的大脚本"里的一个片段，
// 与 store/float 那些分片一样用顶层函数，再在文件末尾挂一次全局；包一层会让"整个文件"被当成
// 一个上百行的函数（代码行门禁会拦），也让调试栈里多一层无意义的匿名调用。

// 毫秒 → 秒：本文件里出现的 1000 只有这一个含义，集中成常量避免各处裸写
var MS_PER_SECOND = 1000;
// 近似值前缀：一眼能看出"这个数字是下界"，不用点开 tooltip
var RATE_APPROX_PREFIX = '≈';
// 缺值占位：与全仓一致用破折号
var RATE_EMPTY_TEXT = '—';

// 解析 "40.3k" / "1.2M" / 数字；"—"/空/非法 → null（仅供展示与兼容，不参与速率）
function parseTokenCount(text) {
  if (typeof text === 'number') return isFinite(text) ? text : null;
  var match = /^\s*([\d.]+)\s*([kKmM]?)\s*$/.exec(String(text == null ? '' : text));
  if (!match) return null;
  var value = parseFloat(match[1]);
  if (!isFinite(value)) return null;
  var unit = match[2].toLowerCase();
  if (unit === 'k') return value * 1000;
  if (unit === 'm') return value * 1000000;
  return value;
}

// 解析 "4.56s" / 数字秒；"—"/空/非法 → null
function parseLatencySeconds(text) {
  if (typeof text === 'number') return isFinite(text) ? text : null;
  var match = /^\s*([\d.]+)\s*s\s*$/.exec(String(text == null ? '' : text));
  if (!match) return null;
  var value = parseFloat(match[1]);
  return isFinite(value) ? value : null;
}

// 只有"能做除数"的数字才算有效分母：0 与负数一律视为没有数据，避免算出 Infinity / 负速率
function isUsableMeasure(value) {
  return typeof value === 'number' && isFinite(value) && value > 0;
}

// 单行的生成速率：返回 { tps, exact } 或 null。
// exact=true 只有一种来路——本行记录了首字时刻（decodeMs 可用），分母是解码段；
// 退化到整步耗时一律 exact=false，让展示层能标 ≈。
// 注意用宽松比较：历史行没有这些字段（undefined）与显式 null 都要跳过。
function computeGenerationRate(row) {
  if (!row || typeof row !== 'object') return null;
  var completionTokens = row.completionTokens;
  if (!isUsableMeasure(completionTokens)) return null;

  if (isUsableMeasure(row.decodeMs)) {
    return { tps: completionTokens / (row.decodeMs / MS_PER_SECOND), exact: true };
  }
  if (isUsableMeasure(row.latencySeconds)) {
    return { tps: completionTokens / row.latencySeconds, exact: false };
  }
  return null;
}

// 会话级聚合：sum(输出 token) / sum(分母)，不是逐行速率的平均——
// 平均会让"只有 1 个 token 的短请求"和"上千 token 的长请求"同权，长回复被短回复带偏。
// 两个桶分别累加：精确桶（有解码段）优先；一条精确行都没有时才退化成整步桶。
function aggregateGenerationRate(rows) {
  if (!rows || typeof rows.length !== 'number' || rows.length === 0) return null;

  var exactTokens = 0;
  var exactDecodeMs = 0;
  var spanTokens = 0;
  var spanSeconds = 0;

  for (var index = 0; index < rows.length; index += 1) {
    var row = rows[index];
    if (!row || typeof row !== 'object') continue;
    var completionTokens = row.completionTokens;
    if (!isUsableMeasure(completionTokens)) continue;

    if (isUsableMeasure(row.decodeMs)) {
      exactTokens += completionTokens;
      exactDecodeMs += row.decodeMs;
    } else if (isUsableMeasure(row.latencySeconds)) {
      spanTokens += completionTokens;
      spanSeconds += row.latencySeconds;
    }
  }

  if (exactDecodeMs > 0 && exactTokens > 0) {
    return { tps: exactTokens / (exactDecodeMs / MS_PER_SECOND), exact: true };
  }
  if (spanSeconds > 0 && spanTokens > 0) {
    return { tps: spanTokens / spanSeconds, exact: false };
  }
  return null;
}

// 展示格式：<100 保留 1 位小数；>=100 取整；>=1000 用 k；无效 → "—"
function formatRate(value) {
  if (typeof value !== 'number' || !isFinite(value)) return RATE_EMPTY_TEXT;
  if (value >= 1000) return (value / 1000).toFixed(1) + 'k';
  if (value >= 100) return String(Math.round(value));
  return value.toFixed(1);
}

// 带"精确/下界"标记的展示串：退化值前面加 ≈，精确值原样，无数据 "—"。
// 前缀放在这里而不是 formatRate 里：formatRate 只管数字形态，标记是口径问题，两者别混。
function formatRateText(result) {
  if (!result || typeof result !== 'object') return RATE_EMPTY_TEXT;
  var text = formatRate(result.tps);
  if (text === RATE_EMPTY_TEXT) return text;
  return result.exact === true ? text : RATE_APPROX_PREFIX + text;
}

// 对外出口：api.js / 测试都通过这个名字取函数（预览页与打包产物都靠它）
var ModelTeamRate = {
  parseTokenCount: parseTokenCount,
  parseLatencySeconds: parseLatencySeconds,
  computeGenerationRate: computeGenerationRate,
  aggregateGenerationRate: aggregateGenerationRate,
  formatRate: formatRate,
  formatRateText: formatRateText
};

if (typeof globalThis !== 'undefined') {
  globalThis.ModelTeamRate = ModelTeamRate;
}
// messages.js —— 消息流构建：把「请求记录 rows」与「会话事件 events」合并成一条按时间排序的消息列表。
// 单独成文件是为了让 app.js 保持精简（交互与渲染入口已够长），也方便单测排序规则。

// 消息排序键：统一换算成"当天毫秒偏移"，两种来源才能比较——
// at（ISO）取本地时分秒，time（HH:mm[:ss]）直接拆解；都没有的排最后，同键靠 tieBreak 稳定
function messageSortValue(source) {
  if (source && source.at) {
    const parsed = Date.parse(source.at);
    if (!isNaN(parsed)) {
      const when = new Date(parsed);
      return when.getHours() * 3600000 + when.getMinutes() * 60000 + when.getSeconds() * 1000;
    }
  }
  const clockMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String((source && source.time) || ''));
  if (clockMatch) {
    const hours = Number(clockMatch[1]);
    const minutes = Number(clockMatch[2]);
    const seconds = Number(clockMatch[3] || 0);
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  }
  return Number.MAX_SAFE_INTEGER;
}

// 消息展示时间：at（ISO）→ 本地 HH:mm:ss；没有 at 就用后端给的 time 原样
function formatMessageTime(source) {
  if (source && source.at) {
    const when = new Date(source.at);
    if (!isNaN(when.getTime())) {
      return [when.getHours(), when.getMinutes(), when.getSeconds()]
        .map(function (value) { return String(value).padStart(2, '0'); }).join(':');
    }
  }
  return String((source && source.time) || '');
}

// 请求记录与会话事件合并成一个按时间排序的列表（不是先 rows 再 events 的拼接）：
// 排序键优先 at、其次 time；同键时 rows 在前、events 在后，保持后端返回顺序不乱
function buildMessages(groupId, rows, events) {
  const items = [];
  rows.forEach(function (row, rowIndex) {
    items.push({
      message: { type: 'row', row: row, rowIndex: rowIndex, expanded: false, time: formatMessageTime(row) },
      sortValue: messageSortValue(row),
      tieBreak: rowIndex
    });
  });
  events.forEach(function (sessionEvent, eventIndex) {
    const isMine = sessionEvent.type === 'self-message';
    items.push({
      message: {
        type: isMine ? 'mine' : 'sys',
        text: sessionEvent.text,
        time: formatMessageTime(sessionEvent)
      },
      sortValue: messageSortValue(sessionEvent),
      tieBreak: rows.length + eventIndex
    });
  });
  items.sort(function (left, right) {
    if (left.sortValue !== right.sortValue) return left.sortValue - right.sortValue;
    return left.tieBreak - right.tieBreak;
  });
  return items.map(function (item) { return item.message; });
}
// 目标来源提示的唯一口径：悬浮球与请求卡片共用同一份映射。
// 为什么要单独成文件：两处各写一份必然漂移，而"来源文案不一致"会让用户以为是两套语义。
// 语义边界（契约 02 §3.2 targetSource）：
//   - 空值 = 本会话显式绑定，不需要提示（**不是**缺失字段，所以不显示 `—`）
//   - 已知回落来源 = 显示括号小字
//   - 未知字符串 = 不渲染（别把未知值当正常值展示），只告警一次，便于发现后端新增来源忘了同步
var TARGET_SOURCE_HINTS = {
  "last-session": "（继承上一会话）",
  parent: "（继承父会话）",
  "fallback-group": "（兜底群默认）"
};

function targetSourceHintOf(targetSource) {
  if (typeof targetSource !== "string" || targetSource.length === 0) return "";
  var hint = TARGET_SOURCE_HINTS[targetSource];
  if (hint === undefined) {
    warnOnce("未知 targetSource：" + targetSource, null);
    return "";
  }
  return hint;
}

// 请求卡片上的来源标记：没有提示内容时整段不渲染（含分隔符），避免出现空 span 或孤立的分隔点
function renderTargetSourceBadge(targetSource) {
  var hint = targetSourceHintOf(targetSource);
  if (!hint) return "";
  return '<span class="req-source">' + escapeHtml(hint) + "</span>";
}
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
// store-state.js —— 状态的形状与常量（唯一真相源只在这里定义"初始长什么样"）。
// 为什么单独成文件：拆分后各模块都要读 state，但"state 有哪些字段"必须只有一处定义，
// 否则新加字段时漏改某一处，就会出现"某块逻辑永远读到 undefined"的隐性 bug。

// 事件清单：只有这些广播会触发重渲染（契约 docs/13 §3.4）
var STORE_EVENTS = ['session:changed', 'target:changed', 'chat:updated', 'stats:updated', 'groups:updated', 'platforms:updated', 'view:changed'];
var STORAGE_WRITE_DEBOUNCE_MS = 150;
var RATE_PLACEHOLDER_TEXT = '— tok/s';
// 持久化键由工厂单点持有（视图不再自己读写 localStorage）
var ANCHOR_STORAGE_KEY = 'dsh-model-team:anchor';
var SESSION_STORAGE_KEY = 'dsh-model-team:last-session';

function createInitialState() {
  return {
    sessionId: null,
    sessionTitle: null,
    lastSessionId: null,
    target: null,                 // 本会话显式绑定的目标（可能为 null）
    effectiveTarget: null,        // 实际生效的目标（含后端回落），面板/球/群聊都用它
    targetSource: 'none',         // explicit | parent | last-session | fallback-group | none
    groups: [],
    // drivers / friendGroups 必须在初始 state 里：渲染路径（platformOf）会直接读 state.drivers，
    // 缺字段时抛 TypeError 会把整条 boot 链打断，表现就是"群列表 0 个群但接口有数据"。
    drivers: [],
    friendGroups: [],
    // 群列表最近一次加载失败的原因（null = 没失败）：渲染层据此区分"真的空"与"加载失败"
    lastGroupsError: null,
    platforms: [],
    currentGroupId: '',
    models: {},
    // 每个群的模型清单加载状态：'loading' | 'loaded' | 'error'。
    // 必须与 models 分开记：models[groupId] 缺省是 []，"还没拉"与"确实 0 个"取值一样，
    // 界面就会把"未知"显示成 0（G-13 同类问题），所以视图要能查到状态再决定显示 — 还是数字。
    modelsStatus: {},
    messages: {},
    rate: RATE_PLACEHOLDER_TEXT,
    global: { requests: 0, tokens: 0, text: '—' },
    view: 'list',
    anchor: null,
    errors: []
  };
}
// store-persist.js —— 持久化端口：悬浮球锚点与最近会话标识的读回/写入（契约 docs/13 §七）。
// 依赖全部从参数进来（storage / state / reportError），模块内不引用任何全局状态，
// 这样"去抖 150ms + 退出 flush + loadedOnce 凭证"三条语义可以单独测。

function createPersistencePort(options) {
  var storage = options.storage || { read: function () { return null; }, write: function () {} };
  var state = options.state;
  var reportError = options.reportError;

  var loadedOnce = false;       // 写入凭证：读失败过也不能写空覆盖
  var pendingWrites = {};
  var writeTimer = null;

  function readRaw(key) {
    try { return storage.read(key); }
    catch (error) { reportError('read:' + key, error); return null; }
  }

  function loadPersisted() {
    var anchorRaw = readRaw(ANCHOR_STORAGE_KEY);
    if (anchorRaw) {
      try {
        var parsedAnchor = JSON.parse(anchorRaw);
        if (parsedAnchor && typeof parsedAnchor.left === 'number' && typeof parsedAnchor.top === 'number') {
          state.anchor = { left: parsedAnchor.left, top: parsedAnchor.top };
        }
      } catch (error) {
        // 脏数据：回落默认（不加锚点），不删键、不影响其它键
        reportError('anchor-json', error);
      }
    }
    state.lastSessionId = readRaw(SESSION_STORAGE_KEY) || null;
    // 读不成功也算"读过"：写入凭证防的是"读失败后写空覆盖"，不是"永远不写"
    loadedOnce = true;
  }

  function persist(key, value) {
    if (!loadedOnce) return;                              // 写入凭证
    pendingWrites[key] = value;
    if (writeTimer) return;
    writeTimer = setTimeout(flushWrites, STORAGE_WRITE_DEBOUNCE_MS);
  }

  function flushWrites() {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    Object.keys(pendingWrites).forEach(function (key) {
      var value = pendingWrites[key];
      delete pendingWrites[key];
      try { storage.write(key, value); }
      catch (error) { reportError('write:' + key, error); }
    });
  }

  function handlePageExit() { flushWrites(); }

  return {
    readRaw: readRaw,
    loadPersisted: loadPersisted,
    persist: persist,
    flushWrites: flushWrites,
    handlePageExit: handlePageExit
  };
}
// store-events.js —— 错误出口 + 事件总线（渲染只由广播触发，契约 docs/13 §3.4/§八）。
// 为什么和 store.js 分开：这两块是"所有模块都要用"的基础设施，留在装配文件里会把
// createTeamStore 撑回几百行；分出来后装配文件只负责接线。

/** 错误出口：预期失败（配额/安全/元素不存在）静默，其余进 state.errors 并留一条 dataset 线索 */
function createErrorSink(options) {
  var state = options.state;

  function isExpectedFailure(error) {
    if (!error) return true;
    if (typeof DOMException !== 'undefined' && error instanceof DOMException) return true;
    return /Quota|Security|NotAllowed/.test(String(error.name || ''));
  }

  function reportError(tag, error) {
    if (isExpectedFailure(error)) return;                 // 配额/安全/元素不存在：静默降级
    var message = String(error && error.message ? error.message : error);
    state.errors.push({ tag: tag, message: message });
    try { document.documentElement.dataset.lastStoreError = tag + ': ' + message; }
    catch (ignored) { /* 连 dataset 都写不了就放弃，不能因此中断 */ }
  }

  return { isExpectedFailure: isExpectedFailure, reportError: reportError };
}

/** 事件总线：订阅表 + 广播。渲染器作为每个事件的内部订阅者——没有广播就没有渲染 */
function createEventHub(options) {
  var state = options.state;
  var reportError = options.reportError;
  var onRender = options.onRender;

  var listeners = {};
  STORE_EVENTS.forEach(function (eventName) { listeners[eventName] = []; });

  function renderNow() {
    try { onRender(state); }
    catch (error) { reportError('render', error); }
  }

  STORE_EVENTS.forEach(function (eventName) {
    listeners[eventName].push(function () { renderNow(); });
  });

  function broadcast(eventName, payload) {
    var handlers = listeners[eventName] || [];
    for (var index = 0; index < handlers.length; index += 1) {
      try { handlers[index](payload, state); }
      catch (error) { reportError('listener:' + eventName, error); }
    }
  }

  function subscribe(eventName, listener) {
    if (!listeners[eventName]) listeners[eventName] = [];
    listeners[eventName].push(listener);
    return function unsubscribe() {
      var position = listeners[eventName].indexOf(listener);
      if (position >= 0) listeners[eventName].splice(position, 1);
    };
  }

  return { renderNow: renderNow, broadcast: broadcast, subscribe: subscribe };
}

/**
 * api.js 的失败上报接线：三类失败（HTTP / JSON / 网络）都进 state.errors；
 * 另外把 /groups 的失败单独留在 sink 里——apiJson 对失败只上报不 reject，
 * 只按 Promise 状态判断会把 500 当成"成功返回空"，界面就继续显示「0 个群」。
 * @returns {{groups: string|null}} 供 loaders 读取的失败直通槽
 */
function createApiFailureSink(options) {
  var reportError = options.reportError;
  var sink = { groups: null };
  if (typeof apiSetErrorReporter !== 'function') return sink;
  apiSetErrorReporter(function (failure) {
    var detail = failure && failure.detail ? String(failure.detail) : 'request failed';
    reportError('api:' + (failure && failure.kind) + ':' + (failure && failure.path), { message: detail });
    if (failure && failure.path === '/groups') {
      // detail 自身已带类别信息（http-status 是「HTTP 500」、json-parse 是解析错误原文），
      // 这里只给其余两类补一个可读前缀，避免出现「HTTP HTTP 500」
      sink.groups = failure.kind === 'http-status'
        ? detail
        : (failure.kind === 'json-parse' ? '数据解析失败：' : '网络异常：') + detail;
    }
  });
  return sink;
}
// store-groups.js —— 群列表与平台清单的加载（四个接口逐接口容错）。
// 依赖以参数注入，模块内不引用全局状态，便于单独验证"一个接口失败不清空其它数据"。

// 有界重试调度：只对失败的接口重拉，成功的那几份由调用方负责保留。
// 放在模块级（而不是塞进 createGroupLoaders）是为了两件事：
//   ① 工厂函数保持可读——它只管"怎么取数/怎么落到 state"，重试流程单独一段；
//   ② 这段逻辑与具体 store 无关，坏了好定位。
// options.fetchOnce(indices) -> Promise<{ failedIndices, rejectionReasons }>
// options.onRound(result)    -> 需要重试的下标数组（返回空数组表示收工）
function runGroupLoadsWithRetry(options) {
  var retryDelays = options.retryDelays;
  var schedule = options.schedule;
  var describeName = options.describeName;
  var pendingIndices = options.initialIndices;
  var retryRound = 0;

  function runRound() {
    return options.fetchOnce(pendingIndices).then(function (fetchResult) {
      var failedForRetry = options.onRound(fetchResult) || [];
      if (failedForRetry.length === 0) return options.finalResult();
      if (retryRound >= retryDelays.length) return options.finalResult();

      retryRound += 1;
      pendingIndices = failedForRetry;
      var failedNameList = failedForRetry.map(describeName).join('、');
      if (typeof console !== 'undefined' && console.info) {
        console.info('[groups] 第 ' + retryRound + ' 轮重试 ← ' + failedNameList);
      }
      return new Promise(function (resolve) {
        schedule(function () { resolve(runRound()); }, retryDelays[retryRound - 1]);
      });
    });
  }

  return runRound();
}

function createGroupLoaders(deps) {
  var api = deps.api;
  var state = deps.state;
  var broadcast = deps.broadcast;
  var reportError = deps.reportError;
  // api.js 的失败上报通道把 /groups 的失败写进这里（apiJson 对失败只上报不 reject，
  // 只看 Promise 状态会把 500 当成"成功返回空"）
  var apiFailureSink = deps.apiFailureSink || { groups: null };

  // 失败原因给渲染层看的一句话（不含栈，避免把内部细节写进界面）
  function describeLoadFailure(reason) {
    if (!reason) return '接口无响应';
    if (typeof reason === 'string') return reason;
    return reason.message ? String(reason.message) : String(reason);
  }

  // 四个接口并发拉，但**任一失败不许清空其它三份**：
  // Promise.all 的"一败全败"会让单个 500（如 platforms 挂掉）把群列表也变成空，
  // 而界面上只会显示"0 个群"，与真实数据矛盾（实测过）。
  // 启动加载的四个接口：下标稳定（0=groups 是"群列表本身"，重试判定要用到）
  var GROUP_REQUEST_NAMES = ['groups', 'drivers', 'friend-groups', 'platforms'];
  // 有界重试：第一次失败多半是"宿主路由还没就绪/冷启慢"；不重试会让 state.groups 永久为空
  var DEFAULT_GROUP_RETRY_DELAYS_MS = [500, 2000];

  function fetchGroupRequests(indices) {
    var requests = indices.map(function (index) {
      if (index === 0) return api.getGroups();
      if (index === 1) return api.getDrivers();
      if (index === 2) return api.getFriendGroups();
      return api.getPlatforms();
    });
    return Promise.all(requests.map(function (request) {
      // 每个请求都兜成 settled：allSettled 在旧 WebView 上不一定有，这里不依赖它
      return Promise.resolve(request).then(
        function (value) { return { status: 'fulfilled', value: value }; },
        function (reason) { return { status: 'rejected', reason: reason }; },
      );
    })).then(function (settled) {
      var failedIndices = [];
      var rejectionReasons = {};
      settled.forEach(function (entry, position) {
        var index = indices[position];
        if (entry.status === 'rejected') {
          failedIndices.push(index);
          rejectionReasons[index] = entry.reason;
          reportError('load-groups:' + GROUP_REQUEST_NAMES[index], entry.reason);
          return;                       // 保留上一份数据，绝不清空
        }
        var value = entry.value;
        if (index === 0) state.groups = value || [];
        else if (index === 1) state.drivers = value || [];
        else if (index === 2) state.friendGroups = value && value.groups ? value.groups : [];
        else state.platforms = value || [];
      });
      return { failedIndices: failedIndices, rejectionReasons: rejectionReasons };
    });
  }

  // options 可注入调度器与延迟（单测里同步跑完整条重试链，避免真实 sleep）
  function loadGroups(options) {
    var settings = options || {};
    var retryDelays = Array.isArray(settings.retryDelays) ? settings.retryDelays : DEFAULT_GROUP_RETRY_DELAYS_MS;
    var schedule = typeof settings.schedule === 'function'
      ? settings.schedule
      : function (run, delayMs) { return setTimeout(run, delayMs); };

    apiFailureSink.groups = null;
    return runGroupLoadsWithRetry({
      retryDelays: retryDelays,
      schedule: schedule,
      initialIndices: [0, 1, 2, 3],
      describeName: function (index) { return GROUP_REQUEST_NAMES[index]; },
      fetchOnce: function (indices) {
        apiFailureSink.groups = null;    // 每轮重新判定：上一轮的失败不能算到这一轮
        return fetchGroupRequests(indices);
      },
      onRound: function (fetchResult) {
        // apiJson 把非 2xx/网络失败吞成 null（不进 rejected 分支），所以群列表本身
        // 还要单独看 apiFailureSink.groups —— 两者任一都算失败。
        var failedForRetry = fetchResult.failedIndices.slice();
        if (apiFailureSink.groups && failedForRetry.indexOf(0) < 0) failedForRetry.push(0);
        var failed = fetchResult.failedIndices.map(function (index) { return GROUP_REQUEST_NAMES[index]; });
        // 错误原因要尽量具体：界面靠它区分"接口失败"与"确实没有群"
        state.lastGroupsError = apiFailureSink.groups
          || (fetchResult.failedIndices.indexOf(0) >= 0 ? describeLoadFailure(fetchResult.rejectionReasons[0]) : null);
        if (!state.currentGroupId && state.groups.length) state.currentGroupId = state.groups[0].id;
        broadcast('groups:updated', { groups: state.groups, failed: failed });
        if (failedForRetry.length === 0) state.lastGroupsError = null;   // 成功即清空失败态
        return failedForRetry;
      },
      finalResult: function () { return state.groups; },
    });
  }

  // 只刷新平台清单：平台预置是数据文件（config/platforms.json 或 <dataRoot>/platforms.json），
  // 运行时可能被修改，因此每次进入「加群」视图都要重取，不能只在启动时拉一次。
  function loadPlatforms() {
    return api.getPlatforms().then(function (platforms) {
      state.platforms = platforms || [];
      broadcast('platforms:updated', { platforms: state.platforms });
      return state.platforms;
    });
  }

  return { describeLoadFailure: describeLoadFailure, loadGroups: loadGroups, loadPlatforms: loadPlatforms };
}
// store-chat.js —— 单群聊天数据与消息动作（群友清单 / 请求行 / 我发出的 @）。
// modelsStatus 与 models 分开记：models 缺省是 []，"还没拉到"与"确实 0 个"必须能区分。

function createChatLoaders(deps) {
  var api = deps.api;
  var state = deps.state;
  var broadcast = deps.broadcast;
  var reportError = deps.reportError;

  function loadChat(groupId) {
    var targetGroupId = groupId || state.currentGroupId;
    if (!targetGroupId) return Promise.resolve();
    // 先标 'loading'：视图据此区分"还没拉到"与"确实 0 个群友"
    state.modelsStatus[targetGroupId] = 'loading';
    return Promise.all([
      api.getSessionStats(targetGroupId),
      api.getGroupModels(targetGroupId),
      api.getSessionEvents(targetGroupId)
    ]).then(function (results) {
      state.models[targetGroupId] = results[1] || [];
      state.modelsStatus[targetGroupId] = 'loaded';
      // 消息合并/排序只在工厂内：视图拿到的是唯一的一份有序数组
      state.messages[targetGroupId] = buildMessages(targetGroupId, results[0].rows, results[2].events);
      broadcast('chat:updated', { groupId: targetGroupId, messages: state.messages[targetGroupId] });
    }).catch(function (error) {
      // 失败也要给状态，否则界面永远停在"未知"；错误本身照常上报
      state.modelsStatus[targetGroupId] = 'error';
      reportError('load-chat:' + targetGroupId, error);
      throw error;
    });
  }

  // 发送消息：先本地乐观插一条（用 concat 生成新数组，不 push 原数组），随后由 loadChat 用后端数据覆盖。
  // 系统提示一律来自后端事件，这里不插任何 system 文案（契约 §六）。
  function sendMessage(text) {
    var groupId = state.currentGroupId;
    if (!groupId) return Promise.resolve();
    var existing = state.messages[groupId] || [];
    state.messages[groupId] = existing.concat([{
      type: 'mine',
      text: text,
      time: formatMessageTime({ at: new Date().toISOString() })
    }]);
    broadcast('chat:updated', { groupId: groupId, messages: state.messages[groupId] });
    return loadChat(groupId);
  }

  // 展开/收起请求行：属于消息数据的一部分，由工厂改并广播，视图不直接改 state
  function toggleRow(groupId, rowIndex) {
    var messageList = state.messages[groupId] || [];
    state.messages[groupId] = messageList.map(function (message) {
      if (message.type !== 'row' || message.rowIndex !== rowIndex) return message;
      return { type: 'row', row: message.row, rowIndex: message.rowIndex, expanded: !message.expanded, time: message.time };
    });
    broadcast('chat:updated', { groupId: groupId, messages: state.messages[groupId] });
    return Promise.resolve();
  }

  return { loadChat: loadChat, sendMessage: sendMessage, toggleRow: toggleRow };
}
// store-stats.js —— 全局统计与会话目标加载（目标决定"当前群聊看哪个群"）。
// loadChat 由装配层注入（stats 依赖 chat 的加载结果，反过来 chat 不依赖 stats，避免循环）。

function createStatsLoaders(deps) {
  var api = deps.api;
  var state = deps.state;
  var broadcast = deps.broadcast;
  var loadChat = deps.loadChat;

  // 群聊默认显示「该会话目标所属的群」（契约条款 25）：
  // 目标是单模型 → 切到 target.platformId 对应的群；目标是分组或未设置 → 保留当前群聊；
  // 目标群不存在 → 回落当前群，再回落到第一个群。
  function pickGroupIdForTarget(target, groups, fallbackGroupId) {
    var groupList = groups || [];
    if (target && target.type === 'model' && target.platformId) {
      var matched = groupList.filter(function (group) { return group.id === target.platformId; })[0];
      if (matched) return matched.id;
    }
    if (fallbackGroupId && groupList.some(function (group) { return group.id === fallbackGroupId; })) {
      return fallbackGroupId;
    }
    return (groupList[0] && groupList[0].id) || '';
  }

  function loadStats() {
    return api.getGlobalStats().then(function (stats) {
      state.rate = stats && stats.sessionRate ? stats.sessionRate : RATE_PLACEHOLDER_TEXT;
      state.global = {
        requests: stats && typeof stats.totalRows === 'number' ? stats.totalRows : 0,
        tokens: stats && typeof stats.totalTokens === 'number' ? stats.totalTokens : 0,
        text: stats ? stats.globalRequests + ' (' + stats.globalTokens + ')' : '—'
      };
      broadcast('stats:updated', { rate: state.rate, global: state.global });
    });
  }

  function loadTargetAndStats() {
    if (!state.sessionId) {
      state.target = null;
      broadcast('target:changed', { target: null });
      return loadStats();
    }
    return api.getSessionTarget(state.sessionId).then(function (payload) {
      // 后端出参：{ target, effectiveTarget, targetSource }；旧出参已被 api 层归一化成同形
      state.target = payload && payload.target ? payload.target : null;
      state.effectiveTarget = payload && payload.effectiveTarget ? payload.effectiveTarget : state.target;
      state.targetSource = payload && payload.targetSource ? payload.targetSource : 'none';
      // 群聊跟着「实际生效的目标」走（不是显式绑定，否则新会话会落到旧群）
      var nextGroupId = pickGroupIdForTarget(state.effectiveTarget, state.groups, state.currentGroupId);
      if (nextGroupId) state.currentGroupId = nextGroupId;
      broadcast('target:changed', { target: state.effectiveTarget, groupId: state.currentGroupId });
      return loadStats();
    }).then(function () {
      return loadChat(state.currentGroupId);
    });
  }

  return { loadStats: loadStats, loadTargetAndStats: loadTargetAndStats, pickGroupIdForTarget: pickGroupIdForTarget };
}
// store-session.js —— 会话生命周期与目标切换（启动/停止/切会话/切目标/视图动作）。
// 依赖全部注入（api / state / broadcast / persist / loaders / sessionSource），
// 模块内不持有第二个真相源：读写的都是传进来的同一份 state。

function createSessionAndTarget(deps) {
  var api = deps.api;
  var state = deps.state;
  var broadcast = deps.broadcast;
  var persist = deps.persist;
  var loaders = deps.loaders;
  var sessionSource = deps.sessionSource || null;
  var persistence = deps.persistence;

  function start() {
    persistence.loadPersisted();                          // R2：读回早于首帧
    document.addEventListener('visibilitychange', persistence.handlePageExit);
    window.addEventListener('pagehide', persistence.handlePageExit);  // pagehide 的目标是 window，不是 document
    if (sessionSource) sessionSource.start();
    return api.getCurrentSession().then(function (payload) {
      var sessionId = payload && payload.sessionId ? payload.sessionId : null;
      if (sessionId) {
        state.sessionId = sessionId;
        persist(SESSION_STORAGE_KEY, sessionId);
      } else {
        state.sessionId = state.lastSessionId;
      }
      if (typeof api.setActiveSession === 'function' && state.sessionId) api.setActiveSession(state.sessionId);
      broadcast('session:changed', { sessionId: state.sessionId, previous: null });
      return loaders.loadGroups();
    }).then(function () {
      return loaders.loadTargetAndStats();
    });
  }

  function stop() {
    if (sessionSource) sessionSource.stop();
    document.removeEventListener('visibilitychange', persistence.handlePageExit);
    window.removeEventListener('pagehide', persistence.handlePageExit);
    persistence.flushWrites();
  }

  // 视图动作：只改 state + 广播，需要数据的交给 loaders
  function openView(view, groupId) {
    state.view = view || 'list';
    if (groupId) state.currentGroupId = groupId;
    broadcast('view:changed', { view: state.view, groupId: state.currentGroupId });
    if (state.view === 'chat' && state.currentGroupId) return loaders.loadChat(state.currentGroupId);
    // 加群页依赖平台清单：每次进入都重取（数据文件可能刚被改过），失败不阻断渲染
    if (state.view === 'add') return loaders.loadPlatforms().catch(function () { return state.platforms; });
    return Promise.resolve();
  }

  function switchTarget(target) {
    if (!state.sessionId) return Promise.resolve(null);
    return api.putSessionTarget(state.sessionId, target).then(function (nextTarget) {
      state.target = nextTarget || target;
      // 用户显式切换后，实际生效的就是它，来源标记为 explicit
      state.effectiveTarget = state.target;
      state.targetSource = 'explicit';
      broadcast('target:changed', { target: state.effectiveTarget });
      return loaders.loadChat(state.currentGroupId);
    }).then(function () {
      return loaders.loadStats();
    });
  }

  // 会话切换：null 表示「新会话草稿」（槽位 props.session === undefined），
  // 这时要把目标/速率清成 —、聊天清空，不能沿用上一个会话的值。
  // sessionTitle 来自宿主会话列表（槽位 props 的 useSessions），只用于面板「会话」行展示。
  function applySessionChanged(sessionId, sessionTitle) {
    var nextSessionId = typeof sessionId === 'string' && sessionId ? sessionId : null;
    var nextTitle = typeof sessionTitle === 'string' && sessionTitle ? sessionTitle : null;
    var previous = state.sessionId;
    var previousTitle = state.sessionTitle;
    if (nextSessionId === previous) {
      // 会话没变但标题可能后到（useSessions 异步就绪）——标题变了也要广播，否则「会话」行一直空着
      if (nextTitle === previousTitle) return Promise.resolve();
      state.sessionTitle = nextTitle;
      broadcast('session:changed', { sessionId: nextSessionId, previous: previous });
      return Promise.resolve();
    }
    state.sessionId = nextSessionId;
    state.sessionTitle = nextTitle;
    if (nextSessionId) {
      state.lastSessionId = nextSessionId;
      persist(SESSION_STORAGE_KEY, nextSessionId);
    }
    if (typeof api.setActiveSession === 'function') api.setActiveSession(nextSessionId);
    if (!nextSessionId) {
      state.target = null;
      state.effectiveTarget = null;
      state.targetSource = 'none';
      state.models = {};
      state.modelsStatus = {};
      state.messages = {};
      state.rate = RATE_PLACEHOLDER_TEXT;
    }
    broadcast('session:changed', { sessionId: nextSessionId, previous: previous });
    return loaders.loadTargetAndStats();
  }

  return {
    start: start,
    stop: stop,
    openView: openView,
    switchTarget: switchTarget,
    applySessionChanged: applySessionChanged
  };
}
// store-dispatch.js —— 动作分派表（视图只能通过它改状态，契约 docs/13 §3.5）。
// 这里只做"动作名 → 实现"的映射与参数整理，逻辑都在各自模块里；
// 分派表保持一行一个动作，新增动作时不会把别处的实现一起改乱。
//
// 表驱动而不是 switch/if 链：动作数继续增长时分支复杂度不再上涨，新增动作只加一行，
// 回滚也只删那一行。每个处理函数都返回 Promise（同步动作包成已决议的），调用方不必区分。

function createActionHandlers(deps) {
  var state = deps.state;
  var persist = deps.persist;
  var renderNow = deps.renderNow;
  var actions = deps.actions;      // { start, stop, applySessionChanged, loadGroups, ... }

  return {
    start: function () { return actions.start(); },
    // stop 是同步动作：包成已决议的 Promise，保证 dispatch 的返回类型对调用方一致
    stop: function () { actions.stop(); return Promise.resolve(); },
    'session-changed': function (action) { return actions.applySessionChanged(action.sessionId, action.sessionTitle); },
    'load-groups': function () { return actions.loadGroups(); },
    'load-chat': function (action) { return actions.loadChat(action.groupId); },
    'load-stats': function () { return actions.loadStats(); },
    'open-view': function (action) { return actions.openView(action.view, action.groupId); },
    'refresh-platforms': function () { return actions.loadPlatforms(); },
    'switch-target': function (action) { return actions.switchTarget(action.target); },
    'send-message': function (action) { return actions.sendMessage(action.text); },
    'toggle-row': function (action) {
      // 没带群 id 的点击落到当前打开的群（视图只负责传行号，来源判定留在这里）
      return actions.toggleRow(action.groupId || state.currentGroupId, action.rowIndex);
    },
    'set-anchor': function (action) {
      state.anchor = action.anchor;
      persist(ANCHOR_STORAGE_KEY, JSON.stringify(action.anchor));
      return Promise.resolve();
    },
    'view:rebuilt': function () { renderNow(); return Promise.resolve(); }
  };
}

function createDispatcher(deps) {
  var handlers = createActionHandlers(deps);

  function dispatch(action) {
    if (!action || typeof action.type !== 'string') return Promise.resolve();
    // hasOwnProperty 判定：避免 'toString' 这类原型键被当成动作名取到函数
    var handler = Object.prototype.hasOwnProperty.call(handlers, action.type) ? handlers[action.type] : null;
    return handler ? handler(action) : Promise.resolve();
  }

  return { dispatch: dispatch };
}
// store.js —— 唯一真相源（装配层）。
// 视图只能：读 getState()、subscribe(事件)、dispatch(action)；所有写入走 dispatch，渲染只由事件广播触发。
// 拆分后的职责边界（依赖全部通过参数注入，模块之间不共享第二份状态）：
//   store-state.js    初始 state 与事件/键常量
//   store-persist.js  持久化端口（去抖 150ms / 退出 flush / loadedOnce 凭证）
//   store-events.js   错误出口 + 事件总线（渲染只由广播触发）
//   store-loaders.js  数据加载（四个接口逐接口容错、群友加载状态）
//   store-session.js  会话生命周期与目标切换（start/stop/切会话/切目标）
//   store-dispatch.js 动作分派表

function createTeamStore(options) {
  var api = options.api;
  var storage = options.storage || { read: function () { return null; }, write: function () {} };
  var sessionSource = options.sessionSource || null;
  var onRender = options.onRender || function () {};

  var state = createInitialState();
  var errorSink = createErrorSink({ state: state });
  var hub = createEventHub({ state: state, reportError: errorSink.reportError, onRender: onRender });
  var persistence = createPersistencePort({ storage: storage, state: state, reportError: errorSink.reportError });

  // api.js 的失败上报通道（三类失败进 errors；/groups 的失败另存给 loaders 判定"加载失败"）
  var apiFailureSink = createApiFailureSink({ reportError: errorSink.reportError });

  // 三个 loader 工厂各自独立；stats 通过延迟引用拿 chat.loadChat（避免循环依赖）
  var baseDeps = { api: api, state: state, broadcast: hub.broadcast, reportError: errorSink.reportError };
  var chatLoadersRef = null;
  var loaders = Object.assign(
    {},
    createGroupLoaders(Object.assign({}, baseDeps, { apiFailureSink: apiFailureSink })),
    chatLoadersRef = createChatLoaders(baseDeps),
    createStatsLoaders(Object.assign({}, baseDeps, {
      loadChat: function (groupId) { return chatLoadersRef.loadChat(groupId); },
    })),
  );
  var session = createSessionAndTarget({
    api: api,
    state: state,
    broadcast: hub.broadcast,
    persist: persistence.persist,
    persistence: persistence,
    loaders: loaders,
    sessionSource: sessionSource
  });

  var dispatcher = createDispatcher({
    state: state,
    persist: persistence.persist,
    renderNow: hub.renderNow,
    actions: {
      start: session.start,
      stop: session.stop,
      applySessionChanged: session.applySessionChanged,
      openView: session.openView,
      switchTarget: session.switchTarget,
      loadGroups: loaders.loadGroups,
      loadPlatforms: loaders.loadPlatforms,
      loadChat: loaders.loadChat,
      loadStats: loaders.loadStats,
      sendMessage: loaders.sendMessage,
      toggleRow: loaders.toggleRow
    }
  });

  return {
    getState: function () { return state; },
    getErrors: function () { return state.errors.slice(); },
    subscribe: hub.subscribe,
    dispatch: dispatcher.dispatch,
    start: session.start,
    stop: session.stop,
    render: hub.renderNow,
    flush: persistence.flushWrites,
    // 对外错误出口：视图层发现"元素缺失 / 显示值为空"这类代码 bug 时调用（契约 §8）
    reportError: function (tag, message) { errorSink.reportError(tag, message); }
  };
}
// model-catalog.js —— 加群页的「模型目录」：状态操作（加行/删行/恢复默认）、
// 「获取可用模型」探测接线（POST /_team/models/probe）、错误文案映射。
// 目录只存在 viewState.modelCatalog（不进全局 store）：它是表单草稿，不是会话级真相。

// 探测失败文案：优先按后端 error.code 给固定措辞，hint 作为补充
const PROBE_ERROR_TEXT = {
  'probe-unauthorized': '凭证无效或缺失，请检查 API Key',
  'probe-not-found': '接口地址不对（找不到 /models）',
  'probe-timeout': '请求超时，检查网络或地址'
};

function probeErrorMessage(errorPayload) {
  const code = errorPayload && errorPayload.code ? errorPayload.code : '';
  const hint = errorPayload && errorPayload.hint ? errorPayload.hint : '';
  const baseText = PROBE_ERROR_TEXT[code] || '探测失败，请稍后重试';
  return hint ? baseText + '（' + hint + '）' : baseText;
}

function currentPlatformForForm() {
  const current = ensureState();
  const platformId = viewState.addForm.platformId;
  return (current.platforms || []).filter(function (platform) { return platform.id === platformId; })[0]
    || (current.platforms || [])[0] || null;
}

// 「获取可用模型」：POST /_team/models/probe，只读探测、不落盘、不写 localStorage
function probeModelCatalog() {
  if (viewState.modelCatalog.probe.loading) return;      // loading 中禁止重复点击
  const platform = currentPlatformForForm();
  const baseURL = String(viewState.addForm.values.baseURL || (platform && platform.baseURL) || '').trim();
  if (!baseURL) {
    viewState.modelCatalog.probe.error = '请先填写 API 地址再探测';
    rerender();
    return;
  }

  viewState.modelCatalog.probe = { loading: true, error: '' };
  rerender();

  api.probeModels({
    driverId: platform ? platform.driverId : undefined,
    baseURL: baseURL,
    modelsEndpoint: (platform && platform.modelsEndpoint) || '/models',
    apiKey: String(viewState.addForm.values.apiKey || '')
  }).then(function (result) {
    viewState.modelCatalog.probe = { loading: false, error: '' };
    if (!result || !Array.isArray(result.models)) {
      viewState.modelCatalog.probe.error = probeErrorMessage(result && result.error);
      rerender();
      return;
    }
    // 成功：用探测结果覆盖目录，但保留用户已经改过的同名显示名
    const previousNames = {};
    viewState.modelCatalog.models.forEach(function (model) {
      if (model.id && model.name) previousNames[model.id] = model.name;
    });
    viewState.modelCatalog.models = result.models.map(function (model) {
      return { id: model.id, name: previousNames[model.id] || model.name || '' };
    });
    viewState.modelCatalog.mode = 'manual';
    rerender();
  });
}

// 目录行操作：加行 / 删行 / 恢复默认
function addModelRow() {
  viewState.modelCatalog.mode = 'manual';
  viewState.modelCatalog.models.push({ id: '', name: '' });
  rerender();
}

function removeModelRow(index) {
  viewState.modelCatalog.models.splice(index, 1);
  if (!viewState.modelCatalog.models.length) viewState.modelCatalog.mode = 'auto';
  rerender();
}

function resetModelCatalog() {
  viewState.modelCatalog = { mode: 'auto', models: [], probe: { loading: false, error: '' } };
  rerender();
}

// 提交用：过滤掉 id 为空的行
function collectStaticModels() {
  return viewState.modelCatalog.models
    .map(function (model) { return { id: String(model.id || '').trim(), name: String(model.name || '').trim() }; })
    .filter(function (model) { return model.id; });
}
// session-bridge.js —— 把宿主当前会话 id 灌进工厂（契约 docs/13 §4.3 修订版：零轮询）。
// 宿主槽位组件直接持有 sessionId prop，切换会话时 React 重渲染组件，我们即时收到新 id；
// 服务端 SSE 与 URL 都拿不到这个信息，所以只有这条路。
// 兜底：槽位注册失败或宿主不提供 slots 时，启动后一次性拉 /_team/sessions/current（不轮询）。

// sessionId 为 null 也要透传：那是「新会话草稿」，工厂需要据此把目标/速率清成 —、聊天清空。
// sessionTitle 来自宿主会话列表（useSessions），只用于面板「会话」行展示，拿不到就传 null。
function pushSession(sessionId, sessionTitle) {
  if (!store) return;
  const nextSessionId = typeof sessionId === 'string' && sessionId ? sessionId : null;
  const nextTitle = typeof sessionTitle === 'string' && sessionTitle ? sessionTitle : null;
  store.dispatch({ type: 'session-changed', sessionId: nextSessionId, sessionTitle: nextTitle });
}

// 从宿主会话状态里取标题：兼容 useSessions() 返回 { byId } 或 { state: { byId } } 两种形状
// 会话标题的三种来源，按可靠性排：
//   ① 宿主列表 store（props.useSessions → byId[id].title）：形状随版本变，拿不到就退
//   ② document.title：宿主自己把「会话标题 — 产品名」写进标题栏（ui-layout 的 DocumentTitle），
//      切换会话即更新，是最稳的现成来源；用 " — " 切分并排除产品名
//   ③ 都拿不到 → null（面板只显示 sessionId 前 8 位）
function readDocumentSessionTitle() {
  if (typeof document === 'undefined') return null;
  const parts = String(document.title || '').split(' — ');
  if (parts.length < 2) return null;            // 没有「标题 — 产品名」结构：说明当前是产品名（无会话）
  const candidate = parts.slice(0, -1).join(' — ').trim();
  return candidate || null;
}

function readSessionTitle(props, sessionId) {
  if (!sessionId) return readDocumentSessionTitle();
  if (props && typeof props.useSessions === 'function') {
    try {
      const sessionsState = props.useSessions();
      const byId = sessionsState && (sessionsState.byId || (sessionsState.state && sessionsState.state.byId));
      const entry = byId && byId[sessionId];
      if (entry && typeof entry.title === 'string' && entry.title) return entry.title;
    } catch (error) {
      // 宿主 hook 形状变了不算致命：继续走 document.title 兜底
    }
  }
  return readDocumentSessionTitle();
}

// INV-14：判定"当前 session 是否选中本插件的虚拟模型"。
// 两个比对值都只能来自服务端 GET /_team/meta（契约 02 §3.8）：部署方可以改 config.virtualModel
// 与 options.providerIds，客户端写死任一侧，都会让球在该显示的部署上永远不显示。
// 判定收敛成纯函数（不读全局、不产生副作用），各种状态才能在单测里直接跑：
//   selection           宿主 projection(modelSelection) 的当前值，形如 { next, lastUsed }
//   meta                { virtualModel, providerIds } | { failed: true }（重试用尽仍不可用）| null（还没到）
//   projectionAvailable 宿主是否提供 useProjection（false = 连 selection 都取不到）
// 返回 'ours' | 'other' | 'unknown' | 'degraded'；**只有 'ours' 会显示**（显示口径在 dock.js）。
//   'degraded' 只保留给日志：它表示"判不了"，而判不了按契约就该隐藏，不再当可见用。
// 顺序即优先级：判不了（无 projection / meta 用尽）→ degraded/unknown；先 unknown（还没到）；最后才比对我们。
function evaluateDock(input) {
  var options = input || {};
  if (options.projectionAvailable === false) {
    return { decision: "degraded", reason: "reason=projection-unavailable" };
  }
  var selection = options.selection;
  var current = selection && (selection.next || selection.lastUsed);
  if (!current) return { decision: "unknown", reason: "reason=selection-empty" };

  var projectionLabel = String(current.model || current.provider || "unknown");
  var meta = options.meta;
  if (!meta) return { decision: "unknown", reason: "reason=meta-pending" };
  // 重试用尽仍拿不到 meta：判不了 → 隐藏（宁可少显示，也不把不属于本插件的入口摆给用户）
  if (meta.failed === true) return { decision: "degraded", reason: "reason=meta-unavailable" };

  var providerIds = Array.isArray(meta.providerIds) ? meta.providerIds : [];
  var isOurs = providerIds.indexOf(current.provider) >= 0 && current.model === meta.virtualModel;
  return {
    decision: isOurs ? "ours" : "other",
    reason: "projection=" + projectionLabel,
  };
}

// 兼容既有调用点：只要结论
function decideDock(input) {
  return evaluateDock(input).decision;
}

// 每次结论变化打一行（含理由），便于现场判断"为什么球不显示"；结论没变就不刷屏
var lastDockLogKey = null;
function reportDockDecision(result) {
  var logKey = result.decision + "|" + result.reason;
  if (logKey !== lastDockLogKey) {
    lastDockLogKey = logKey;
    try {
      console.info("[dock] " + result.decision + " ← " + result.reason);
    } catch (logError) { /* 没有 console 的环境不影响显隐 */ }
  }
  applyDockDecision(result.decision);
  return result.decision;
}

// meta 是异步拉的：到达时 React 不会因为 selection 没变而重渲染，所以显隐必须由这里主动重算下发。
// 只在"到达 / 失败"两个事件各触发一次，不做定时轮询（契约 02 §3.8：不重试、不轮询）。
var teamMetaState = { status: "loading", value: null };
var teamMetaRequestStarted = false;
// 桥最近一次的输入：重算要用同一份 selection，不能指望 React 再渲染一次
var latestDockInputs = { selection: undefined, projectionAvailable: true, hasBridge: false };

// 把 meta 状态归一成 decideDock 的入参（ready → 真值 / failed → 失败标记 / loading → null）
function currentMetaInput() {
  if (teamMetaState.status === "ready") return teamMetaState.value;
  if (teamMetaState.status === "failed") return { failed: true };
  return null;
}

// 桥每帧调用：记下最新输入并给出判定（纯计算，显隐由调用方的 effect 落地）
function rememberDockInputs(selection, projectionAvailable) {
  latestDockInputs = {
    selection: selection,
    projectionAvailable: projectionAvailable !== false,
    hasBridge: true
  };
  // 记输入 + 下发结论（含日志）：判定结论变化时球要立即响应，
  // 不能等宿主再渲染一次。注意这里只切球的显隐，不碰整个宿主容器（见 dock.js setDockVisibility）。
  return reportDockDecision(evaluateDock({
    selection: latestDockInputs.selection,
    meta: currentMetaInput(),
    projectionAvailable: latestDockInputs.projectionAvailable
  }));
}

// 重算入口：meta 到达 / 重试用尽时调一次。桥还没渲染过就没有输入可算，等它首帧自己算。
function recomputeDockDecision() {
  if (!latestDockInputs.hasBridge) return;
  reportDockDecision(evaluateDock({
    selection: latestDockInputs.selection,
    meta: currentMetaInput(),
    projectionAvailable: latestDockInputs.projectionAvailable
  }));
}

// 订阅 modelSelection 的变化（G-15 根因）。
// 为什么不能只靠渲染期取值：槽位组件什么时候重渲染由宿主决定，切模型时可能根本不重渲染，
// 于是 latestDockInputs.selection 一直是旧值 —— 表现为「切到别的模型球不消失」「切回来也不出现」。
// 宿主的 projection face 本身就是 observable（session.projections.faceOf(key)，
// ui-conversation 也是这么读的），订阅它就能在变化时立即重算，且不引入任何定时轮询。
// 返回退订函数；宿主没提供 face（旧版/结构变了）时返回 null，由调用方继续走渲染期取值。
function subscribeModelSelection({ session, key, onChange } = {}) {
  try {
    const projections = session && session.projections;
    const face = projections && typeof projections.faceOf === "function" ? projections.faceOf(key) : null;
    if (!face || typeof face.subscribe !== "function") return null;
    const emitSelection = function () {
      let nextSelection;
      try {
        nextSelection = typeof face.getSnapshot === "function" ? face.getSnapshot() : undefined;
      } catch (snapshotError) {
        warnOnce("projection(modelSelection) getSnapshot", snapshotError);
        nextSelection = undefined;
      }
      if (typeof onChange === "function") onChange(nextSelection);
    };

    const unsubscribe = face.subscribe(emitSelection);
    // 订阅成功后**立刻取一次快照**：projection 的值可能在订阅之前就已设定（恢复历史会话就是这样），
    // 之后不会再有变化事件；不补这一下，selection 会一直是 undefined → 判定 unknown → 球永久隐藏。
    emitSelection();
    return typeof unsubscribe === "function" ? unsubscribe : null;
  } catch (error) {
    // 订阅失败不算致命：退回渲染期取值（比现在不多也不少）
    warnOnce("subscribe(modelSelection)", error);
    return null;
  }
}

// meta 重试预算：首次失败后按这三档重试；三次都失败 = 判不了 → 隐藏。
// 为什么需要重试：启动时客户端常比插件路由先就绪，第一次请求打空是常态；
// 只试一次会让整个页面生命周期都停在"判不了"，表现为球常显（旧实现的缺陷）。
var TEAM_META_RETRY_DELAYS_MS = [500, 2000, 5000];

// 拉 meta（契约 02 §2.9）。字段不齐也算失败：apiJson 把非 2xx 与网络异常都吞成 null，
// 只能靠"字段齐不齐"判成败。schedule 可注入，单测里换成同步执行即可复现整条重试链。
function loadTeamMetaWithRetry(options) {
  var settings = options || {};
  if (teamMetaRequestStarted) return;
  teamMetaRequestStarted = true;
  var retryDelays = Array.isArray(settings.retryDelays) ? settings.retryDelays : TEAM_META_RETRY_DELAYS_MS;
  var schedule = typeof settings.schedule === "function"
    ? settings.schedule
    : function (run, delayMs) { return setTimeout(run, delayMs); };
  requestTeamMeta(retryDelays, schedule, 0);
}

function requestTeamMeta(retryDelays, schedule, attemptIndex) {
  if (typeof api === "undefined" || !api || typeof api.getMeta !== "function") {
    markTeamMetaUnavailable(attemptIndex);
    return;
  }
  Promise.resolve(api.getMeta()).then(function (payload) {
    if (payload && typeof payload.virtualModel === "string" && Array.isArray(payload.providerIds)) {
      teamMetaState = {
        status: "ready",
        value: { virtualModel: payload.virtualModel, providerIds: payload.providerIds }
      };
      recomputeDockDecision();
      return;
    }
    retryOrGiveUp(retryDelays, schedule, attemptIndex);
  }, function () {
    retryOrGiveUp(retryDelays, schedule, attemptIndex);
  });
}

// 还有预算就排队重试，没有就把状态钉成 failed（判定侧会转成 degraded → 隐藏）
function retryOrGiveUp(retryDelays, schedule, attemptIndex) {
  if (attemptIndex >= retryDelays.length) {
    markTeamMetaUnavailable(attemptIndex);
    return;
  }
  schedule(function () {
    requestTeamMeta(retryDelays, schedule, attemptIndex + 1);
  }, retryDelays[attemptIndex]);
}

function markTeamMetaUnavailable(attemptIndex) {
  teamMetaState = { status: "failed", value: null };
  warnOnce("INV-14 判定隐藏：GET /_team/meta 连续 " + (attemptIndex + 1) + " 次不可用", null);
  recomputeDockDecision();
}

// 槽位桥组件：不渲染任何 DOM，只把当前会话 id（与标题）的变化灌进工厂，
// 并顺带把 INV-14 的显隐结论推给 dock（挂载生命周期不变，只切 display）。
// 槽位是 conversation.input.dock，props 形如 { session, input, useSessions, useProjection }；
// session 为 undefined 表示"新会话草稿"，这时按 null 处理。
function createSessionBridgeComponent(reactRuntime) {
  return function SessionBridge(props) {
    const sessionId = (props && props.session && props.session.sessionId) || (props && props.sessionId) || null;
    const sessionTitle = readSessionTitle(props, sessionId);

    // 旧版宿主没有 useProjection：降级为"显示"（不比现状差），只警告一次
    const hasProjection = Boolean(props && typeof props.useProjection === "function");
    if (!hasProjection) {
      warnOnce('宿主未提供 useProjection，INV-14 降级为常显', null);
    }
    let selection;
    if (hasProjection) {
      try {
        selection = props.useProjection(MODEL_SELECTION_PROJECTION_KEY);
      } catch (error) {
        // 宿主 hook 形状变了不算致命：按"还没有值"处理（不显示），告警一次
        warnOnce('useProjection(modelSelection)', error);
      }
    }
    // 记下本次输入并判定：meta 迟到时用同一份输入重算，不依赖 React 再渲染一次
    const selectionState = rememberDockInputs(selection, hasProjection);

    reactRuntime.useEffect(function () {
      pushSession(sessionId, sessionTitle);
    }, [sessionId, sessionTitle]);

    // 响应式路径一（渲染驱动）：宿主重渲染时重新取值并下发
    reactRuntime.useEffect(function () {
      reportDockDecision(evaluateDock({
        selection: selection,
        meta: currentMetaInput(),
        projectionAvailable: hasProjection
      }));
    }, [selectionState]);

    // 挂载即下发一次：渲染期 props.useProjection 已经有值（恢复历史会话）时，
    // 不能等"下一次变化"——那时可能永远不来。只在挂载与换会话时执行。
    reactRuntime.useEffect(function () {
      reportDockDecision(evaluateDock({
        selection: selection,
        meta: currentMetaInput(),
        projectionAvailable: hasProjection
      }));
    }, [sessionId]);

    // 响应式路径二（订阅驱动，G-15）：宿主不重渲染时也能感知 modelSelection 变化。
    // 依赖 sessionId：切会话要重新订阅新 session 的 projection face；同一会话内不重复订阅。
    reactRuntime.useEffect(function () {
      const unsubscribe = subscribeModelSelection({
        session: props && props.session,
        key: MODEL_SELECTION_PROJECTION_KEY,
        onChange: function (nextSelection) {
          // 新值到达：先记输入（meta 迟到的重算要用最新值），再立即下发，不等 React 再渲染一次
          applyDockDecision(rememberDockInputs(nextSelection, true));
        }
      });
      return function () {
        if (typeof unsubscribe === "function") unsubscribe();
      };
    }, [sessionId]);

    return null;
  };
}

// 兜底（仅在槽位不可用时调用）：启动后拉一次，绝不 setInterval
function fetchSessionOnce() {
  if (typeof api === 'undefined' || !api || typeof api.getCurrentSession !== 'function') return;
  api.getCurrentSession().then(function (payload) {
    // 一次性兜底没有 useSessions，标题拿不到 → 面板「会话」行只显示 id 前 8 位
    if (payload && payload.sessionId) pushSession(payload.sessionId, null);
  });
}
// dock-state.js —— 悬浮件（球 + 面板）的 UI 状态单一真相源。
//
// 为什么要它：显隐与位置原本散在三处（dock.js 的 lastDockDecision、float.js 的 DOM 读写、
// store 里的一份 anchor），任何一处不同步就会出现「判定说隐藏、界面还亮着」「拖出去再刷新跳回固定位置」。
// 这里按 ModelStage 的 ui-state 契约收敛：
//   R1 单一真相源：显示值只有一个来源（本模块），控件不留显示副本；
//   R2 读回早于首次渲染：模块加载时就把持久化值读进内存，早于任何 DOM 构建；
//   R3 apply 与 render 分离：setXxx 只改值 + 通知；真正写 DOM 由装配方注册的 applier 落地（幂等可重放）。
// 依赖方向单向：本模块**不 import** float.js / dock.js / session-bridge.js，谁要写 DOM 谁自己注册。

// 新的持久化键；旧键（dsh-model-team:anchor）由 store-persist 写过，加载时迁移并删除
var DOCK_STATE_STORAGE_KEY = 'dsh-model-team:dock-state-v2';
var LEGACY_ANCHOR_STORAGE_KEY = 'dsh-model-team:anchor';

// 形态：ball=只有球；panel=面板展开（面板位置由锚点 + 方向算出，不单独持久化）
var DOCK_SHAPES = { BALL: 'ball', PANEL: 'panel' };

var dockState = {
  visible: false,          // 球是否显示（INV-14 判定的唯一落点）
  anchor: null,            // 收起态锚点（球左上角）{left, top}；null = 还没定过位（用默认右下角）
  shape: DOCK_SHAPES.BALL, // 当前形态，决定按谁的尺寸夹取
  // 展开方向：锚点中心相对视口中心决定象限。文本侧与面板展开方向都由它推出来，
  // 拖动松手/窗口 resize 后必须重算（用户可能拖到另一半屏再展开）。
  openDir: (typeof window === 'undefined') ? 'down-left' : 'down-left',
};

var dockStateListeners = [];
var dockAppliers = { visibility: null, anchor: null };

function cloneDockAnchor(anchor) {
  if (!anchor || typeof anchor.left !== 'number' || typeof anchor.top !== 'number') return null;
  return { left: anchor.left, top: anchor.top };
}

function getDockState() {
  return {
    visible: dockState.visible,
    anchor: cloneDockAnchor(dockState.anchor),
    shape: dockState.shape,
    openDir: dockState.openDir,
  };
}

// 立即回调一次当前值：订阅者不该为了"拿首帧值"再写一套读取逻辑（R2）
function subscribeDockState(listener) {
  if (typeof listener !== 'function') return function () {};
  dockStateListeners.push(listener);
  try { listener(getDockState()); } catch (error) { /* 订阅者自身异常不能打断别人 */ }
  return function unsubscribe() {
    var index = dockStateListeners.indexOf(listener);
    if (index >= 0) dockStateListeners.splice(index, 1);
  };
}

function notifyDockState() {
  var snapshot = getDockState();
  dockStateListeners.slice().forEach(function (listener) {
    try { listener(snapshot); } catch (error) { /* 同上 */ }
  });
}

// 装配方注册 DOM 落地函数（浮动球显隐 / 位置）；重复注册以最后一次为准，便于宿主重建 DOM 后重挂
function registerDockAppliers(appliers) {
  var next = appliers || {};
  if (typeof next.visibility === 'function') dockAppliers.visibility = next.visibility;
  if (typeof next.anchor === 'function') dockAppliers.anchor = next.anchor;
  reapplyDockDom();
}

// 按当前值重画已存在的 DOM（幂等、可重放）：DOM 重建后调它就能补齐显示态
function reapplyDockDom() {
  var snapshot = getDockState();
  if (dockAppliers.visibility) {
    try { dockAppliers.visibility(snapshot.visible); } catch (error) { /* 落地失败不影响状态 */ }
  }
  if (dockAppliers.anchor) {
    try { dockAppliers.anchor(snapshot.anchor, snapshot.shape, snapshot.openDir); } catch (error) { /* 同上 */ }
  }
}

function setDockVisible(visible) {
  var nextVisible = visible === true;
  if (dockState.visible === nextVisible) {
    reapplyDockDom();   // 值没变也要重放一次：DOM 可能刚被重建过
    return;
  }
  dockState.visible = nextVisible;
  reapplyDockDom();
  notifyDockState();
}

// 展开方向变化也要重画（文本换到球的另一侧、面板换方向），但不落盘：位置真相只有锚点
function setDockOpenDir(openDir) {
  var nextDir = String(openDir || '').trim();
  if (!/^(up|down)-(left|right)$/.test(nextDir)) return;
  if (dockState.openDir === nextDir) return;
  dockState.openDir = nextDir;
  reapplyDockDom();
  notifyDockState();
}

function setDockShape(shape) {
  var nextShape = shape === DOCK_SHAPES.PANEL ? DOCK_SHAPES.PANEL : DOCK_SHAPES.BALL;
  if (dockState.shape === nextShape) return;
  dockState.shape = nextShape;
  reapplyDockDom();
  notifyDockState();
}

// 位置只存锚点（球的左上角）；面板位置由锚点 + 展开方向算出来，不落盘
function setDockAnchor(anchor) {
  var nextAnchor = cloneDockAnchor(anchor);
  if (nextAnchor) {
    nextAnchor.left = Math.round(nextAnchor.left);
    nextAnchor.top = Math.round(nextAnchor.top);
  }
  var previous = dockState.anchor;
  var unchanged = (previous === null && nextAnchor === null)
    || (previous && nextAnchor && previous.left === nextAnchor.left && previous.top === nextAnchor.top);
  if (unchanged) return;
  dockState.anchor = nextAnchor;
  persistDockState();
  reapplyDockDom();
  notifyDockState();
}

// ---------------------------------------------------------------- 持久化（R2：加载即读）

function readStorage(storage) {
  try { return storage && typeof storage.getItem === 'function' ? storage : null; } catch (error) { return null; }
}

function parseAnchor(rawValue) {
  if (!rawValue) return null;
  try {
    var parsed = JSON.parse(rawValue);
    if (parsed && typeof parsed.left === 'number' && typeof parsed.top === 'number') {
      return { left: parsed.left, top: parsed.top };
    }
  } catch (error) { /* 脏数据当没有 */ }
  return null;
}

function loadDockStateFromStorage(storage) {
  var target = readStorage(storage);
  if (!target) return;
  var stored = null;
  try { stored = target.getItem(DOCK_STATE_STORAGE_KEY); } catch (error) { stored = null; }
  if (stored) {
    var parsedState = null;
    try { parsedState = JSON.parse(stored); } catch (error) { parsedState = null; }
    if (parsedState && parsedState.anchor) {
      dockState.anchor = cloneDockAnchor(parsedState.anchor);
    }
    // 只有锚点会持久化：显隐与形态是运行时事实，不该跨会话恢复
    return;
  }
  // 迁移旧键：读出来 → 写进新键 → 删旧键（避免两份真相并存）
  var legacyRaw = null;
  try { legacyRaw = target.getItem(LEGACY_ANCHOR_STORAGE_KEY); } catch (error) { legacyRaw = null; }
  var legacyAnchor = parseAnchor(legacyRaw);
  if (!legacyAnchor) return;
  dockState.anchor = legacyAnchor;
  persistDockState(target);
  try { target.removeItem(LEGACY_ANCHOR_STORAGE_KEY); } catch (error) { /* 删不掉也不影响值 */ }
}

function persistDockState(storage) {
  var target = readStorage(storage) || readStorage(typeof window === 'undefined' ? null : window.localStorage);
  if (!target) return;
  try {
    target.setItem(DOCK_STATE_STORAGE_KEY, JSON.stringify({ anchor: dockState.anchor }));
  } catch (error) { /* 存储不可用（隐私模式/配额）时装不了不影响运行 */ }
}

// R2：模块一加载就把值读回内存，早于任何 DOM 构建
if (typeof window !== 'undefined' && window.localStorage) {
  loadDockStateFromStorage(window.localStorage);
}

// 预览/自检通道：真渲染门禁需要能"先让球可见再点它"（预览垫片没有宿主 projection）。
// 只暴露状态工厂本身，不提供任何伪造判定结果的入口。
if (typeof window !== 'undefined') {
  window.__DMT_DOCK__ = {
    getDockState: getDockState,
    subscribeDockState: subscribeDockState,
    setDockVisible: setDockVisible,
    setDockAnchor: setDockAnchor,
    setDockShape: setDockShape,
    setDockOpenDir: setDockOpenDir,
    reapplyDockDom: reapplyDockDom,
    registerDockAppliers: registerDockAppliers,
  };
}
// render.js —— 纯渲染层：把数据变成 DOM 字符串，不读写全局状态、不绑事件。
// 所有插值过 escapeHtml()，防止数据里的尖括号破坏结构；请求行的 title 直接用后端给的 row.title。

const STATUS_OK_MIN = 200;          // 2xx 视为成功
const STATUS_OK_MAX = 299;
const STATUS_RATE_LIMITED = 429;    // 限流，单独用一种颜色

// HTML 转义，属性值与文本节点共用
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 状态码 → 颜色语义
function statusClass(status) {
  if (status >= STATUS_OK_MIN && status <= STATUS_OK_MAX) return 'st-ok';
  if (status === STATUS_RATE_LIMITED) return 'st-warn';
  return 'st-err';
}

// 单条请求记录气泡：折叠时单行摘要，展开时补明细（account 只出现在 title 里）
// platform：本次真正接活的平台 { avatar, name }（分组轮换时必须能看出是谁响应的）
function requestRow(row, index, isExpanded, platform) {
  const platformAvatar = platform ? platform.avatar : '[G]';
  const platformName = platform ? platform.name : '';
  const modelName = String(row.model || '').replace(/^global:/, '');
  const detailHtml = isExpanded
    ? `<div class="req-detail">
         <span class="k">状态</span><span class="v">${escapeHtml(row.status)} ${escapeHtml(row.statusText)}</span>
         <span class="k">模型</span><span class="v">${escapeHtml(row.model)}</span>
         <span class="k">来源 IP</span><span class="v">${escapeHtml(row.ip)}</span>
         <span class="k">User-Agent</span><span class="v">${escapeHtml(row.ua)}</span>
         <span class="k">耗时</span><span class="v">${escapeHtml(row.latency)}</span>
         <span class="k">token</span><span class="v">${escapeHtml(row.tokens)}</span>
         <span class="k">credit</span><span class="v">${escapeHtml(row.credit)}</span>
         <span class="k">命中率</span><span class="v">${escapeHtml(row.cacheHit)}</span>
         <span class="k">req-id</span><span class="v">${escapeHtml(row.requestId)}</span>
       </div>`
    : '';

  return `<div class="msg msg-left">
    <span class="avatar" data-mention="${escapeHtml(modelName)}" title="点击插入 @${escapeHtml(modelName)}">${renderAvatar(platformAvatar, platformName || modelName)}</span>
    <div class="bubble req-bubble${isExpanded ? ' expanded' : ''}" data-row-index="${index}"
         tabindex="0" role="button" aria-expanded="${isExpanded ? 'true' : 'false'}"
         title="${escapeHtml(row.title)}">
      <div class="req-head">
        <span class="req-model">${escapeHtml(modelName)}</span>
        ${renderTargetSourceBadge(row.targetSource)}
        <span class="req-time">${escapeHtml(row.time)}</span>
        <span class="req-caret" aria-hidden="true"></span>
      </div>
      <div class="req-meta">
        <span class="st ${statusClass(row.status)}">${escapeHtml(row.status)} ${escapeHtml(row.statusText)}</span>
        <span>${escapeHtml(row.latency)}</span><span class="sep">·</span>
        <span>${escapeHtml(row.tokens)} tok</span><span class="sep">·</span>
        <span>${escapeHtml(row.credit)} credit</span><span class="sep">·</span>
        <span>命中 ${escapeHtml(row.cacheHit)}</span>
      </div>
      ${platformName ? `<div class="req-served">本次请求由 ${escapeHtml(platformAvatar)} ${escapeHtml(platformName)}(${escapeHtml(modelName)}) 响应</div>` : ''}
      ${detailHtml}
    </div>
  </div>`;
}

// 球内标记 / 窗口格式化这类跨视图口径搬到 ui-format.js（render.js 保持只做本视图的骨架）。

// 群列表时间：当天 HH:mm、昨天显示「昨天」、更早 MM-DD；lastUpdated 缺失/非法 → 空
function formatGroupTime(isoText) {
  if (!isoText) return '';
  const when = new Date(isoText);
  if (isNaN(when.getTime())) return '';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const stamp = when.getTime();
  if (stamp >= startOfToday) {
    const hours = String(when.getHours()).padStart(2, '0');
    const minutes = String(when.getMinutes()).padStart(2, '0');
    return hours + ':' + minutes;
  }
  if (stamp >= startOfYesterday) return '昨天';
  const month = String(when.getMonth() + 1).padStart(2, '0');
  const day = String(when.getDate()).padStart(2, '0');
  return month + '-' + day;
}

// 头像渲染：http(s) / data: URL 用 <img>，其余按文本占位（空则用名称首字母）。
// 图片 404 等加载失败由 app.js 的全局 error 捕获降级为文本，不会留下破图。
function renderAvatar(avatarText, fallbackName) {
  const rawValue = String(avatarText == null ? '' : avatarText).trim();
  const isImageUrl = /^https?:\/\//i.test(rawValue) || /^data:/i.test(rawValue);
  const initial = String(fallbackName == null ? '' : fallbackName).trim().charAt(0).toUpperCase() || '?';
  if (isImageUrl) {
    return `<img class="avatar-img" src="${escapeHtml(rawValue)}" alt="" loading="lazy" data-fallback="${escapeHtml(initial)}">`;
  }
  return escapeHtml(rawValue || initial);
}

// 视图一：群列表（= 平台账号列表）：顶部搜索 + 加群入口，每项右侧 lastUpdated 本地化时间。
// options.loadError：群接口最近一次失败原因。空列表 + 有失败原因 → 显示"加载失败 + 重试"，
// 不能渲染成「0 个群」——那会把"加载失败"伪装成"确实没有数据"，用户没法判断该重试还是该加群。
function renderGroupList(groups, currentGroupId, filterText, options) {
  const loadError = options && options.loadError ? String(options.loadError) : '';
  const itemsHtml = groups.map(function (group) {
    const timeText = formatGroupTime(group.lastUpdated);
    return `<li class="group-item${group.id === currentGroupId ? ' active' : ''}" data-group-id="${escapeHtml(group.id)}" tabindex="0">
      <span class="avatar">${renderAvatar(group.avatar, group.name)}</span>
      <div class="group-main">
        <div class="group-line"><span class="group-name">${escapeHtml(group.name)}</span></div>
        <div class="group-summary">${escapeHtml(group.summary)}</div>
      </div>
      <div class="group-right">
        ${timeText ? `<span class="group-time">${escapeHtml(timeText)}</span>` : ''}
        <span class="group-driver">${escapeHtml(group.driver)}</span>
      </div>
    </li>`;
  }).join('');

  const isLoadFailure = groups.length === 0 && loadError !== '';
  const countHtml = isLoadFailure
    ? '<span class="list-count list-count-error">加载失败</span>'
    : `<span class="list-count">${groups.length} 个群 · 每个群 = 一个平台账号</span>`;
  const listHtml = isLoadFailure
    ? `<div class="list-error" role="alert">
         <div class="list-error-title">群列表加载失败</div>
         <div class="list-error-detail">${escapeHtml(loadError)}</div>
         <button class="btn-retry" id="btnReloadGroups" type="button">点此重试</button>
       </div>`
    : `<ul class="group-list" id="groupList">${itemsHtml}</ul>`;

  return `<section class="view view-list">
    <div class="list-head">
      <h2>消息</h2>
      <input class="group-search" id="groupSearch" type="search" autocomplete="off"
             placeholder="🔍 搜索群聊 (账号)" value="${escapeHtml(filterText || '')}">
      ${countHtml}
      <button class="btn-add" id="btnAddGroup" type="button">＋ 加群</button>
    </div>
    ${listHtml}
  </section>`;
}

// 视图二：群聊（sys 系统提示 / row 请求记录 / mine 我发出的 @）
// platform：当前群对应的平台信息，用于把请求行标成「[W] WorkBuddy(model)」
// modelsStatus：该群模型清单的加载状态（'loading' | 'loaded' | 'error'）。
// 为什么必须传进来：models 缺省是 []，"还没拉到"与"确实 0 个群友"取值一样，
// 只按长度渲染就会把"未知"显示成 0（G-13 同类问题）。缺省按 loaded 处理，兼容既有调用方。
function renderChat(group, models, messages, platform, modelsStatus) {
  const streamHtml = messages.map(function (message) {
    const timeHtml = message.time ? `<span class="msg-time">${escapeHtml(message.time)}</span>` : '';
    if (message.type === 'sys') {
      return `<div class="msg msg-sys"><span class="sys-tip">[系统] ${escapeHtml(message.text)}</span>${timeHtml}</div>`;
    }
    if (message.type === 'row') return requestRow(message.row, message.rowIndex, Boolean(message.expanded), platform);
    const bodyHtml = escapeHtml(message.text).replace(/(@[^\s<]+)/g, '<span class="mention-inline">$1</span>');
    return `<div class="msg msg-right">
      <span class="avatar round">[我]</span>
      <div class="bubble">${bodyHtml}${timeHtml}</div>
    </div>`;
  }).join('');

  return `<section class="view view-chat">
    <header class="view-head chat-head">
      <button class="btn-back" id="btnChatBack" type="button">&lt; 返回</button>
      <span class="head-title">${escapeHtml(group.name)}</span>
      <span class="group-tag">[群友: ${modelsStatus === undefined || modelsStatus === 'loaded' ? models.length : '—'}]</span>
      <span class="head-sub">群友 = 模型 · 消息 = 请求记录</span>
    </header>
    <div class="chat-stream" id="chatStream">${streamHtml}</div>
    <footer class="chat-input">
      <button class="btn-at" id="btnAt" type="button" title="选择群友或分组">@</button>
      <textarea id="msgInput" rows="1" autocomplete="off"
                placeholder="@ 选择群友或分组…"></textarea>
      <button class="btn-send" id="btnSend" type="button">发送</button>
      <div class="at-pop hidden" id="atPop">
        <div class="at-pop-title">选择群友（单模型）或好友分组（轮换组）—— 发送后切换当前目标</div>
        <div id="atList"></div>
      </div>
    </footer>
  </section>`;
}

// 选择器分组标题（本群群友 / 我的好友分组）
function renderAtSection(title) {
  return `<div class="at-section">${escapeHtml(title)}</div>`;
}

// @ 选择器：单个模型项（本群群友）；display 带来源平台，label 是纯模型名
// 窗口来自 models.static[].contextLength 或探测结果（docs/07 §二点六），未知显示 — 而不是省略
function renderAtModelItem(item, index) {
  return `<div class="at-item" data-at-type="model" data-at-id="${escapeHtml(item.id)}" data-index="${index}">
    <span class="avatar at-avatar">${escapeHtml(item.avatar || '[M]')}</span>
    <span class="at-model">${escapeHtml(item.display || item.label)}</span>
    <span class="at-tag">窗口 ${escapeHtml(formatContextLength(item.contextLength))}</span>
  </div>`;
}

// @ 选择器：单个分组项（跨平台轮换组）
function renderAtGroupItem(item, index) {
  return `<div class="at-item" data-at-type="group" data-at-id="${escapeHtml(item.id)}" data-index="${index}">
    <span class="avatar at-avatar at-avatar-group">👥</span>
    <span class="at-model">${escapeHtml(item.label)}</span>
    <span class="at-tag">(${item.memberCount}个平台成员)</span>
  </div>`;
}

// 视图五：通讯录（好友分组管理）
const STRATEGY_LABELS = { 'round-robin': '轮询', fallback: '故障转移' };

// 只吃「好友分组 + 平台群」两份数据：成员行原来还要 drivers，是为了按驱动取头像，
// 而 platformId 指的是群——留着这个参数等于鼓励下一个人再按驱动查一次，所以直接去掉。
function renderAddressBook(friendGroups, groups) {
  // 成员的 platformId 存的是**群 id**（契约 §3.5 的 agnes 就是群 id），不是驱动 id：
  // 头像与"来自谁"都必须按群取，拿它去查 driverById 永远查不到（旧实现就这么渲染出 [?]）。
  const groupById = {};
  groups.forEach(function (group) { groupById[group.id] = group; });

  const itemsHtml = friendGroups.map(function (friendGroup) {
    const isFallback = friendGroup.strategy === 'fallback';
    const membersHtml = friendGroup.members.map(function (member, memberIndex) {
      const memberGroup = groupById[member.platformId];
      // 平台显示名取群名；群被删掉时回落成 platformId，让人看得出这个成员指向哪儿
      const platformName = memberGroup && memberGroup.name ? memberGroup.name : member.platformId;
      const branch = memberIndex === friendGroup.members.length - 1 ? '└─' : '├─';
      // fallback 组按数组顺序标主/备：第一个是主，其余是备
      let roleTag = '';
      if (isFallback) roleTag = memberIndex === 0 ? '<span class="contact-role contact-role-main">[主]</span>' : '<span class="contact-role">[备]</span>';
      return `<div class="contact-member">
        <span class="contact-branch">${branch}</span>
        <span class="avatar">${renderAvatar(memberGroup && memberGroup.avatar, platformName)}</span>
        <span class="contact-member-model">${escapeHtml(member.modelId)}</span>
        <span class="contact-member-from">(来自 ${escapeHtml(platformName)})</span>
        ${roleTag}
      </div>`;
    }).join('');
    return `<div class="contact-row">
      <div class="contact-head">
        <span class="avatar at-avatar-group">👥</span>
        <span class="contact-name">${escapeHtml(friendGroup.name)}</span>
        <span class="contact-strategy">(${escapeHtml(STRATEGY_LABELS[friendGroup.strategy] || friendGroup.strategy)})</span>
        <button class="contact-edit" type="button" data-edit-group="${escapeHtml(friendGroup.id)}">[ 编辑 ]</button>
      </div>
      <div class="contact-members">${membersHtml}</div>
    </div>`;
  }).join('');

  return `<section class="view view-contacts">
    <header class="view-head">
      <button class="btn-back" id="btnContactsBack" type="button">&lt; 返回</button>
      <span class="head-title">通讯录 - 好友分组管理</span>
    </header>
    <div class="contacts-body">
      <div class="contacts-label">我的分组：</div>
      <div class="contact-list">${itemsHtml || '<div class="contacts-empty">还没有分组</div>'}</div>
    </div>
    <div class="contacts-foot">
      <button class="btn-primary" id="btnCreateGroup" type="button">[ + 新建分组 ]</button>
    </div>
  </section>`;
}

// 条件显示：字段声明里的 showWhen 指到某个依赖字段的取值，取到才出现（如 manual 才显示手填模型）
function isFieldVisible(field, savedValues) {
  if (!field.showWhen) return true;
  return savedValues && savedValues[field.showWhen.key] === field.showWhen.value;
}

// 单个控件：text / password / textarea / select 四种形态
function renderFieldControl(field, savedValue) {
  if (field.type === 'textarea') {
    return `<textarea data-auth-key="${escapeHtml(field.key)}" placeholder="${escapeHtml(field.placeholder || '')}">${escapeHtml(savedValue)}</textarea>`;
  }
  if (field.type === 'select') {
    const optionsHtml = (field.options || []).map(function (option) {
      const selected = option.value === savedValue ? ' selected' : '';
      return `<option value="${escapeHtml(option.value)}"${selected}>${escapeHtml(option.label)}</option>`;
    }).join('');
    return `<select class="field-select" data-auth-key="${escapeHtml(field.key)}">${optionsHtml}</select>`;
  }
  return `<input type="${field.type === 'password' ? 'password' : 'text'}" data-auth-key="${escapeHtml(field.key)}"
            placeholder="${escapeHtml(field.placeholder || '')}" value="${escapeHtml(savedValue)}">`;
}

// 第二步表单字段：完全由 driver.authSchema 驱动，未满足 showWhen 的字段不渲染
function renderAuthFields(driver, savedValues) {
  if (!driver) return '';
  return driver.authSchema.filter(function (field) {
    return isFieldVisible(field, savedValues);
  }).map(function (field) {
    const savedValue = savedValues && savedValues[field.key]
      ? savedValues[field.key]
      : (field.type === 'select' && field.options && field.options.length ? field.options[0].value : '');
    return `<div class="field">
      <label class="field-label">${escapeHtml(field.label)}${field.required ? '<span class="req-mark">*</span>' : ''}</label>
      ${renderFieldControl(field, savedValue)}
    </div>`;
  }).join('');
}

// 平台下拉：选项来自后端预置的平台列表（显示平台名），前端不写死任何平台
// 平台选择的选项来源有两类：
//   ① 平台预置（config/platforms.json）：value = preset:<id>，带 baseURL/头像/摘要模板
//   ② 未被任何预置覆盖的驱动：value = driver:<driverId>，即"通用入口"（如 OpenAI 兼容（配置型））
// 只列预置会让用户以为"只能选已知平台"，所以两者都要出现。
function renderPlatformOptions(platforms, drivers, selectedValue) {
  const presetOptions = (platforms || []).map(function (platform) {
    const value = 'preset:' + platform.id;
    const selected = value === selectedValue ? ' selected' : '';
    return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(platform.name)}</option>`;
  }).join('');

  // 驱动始终全部列出：预置只是"某平台的一组默认值"，而"通用入口"（不绑平台）必须随时可选，
  // 否则用户只能选已知平台，无法接入别人家的 OpenAI 兼容服务。
  const driverOptions = (drivers || []).map(function (driver) {
    const value = 'driver:' + driver.id;
    const selected = value === selectedValue ? ' selected' : '';
    return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(driver.name)}</option>`;
  }).join('');

  return presetOptions + driverOptions;
}

// 选择值有两种形态，先归一成 { kind, id }：driver:<id> 走通用入口，preset:<id> 走平台预置；
// 没写前缀的历史值按 preset 处理（旧数据回落规则，不能因为多一层解析就变）。
function parsePlatformSelectionValue(selectedValue) {
  const rawValue = typeof selectedValue === 'string' ? selectedValue : '';
  if (rawValue.indexOf('driver:') === 0) {
    return { kind: 'driver', id: rawValue.slice('driver:'.length) };
  }
  if (rawValue.indexOf('preset:') === 0) {
    return { kind: 'preset', id: rawValue.slice('preset:'.length) };
  }
  return { kind: 'preset', id: rawValue };
}

// 候选两项都走同一个查找：按 id 命中优先，命中不了回落清单第一项（保证表单永远有可提交对象）
function findListEntry(items, id) {
  return (items || []).filter(function (item) { return item.id === id; })[0] || null;
}

function pickFirstEntry(items) {
  return (items && items[0]) || null;
}

// 预置平台 → 它的驱动：平台缺 driverId 或驱动清单里没有时回落第一个驱动
function pickDriverForPlatform(drivers, platform) {
  if (!platform) return pickFirstEntry(drivers);
  return findListEntry(drivers, platform.driverId) || pickFirstEntry(drivers);
}

// 解析平台选择值：preset:<id> → 预置对象；driver:<id> → 驱动对象（无预置）
function resolvePlatformSelection(platforms, drivers, selectedValue) {
  const selection = parsePlatformSelectionValue(selectedValue);
  // 通用入口：只有驱动，没有平台预置；找不到驱动就是 null（这里刻意不回落到第一个驱动，
  // 否则"选了不存在的驱动"会静默变成"用第一个驱动"，写配置时才发现用错驱动）
  if (selection.kind === 'driver') {
    return { platform: null, driver: findListEntry(drivers, selection.id), driverId: selection.id };
  }

  const platform = findListEntry(platforms, selection.id) || pickFirstEntry(platforms);
  const driver = pickDriverForPlatform(drivers, platform);
  return { platform: platform, driver: driver, driverId: platform ? platform.driverId : (driver ? driver.id : '') };
}

// 模型目录（第三段）：行内 id/name 两个输入 + 删除；mode=auto 时提交走 models.endpoint
function renderModelCatalog(catalog) {
  const models = (catalog && catalog.models) || [];
  const probeState = (catalog && catalog.probe) || {};
  const mode = catalog && catalog.mode === 'manual' ? 'manual' : 'auto';

  const rows = models.map(function (model, index) {
    return `<div class="model-row" data-model-index="${index}">
      <input type="text" data-model-id="${index}" value="${escapeHtml(model.id || '')}" placeholder="例如 agnes-3.0-flash">
      <input type="text" data-model-name="${index}" value="${escapeHtml(model.name || '')}" placeholder="可空，默认用 id">
      <button type="button" class="model-remove" data-model-remove="${index}" title="删除这一行">×</button>
    </div>`;
  }).join('');

  const modeText = mode === 'auto'
    ? '自动拉取（提交时写 models.endpoint = /models，由网关按接口发现）'
    : '手动目录（提交时写 models.static，共 ' + models.length + ' 行，id 为空的行会被忽略）';
  const probeButtonText = probeState.loading ? '探测中…' : '获取可用模型';

  return `<div class="form-step">
    <div class="form-step-title">
      <span class="step-no">3</span>模型目录
      <span class="step-actions">
        <button type="button" class="btn-ghost" id="btnProbeModels"${probeState.loading ? ' disabled' : ''}>${probeButtonText}</button>
        <button type="button" class="btn-ghost" id="btnResetModels">恢复默认模型</button>
      </span>
    </div>
    <div class="model-mode" id="modelMode">${escapeHtml(modeText)}</div>
    <div class="model-table">
      <div class="model-row model-row-head"><span>模型 id（必填）</span><span>显示名（可空=用 id）</span><span>删除</span></div>
      ${rows}
    </div>
    <button type="button" class="btn-ghost" id="btnAddModelRow">＋ 添加模型</button>
    <div class="probe-feedback${probeState.error ? ' probe-error' : ''}" id="probeFeedback">${escapeHtml(probeState.error || '')}</div>
  </div>`;
}

// 视图三：加群（选平台 → 按平台预置预填 → 按 driver.authSchema 填接入信息 → 模型目录）
// 预填规则：用户没填过的字段用平台默认值（群名 / API 地址），填过的原样保留。
function renderAddGroup(platforms, drivers, platformId, savedValues, savedName, catalog) {
  const platformList = platforms || [];
  const driverList = drivers || [];
  const selection = resolvePlatformSelection(platformList, driverList, platformId);
  const currentPlatform = selection.platform;
  const currentDriver = selection.driver;
  const selectedValue = currentPlatform ? ('preset:' + currentPlatform.id) : ('driver:' + selection.driverId);

  const prefilledValues = {};
  Object.keys(savedValues || {}).forEach(function (key) { prefilledValues[key] = savedValues[key]; });
  if (currentPlatform && !prefilledValues.baseURL && currentPlatform.baseURL) {
    prefilledValues.baseURL = currentPlatform.baseURL;
  }
  const effectiveName = savedName || (currentPlatform ? currentPlatform.name : '');
  const driverHint = currentPlatform
    ? currentPlatform.name + ' · 驱动 ' + currentPlatform.driverId
      + (currentPlatform.summaryTemplate ? ' · ' + currentPlatform.summaryTemplate : '')
    : '暂无可用平台';

  return `<form class="view view-add" id="addGroupForm" autocomplete="off">
    <header class="view-head">
      <button class="btn-back" id="btnAddBack" type="button">&lt; 返回</button>
      <span class="head-title">新建群聊（添加账号）</span>
    </header>
    <div class="form-body">
      <div class="form-step">
        <div class="form-step-title"><span class="step-no">1</span>选择平台</div>
        <select class="driver-select" id="platformSelect">${renderPlatformOptions(platformList, driverList, selectedValue)}</select>
        <div class="driver-hint">${escapeHtml(driverHint)}</div>
      </div>
      <div class="form-step">
        <div class="form-step-title"><span class="step-no">2</span>接入信息（根据 authSchema 动态生成）</div>
        <div class="field">
          <label class="field-label">群名称 (自定义)</label>
          <input class="group-name-input" id="groupNameInput" type="text" placeholder="例如：我的账号" value="${escapeHtml(effectiveName)}">
        </div>
        <div id="authFields">${renderAuthFields(currentDriver, prefilledValues)}</div>
      </div>
      ${renderModelCatalog(catalog)}
    </div>
    <div class="form-footer">
      <button class="btn-primary" id="btnSubmitGroup" type="button">校验并添加群</button>
      <div class="form-note">API Key 由服务端落盘保存，配置文件里只留引用。</div>
    </div>
  </form>`;
}

// 视图四：我的数据库（导入 / 导出 + 已连接账号）
function renderProfile(groups) {
  const itemsHtml = groups.map(function (group) {
    return `<div class="conn-item">
      <span class="avatar">${renderAvatar(group.avatar, group.name)}</span>
      <div>
        <div class="conn-name">${escapeHtml(group.name)}</div>
        <div class="conn-meta conn-meta-compact">${escapeHtml(group.driver)}</div>
      </div>
      <span class="conn-meta">${escapeHtml(group.summary)}</span>
    </div>`;
  }).join('');

  return `<section class="view view-profile">
    <header class="view-head">
      <button class="btn-back" id="btnDatabaseBack" type="button">&lt; 返回</button>
      <span class="head-title">我的模型团队</span>
    </header>
    <div class="profile-body">
      <div class="profile-card">
        <span class="avatar big round">[我]</span>
        <div class="profile-main">
          <div class="profile-name">我的模型团队</div>
          <div class="profile-sub">当前已连接 <b>${groups.length}</b> 个平台账号</div>
        </div>
        <div class="profile-actions">
          <button class="btn-outline" id="btnImport" type="button">导入账号配置 (JSON)</button>
          <button class="btn-outline" id="btnExport" type="button">导出当前配置</button>
        </div>
      </div>
      <div class="conn-title">已连接的平台账号 / 群</div>
      <div class="conn-list">${itemsHtml}</div>
    </div>
  </section>`;
}
// friend-group-form.js —— 好友分组表单的规则层：id 派生 / 校验 / 提交前归一化。
//
// 这一层全是纯函数（同输入 → 同输出）：不碰 document、不发请求、不读全局 state，
// 所以这些规则可以直接被 node 拿去跑用例，不用起浏览器。
//
// 校验条目与后端 src/gateway/friend-groups.js 的 normalizeFriendGroup 一一对应：
// 前端只是把同一套判据提前显示出来，绝不比后端更严——
// 否则会出现「界面不让存、接口其实能收」这种自相矛盾的体验。

// 分组 id 会进 URL 与会话目标，只允许安全字符并以字母/数字开头。
// 与后端 FRIEND_GROUP_ID_PATTERN 是同一条正则，改一处必须改另一处（有测试守着）。
const FRIEND_GROUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// 与后端 MAX_FRIEND_GROUP_ID_LENGTH 一致
const FRIEND_GROUP_ID_MAX_LENGTH = 64;

// 分组名是纯中文或纯符号时派生不出任何字母数字，用这个词兜底（后端要求 id 非空）
const FRIEND_GROUP_ID_FALLBACK = 'group';

// 撞名时最多试到 -99。再多说明命名已经失控，此时交给校验层报「id 已被占用」让人改名，
// 绝不返回一个已存在的 id —— 那会让 POST 的 upsert 语义静默覆盖掉别人的分组。
const FRIEND_GROUP_ID_MAX_SUFFIX = 99;

// 两种调度策略（与后端 STRATEGIES 同值）
const FRIEND_GROUP_STRATEGIES = ['round-robin', 'fallback'];

// 名字 → id 片段：小写 → 非字母数字转连字符 → 合并连续连字符 → 去首尾连字符。
// 派生规则只在这个函数里实现一遍，将来换成拼音或哈希只需要改这里。
function slugifyFriendGroupName(groupName) {
  return String(groupName == null ? '' : groupName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// 派生一个不与已有 id 撞名的分组 id。
// 截断放在加后缀之前，是为了「超长名字 + 撞名」时依旧不超后端的长度上限。
function deriveFriendGroupId(groupName, existingIds) {
  const takenIds = new Set((existingIds || []).map(function (existingId) { return String(existingId); }));
  const slug = slugifyFriendGroupName(groupName).slice(0, FRIEND_GROUP_ID_MAX_LENGTH);
  const baseId = slug || FRIEND_GROUP_ID_FALLBACK;

  if (!takenIds.has(baseId)) return baseId;

  for (let suffix = 2; suffix <= FRIEND_GROUP_ID_MAX_SUFFIX; suffix += 1) {
    const suffixText = '-' + suffix;
    const head = baseId.slice(0, FRIEND_GROUP_ID_MAX_LENGTH - suffixText.length);
    const candidateId = head + suffixText;
    if (!takenIds.has(candidateId)) return candidateId;
  }

  return baseId;
}

// 成员唯一键：与后端去重口径一致（平台 + 模型，与顺序无关）
function friendGroupMemberKey(member) {
  const platformId = member && typeof member.platformId === 'string' ? member.platformId.trim() : '';
  const modelId = member && typeof member.modelId === 'string' ? member.modelId.trim() : '';
  return platformId + '::' + modelId;
}

// 分组 id 单独判一次：派生出来的 id 与手改过的 id 用同一套规则描述错误
function describeFriendGroupIdError(groupId, existingIds, mode) {
  const normalizedId = typeof groupId === 'string' ? groupId.trim() : '';
  if (!normalizedId) return '分组 id 不能为空';
  if (normalizedId.length > FRIEND_GROUP_ID_MAX_LENGTH) {
    return '分组 id 最长 ' + FRIEND_GROUP_ID_MAX_LENGTH + ' 个字符';
  }
  if (!FRIEND_GROUP_ID_PATTERN.test(normalizedId)) {
    return '分组 id 只能包含字母、数字、点、下划线、连字符，且以字母或数字开头';
  }
  // 编辑态用的是分组自己的原 id，不算冲突；只有新建才需要查占用
  const takenIds = (existingIds || []).map(function (existingId) { return String(existingId); });
  if (mode !== 'edit' && takenIds.indexOf(normalizedId) >= 0) {
    return '分组 id 已被占用：' + normalizedId;
  }
  return '';
}

// 表单校验：只报后端会拒绝的项，不新增规则。
// 返回 { ok, errors }，errors 的键就是出错字段名（name / id / strategy / members），
// 视图层按字段名把文案摆到对应输入框下面。
function validateFriendGroupForm(draft, options) {
  const settings = options || {};
  const mode = settings.mode === 'edit' ? 'edit' : 'create';
  const formDraft = draft || {};
  const errors = {};

  const name = typeof formDraft.name === 'string' ? formDraft.name.trim() : '';
  if (!name) errors.name = '分组名不能为空';

  const idError = describeFriendGroupIdError(formDraft.id, settings.existingIds, mode);
  if (idError) errors.id = idError;

  if (FRIEND_GROUP_STRATEGIES.indexOf(formDraft.strategy) < 0) {
    errors.strategy = '策略只能是轮询（round-robin）或故障转移（fallback）';
  }

  const members = Array.isArray(formDraft.members) ? formDraft.members : [];
  if (members.length === 0) {
    errors.members = '至少要有一个成员';
  } else {
    const brokenMemberIndex = members.findIndex(function (member) {
      return !(member && member.platformId && member.modelId);
    });
    if (brokenMemberIndex >= 0) {
      errors.members = '第 ' + (brokenMemberIndex + 1) + ' 个成员缺少平台或模型';
    }
  }

  return { ok: Object.keys(errors).length === 0, errors: errors };
}

// 提交前的归一化：去空白、成员按「平台::模型」去重且保留顺序（后端也这么去重）。
// 去重在这里做，是因为「同一成员配两遍」没有语义，留着只会让故障转移顺序看起来像有两条备份。
function normalizeFriendGroupDraft(draft) {
  const formDraft = draft || {};
  const seenMemberKeys = new Set();
  const members = [];

  (Array.isArray(formDraft.members) ? formDraft.members : []).forEach(function (member) {
    const platformId = member && typeof member.platformId === 'string' ? member.platformId.trim() : '';
    const modelId = member && typeof member.modelId === 'string' ? member.modelId.trim() : '';
    if (!platformId || !modelId) return;
    const memberKey = platformId + '::' + modelId;
    if (seenMemberKeys.has(memberKey)) return;
    seenMemberKeys.add(memberKey);
    members.push({ platformId: platformId, modelId: modelId });
  });

  return {
    id: typeof formDraft.id === 'string' ? formDraft.id.trim() : '',
    name: typeof formDraft.name === 'string' ? formDraft.name.trim() : '',
    strategy: formDraft.strategy,
    members: members,
  };
}

// 两个下拉框当前该选中谁：平台找不到就回落第一个群，模型找不到就回落第一个模型。
// 回落而不是留空，是为了「打开弹窗直接点添加」这条最短路径不会先报一次「没选模型」。
function resolveFriendGroupPicks(platformGroups, pickedPlatformId, pickedModelId, modelsByGroupId) {
  const groups = platformGroups || [];
  const platformGroup = groups.filter(function (group) {
    return group.id === pickedPlatformId;
  })[0] || groups[0] || null;
  const models = (platformGroup && modelsByGroupId && modelsByGroupId[platformGroup.id]) || [];
  const pickedModel = models.filter(function (model) {
    return model.id === pickedModelId;
  })[0] || models[0] || null;

  return {
    platformId: platformGroup ? platformGroup.id : '',
    modelId: pickedModel ? pickedModel.id : '',
    models: models,
  };
}
// friend-group-view.js —— 好友分组表单的视图层：只把草稿画成 HTML 字符串。
//
// 与 friend-group-form.js 的分工：那边管「id 怎么派生、哪些字段不合格」，
// 这边只管「把已经算好的结果摆到页面上」。两个职责混在一个文件里会让人
// 改样式时误碰校验规则，所以拆开——不是为压行数。
//
// 全部是纯函数：输入草稿 + 目录数据，输出 HTML 字符串；不碰 document、不绑事件。
// 事件与请求在 friend-group-modal.js。
//
// 复用现有 class 命名（.field / .field-label / .contact-member / .btn-primary …）：
// 通讯录视图长什么样，编辑弹窗里的成员行就长什么样，避免出现第二套视觉语言。

const FRIEND_GROUP_MEMBER_EMPTY_TEXT = '(还没有添加成员)';
const FRIEND_GROUP_MODEL_LOADING_TEXT = '(模型加载中…)';
const FRIEND_GROUP_MODEL_EMPTY_TEXT = '(该群没有可用模型)';

// 平台下拉：数据源是 state.groups（平台账号群），一个群就是一个可选平台。
// 一个群都没有时给出明确指引，而不是渲染一个空下拉让人以为坏了。
function renderFriendGroupPlatformOptions(platformGroups, pickedPlatformId) {
  if (!platformGroups.length) {
    return '<option value="">(还没有平台群，先去「加群」)</option>';
  }
  return platformGroups.map(function (group) {
    const selected = group.id === pickedPlatformId ? ' selected' : '';
    const label = group.name || group.id;
    return '<option value="' + escapeHtml(group.id) + '"' + selected + '>' + escapeHtml(label) + '</option>';
  }).join('');
}

// 模型下拉：loading / 空 / 有数据三种状态分开说。
// 「加载中」与「确实没有模型」长得一样时，人会以为是插件坏了，所以文案必须分开。
function renderFriendGroupModelOptions(models, pickedModelId, modelsStatus) {
  if (modelsStatus === 'loading') {
    return '<option value="">' + FRIEND_GROUP_MODEL_LOADING_TEXT + '</option>';
  }
  if (!models.length) {
    return '<option value="">' + FRIEND_GROUP_MODEL_EMPTY_TEXT + '</option>';
  }
  return models.map(function (model) {
    const selected = model.id === pickedModelId ? ' selected' : '';
    const label = model.name || model.id;
    return '<option value="' + escapeHtml(model.id) + '"' + selected + '>' + escapeHtml(label) + '</option>';
  }).join('');
}

// 单个成员行。故意沿用通讯录的 .contact-member 结构：
//   ├─ 模型名 (来自 平台名) [主]/[备] [ 移除 ]
// fallback 组按数组顺序标主/备——顺序就是故障转移的先后；
// 本轮没有做上移/下移控件，改顺序的办法是移除后重新添加（交付说明里已声明）。
function renderFriendGroupMemberRow(member, memberIndex, memberTotal, platformNameById, isFallback) {
  const isLastMember = memberIndex === memberTotal - 1;
  const branch = isLastMember ? '└─' : '├─';
  const platformName = platformNameById[member.platformId] || member.platformId;

  let roleTag = '';
  if (isFallback) {
    roleTag = memberIndex === 0
      ? '<span class="contact-role contact-role-main">[主]</span>'
      : '<span class="contact-role">[备]</span>';
  }

  return '<div class="contact-member">'
    + '<span class="contact-branch">' + branch + '</span>'
    + '<span class="contact-member-model">' + escapeHtml(member.modelId) + '</span>'
    + '<span class="contact-member-from">(来自 ' + escapeHtml(platformName) + ')</span>'
    + roleTag
    + '<button class="fg-remove" type="button" data-remove-member="' + memberIndex + '">[ 移除 ]</button>'
    + '</div>';
}

function renderFriendGroupMemberRows(members, platformGroups, strategy) {
  if (!members.length) {
    return '<div class="contacts-empty">' + FRIEND_GROUP_MEMBER_EMPTY_TEXT + '</div>';
  }

  const platformNameById = {};
  (platformGroups || []).forEach(function (group) {
    platformNameById[group.id] = group.name || group.id;
  });

  const isFallback = strategy === 'fallback';
  return members.map(function (member, memberIndex) {
    return renderFriendGroupMemberRow(member, memberIndex, members.length, platformNameById, isFallback);
  }).join('');
}

// 字段级错误位：始终渲染这个节点（哪怕是空串），
// 输入时只改它的 textContent 就能清掉红字，不用为了一句提示重画整个表单。
function renderFriendGroupFieldError(errors, fieldName) {
  const message = (errors || {})[fieldName] || '';
  return '<div class="fg-error" data-error-for="' + fieldName + '">' + escapeHtml(message) + '</div>';
}

// 策略下拉：中文名复用 render.js 的 STRATEGY_LABELS（与通讯录视图同一份，不复制第三份）
function renderFriendGroupStrategyOptions(strategy) {
  return FRIEND_GROUP_STRATEGIES.map(function (value) {
    const selected = value === strategy ? ' selected' : '';
    return '<option value="' + value + '"' + selected + '>' + escapeHtml(STRATEGY_LABELS[value] || value) + '</option>';
  }).join('');
}

// 删除按钮：编辑态才有。第一次点只是进入二次确认（行内按钮，不用 window.confirm —
// 原生对话框在无头浏览器里会被自动吞掉，也会把 409 的提示挡在对话框后面）。
function renderFriendGroupDeleteButton(mode, deleteArmed) {
  if (mode !== 'edit') return '';
  if (deleteArmed) {
    return '<button class="btn-danger" id="btnConfirmDeleteFriendGroup" type="button">[ 确认删除 ]</button>';
  }
  return '<button class="btn-ghost" id="btnDeleteFriendGroup" type="button">[ 删除分组 ]</button>';
}

// 三个单行输入/下拉字段：各自一个函数，改某个字段的文案或校验位置时不必读整张表单
function renderFriendGroupNameField(draft, errors) {
  return '<div class="field">'
    + '<label class="field-label" for="friendGroupName">分组名<span class="req-mark">*</span></label>'
    + '<input id="friendGroupName" type="text" placeholder="例如：主力轮询组" value="' + escapeHtml(draft.name || '') + '">'
    + renderFriendGroupFieldError(errors, 'name')
    + '</div>';
}

function renderFriendGroupIdField(draft, errors, mode) {
  const idReadonly = mode === 'edit' ? ' readonly' : '';
  return '<div class="field">'
    + '<label class="field-label" for="friendGroupId">分组 id（自动生成）</label>'
    + '<input id="friendGroupId" type="text" value="' + escapeHtml(draft.id || '') + '"' + idReadonly + '>'
    + renderFriendGroupFieldError(errors, 'id')
    + '</div>';
}

function renderFriendGroupStrategyField(strategy, errors) {
  return '<div class="field">'
    + '<label class="field-label" for="friendGroupStrategy">调度策略</label>'
    + '<select class="field-select" id="friendGroupStrategy">' + renderFriendGroupStrategyOptions(strategy) + '</select>'
    + renderFriendGroupFieldError(errors, 'strategy')
    + '</div>';
}

// 成员选择器：平台下拉 → 模型下拉 → 添加按钮，三者同排
function renderFriendGroupPickerField(platformGroups, picks, pickedModelsStatus, errors) {
  return '<div class="field">'
    + '<label class="field-label">添加成员</label>'
    + '<div class="fg-picker">'
    + '<select class="field-select" id="friendGroupPlatformPick">'
    + renderFriendGroupPlatformOptions(platformGroups, picks.platformId)
    + '</select>'
    + '<select class="field-select" id="friendGroupModelPick">'
    + renderFriendGroupModelOptions(picks.models, picks.modelId, pickedModelsStatus)
    + '</select>'
    + '<button class="btn-ghost" id="btnAddFriendGroupMember" type="button">[ + 添加成员 ]</button>'
    + '</div>'
    + renderFriendGroupFieldError(errors, 'members')
    + '</div>';
}

function renderFriendGroupMembersField(members, platformGroups, strategy) {
  return '<div class="field">'
    + '<label class="field-label">成员（' + members.length + ' 个）</label>'
    + '<div class="contact-members">' + renderFriendGroupMemberRows(members, platformGroups, strategy) + '</div>'
    + '</div>';
}

// 弹窗正文。
// options：mode（create/edit）、groups（平台群）、modelsByGroupId / modelsStatus（模型目录）、
//          draft（名字 / 策略 / 已选成员 / 两个下拉的选择）、errors（前端校验结果）、
//          formError（服务端返回的原文，原样显示不加工）、deleteArmed（是否已进入删除确认）。
function renderFriendGroupForm(options) {
  const settings = options || {};
  const mode = settings.mode === 'edit' ? 'edit' : 'create';
  const platformGroups = settings.groups || [];
  const draft = settings.draft || {};
  const errors = settings.errors || {};
  const members = Array.isArray(draft.members) ? draft.members : [];
  const strategy = FRIEND_GROUP_STRATEGIES.indexOf(draft.strategy) >= 0
    ? draft.strategy
    : FRIEND_GROUP_STRATEGIES[0];

  const picks = resolveFriendGroupPicks(platformGroups, draft.platformPick, draft.modelPick, settings.modelsByGroupId);
  const pickedModelsStatus = settings.modelsStatus ? settings.modelsStatus[picks.platformId] : '';
  const formErrorHtml = settings.formError
    ? '<div class="fg-form-error" data-error-for="form">' + escapeHtml(settings.formError) + '</div>'
    : '';

  return '<form class="friend-group-form" id="friendGroupForm" autocomplete="off">'
    + renderFriendGroupNameField(draft, errors)
    + renderFriendGroupIdField(draft, errors, mode)
    + renderFriendGroupStrategyField(strategy, errors)
    + renderFriendGroupPickerField(platformGroups, picks, pickedModelsStatus, errors)
    + renderFriendGroupMembersField(members, platformGroups, strategy)
    + formErrorHtml
    + '<div class="fg-actions">'
    + '<button class="btn-primary" id="btnSaveFriendGroup" type="button">保存</button>'
    + renderFriendGroupDeleteButton(mode, settings.deleteArmed)
    + '<button class="btn-ghost" id="btnCancelFriendGroup" type="button">取消</button>'
    + '</div>'
    + '</form>';
}
// friend-group-modal.js —— 好友分组弹窗的接线层：取数、弹窗、保存/删除、失败呈现。
// 为什么单独一个分片而不是塞进 app.js：app.js 已到 379 代码行（门禁 400），
// 这层是纯副作用代码（DOM + 请求），塞进去必然破门禁；纯规则在 friend-group-form.js。
// 依赖（同作用域、后加载）：showModal / toast / renderApp 来自 app.js，store 是 app.js 的装配实例；
// 这里只在函数体里引用它们，模块加载期不求值，因此拼接顺序不会踩 TDZ。

// 弹窗现状：null = 没开。留着草稿是为了"添加成员/切换下拉/失败重画"都不丢已填内容
var friendGroupModal = null;
// 删除二次确认用行内按钮而不是 window.confirm：原生对话框在无头浏览器里会被自动吞掉，
// 既测不到"确认后真的删了"，也会把 409 的提示挡在对话框后面
var FRIEND_GROUP_MODAL_TITLE = { create: '新建好友分组', edit: '编辑好友分组' };

function friendGroupDeepCopyMembers(members) {
  return (Array.isArray(members) ? members : []).map(function (member) {
    return { platformId: member.platformId, modelId: member.modelId };
  });
}

function friendGroupExistingIds(exceptGroupId) {
  var current = store.getState();
  return current.friendGroups
    .map(function (friendGroup) { return friendGroup.id; })
    .filter(function (groupId) { return groupId !== exceptGroupId; });
}

// 平台群有动作才拉模型：只有"全部平台都还没有模型目录"时才发请求，避免每次开弹窗都打一遍接口
function ensureFriendGroupModels(platformGroups) {
  var missingGroups = platformGroups.filter(function (group) {
    return !friendGroupModal.draft.modelsByGroupId[group.id];
  });
  if (!missingGroups.length) return Promise.resolve();
  missingGroups.forEach(function (group) { friendGroupModal.draft.modelsStatus[group.id] = 'loading'; });
  return Promise.all(missingGroups.map(function (group) {
    return Promise.resolve(api.getGroupModels(group.id)).then(function (models) {
      friendGroupModal.draft.modelsByGroupId[group.id] = models || [];
      friendGroupModal.draft.modelsStatus[group.id] = 'loaded';
    }, function (loadError) {
      // 模型拉不到不该挡住"改名字/改策略"：标成 error 让下拉显示空态，失败原因照常上报
      friendGroupModal.draft.modelsByGroupId[group.id] = [];
      friendGroupModal.draft.modelsStatus[group.id] = 'error';
      reportApiFailure('friend-groups:models:' + group.id, 'load', loadError && loadError.message ? loadError.message : String(loadError));
    });
  }));
}

// 由「编辑中的原分组」造出初始草稿：新建时全都给空/缺省，
// 编辑时预填名字/策略/成员，并把两个下拉先指到第一个成员所在的平台与模型
function buildFriendGroupDraft(editingGroup, platformGroups) {
  var members = friendGroupDeepCopyMembers(editingGroup ? editingGroup.members : []);
  var firstMember = members.length ? members[0] : null;
  var firstPlatformGroup = platformGroups[0] || null;
  return {
    id: editingGroup ? editingGroup.id : '',
    name: editingGroup ? editingGroup.name : '',
    strategy: editingGroup ? editingGroup.strategy : 'round-robin',
    members: members,
    platformPick: firstMember ? firstMember.platformId : (firstPlatformGroup ? firstPlatformGroup.id : ''),
    modelPick: firstMember ? firstMember.modelId : '',
    modelsByGroupId: {},
    modelsStatus: {},
    errors: {},
    formError: ''
  };
}

// 打开弹窗：mode=create 新建 / edit 编辑（group 必须是 state.friendGroups 里的一项）
function openFriendGroupModal(mode, friendGroup) {
  // 先收掉上一份：连点两下「编辑」或上一个弹窗是用 × 关掉的时候，
  // 不先关就会在页面上叠出第二个遮罩，而 × 的处理器只认第一个 #modalClose。
  closeFriendGroupModal();
  var platformGroups = store.getState().groups || [];
  var editingGroup = mode === 'edit' ? friendGroup : null;
  friendGroupModal = {
    mode: editingGroup ? 'edit' : 'create',
    groupId: editingGroup ? editingGroup.id : '',
    platformGroups: platformGroups,
    deleteArmed: false,
    draft: buildFriendGroupDraft(editingGroup, platformGroups),
    mask: null
  };
  friendGroupModal.mask = showModal(FRIEND_GROUP_MODAL_TITLE[friendGroupModal.mode], '<div class="loading">正在准备表单…</div>');
  friendGroupModal.mask.addEventListener('click', onFriendGroupModalClick);
  friendGroupModal.mask.addEventListener('input', onFriendGroupModalInput);
  friendGroupModal.mask.addEventListener('change', onFriendGroupModalChange);
  // × 与点遮罩由 showModal 自己负责摘节点，这里只负责把模块状态一起清掉：
  // 否则下一次打开会以为"上一个弹窗还开着"，草稿与遮罩引用都对不上。
  var closeButton = friendGroupModal.mask.querySelector('.modal-close');
  if (closeButton) {
    closeButton.addEventListener('click', function () { friendGroupModal = null; });
  }
  ensureFriendGroupModels(platformGroups).then(function () { paintFriendGroupModal(); });
}

// 重画弹窗正文：只有它一处改 DOM，草稿与错误都在 friendGroupModal 里
function paintFriendGroupModal() {
  if (!friendGroupModal || !friendGroupModal.mask) return;
  var bodyHost = friendGroupModal.mask.querySelector('.modal-body');
  if (!bodyHost) return;
  var draft = friendGroupModal.draft;
  var strategySelect = bodyHost.querySelector('#friendGroupStrategy');
  // 策略/平台的选中值以草稿为准（重画前用户刚改过的值不能丢）
  if (strategySelect) draft.strategy = strategySelect.value || draft.strategy;
  bodyHost.innerHTML = renderFriendGroupForm({
    mode: friendGroupModal.mode,
    groups: friendGroupModal.platformGroups,
    modelsByGroupId: draft.modelsByGroupId,
    modelsStatus: draft.modelsStatus,
    draft: draft,
    errors: draft.errors,
    formError: draft.formError,
    deleteArmed: friendGroupModal.deleteArmed
  });
}

function closeFriendGroupModal() {
  if (friendGroupModal && friendGroupModal.mask) friendGroupModal.mask.remove();
  friendGroupModal = null;
}

function readFriendGroupDraftFromDom() {
  var bodyHost = friendGroupModal.mask.querySelector('.modal-body');
  var nameInput = bodyHost.querySelector('#friendGroupName');
  var strategySelect = bodyHost.querySelector('#friendGroupStrategy');
  if (nameInput) friendGroupModal.draft.name = nameInput.value;
  if (strategySelect) friendGroupModal.draft.strategy = strategySelect.value;
  return friendGroupModal.draft;
}

// 名字改动时实时刷新派生 id（新建态）：只改那两个输入框，不重画整表，否则输入框会失焦
function syncFriendGroupDerivedId() {
  if (!friendGroupModal || friendGroupModal.mode !== 'create') return;
  var bodyHost = friendGroupModal.mask.querySelector('.modal-body');
  var idInput = bodyHost.querySelector('#friendGroupId');
  var draft = readFriendGroupDraftFromDom();
  draft.id = deriveFriendGroupId(draft.name, friendGroupExistingIds(''));
  if (idInput) idInput.value = draft.id;
  draft.errors.name = '';
  draft.errors.id = '';
  var nameErrorNode = bodyHost.querySelector('[data-error-for="name"]');
  var idErrorNode = bodyHost.querySelector('[data-error-for="id"]');
  if (nameErrorNode) nameErrorNode.textContent = '';
  if (idErrorNode) idErrorNode.textContent = '';
}

function addFriendGroupMember() {
  var draft = friendGroupModal.draft;
  var bodyHost = friendGroupModal.mask.querySelector('.modal-body');
  var platformSelect = bodyHost.querySelector('#friendGroupPlatformPick');
  var modelSelect = bodyHost.querySelector('#friendGroupModelPick');
  var platformId = platformSelect ? platformSelect.value : '';
  var modelId = modelSelect ? modelSelect.value : '';
  if (!platformId || !modelId) {
    draft.errors = { members: '先选好平台与模型再添加（当前下拉没有可用模型）' };
    paintFriendGroupModal();
    return;
  }
  var memberKey = platformId + '::' + modelId;
  var alreadyAdded = draft.members.some(function (member) {
    return member.platformId + '::' + member.modelId === memberKey;
  });
  // 重复添加不报错（后端也是去重保序），只是不再加一遍，避免列表里出现两行一样的成员
  if (!alreadyAdded) draft.members.push({ platformId: platformId, modelId: modelId });
  draft.errors = {};
  draft.formError = '';
  paintFriendGroupModal();
}

function saveFriendGroupDraft() {
  var draft = readFriendGroupDraftFromDom();
  var normalizedDraft = normalizeFriendGroupDraft(draft);
  if (friendGroupModal.mode === 'create') {
    normalizedDraft.id = normalizedDraft.id || deriveFriendGroupId(normalizedDraft.name, friendGroupExistingIds(''));
  }
  var validation = validateFriendGroupForm(normalizedDraft, {
    existingIds: friendGroupExistingIds(friendGroupModal.groupId),
    mode: friendGroupModal.mode
  });
  draft.errors = validation.errors;
  draft.formError = '';
  if (!validation.ok) { paintFriendGroupModal(); return; }
  draft.id = normalizedDraft.id;
  // 保存期间按钮不做禁用态：同 id 覆盖是幂等的，重复点击不会造出第二个分组
  api.createFriendGroup(normalizedDraft).then(function () {
    closeFriendGroupModal();
    toast('分组已保存');
    return store.dispatch({ type: 'load-groups' });
  }).catch(function (saveError) {
    // 服务端 message 原文进弹窗（含「分组 id 不合法」「members 必须是非空数组」这类具体判据）
    draft.formError = '保存失败：' + (saveError && saveError.message ? saveError.message : String(saveError));
    paintFriendGroupModal();
  });
}

function deleteFriendGroupConfirmed() {
  var draft = friendGroupModal.draft;
  api.deleteFriendGroup(friendGroupModal.groupId).then(function () {
    closeFriendGroupModal();
    toast('分组已删除');
    return store.dispatch({ type: 'load-groups' });
  }).catch(function (deleteError) {
    // 409 的「分组 x 正被 N 个会话使用」必须原样显示：这是唯一告诉用户"为什么删不掉"的信息
    friendGroupModal.deleteArmed = false;
    draft.formError = '删除失败：' + (deleteError && deleteError.message ? deleteError.message : String(deleteError));
    paintFriendGroupModal();
  });
}

function onFriendGroupModalClick(event) {
  var clickedButton = event.target.closest('button');
  if (!clickedButton) return;
  var removeMemberButton = event.target.closest('[data-remove-member]');
  if (removeMemberButton) {
    friendGroupModal.draft.members.splice(Number(removeMemberButton.dataset.removeMember), 1);
    friendGroupModal.draft.errors = {};
    paintFriendGroupModal();
    return;
  }
  var buttonId = clickedButton.id;
  if (buttonId === 'btnSaveFriendGroup') saveFriendGroupDraft();
  else if (buttonId === 'btnAddFriendGroupMember') addFriendGroupMember();
  else if (buttonId === 'btnCancelFriendGroup') closeFriendGroupModal();
  else if (buttonId === 'btnDeleteFriendGroup') {
    friendGroupModal.deleteArmed = true;
    friendGroupModal.draft.formError = '';
    paintFriendGroupModal();
  } else if (buttonId === 'btnConfirmDeleteFriendGroup') deleteFriendGroupConfirmed();
}

function onFriendGroupModalInput(event) {
  if (event.target.id !== 'friendGroupName') return;
  syncFriendGroupDerivedId();
}

function onFriendGroupModalChange(event) {
  var target = event.target;
  if (target.id === 'friendGroupPlatformPick') {
    friendGroupModal.draft.platformPick = target.value;
    friendGroupModal.draft.modelPick = '';
    paintFriendGroupModal();
  } else if (target.id === 'friendGroupModelPick') {
    friendGroupModal.draft.modelPick = target.value;
  } else if (target.id === 'friendGroupStrategy') {
    // 策略决定成员行要不要标 [主]/[备]，必须重画一次
    friendGroupModal.draft.strategy = target.value;
    paintFriendGroupModal();
  }
}
// chat.js —— 群聊交互：@ 选择器、插入输入框、发送与切换目标（写入一律走 store.dispatch）。
// 消息合并/排序/系统提示都归工厂：这里不再本地插 system 文案，也不直接调 api 改会话。

// 选择器条目：本群群友（带来源平台）在前、好友分组（带成员数）在后，键盘用同一份 items 索引
function buildAtSections() {
  const current = ensureState();
  const activeGroup = currentGroup();
  // 群对象的驱动字段是 driver（契约 §3.1 同名透传）；读 driverId 会恒空 → 选择器里平台名缺失
  const activeDriverId = activeGroup ? (activeGroup.driver || activeGroup.driverId) : '';
  const activeDriver = current && current.drivers ? current.drivers.filter(function (driver) {
    return driver.id === activeDriverId;
  })[0] : null;
  const driverName = activeDriver
    ? String(activeDriver.name).split(/[（(]/)[0].trim()
    : (activeDriverId || '');

  const modelItems = modelsOf(current.currentGroupId).map(function (model) {
    const shortName = String(model.name || model.id).replace(/^global:/, '');
    return {
      type: 'model',
      id: model.id,
      label: shortName,
      display: driverName ? shortName + ' (' + driverName + ')' : shortName,
      avatar: '[' + shortName.charAt(0).toUpperCase() + ']',
      // 窗口随条目带出来：@ 选择器要如实展示（未知显示 —），切换提示也用它比较
      contextLength: model.contextLength
    };
  });
  const groupItems = (current.friendGroups || []).map(function (friendGroup) {
    return {
      type: 'group',
      id: friendGroup.id,
      label: friendGroup.name,
      display: friendGroup.name,
      memberCount: friendGroup.members ? friendGroup.members.length : 0
    };
  });
  return { modelItems: modelItems, groupItems: groupItems, all: modelItems.concat(groupItems) };
}

// 打开 @ 浮层：两块列表 + 记录触发用的 @ 位置
function openAtPop() {
  const atPop = findElement('#atPop');
  if (!atPop) return;
  const sections = buildAtSections();
  if (!sections.all.length) return;
  viewState.atPicker.open = true;
  viewState.atPicker.activeIndex = 0;
  viewState.atPicker.items = sections.all;
  const messageInput = findElement('#msgInput');
  viewState.atPicker.triggerIndex = messageInput ? messageInput.value.lastIndexOf('@') : -1;

  const modelsHtml = sections.modelItems.length
    ? renderAtSection('本群群友（单模型）') + sections.modelItems.map(renderAtModelItem).join('')
    : '';
  const groupsHtml = sections.groupItems.length
    ? renderAtSection('我的好友分组（轮换组）') + sections.groupItems.map(function (item, offset) {
      return renderAtGroupItem(item, sections.modelItems.length + offset);
    }).join('')
    : '';
  findElement('#atList').innerHTML = modelsHtml + groupsHtml;
  atPop.classList.remove('hidden');
  syncAtActive();
}

function closeAtPop() {
  const atPop = findElement('#atPop');
  if (atPop) atPop.classList.add('hidden');
  viewState.atPicker.open = false;
}

// 高亮键盘选中项
function syncAtActive() {
  findElements('#atList .at-item').forEach(function (element, index) {
    element.classList.toggle('active', index === viewState.atPicker.activeIndex);
  });
}

// 把 @条目 写进输入框：替换触发用的那个 @，避免出现 @@
function insertMention(item) {
  const messageInput = findElement('#msgInput');
  if (!messageInput || !item) return;
  const inputValue = messageInput.value;
  const recordedIndex = viewState.atPicker.triggerIndex;
  const triggerIndex = recordedIndex >= 0 && recordedIndex < inputValue.length
    ? recordedIndex
    : inputValue.lastIndexOf('@');
  const beforeMention = (triggerIndex >= 0 ? inputValue.slice(0, triggerIndex) : inputValue).replace(/@+$/, '');
  messageInput.value = beforeMention + '@' + item.label + ' ';
  viewState.atPicker.triggerIndex = -1;
  closeAtPop();
  messageInput.focus();
}

// 输入里最后一个 @ 之后还没有空格，就认为正在选人
function syncAtByInput(inputElement) {
  const inputValue = inputElement.value;
  const atIndex = inputValue.lastIndexOf('@');
  if (atIndex >= 0 && inputValue.slice(atIndex + 1).indexOf(' ') === -1) {
    if (!viewState.atPicker.open) openAtPop();
  } else {
    closeAtPop();
  }
}

// 发送：由工厂乐观插一条我的气泡，随后用后端事件重建；@分组/@模型 再切一次目标。
// 系统提示只在后端定义（契约 §六），这里不本地拼任何 system 文案。
function sendMessage() {
  const messageInput = findElement('#msgInput');
  if (!messageInput) return;
  const messageText = messageInput.value.trim().replace(/@+/g, '@');
  if (!messageText) { toast('先输入点什么再发送'); return; }

  messageInput.value = '';
  closeAtPop();
  store.dispatch({ type: 'send-message', text: messageText });

  const mentionMatch = /@([^\s]+)/.exec(messageText);
  if (!mentionMatch) return;
  const mentionText = mentionMatch[1];
  const current = ensureState();

  const matchedGroup = (current.friendGroups || []).filter(function (friendGroup) {
    return friendGroup.name === mentionText || friendGroup.id === mentionText;
  })[0];
  if (matchedGroup) {
    store.dispatch({ type: 'switch-target', target: { type: 'group', id: matchedGroup.id } });
    return;
  }

  const matchedModel = modelsOf(current.currentGroupId).filter(function (model) {
    return String(model.name || model.id).replace(/^global:/, '') === mentionText || model.id === mentionText;
  })[0];
  if (matchedModel) {
    warnOnSmallerWindow(current, matchedModel);
    store.dispatch({
      type: 'switch-target',
      target: { type: 'model', id: matchedModel.id, platformId: current.currentGroupId }
    });
  }
}

// 切到更小窗口的模型时提示一次（不阻断）。为什么要提示：申报给 dsh 的是所有模型窗口的最小值，
// 但真实请求打到的是目标模型；从大窗口切到小窗口后，长上下文请求会被上游拒绝，提前说一声比事后报 400 好。
// 任一侧窗口未知就不提示——宁可不提示，也不要拿兜底值吓人。
function warnOnSmallerWindow(current, nextModel) {
  const previousTarget = current.effectiveTarget || current.target;
  if (!previousTarget || previousTarget.type !== 'model') return;
  const previousModel = modelsOf(current.currentGroupId).filter(function (model) {
    return model.id === previousTarget.id;
  })[0];
  const previousWindow = Number(previousModel && previousModel.contextLength);
  const nextWindow = Number(nextModel.contextLength);
  if (!Number.isFinite(previousWindow) || !Number.isFinite(nextWindow)) return;
  if (nextWindow >= previousWindow) return;
  toast('目标窗口变小：' + formatContextLength(previousWindow) + ' → ' + formatContextLength(nextWindow)
    + '，长上下文请求可能被拒');
}
// admin.js —— 管理侧交互：加群提交、数据库导入导出。
// 导出取 api.exportConfig() 的结果触发下载；导入交给 api.importConfig() 校验后展示回执。

const REVOKE_URL_DELAY_MS = 1500;   // 下载触发后延迟回收 blob URL
const GROUP_ID_SUFFIX_LENGTH = 8;   // 新群名后面拼的 id 尾号长度

// 导入回执的表格与说明抽成纯函数：字段名（driver）与文案都被单测钉住，
// 否则这类"看起来能用、其实列恒空"的问题只能等用户导入一次才发现。
// 群对象的驱动字段是 driver（契约 §3.1：写入与读出同名，无映射层）。
function renderImportPreviewTable(acceptedGroups) {
  const rowHtml = (acceptedGroups || []).map(function (group) {
    return `<tr><td>${escapeHtml(group.id)}</td><td>${escapeHtml(group.name)}</td>`
      + `<td>${escapeHtml(group.driver)}</td><td>${escapeHtml(group.credentialRef || '—')}</td></tr>`;
  }).join('');
  return `<table class="modal-table">
            <thead><tr><th>id</th><th>name</th><th>driver</th><th>credentialRef</th></tr></thead>
            <tbody>${rowHtml || '<tr><td colspan="4">（无 groups 数据）</td></tr>'}</tbody>
          </table>`;
}

// 导入说明必须与真实行为一致：api.importConfig 走 merge upsert（会落盘），
// 旧文案「只展示结果、不写入存储」是 mock 时代残留，会让人以为导入不生效。
function buildImportResultNote(acceptedCount, rejectedCount) {
  return '可导入 ' + acceptedCount + ' 个平台账号，结构不合法 ' + rejectedCount
    + ' 条；合并写入（同名 upsert），不会删除已有群。';
}

// —— 加群表单的读取与组装 ——
// 拆成「读 DOM / 校验 / 组装 / 结果处理」几段纯函数，提交主流程只留编排：
// 以前这些都在 submitNewGroup 一个函数里，改任何一条取值优先级都要重读整段。

// 群名以 DOM 为准：预填值只写进了 input.value，不一定同步回 viewState
function readGroupNameFromDom() {
  const nameNode = document.querySelector('#groupNameInput');
  return String((nameNode && nameNode.value) || viewState.addForm.name || '').trim();
}

// 凭证字段按 data-auth-key 扫 DOM：键名由后端 authSchema 决定，前端不写死任何平台字段
function readAuthValuesFromDom() {
  const authValues = {};
  Array.prototype.slice.call(document.querySelectorAll('[data-auth-key]')).forEach(function (node) {
    authValues[node.dataset.authKey] = String(node.value || '').trim();
  });
  return authValues;
}

// 必填项缺失时返回中文标签（直接拼进 toast）；空数组表示可以提交
function findMissingRequiredLabels(selectedDriver, authValues) {
  return (selectedDriver.authSchema || []).filter(function (field) {
    return field.required && !authValues[field.key];
  }).map(function (field) { return field.label; });
}

// 群 id：mock- 前缀 + 时间戳的 36 进制。36 是进制基数（0-9a-z），不是长度/轮询阈值；
// 用 36 进制只为短一些，真正唯一性由后端保存时保证
function buildGroupId() {
  return 'mock-' + Date.now().toString(36);
}

// baseURL 取值优先级：DOM 输入 → viewState 预填 → 平台预置 → 空串（提交时再 trim）
function readBaseURLFromDom(selectedPlatform) {
  const domBaseURL = document.querySelector('[data-auth-key="baseURL"]');
  return String(
    (domBaseURL && domBaseURL.value)
    || viewState.addForm.values.baseURL
    || (selectedPlatform && selectedPlatform.baseURL)
    || ''
  );
}

// 摘要模板来自后端（{baseURL} 占位）；没有模板时用同一份默认串，保证摘要永远可渲染
function resolveSummaryTemplate(selectedPlatform) {
  return (selectedPlatform && selectedPlatform.summaryTemplate) || '已连接 · {baseURL}';
}

// 群草稿：前端概念字段先铺好，后端返回的 savedGroup 随后覆盖（id/credentialRef 以服务端为准）
function buildNewGroupDraft(options) {
  const selectedPlatform = options.selectedPlatform;
  const selectedDriver = options.selectedDriver;
  const groupId = options.groupId;
  return {
    id: groupId,
    name: options.groupName + '(' + groupId.slice(-GROUP_ID_SUFFIX_LENGTH) + ')',
    avatar: (selectedPlatform && selectedPlatform.avatar) || selectedDriver.avatar || '',
    // 不要在这里放 driverId：契约 §3.1 群的驱动字段只有 driver，后端返回的 savedGroup 会覆盖，
    // 留一个没人读的同义字段只会让后来人以为"前端驱动 id 叫 driverId"（F-09 那类错误的温床）。
    platformId: selectedPlatform ? selectedPlatform.id : '',
    credentialRef: 'local://' + (selectedPlatform ? selectedPlatform.id : selectedDriver.id) + '/' + groupId,
    summary: options.summaryTemplate.replace('{baseURL}', options.baseURL),
    lastUpdated: new Date().toISOString()
  };
}

// 模型目录：manual 且有有效行 → models.static；否则走自动拉取 models.endpoint
function buildModelsPayload(selectedPlatform) {
  const staticModels = collectStaticModels();
  if (staticModels.length) return { static: staticModels };
  return { endpoint: (selectedPlatform && selectedPlatform.modelsEndpoint) || '/models' };
}

// 提交载荷按 docs/09「POST /_team/groups 请求体（冻结）」逐字段对齐：
//   driver（不是 driverId）、baseURL 在顶层、summary 是 { template } 对象、auth 只放凭证。
//   读侧（GET /_team/groups）的驱动字段同样叫 driver（契约 §3.1 同名透传，无映射层）。
function buildGroupSubmitPayload(options) {
  const submitPayload = {
    name: options.groupName,
    driver: options.selectedDriver.id,
    baseURL: String(options.baseURL || '').trim(),
    auth: { apiKey: options.authValues.apiKey },
    models: options.modelsPayload,
    avatar: options.newGroup.avatar
  };
  if (options.summaryTemplate) {
    submitPayload.summary = { template: options.summaryTemplate };
  }
  return submitPayload;
}

// 提交成功：以后端返回的群为准；没返回群信息按失败处理（不做乐观插入）
function applyCreatedGroup(created, context) {
  const savedGroup = created && created.group ? created.group : null;
  if (!savedGroup) {
    // 后端没返回群信息：视为失败，不做乐观插入
    viewState.addForm.submitting = false;
    toast('添加失败：服务端未返回群信息');
    store.render();
    return;
  }
  // 本地字段打底（platformId 等前端概念），后端字段覆盖（id / credentialRef 以服务端为准）。
  // summary 例外：POST 回显的是**写入形状** { template }，列表渲染要的是渲染后字符串，
  // 直接用会显示 [object Object]（刷新后由 GET 渲染成字符串才对得上）。
  const mergedGroup = Object.assign({}, context.newGroup, savedGroup);
  if (mergedGroup.summary && typeof mergedGroup.summary === 'object') mergedGroup.summary = context.newGroup.summary;
  context.currentState.groups.push(mergedGroup);
  viewState.addForm = { platformId: context.selectedPlatform.id, name: '', values: {} };
  viewState.modelCatalog = { mode: 'auto', models: [], probe: { loading: false, error: '' } };
  viewState.addForm.submitting = false;
  toast('已添加群聊：' + context.selectedPlatform.name + ' · ' + context.groupName);
  store.render();
  switchView('list');
}

// 提交失败：提示原因、保留表单、不插入、不跳转（标志必须复位，否则一次失败后再也提交不了）
function handleSubmitFailure(error) {
  viewState.addForm.submitting = false;
  const reason = error && error.message ? error.message : '未知错误';
  toast('添加失败：' + reason);
  store.render();
}

// 提交加群表单：选中的平台决定 driver（authSchema 校验）与默认头像/摘要模板。
// 平台信息全部来自 /_team/platforms，这里只用返回值，不写死任何平台字段。
function submitNewGroup() {
  // 重复点击保护：请求在途时直接返回。没有这道闸，双击会连发两次建群，
  // 后端不去重 → 列表里出现同名群（G-12 的另一半症状）。
  if (viewState.addForm.submitting) return;
  const current = ensureState();
  // 平台选择值有两种形态：preset:<平台id>（预置，带 baseURL/头像/摘要模板）
  // 或 driver:<驱动id>（通用入口，只有驱动本身）。两种都要支持提交。
  const selection = resolvePlatformSelection(current.platforms || [], current.drivers || [], viewState.addForm.platformId);
  const selectedPlatform = selection.platform;
  const selectedDriver = selection.driver;
  if (!selectedDriver) { toast('平台/驱动列表未就绪'); return; }

  // 名称/凭证/baseURL 都以 DOM 实际值为准（各自的取值优先级见对应读取函数）
  const groupName = readGroupNameFromDom();
  if (!groupName) { toast('请填写群名称'); return; }

  const authValues = readAuthValuesFromDom();
  const missingLabels = findMissingRequiredLabels(selectedDriver, authValues);
  if (missingLabels.length) { toast('请填写必填项：' + missingLabels.join('、')); return; }

  const groupId = buildGroupId();
  const baseURL = readBaseURLFromDom(selectedPlatform);
  // 摘要按平台模板渲染（{baseURL} 占位），模板也来自后端
  const summaryTemplate = resolveSummaryTemplate(selectedPlatform);
  const newGroup = buildNewGroupDraft({
    groupId: groupId,
    groupName: groupName,
    selectedPlatform: selectedPlatform,
    selectedDriver: selectedDriver,
    baseURL: baseURL,
    summaryTemplate: summaryTemplate
  });
  // 提交载荷：平台头像与摘要模板一并带给后端（群配置字段）
  const modelsPayload = buildModelsPayload(selectedPlatform);

  const submitPayload = buildGroupSubmitPayload({
    groupName: groupName,
    selectedDriver: selectedDriver,
    baseURL: baseURL,
    authValues: authValues,
    modelsPayload: modelsPayload,
    newGroup: newGroup,
    summaryTemplate: summaryTemplate
  });

  viewState.addForm.submitting = true;
  const submitButton = document.querySelector('#btnSubmitGroup');
  if (submitButton) submitButton.disabled = true;

  // 提交后**以后端返回的群为准**：失败必须提示且不插入本地对象。
  // 曾经的写法是 .catch(function () { return null; }) 吞掉错误后再无条件 push，
  // 导致「界面显示 7 个群、config.json 里只有 2 个」的幽灵群，且重复点击会堆同名群。
  api.createGroup(submitPayload).then(function (created) {
    applyCreatedGroup(created, {
      currentState: current,
      newGroup: newGroup,
      selectedPlatform: selectedPlatform,
      groupName: groupName
    });
  }).catch(handleSubmitFailure);
}

// 导出：把配置存成 .json 文件
function exportDatabase() {
  api.exportConfig().then(function (config) {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const blobUrl = URL.createObjectURL(blob);
    const downloadLink = document.createElement('a');
    downloadLink.href = blobUrl;
    downloadLink.download = 'model-team-export.json';
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
    setTimeout(function () { URL.revokeObjectURL(blobUrl); }, REVOKE_URL_DELAY_MS);
    toast('已导出 model-team-export.json');
  });
}

// 导入：读本地 JSON 文件 → api.importConfig 校验 → 弹层展示回执
function importDatabase() {
  const filePicker = document.createElement('input');
  filePicker.type = 'file';
  filePicker.accept = '.json,application/json';
  filePicker.id = 'teamImportPicker';
  filePicker.style.display = 'none';
  document.body.appendChild(filePicker);   // 游离节点在部分浏览器不弹文件框

  filePicker.addEventListener('change', function () {
    const selectedFile = filePicker.files && filePicker.files[0];
    if (!selectedFile) return;
    const fileReader = new FileReader();
    fileReader.onload = function () {
      let parsedConfig = null;
      try {
        parsedConfig = JSON.parse(String(fileReader.result));
      } catch (error) {
        showModal('导入失败', `<p class="modal-p">JSON 解析失败：${escapeHtml(error.message)}</p>`);
        filePicker.remove();
        return;
      }
      api.importConfig(parsedConfig).then(function (importResult) {
        showModal('导入解析结果', `
          <p class="modal-p">文件名：<b>${escapeHtml(selectedFile.name)}</b> · 大小 ${selectedFile.size} 字节</p>
          <p class="modal-p">${escapeHtml(buildImportResultNote(importResult.accepted.length, importResult.rejected.length))}</p>
          ${renderImportPreviewTable(importResult.accepted)}`);
        filePicker.remove();
      });
    };
    fileReader.readAsText(selectedFile);
  });
  filePicker.click();
}
// float.js —— 悬浮球与悬浮面板：定位、开合、关闭与召回、拖拽。
// 球常驻屏幕、可拖动；点球展开统计面板；× 关闭后留一个「呼出模型团队」入口。
// 拖动：球用 transform 单帧跟随（rAF 合并，不重排），松手才落 left/top 并持久化锚点；
//       面板标题条拖动仍直接改 left/top（面板位置不持久化）。

const PANEL_GAP_PX = 12;             // 面板与球的间距
const VIEWPORT_MARGIN_PX = 12;       // 面板离视口边缘的最小距离
const DRAG_THRESHOLD_PX = 4;         // 位移超过它才算拖动，否则视为点击
const BALL_FALLBACK_SIZE_PX = 56;    // 取不到球实际尺寸时的兜底（与样式里的球径一致）
const PANEL_FALLBACK_WIDTH = 384;    // 面板未渲染完成时的兜底尺寸
const PANEL_FALLBACK_HEIGHT = 210;

let dragState = null;                // 当前拖动上下文（球或面板）
let dragFrameId = 0;                 // rAF 句柄：同一帧只写一次 transform
let dragPendingPosition = null;      // 等待写入的位置
let dockElement = null;              // 缓存球容器，拖动中不逐帧 querySelector

// 位置夹取：**唯一入口**（拖动每帧、松手落位、落盘、恢复锚点、resize、面板定位全走它）。
// 语义：**整块留在视口内**（min=0，max=max(0, 视口 - 尺寸)）。
// 为什么不是"至少留 8px 可抓"：那样球能被拖到只剩一条边露在外面，松手/刷新再被夹回，
// 用户看到的是"被拉出去又跳回固定位置"。整块在内既不会丢，也不需要事后纠正。
// 视口比控件还小时 max 会小于 min：此时按 0 处理（贴左上角，至少能看见一部分）。
// 纯函数：不读全局状态，viewSize 缺省才用 window（单测里直接传）。
function clampDockPosition(left, top, size, viewSize) {
  const targetSize = size || { width: BALL_FALLBACK_SIZE_PX, height: BALL_FALLBACK_SIZE_PX };
  const view = viewSize || {
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
  };
  const maxLeft = Math.max(0, Number(view.width || 0) - Number(targetSize.width || 0));
  const maxTop = Math.max(0, Number(view.height || 0) - Number(targetSize.height || 0));
  return {
    left: Math.min(Math.max(Number(left) || 0, 0), maxLeft),
    top: Math.min(Math.max(Number(top) || 0, 0), maxTop),
  };
}

// 取球的实际尺寸（取不到就用兜底值）：夹取需要它算"至少留 8px"的下界
function readDockSize() {
  const floatDock = dockElement || findElement('#floatDock');
  const rect = floatDock ? floatDock.getBoundingClientRect() : null;
  if (!rect || !rect.width || !rect.height) {
    return { width: BALL_FALLBACK_SIZE_PX, height: BALL_FALLBACK_SIZE_PX };
  }
  return { width: rect.width, height: rect.height };
}

// 展开方向：锚点中心相对视口中心决定象限（照 ModelStage 的 placeForForm 口径）。
//   openLeft = 球在右半边 → 面板向左长、文本在球的左侧（朝视口内侧）
//   openUp   = 球在下半边 → 面板向上长
// 拖动松手、resize、恢复锚点后都要重算，否则拖到另一半屏后方向还是旧的。
function computeOpenDir(rect, viewSize) {
  const view = viewSize || { width: window.innerWidth, height: window.innerHeight };
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const openLeft = centerX >= view.width / 2;
  const openUp = centerY >= view.height / 2;
  return (openUp ? 'up' : 'down') + '-' + (openLeft ? 'left' : 'right');
}

// 把方向写到 DOM：CSS 用 [data-open-dir$="right"] 决定文本在球的哪一侧
function applyOpenDir(openDir) {
  const floatDock = findElement('#floatDock');
  if (floatDock && openDir) floatDock.dataset.openDir = openDir;
  if (typeof setDockOpenDir === 'function' && openDir) setDockOpenDir(openDir);
}

// 按球的当前实际位置重算方向（拖动中不调，松手/resize 才调：拖动中算会让文本左右跳）
function refreshOpenDir() {
  const floatDock = findElement('#floatDock');
  if (!floatDock) return '';
  const openDir = computeOpenDir(floatDock.getBoundingClientRect());
  applyOpenDir(openDir);
  return openDir;
}

// 面板尺寸：优先取实际渲染尺寸，取不到用兜底常量（夹取要按"当前形态"的尺寸算）
function readPanelSize() {
  const floatPanel = findElement('#floatPanel');
  const width = floatPanel && floatPanel.offsetWidth ? floatPanel.offsetWidth : PANEL_FALLBACK_WIDTH;
  const height = floatPanel && floatPanel.offsetHeight ? floatPanel.offsetHeight : PANEL_FALLBACK_HEIGHT;
  return { width, height };
}

// 面板相对球展开：**永远朝视口中心方向长**——
// 球在右半边就向左展开、在下半边就向上展开；写死一个方向必然有一半位置放不下。
// 位置最后统一过 clampDockPosition（同一套「整块在视口内」的语义）。
function positionPanel() {
  const floatPanel = findElement('#floatPanel');
  const floatDock = findElement('#floatDock');
  if (!floatPanel || !floatDock || floatPanel.classList.contains('hidden')) return;
  const dockRect = floatDock.getBoundingClientRect();
  const panelSize = readPanelSize();
  const openDir = (typeof getDockState === 'function' && getDockState().openDir) || computeOpenDir(dockRect);
  const openLeftwards = openDir.indexOf('left') >= 0;
  const openUpwards = openDir.indexOf('up') >= 0;
  const rawLeft = openLeftwards ? dockRect.right - panelSize.width : dockRect.left;
  const rawTop = openUpwards ? dockRect.top - panelSize.height - PANEL_GAP_PX : dockRect.bottom + PANEL_GAP_PX;
  const clamped = clampDockPosition(rawLeft, rawTop, panelSize);
  floatPanel.style.left = clamped.left + 'px';
  floatPanel.style.top = clamped.top + 'px';
}

function showPanel() {
  findElement('#floatPanel').classList.remove('hidden');
  positionPanel();
}

function hidePanel() {
  findElement('#floatPanel').classList.add('hidden');
}

// 锚点只从状态工厂读（R1：持久化与显示值的唯一真相源是 dock-state.js，视图不再自己读写 storage）
function readDockAnchor() {
  const dockState = typeof getDockState === 'function' ? getDockState() : null;
  const anchor = dockState && dockState.anchor;
  if (!anchor || typeof anchor.left !== 'number' || typeof anchor.top !== 'number') return null;
  // 恢复时也过一遍夹取：窗口比存的时候小了，旧锚点可能越界
  return clampDockPosition(anchor.left, anchor.top, readDockSize());
}

// 存锚点走状态工厂（内部负责持久化与通知）
function saveDockAnchor(anchor) {
  if (typeof setDockAnchor === 'function') setDockAnchor(anchor);
}

// 状态工厂的 anchor applier：装配方（dock.js）在 mount 时注册，由工厂 reapply 调用。
// 只负责"把值摆到 DOM 上"，不判断该不该摆（判断在工厂里）。
function applyDockAnchor(anchor) {
  const floatDock = findElement('#floatDock');
  if (!floatDock) return;
  if (!anchor) {
    // 没有锚点 = 从没拖过：保持骨架里的默认位置（右下角），不写死坐标
    floatDock.style.transform = '';
    return;
  }
  const clamped = clampDockPosition(anchor.left, anchor.top, readDockSize());
  commitDockPosition(clamped.left, clamped.top);
  refreshOpenDir();
}

// 落位：清 transform、写 left/top（只在松手/恢复锚点时发生）
function commitDockPosition(left, top) {
  const floatDock = findElement('#floatDock');
  if (!floatDock) return;
  floatDock.style.transform = '';
  floatDock.style.left = left + 'px';
  floatDock.style.top = top + 'px';
  positionPanel();
}

// 窗口尺寸变化后把球夹回视口：这条路径以前完全没人管，缩窗/换显示器后球会停在视口外，
// 表现为"球消失了"。夹完要落位 + 落盘，否则下次启动还是旧位置。
function reclampDockOnResize() {
  const floatDock = findElement('#floatDock');
  if (!floatDock) return;
  const rect = floatDock.getBoundingClientRect();
  const clamped = clampDockPosition(rect.left, rect.top, { width: rect.width, height: rect.height });
  const movedX = Math.round(clamped.left) !== Math.round(rect.left);
  const movedY = Math.round(clamped.top) !== Math.round(rect.top);
  if (!movedX && !movedY) return;
  commitDockPosition(clamped.left, clamped.top);
  saveDockAnchor({ left: Math.round(clamped.left), top: Math.round(clamped.top) });
  refreshOpenDir();
}

// 同一帧多次 pointermove 只写一次：球写 transform，面板写 left/top
function scheduleDockFrame(left, top) {
  dragPendingPosition = { left: left, top: top };
  if (dragFrameId) return;
  dragFrameId = requestAnimationFrame(function () {
    dragFrameId = 0;
    if (!dragPendingPosition || !dragState || !dockElement) return;
    const nextPosition = dragPendingPosition;
    const startRect = dragState.startRect;
    if (dragState.kind === 'panel') {
      const floatPanel = findElement('#floatPanel');
      if (floatPanel) {
        floatPanel.style.left = nextPosition.left + 'px';
        floatPanel.style.top = nextPosition.top + 'px';
      }
      return;
    }
    dockElement.style.transform = 'translate3d('
      + Math.round(nextPosition.left - startRect.left) + 'px, '
      + Math.round(nextPosition.top - startRect.top) + 'px, 0)';
  });
}

// 松手前把最后一帧立刻写出去：只 cancel 会丢掉最后一次 pointermove 的位移
function flushDockFrame() {
  if (dragFrameId) {
    cancelAnimationFrame(dragFrameId);
    dragFrameId = 0;
    if (dragPendingPosition && dragState && dockElement) {
      const nextPosition = dragPendingPosition;
      const startRect = dragState.startRect;
      if (dragState.kind === 'panel') {
        const floatPanel = findElement('#floatPanel');
        if (floatPanel) {
          floatPanel.style.left = nextPosition.left + 'px';
          floatPanel.style.top = nextPosition.top + 'px';
        }
      } else {
        dockElement.style.transform = 'translate3d('
          + Math.round(nextPosition.left - startRect.left) + 'px, '
          + Math.round(nextPosition.top - startRect.top) + 'px, 0)';
      }
    }
  }
  dragPendingPosition = null;
}

// 拖拽：超过阈值才算拖动；球没被拖动时松手视为点击，切换面板开合
function initDrag() {
  const floatDock = findElement('#floatDock');
  dockElement = floatDock;             // 缓存给 rAF 回调，拖动中不再 querySelector
  const floatBall = findElement('#floatBall');
  const floatPanel = findElement('#floatPanel');
  const panelHead = findElement('#fpHead');

  // 锚点恢复不在这里做：initDrag 早于 store 创建，读不到 state.anchor；
  // 由首帧渲染后的 applyStoredAnchorOnce() 统一落位（见下）。

  floatBall.addEventListener('pointerdown', function (event) {
    event.preventDefault();
    // 这里只记录"按下时面板是开还是关"，不立刻收起：
    // 立刻收起会让 pointerup 的 toggle 永远走"展开"，点球就收不起来了（只能重复展开）。
    dragState = {
      kind: 'ball',
      startX: event.clientX,
      startY: event.clientY,
      startRect: floatDock.getBoundingClientRect(),
      panelWasOpen: !floatPanel.classList.contains('hidden'),
      moved: false,
      last: null
    };
    try { floatDock.setPointerCapture(event.pointerId); } catch (error) { /* 捕获失败不影响拖动 */ }
  });

  panelHead.addEventListener('pointerdown', function (event) {
    if (event.target.closest('.fp-btn')) return;
    event.preventDefault();
    dragState = {
      kind: 'panel',
      startX: event.clientX,
      startY: event.clientY,
      startRect: floatPanel.getBoundingClientRect(),
      moved: false
    };
  });

  document.addEventListener('pointermove', function (event) {
    if (!dragState) return;
    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;
    if (!dragState.moved) {
      if (Math.abs(deltaX) + Math.abs(deltaY) <= DRAG_THRESHOLD_PX) return;
      dragState.moved = true;
      floatDock.classList.add('is-dragging');
      // 真正进入拖动才收起面板：球动而面板停在原地会显得"拖不动"
      if (dragState.kind === 'ball' && dragState.panelWasOpen) hidePanel();
    }

    if (dragState.kind === 'panel') {
      // 面板也按"自己尺寸"整块留在视口内（与球同一函数、不同尺寸）
      const clampedPanel = clampDockPosition(
        dragState.startRect.left + deltaX,
        dragState.startRect.top + deltaY,
        { width: dragState.startRect.width, height: dragState.startRect.height },
      );
      dragState.last = clampedPanel;
      scheduleDockFrame(clampedPanel.left, clampedPanel.top);
      return;
    }

    // 拖动每帧都夹：不夹的话球能被拖到视口外，且落盘后刷新也找不回来
    const clampedPosition = clampDockPosition(
      dragState.startRect.left + deltaX,
      dragState.startRect.top + deltaY,
      { width: dragState.startRect.width, height: dragState.startRect.height },
    );
    dragState.last = clampedPosition;
    scheduleDockFrame(clampedPosition.left, clampedPosition.top);
  });

  document.addEventListener('pointerup', function () {
    if (!dragState) return;
    const finishedDrag = dragState;
    dragState = null;
    floatDock.classList.remove('is-dragging');
    // 没超过阈值 = 点击：按"按下时"的状态切换，开着就关、关着就开
    if (!finishedDrag.moved) {
      if (finishedDrag.panelWasOpen) hidePanel(); else showPanel();
      return;
    }
    flushDockFrame();                    // 最后一帧不能丢，否则手感"差一点"
    if (finishedDrag.kind !== 'ball') return;
    const rawPosition = finishedDrag.last || { left: finishedDrag.startRect.left, top: finishedDrag.startRect.top };
    // 落位与落盘各夹一次：落位影响视觉，落盘影响下次启动；两处都用同一口径
    const committed = clampDockPosition(rawPosition.left, rawPosition.top, readDockSize());
    commitDockPosition(committed.left, committed.top);
    saveDockAnchor({ left: Math.round(committed.left), top: Math.round(committed.top) });
    // 松手才重算方向：拖动中算会让文本在球的左右来回跳
    refreshOpenDir();
    positionPanel();
  });
}

// 面板按钮：收起 / 关闭整个悬浮窗 / 进群聊，以及关闭后的召回
function initFloatControls() {
  findElement('#fpMin').addEventListener('click', hidePanel);
  findElement('#fpClose').addEventListener('click', function () {
    hidePanel();
    findElement('#floatDock').classList.add('hidden');
    findElement('#floatRecall').classList.remove('hidden');
  });
  findElement('#floatRecall').addEventListener('click', function () {
    findElement('#floatDock').classList.remove('hidden');
    findElement('#floatRecall').classList.add('hidden');
    showPanel();
  });
  findElement('#fpEnter').addEventListener('click', function () {
    hidePanel();
    openChat(state.currentGroupId);
    // 进入主窗口后把焦点移出输入控件：否则焦点会落在群列表搜索框上，移动端直接弹键盘
    const activeElement = document.activeElement;
    if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
      activeElement.blur();
    }
  });
  // 面板标题左侧「👤 我的模型团队」：点击打开主窗口并进数据库页（契约条款 2）
  findElement('#fpTitle').addEventListener('click', function () {
    hidePanel();
    const timApp = findElement('#timApp');
    if (timApp) timApp.hidden = false;
    switchView('profile');
  });
  // 悬浮窗里的通讯录入口（左侧边栏入口在顶栏，两者都通）
  findElement('#btnContacts').addEventListener('click', function () {
    hidePanel();
    switchView('contacts');
  });
  // 窗口尺寸变化：先重夹球（缩窗后球可能整个跑到视口外），再重摆面板
  window.addEventListener('resize', function () {
    reclampDockOnResize();
    positionPanel();
  });
}

// 悬浮球/面板显示的当前目标：单模型 → 模型名（过长截断），分组 → @分组名，未设置 → —
const BALL_TARGET_MAX_CHARS = 9;


// 悬浮窗渲染（契约 §4.4）：所有显示值都从 state 派生，没有"补丁式"单独刷新函数。
// 由 renderApp() 调用——同一个渲染出口，事件广播后自动重放。
// 首帧后按 state.anchor 落位一次：initDrag 早于 store 创建，读不到锚点，所以放到渲染后做
let anchorApplied = false;

function applyStoredAnchorOnce() {
  if (anchorApplied) return;
  const restoredAnchor = readDockAnchor();
  if (!restoredAnchor) return;
  anchorApplied = true;
  commitDockPosition(restoredAnchor.left, restoredAnchor.top);
}

// 悬浮窗文本统一走这里：空值一律落回占位符（禁止空字符串），元素缺失走 store.reportError
// （契约 §8：找不到元素属于"代码 bug 类"，不能静默跳过，否则某次渲染后就永远不更新）
const FLOAT_PLACEHOLDER = '—';

// 目标行专用：名称 + 可选的浅色来源提示（「继承上一会话」等）
function setFloatTarget(selector, label, hint) {
  const node = findElement(selector);
  if (!node) {
    if (store && typeof store.reportError === 'function') {
      store.reportError('float', '缺少元素 ' + selector);
    }
    return;
  }
  const name = String(label == null ? '' : label).trim() || FLOAT_PLACEHOLDER;
  node.innerHTML = escapeHtml(name)
    + (hint ? '<span class="fp-target-source">' + escapeHtml(hint) + '</span>' : '');
}

function setFloatText(selector, value, fallback) {
  const node = findElement(selector);
  if (!node) {
    if (store && typeof store.reportError === 'function') {
      store.reportError('float', '缺少元素 ' + selector);
    }
    return;
  }
  const text = value == null ? '' : String(value).trim();
  node.textContent = text || (fallback || FLOAT_PLACEHOLDER);
}

// 面板五个字段的最终文案（纯函数：不读 DOM、不读 store）。
// 抽出来是为了让 check-render 能在 node:vm 里直接断言「五字段非空且不是加载中」，
// 而不需要起浏览器、也不需要宿主的 projection。float.js 的 DOM 写入与门禁共用这一份。
function buildPanelFieldTexts(values) {
  const source = values || {};
  const trimmed = function (value) {
    return value == null ? '' : String(value).trim();
  };
  return {
    fpGroup: trimmed(source.groupName) || FLOAT_PLACEHOLDER,
    fpSession: trimmed(source.sessionLabel) || FLOAT_PLACEHOLDER,
    fpTarget: trimmed(source.targetLabel) || FLOAT_PLACEHOLDER,
    fpRate: trimmed(source.rate) || (FLOAT_PLACEHOLDER + ' tok/s'),
    fpTotal: trimmed(source.globalText) || FLOAT_PLACEHOLDER,
  };
}

// 会话行：有标题显示「标题（短 id）」，没标题只显示短 id，没有会话显示 —
// 短 id 取「去掉 session- 前缀后的前 8 位」——直接取原串前 8 位会永远是 "session-"，无法区分会话
function formatSessionLabel(current) {
  const sessionId = current && current.sessionId;
  if (!sessionId) return FLOAT_PLACEHOLDER;
  const shortId = String(sessionId).replace(/^session-/, '').slice(0, 8);
  const title = current.sessionTitle;
  return title ? title + '（' + shortId + '）' : shortId;
}

// ≈ 前缀是"下界"的唯一信号：光看数字看不出为什么偏低，补一条 title 说明分母口径。
// 精确值不带 title —— 别让用户觉得"这个数也可能不准"。
const RATE_APPROX_MARK = '≈';
const RATE_APPROX_HINT = '≈ 为下界：这次没记录首字时刻，按整步平均算（含首字等待）';

function applyRateHint(rateText) {
  const rateNode = findElement('#fpRate');
  if (!rateNode) return;
  if (rateText && rateText.indexOf(RATE_APPROX_MARK) === 0) {
    rateNode.setAttribute('title', RATE_APPROX_HINT);
  } else {
    rateNode.removeAttribute('title');
  }
}

function renderFloat(current, activePlatform) {
  applyStoredAnchorOnce();
  if (!current) return;
  const label = targetLabel();

  // 球内显示"接活平台"的头像/首字母（G6）：不再显示模型名文字，溢出问题从设计上消失。
  // data-fb-target 是 docs/03 §2.1 的 DOM 钩子，必须保留这个容器与属性名。
  const ballTarget = findElement('#floatBall [data-fb-target]');
  if (ballTarget) ballTarget.innerHTML = renderFloatTargetMarkup(activePlatform);

  // 图不承载语义：title / aria-label 兜住"目标名 · 平台名"，否则读屏只剩一个装饰圆
  const ball = findElement('#floatBall');
  if (ball) {
    const platformName = activePlatform && activePlatform.name ? String(activePlatform.name) : '';
    const accessibleLabel = platformName ? label + ' · ' + platformName : label;
    ball.setAttribute('title', accessibleLabel);
    ball.setAttribute('aria-label', accessibleLabel);
  }
  setFloatText('#fpModel', '模型 ' + label);
  setFloatText('#floatPill .pill-model', '( ' + label + ' )');

  const activeGroup = currentGroup();
  // 五字段文案统一由纯函数算（check-render 断言的就是这一份），这里只负责写进 DOM
  const panelFieldTexts = buildPanelFieldTexts({
    groupName: activeGroup ? activeGroup.name : '',
    sessionLabel: formatSessionLabel(current),
    targetLabel: label,
    rate: current.rate,
    globalText: current.global && current.global.text,
  });
  setFloatText('#fpGroup', panelFieldTexts.fpGroup);
  setFloatText('#fpSession', panelFieldTexts.fpSession);
  setFloatTarget('#fpTarget', panelFieldTexts.fpTarget, targetSourceHint());
  setFloatText('#fpRate', panelFieldTexts.fpRate);
  applyRateHint(panelFieldTexts.fpRate);
  setFloatText('#fpTotal', panelFieldTexts.fpTotal);
}
// app.js —— 视图层：只读 store 状态 + 渲染 + 事件委托。所有写入走 store.dispatch（契约 docs/13）。
// 渲染只有一个出口 renderApp(state)：由 store 在事件广播后调用；视图内的"我还想重画"用 store.render()。

var store = null;                          // boot 时创建
var state = null;                          // store.getState() 的只读引用（视图取值用）
var viewState = {                          // 纯 UI 局部状态（表单草稿 / @ 选择器 / 搜索词），不参与业务真相
  addForm: { platformId: '', name: '', values: {} },   // platformId 对应 /_team/platforms 里的平台
  // 模型目录（只在加群页用，不进全局 store）：mode=auto 提交走 endpoint，manual 提交走 static
  modelCatalog: { mode: 'auto', models: [], probe: { loading: false, error: '' } },
  atPicker: { open: false, activeIndex: 0, triggerIndex: -1, items: [] },
  groupFilter: ''
};

// ---------------------------------------------------------------- 基础工具
const CLOCK_PAD_WIDTH = 2;
const TOAST_VISIBLE_MS = 2200;

function findElement(selector) { return document.querySelector(selector); }
function findElements(selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); }

function nowTime() {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(function (value) { return String(value).padStart(CLOCK_PAD_WIDTH, '0'); }).join(':');
}

function toast(text) {
  // 宿主壳不保证带 #toast 节点（实测：全仓没有任何地方创建它，导致所有提示静默丢失）。
  // 这里懒创建：样式在 ui/css/panels.css 的 .toast，挂到 body 上即可用。
  let toastNode = findElement('#toast');
  if (!toastNode) {
    toastNode = document.createElement('div');
    toastNode.id = 'toast';
    toastNode.className = 'toast';
    document.body.appendChild(toastNode);
  }
  toastNode.textContent = text;
  toastNode.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(function () { toastNode.classList.remove('show'); }, TOAST_VISIBLE_MS);
}

function showModal(title, bodyHtml) {
  const modalMask = document.createElement('div');
  modalMask.className = 'modal-mask';
  modalMask.innerHTML = `<div class="modal">
    <div class="modal-head"><span>${escapeHtml(title)}</span><button class="modal-close" id="modalClose" type="button">×</button></div>
    <div class="modal-body">${bodyHtml}</div>
  </div>`;
  document.body.appendChild(modalMask);
  findElement('#modalClose').addEventListener('click', function () { modalMask.remove(); });
  modalMask.addEventListener('click', function (event) {
    if (event.target === modalMask) modalMask.remove();
  });
  // 交回遮罩节点：调用方要往弹窗里装表单、重画正文（好友分组表单就这么用）
  return modalMask;
}

// ---------------------------------------------------------------- 读取辅助（只读 state）
function ensureState() {
  if (!state && store) state = store.getState();
  return state;
}

function currentGroup() {
  const current = ensureState();
  if (!current) return null;
  return current.groups.filter(function (group) { return group.id === current.currentGroupId; })[0] || current.groups[0] || null;
}
function currentMessages() {
  const current = ensureState();
  return (current && current.messages[current.currentGroupId]) || [];
}
function modelsOf(groupId) {
  const current = ensureState();
  return (current && current.models[groupId]) || [];
}
// 「接活平台」= effectiveTarget 所属群对应的平台（不是当前打开的群）。
// 为什么要在渲染出口算：球上的头像代表"这次请求会发给谁"，目标切到别的群时头像必须跟着走；
// 在 float.js 里重新推导一遍群列表会与这里形成第二个真相源。
function activePlatformInfo(current) {
  const target = current && current.effectiveTarget;
  if (!target) return null;
  if (target.type === 'model' && target.platformId) {
    const targetGroup = (current.groups || []).filter(function (group) {
      return group.id === target.platformId;
    })[0];
    return platformOf(targetGroup);
  }
  // 分组跨平台，没有唯一平台：给一个中性名字，首字母牌显示「好」
  if (target.type === 'group') return { avatar: '', name: '好友分组' };
  return null;
}

function platformOf(group) {
  const current = ensureState();
  if (!group || !current) return null;
  // GET /_team/groups 的驱动字段名是 driver（契约 02 §3.1：写入与读出同名）；
  // 旧代码只读 driverId → 平台名恒空、球内字母牌回落成 "?"。两处都认，避免再被字段名绊一次。
  const driverKey = group.driverId || group.driver;
  const drivers = (current && current.drivers) || [];
  const driver = drivers.filter(function (item) { return item.id === driverKey; })[0];
  return {
    avatar: group.avatar || (driver ? driver.avatar : '[G]'),
    // 驱动名形如「OpenAI 兼容（配置型）」：去掉全角/半角括号里的补充说明，只留主名
    name: driver ? String(driver.name).split(/[（(]/)[0].trim() : (driverKey || '')
  };
}
// 目标文案：分组 → @分组名；单模型 → 模型名（去 global: 前缀）；空 → —
// 目标显示名：用「实际生效的目标」（effectiveTarget），不是本会话显式绑定的 target。
// 否则新会话（未绑定）会出现"面板有目标、球是 —"的不一致。
function targetLabel() {
  const current = ensureState();
  const target = current && (current.effectiveTarget || current.target);
  if (!target) return '—';
  if (target.type === 'group') {
    const matched = current.friendGroups.filter(function (friendGroup) { return friendGroup.id === target.id; })[0];
    return '@' + (matched ? matched.name : target.id);
  }
  const modelId = String(target.id || target.model || '').replace(/^global:/, '');
  return modelId || '—';
}

// 来源提示：只有「本会话没显式绑定、由后端回落」时才显示（浅色小字，跟在目标名后面）。
// 文案映射与请求卡片共用 ui/js/target-source.js，两处各写一份必然漂移。
function targetSourceHint() {
  const current = ensureState();
  if (!current || !current.effectiveTarget) return '';
  if (current.target) return '';                       // 显式绑定过 → 不带提示
  return targetSourceHintOf(current.targetSource);
}

// ---------------------------------------------------------------- 渲染（唯一出口）
// options.keepChatScroll：展开请求行时保持聊天区滚动位置
function renderApp(nextState, options) {
  if (nextState) state = nextState;
  const current = ensureState();
  if (!current) return;

  const viewRoot = findElement('#viewRoot');
  if (!viewRoot) return;
  const viewName = findElement('#viewName');
  const previousStream = findElement('#chatStream');
  const keptScrollTop = options && options.keepChatScroll && previousStream ? previousStream.scrollTop : null;

  if (current.view === 'chat' && !current.currentGroupId) {
    viewRoot.innerHTML = '<div class="loading">正在加载会话…</div>';
    return;
  }

  if (current.view === 'list') {
    const keyword = (viewState.groupFilter || '').trim().toLowerCase();
    const visibleGroups = keyword
      ? current.groups.filter(function (group) {
        return [group.name, group.summary, group.driver, group.id].join(' ').toLowerCase().indexOf(keyword) >= 0;
      })
      : current.groups;

    // 焦点只在"本来就在搜索框里"时恢复：不能无条件 focus，
    // 否则每次进群聊界面都会把焦点塞进搜索框（移动端直接弹键盘）。
    const activeElement = document.activeElement;
    const hadSearchFocus = !!activeElement && activeElement.id === 'groupSearch';
    const caretStart = hadSearchFocus ? activeElement.selectionStart : null;
    const caretEnd = hadSearchFocus ? activeElement.selectionEnd : null;

    viewRoot.innerHTML = renderGroupList(
      visibleGroups,
      current.currentGroupId,
      viewState.groupFilter || '',
      { loadError: current.lastGroupsError || (current.groups && current.groups.length ? '' : '') },
    );

    if (hadSearchFocus) {
      const searchInput = findElement('#groupSearch');
      if (searchInput) {
        searchInput.focus();
        // 光标位置原样恢复：直接 focus 会把光标甩到末尾，连续输入时体验很差
        if (caretStart !== null && caretEnd !== null) searchInput.setSelectionRange(caretStart, caretEnd);
      }
    }
    viewName.textContent = '消息';
  } else if (current.view === 'chat') {
    const activeGroup = currentGroup();
    viewRoot.innerHTML = renderChat(
      activeGroup,
      modelsOf(activeGroup.id),
      currentMessages(),
      platformOf(activeGroup),
      current.modelsStatus ? current.modelsStatus[activeGroup.id] : undefined,
    );
    viewName.textContent = '群聊';
  } else if (current.view === 'add') {
    viewRoot.innerHTML = renderAddGroup(
      current.platforms,
      current.drivers,
      viewState.addForm.platformId,
      viewState.addForm.values,
      viewState.addForm.name,
      viewState.modelCatalog
    );
    viewName.textContent = '加群';
  } else if (current.view === 'contacts') {
    // 成员头像/来自谁只跟平台群有关（member.platformId 是群 id），不再传 drivers
    viewRoot.innerHTML = renderAddressBook(current.friendGroups, current.groups);
    viewName.textContent = '通讯录';
  } else {
    viewRoot.innerHTML = renderProfile(current.groups);
    viewName.textContent = '我的';
  }

  const chatStream = findElement('#chatStream');
  if (chatStream) chatStream.scrollTop = keptScrollTop == null ? chatStream.scrollHeight : keptScrollTop;

  // 悬浮窗（球/标题/目标/pill/统计）也由同一个渲染出口派生，不再有"手动补丁"函数
  renderFloat(current, activePlatformInfo(current));
  renderTabs(current);
}

// 主题契约自检（docs/18 §5.2）：换主题时立刻知道漏了哪个钩子。
// 缺失只 console.error + 记入 store 错误出口，不阻断启动。
const THEME_CONTRACT_SELECTORS = [
  '#floatDock', '#floatBall', '#floatPanel',
  '#fpSession', '#fpModel', '#fpTarget', '#fpRate', '#fpTotal', '#fpEnter',
  '#viewRoot', '.team-app', '.team-tabbar', '.team-tab[data-view]'
];

function assertThemeContract() {
  const missing = THEME_CONTRACT_SELECTORS.filter(function (selector) {
    return !document.querySelector(selector);
  });
  if (!missing.length) return missing;
  const message = '主题契约缺少元素：' + missing.join('、');
  if (typeof console !== 'undefined' && typeof console.error === 'function') {
    console.error('[dsh-model-team] ' + message);
  }
  if (store && typeof store.reportError === 'function') store.reportError('theme', message);
  return missing;
}

// 底边栏选中态：chat/add 都归到「消息」tab，其余按 view 一一对应（契约条款 22）
const TAB_VIEW_BY_STATE = { list: 'list', chat: 'list', add: 'list', contacts: 'contacts', profile: 'profile' };

function renderTabs(current) {
  const activeTabView = TAB_VIEW_BY_STATE[current.view] || 'list';
  findElements('.team-tab').forEach(function (tab) {
    tab.setAttribute('aria-selected', tab.dataset.view === activeTabView ? 'true' : 'false');
  });
}

// ---------------------------------------------------------------- 视图动作（只发 dispatch）
function switchView(nextView) {
  closeAtPop();
  store.dispatch({ type: 'open-view', view: nextView });
}

function openChat(groupId) {
  closeAtPop();
  store.dispatch({ type: 'open-view', view: 'chat', groupId: groupId });
}

function rerender() {
  if (store) store.render();
}

// ---------------------------------------------------------------- 事件委托
// 全部挂在稳定的容器上：#viewRoot（视图内容）+ .team-tabbar（底边栏），render() 重建内容后无需重绑
function initViewEvents() {
  const viewRoot = findElement('#viewRoot');

  // 头像图片加载失败（404 / 域名不可达）→ 降级为文本占位，避免出现破图。
  // error 事件不冒泡，必须用捕获阶段监听；节点由 renderAvatar() 生成（带 data-fallback）。
  document.addEventListener('error', function (event) {
    const failedImage = event.target;
    if (!failedImage || failedImage.tagName !== 'IMG' || !failedImage.classList.contains('avatar-img')) return;
    const fallback = document.createElement('span');
    fallback.className = 'avatar-fallback';
    fallback.textContent = failedImage.dataset.fallback || '?';
    if (failedImage.parentNode) failedImage.parentNode.replaceChild(fallback, failedImage);
  }, true);

  // 底边栏三 tab：点击即切视图（契约条款 21-24）；顶栏不再有通讯录/数据库按钮
  const tabBar = findElement('.team-tabbar');
  if (tabBar) {
    tabBar.addEventListener('click', function (event) {
      const tab = event.target.closest('.team-tab');
      if (!tab || !tab.dataset.view) return;
      store.dispatch({ type: 'open-view', view: tab.dataset.view });
    });
  }

  viewRoot.addEventListener('click', function (event) {
    // 点消息流头像 = 快捷插入 @名字
    const mentionAvatar = event.target.closest('[data-mention]');
    if (mentionAvatar) {
      const messageInput = findElement('#msgInput');
      if (messageInput) {
        messageInput.value = messageInput.value.replace(/@[^\s]*$/, '') + '@' + mentionAvatar.dataset.mention + ' ';
        messageInput.focus();
        closeAtPop();
      }
      return;
    }
    const requestBubble = event.target.closest('.req-bubble');
    if (requestBubble) {
      const rowIndex = Number(requestBubble.dataset.rowIndex);
      store.dispatch({ type: 'toggle-row', groupId: state.currentGroupId, rowIndex: rowIndex })
        .then(function () {
          renderApp(null, { keepChatScroll: true });
          const expandedBubble = findElement('.req-bubble[data-row-index="' + rowIndex + '"]');
          if (expandedBubble && expandedBubble.getAttribute('aria-expanded') === 'true') {
            expandedBubble.scrollIntoView({ block: 'nearest' });
          }
        });
      return;
    }
    const groupItem = event.target.closest('.group-item');
    if (groupItem) { openChat(groupItem.dataset.groupId); return; }
    // 通讯录：新建 / 编辑好友分组都走同一个弹窗（表单与校验在 friend-group-form.js）
    if (event.target.closest('#btnCreateGroup')) { openFriendGroupModal('create', null); return; }
    const editGroupButton = event.target.closest('[data-edit-group]');
    if (editGroupButton) {
      const friendGroupsNow = (ensureState() || { friendGroups: [] }).friendGroups;
      const editingFriendGroup = friendGroupsNow.filter(function (friendGroup) {
        return friendGroup.id === editGroupButton.dataset.editGroup;
      })[0];
      if (editingFriendGroup) openFriendGroupModal('edit', editingFriendGroup);
      return;
    }
    const atItem = event.target.closest('.at-item');
    if (atItem) {
      const picked = viewState.atPicker.items[Number(atItem.dataset.index)];
      if (picked) insertMention(picked);
      return;
    }

    // 模型目录：删行
    const removeModelButton = event.target.closest('[data-model-remove]');
    if (removeModelButton) {
      removeModelRow(Number(removeModelButton.dataset.modelRemove));
      return;
    }

    const clickedButton = event.target.closest('button');
    const buttonId = clickedButton ? clickedButton.id : '';
    if (buttonId === 'btnProbeModels') { probeModelCatalog(); return; }
    if (buttonId === 'btnResetModels') { resetModelCatalog(); return; }
    if (buttonId === 'btnReloadGroups') { store.dispatch({ type: 'load-groups' }); return; }
    if (buttonId === 'btnAddModelRow') { addModelRow(); return; }
    if (buttonId === 'btnAddGroup') switchView('add');
    else if (buttonId === 'btnChatBack' || buttonId === 'btnAddBack' || buttonId === 'btnDatabaseBack' || buttonId === 'btnContactsBack') switchView('list');
    else if (buttonId === 'btnAt') {
      const messageInput = findElement('#msgInput');
      if (messageInput) { messageInput.focus(); openAtPop(); }
    }
    else if (buttonId === 'btnSend') sendMessage();
    else if (buttonId === 'btnSubmitGroup') submitNewGroup();
    else if (buttonId === 'btnExport') exportDatabase();
    else if (buttonId === 'btnImport') importDatabase();
  });

  viewRoot.addEventListener('input', function (event) {
    const target = event.target;
    // 模型目录行：就地更新数据，不重渲染（否则输入框会失焦）
    if (target.dataset && target.dataset.modelId !== undefined) {
      const modelIndex = Number(target.dataset.modelId);
      if (viewState.modelCatalog.models[modelIndex]) {
        viewState.modelCatalog.models[modelIndex].id = target.value;
        viewState.modelCatalog.mode = 'manual';
      }
      return;
    }
    if (target.dataset && target.dataset.modelName !== undefined) {
      const nameIndex = Number(target.dataset.modelName);
      if (viewState.modelCatalog.models[nameIndex]) {
        viewState.modelCatalog.models[nameIndex].name = target.value;
      }
      return;
    }
    if (target.id === 'msgInput') syncAtByInput(target);
    else if (target.id === 'groupSearch') {
      viewState.groupFilter = target.value;
      rerender();
    }
    else if (target.id === 'groupNameInput') viewState.addForm.name = target.value;
    else if (target.dataset && target.dataset.authKey) viewState.addForm.values[target.dataset.authKey] = target.value;
  });

  viewRoot.addEventListener('change', function (event) {
    if (event.target.id === 'platformSelect') {
      // 切换平台：清掉上一平台填过的值，让 renderAddGroup 用新平台的默认值重新预填；
      // 模型目录也重置（模型属于平台，不能沿用上一个平台的目录）
      viewState.addForm.platformId = event.target.value;
      viewState.addForm.values = {};
      viewState.addForm.name = '';
      viewState.modelCatalog = { mode: 'auto', models: [], probe: { loading: false, error: '' } };
      rerender();
      return;
    }
    const authFieldKey = event.target.dataset ? event.target.dataset.authKey : '';
    if (authFieldKey && event.target.tagName === 'SELECT') {
      viewState.addForm.values[authFieldKey] = event.target.value;
      rerender();
    }
  });

  viewRoot.addEventListener('submit', function (event) {
    if (event.target.id === 'addGroupForm') {
      event.preventDefault();
      submitNewGroup();
    }
  });

  // Enter 发送 / Shift+Enter 换行；@ 选择器打开时 Enter 上屏选中项
  viewRoot.addEventListener('keydown', function (event) {
    if (event.target.id !== 'msgInput') return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (viewState.atPicker.open) {
        const pickedItem = viewState.atPicker.items[viewState.atPicker.activeIndex];
        if (pickedItem) insertMention(pickedItem);
        return;
      }
      sendMessage();
      return;
    }
    if (!viewState.atPicker.open) return;
    const pickerItems = viewState.atPicker.items;
    if (!pickerItems.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      viewState.atPicker.activeIndex = (viewState.atPicker.activeIndex + 1) % pickerItems.length;
      syncAtActive();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      viewState.atPicker.activeIndex = (viewState.atPicker.activeIndex - 1 + pickerItems.length) % pickerItems.length;
      syncAtActive();
    } else if (event.key === 'Escape') {
      closeAtPop();
    }
  });
}

// ---------------------------------------------------------------- 启动
function boot() {
  if (window.__dshModelTeamBooted) return;
  window.__dshModelTeamBooted = true;

  initDrag();
  initFloatControls();
  initViewEvents();

  store = createTeamStore({
    api: api,
    storage: {
      read: function (key) { return window.localStorage.getItem(key); },
      write: function (key, value) { window.localStorage.setItem(key, value); }
    },
    // 会话 id 由槽位桥（apply.js 注册的 SessionBridge）推进来，不做任何轮询
    sessionSource: null,
    onRender: function (nextState) { renderApp(nextState); }
  });
  window.__teamStore = store;            // 供验收脚本读取 errors / state

  const viewRoot = findElement('#viewRoot');
  if (viewRoot) viewRoot.innerHTML = '<div class="loading">正在加载模型团队数据…</div>';

  store.dispatch({ type: 'start' }).then(function () {
    const current = store.getState();
    // 默认选中第一项：优先平台预置（preset:<id>），没有预置则用第一个驱动的通用入口（driver:<id>）
    if (!viewState.addForm.platformId) {
      if (current.platforms.length) viewState.addForm.platformId = 'preset:' + current.platforms[0].id;
      else if (current.drivers.length) viewState.addForm.platformId = 'driver:' + current.drivers[0].id;
    }
    assertThemeContract();   // 启动后自检一次主题契约
  });
}

document.addEventListener('DOMContentLoaded', boot);
// dock.js —— 把 ui/ 的界面装进宿主：DOM 骨架由 build.cjs 从 ui/index.html 抽取并内联，
// 交互与渲染全部复用 ui/js/*。这里只做三件事：注入骨架、把主窗口默认收起、点「进入群聊界面」时显示主窗口并触发 boot。
// 注意：不要在本地再维护一份骨架字符串——改 ui/index.html 后重跑 node build.cjs 即可。

// 重复挂载保护：宿主 HMR / 重复 apply 时可能已经挂过一份骨架。
// 关键：**复用已有 DOM**，而不是清掉重建——重建出来的新节点没有监听、也不在渲染链路里，
// 会一直停在初始占位（真机表现就是"切会话后面板空白"）。只有旧节点已不在文档里时才重建。
function mountUiDom() {
  var existingHost = document.querySelector(".dmt-host");
  if (existingHost && document.getElementById("floatDock")) {
    mountStyle();
    return existingHost;
  }
  // 孤儿节点（宿主清过 body 但残留单个 #floatDock）：先清掉，保证全局只有一份
  var orphanDock = document.getElementById("floatDock");
  if (orphanDock && orphanDock.parentNode) orphanDock.parentNode.removeChild(orphanDock);

  var host = document.createElement("div");
  host.className = "dmt-host";
  host.innerHTML = UI_SKELETON_HTML;

  // 宿主差异适配：预览页里主窗口常驻，插件里默认收起并给一个「× 收起」按钮
  var timApp = host.querySelector(".team-app");
  if (timApp) {
    timApp.id = "timApp";
    timApp.hidden = true;
  }
  var toolBar = host.querySelector(".team-bar");
  if (toolBar) {
    var closeButton = document.createElement("button");
    closeButton.id = "btnCloseApp";
    closeButton.type = "button";
    closeButton.className = "team-bar-btn";
    closeButton.textContent = "× 收起";
    toolBar.appendChild(closeButton);
  }

  document.body.appendChild(host);
  mountStyle();
  return host;
}

// 主窗口显隐：ui 的主窗口在预览页是常驻的，宿主里默认收起
function showAppWindow() {
  var timApp = document.getElementById("timApp");
  if (!timApp) return;
  timApp.hidden = false;
}

// ui 自己的 fpEnter 会调 openChat(currentGroupId)，空会话时进不去群聊；
// 这里延后一拍再切回群列表，保证「进入群聊界面」落地就是列表视图
function enterListView() {
  showAppWindow();
  setTimeout(function () {
    if (typeof switchView === "function") switchView("list");
  }, 0);
}

function mountDock() {
  mountStyle();
  var host = mountUiDom();
  dockMountedHost = host;
  // 装配：把"写 DOM"的两个动作注册给状态工厂（显隐 + 位置），随后由工厂 reapply 统一落地。
  // 这样判定发生在 mount 之前也不会丢——工厂记着值，mount 后重放一次即可。
  registerDockAppliers({
    visibility: setDockVisibility,
    anchor: function (anchor) {
      if (typeof applyDockAnchor === "function") applyDockAnchor(anchor);
    },
  });
  // 默认隐藏：首帧 projection 还没到，先不显示；由槽位桥判定后显式打开（降级路径见 apply.js）
  setDockVisible(false);
  reapplyDockDom();
  // meta 是异步拉的（契约 02 §2.9，启动取一次）：到达后由 session-bridge 的重算入口落地显隐
  loadTeamMetaWithRetry();

  var appBooted = false;
  function bootUiOnce() {
    if (appBooted) return;
    appBooted = true;
    resolveSessionId().then(function (sessionId) {
      MOCK_SESSION_ID = sessionId;          // ui 分片靠这个名字取会话
      if (typeof boot === "function") boot(); // app.js：拉数据 + initFloatStats + render
    });
  }
  bootUiOnce();

  var enterButton = document.getElementById("fpEnter");
  var contactsButton = document.getElementById("btnContacts");
  var closeAppButton = document.getElementById("btnCloseApp");
  function onEnter() { enterListView(); }
  function onContacts() { showAppWindow(); if (typeof switchView === "function") switchView("contacts"); }
  function onCloseApp() { hideAppWindow(); }
  if (enterButton) enterButton.addEventListener("click", onEnter);
  if (contactsButton) contactsButton.addEventListener("click", onContacts);
  if (closeAppButton) closeAppButton.addEventListener("click", onCloseApp);

  return {
    dispose: function () {
      if (enterButton) enterButton.removeEventListener("click", onEnter);
      if (contactsButton) contactsButton.removeEventListener("click", onContacts);
      if (closeAppButton) closeAppButton.removeEventListener("click", onCloseApp);
      var styleTag = document.querySelector('style[data-plugin-css="' + CLIENT_STYLE_ID + '"]');
      if (styleTag) styleTag.remove();
      host.remove();
    }
  };
}

function hideAppWindow() {
  var timApp = document.getElementById("timApp");
  if (timApp) timApp.hidden = true;
}

// INV-14：悬浮窗（球 + 面板 + 呼出条）整体显隐。
// 只是切 display，不动 DOM、不销毁监听：反复切换不会重启 UI、也不会丢事件（挂载生命周期保持不变）。
var dockMountedHost = null;

// 只切换**球**的显隐，不碰整个宿主容器：.dmt-host 里还装着主窗口，
// 把容器 display:none 会连主窗口一起藏掉（实测：会话/输入框全都拿不到焦点）。
function setDockVisibility(visible) {
  if (!dockMountedHost) return;
  var floatDock = document.getElementById("floatDock");
  if (floatDock) {
    floatDock.classList.toggle("hidden", visible === false);
    return;
  }
  // 骨架异常（取不到球）时才退回容器级兜底，保证不会残留一个"判了隐藏却还显示"的入口
  dockMountedHost.style.display = visible === false ? "none" : "";
}

// 槽位桥（session-bridge.js）在 session 作用域里判定"当前是否选中本插件虚拟模型"。
// 注意：这里只是把结论**写进状态工厂**，不直接改 DOM——DOM 由注册的 applier 统一落地。
function applyDockVisibility(visible) {
  setDockVisible(visible !== false);
}

// 判定结论 → 显隐：**只有 'ours' 显示**。
// 'degraded'（判不了）与 'unknown'（还不知道）一律隐藏：契约 INV-14 的口径是
// "任一输入在重试后仍不可用则判为不可知并隐藏"——宁可少显示，也不把不属于本插件的入口摆给用户。
// 'degraded' 仍保留在判定结果里，只用于日志区分"为什么隐藏"。
// 单独一层是为了让"判定"与"显示策略"分开：桥只管算，显示口径只在这一处。
function isDockVisibleForDecision(decision) {
  return decision === "ours";
}

// 判定结果只往状态工厂写一次，DOM 由工厂的 reapply 统一落地（R1：这里不留显示副本）
function applyDockDecision(decision) {
  setDockVisible(isDockVisibleForDecision(decision));
}
// apply.js —— 入口：ctx.effect 挂载悬浮球；槽位桥把宿主 sessionId 灌进工厂（零轮询，契约 docs/13 §4.3）。
function apply(ctx) {
  ctx.effect(function () {
    try {
      var mounted = mountDock();
      return function () {
        try { mounted.dispose(); } catch (error) { warnOnce("dock dispose", error); }
      };
    } catch (error) {
      warnOnce("dock mount", error);
      return function () {};
    }
  }, "dsh-model-team: dock");

  // 槽位注册必须发生在 client 插件入口（这里能拿到 ctx），纯 DOM 分片拿不到 ctx
  var slotsReady = ctx && ctx.slots && typeof ctx.slots.inject === "function";
  if (!slotsReady) {
    // 拿不到槽位就拿不到 session 作用域，也就判不了 INV-14。
    // 按契约：判不了就隐藏（「宁可少显示，也不把不属于本插件的入口摆给用户」）。
    // 历史：这里一度「降级为显示」，理由是"不比现状差"——那与契约冲突，
    //      表现为任何模型下都挂着一个球，属于虚假入口。
    applyDockVisibility(false);
    fetchSessionOnce();          // 宿主不提供 slots：一次性兜底，绝不轮询
    return;
  }
  try {
    // 会话作用域槽位：宿主 renderSlot("conversation.input.dock", { session, input }) 带 session；
    // shell.overlay 的 props 是空对象，拿不到 sessionId（真机实测）。
    ctx.slots.inject("conversation.input.dock", function () {
      return ctx.slots.register(
        {
          name: "conversation.input.dock",
          id: "dsh-model-team-session-bridge",
          order: 999          // 排到最后，避免插到宿主自己的 dock 前面
        },
        createSessionBridgeComponent(require("react"))
      );
    });
  } catch (error) {
    warnOnce("session bridge slot", error);
    applyDockVisibility(false);   // 槽位注册失败 = 判不了 INV-14 → 隐藏（契约口径，不是降级显示）
    fetchSessionOnce();
  }
}

exports.apply = apply;
exports.inject = ["slots"];
return module.exports;
  }
});
