// 单次成员调用的「max_tokens 夹取 + 上限类 400 重试」：从 adapter.js 抽出来是为了两件事——
//   1) adapter.js 已有文件行数门禁，塞进去会超；
//   2) 这段逻辑与"怎么找群/怎么发请求"无关，只跟"这次请求的 max_tokens 与失败文案"有关。

import { buildOpenAiRequestBody } from './support.js';
import { capMaxTokens, parseMaxTokensLimit } from '../../gateway/config/limits.js';
import { describeFailure } from '../../gateway/logger.js';

// 每个 (群, 模型) 只告警一次：撞 400 的场景会反复发生，每次都说一遍等于刷屏
export function createLimitWarningTracker() {
  const warnedKeys = new Set();
  return function warnOnceFor(key, message, logger) {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    if (logger && typeof logger.warn === 'function') logger.warn(message);
  };
}

// 组装请求体：把宿主要求的 maxTokens 按"配置 > 学习值 > 原值"夹一次再发
export async function buildCappedRequestBody({ options, modelId, imageUrls, group, model, limitsStore }) {
  const learnedLimit = await limitsStore.getLimit(group?.id, model);
  const capped = capMaxTokens({
    requested: options?.maxTokens,
    configured: group?.request?.maxTokens,
    learned: learnedLimit,
  });
  return {
    body: buildOpenAiRequestBody({ ...options, maxTokens: capped.maxTokens }, modelId, imageUrls),
    capped,
  };
}

// 上游 400 且文案里写了 max_tokens 上限 → 学到它，并用 min(本次值, 上限) 重发一次。
// 只处理"上限类 400"：其它 4xx/5xx 原样返回，行为不变。
export async function retryIfMaxTokensExceeded({
  driver,
  driverContext,
  requestBody,
  result,
  group,
  model,
  limitsStore,
  logger,
  warnOnce,
  signal,
}) {
  if (!result || result.ok !== false || result.status !== 400) return result;

  const learnedLimit = parseMaxTokensLimit(result.error?.message ?? '');
  if (learnedLimit === null) return result;

  const currentMaxTokens = typeof requestBody?.max_tokens === 'number' ? requestBody.max_tokens : null;
  // 已经不比上限大了还报这个错，说明不是"值太大"而是别的配置问题：不重试，避免死循环式重发
  if (currentMaxTokens !== null && currentMaxTokens <= learnedLimit) return result;

  const cappedMaxTokens = currentMaxTokens === null ? learnedLimit : Math.min(currentMaxTokens, learnedLimit);
  await limitsStore.learnLimit(group?.id, model, learnedLimit);
  warnOnce(
    `${group?.id ?? ''}::${model}`,
    `${group?.id ?? ''}/${model} 的 max_tokens 上限为 ${learnedLimit}（从上游 400 学到，已按 ${cappedMaxTokens} 重发）；`
    + '若上游已放宽，删除 limits.json 中该条目以重新探测',
    logger,
  );

  const retryBody = { ...requestBody, max_tokens: cappedMaxTokens };
  try {
    return await driver.streamCompletions(driverContext, retryBody, { signal });
  } catch (retryError) {
    // 重发本身抛错：把原始 400 抛回去更贴近事实（重发是补偿动作，不该盖掉根因）
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`按学习上限重发失败：${describeFailure(retryError)}`);
    }
    return result;
  }
}
