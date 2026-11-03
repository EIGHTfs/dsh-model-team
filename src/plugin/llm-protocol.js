// OpenAI 流式事件 → dsh StreamChunk 的协议转换（docs/10 的实现依据）。
// 需求意图：dsh 只认自己的 StreamChunk（block-start / text-delta / reasoning-delta / tool-call-delta /
//          block-end / usage / finish），OpenAI 兼容上游给的是 delta 结构，中间这层翻译必须精确，
//          否则界面会出现"文本与工具调用串块""块没闭合"这类只有人工才发现的问题。
// 思路：用一个有状态 builder 管块索引——每个块（文本/思考/工具调用）第一次出现时分配递增 index 并发
//      block-start，结束（finish 或切换）时发 block-end 带完整内容；块索引严格配对，不靠调用方数。

// 块类型字符串（与 dsh 的 ContentBlockType 对齐，只用本轮需要的最小集合）
export const BLOCK_TYPE_TEXT = 'text';
export const BLOCK_TYPE_REASONING = 'reasoning';
export const BLOCK_TYPE_TOOL_CALL = 'tool-call';

// OpenAI finish_reason → dsh FinishReason.kind
export const FINISH_REASON_MAP = Object.freeze({
  stop: 'stop',
  tool_calls: 'tool-calls',
  function_call: 'tool-calls',
  length: 'max-tokens',
});

// 无 finish_reason 时的兜底
const DEFAULT_FINISH_KIND = 'stop';

// 把 OpenAI usage 换成 dsh TokenUsage（契约要求"不相交"：inputTokens 只含未缓存输入）
// 口径：inputTokens = prompt_tokens - cached_tokens；cacheReadTokens = cached_tokens；
//      outputTokens = completion_tokens；totalTokens = 三者之和
export function toTokenUsage(openAiUsage) {
  if (!openAiUsage || typeof openAiUsage !== 'object') {
    return null;
  }
  const promptTokens = typeof openAiUsage.promptTokens === 'number' ? openAiUsage.promptTokens : null;
  const completionTokens = typeof openAiUsage.completionTokens === 'number' ? openAiUsage.completionTokens : 0;
  const cachedTokens = typeof openAiUsage.cacheHit === 'number' ? openAiUsage.cacheHit : 0;
  if (promptTokens === null) {
    return null;
  }
  const inputTokens = Math.max(0, promptTokens - cachedTokens);
  return {
    inputTokens,
    outputTokens: completionTokens,
    totalTokens: inputTokens + cachedTokens + completionTokens,
    cacheReadTokens: cachedTokens,
  };
}

// 上游 HTTP 状态 → dsh 的错误码分类：让 dsh 既有重试/提示策略生效，不要在插件里自己重试
export function classifyUpstreamFailure(statusCode) {
  if (statusCode === 401 || statusCode === 403) {
    return 'AUTH';
  }
  if (statusCode === 429) {
    return 'RATE_LIMIT';
  }
  if (statusCode === 402) {
    return 'QUOTA_EXCEEDED';
  }
  return 'UPSTREAM_ERROR';
}

// 工具调用参数是流式拼接的 JSON 字符串：给 block-end 时尽量原样带上，解析失败就带原文
function toToolCallArguments(rawArgumentText) {
  if (typeof rawArgumentText !== 'string' || rawArgumentText.length === 0) {
    return {};
  }
  try {
    return JSON.parse(rawArgumentText);
  } catch {
    return rawArgumentText;
  }
}

// 有状态转换器：一次上游响应对应一个实例
export class StreamChunkBuilder {
  constructor() {
    this.nextBlockIndex = 0;
    this.textBlock = null;
    this.reasoningBlock = null;
    this.toolCallBlocks = new Map();
    this.emittedFinish = false;
  }

  // 分配新块索引
  allocateBlockIndex() {
    const blockIndex = this.nextBlockIndex;
    this.nextBlockIndex += 1;
    return blockIndex;
  }

  // 追加一段文本：首段开块，后续只发 delta
  appendText(textChunk) {
    if (typeof textChunk !== 'string' || textChunk.length === 0) {
      return [];
    }
    const chunks = [];
    if (!this.textBlock) {
      const blockIndex = this.allocateBlockIndex();
      this.textBlock = { index: blockIndex, text: '' };
      chunks.push({ type: 'block-start', index: blockIndex, blockType: BLOCK_TYPE_TEXT });
    }
    this.textBlock.text += textChunk;
    chunks.push({ type: 'text-delta', index: this.textBlock.index, text: textChunk });
    return chunks;
  }

  // 追加一段思考内容（部分平台用 reasoning_content 暴露思维链）
  appendReasoning(reasoningChunk) {
    if (typeof reasoningChunk !== 'string' || reasoningChunk.length === 0) {
      return [];
    }
    const chunks = [];
    if (!this.reasoningBlock) {
      const blockIndex = this.allocateBlockIndex();
      this.reasoningBlock = { index: blockIndex, text: '' };
      chunks.push({ type: 'block-start', index: blockIndex, blockType: BLOCK_TYPE_REASONING });
    }
    this.reasoningBlock.text += reasoningChunk;
    chunks.push({ type: 'reasoning-delta', index: this.reasoningBlock.index, text: reasoningChunk });
    return chunks;
  }

  // 追加工具调用增量：同一个 OpenAI 工具下标始终映射到同一个块索引
  appendToolCallDelta(toolCallDelta) {
    const chunks = [];
    const toolCallPosition = typeof toolCallDelta?.index === 'number' ? toolCallDelta.index : 0;
    let toolCallBlock = this.toolCallBlocks.get(toolCallPosition);

    if (!toolCallBlock) {
      const blockIndex = this.allocateBlockIndex();
      toolCallBlock = {
        index: blockIndex,
        id: toolCallDelta?.id ?? `tool-call-${toolCallPosition}`,
        name: toolCallDelta?.function?.name ?? '',
        argumentsText: '',
      };
      this.toolCallBlocks.set(toolCallPosition, toolCallBlock);
      chunks.push({
        type: 'block-start',
        index: blockIndex,
        blockType: BLOCK_TYPE_TOOL_CALL,
      });
    }

    if (typeof toolCallDelta?.id === 'string' && toolCallDelta.id.length > 0) {
      toolCallBlock.id = toolCallDelta.id;
    }
    const argumentDelta = typeof toolCallDelta?.function?.arguments === 'string' ? toolCallDelta.function.arguments : '';
    if (typeof toolCallDelta?.function?.name === 'string' && toolCallDelta.function.name.length > 0) {
      toolCallBlock.name = toolCallDelta.function.name;
    }
    toolCallBlock.argumentsText += argumentDelta;
    chunks.push({
      type: 'tool-call-delta',
      index: toolCallBlock.index,
      id: toolCallBlock.id,
      ...(toolCallBlock.name.length > 0 ? { name: toolCallBlock.name } : {}),
      argumentsDelta: argumentDelta,
    });
    return chunks;
  }

  // 把一条 OpenAI chunk 的 choices[0].delta 展开成若干 StreamChunk
  appendOpenAiChunk(openAiPayload) {
    const delta = openAiPayload?.choices?.[0]?.delta;
    if (!delta) {
      return [];
    }
    return [
      ...this.appendReasoning(delta.reasoning_content),
      ...this.appendText(delta.content),
      ...(Array.isArray(delta.tool_calls) ? delta.tool_calls.flatMap((toolCallDelta) => this.appendToolCallDelta(toolCallDelta)) : []),
    ];
  }

  // 收尾：先闭合所有已开块（顺序按分配顺序），再发 usage 与 finish
  finish({ finishReason, usage } = {}) {
    const chunks = [];
    const openedBlocks = [];
    if (this.textBlock) {
      openedBlocks.push({ index: this.textBlock.index, block: { type: BLOCK_TYPE_TEXT, text: this.textBlock.text } });
      this.textBlock = null;
    }
    if (this.reasoningBlock) {
      openedBlocks.push({ index: this.reasoningBlock.index, block: { type: BLOCK_TYPE_REASONING, text: this.reasoningBlock.text } });
      this.reasoningBlock = null;
    }
    for (const toolCallBlock of this.toolCallBlocks.values()) {
      openedBlocks.push({
        index: toolCallBlock.index,
        block: {
          type: BLOCK_TYPE_TOOL_CALL,
          id: toolCallBlock.id,
          name: toolCallBlock.name,
          arguments: toToolCallArguments(toolCallBlock.argumentsText),
        },
      });
    }
    this.toolCallBlocks.clear();

    openedBlocks.sort((leftBlock, rightBlock) => leftBlock.index - rightBlock.index);
    for (const openedBlock of openedBlocks) {
      chunks.push({ type: 'block-end', index: openedBlock.index, block: openedBlock.block });
    }

    const tokenUsage = toTokenUsage(usage);
    if (tokenUsage) {
      chunks.push({ type: 'usage', usage: tokenUsage });
    }

    if (!this.emittedFinish) {
      this.emittedFinish = true;
      chunks.push({
        type: 'finish',
        reason: { kind: FINISH_REASON_MAP[finishReason] ?? DEFAULT_FINISH_KIND },
      });
    }
    return chunks;
  }
}

// 便捷入口：把"上游事件流"整体转成 chunk 流（适配器内部按事件逐条调用 builder）
export function createStreamChunkBuilder() {
  return new StreamChunkBuilder();
}
