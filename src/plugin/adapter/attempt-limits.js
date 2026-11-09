// 单次成员调用的「max_tokens 夹取 + 上限类 400 重试」：从 adapter.js 抽出来是为了两件事——
//   1) adapter.js 已有文件行数门禁，塞进去会超；
//   2) 这段逻辑与"怎么找群/怎么发请求"无关，只跟"这次请求的 max_tokens 与失败文案"有关。

import { buildOpenAiRequestBody } from './support.js';
import { capMaxTokens, parseMaxTokensLimit } from '../../gateway/config/limits.js';
import { describeFailure } from '../../gateway/logger.js';

// 重发值的下限：低于它就没有可用输出（上游多半会报别的错），宁可把原 400 交回去
const MIN_RETRYABLE_MAX_TOKENS = 256;

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
  const effectiveLimit = typeof limitsStore.getEffectiveLimit === 'function'
    ? await limitsStore.getEffectiveLimit(group?.id, model)
    : null;
  const capped = capMaxTokens({
    requested: options?.maxTokens,
    configured: group?.request?.maxTokens,
    effective: effectiveLimit,
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

  // 语义（B11d，依据真机日志 requested=learned=65536 → 上游仍 400）：
  // 上游对 max_tokens 是**按值直接判**且边界排他——"不能超过 65536" 实际等价于"必须小于 65536"。
  // 所以：`当前值 >= 声明上限` 时，可用值是 `上限 − 1`，按它重发一次；`当前值 < 上限` 说明不是"值太大"，
  // 原样返回（这条同时是防死循环的第一道闸：不会对同一个"已经更小"的值反复重发）。
  const retryValue = learnedLimit - 1;
  const belowLimit = currentMaxTokens !== null && currentMaxTokens < learnedLimit;
  // 下限保护：再小就没有可用输出，宁可把 400 交回去也不发一个没意义的值
  const aboveFloor = retryValue >= MIN_RETRYABLE_MAX_TOKENS;
  // 必须真的降值：重发值不能 >= 本次请求值，否则同一个 body 必然再 400
  const strictlyReduces = currentMaxTokens === null || retryValue < currentMaxTokens;
  const shouldRetry = !belowLimit && aboveFloor && strictlyReduces;

  // 取证日志：解析成功之后、任何分支之前都留痕（含不重试的档，便于统计命中分布）。
  // 注意生产 logger 的 info 只吃字符串（src/gateway/logger.js:39），JSON 必须拼进 message 才能被 grep。
  try {
    if (logger && typeof logger.info === 'function') {
      const traceFields = {
        group: group?.id ?? null,
        model,
        requested: currentMaxTokens,
        learned: learnedLimit,
        effective: shouldRetry ? retryValue : null,
        retriedTo: shouldRetry ? retryValue : null,
        decision: shouldRetry ? 'retry' : 'no-retry',
        retried: shouldRetry,
        status: result?.status ?? null,
      };
      logger.info(`max_tokens 上限命中 ${JSON.stringify(traceFields)}`, traceFields);
    }
  } catch { /* 日志失败绝不影响请求处理 */ }

  if (!shouldRetry) return result;

  // 先只把「声明上限」记在内存里，等重发**成功**再记录可用值（effective）：
  // 声明上限是上游返回的原始数值（作为证据保留），effective 是"验过的可用值"——
  // 没验成功就不能当可用值记进去，否则一次失败的降值会变成长期策略。
  const retryBody = { ...requestBody, max_tokens: retryValue };
  let retryResult;
  try {
    retryResult = await driver.streamCompletions(driverContext, retryBody, { signal });
  } catch (retryError) {
    // 重发本身抛错：把原始 400 抛回去更贴近事实（重发是补偿动作，不该盖掉根因）
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`按可用值（${retryValue}）重发失败：${describeFailure(retryError)}`);
    }
    await limitsStore.learnLimit(group?.id, model, learnedLimit, { effective: null });
    return result;
  }

  const retriedOk = Boolean(retryResult && retryResult.ok);
  await limitsStore.learnLimit(group?.id, model, learnedLimit, {
    effective: retriedOk ? retryValue : null,
  });
  warnOnce(
    `${group?.id ?? ''}::${model}`,
    `${group?.id ?? ''}/${model} 的 max_tokens 上限为 ${learnedLimit}（上游对等于上限的值也拒），`
    + (retriedOk
      ? `已按 ${retryValue} 重发成功并记下可用值；若上游已放宽，删除 limits.json 中该条目以重新探测`
      : `按 ${retryValue} 重发仍未成功，已只记下声明上限；若上游已放宽，删除 limits.json 中该条目以重新探测`),
    logger,
  );
  return retryResult;
}
