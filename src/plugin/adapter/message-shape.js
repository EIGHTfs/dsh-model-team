// 消息形状探测与归一化（G3）：
//   dsh ≤0.1.6 把工具结果包在 `role:'user'` 的 content 里 —— `{type:'tool-result', toolCallId, content, isError?}`；
//   0.1.7+ 改成**一等 `role:'tool'` 消息**，`toolCallId` / `isError` 在顶层。
//
// 为什么必须归一化：本插件只认新形状。旧形状下 `resultIds` 恒为空集，
// 「结果 id 全集 ∩ 有 name 的调用」也恒空 → assistant 的 `tool_calls` 被整体剔除，
// 上游看到「说了句话 + 一段凭空出现的工具输出」，模型表现就是提前判定对话结束或陷入循环思考。
// 实测参考（dsh-providers-hub）：同一段历史新形状下保留 0 条工具调用，套回旧形状保留 512 条。
//
// 归一化方向：**把 legacy 升级成 tool-role**（而不是反过来降级）。本插件的组装、配对、
// 请求体构造全部按新形状写成一条路径，升级后仍然只有一条路径；若改成就地兼容两套形状，
// 配对与顺序约束会在两处各写一遍，必然漂移。
//
// 探测按**形状**判断，不认版本号：形状就在入参里，且对"升级期混合形态"天然鲁棒。

/** 该 content 块是否为 legacy 的包裹式工具结果 */
function isWrappedToolResult(block) {
  return typeof block === 'object' && block !== null && block.type === 'tool-result';
}

/** 该消息是否为一等工具结果消息 */
function isToolRoleMessage(message) {
  return message?.role === 'tool';
}

/**
 * 探测整段历史的形状。
 * 混合形态一律判 `tool-role`：tool 角色是新版的权威判据，判成 legacy 会让新形态的结果被漏掉。
 * @param {Array} messages
 * @returns {'legacy'|'tool-role'|'none'}
 */
export function detectMessageShape(messages) {
  let sawLegacy = false;
  for (const message of messages ?? []) {
    if (isToolRoleMessage(message)) return 'tool-role';
    const content = message?.content;
    if (Array.isArray(content) && content.some(isWrappedToolResult)) sawLegacy = true;
  }
  return sawLegacy ? 'legacy' : 'none';
}

/**
 * 把 legacy 的包裹式工具结果升级成一等 `tool` 消息。
 *
 * 规则（顺序是硬约束：上游要求 tool 消息紧跟在带 tool_calls 的 assistant 之后）：
 * - 命中 legacy 块的消息：**先**产出对应的 tool 消息（保持块在原消息里的先后顺序），
 *   再把该消息剩余的非 tool-result 内容原样保留；剩余内容为空则整条消息丢弃；
 * - 其余消息原样透传（保持引用身份）；
 * - 没有任何 legacy 块时**返回原数组引用**，让 0.1.7+ 路径零开销、逐字节不变。
 *
 * @param {Array} messages
 * @returns {Array}
 */
export function normalizeHarnessMessages(messages) {
  const sourceMessages = messages ?? [];
  const hasLegacyBlocks = sourceMessages.some((message) => Array.isArray(message?.content) && message.content.some(isWrappedToolResult));
  if (!hasLegacyBlocks) return sourceMessages;

  const normalized = [];
  for (const message of sourceMessages) {
    const content = message?.content;
    if (!Array.isArray(content) || !content.some(isWrappedToolResult)) {
      normalized.push(message);
      continue;
    }
    const remainingBlocks = [];
    for (const contentBlock of content) {
      if (!isWrappedToolResult(contentBlock)) {
        remainingBlocks.push(contentBlock);
        continue;
      }
      const toolMessage = {
        role: 'tool',
        // legacy 的 id 就在块里；缺失时保持 undefined（下游按"无 id"处理，与旧行为一致）
        toolCallId: contentBlock.toolCallId,
        content: contentBlock.content,
      };
      if (contentBlock.isError !== undefined) toolMessage.isError = contentBlock.isError;
      normalized.push(toolMessage);
    }
    if (remainingBlocks.length > 0) {
      normalized.push({ ...message, content: remainingBlocks });
    }
  }
  return normalized;
}
