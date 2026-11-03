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
