// 适配器的纯函数辅助：消息/工具/请求体转换、流状态采集、请求行上下文组装。
// 拆出本文件是为了让 adapter.js 只保留"工厂 + 类"，单文件与单函数都保持在约定长度内。

import { extractUsage } from '../gateway/mapping.js';
import { normalizeHarnessMessages } from './message-shape.js';

// 把 dsh 的 messages 转成 OpenAI 兼容 messages：只做保守映射，未知块显式转文本而不是静默丢
//
// tool-call 块的处理（契约 docs/02 §六「消息映射·工具」）：
//   助手消息里的 `tool-call` 块必须走 `tool_calls[]` 结构化通道，**不能**在正文里留下
//   占位文本——上游会看到「一条没有调用声明的工具结果」→ tool_call_mismatch（真机必现）。
//   这里只负责把 tool-call 从正文里剔除；声明本身由 toOpenAiToolCalls() 提取。
//
// reasoning 块的处理（真机实证的对话污染）：
//   思考块转成正文占位 `[reasoning 内容已省略]` 后会写进会话历史，回放给上游时模型把这行
//   当成自己以前说过的话学出来，再被存成 text 块——占位文本进入上下文就是污染对话；
//   且历史思考内容上游基本用不上，回传只浪费 token。所以 reasoning 一律静默丢弃。
//
// 占位文本收敛为白名单：只有 image/file 这类「模型需要知道这里有个东西」的块才值得占位；
// 其余未知块（含 reasoning）一律静默丢弃，不再产生可被学嘴的文本。
const PLACEHOLDER_BLOCK_TYPES = new Set(['file']);
const IMAGE_BLOCK_TYPE = 'image';
const IMAGE_UNSENDABLE_PREFIX = '[图片无法发送：';
// tool 消息里带图时的两句提示（OpenAI 协议不允许 role:'tool' 放图，图要跟一条 user 消息）
const TOOL_IMAGE_FOLLOWUP_HINT = '（附图见下一条消息）';
// 部分取到时的提示：必须让模型知道有几张没送到，否则它会以为图都在
const TOOL_IMAGE_PARTIAL_HINT_PREFIX = '（附图见下一条消息：';
const TOOL_IMAGE_MISSING_HINT = '（附图未取到）';
const TOOL_IMAGE_INTRO_TEXT = '以下是工具 read_image 返回的图片：';

/**
 * 图片块 → OpenAI 内容块。
 * 取到 data URL 就给 image_url；取不到/失败就给**占位文本**（模型能看出这里本来有图，
 * 而"静默丢掉"会让模型坚信用户没发图）。imageUrls 为空 Map 时也走占位，不退化成"没有图"。
 */
function imageBlockToOpenAi(contentBlock, imageUrls) {
  const attachment = contentBlock && contentBlock.attachment;
  const attachmentId = attachment && attachment.attachmentId;
  const prepared = imageUrls && attachmentId ? imageUrls.get(attachmentId) : null;
  if (prepared && typeof prepared.url === 'string' && prepared.url.length > 0) {
    return { type: 'image_url', image_url: { url: prepared.url } };
  }
  const reason = prepared && prepared.error ? prepared.error : '附件未取到';
  return { type: 'text', text: `${IMAGE_UNSENDABLE_PREFIX}${reason}]` };
}

/**
 * 消息 content → 上游 content。
 * 返回类型按内容决定：**纯文本仍是字符串**（契约冻结，改了会让上游/既有断言同时变），
 * 含图片且能发出去时返回块数组（OpenAI 多模态格式），文字与图片保持原顺序。
 * @param {object} message
 * @param {Map<string, {url?: string, error?: string}>} [imageUrls] 预取结果；缺省按"没有图"处理
 */
function toOpenAiContentBlocks(message, imageUrls) {
  const messageContent = message?.content;
  if (typeof messageContent === 'string') {
    return messageContent;
  }
  if (!Array.isArray(messageContent)) {
    return '';
  }
  const textParts = [];
  const openAiBlocks = [];
  let hasImageBlock = false;
  const flushTextParts = () => {
    if (textParts.length === 0) return;
    openAiBlocks.push({ type: 'text', text: textParts.join('\n') });
    textParts.length = 0;
  };

  for (const contentBlock of messageContent) {
    if (typeof contentBlock === 'string') {
      textParts.push(contentBlock);
      continue;
    }
    if (contentBlock?.type === 'tool-call') {
      continue; // 走 tool_calls[] 通道，正文里不出现占位文本
    }
    if (contentBlock?.type === 'tool-result') {
      // legacy 包裹式工具结果：归一化会把它抬成独立 tool 消息，正文里绝不能留占位文本
      continue;
    }
    if (contentBlock?.type === 'text' && typeof contentBlock.text === 'string') {
      textParts.push(contentBlock.text);
      continue;
    }
    if (contentBlock?.type === IMAGE_BLOCK_TYPE) {
      const attachmentId = contentBlock.attachment && contentBlock.attachment.attachmentId;
      if (typeof attachmentId !== 'string' || attachmentId.length === 0) {
        // 没有附件引用的 image 块拿不到任何字节（旧数据/设计稿里出现过这种形状）：
        // 保留原有占位文本，别把它变成"我方声称能发图却什么都发不出去"的空数组
        textParts.push('[image 内容已省略]');
        continue;
      }
      hasImageBlock = true;
      flushTextParts();                       // 图片前的文字先落块，保持原顺序
      openAiBlocks.push(imageBlockToOpenAi(contentBlock, imageUrls));
      continue;
    }
    if (PLACEHOLDER_BLOCK_TYPES.has(contentBlock?.type)) {
      textParts.push(`[${contentBlock.type} 内容已省略]`);
      continue;
    }
    // reasoning 及其余未知块：静默丢弃。任何占位文本进了上下文都会被模型当正文复制（学嘴）
  }

  // 没有图片块：保持"纯文本返回字符串"的既有契约（逐字节不变）
  if (!hasImageBlock) return textParts.join('\n');
  flushTextParts();
  return openAiBlocks;
}

/** 只要文本形态（assistant / tool / developer 走这条：这些角色不该带图） */
// 把一条消息的内容拆成「文本」与「图片块」两部分。
// tool 消息要用：协议不允许 role:'tool' 带图，图必须拆出来另发一条 user 消息。
function splitTextAndImageBlocks(message, imageUrls) {
  const blocks = toOpenAiContentBlocks(message, imageUrls);
  if (!Array.isArray(blocks)) {
    return {
      text: String(blocks == null ? '' : blocks),
      imageBlocks: [],
      imageBlockCount: 0,
      hasImageBlock: messageHasImageBlock(message),
    };
  }
  const textParts = [];
  const imageBlocks = [];
  for (const block of blocks) {
    if (block && block.type === 'image_url') imageBlocks.push(block);
    // 取不到图时 imageBlockToOpenAi 会产出占位文本；tool 文本里不能出现它（改由 HINT 说明）
    else if (block && block.type === 'text' && !String(block.text || '').startsWith(IMAGE_UNSENDABLE_PREFIX)) {
      textParts.push(block.text);
    }
  }
  // imageBlockCount 统计**消息里所有** image 块（含没取到 url 的），用来算"几张没送到"
  const imageBlockCount = Array.isArray(message?.content)
    ? message.content.filter((block) => block && block.type === IMAGE_BLOCK_TYPE).length
    : 0;
  return {
    text: textParts.join('\n').trim(),
    imageBlocks,
    imageBlockCount,
    hasImageBlock: messageHasImageBlock(message),
  };
}

// 该消息是否含 image 块（用于区分"本来没图"与"有图但没取到"）
function messageHasImageBlock(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block && block.type === IMAGE_BLOCK_TYPE);
}

function toOpenAiTextOnly(message) {
  const content = toOpenAiContentBlocks(message, undefined);
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
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
// 第一遍：收集配对信息（双向孤儿剔除的依据）。结果 id 全集 ∩ 有 name 的调用 = 保留集。
function collectKeptToolCallIds(messages) {
  const resultIds = new Set();
  for (const message of messages ?? []) {
    if (message?.role === 'tool' && message.toolCallId !== undefined && message.toolCallId !== null) {
      resultIds.add(String(message.toolCallId));
      continue;
    }
    // 防御：即便调用方绕过归一化直接塞 legacy 形状，也要认出块里的 toolCallId，
    // 否则「结果 id 全集为空 → tool_calls 被整体剔除」会重演。
    if (Array.isArray(message?.content)) {
      for (const contentBlock of message.content) {
        if (contentBlock?.type === 'tool-result' && contentBlock.toolCallId !== undefined && contentBlock.toolCallId !== null) {
          resultIds.add(String(contentBlock.toolCallId));
        }
      }
    }
  }
  const keptCallIds = new Set();
  for (const message of messages ?? []) {
    if (message?.role !== 'assistant') continue;
    for (const toolCall of toOpenAiToolCalls(message) ?? []) {
      if (resultIds.has(toolCall.id)) keptCallIds.add(toolCall.id);
    }
  }
  return keptCallIds;
}

// tool 正文：有图要提示"见下一条"，部分取到还要如实说几张可用；
// 有图块但一张都没取到则明说"未取到"；纯文本逐字保留。
function buildToolResultBody(toolParts) {
  if (toolParts.imageBlocks.length > 0) {
    const sentImageCount = toolParts.imageBlocks.length;
    const totalImageCount = Math.max(sentImageCount, toolParts.imageBlockCount);
    const followupHint = sentImageCount < totalImageCount
      ? `${TOOL_IMAGE_PARTIAL_HINT_PREFIX}${totalImageCount} 张中 ${sentImageCount} 张可用）`
      : TOOL_IMAGE_FOLLOWUP_HINT;
    return toolParts.text.length > 0 ? `${toolParts.text}\n${followupHint}` : followupHint;
  }
  if (toolParts.hasImageBlock) {
    return toolParts.text.length > 0 ? `${toolParts.text}\n${TOOL_IMAGE_MISSING_HINT}` : TOOL_IMAGE_MISSING_HINT;
  }
  return toolParts.text.length > 0 ? toolParts.text : EMPTY_TOOL_RESULT_TEXT;
}

// 收尾/换批时把本批收集到的图发成一条 user 消息（顺序即收集顺序）
function flushPendingToolImages(assembly) {
  if (assembly.pendingToolImages.length === 0) return;
  assembly.openAiMessages.push({
    role: 'user',
    content: [{ type: 'text', text: TOOL_IMAGE_INTRO_TEXT }, ...assembly.pendingToolImages],
  });
  assembly.pendingToolImages.length = 0;
}

// 一条 tool 结果：正文发文本，图片收集起来等整批发完再补一条 user（协议不允许 tool 带图）
function pushToolResultMessage(assembly, message, keptCallIds, imageUrls) {
  const callId = String(message.toolCallId ?? '');
  if (!keptCallIds.has(callId)) return;        // 孤儿工具结果：丢弃
  const toolParts = splitTextAndImageBlocks(message, imageUrls);
  const body = buildToolResultBody(toolParts);
  assembly.openAiMessages.push({
    role: 'tool',
    tool_call_id: callId,
    content: message.isError === true ? `[工具执行失败]\n${body}` : body,
  });
  if (toolParts.imageBlocks.length > 0) assembly.pendingToolImages.push(...toolParts.imageBlocks);
  assembly.pendingToolResults -= 1;
  if (assembly.pendingToolResults > 0) return;

  // 顺序硬要求：附图 user 必须在这批 tool 结果**全部发完**之后插入，
  // 否则会插进 assistant(tool_calls) 与 tool 之间 → 破坏配对 → 上游 400。
  flushPendingToolImages(assembly);
  if (assembly.deferredSystemMessages.length > 0) {
    assembly.openAiMessages.push(...assembly.deferredSystemMessages);
    assembly.deferredSystemMessages.length = 0;
  }
}

// developer / assistant / user：developer 映射 system（卡在批中间要延后）；
// assistant 只取文本并挂 tool_calls；user 走图文块。
function pushRegularMessage(assembly, message, role, imageUrls, keptCallIds) {
  if (role === 'developer') {
    const systemEntry = { role: 'system', content: toOpenAiTextOnly(message) };
    if (assembly.pendingToolResults > 0) assembly.deferredSystemMessages.push(systemEntry);
    else assembly.openAiMessages.push(systemEntry);
    return;
  }
  const toolCalls = role === 'assistant' ? toOpenAiToolCalls(message) : undefined;
  const textContent = role === 'assistant' ? toOpenAiTextOnly(message) : toOpenAiContentBlocks(message, imageUrls);
  const entry = { role, content: toolCalls && textContent.length === 0 ? null : textContent };
  if (toolCalls) {
    const pairedCalls = toolCalls.filter((toolCall) => keptCallIds.has(toolCall.id));
    if (pairedCalls.length > 0) {
      entry.tool_calls = pairedCalls;
      assembly.pendingToolResults = pairedCalls.length;
    } else {
      // 调用全部被剔（如全是空名）：没有 tool_calls 的消息 content 必须有值
      entry.content = textContent.length > 0 ? textContent : EMPTY_TOOL_RESULT_TEXT;
    }
  }
  assembly.openAiMessages.push(entry);
}

// 主入口：归一化 → 配对剪枝 → 逐条组装（三段拆开是为了每个函数只干一件事）
export function toOpenAiMessages(rawMessages, systemPrompt, imageUrls) {
  // 先归一化：legacy 的包裹式工具结果升级成一等 tool 消息，后续只有一条形状路径。
  // 新形状输入时 normalizeHarnessMessages 原样返回同一数组（零开销、行为逐字节不变）。
  const messages = normalizeHarnessMessages(rawMessages);
  const keptCallIds = collectKeptToolCallIds(messages);

  const assembly = {
    openAiMessages: [],
    pendingToolResults: 0,
    deferredSystemMessages: [],
    pendingToolImages: [],
  };
  if (typeof systemPrompt === 'string' && systemPrompt.length > 0) {
    assembly.openAiMessages.push({ role: 'system', content: systemPrompt });
  }

  for (const message of messages ?? []) {
    const role = typeof message?.role === 'string' ? message.role : 'user';
    if (role === 'tool') pushToolResultMessage(assembly, message, keptCallIds, imageUrls);
    else pushRegularMessage(assembly, message, role, imageUrls, keptCallIds);
  }

  flushPendingToolImages(assembly);
  assembly.openAiMessages.push(...assembly.deferredSystemMessages);
  return assembly.openAiMessages;
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
export function buildOpenAiRequestBody(options, targetModel, imageUrls) {
  const requestBody = {
    model: targetModel,
    messages: toOpenAiMessages(options?.messages, options?.system, imageUrls),
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

