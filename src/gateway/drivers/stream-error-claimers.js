// 上游错误认领（通用层）：只提供「登记认领者」与「逐帧询问」两个动作。
//
// 为什么要有这一层：有些上游用 HTTP 200 + 一帧错误体回话（而不是 4xx/5xx），
// 网关若只看 HTTP 状态就会把「额度不足」记成「成功空回复」。差异属于各平台/驱动，
// 所以这里**只收函数**：不认识路径、不认识错误码表、不出现任何平台名。
//
// 认领契约（统一形状，见 docs/02 §九）：
//   claim(payload, context) → null | { code, message, reason, status? }
//     · null      = 我不认这帧，继续问下一位
//     · code      = 稳定枚举（如 UPSTREAM_QUOTA_EXHAUSTED）
//     · message   = 给用户看的人话
//     · reason    = 机器可查的原始依据（进请求行 claimedReason）
//     · status    = 建议映射的 HTTP 式状态，缺省 502

const DEFAULT_CLAIM_STATUS = 502;

// id → { id, claim }；Map 保持登记顺序（"首个命中生效"依赖它）
const claimersById = new Map();

export const CLAIM_ERROR_CODE = 'UPSTREAM_CLAIMED_ERROR';

/**
 * 登记一个认领者。id 必须唯一（重复登记说明两个模块抢同一件事，直接报错比静默覆盖安全）。
 * @returns {() => void} 注销函数（幂等：重复调用无副作用）
 */
export function registerStreamErrorClaimer({ id, claim } = {}) {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new TypeError('认领者 id 必须是非空字符串');
  }
  if (typeof claim !== 'function') {
    throw new TypeError(`认领者 ${id} 的 claim 必须是函数`);
  }
  const normalizedId = id.trim();
  if (claimersById.has(normalizedId)) {
    throw new Error(`认领者 id 重复：${normalizedId}`);
  }
  claimersById.set(normalizedId, { id: normalizedId, claim });
  return function unregisterStreamErrorClaimer() {
    claimersById.delete(normalizedId);
  };
}

/**
 * 逐帧询问：按登记顺序问，首个返回非 null 的认领生效。
 * @param {object} payload 已解析的上游帧
 * @param {{driverId?: string, model?: string}} context 只作判据输入，不含任何平台分支
 * @returns {null | {code: string, message: string, reason: string, status: number, claimerId: string}}
 */
export function claimStreamError(payload, context = {}) {
  for (const claimer of claimersById.values()) {
    let claimResult = null;
    try {
      claimResult = claimer.claim(payload, context);
    } catch {
      // 单个认领者抛错不能影响其它认领者与主流程：当作"不认"
      continue;
    }
    if (!claimResult) continue;
    if (typeof claimResult.code !== 'string' || claimResult.code.length === 0) continue;
    return {
      code: claimResult.code,
      message: typeof claimResult.message === 'string' && claimResult.message.length > 0
        ? claimResult.message
        : `上游返回错误（${claimResult.code}）`,
      reason: typeof claimResult.reason === 'string' ? claimResult.reason : claimer.id,
      status: Number.isInteger(claimResult.status) ? claimResult.status : DEFAULT_CLAIM_STATUS,
      claimerId: claimer.id,
    };
  }
  return null;
}

// 测试隔离：清空登记表
export function resetStreamErrorClaimersForTest() {
  claimersById.clear();
}

// 只读快照：排查"到底登记了谁"用（不含函数，避免被顺手调用）
export function listRegisteredStreamErrorClaimers() {
  return [...claimersById.keys()];
}
