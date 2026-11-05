// 会话标题解析：移植自 dsh-session-conductor 的权威实现，不另起一套。
// 来源（逐条对应，便于回溯）：
//   - titleString / foldTitle / resolveSessionTitle：dsh-session-conductor/lib/features/rename/title.js
//   - sessionEventList：dsh-session-conductor/lib/sessions/events.js:73
// 需求意图：宿主 sessionTitle 服务返回的是**标题快照对象**（{title, source, eventSeq}），不是字符串；
//          且它的 get(session) 只接受真正的 live Session（有 snapshotEvents 方法），喂普通摘要对象会抛。
//          所以必须先拿到活会话对象、try/catch 调服务，拿不到再回退"从事件流折叠最近一次持久化标题"。

// 快照归一：服务可能给字符串、也可能给 {title, ...}；都拿不到就返回 undefined
export function titleString(snapshot) {
  if (typeof snapshot === 'string') {
    return snapshot;
  }
  if (snapshot !== null && typeof snapshot === 'object' && typeof snapshot.title === 'string') {
    return snapshot.title;
  }
  return undefined;
}

// 回退：从事件流里折叠最近一次持久化标题（session/title 事件）
export function foldTitle(events) {
  if (!Array.isArray(events)) {
    return undefined;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') {
      return event.data.title;
    }
  }
  return undefined;
}

// live Session 的 events 可能不是数组，优先 snapshotEvents()；非 Session 对象返回空数组
export function sessionEventList(session) {
  if (Array.isArray(session?.events)) {
    return session.events;
  }
  try {
    const snapshot = session?.snapshotEvents?.();
    if (Array.isArray(snapshot)) {
      return snapshot;
    }
  } catch {
    // 非 Session 对象
  }
  return [];
}

// 取会话标题：优先 sessionTitle 服务（只认 live Session），失败回退事件流；都没有返回 null
export function resolveSessionTitle(sessionTitle, session, events) {
  if (sessionTitle && session && typeof session.snapshotEvents === 'function') {
    try {
      const title = titleString(sessionTitle.get(session));
      if (title) {
        return title;
      }
    } catch {
      // 非 live Session 或 get() 签名变化：交给事件流回退
    }
  }
  return foldTitle(events) ?? null;
}
