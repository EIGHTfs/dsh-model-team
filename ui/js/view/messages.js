// messages.js —— 消息流构建：把「请求记录 rows」与「会话事件 events」合并成一条按时间排序的消息列表。
// 单独成文件是为了让 app.js 保持精简（交互与渲染入口已够长），也方便单测排序规则。

// 消息排序键：**绝对时间优先**（docs/02 §3.2 的 startedAt / 事件的 at）。
// 为什么不能只取时分秒：那等于丢掉日期，跨午夜必然把"今天 00:11"判成比"昨天 23:50"更早。
// 三级口径：
//   ① 有绝对时间（startedAt / at / startedAtMs）→ 直接用 epoch 毫秒比较
//   ② 只有 time（老数据没有绝对时间）→ 无法判断是哪一天，**整体排在所有绝对时间之后**，
//      组内再按 HH:mm:ss 升序（不猜日期，也不打乱彼此顺序）
//   ③ 连 time 都没有 → 排最后，且彼此保持后端顺序
// 秒 → 毫秒：只有 time 字段时用它把「时分秒」换算成偏移
const MILLISECONDS_PER_SECOND = 1000;
// 没有绝对时间的条目统一落在这个基数之上（留 10 亿余量给"当天毫秒偏移"，最大 86,400,000）
const NO_ABSOLUTE_TIME_BASE = Number.MAX_SAFE_INTEGER - 1000000000;
const NO_TIME_AT_ALL = Number.MAX_SAFE_INTEGER;

/** 绝对时间（epoch 毫秒）：startedAt(ISO) → at(ISO) → startedAtMs(number)；都没有返回 null */
function absoluteTimeOf(source) {
  if (!source) return null;
  if (typeof source.startedAtMs === 'number' && Number.isFinite(source.startedAtMs)) return source.startedAtMs;
  const isoTimestamp = typeof source.startedAt === 'string' ? source.startedAt : (typeof source.at === 'string' ? source.at : null);
  if (!isoTimestamp) return null;
  const parsed = Date.parse(isoTimestamp);
  return Number.isNaN(parsed) ? null : parsed;
}

/** 只有时分秒时的时间偏移（毫秒）；解析不出来返回 null */
function clockOffsetOf(source) {
  const clockMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String((source && source.time) || ''));
  if (!clockMatch) return null;
  const hours = Number(clockMatch[1]);
  const minutes = Number(clockMatch[2]);
  const seconds = Number(clockMatch[3] || 0);
  return (hours * 3600 + minutes * 60 + seconds) * MILLISECONDS_PER_SECOND;
}

function messageSortValue(source) {
  const absoluteTime = absoluteTimeOf(source);
  if (absoluteTime !== null) return absoluteTime;
  const clockOffset = clockOffsetOf(source);
  // 没有绝对时间：整体排在绝对时间之后；组内仍按时间升序（偏移越大 = 越晚 = 键越大）
  if (clockOffset !== null) return NO_ABSOLUTE_TIME_BASE + clockOffset;
  return NO_TIME_AT_ALL;
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
