// 适配器的纯函数辅助：消息/工具/请求体转换、流状态采集、请求行上下文组装。
// 拆出本文件是为了让 adapter.js 只保留"工厂 + 类"，单文件与单函数都保持在约定长度内。

import { extractUsage } from '../gateway/mapping.js';

// 把 dsh 的 messages 转成 OpenAI 兼容 messages：只做保守映射，未知块显式转文本而不是静默丢
//
// tool-call 块的处理（契约 docs/02 §六「消息映射·工具」）：
//   助手消息里的 `tool-call` 块必须走 `tool_calls[]` 结构化通道，**不能**在正文里留下
//   占位文本——上游会看到「一条没有调用声明的工具结果」→ tool_call_mismatch（真机必现）。
//   这里只负责把 tool-call 从正文里剔除；声明本身由 toOpenAiToolCalls() 提取。
function toOpenAiContentBlocks(message) {
  const messageContent = message?.content;
  if (typeof messageContent === 'string') {
    return messageContent;
  }
  if (!Array.isArray(messageContent)) {
    return '';
  }
  const textParts = [];
  for (const contentBlock of messageContent) {
    if (typeof contentBlock === 'string') {
      textParts.push(contentBlock);
      continue;
    }
    if (contentBlock?.type === 'tool-call') {
      continue; // 走 tool_calls[] 通道，正文里不出现占位文本
    }
    if (contentBlock?.type === 'text' && typeof contentBlock.text === 'string') {
      textParts.push(contentBlock.text);
      continue;
    }
    // 图片/文件等本轮不支持：转成文本占位，让模型至少知道"这里有东西"，不静默丢内容
    textParts.push(`[${contentBlock?.type ?? 'unknown'} 内容已省略]`);
  }
  return textParts.join('\n');
}

// 提取助手消息里的工具调用声明 → OpenAI tool_calls[] 形状。
// arguments 是原始 JSON 字符串（dsh 类型定义 ToolCallBlock）；缺失/非字符串时给 '{}'，
// 上游对空参数的容忍度不稳定，'{}' 是最安全的中性值。
// name 为空的调用直接丢弃（空名调用无论配对是否完整都会被上游 400，真机实测），
// 同批其余调用不受影响——结果按 id 匹配，剔掉一个不破坏另一个的配对。
export function toOpenAiToolCalls(message) {
  if (!Array.isArray(message?.content)) {
    return undefined;
  }
  const toolCalls = message.content
    .filter((block) => block?.type === 'tool-call')
    .filter((block) => typeof block.name === 'string' && block.name.length > 0)
    .map((block) => ({
      id: String(block.id),
      type: 'function',
      function: {
        name: block.name,
        arguments: typeof block.arguments === 'string' && block.arguments.length > 0 ? block.arguments : '{}',
      },
    }));
  return toolCalls.length > 0 ? toolCalls : undefined;
}

/** 上游要求工具结果正文非空：空结果给中性占位，空串会被部分网关拒收 */
const EMPTY_TOOL_RESULT_TEXT = '(no output)';

// dsh 消息 → OpenAI 消息；system 单独成首条 system 消息
//
// 映射铁律（契约 docs/02 §六，全部为真机教训）：
//   1. `role:'tool'` 必须带 tool_call_id（取 message.toolCallId），禁止只保留 role+content；
//   2. 助手消息有 tool-call 块时带 tool_calls[]，正文只留非工具文本，纯工具调用时 content
//      给 null；纯文本消息的 content 必须保持**字符串**形态——包装成块数组会被上游
//      model_param_invalid 拒收整个请求（真机实测）；
//   3. `developer` 必须映射为 system（OpenAI 兼容接口只认 system/user/assistant/tool）；
//   4. 孤儿双向剔除：工具结果找不到对应调用声明 → 丢弃结果；调用 name 为空 → 丢弃该调用
//      （其结果同样变孤儿，一并丢弃）。两个方向的孤儿都会让上游 400；
//   5. 顺序约束：role:'tool' 必须紧跟带 tool_calls 的 assistant——中间插入任何消息都会被
//      上游 400，所以 developer 映射出的 system 卡在中间时要延后到这批 tool 结果之后。
export function toOpenAiMessages(messages, systemPrompt) {
  const openAiMessages = [];
  if (typeof systemPrompt === 'string' && systemPrompt.length > 0) {
    openAiMessages.push({ role: 'system', content: systemPrompt });
  }

  // 第一遍：收集配对信息（双向孤儿剔除的依据）。结果 id 全集 ∩ 有 name 的调用 = 保留集。
  const resultIds = new Set();
  for (const message of messages ?? []) {
    if (message?.role === 'tool' && message.toolCallId !== undefined && message.toolCallId !== null) {
      resultIds.add(String(message.toolCallId));
    }
  }
  const keptCallIds = new Set();
  for (const message of messages ?? []) {
    if (message?.role !== 'assistant') continue;
    for (const toolCall of toOpenAiToolCalls(message) ?? []) {
      if (resultIds.has(toolCall.id)) keptCallIds.add(toolCall.id);
    }
  }

  // 第二遍：组装。pendingToolResults 记当前 assistant 批还差几条结果；
  // deferredSystemMessages 缓冲卡在 assistant 与 tool 之间的 system 消息，等结果发完补发。
  let pendingToolResults = 0;
  const deferredSystemMessages = [];
  for (const message of messages ?? []) {
    const role = typeof message?.role === 'string' ? message.role : 'user';
    if (role === 'developer') {
      const systemEntry = { role: 'system', content: toOpenAiContentBlocks(message) };
      if (pendingToolResults > 0) {
        deferredSystemMessages.push(systemEntry); // tool 必须紧跟 assistant，延后
      } else {
        openAiMessages.push(systemEntry);
      }
      continue;
    }
    if (role === 'tool') {
      const callId = String(message.toolCallId ?? '');
      if (!keptCallIds.has(callId)) {
        continue; // 孤儿工具结果（无配对调用，或其调用因空名被剔）：丢弃
      }
      const toolText = toOpenAiContentBlocks(message);
      const isError = message.isError === true;
      const body = toolText.length > 0 ? toolText : EMPTY_TOOL_RESULT_TEXT;
      openAiMessages.push({
        role: 'tool',
        tool_call_id: callId,
        content: isError ? `[工具执行失败]\n${body}` : body,
      });
      pendingToolResults -= 1;
      if (pendingToolResults <= 0 && deferredSystemMessages.length > 0) {
        openAiMessages.push(...deferredSystemMessages); // 该批结果发完，补发缓冲的 system
        deferredSystemMessages.length = 0;
      }
      continue;
    }
    const toolCalls = role === 'assistant' ? toOpenAiToolCalls(message) : undefined;
    const textContent = toOpenAiContentBlocks(message);
    const assistantEntry = { role, content: toolCalls && textContent.length === 0 ? null : textContent };
    if (toolCalls) {
      const pairedCalls = toolCalls.filter((toolCall) => keptCallIds.has(toolCall.id));
      if (pairedCalls.length > 0) {
        assistantEntry.tool_calls = pairedCalls;
        pendingToolResults = pairedCalls.length;
      } else {
        // 调用全部被剔（如全是空名）：没有 tool_calls 的消息 content 必须有值
        assistantEntry.content = textContent.length > 0 ? textContent : EMPTY_TOOL_RESULT_TEXT;
      }
    }
    openAiMessages.push(assistantEntry);
  }
  openAiMessages.push(...deferredSystemMessages);
  return openAiMessages;
}

// dsh 工具声明 → OpenAI function 工具
export function toOpenAiTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }
  return tools
    .filter((tool) => typeof tool?.name === 'string' && tool.name.length > 0)
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        parameters: tool.parameters ?? tool.inputSchema ?? { type: 'object', properties: {} },
      },
    }));
}

// 组装上游请求体：模型已按会话映射改写
export function buildOpenAiRequestBody(options, targetModel) {
  const requestBody = {
    model: targetModel,
    messages: toOpenAiMessages(options?.messages, options?.system),
    stream: true,
  };
  if (typeof options?.temperature === 'number') {
    requestBody.temperature = options.temperature;
  }
  if (typeof options?.maxTokens === 'number') {
    requestBody.max_tokens = options.maxTokens;
  }
  if (Array.isArray(options?.stop) && options.stop.length > 0) {
    requestBody.stop = options.stop;
  }
  const openAiTools = toOpenAiTools(options?.tools);
  if (openAiTools) {
    requestBody.tools = openAiTools;
  }
  return requestBody;
}

// 会话 id 归一：dsh 盖的 sessionId 可能是 Branded 类型，统转成字符串或 null
export function normalizeSessionId(sessionId) {
  return sessionId === undefined || sessionId === null ? null : String(sessionId);
}

// 本次尝试落在哪个群（用于取 usagePath 与请求行里的 account）
export function findAttemptGroup(config, attempt) {
  if (!attempt) {
    return null;
  }
  return (config?.groups ?? []).find((group) => group.id === attempt.platformId) ?? null;
}

// 流式请求的运行态：所有"逐事件累积"的字段集中在这里，避免散落成一堆 let
export function createStreamState(streamResult) {
  return {
    upstreamStatus: typeof streamResult?.status === 'number' ? streamResult.status : 0,
    lastUsage: null,
    lastResponseId: null,
    finishReason: null,
    abortedByCaller: false,
    // 上游是否已给出完成信号（finish_reason 或 [DONE]）：完成之后 signal 再被 abort 不算中断
    upstreamFinished: false,
  };
}

// 从一个上游事件里采集状态（usage / 响应 id / 完成原因）
export function collectStreamState(streamState, payload, usagePath) {
  if (typeof payload.id === 'string' && payload.id.length > 0) {
    streamState.lastResponseId = payload.id;
  }
  const chunkUsage = extractUsage(payload, usagePath);
  if (chunkUsage) {
    streamState.lastUsage = chunkUsage;
  }
  const choice = payload.choices?.[0];
  if (choice?.finish_reason) {
    streamState.finishReason = choice.finish_reason;
    streamState.upstreamFinished = true;
  }
}

// 请求行上下文：一次派发里重复用到的字段集中组装
export function buildRowContext({ sessionId, config, attempt, startedAtMs, targetSource = null }) {
  return {
    sessionId,
    targetGroup: findAttemptGroup(config, attempt),
    targetModel: attempt?.modelId ?? null,
    groupId: attempt?.groupId ?? null,
    targetSource,
    startedAtMs,
  };
}

