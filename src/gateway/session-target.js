// 会话目标（SessionTarget）归一：把新旧两种写法统一成一种内部结构（docs/11 §24-33）。
// 需求意图：历史数据是 { platform, model }，新契约是 { type, id }；两者必须都能派发，
//          否则升级后所有会话都会被判成"没有目标"。
// 思路：只做纯结构转换，不查配置、不猜平台——平台缺失的解析交给 dispatcher 的分级规则（禁止猜测）。

// 目标类型
export const TARGET_TYPE_MODEL = 'model';
export const TARGET_TYPE_GROUP = 'group';

// 归一化：返回 { type:'model', id, platformId? } / { type:'group', id } / null
export function normalizeSessionTarget(rawTarget) {
  if (typeof rawTarget !== 'object' || rawTarget === null) {
    return null;
  }
  if (rawTarget.type === TARGET_TYPE_GROUP) {
    return typeof rawTarget.id === 'string' && rawTarget.id.trim().length > 0
      ? { type: TARGET_TYPE_GROUP, id: rawTarget.id.trim() }
      : null;
  }
  if (rawTarget.type === TARGET_TYPE_MODEL) {
    if (typeof rawTarget.id !== 'string' || rawTarget.id.trim().length === 0) {
      return null;
    }
    return buildModelTarget(rawTarget.id.trim(), rawTarget.platformId ?? rawTarget.platform);
  }
  // 旧结构：{ platform, model }（docs/11 §32）
  if (typeof rawTarget.model === 'string' && rawTarget.model.trim().length > 0) {
    return buildModelTarget(rawTarget.model.trim(), rawTarget.platformId ?? rawTarget.platform);
  }
  return null;
}

// 单模型目标：platformId 只在新写入时一定存在，读旧数据可能缺
function buildModelTarget(modelId, platformId) {
  const modelTarget = { type: TARGET_TYPE_MODEL, id: modelId };
  if (typeof platformId === 'string' && platformId.trim().length > 0) {
    modelTarget.platformId = platformId.trim();
  }
  return modelTarget;
}

// 反推旧结构（GET 兼容接口与旧读取方用）：分组目标没有单一模型，返回 null
export function toLegacyMapping(normalizedTarget) {
  if (normalizedTarget?.type === TARGET_TYPE_MODEL) {
    return { platform: normalizedTarget.platformId ?? null, model: normalizedTarget.id };
  }
  return { platform: null, model: null };
}

// 目标的人话描述（日志/错误提示用）
export function describeSessionTarget(normalizedTarget) {
  if (!normalizedTarget) {
    return '未设置';
  }
  return normalizedTarget.type === TARGET_TYPE_GROUP
    ? `分组 ${normalizedTarget.id}`
    : `模型 ${normalizedTarget.id}@${normalizedTarget.platformId ?? '待解析'}`;
}
