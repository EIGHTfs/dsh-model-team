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
// api-real.js —— 数据层唯一实现：接口名、请求路径、返回结构都只写在这里。
// 传输层可替换：插件里走真实 HTTP；设计稿用 apiSetTransport(mockTransport) 注入「只供假 JSON」的 mock，
// 因此新增接口只改本文件一处，mock 侧只需补一段假数据（缺了会自动落到默认空值）。
// 当前会话由 store 通过 setActiveSession() 注入。
// 变量名不能叫 MOCK_SESSION_ID —— 设计稿的 mock-data.js 里有同名 const，
// 顶层 var 与 const 同名会让那个脚本整体 SyntaxError 不执行（踩过）。
var activeSessionId = null;
var apiTransport = null;

// 注入/清除 mock 传输：transport(path, options) 直接返回假 JSON（同步值即可）
function apiSetTransport(transport) {
  apiTransport = typeof transport === "function" ? transport : null;
}

function setActiveSession(sessionId) {
  activeSessionId = typeof sessionId === "string" && sessionId ? sessionId : null;
}

function apiJson(path, options) {
  // 设计稿模式：交给注入的 mock 传输（同步返回假 JSON，包成 Promise 保持异步语义）
  if (typeof apiTransport === "function") {
    return Promise.resolve()
      .then(function () { return apiTransport(path, options); })
      .catch(function () { return null; })
      .then(function (payload) { return payload === undefined ? null : payload; });
  }
  if (typeof fetch !== "function") return Promise.resolve(null);
  var requestOptions = options || {};
  var controller = typeof AbortController === "function" ? new AbortController() : null;
  var timer = setTimeout(function () { if (controller) controller.abort(); }, API_TIMEOUT_MS);
  if (controller) requestOptions.signal = controller.signal;
  return fetch(API_PREFIX + path, requestOptions)
    .then(function (response) { return response.ok ? response.json() : null; })
    .catch(function () { return null; })
    .then(function (payload) {
      clearTimeout(timer);
      return payload === undefined ? null : payload;
    });
}

// 探测类接口需要读 4xx 的错误体（code/message/hint），不能用 apiJson（它把非 2xx 判成 null）
function apiPostRaw(path, payload) {
  if (typeof apiTransport === "function") {
    return Promise.resolve()
      .then(function () { return apiTransport(path, { method: "POST", body: payload }); })
      .catch(function () { return null; });
  }
  if (typeof fetch !== "function") return Promise.resolve(null);
  var controller = typeof AbortController === "function" ? new AbortController() : null;
  var timer = setTimeout(function () { if (controller) controller.abort(); }, API_TIMEOUT_MS);
  return fetch(API_PREFIX + path, {
    method: "POST",
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

// 速率统一走 ui/js/rate.js（唯一实现）：速率 = 输出 token / 耗时（生成速度），
// 不是 total/latency（吞吐）——长上下文下 total 里 99% 是输入，会算出高两个数量级的假值。
// 取最近一条有 completionTokens + latencySeconds 的行（最多回溯 20 行），拿不到就 "— tok/s"。
var RATE_LOOKBACK_ROWS = 20;

function apiEstimateRate(rows) {
  if (!rows || !rows.length) return "— tok/s";
  for (var index = rows.length - 1; index >= 0 && index >= rows.length - RATE_LOOKBACK_ROWS; index -= 1) {
    var value = ModelTeamRate.computeGenerationRate(rows[index]);
    if (value !== null) return ModelTeamRate.formatRate(value) + " tok/s";
  }
  return "— tok/s";
}

var api = {
  // store 在会话确定/切换时调用；之后的会话级请求都用这个 id
  setActiveSession: setActiveSession,
  setTransport: apiSetTransport,
  getCurrentSession: function () {
    return apiJson("/sessions/current");
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
  createGroup: function (payload) {
    return apiPost("/groups", payload);
  },
  createFriendGroup: function (payload) {
    return apiPost("/friend-groups", payload);
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
  tag.textContent = UI_CSS + "\n" + HOST_OVERRIDE_CSS;
  document.head.appendChild(tag);
}
// 由 build.cjs 内联的 ui 样式（勿手改）
var UI_CSS = "/* layout.css —— 窗体外壳：主题变量、垫场背景、悬浮球与悬浮面板、模型团队主窗口。\n   视觉基调：蓝白、圆角、柔和投影；内容页样式在 views.css / panels.css。 */\n\n/* 主题变量集中一处，改色只动这里 */\n:root {\n  /* 主窗口尺寸：主题可覆盖这两个变量，默认 760×540（契约条款 26） */\n  --team-window-width: min(760px, 92vw);\n  --team-window-height: min(540px, 86vh);\n  --team-blue: #12a7f5;          /* 主色：亮蓝 */\n  --team-blue-deep: #0b8bd0;     /* 主色深一档，用于渐变收尾 */\n  --team-blue-soft: #e8f5ff;     /* 主色淡底，用于选中态、hover */\n  --team-text: #1f2329;          /* 主文字 */\n  --team-text-2: #6b7785;        /* 次要文字 */\n  --team-text-3: #9aa6b2;        /* 弱提示 */\n  --team-line: #e6ebf0;          /* 分割线 */\n  --team-bg: #f5f8fb;            /* 窗口内底色 */\n  --team-white: #ffffff;\n  --team-green: #20b26c;         /* 成功 / 在线 */\n  --team-orange: #f0a020;        /* 限流 */\n  --team-red: #e8513d;           /* 失败 */\n  --team-radius: 10px;\n  --team-shadow: 0 10px 30px rgba(16, 58, 96, 0.14);\n  --team-shadow-lg: 0 18px 48px rgba(16, 58, 96, 0.22);\n}\n\n* { box-sizing: border-box; }\n\nhtml, body {\n  height: 100%;\n  margin: 0;\n}\n\nbody {\n  /* 淡蓝白渐变，衬托白色卡片与悬浮件 */\n  background: linear-gradient(160deg, #eef5fc 0%, #dfe9f4 55%, #d6e3f1 100%);\n  color: var(--team-text);\n  font: 14px/1.6 \"PingFang SC\", \"Microsoft YaHei\", \"Hiragino Sans GB\", system-ui, -apple-system, sans-serif;\n  overflow: hidden;\n}\n\n\n\n/* ---------------------------------------------------------------- 悬浮球 */\n.float-dock {\n  position: fixed;\n  left: calc(100% - 320px);      /* 初始位置：右下角往内缩一点 */\n  top: 58%;\n  z-index: 2147482000;           /* 契约条款 4：悬浮件必须压住宿主所有界面 */\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  user-select: none;\n}\n/* 关闭整个悬浮窗时用：球与 pill 一起隐藏，只留右下角\"呼出模型团队\"按钮 */\n.float-dock.hidden { display: none; }\n\n.float-ball {\n  position: relative;\n  width: 56px;\n  height: 56px;\n  padding: 0;\n  border: none;\n  border-radius: 50%;\n  cursor: grab;\n  touch-action: none;            /* 触控/触控板下别让浏览器把手势当滚动，否则拖动会被抢走 */\n  color: #fff;\n  font-size: 16px;\n  font-weight: 600;\n  letter-spacing: 0.05em;\n  background: linear-gradient(145deg, #38bdf8, var(--team-blue) 55%, var(--team-blue-deep));\n  box-shadow: 0 10px 22px rgba(12, 122, 186, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.45);\n  transition: transform 0.16s ease, box-shadow 0.16s ease;\n}\n/* 拖动中禁掉球自身的缩放/过渡，否则跟手会被 hover/active 动画拖住 */\n.float-dock.is-dragging .float-ball { transition: none; transform: none; }\n.float-ball:hover {\n  transform: translateY(-2px) scale(1.03);\n  box-shadow: 0 14px 28px rgba(12, 122, 186, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.5);\n}\n.float-ball:active { cursor: grabbing; transform: scale(0.97); }\n/* 球内显示当前目标（单模型名截断 / @分组名 / —），不再显示固定文案 */\n.fb-target {\n  max-width: 44px;\n  font-size: 10px;\n  line-height: 1.15;\n  text-align: center;\n  word-break: break-all;\n}\n/* 球的呼吸光晕，暗示\"有实时统计在跳\" */\n.fb-dot {\n  position: absolute;\n  right: 4px;\n  bottom: 6px;\n  width: 10px;\n  height: 10px;\n  border-radius: 50%;\n  background: var(--team-green);\n  border: 2px solid #fff;\n}\n\n.float-pill {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  max-width: 260px;             /* 模型名极长时省略，不把球推出视口 */\n  padding: 7px 12px;\n  border-radius: 999px;\n  background: rgba(255, 255, 255, 0.92);\n  border: 1px solid rgba(18, 167, 245, 0.28);\n  box-shadow: 0 6px 16px rgba(16, 58, 96, 0.12);\n  font-size: 12px;\n  color: var(--team-text-2);\n  white-space: nowrap;\n}\n.pill-model {\n  font-family: \"JetBrains Mono\", \"SFMono-Regular\", Consolas, monospace;\n  color: var(--team-blue-deep);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.pill-dot {\n  width: 7px;\n  height: 7px;\n  border-radius: 50%;\n  background: var(--team-green);\n  box-shadow: 0 0 0 3px rgba(32, 178, 108, 0.16);\n}\n\n/* ------------------------------------------------------------ 悬浮面板 */\n.float-panel {\n  position: fixed;\n  z-index: 2147482001;           /* 面板压在球之上，两者都在宿主界面之上 */\n  width: 384px;\n  border-radius: 12px;\n  background: var(--team-white);\n  border: 1px solid var(--team-line);\n  box-shadow: var(--team-shadow-lg);\n  overflow: hidden;\n  /* 开合动画：只过渡透明度与位移，不做尺寸动画（宽度固定，避免抖动） */\n  transition: opacity 160ms ease, transform 180ms cubic-bezier(0.16, 1, 0.3, 1), visibility 0s;\n}\n.float-panel.hidden {\n  visibility: hidden;\n  opacity: 0;\n  transform: translateY(6px) scale(0.98);\n  pointer-events: none;\n  transition: opacity 140ms ease, transform 160ms ease, visibility 0s linear 160ms;\n}\n/* 拖动中禁掉过渡，否则跟手会被平滑掉 */\n.float-dock.is-dragging { transition: none; will-change: transform; }\n\n.fp-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 10px 12px;\n  background: linear-gradient(120deg, #eaf7ff, #f7fbff);\n  border-bottom: 1px solid var(--team-line);\n  cursor: move;                 /* 面板标题条可拖拽 */\n  user-select: none;\n  touch-action: none;           /* 同上：拖动标题条时不被浏览器手势接管 */\n}\n.fp-title-btn {\n  padding: 0;\n  border: none;\n  background: transparent;\n  color: inherit;\n  font: inherit;\n  font-weight: 600;\n  cursor: pointer;\n}\n.fp-title-btn:hover { color: var(--team-blue-deep); }\n\n/* 目标行的来源提示：本会话未显式绑定、由后端回落时显示（浅色小字，不抢目标名） */\n.fp-target-source {\n  margin-left: 4px;\n  color: var(--team-text-3);\n  font-weight: 400;\n  font-size: 11px;\n}\n\n.fp-title { font-weight: 600; font-size: 13px; }\n.fp-model {\n  margin-left: auto;\n  font-size: 12px;\n  color: var(--team-text-2);\n  font-family: \"JetBrains Mono\", Consolas, monospace;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  max-width: 150px;\n}\n.fp-ops { display: flex; gap: 2px; flex: none; }\n.fp-btn {\n  width: 22px;\n  height: 22px;\n  padding: 0;\n  border: none;\n  border-radius: 5px;\n  background: transparent;\n  color: var(--team-text-2);\n  font-size: 14px;\n  line-height: 1;\n  cursor: pointer;\n}\n.fp-btn:hover { background: rgba(18, 167, 245, 0.14); color: var(--team-blue-deep); }\n\n.fp-body { padding: 12px 14px; }\n.fp-row {\n  display: flex;\n  gap: 6px;\n  padding: 4px 0;\n  font-size: 13px;\n}\n.fp-k { color: var(--team-text-2); flex: none; }\n.fp-v {\n  color: var(--team-text);\n  font-weight: 600;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.fp-foot { padding: 0 14px 12px; }\n.fp-enter {\n  width: 100%;\n  padding: 9px 0;\n  border: 1px solid rgba(18, 167, 245, 0.4);\n  border-radius: 8px;\n  background: linear-gradient(120deg, #eaf7ff, #f4fbff);\n  color: var(--team-blue-deep);\n  font-size: 13px;\n  font-weight: 600;\n  cursor: pointer;\n}\n.fp-enter:hover { background: linear-gradient(120deg, #dcf1ff, #eeF9ff); }\n\n/* 关闭悬浮窗后的再次呼出按钮 */\n.float-recall {\n  position: fixed;\n  right: 24px;\n  bottom: 24px;\n  z-index: 2147482000;\n  padding: 10px 16px;\n  border: 1px solid rgba(18, 167, 245, 0.35);\n  border-radius: 999px;\n  background: #fff;\n  color: var(--team-blue-deep);\n  font-size: 13px;\n  box-shadow: var(--team-shadow);\n  cursor: pointer;\n}\n.float-recall.hidden { display: none; }\n\n/* ------------------------------------------------------ 模型团队主窗口 */\n.team-app {\n  position: fixed;\n  left: 50%;\n  top: 50%;\n  z-index: 2147482002;           /* 主窗口压在悬浮件之上（契约条款 4） */\n  transform: translate(-50%, -50%);\n  width: var(--team-window-width);\n  height: var(--team-window-height);\n  display: flex;\n  flex-direction: column;\n  background: var(--team-white);\n  border: 1px solid rgba(255, 255, 255, 0.9);\n  border-radius: 14px;\n  box-shadow: var(--team-shadow-lg);\n  overflow: hidden;\n}\n\n.team-bar {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  height: 48px;\n  padding: 0 14px;\n  flex: none;\n  background: linear-gradient(120deg, #f2f9ff, #ffffff);\n  border-bottom: 1px solid var(--team-line);\n}\n.team-logo {\n  padding: 2px 8px;\n  border-radius: 6px;\n  background: linear-gradient(145deg, #38bdf8, var(--team-blue-deep));\n  color: #fff;\n  font-size: 12px;\n  font-weight: 700;\n  letter-spacing: 0.08em;\n}\n.team-view-name { font-size: 14px; font-weight: 600; }\n.team-bar-btn {\n  margin-left: auto;\n  padding: 6px 12px;\n  border: 1px solid var(--team-line);\n  border-radius: 999px;\n  background: #fff;\n  color: var(--team-text-2);\n  font-size: 12px;\n  cursor: pointer;\n}\n.team-bar-btn:hover { border-color: rgba(18, 167, 245, 0.4); color: var(--team-blue-deep); }\n\n.team-body {\n  flex: 1;\n  min-height: 0;                /* 关键：让内部滚动区正确收缩 */\n  overflow: hidden;             /* 内容在视图内部滚动，底边栏与顶栏不动 */\n  background: var(--team-bg);\n  display: flex;\n  flex-direction: column;\n}\n\n/* 底部三 tab（契约条款 21-24）：图标在上文字在下，固定高度、不随内容滚动 */\n.team-tabbar {\n  flex: none;\n  display: flex;\n  height: 54px;\n  border-top: 1px solid var(--team-line);\n  background: #fff;\n}\n.team-tab {\n  flex: 1;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  justify-content: center;\n  gap: 3px;\n  padding: 0;\n  border: none;\n  background: transparent;\n  color: var(--team-text-3);\n  font-size: 11px;\n  line-height: 1;\n  cursor: pointer;\n  transition: color 140ms ease;\n}\n.team-tab svg { width: 22px; height: 22px; }\n.team-tab:hover { color: var(--team-blue-deep); }\n.team-tab[aria-selected=\"true\"] {\n  color: var(--team-blue-deep);\n  font-weight: 600;\n}\n.team-tab-label { font-size: 11px; }\n\n.noscript {\n  position: fixed;\n  left: 50%;\n  top: 12px;\n  transform: translateX(-50%);\n  color: var(--team-red);\n}\n\n/* 小屏兜底：窗口贴边，悬浮球躲到左下，避免遮挡输入区 */\n@media (max-width: 720px) {\n  .team-app {\n    width: 100vw;\n    height: 100vh;\n    border-radius: 0;\n    top: 0;\n    left: 0;\n    transform: none;\n  }\n  .float-dock { left: 16px; top: unset; bottom: 96px; }\n  .float-panel { width: calc(100vw - 32px); }\n}\n\n/* views.css —— 窗口内内容页：群列表、群聊（气泡 / 请求行 / 输入区）。\n   加群与数据库在 panels.css，@ 选择器在 mention.css，外壳在 layout.css。 */\n\n/* 每个视图都是纵向 flex，中间滚动区自行 min-height:0 */\n.view {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n}\n\n/* 数据未就绪时的占位 */\n.loading {\n  flex: 1;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  color: var(--team-text-3);\n  font-size: 13px;\n}\n\n/* 视图内的通用头部（群聊 / 加群 / 数据库共用） */\n.view-head {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  flex: none;\n  padding: 10px 14px;\n  background: #fff;\n  border-bottom: 1px solid var(--team-line);\n}\n.view-head .head-title {\n  font-size: 14px;\n  font-weight: 600;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.btn-back {\n  flex: none;\n  padding: 4px 10px;\n  border: 1px solid var(--team-line);\n  border-radius: 999px;\n  background: #fff;\n  color: var(--team-text-2);\n  font-size: 12px;\n  cursor: pointer;\n}\n.btn-back:hover { border-color: rgba(18, 167, 245, 0.4); color: var(--team-blue-deep); }\n\n/* 通用头像占位：字符串头像，不引用任何外部图片 */\n.avatar {\n  flex: none;\n  width: 38px;\n  height: 38px;\n  border-radius: 10px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  background: linear-gradient(145deg, #e8f5ff, #d4ecff);\n  color: var(--team-blue-deep);\n  font-size: 13px;\n  font-weight: 700;\n  letter-spacing: 0.02em;\n}\n.avatar.round { border-radius: 50%; }\n.avatar.big { width: 56px; height: 56px; font-size: 16px; border-radius: 14px; }\n\n/* 头像换成图片时保持原尺寸与圆角，不破坏布局（平台图标来自后端预置的 URL） */\n.avatar-img {\n  width: 100%;\n  height: 100%;\n  border-radius: inherit;\n  object-fit: cover;\n  display: block;\n}\n\n/* 视图一：群列表（= 平台账号列表） */\n.list-head {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  flex: none;\n  padding: 12px 16px 8px;\n}\n.list-head h2 {\n  margin: 0;\n  font-size: 15px;\n  font-weight: 700;\n}\n.list-count {\n  font-size: 12px;\n  color: var(--team-text-3);\n}\n.btn-add {\n  margin-left: auto;\n  padding: 6px 14px;\n  border: none;\n  border-radius: 999px;\n  background: linear-gradient(120deg, #38bdf8, var(--team-blue-deep));\n  color: #fff;\n  font-size: 12px;\n  font-weight: 600;\n  cursor: pointer;\n  box-shadow: 0 4px 12px rgba(12, 122, 186, 0.28);\n}\n.btn-add:hover { filter: brightness(1.05); }\n\n/* 群列表顶部：搜索框（占剩余宽度）+「我」入口（契约条款 5 / 8） */\n.group-search {\n  flex: 1;\n  min-width: 120px;\n  max-width: 280px;\n  padding: 6px 12px;\n  border: 1px solid var(--team-line);\n  border-radius: 999px;\n  background: #fff;\n  font-size: 12px;\n  color: var(--team-text);\n  outline: none;\n}\n.group-search:focus { border-color: rgba(18, 167, 245, 0.55); }\n.btn-me {\n  padding: 6px 12px;\n  border: 1px solid var(--team-line);\n  border-radius: 999px;\n  background: #fff;\n  color: var(--team-text-2);\n  font-size: 12px;\n  cursor: pointer;\n}\n.btn-me:hover { border-color: rgba(18, 167, 245, 0.4); color: var(--team-blue-deep); }\n.list-head .btn-add { margin-left: 0; }\n\n.group-list {\n  flex: 1;\n  min-height: 0;\n  overflow-y: auto;\n  list-style: none;\n  margin: 0;\n  padding: 4px 10px 14px;\n}\n.group-item {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  padding: 10px 10px;\n  border-radius: 10px;\n  cursor: pointer;\n  transition: background 0.14s ease;\n}\n.group-item:hover { background: #fff; box-shadow: 0 2px 10px rgba(16, 58, 96, 0.06); }\n.group-item.active { background: var(--team-blue-soft); }\n.group-main { flex: 1; min-width: 0; }   /* min-width:0 是超长文本能省略的前提 */\n.group-line {\n  display: flex;\n  align-items: baseline;\n  gap: 8px;\n  min-width: 0;                 /* 让长群名在 flex 里能真正收缩到容器宽度 */\n}\n.group-name {\n  flex: 1;\n  min-width: 0;                 /* 配合 overflow 才能出省略号，否则会撑破整行 */\n  font-size: 14px;\n  font-weight: 600;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n/* 右侧竖排：时间在上、驱动名在下，避免和摘要行抢宽度 */\n.group-right {\n  flex: none;\n  display: flex;\n  flex-direction: column;\n  align-items: flex-end;\n  gap: 2px;\n}\n.group-time {\n  font-size: 11px;\n  color: var(--team-text-3);\n  font-variant-numeric: tabular-nums;\n}\n.group-summary {\n  margin-top: 2px;\n  font-size: 12px;\n  color: var(--team-text-2);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.group-driver {\n  padding: 0 6px;\n  border-radius: 4px;\n  background: #f0f5fa;\n  color: var(--team-text-3);\n  font-size: 10px;\n  line-height: 15px;\n}\n\n/* 视图二：群聊（请求记录行 = 群友消息） */\n.chat-head { display: flex; align-items: center; gap: 10px; }\n.chat-head .group-tag {\n  flex: none;\n  padding: 1px 7px;\n  border-radius: 999px;\n  background: var(--team-blue-soft);\n  color: var(--team-blue-deep);\n  font-size: 11px;\n}\n.chat-head .head-sub {\n  margin-left: auto;\n  font-size: 11px;\n  color: var(--team-text-3);\n}\n\n.chat-stream {\n  flex: 1;\n  min-height: 0;\n  overflow-y: auto;\n  padding: 14px 16px 6px;\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n}\n\n/* 单条消息的通用行：头像 + 气泡 */\n.msg { display: flex; align-items: flex-start; gap: 8px; max-width: 100%; }\n.msg-left { justify-content: flex-start; }\n.msg-right { justify-content: flex-end; }\n.msg-right .avatar { order: 2; }\n.msg-right .bubble { order: 1; }\n.msg-sys { justify-content: center; }\n\n.bubble {\n  position: relative;\n  max-width: min(78%, 620px);\n  padding: 9px 12px;\n  border-radius: 10px;\n  font-size: 13px;\n  line-height: 1.55;\n  word-break: break-word;             /* 超长无空格串也要换行，不撑破气泡 */\n  box-shadow: 0 2px 8px rgba(16, 58, 96, 0.06);\n}\n.msg-left .bubble {\n  background: #fff;\n  border: 1px solid var(--team-line);\n  border-top-left-radius: 3px;\n}\n.msg-right .bubble {\n  background: linear-gradient(135deg, #45c2fb, var(--team-blue-deep));\n  border: none;\n  border-top-right-radius: 3px;\n  color: #fff;\n}\n.msg-right .bubble .mention-inline { color: #fff; font-weight: 600; }\n\n/* 请求记录行：默认单行折叠，点击展开 */\n.req-bubble { cursor: pointer; transition: box-shadow 0.14s ease, transform 0.14s ease; }\n.req-bubble:hover {\n  box-shadow: 0 6px 18px rgba(16, 58, 96, 0.12);\n  transform: translateY(-1px);\n}\n.req-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n}\n.req-model {\n  font-family: \"JetBrains Mono\", Consolas, monospace;\n  font-size: 12.5px;\n  font-weight: 600;\n  color: var(--team-text);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.req-time {\n  margin-left: auto;\n  flex: none;\n  font-size: 11px;\n  color: var(--team-text-3);\n  font-variant-numeric: tabular-nums;\n}\n/* 右上角的小三角：提示\"这一行能点开看的\"，用 CSS 边框画，不依赖字体字形 */\n.req-caret {\n  flex: none;\n  width: 0;\n  height: 0;\n  margin-top: 2px;\n  border-left: 4px solid transparent;\n  border-right: 4px solid transparent;\n  border-top: 5px solid var(--team-text-3);\n}\n.req-bubble.expanded .req-caret {\n  border-top: none;\n  border-bottom: 5px solid var(--team-blue-deep);\n}\n/* 折叠态：状态 + 关键的四个数字挤在同一行，超出省略 */\n.req-meta {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  margin-top: 3px;\n  font-size: 11.5px;\n  color: var(--team-text-2);\n  overflow: hidden;\n  white-space: nowrap;\n  text-overflow: ellipsis;\n}\n.req-meta .sep { color: #cbd5df; }\n.st {\n  flex: none;\n  padding: 0 6px;\n  border-radius: 4px;\n  font-size: 11px;\n  font-weight: 600;\n}\n.st-ok { background: rgba(32, 178, 108, 0.12); color: var(--team-green); }\n.st-warn { background: rgba(240, 160, 32, 0.14); color: #b5730a; }\n.st-err { background: rgba(232, 81, 61, 0.12); color: var(--team-red); }\n\n/* 展开态：气泡下面追加一张明细表 */\n.req-detail {\n  margin-top: 8px;\n  padding-top: 8px;\n  border-top: 1px dashed var(--team-line);\n  display: grid;\n  grid-template-columns: 74px 1fr;\n  gap: 4px 10px;\n  font-size: 12px;\n}\n.req-detail .k { color: var(--team-text-3); }\n.req-detail .v {\n  color: var(--team-text);\n  font-family: \"JetBrains Mono\", Consolas, monospace;\n  word-break: break-all;              /* UA / req-id 很长，允许任意断行 */\n}\n/* 分组轮换时的\"谁接的活\"轻提示 */\n.req-served {\n  margin-top: 6px;\n  font-size: 11px;\n  color: var(--team-text-3);\n}\n/* 系统提示：灰色居中细条 */\n.sys-tip {\n  align-self: center;\n  padding: 3px 10px;\n  border-radius: 999px;\n  background: rgba(31, 35, 41, 0.06);\n  color: var(--team-text-3);\n  font-size: 11.5px;\n}\n/* 每条消息的展示时间：系统提示在细条右侧、我的气泡在气泡内右下，低调不抢内容 */\n.msg-time {\n  align-self: center;\n  margin-left: 8px;\n  font-size: 10.5px;\n  color: var(--team-text-3);\n  font-variant-numeric: tabular-nums;\n}\n.msg-right .msg-time {\n  display: block;\n  margin: 2px 0 0;\n  text-align: right;\n  font-size: 10.5px;\n  opacity: 0.75;\n}\n\n/* 模型目录（加群页第三段）：id/name 两列 + 删除；窄屏也保持不挤压 */\n.form-step-title .step-actions {\n  margin-left: auto;\n  display: flex;\n  gap: 8px;\n}\n.btn-ghost {\n  padding: 4px 10px;\n  border: 1px solid var(--team-line);\n  border-radius: 999px;\n  background: #fff;\n  color: var(--team-text-2);\n  font-size: 12px;\n  cursor: pointer;\n}\n.btn-ghost:hover:not(:disabled) { border-color: rgba(18, 167, 245, 0.4); color: var(--team-blue-deep); }\n.btn-ghost:disabled { opacity: 0.6; cursor: not-allowed; }\n.model-mode {\n  margin: 6px 0 8px;\n  font-size: 11.5px;\n  color: var(--team-text-3);\n}\n.model-table { display: flex; flex-direction: column; gap: 6px; }\n.model-row {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 36px;\n  gap: 8px;\n  align-items: center;\n}\n.model-row input {\n  min-width: 0;\n  height: 32px;\n  padding: 0 10px;\n  border: 1px solid var(--team-line);\n  border-radius: 8px;\n  font-size: 12.5px;\n  background: #fff;\n  outline: none;\n}\n.model-row input:focus { border-color: rgba(18, 167, 245, 0.55); }\n.model-row-head {\n  font-size: 11px;\n  color: var(--team-text-3);\n}\n.model-remove {\n  width: 30px;\n  height: 30px;\n  border: 1px solid var(--team-line);\n  border-radius: 8px;\n  background: #fff;\n  color: var(--team-text-3);\n  font-size: 14px;\n  line-height: 1;\n  cursor: pointer;\n}\n.model-remove:hover { border-color: rgba(220, 80, 80, 0.5); color: #c0392b; }\n.probe-feedback {\n  margin-top: 8px;\n  min-height: 16px;\n  font-size: 11.5px;\n  color: var(--team-text-3);\n}\n.probe-feedback.probe-error { color: #c0392b; }\n\n/* 输入区 */\n.chat-input {\n  position: relative;\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 10px 12px;\n  background: #fff;\n  border-top: 1px solid var(--team-line);\n}\n.btn-at {\n  flex: none;\n  width: 32px;\n  height: 32px;\n  border: 1px solid var(--team-line);\n  border-radius: 8px;\n  background: #fff;\n  color: var(--team-text-2);\n  font-size: 14px;\n  font-weight: 700;\n  cursor: pointer;\n}\n.btn-at:hover { color: var(--team-blue-deep); border-color: rgba(18, 167, 245, 0.4); }\n#msgInput {\n  flex: 1;\n  min-width: 0;\n  height: 36px;\n  max-height: 88px;\n  padding: 9px 12px;\n  border: 1px solid var(--team-line);\n  border-radius: 8px;\n  background: var(--team-bg);\n  font-size: 13px;\n  line-height: 18px;\n  color: var(--team-text);\n  outline: none;\n  resize: none;                  /* Shift+Enter 换行，但不允许手动拖高 */\n  overflow-y: auto;\n}\n#msgInput:focus { border-color: rgba(18, 167, 245, 0.55); background: #fff; }\n.btn-send {\n  flex: none;\n  height: 36px;\n  padding: 0 18px;\n  border: none;\n  border-radius: 8px;\n  background: linear-gradient(120deg, #38bdf8, var(--team-blue-deep));\n  color: #fff;\n  font-size: 13px;\n  font-weight: 600;\n  cursor: pointer;\n}\n.btn-send:hover { filter: brightness(1.05); }\n\n/* @ 选择器见 mention.css；加群表单与数据库页见 panels.css */\n\n/* panels.css —— 表单与浮层：加群动态表单、我的数据库、轻提示、导入结果弹层。 */\n\n/* ========================================================================\n   视图三：加群（两步动态表单）\n   ==================================================================== */\n.form-body {\n  flex: 1;\n  min-height: 0;\n  overflow-y: auto;\n  padding: 16px 18px 20px;\n  background: #fff;\n}\n.form-step {\n  margin-bottom: 18px;\n  padding: 14px;\n  border: 1px solid var(--team-line);\n  border-radius: 10px;\n  background: #fbfdff;\n}\n.form-step-title {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  margin-bottom: 10px;\n  font-size: 13px;\n  font-weight: 600;\n}\n.step-no {\n  width: 20px;\n  height: 20px;\n  border-radius: 50%;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  background: var(--team-blue-soft);\n  color: var(--team-blue-deep);\n  font-size: 11px;\n}\n.field { margin-bottom: 12px; }\n.field:last-child { margin-bottom: 0; }\n.field-label {\n  display: block;\n  margin-bottom: 5px;\n  font-size: 12.5px;\n  color: var(--team-text-2);\n}\n.field-label .req-mark { color: var(--team-red); margin-left: 2px; }\n\n/* 动态字段：text / password 用 input，textarea 单独放宽高度 */\n.field input[type=\"text\"],\n.field input[type=\"password\"],\n.field textarea,\n.driver-select,\n.group-name-input {\n  width: 100%;\n  padding: 8px 10px;\n  border: 1px solid var(--team-line);\n  border-radius: 8px;\n  background: #fff;\n  font-size: 13px;\n  font-family: inherit;\n  color: var(--team-text);\n  outline: none;\n}\n.field input:focus, .field textarea:focus,\n.driver-select:focus, .group-name-input:focus {\n  border-color: rgba(18, 167, 245, 0.55);\n  box-shadow: 0 0 0 3px rgba(18, 167, 245, 0.1);\n}\n.field textarea { min-height: 74px; resize: vertical; }\n.driver-hint {\n  margin-top: 6px;\n  font-size: 11.5px;\n  color: var(--team-text-3);\n}\n/* 提交栏固定在表单底部：字段随 driver 变多时按钮始终可见，也不压住最后一个字段 */\n.form-footer {\n  flex: none;\n  padding: 10px 18px 12px;\n  text-align: center;\n  background: #fff;\n  border-top: 1px solid var(--team-line);\n}\n.btn-primary {\n  min-width: 180px;\n  padding: 10px 22px;\n  border: none;\n  border-radius: 9px;\n  background: linear-gradient(120deg, #38bdf8, var(--team-blue-deep));\n  color: #fff;\n  font-size: 13.5px;\n  font-weight: 600;\n  cursor: pointer;\n  box-shadow: 0 6px 16px rgba(12, 122, 186, 0.26);\n}\n.btn-primary:hover { filter: brightness(1.05); }\n.form-note {\n  margin-top: 10px;\n  font-size: 11.5px;\n  color: var(--team-text-3);\n}\n\n/* 下拉字段（如「模型列表来源」）：与输入框同宽同高，保持一行内对齐 */\n.field-select {\n  width: 100%;\n  padding: 8px 10px;\n  border: 1px solid var(--team-line);\n  border-radius: 8px;\n  background: #fff;\n  font-size: 13px;\n  font-family: inherit;\n  color: var(--team-text);\n  outline: none;\n  cursor: pointer;\n}\n.field-select:focus {\n  border-color: rgba(18, 167, 245, 0.55);\n  box-shadow: 0 0 0 3px rgba(18, 167, 245, 0.1);\n}\n\n/* ========================================================================\n   视图四：我的模型团队（导入 / 导出）\n   ==================================================================== */\n.profile-body {\n  flex: 1;\n  min-height: 0;\n  overflow-y: auto;\n  padding: 18px;\n}\n.profile-card {\n  display: flex;\n  align-items: center;\n  gap: 14px;\n  padding: 16px;\n  border-radius: 12px;\n  background: linear-gradient(120deg, #f2f9ff, #ffffff);\n  border: 1px solid var(--team-line);\n}\n.profile-main { min-width: 0; }\n.profile-name { font-size: 15px; font-weight: 700; }\n.profile-sub {\n  margin-top: 2px;\n  font-size: 12px;\n  color: var(--team-text-2);\n}\n.profile-actions {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 10px;\n  margin-left: auto;\n}\n.btn-outline {\n  padding: 8px 14px;\n  border: 1px solid rgba(18, 167, 245, 0.42);\n  border-radius: 8px;\n  background: #fff;\n  color: var(--team-blue-deep);\n  font-size: 12.5px;\n  cursor: pointer;\n}\n.btn-outline:hover { background: var(--team-blue-soft); }\n\n.conn-title {\n  margin: 18px 0 8px;\n  font-size: 12.5px;\n  color: var(--team-text-2);\n  font-weight: 600;\n}\n.conn-list {\n  border: 1px solid var(--team-line);\n  border-radius: 10px;\n  overflow: hidden;\n  background: #fff;\n}\n.conn-item {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  padding: 10px 12px;\n  border-bottom: 1px solid var(--team-line);\n}\n.conn-item:last-child { border-bottom: none; }\n.conn-name { font-size: 13px; font-weight: 600; }\n.conn-meta {\n  margin-left: auto;\n  font-size: 11.5px;\n  color: var(--team-text-3);\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  max-width: 55%;\n  text-align: right;\n}\n/* 头像下方那行驱动名：不靠右、不省略 */\n.conn-meta-compact {\n  margin: 0;\n  max-width: none;\n  text-align: left;\n}\n\n/* ========================================================================\n   轻提示（toast）：导出成功、表单校验失败等短反馈\n   ==================================================================== */\n.toast {\n  position: fixed;\n  left: 50%;\n  bottom: 34px;\n  transform: translate(-50%, 12px);\n  z-index: 200;\n  padding: 9px 18px;\n  border-radius: 999px;\n  background: rgba(31, 35, 41, 0.88);\n  color: #fff;\n  font-size: 12.5px;\n  opacity: 0;\n  pointer-events: none;\n  transition: opacity 0.2s ease, transform 0.2s ease;\n}\n.toast.show { opacity: 1; transform: translate(-50%, 0); }\n\n/* ========================================================================\n   导入结果弹层：展示 JSON 解析结果，不阻塞页面\n   ==================================================================== */\n.modal-mask {\n  position: fixed;\n  inset: 0;\n  z-index: 300;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  background: rgba(16, 40, 66, 0.34);\n}\n.modal {\n  width: min(640px, calc(100vw - 48px));\n  max-height: 76vh;\n  display: flex;\n  flex-direction: column;\n  border-radius: 12px;\n  background: #fff;\n  box-shadow: var(--team-shadow-lg);\n  overflow: hidden;\n}\n.modal-head {\n  display: flex;\n  align-items: center;\n  padding: 12px 14px;\n  font-size: 13.5px;\n  font-weight: 600;\n  border-bottom: 1px solid var(--team-line);\n  background: linear-gradient(120deg, #f2f9ff, #ffffff);\n}\n.modal-x {\n  margin-left: auto;\n  width: 24px;\n  height: 24px;\n  padding: 0;\n  border: none;\n  border-radius: 6px;\n  background: transparent;\n  color: var(--team-text-2);\n  font-size: 15px;\n  cursor: pointer;\n}\n.modal-x:hover { background: rgba(18, 167, 245, 0.14); color: var(--team-blue-deep); }\n.modal-body {\n  padding: 14px;\n  overflow: auto;\n  font-size: 12.5px;\n}\n.modal-p { margin: 0 0 8px; color: var(--team-text-2); }\n.modal-table {\n  width: 100%;\n  border-collapse: collapse;\n  font-size: 12px;\n}\n.modal-table th, .modal-table td {\n  padding: 6px 8px;\n  border-bottom: 1px solid var(--team-line);\n  text-align: left;\n  word-break: break-all;\n}\n.modal-table th { color: var(--team-text-3); font-weight: 600; background: #fafcfe; }\n\n/* ========================================================================\n   视图五：通讯录（好友分组管理）\n   ==================================================================== */\n.contacts-body {\n  flex: 1;\n  min-height: 0;\n  overflow-y: auto;\n  padding: 14px 16px;\n}\n.contacts-label {\n  margin-bottom: 8px;\n  font-size: 12.5px;\n  color: var(--team-text-2);\n  font-weight: 600;\n}\n.contact-list { display: flex; flex-direction: column; gap: 14px; }\n.contacts-empty {\n  padding: 24px;\n  text-align: center;\n  color: var(--team-text-3);\n  font-size: 12.5px;\n}\n.contact-row { border-bottom: 1px dashed var(--team-line); padding-bottom: 8px; }\n.contact-row:last-child { border-bottom: none; }\n.contact-head {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 4px 0 6px;\n}\n.contact-name { font-size: 13px; font-weight: 600; }\n.contact-strategy { font-size: 11.5px; color: var(--team-text-2); }\n.contact-edit {\n  margin-left: auto;\n  flex: none;\n  padding: 2px 8px;\n  border: 1px solid var(--team-line);\n  border-radius: 6px;\n  background: #fff;\n  color: var(--team-text-2);\n  font-size: 11.5px;\n  cursor: pointer;\n}\n.contact-edit:hover { border-color: rgba(18, 167, 245, 0.4); color: var(--team-blue-deep); }\n.contact-members { padding-left: 8px; }\n.contact-member {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  padding: 3px 0;\n  font-size: 12px;\n}\n.contact-branch { color: var(--team-text-3); font-family: monospace; }\n.contact-member-model {\n  font-family: \"JetBrains Mono\", Consolas, monospace;\n  font-weight: 600;\n}\n.contact-member-from {\n  color: var(--team-text-3);\n  font-size: 11px;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.contact-role { flex: none; font-size: 11px; color: var(--team-text-3); }\n.contact-role-main { color: var(--team-blue-deep); font-weight: 600; }\n.contacts-foot {\n  flex: none;\n  padding: 10px 16px 12px;\n  border-top: 1px solid var(--team-line);\n  background: #fff;\n  text-align: center;\n}\n.fp-contacts { margin-top: 8px; }\n\n/* mention.css —— @ 选择群友的浮层：列表、悬停/键盘高亮、模型名省略。\n   浮层贴在输入区上方，宽度受输入框限制。 */\n\n.at-pop {\n  position: absolute;\n  left: 12px;\n  bottom: 56px;\n  width: min(320px, 70%);\n  /* 两块列表（本群群友 + 好友分组）要一屏放得下，太矮分组块会被裁掉 */\n  max-height: 320px;\n  overflow-y: auto;\n  padding: 6px;\n  border-radius: 10px;\n  background: #fff;\n  border: 1px solid var(--team-line);\n  box-shadow: var(--team-shadow);\n  z-index: 20;\n}\n.at-pop.hidden { display: none; }\n.at-pop-title {\n  padding: 4px 8px 6px;\n  font-size: 11px;\n  color: var(--team-text-3);\n}\n.at-item {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 7px 8px;\n  border-radius: 7px;\n  cursor: pointer;\n  font-size: 12.5px;\n}\n.at-item:hover, .at-item.active { background: var(--team-blue-soft); }\n.at-item .at-model {\n  font-family: \"JetBrains Mono\", Consolas, monospace;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n.at-item .at-tag { margin-left: auto; flex: none; font-size: 10px; color: var(--team-text-3); }\n\n/* 模型项的小头像，比群列表头像小一号 */\n.at-avatar {\n  width: 26px;\n  height: 26px;\n  border-radius: 7px;\n  font-size: 11px;\n}\n/* 分组项头像用圆角胶囊色，和单模型区分开 */\n.at-avatar-group {\n  background: linear-gradient(145deg, #fff4e6, #ffe7c7);\n  color: #b5730a;\n}\n/* 两块列表的分区标题 */\n.at-section {\n  padding: 6px 8px 3px;\n  font-size: 11px;\n  color: var(--team-text-3);\n  border-top: 1px solid var(--team-line);\n  margin-top: 4px;\n}\n.at-section:first-child { border-top: none; margin-top: 0; }\n";
// 由 build.cjs 从 ui/index.html 抽取的界面骨架（勿手改）
var UI_SKELETON_HTML = "<!-- 悬浮窗收起态：模型 pill + 圆球，整体可拖动 -->\n  <div class=\"float-dock\" id=\"floatDock\">\n    <!-- pill 在球左侧，球拖到屏幕最右边时不会被挤出视口 -->\n    <div class=\"float-pill\" id=\"floatPill\">\n      <span class=\"pill-model\">( — )</span>\n      <span class=\"pill-dot\"></span>\n    </div>\n    <button class=\"float-ball\" id=\"floatBall\" type=\"button\" title=\"点击展开模型团队悬浮窗（可拖动）\">\n      <span class=\"fb-target\" data-fb-target>—</span>\n      <span class=\"fb-dot\"></span>\n    </button>\n  </div>\n\n  <!-- 悬浮窗展开态：当前群聊 / 当前目标 / 本会话速率 / 全局请求量 -->\n  <section class=\"float-panel hidden\" id=\"floatPanel\" aria-label=\"模型团队悬浮窗\">\n    <header class=\"fp-head\" id=\"fpHead\">\n      <button class=\"fp-title-btn\" id=\"fpTitle\" type=\"button\" title=\"进入我的数据库\">👤 我的模型团队</button>\n      <span class=\"fp-model\" id=\"fpModel\">模型 —</span>\n      <span class=\"fp-ops\">\n        <button class=\"fp-btn\" id=\"fpMin\" type=\"button\" title=\"收起为悬浮球\">—</button>\n        <button class=\"fp-btn\" id=\"fpClose\" type=\"button\" title=\"关闭悬浮窗\">×</button>\n      </span>\n    </header>\n    <div class=\"fp-body\">\n      <div class=\"fp-row\"><span class=\"fp-k\">当前群聊：</span><span class=\"fp-v\" id=\"fpGroup\">—</span></div>\n      <div class=\"fp-row\"><span class=\"fp-k\">会话：</span><span class=\"fp-v\" id=\"fpSession\">—</span></div>\n      <div class=\"fp-row\"><span class=\"fp-k\">当前目标：</span><span class=\"fp-v\" id=\"fpTarget\">—</span></div>\n      <div class=\"fp-row\"><span class=\"fp-k\">📊 本会话速率：</span><span class=\"fp-v\" id=\"fpRate\">— tok/s</span></div>\n      <div class=\"fp-row\"><span class=\"fp-k\">📈 全局请求量：</span><span class=\"fp-v\" id=\"fpTotal\">—</span></div>\n    </div>\n    <footer class=\"fp-foot\">\n      <button class=\"fp-enter\" id=\"fpEnter\" type=\"button\">[ 进入群聊界面 &gt; ]</button>\n      <button class=\"fp-enter fp-contacts\" id=\"btnContacts\" type=\"button\">📇 通讯录 · 好友分组</button>\n    </footer>\n  </section>\n\n  <!-- 关闭悬浮窗后的召回入口 -->\n  <button class=\"float-recall hidden\" id=\"floatRecall\" type=\"button\">💬 呼出模型团队</button>\n\n  <!-- 模型团队主窗口：各视图渲染进 #viewRoot；底部固定三 tab（契约条款 21-24） -->\n  <main class=\"team-app\">\n    <header class=\"team-bar\">\n      <span class=\"team-logo\">团队</span>\n      <span class=\"team-view-name\" id=\"viewName\">消息</span>\n    </header>\n    <div class=\"team-body\" id=\"viewRoot\"></div>\n    <nav class=\"team-tabbar\" role=\"tablist\" aria-label=\"主导航\">\n      <button class=\"team-tab\" type=\"button\" role=\"tab\" data-view=\"list\" aria-selected=\"true\">\n        <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">\n          <path d=\"M20.5 14.5a2.5 2.5 0 0 1-2.5 2.5H9l-4.5 3v-3.2A2.5 2.5 0 0 1 3.5 14.5v-7A2.5 2.5 0 0 1 6 5h12a2.5 2.5 0 0 1 2.5 2.5z\"></path>\n          <path d=\"M7.5 9h9M7.5 12.5h6\"></path>\n        </svg>\n        <span class=\"team-tab-label\">消息</span>\n      </button>\n      <button class=\"team-tab\" type=\"button\" role=\"tab\" data-view=\"contacts\" aria-selected=\"false\">\n        <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">\n          <circle cx=\"9.5\" cy=\"8.5\" r=\"3.2\"></circle>\n          <path d=\"M3.8 19.5a5.7 5.7 0 0 1 11.4 0\"></path>\n          <circle cx=\"17.2\" cy=\"9.5\" r=\"2.3\"></circle>\n          <path d=\"M15.4 19.5a4.4 4.4 0 0 1 5.4-4\"></path>\n        </svg>\n        <span class=\"team-tab-label\">通讯录</span>\n      </button>\n      <button class=\"team-tab\" type=\"button\" role=\"tab\" data-view=\"profile\" aria-selected=\"false\">\n        <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">\n          <circle cx=\"12\" cy=\"8\" r=\"3.6\"></circle>\n          <path d=\"M5.2 20a6.8 6.8 0 0 1 13.6 0\"></path>\n        </svg>\n        <span class=\"team-tab-label\">我</span>\n      </button>\n    </nav>\n  </main>\n\n  <noscript><p class=\"noscript\">本预览需要启用 JavaScript 才能看到界面。</p></noscript>\n\n  <!-- 数据层：接口实现只有一份（lib/client-parts 里的 api-real.js）；设计稿注入「路径 → 假 JSON」的 mock 传输 -->";
// rate.js —— 模型团队速率计算（唯一实现，ui 预览与插件客户端共用）。
//
// 计算规则（真机踩过，别再改回 total/latency）：
//   1) 速率 = 输出 token / 耗时（生成速度），优先用后端字段 completionTokens + latencySeconds
//   2) 只有两者都是有效数字且 latencySeconds > 0 才算：completionTokens / latencySeconds
//   3) 禁止用 row.tokens（total，含输入）或 row.latency 字符串兜底：长上下文下 total 里 99% 是
//      promptTokens，40.3k / 4.56s 会算出 8837 tok/s，而真实生成速度只有 83 tok/s
//   4) 取不到 → null，展示层 formatRate(null) 输出 "—"
//
// 纯函数、零依赖、不碰 DOM；UMD 挂到全局，Node 里也能直接加载测试。
(function (root) {
  'use strict';

  // 解析 "40.3k" / "1.2M" / 数字；"—"/空/非法 → null（仅供展示与兼容，不参与速率）
  function parseTokenCount(text) {
    if (typeof text === 'number') return isFinite(text) ? text : null;
    const match = /^\s*([\d.]+)\s*([kKmM]?)\s*$/.exec(String(text == null ? '' : text));
    if (!match) return null;
    const value = parseFloat(match[1]);
    if (!isFinite(value)) return null;
    const unit = match[2].toLowerCase();
    if (unit === 'k') return value * 1000;
    if (unit === 'm') return value * 1000000;
    return value;
  }

  // 解析 "4.56s" / 数字秒；"—"/空/非法 → null
  function parseLatencySeconds(text) {
    if (typeof text === 'number') return isFinite(text) ? text : null;
    const match = /^\s*([\d.]+)\s*s\s*$/.exec(String(text == null ? '' : text));
    if (!match) return null;
    const value = parseFloat(match[1]);
    return isFinite(value) ? value : null;
  }

  // 单行的生成速率（tok/s）：只用 completionTokens + latencySeconds，拿不到返回 null
  // 注意用宽松比较 != null：历史行可能没有这两个字段（undefined），也可能显式是 null，两者都要跳过
  function computeGenerationRate(row) {
    if (!row || typeof row !== 'object') return null;
    const completionTokens = row.completionTokens;
    const latencySeconds = row.latencySeconds;
    if (completionTokens == null || latencySeconds == null) return null;
    if (typeof completionTokens !== 'number' || typeof latencySeconds !== 'number') return null;
    if (!isFinite(completionTokens) || !isFinite(latencySeconds) || latencySeconds <= 0) return null;
    return completionTokens / latencySeconds;
  }

  // 展示格式：<100 保留 1 位小数；>=100 取整；>=1000 用 k；无效 → "—"
  function formatRate(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '—';
    if (value >= 1000) return (value / 1000).toFixed(1) + 'k';
    if (value >= 100) return String(Math.round(value));
    return value.toFixed(1);
  }

  root.ModelTeamRate = {
    parseTokenCount: parseTokenCount,
    parseLatencySeconds: parseLatencySeconds,
    computeGenerationRate: computeGenerationRate,
    formatRate: formatRate
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
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
// store.js —— 唯一真相源 + 事件驱动（契约 docs/13）。
// 视图只能：读 getState()、subscribe(事件)、dispatch(action)；所有写入走 dispatch，渲染只由事件广播触发。
var STORE_EVENTS = ['session:changed', 'target:changed', 'chat:updated', 'stats:updated', 'groups:updated', 'platforms:updated', 'view:changed'];
var STORAGE_WRITE_DEBOUNCE_MS = 150;
var RATE_PLACEHOLDER_TEXT = '— tok/s';
// 持久化键由工厂单点持有（视图不再自己读写 localStorage）
var ANCHOR_STORAGE_KEY = 'dsh-model-team:anchor';
var SESSION_STORAGE_KEY = 'dsh-model-team:last-session';

function createTeamStore(options) {
  var api = options.api;
  var storage = options.storage || { read: function () { return null; }, write: function () {} };
  var sessionSource = options.sessionSource || null;
  var onRender = options.onRender || function () {};

  var listeners = {};
  STORE_EVENTS.forEach(function (eventName) { listeners[eventName] = []; });

  var state = {
    sessionId: null,
    sessionTitle: null,
    lastSessionId: null,
    target: null,                 // 本会话显式绑定的目标（可能为 null）
    effectiveTarget: null,        // 实际生效的目标（含后端回落），面板/球/群聊都用它
    targetSource: 'none',         // explicit | parent | last-session | fallback-group | none
    groups: [],
    platforms: [],
    currentGroupId: '',
    models: {},
    messages: {},
    rate: RATE_PLACEHOLDER_TEXT,
    global: { requests: 0, tokens: 0, text: '—' },
    view: 'list',
    anchor: null,
    errors: []
  };

  var loadedOnce = false;
  var pendingWrites = {};
  var writeTimer = null;

  // ---------- 错误出口（§八：预期失败静默，代码 bug 暴露） ----------
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

  // ---------- 持久化（§七：去抖 150ms + 退出 flush + loadedOnce 凭证） ----------
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

  // ---------- 事件广播（渲染也只由这里触发：删掉广播，对应场景就会红） ----------
  function renderNow() {
    try { onRender(state); }
    catch (error) { reportError('render', error); }
  }

  // 渲染器作为每个事件的内部订阅者：没有广播就没有渲染（A7 反向自证靠这一点）
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

  // ---------- 数据加载（apply：只改 state + 广播，不碰 DOM） ----------
  function loadGroups() {
    return Promise.all([api.getGroups(), api.getDrivers(), api.getFriendGroups(), api.getPlatforms()]).then(function (results) {
      state.groups = results[0] || [];
      state.drivers = results[1] || [];
      state.friendGroups = results[2] && results[2].groups ? results[2].groups : [];
      state.platforms = results[3] || [];
      if (!state.currentGroupId && state.groups.length) state.currentGroupId = state.groups[0].id;
      broadcast('groups:updated', { groups: state.groups });
      return state.groups;
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

  function loadChat(groupId) {
    var targetGroupId = groupId || state.currentGroupId;
    if (!targetGroupId) return Promise.resolve();
    return Promise.all([
      api.getSessionStats(targetGroupId),
      api.getGroupModels(targetGroupId),
      api.getSessionEvents(targetGroupId)
    ]).then(function (results) {
      state.models[targetGroupId] = results[1] || [];
      // 消息合并/排序只在工厂内：视图拿到的是唯一的一份有序数组
      state.messages[targetGroupId] = buildMessages(targetGroupId, results[0].rows, results[2].events);
      broadcast('chat:updated', { groupId: targetGroupId, messages: state.messages[targetGroupId] });
    });
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

  function start() {
    loadPersisted();                                      // R2：读回早于首帧
    document.addEventListener('visibilitychange', handlePageExit);
    window.addEventListener('pagehide', handlePageExit);  // pagehide 的目标是 window，不是 document
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
      return loadGroups();
    }).then(function () {
      return loadTargetAndStats();
    });
  }

  function stop() {
    if (sessionSource) sessionSource.stop();
    document.removeEventListener('visibilitychange', handlePageExit);
    window.removeEventListener('pagehide', handlePageExit);
    flushWrites();
  }

  // ---------- 视图动作 ----------
  function openView(view, groupId) {
    state.view = view || 'list';
    if (groupId) state.currentGroupId = groupId;
    broadcast('view:changed', { view: state.view, groupId: state.currentGroupId });
    if (state.view === 'chat' && state.currentGroupId) return loadChat(state.currentGroupId);
    // 加群页依赖平台清单：每次进入都重取（数据文件可能刚被改过），失败不阻断渲染
    if (state.view === 'add') return loadPlatforms().catch(function () { return state.platforms; });
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
      return loadChat(state.currentGroupId);
    }).then(function () {
      return loadStats();
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
      state.messages = {};
      state.rate = RATE_PLACEHOLDER_TEXT;
    }
    broadcast('session:changed', { sessionId: nextSessionId, previous: previous });
    return loadTargetAndStats();
  }

  function dispatch(action) {
    if (!action || typeof action.type !== 'string') return Promise.resolve();
    switch (action.type) {
      case 'start': return start();
      case 'stop': stop(); return Promise.resolve();
      case 'session-changed': return applySessionChanged(action.sessionId, action.sessionTitle);
      case 'load-groups': return loadGroups();
      case 'load-chat': return loadChat(action.groupId);
      case 'load-stats': return loadStats();
      case 'open-view': return openView(action.view, action.groupId);
      case 'refresh-platforms': return loadPlatforms();
      case 'switch-target': return switchTarget(action.target);
      case 'send-message': return sendMessage(action.text);
      case 'toggle-row': return toggleRow(action.groupId || state.currentGroupId, action.rowIndex);
      case 'set-anchor':
        state.anchor = action.anchor;
        persist(ANCHOR_STORAGE_KEY, JSON.stringify(action.anchor));
        return Promise.resolve();
      case 'view:rebuilt': renderNow(); return Promise.resolve();
      default: return Promise.resolve();
    }
  }

  return {
    getState: function () { return state; },
    getErrors: function () { return state.errors.slice(); },
    subscribe: subscribe,
    dispatch: dispatch,
    start: start,
    stop: stop,
    render: renderNow,
    flush: flushWrites,
    // 对外错误出口：视图层发现"元素缺失 / 显示值为空"这类代码 bug 时调用（契约 §8）
    reportError: function (tag, message) { reportError(tag, message); }
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

// 槽位桥组件：不渲染任何 DOM，只把当前会话 id（与标题）的变化灌进工厂。
// 槽位是 conversation.input.dock，props 形如 { session, input, useSessions }；
// session 为 undefined 表示"新会话草稿"，这时按 null 处理。
function createSessionBridgeComponent(reactRuntime) {
  return function SessionBridge(props) {
    const sessionId = (props && props.session && props.session.sessionId) || (props && props.sessionId) || null;
    const sessionTitle = readSessionTitle(props, sessionId);
    reactRuntime.useEffect(function () {
      pushSession(sessionId, sessionTitle);
    }, [sessionId, sessionTitle]);
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

// 视图一：群列表（= 平台账号列表）：顶部搜索 +「我」入口，每项右侧 lastUpdated 本地化时间
function renderGroupList(groups, currentGroupId, filterText) {
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
        <span class="group-driver">${escapeHtml(group.driverId)}</span>
      </div>
    </li>`;
  }).join('');

  return `<section class="view view-list">
    <div class="list-head">
      <h2>消息</h2>
      <input class="group-search" id="groupSearch" type="search" autocomplete="off"
             placeholder="🔍 搜索群聊 (账号)" value="${escapeHtml(filterText || '')}">
      <span class="list-count">${groups.length} 个群 · 每个群 = 一个平台账号</span>
      <button class="btn-me" id="btnMe" type="button">👤 我</button>
      <button class="btn-add" id="btnAddGroup" type="button">＋ 加群</button>
    </div>
    <ul class="group-list" id="groupList">${itemsHtml}</ul>
  </section>`;
}

// 视图二：群聊（sys 系统提示 / row 请求记录 / mine 我发出的 @）
// platform：当前群对应的平台信息，用于把请求行标成「[W] WorkBuddy(model)」
function renderChat(group, models, messages, platform) {
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
      <span class="group-tag">[群友: ${models.length}]</span>
      <span class="head-sub">群友 = 模型 · 消息 = 请求记录</span>
    </header>
    <div class="chat-stream" id="chatStream">${streamHtml}</div>
    <footer class="chat-input">
      <button class="btn-at" id="btnAt" type="button" title="选择群友或分组">@</button>
      <textarea id="msgInput" rows="1" autocomplete="off"
                placeholder="@ 选择群友或分组…"></textarea>
      <button class="btn-send" id="btnSend" type="button">发送</button>
      <div class="at-pop hidden" id="atPop">
        <div class="at-pop-title">选择群友（单模型）或好友分组（轮换组）—— 发送后切换本会话目标</div>
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
function renderAtModelItem(item, index) {
  return `<div class="at-item" data-at-type="model" data-at-id="${escapeHtml(item.id)}" data-index="${index}">
    <span class="avatar at-avatar">${escapeHtml(item.avatar || '[M]')}</span>
    <span class="at-model">${escapeHtml(item.display || item.label)}</span>
    <span class="at-tag">群友</span>
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

function renderAddressBook(friendGroups, groups, drivers) {
  const groupNameById = {};
  groups.forEach(function (group) { groupNameById[group.id] = group.name; });
  const driverById = {};
  (drivers || []).forEach(function (driver) { driverById[driver.id] = driver; });

  const itemsHtml = friendGroups.map(function (friendGroup) {
    const isFallback = friendGroup.strategy === 'fallback';
    const membersHtml = friendGroup.members.map(function (member, memberIndex) {
      const driver = driverById[member.platformId];
      // 平台显示名取短名（CodeArts (华为云) → CodeArts），与界面稿的 "(来自 CodeArts)" 对齐
      const driverName = driver ? String(driver.name).split(' (')[0] : (groupNameById[member.platformId] || member.platformId);
      const driverAvatar = member.platformAvatar || (driver ? driver.avatar : '[?]');
      const branch = memberIndex === friendGroup.members.length - 1 ? '└─' : '├─';
      // fallback 组按数组顺序标主/备：第一个是主，其余是备
      let roleTag = '';
      if (isFallback) roleTag = memberIndex === 0 ? '<span class="contact-role contact-role-main">[主]</span>' : '<span class="contact-role">[备]</span>';
      return `<div class="contact-member">
        <span class="contact-branch">${branch}</span>
        <span class="avatar">${escapeHtml(driverAvatar)}</span>
        <span class="contact-member-model">${escapeHtml(member.modelId)}</span>
        <span class="contact-member-from">(来自 ${escapeHtml(driverName)})</span>
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

// 解析平台选择值：preset:<id> → 预置对象；driver:<id> → 驱动对象（无预置）
function resolvePlatformSelection(platforms, drivers, selectedValue) {
  const rawValue = typeof selectedValue === 'string' ? selectedValue : '';
  if (rawValue.indexOf('driver:') === 0) {
    const driverId = rawValue.slice('driver:'.length);
    const driver = (drivers || []).filter(function (item) { return item.id === driverId; })[0] || null;
    return { platform: null, driver: driver, driverId: driverId };
  }
  const presetId = rawValue.indexOf('preset:') === 0 ? rawValue.slice('preset:'.length) : rawValue;
  const platform = (platforms || []).filter(function (item) { return item.id === presetId; })[0]
    || (platforms || [])[0] || null;
  const driver = platform
    ? ((drivers || []).filter(function (item) { return item.id === platform.driverId; })[0] || (drivers || [])[0] || null)
    : ((drivers || [])[0] || null);
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
      <div class="form-note">阶段 1 演示：提交只做表单校验提示，不会发起任何请求。</div>
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
        <div class="conn-meta conn-meta-compact">${escapeHtml(group.driverId)}</div>
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
// chat.js —— 群聊交互：@ 选择器、插入输入框、发送与切换目标（写入一律走 store.dispatch）。
// 消息合并/排序/系统提示都归工厂：这里不再本地插 system 文案，也不直接调 api 改会话。

// 选择器条目：本群群友（带来源平台）在前、好友分组（带成员数）在后，键盘用同一份 items 索引
function buildAtSections() {
  const current = ensureState();
  const activeGroup = currentGroup();
  const activeDriver = current ? current.drivers.filter(function (driver) {
    return driver.id === (activeGroup && activeGroup.driverId);
  })[0] : null;
  const driverName = activeDriver
    ? String(activeDriver.name).split(' (')[0]
    : (activeGroup ? activeGroup.driverId : '');

  const modelItems = modelsOf(current.currentGroupId).map(function (model) {
    const shortName = String(model.name || model.id).replace(/^global:/, '');
    return {
      type: 'model',
      id: model.id,
      label: shortName,
      display: driverName ? shortName + ' (' + driverName + ')' : shortName,
      avatar: '[' + shortName.charAt(0).toUpperCase() + ']'
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
    store.dispatch({
      type: 'switch-target',
      target: { type: 'model', id: matchedModel.id, platformId: current.currentGroupId }
    });
  }
}
// admin.js —— 管理侧交互：加群提交、数据库导入导出。
// 导出取 api.exportConfig() 的结果触发下载；导入交给 api.importConfig() 校验后展示回执。

const REVOKE_URL_DELAY_MS = 1500;   // 下载触发后延迟回收 blob URL
const GROUP_ID_SUFFIX_LENGTH = 8;   // 新群名后面拼的 id 尾号长度

// 提交加群表单：选中的平台决定 driver（authSchema 校验）与默认头像/摘要模板。
// 平台信息全部来自 /_team/platforms，这里只用返回值，不写死任何平台字段。
function submitNewGroup() {
  const current = ensureState();
  // 平台选择值有两种形态：preset:<平台id>（预置，带 baseURL/头像/摘要模板）
  // 或 driver:<驱动id>（通用入口，只有驱动本身）。两种都要支持提交。
  const selection = resolvePlatformSelection(current.platforms || [], current.drivers || [], viewState.addForm.platformId);
  const selectedPlatform = selection.platform;
  const selectedDriver = selection.driver;
  if (!selectedDriver) { toast('平台/驱动列表未就绪'); return; }

  // 以 DOM 里的实际表单值为准：预填值只写进了 input 的 value，不一定同步回 viewState
  const nameNode = document.querySelector('#groupNameInput');
  const groupName = String((nameNode && nameNode.value) || viewState.addForm.name || '').trim();
  if (!groupName) { toast('请填写群名称'); return; }

  const authValues = {};
  Array.prototype.slice.call(document.querySelectorAll('[data-auth-key]')).forEach(function (node) {
    authValues[node.dataset.authKey] = String(node.value || '').trim();
  });

  const missingLabels = (selectedDriver.authSchema || []).filter(function (field) {
    return field.required && !authValues[field.key];
  }).map(function (field) { return field.label; });
  if (missingLabels.length) { toast('请填写必填项：' + missingLabels.join('、')); return; }

  const groupId = 'mock-' + Date.now().toString(36);
  // 摘要按平台模板渲染（{baseURL} 占位），模板也来自后端
  const domBaseURL = document.querySelector('[data-auth-key="baseURL"]');
  const baseURL = String((domBaseURL && domBaseURL.value) || viewState.addForm.values.baseURL || (selectedPlatform && selectedPlatform.baseURL) || '');
  const summaryTemplate = (selectedPlatform && selectedPlatform.summaryTemplate) || '已连接 · {baseURL}';
  const summary = summaryTemplate.replace('{baseURL}', baseURL);

  const newGroup = {
    id: groupId,
    name: groupName + '(' + groupId.slice(-GROUP_ID_SUFFIX_LENGTH) + ')',
    avatar: (selectedPlatform && selectedPlatform.avatar) || selectedDriver.avatar || '',
    driverId: selectedDriver.id,
    platformId: selectedPlatform ? selectedPlatform.id : '',
    credentialRef: 'local://' + (selectedPlatform ? selectedPlatform.id : selectedDriver.id) + '/' + groupId,
    summary: summary,
    lastUpdated: new Date().toISOString()
  };
  // 提交载荷：平台头像与摘要模板一并带给后端（群配置字段）
  // 模型目录：manual 且有有效行 → models.static；否则走自动拉取 models.endpoint
  const staticModels = collectStaticModels();
  const modelsPayload = staticModels.length
    ? { static: staticModels }
    : { endpoint: (selectedPlatform && selectedPlatform.modelsEndpoint) || '/models' };

  // 提交载荷按 docs/09「POST /_team/groups 请求体（冻结）」逐字段对齐：
  //   driver（不是 driverId）、baseURL 在顶层、summary 是 { template } 对象、auth 只放凭证。
  //   读侧（GET /_team/groups）仍用 driverId，两套命名不要混。
  const submitPayload = {
    name: groupName,
    driver: selectedDriver.id,
    baseURL: String(baseURL || '').trim(),
    auth: { apiKey: authValues.apiKey },
    models: modelsPayload,
    avatar: newGroup.avatar
  };
  if (summaryTemplate) {
    submitPayload.summary = { template: summaryTemplate };
  }

  newGroup.modelCount = staticModels.length || null;

  api.createGroup(submitPayload).catch(function () { return null; }).then(function () {
    current.groups.push(newGroup);
    viewState.addForm = { platformId: selectedPlatform.id, name: '', values: {} };
    viewState.modelCatalog = { mode: 'auto', models: [], probe: { loading: false, error: '' } };
    toast('已添加群聊：' + selectedPlatform.name + ' · ' + groupName);
    store.render();
    switchView('list');
  });
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
        const rowHtml = importResult.accepted.map(function (group) {
          return `<tr><td>${escapeHtml(group.id)}</td><td>${escapeHtml(group.name)}</td>`
            + `<td>${escapeHtml(group.driverId)}</td><td>${escapeHtml(group.credentialRef || '—')}</td></tr>`;
        }).join('');
        showModal('导入解析结果', `
          <p class="modal-p">文件名：<b>${escapeHtml(selectedFile.name)}</b> · 大小 ${selectedFile.size} 字节</p>
          <p class="modal-p">可导入 <b>${importResult.accepted.length}</b> 个平台账号，结构不合法 ${importResult.rejected.length} 条；阶段 1 只展示结果，不写入存储。</p>
          <table class="modal-table">
            <thead><tr><th>id</th><th>name</th><th>driverId</th><th>credentialRef</th></tr></thead>
            <tbody>${rowHtml || '<tr><td colspan="4">（无 groups 数据）</td></tr>'}</tbody>
          </table>`);
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
const DOCK_EDGE_KEEP_PX = 8;         // 球离视口边缘的最小距离
const BALL_VIEWPORT_KEEP_PX = 70;    // 球本身占位，避免拖出可视区
const PANEL_FALLBACK_WIDTH = 384;    // 面板未渲染完成时的兜底尺寸
const PANEL_FALLBACK_HEIGHT = 210;

let dragState = null;                // 当前拖动上下文（球或面板）
let dragFrameId = 0;                 // rAF 句柄：同一帧只写一次 transform
let dragPendingPosition = null;      // 等待写入的位置
let dockElement = null;              // 缓存球容器，拖动中不逐帧 querySelector

// 面板贴在球左上方，上方放不下就翻到下方，最后夹进视口
function positionPanel() {
  const floatPanel = findElement('#floatPanel');
  const floatDock = findElement('#floatDock');
  if (!floatPanel || !floatDock || floatPanel.classList.contains('hidden')) return;
  const dockRect = floatDock.getBoundingClientRect();
  const panelWidth = floatPanel.offsetWidth || PANEL_FALLBACK_WIDTH;
  const panelHeight = floatPanel.offsetHeight || PANEL_FALLBACK_HEIGHT;
  let leftPosition = dockRect.right - panelWidth;
  let topPosition = dockRect.top - panelHeight - PANEL_GAP_PX;
  if (topPosition < VIEWPORT_MARGIN_PX) topPosition = dockRect.bottom + PANEL_GAP_PX;
  leftPosition = Math.max(VIEWPORT_MARGIN_PX, Math.min(leftPosition, window.innerWidth - panelWidth - VIEWPORT_MARGIN_PX));
  topPosition = Math.max(VIEWPORT_MARGIN_PX, Math.min(topPosition, window.innerHeight - panelHeight - VIEWPORT_MARGIN_PX));
  floatPanel.style.left = leftPosition + 'px';
  floatPanel.style.top = topPosition + 'px';
}

function showPanel() {
  findElement('#floatPanel').classList.remove('hidden');
  positionPanel();
}

function hidePanel() {
  findElement('#floatPanel').classList.add('hidden');
}

// 锚点只从 store 读（契约 R1：持久化项的唯一真相源在工厂，视图不再自己读写 localStorage）
function readDockAnchor() {
  const current = ensureState();
  const anchor = current && current.anchor;
  if (!anchor || typeof anchor.left !== 'number' || typeof anchor.top !== 'number') return null;
  const maxLeft = window.innerWidth - BALL_VIEWPORT_KEEP_PX;
  const maxTop = window.innerHeight - BALL_VIEWPORT_KEEP_PX;
  if (anchor.left < DOCK_EDGE_KEEP_PX || anchor.top < DOCK_EDGE_KEEP_PX) return null;
  if (anchor.left > maxLeft || anchor.top > maxTop) return null;
  return { left: anchor.left, top: anchor.top };
}

// 存锚点走工厂（去抖 150ms + 退出 flush 由 store 负责）
function saveDockAnchor(anchor) {
  if (store) store.dispatch({ type: 'set-anchor', anchor: anchor });
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
      const nextLeft = Math.max(VIEWPORT_MARGIN_PX, Math.min(dragState.startRect.left + deltaX, window.innerWidth - floatPanel.offsetWidth - VIEWPORT_MARGIN_PX));
      const nextTop = Math.max(VIEWPORT_MARGIN_PX, Math.min(dragState.startRect.top + deltaY, window.innerHeight - floatPanel.offsetHeight - VIEWPORT_MARGIN_PX));
      dragState.last = { left: nextLeft, top: nextTop };
      scheduleDockFrame(nextLeft, nextTop);
      return;
    }

    const nextLeft = Math.max(DOCK_EDGE_KEEP_PX, Math.min(dragState.startRect.left + deltaX, window.innerWidth - BALL_VIEWPORT_KEEP_PX));
    const nextTop = Math.max(DOCK_EDGE_KEEP_PX, Math.min(dragState.startRect.top + deltaY, window.innerHeight - BALL_VIEWPORT_KEEP_PX));
    dragState.last = { left: nextLeft, top: nextTop };
    scheduleDockFrame(nextLeft, nextTop);
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
    const targetPosition = finishedDrag.last || { left: finishedDrag.startRect.left, top: finishedDrag.startRect.top };
    commitDockPosition(targetPosition.left, targetPosition.top);
    saveDockAnchor({ left: Math.round(targetPosition.left), top: Math.round(targetPosition.top) });
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
  window.addEventListener('resize', positionPanel);
}

// 悬浮球/面板显示的当前目标：单模型 → 模型名（过长截断），分组 → @分组名，未设置 → —
const BALL_TARGET_MAX_CHARS = 9;

function formatBallTarget(label) {
  if (!label || label === '—') return '—';
  if (label.length <= BALL_TARGET_MAX_CHARS) return label;
  return label.slice(0, BALL_TARGET_MAX_CHARS) + '…';
}

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

// 会话行：有标题显示「标题（短 id）」，没标题只显示短 id，没有会话显示 —
// 短 id 取「去掉 session- 前缀后的前 8 位」——直接取原串前 8 位会永远是 "session-"，无法区分会话
function formatSessionLabel(current) {
  const sessionId = current && current.sessionId;
  if (!sessionId) return FLOAT_PLACEHOLDER;
  const shortId = String(sessionId).replace(/^session-/, '').slice(0, 8);
  const title = current.sessionTitle;
  return title ? title + '（' + shortId + '）' : shortId;
}

function renderFloat(current) {
  applyStoredAnchorOnce();
  if (!current) return;
  const label = targetLabel();

  const ballTarget = findElement('#floatBall [data-fb-target]');
  if (ballTarget) ballTarget.textContent = formatBallTarget(label);
  setFloatText('#fpModel', '模型 ' + label);
  setFloatText('#floatPill .pill-model', '( ' + label + ' )');

  const activeGroup = currentGroup();
  setFloatText('#fpGroup', activeGroup ? activeGroup.name : '');
  setFloatText('#fpSession', formatSessionLabel(current));
  setFloatTarget('#fpTarget', label, targetSourceHint());
  setFloatText('#fpRate', current.rate, '— tok/s');
  setFloatText('#fpTotal', current.global && current.global.text);
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
  const toastNode = findElement('#toast');
  if (!toastNode) return;
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
function platformOf(group) {
  const current = ensureState();
  if (!group || !current) return null;
  const driver = current.drivers.filter(function (item) { return item.id === group.driverId; })[0];
  return {
    avatar: group.avatar || (driver ? driver.avatar : '[G]'),
    name: driver ? String(driver.name).split(' (')[0] : group.driverId
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

// 来源提示：只有「本会话没显式绑定、由后端回落」时才显示（浅色小字，跟在目标名后面）
const TARGET_SOURCE_HINTS = {
  'last-session': '（继承上一会话）',
  parent: '（继承父会话）',
  'fallback-group': '（兜底群默认）'
};

function targetSourceHint() {
  const current = ensureState();
  if (!current || !current.effectiveTarget) return '';
  if (current.target) return '';                       // 显式绑定过 → 不带提示
  return TARGET_SOURCE_HINTS[current.targetSource] || '';
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
        return [group.name, group.summary, group.driverId, group.id].join(' ').toLowerCase().indexOf(keyword) >= 0;
      })
      : current.groups;

    // 焦点只在"本来就在搜索框里"时恢复：不能无条件 focus，
    // 否则每次进群聊界面都会把焦点塞进搜索框（移动端直接弹键盘）。
    const activeElement = document.activeElement;
    const hadSearchFocus = !!activeElement && activeElement.id === 'groupSearch';
    const caretStart = hadSearchFocus ? activeElement.selectionStart : null;
    const caretEnd = hadSearchFocus ? activeElement.selectionEnd : null;

    viewRoot.innerHTML = renderGroupList(visibleGroups, current.currentGroupId, viewState.groupFilter || '');

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
    viewRoot.innerHTML = renderChat(activeGroup, modelsOf(activeGroup.id), currentMessages(), platformOf(activeGroup));
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
    viewRoot.innerHTML = renderAddressBook(current.friendGroups, current.groups, current.drivers);
    viewName.textContent = '通讯录';
  } else {
    viewRoot.innerHTML = renderProfile(current.groups);
    viewName.textContent = '我的';
  }

  const chatStream = findElement('#chatStream');
  if (chatStream) chatStream.scrollTop = keptScrollTop == null ? chatStream.scrollHeight : keptScrollTop;

  // 悬浮窗（球/标题/目标/pill/统计）也由同一个渲染出口派生，不再有"手动补丁"函数
  renderFloat(current);
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
    if (buttonId === 'btnAddModelRow') { addModelRow(); return; }
    if (buttonId === 'btnAddGroup') switchView('add');
    else if (buttonId === 'btnChatBack' || buttonId === 'btnAddBack' || buttonId === 'btnDatabaseBack' || buttonId === 'btnContactsBack') switchView('list');
    else if (buttonId === 'btnAt') {
      const messageInput = findElement('#msgInput');
      if (messageInput) { messageInput.focus(); openAtPop(); }
    }
    else if (buttonId === 'btnSend') sendMessage();
    else if (buttonId === 'btnMe') switchView('profile');
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
    fetchSessionOnce();
  }
}

exports.apply = apply;
exports.inject = ["slots"];
return module.exports;
  }
});
