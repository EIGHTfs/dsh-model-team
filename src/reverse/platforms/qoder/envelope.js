// Qoder SSE 信封剥离（纯函数，M1 不联网）。
//
// 事实（docs/16 §二.7）：上游每帧长这样 ——
//   data: {"headers":{...},"statusCode":200,"body":"{\"choices\":[...]}"}
// 内层 `body` 是**标准 OpenAI chunk 的 JSON 字符串**，没有加密；只需要剥掉信封，不要重新序列化。
//
// 返回值三种，必须能区分"结束"与"坏帧"：
//   · 内层 JSON 字符串 —— 正常帧
//   · ENVELOPE_DONE 哨兵 —— 收到 [DONE]（外层或内层任一位置）
//   · null —— 空行 / 非法 JSON / 缺 body / body 不是字符串（调用方直接跳过这一帧，不抛）

// 结束哨兵：用冻结对象而不是 null，避免和"坏帧"混为一谈（坏帧要能被统计，结束不能）
export const ENVELOPE_DONE = Object.freeze({ done: true });

// 上游把结束标记放在内层 body 里的情形也认
const DONE_MARKER = '[DONE]';

function parseJsonOrNull(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

// 输入：一条 SSE 的 data 行原文（可带 `data:` 前缀，也接受已经去掉前缀的裸 JSON）
export function unwrapEnvelope(dataLine) {
  const rawText = String(dataLine ?? '').trim();
  if (rawText.length === 0) return null;

  const payloadText = rawText.startsWith('data:') ? rawText.slice('data:'.length).trim() : rawText;
  if (payloadText.length === 0) return null;
  if (payloadText === DONE_MARKER) return ENVELOPE_DONE;

  const outer = parseJsonOrNull(payloadText);
  if (!outer.ok) return null;
  if (typeof outer.value !== 'object' || outer.value === null) return null;

  const innerBody = outer.value.body;
  if (typeof innerBody !== 'string') return null;

  const trimmedBody = innerBody.trim();
  if (trimmedBody === DONE_MARKER) return ENVELOPE_DONE;
  // 内层必须是可解析的 JSON：否则调用方拿到的是"看起来像 JSON 的垃圾"，错误会漂到更远的地方
  if (!parseJsonOrNull(innerBody).ok) return null;
  return innerBody;
}
