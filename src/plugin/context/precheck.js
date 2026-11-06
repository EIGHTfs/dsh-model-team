// 请求前的上下文超限检查（从 adapter.js 搬出来，那边有文件行数门禁；行为逐行未改）。
//
// 判据：估算 = max(本次消息估算, 上次成功请求的 prompt_tokens)，只在明确超过窗口时拒绝。
// 为什么不用"上次失败就拦"：窗口未知时硬判会把正常请求拦掉，宁可漏报不误报。

import { buildOpenAiRequestBody } from '../adapter/support.js';
import { buildContextOverflowMessage, estimateMessagesTokens, evaluateContextGuard } from './guard.js';
import { resolveModelContextWindow } from './window.js';
import { readRequestRows } from '../../gateway/stats/index.js';
import { describeFailure } from '../../gateway/logger.js';

// 上次成功请求的 prompt_tokens：请求行里唯一可靠的"真实占用"参照（估算只作补充）
export async function readLastPromptTokens({ dataRoot, logger, sessionId }) {
  try {
    const rows = await readRequestRows({ dataRoot, logger });
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (sessionId && row?.sessionId && row.sessionId !== sessionId) continue;
      const promptTokens = row?.usage?.promptTokens;
      if (typeof promptTokens === 'number' && promptTokens > 0) return promptTokens;
    }
  } catch (readError) {
    logger.warn(`读取历史请求行失败，超限检查改用纯估算：${describeFailure(readError)}`);
  }
  return null;
}

// 超限就抛 CONTEXT_OVERFLOW（dsh 会把这条错误摆给用户，而不是让它变成上游 400）
export async function assertContextWithinWindow({
  config,
  target,
  options,
  sessionId,
  dataRoot,
  logger,
  fetchImpl,
  LlmErrorClass,
}) {
  const modelId = typeof target?.id === 'string' ? target.id : '';
  const groupId = typeof target?.platformId === 'string' ? target.platformId : '';
  if (modelId.length === 0 || groupId.length === 0) return;

  let windowTokens = null;
  try {
    windowTokens = await resolveModelContextWindow({ config, groupId, modelId, dataRoot, logger, fetchImpl });
  } catch (windowError) {
    logger.warn(`目标模型窗口查询失败，本次跳过超限检查：${describeFailure(windowError)}`);
    return;
  }
  if (windowTokens === null) return;   // 窗口未知：不拦

  const lastPromptTokens = await readLastPromptTokens({ dataRoot, logger, sessionId });
  const outboundMessages = buildOpenAiRequestBody(options, modelId).messages;
  const estimatedTokens = Math.max(estimateMessagesTokens(outboundMessages), lastPromptTokens ?? 0);
  const verdict = evaluateContextGuard({ estimatedTokens, windowTokens });
  if (verdict.blocked) {
    throw new LlmErrorClass(
      buildContextOverflowMessage({ estimatedTokens, lastPromptTokens, windowTokens, modelId }),
      'CONTEXT_OVERFLOW',
    );
  }
  // 接近上限时留一行日志：真超了以后能回看是不是估算偏差，而不是只有一个"上游 400"
  if (estimatedTokens > windowTokens * 0.9) {
    logger.info(`上下文接近目标窗口：估算 ${estimatedTokens} / 窗口 ${windowTokens}（${modelId}）`);
  }
}
