// 模型目录归一：`models.static` 同时接受字符串与 { id, name }，对外统一成 { id, name }（docs/21）。
// 需求意图：加群表单新增"显示名"后，同一份配置里会同时存在旧格式（纯 id 字符串）与新格式；
//          读取侧不能因此分裂成两套逻辑，所以统一在这里归一（写盘与出参都走同一函数）。

import { defaultLogger } from '../logger.js';
import { normalizeContextLength, normalizeMaxOutputTokens, toPositiveInteger } from './capacity.js';

// 单条归一：字符串 → { id, name: id }；对象 → { id, name: name || id }；非法返回 null
export function toModelOption(rawEntry, { logger = defaultLogger } = {}) {
  if (typeof rawEntry === 'string') {
    const trimmedId = rawEntry.trim();
    return trimmedId.length > 0 ? { id: trimmedId, name: trimmedId } : null;
  }
  if (rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry)) {
    const rawId = rawEntry.id ?? rawEntry.modelId ?? rawEntry.value;
    if (typeof rawId !== 'string' || rawId.trim().length === 0) {
      logger.warn(`模型条目缺少 id，已跳过：${JSON.stringify(rawEntry).slice(0, 120)}`);
      return null;
    }
    const trimmedId = rawId.trim();
    const rawName = rawEntry.name ?? rawEntry.label ?? rawEntry.displayName;
    const trimmedName = typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : trimmedId;
    const modelOption = { id: trimmedId, name: trimmedName };
    // 容量随条目一起走：驱动已归一化过就原样带；用户手填对象里也可能直接写 contextLength
    const contextLength = toPositiveInteger(rawEntry.contextLength) ?? normalizeContextLength(rawEntry);
    if (contextLength !== null) modelOption.contextLength = contextLength;
    const maxOutputTokens = toPositiveInteger(rawEntry.maxOutputTokens) ?? normalizeMaxOutputTokens(rawEntry);
    if (maxOutputTokens !== null) modelOption.maxOutputTokens = maxOutputTokens;
    return modelOption;
  }
  if (rawEntry !== null && rawEntry !== undefined) {
    logger.warn(`模型条目类型不支持，已跳过：${JSON.stringify(rawEntry).slice(0, 120)}`);
  }
  return null;
}

// 列表归一 + 去重（同 id 只保留第一条），重复时只 warn 一次
export function normalizeModelList(rawModels, { logger = defaultLogger } = {}) {
  if (!Array.isArray(rawModels)) {
    return [];
  }
  const normalizedModels = [];
  const seenModelIds = new Set();
  const duplicatedModelIds = [];

  for (const rawEntry of rawModels) {
    const modelOption = toModelOption(rawEntry, { logger });
    if (!modelOption) {
      continue;
    }
    if (seenModelIds.has(modelOption.id)) {
      duplicatedModelIds.push(modelOption.id);
      continue;
    }
    seenModelIds.add(modelOption.id);
    normalizedModels.push(modelOption);
  }

  if (duplicatedModelIds.length > 0) {
    logger.warn(`模型 id 重复，已保留第一条：${[...new Set(duplicatedModelIds)].join(', ')}`);
  }
  return normalizedModels;
}

// 取 id：调度/校验只需要 id 时用（兼容历史字符串条目）
export function modelIdOf(rawEntry) {
  if (typeof rawEntry === 'string') {
    return rawEntry.trim().length > 0 ? rawEntry.trim() : null;
  }
  if (rawEntry && typeof rawEntry === 'object') {
    const rawId = rawEntry.id ?? rawEntry.modelId ?? rawEntry.value;
    return typeof rawId === 'string' && rawId.trim().length > 0 ? rawId.trim() : null;
  }
  return null;
}
