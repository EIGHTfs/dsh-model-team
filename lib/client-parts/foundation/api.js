// api.js —— 数据层唯一实现：接口名、请求路径、返回结构都只写在这里。
// 新增接口只改本文件一处。
// 当前会话由 store 通过 setActiveSession() 注入。
// 注意：本文件的分片与 ui/js/* 合并进同一作用域，变量名不要与 ui 分片的顶层 const 重名
// （同名的 var 与 const 会让后加载的脚本整体 SyntaxError 不执行，踩过）。
var activeSessionId = null;
function setActiveSession(sessionId) {
  activeSessionId = typeof sessionId === "string" && sessionId ? sessionId : null;
}

function apiJson(path, options) {
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
      const serverError = body && body.error;
      const error = new Error((serverError && serverError.message) || "服务端未返回群信息");
      error.code = (serverError && serverError.code) || "CREATE_GROUP_FAILED";
      if (serverError && serverError.hint) error.hint = serverError.hint;
      throw error;
    });
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
