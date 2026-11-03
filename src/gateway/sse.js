// SSE（text/event-stream）解析：把上游字节流拆成一条条事件，供驱动与 HTTP 透传共用。
// 需求意图：流式回复必须逐块透传、禁止整体缓冲（docs/09 §12）；解析只写一份，避免两条路径漂移。
// 思路：TextDecoder 流式解码 + 按 \n 切行（兼容 CRLF）；空行结束一个事件；`data:` 多行按规范用 \n 拼接；
//      以 ':' 开头的注释行与未知字段一律忽略；`[DONE]` 由调用方判断（这里不吞掉）。

// SSE 字段前缀与结束标记：字面量集中在此，避免调用点各写一份
export const SSE_DATA_PREFIX = 'data:';
export const SSE_EVENT_PREFIX = 'event:';
export const SSE_COMMENT_PREFIX = ':';
export const SSE_DONE_MARKER = '[DONE]';

// 逐行状态机：喂一行，返回"事件已完成"时的对象，否则 null
function createSseLineParser() {
  let currentEventName = null;
  let dataLines = [];

  const buildEvent = () => {
    const event = { event: currentEventName, data: dataLines.join('\n') };
    currentEventName = null;
    dataLines = [];
    return event;
  };

  return {
    pushLine(rawLine) {
      if (rawLine.length === 0) {
        return dataLines.length > 0 ? buildEvent() : null;
      }
      if (rawLine.startsWith(SSE_COMMENT_PREFIX)) {
        return null;
      }
      if (rawLine.startsWith(SSE_EVENT_PREFIX)) {
        currentEventName = rawLine.slice(SSE_EVENT_PREFIX.length).trim();
        return null;
      }
      if (rawLine.startsWith(SSE_DATA_PREFIX)) {
        // 规范允许 data: 后带一个空格，去掉它但保留其余空白
        dataLines.push(rawLine.slice(SSE_DATA_PREFIX.length).replace(/^ /, ''));
        return null;
      }
      return null;
    },
    // 流结束时可能还剩一个没有空行收尾的事件
    flush() {
      return dataLines.length > 0 ? buildEvent() : null;
    },
  };
}

// 把字节流解析成事件流：入参是 fetch 的 response.body（Node 的 web ReadableStream）
export async function* parseSseEvents(byteStream) {
  if (!byteStream) {
    return;
  }
  const textDecoder = new TextDecoder('utf-8');
  const lineParser = createSseLineParser();
  let pendingText = '';

  for await (const byteChunk of byteStream) {
    pendingText += textDecoder.decode(byteChunk, { stream: true });
    let lineBreakIndex = pendingText.indexOf('\n');
    while (lineBreakIndex >= 0) {
      const rawLine = pendingText.slice(0, lineBreakIndex).replace(/\r$/, '');
      pendingText = pendingText.slice(lineBreakIndex + 1);
      const parsedEvent = lineParser.pushLine(rawLine);
      if (parsedEvent) {
        yield parsedEvent;
      }
      lineBreakIndex = pendingText.indexOf('\n');
    }
  }

  pendingText += textDecoder.decode();
  if (pendingText.length > 0) {
    const parsedEvent = lineParser.pushLine(pendingText.replace(/\r$/, ''));
    if (parsedEvent) {
      yield parsedEvent;
    }
  }
  const trailingEvent = lineParser.flush();
  if (trailingEvent) {
    yield trailingEvent;
  }
}

// 解析事件里的 data：`[DONE]` 单独标记，非法 JSON 不抛错（交给调用方决定是否忽略）
export function parseSseJsonData(sseEvent) {
  const dataText = typeof sseEvent?.data === 'string' ? sseEvent.data : '';
  if (dataText.trim() === SSE_DONE_MARKER) {
    return { done: true, payload: null, invalid: false };
  }
  try {
    return { done: false, payload: JSON.parse(dataText), invalid: false };
  } catch {
    return { done: false, payload: null, invalid: true };
  }
}
