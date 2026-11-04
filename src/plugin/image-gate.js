// image-gate.js —— 图片输入的三态门禁（未加载 ≠ 不支持）。
//
// 为什么三态必须分开（照官方适配器与 dsh-providers-hub 的实测记录）：
//   ① 能力列表还没加载完（undefined）→ 这是"暂时判不了"，用可重试之外的语义会让用户莫名重试；
//      官方选 INVALID_REQUEST，因为它在 harness 的**不可重试**集合里（用 TRANSPORT 会被自动重试，
//      用户会在 15 秒里看到 500/1000/2000/4000/8000ms 六次闪烁）。
//   ② 明确不支持图片 → UNSUPPORTED_CONTENT（重试也没用）。
//   ③ 声明了支持图片、但拿不到附件服务 → 也按 UNSUPPORTED_CONTENT：宁可明确报错，
//      也不能"声明支持却悄悄把图丢掉"——那样用户只会以为图坏了。
//
// 本模块只做判定，不碰 IO；错误类由调用方注入（项目零依赖，不 import 宿主包）。

export const IMAGE_UNSUPPORTED_MESSAGE = '不支持图片输入';
export const IMAGE_ATTACHMENTS_REQUIRED_MESSAGE = '图片输入需要附件服务';

/**
 * @param {object} input
 * @param {string} input.modelId             模型 id（进错误文案）
 * @param {string[]|undefined} input.declaredModalities 已声明的能力；undefined = 还没加载完
 * @param {boolean} input.attachmentsAvailable 附件服务是否可用
 * @param {boolean} input.hasImage           本次请求是否真的带图
 * @param {Function} input.LlmErrorClass     注入的错误类
 * @returns {void} 不满足条件时抛错；满足则原样返回
 */
export function assertImageInputAllowed({ modelId, declaredModalities, attachmentsAvailable, hasImage, LlmErrorClass }) {
  if (!hasImage) return;
  const modelLabel = modelId || '(未知模型)';

  if (declaredModalities === undefined) {
    throw new LlmErrorClass(
      `模型 ${modelLabel} 的能力列表尚未加载完成，暂时无法判断是否支持图片；请稍后重试`,
      'INVALID_REQUEST',
    );
  }
  if (!Array.isArray(declaredModalities) || declaredModalities.indexOf('image') < 0) {
    throw new LlmErrorClass(`模型 ${modelLabel} ${IMAGE_UNSUPPORTED_MESSAGE}`, 'UNSUPPORTED_CONTENT');
  }
  if (!attachmentsAvailable) {
    throw new LlmErrorClass(IMAGE_ATTACHMENTS_REQUIRED_MESSAGE, 'UNSUPPORTED_CONTENT');
  }
}
