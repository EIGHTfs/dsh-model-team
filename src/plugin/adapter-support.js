// 适配器的纯函数辅助：消息/工具/请求体转换、流状态采集、请求行上下文组装。
// 拆出本文件是为了让 adapter.js 只保留"工厂 + 类"，单文件与单函数都保持在约定长度内。

import { extractUsage } from '../gateway/mapping.js';

// 把 dsh 的 messages 转成 OpenAI 兼容 messages：只做保守映射，未知块显式转文本而不是静默丢
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
    if (contentBlock?.type === 'text' && typeof contentBlock.text === 'string') {
      textParts.push(contentBlock.text);
      continue;
    }
    // 图片/文件等本轮不支持：转成文本占位，让模型至少知道"这里有东西"，不静默丢内容
    textParts.push(`[${contentBlock?.type ?? 'unknown'} 内容已省略]`);
  }
  return textParts.join('\n');
}

// dsh 消息 → OpenAI 消息；system 单独成首条 system 消息
export function toOpenAiMessages(messages, systemPrompt) {
  const openAiMessages = [];
  if (typeof systemPrompt === 'string' && systemPrompt.length > 0) {
    openAiMessages.push({ role: 'system', content: systemPrompt });
  }
  for (const message of messages ?? []) {
    const role = typeof message?.role === 'string' ? message.role : 'user';
    openAiMessages.push({ role, content: toOpenAiContentBlocks(message) });
  }
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

