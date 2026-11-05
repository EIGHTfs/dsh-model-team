// 会话事件排序：`at` 为 null/不可解析的历史事件排在最前（没有可比时间），其余按 `at` 升序；
// 同一时刻保持写入顺序（显式下标兜底，不依赖引擎排序稳定性）。
// 独立成文件是因为 JSONL 读取与可能的其它消费方都要用，放在 session-store 里会让它超长。

// at 解析：不是合法时间串一律当作"没有时间"，参与排序时排在最前
function toEventTimeMs(atValue) {
  if (typeof atValue !== 'string' || atValue.length === 0) {
    return null;
  }
  const parsedMs = Date.parse(atValue);
  return Number.isFinite(parsedMs) ? parsedMs : null;
}

export function sortSessionEvents(events) {
  return events
    .map((event, appendIndex) => ({ event, appendIndex }))
    .sort((leftEntry, rightEntry) => {
      const leftMs = toEventTimeMs(leftEntry.event.at);
      const rightMs = toEventTimeMs(rightEntry.event.at);
      if (leftMs === null && rightMs === null) {
        return leftEntry.appendIndex - rightEntry.appendIndex;
      }
      if (leftMs === null) {
        return -1;
      }
      if (rightMs === null) {
        return 1;
      }
      const timeDelta = leftMs - rightMs;
      return timeDelta !== 0 ? timeDelta : leftEntry.appendIndex - rightEntry.appendIndex;
    })
    .map((entry) => entry.event);
}
