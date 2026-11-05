// 转发模式解析（docs/15 §一）：纯函数，无 IO、无模块级状态。
// 需求意图：一个群这次走 forward（只换 provider/model，其余交回宿主）还是 rewrite（本插件自己转协议），
//          必须能由配置显式决定，且默认值要能安全地翻成 forward。
// 思路：显式合法值优先 → 未声明用默认（forward）→ 非法值告警并回退默认（绝不静默当 rewrite，
//      否则配置写错会悄悄走旧链路，排查时看不到任何线索）。

// 两种模式的字面量：调用方与本文件都不直接写字符串，避免拼错后才在运行期发现
export const MODE_FORWARD = 'forward';
export const MODE_REWRITE = 'rewrite';

// 默认模式：docs/15 §一 —— 未声明即 forward（rewrite 退为特定协议的后备）
export const DEFAULT_MODE = MODE_FORWARD;

export const VALID_MODES = Object.freeze([MODE_FORWARD, MODE_REWRITE]);

export function isModeValue(value) {
  return value === MODE_FORWARD || value === MODE_REWRITE;
}

// 目标 provider 是否就是本插件自己：转发给自己必然打转（docs/12 §四.1 递归守卫）
export function isSelfProvider(provider, providerIds) {
  if (typeof provider !== 'string' || provider.length === 0) return false;
  const knownProviderIds = Array.isArray(providerIds) ? providerIds : [];
  return knownProviderIds.includes(provider);
}

// 解析本次调用该用哪种模式。
// 入参：{ group, providerIds, logger }
//   group.mode      显式声明（'forward' | 'rewrite'），未声明走默认
//   group.provider  目标 host provider id：命中 providerIds 说明目标是自己 → 强制 rewrite
// 返回 'forward' | 'rewrite'；非法值只告警一次（本次解析一次）并回退默认。
export function resolveMode({ group, providerIds, logger } = {}) {
  const declaredMode = group?.mode;
  let mode = DEFAULT_MODE;
  if (isModeValue(declaredMode)) {
    mode = declaredMode;
  } else if (declaredMode !== undefined && declaredMode !== null) {
    // 配置层（config.js）已经会剔除非法值，这里是第二道防线：万一有调用方绕过配置，
    // 也不能把未知值当成 rewrite——那等于"写错就悄悄走旧链路"。
    if (logger && typeof logger.warn === 'function') {
      logger.warn(
        `群 ${group?.id ?? '(无 id)'} 的 mode 值不合法：${JSON.stringify(declaredMode)}`
        + `（只认 ${VALID_MODES.join(' / ')}），已回退默认 ${DEFAULT_MODE}`,
      );
    }
    mode = DEFAULT_MODE;
  }

  // 递归守卫：目标 provider 是自己 → 无论配置写了什么都只能 rewrite
  if (mode === MODE_FORWARD && isSelfProvider(group?.provider, providerIds)) {
    return MODE_REWRITE;
  }
  return mode;
}
