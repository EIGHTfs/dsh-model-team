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
