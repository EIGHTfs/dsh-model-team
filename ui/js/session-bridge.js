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
// 读的是宿主运行时 projection（modelSelection），取值形如 { next, lastUsed }，
// 每一项是 { provider, model, reasoningEffort }；两个字段都要比：
//   provider = 本插件 llm 适配器注册的路由名，model = config.virtualModel（缺省 dsh-model-team）。
// 返回三态：'ours' | 'other' | 'unknown'
//   unknown = projection 还没有值（宿主未挂载 / 首帧未到）→ 按不显示处理，且不抛错
function resolveModelSelectionState(useProjection) {
  let selection;
  try {
    selection = useProjection(MODEL_SELECTION_PROJECTION_KEY);
  } catch (error) {
    warnOnce('useProjection(modelSelection)', error);
    return 'unknown';
  }
  if (!selection) return 'unknown';
  const current = selection.next || selection.lastUsed;
  if (!current) return 'unknown';
  const usingOurs = current.provider === OUR_PROVIDER_ID && current.model === VIRTUAL_MODEL_ID;
  return usingOurs ? 'ours' : 'other';
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
    const hasProjection = Boolean(props && typeof props.useProjection === 'function');
    if (!hasProjection) {
      warnOnce('宿主未提供 useProjection，INV-14 降级为常显', null);
    }
    const selectionState = hasProjection ? resolveModelSelectionState(props.useProjection) : 'degraded';

    reactRuntime.useEffect(function () {
      pushSession(sessionId, sessionTitle);
    }, [sessionId, sessionTitle]);

    // 响应式：projection 变化 → 组件重渲染 → 这里重新执行 → 球即时显隐（无需刷新页面）
    reactRuntime.useEffect(function () {
      if (selectionState === 'degraded') {
        applyDockVisibility(true);
        return;
      }
      applyDockVisibility(selectionState === 'ours');
    }, [selectionState]);

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
