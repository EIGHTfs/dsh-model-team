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

// 结论的「信息量」分级：
//   2 级 = 拿到了值（ours / other）
//   1 级 = 没有可用值（unknown：值还没到；degraded：连通道都没有）
// 桥可能被多次挂载（宿主多个槽位/重渲染），**"没有值"的挂载不得覆盖"有值"的结论**——
// 否则"先判出 ours、后被无 projection 的挂载改写成 degraded"会让球永久隐藏（真机实测就是这个顺序）。
// unknown 与 degraded 同级：两者都不显示，谁在后就记谁（日志更准），互不构成信息损失。
// 同级允许更新，保证 other → ours 这种真实变化能生效。
var DOCK_DECISION_LEVELS = { degraded: 1, unknown: 1, other: 2, ours: 2 };

function dockDecisionLevel(decision) {
  return Object.prototype.hasOwnProperty.call(DOCK_DECISION_LEVELS, decision)
    ? DOCK_DECISION_LEVELS[decision]
    : DOCK_DECISION_LEVELS.degraded;
}

// 是否该用新结论覆盖上一个结论（纯函数，便于单测）
function shouldApplyDockDecision(nextDecision, lastDecision) {
  if (!lastDecision) return true;
  return dockDecisionLevel(nextDecision) >= dockDecisionLevel(lastDecision);
}

// 每次结论变化打一行（含理由），便于现场判断"为什么球不显示"；结论没变就不刷屏
var lastDockLogKey = null;
var lastAppliedDecision = null;
function reportDockDecision(result) {
  if (!shouldApplyDockDecision(result.decision, lastAppliedDecision)) {
    // 低信息量的挂载不改写已有结论；保持当前显隐不动
    return lastAppliedDecision;
  }
  var logKey = result.decision + "|" + result.reason;
  if (logKey !== lastDockLogKey) {
    lastDockLogKey = logKey;
    try {
      console.info("[dock] " + result.decision + " ← " + result.reason);
    } catch (logError) { /* 没有 console 的环境不影响显隐 */ }
  }
  lastAppliedDecision = result.decision;
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
  // 取值通道统一走适配层（model-selection-source.js）：老宿主 session.projections.faceOf 只是其中一种，
  // 以后官方换版本只改适配层，这里与判定逻辑都不动。
  var source = resolveModelSelectionSource({ session: session, projectionKey: key });
  if (!source) return null;
  var emit = function () {
    if (typeof onChange === "function") onChange(source.getSnapshot());
  };
  var unsubscribe = source.subscribe(emit);
  // 订阅成功后立刻取一次快照：值可能在订阅之前就已设定（恢复历史会话就是这样）
  emit();
  return typeof unsubscribe === "function" ? unsubscribe : null;
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

    // 取值通道由适配层探测（useProjection / session.projections / props 直传 / session 快照）
    const selectionSource = resolveModelSelectionSource(props);
    const hasProjection = Boolean(selectionSource);
    if (!hasProjection) {
      warnOnce('宿主未提供任何模型选择通道，INV-14 判定为 degraded（隐藏）', null);
    }
    let selection;
    if (hasProjection) {
      try {
        selection = selectionSource.getSnapshot();
      } catch (error) {
        warnOnce('modelSelection.getSnapshot', error);
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
      const unsubscribe = selectionSource ? selectionSource.subscribe(function () {
        // 新值到达：先记输入（meta 迟到的重算要用最新值），再立即下发，不等 React 再渲染一次
        applyDockDecision(rememberDockInputs(selectionSource.getSnapshot(), true));
      }) : null;
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
