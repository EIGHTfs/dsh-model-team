// Qoder 设备指纹派生（纯函数）：同一账号反复登录必须得到同一套指纹。
//
// 为什么必须派生而不是随机：machineToken/machineType 是上游眼里"这台设备是谁"，
// 每次登录换一套值 = 每次换一台新设备 —— 轻则天天要重新登录，重则被风控当异常设备。
// 参考实现（qoder_fingerprint.py:43-86）就是用 uid + salt 稳定派生的，这里同口径。
//
// 注意：这里只做"同一 uid 恒等"，不追求与官方客户端逐字节相同（那需要硬件 UUID，
// 拿不到也不该伪造）。

import { createHash } from 'node:crypto';

const MACHINE_TYPE_SALT = 'machinetype';
const MACHINE_TOKEN_SALT = 'machinetoken';
const MACHINE_ID_SALT = 'machine';
// machine_type 的形态：18 位去横线 hex（与参考实现同形）
const MACHINE_TYPE_LENGTH = 18;
// machine_token 的形态：base64url 43 字符（与参考实现同形）
const MACHINE_TOKEN_LENGTH = 43;

function md5Hex(text) {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

// uid + salt → UUID 形状（第 13 位版本位 4、第 17 位变体位 a）
export function deriveDeviceId(userId, salt = MACHINE_ID_SALT) {
  const digest = md5Hex(`${salt}:${userId || 'anonymous'}`);
  const shaped = `${digest.slice(0, 12)}4${digest.slice(13, 16)}a${digest.slice(17)}`;
  return `${shaped.slice(0, 8)}-${shaped.slice(8, 12)}-${shaped.slice(12, 16)}-${shaped.slice(16, 20)}-${shaped.slice(20, 32)}`;
}

export function deriveMachineType(userId) {
  return md5Hex(`${MACHINE_TYPE_SALT}:${userId || 'anonymous'}`).replace(/-/g, '').slice(0, MACHINE_TYPE_LENGTH);
}

export function deriveMachineToken(userId) {
  const raw = createHash('sha512').update(`${MACHINE_TOKEN_SALT}:${userId || 'anonymous'}`, 'utf8').digest('base64url');
  return raw.slice(0, MACHINE_TOKEN_LENGTH);
}

/**
 * 登录成功时的指纹合并规则：**已有值优先**，缺了才补派生值。
 * 为什么不是"派生值优先"：老账号的指纹已经在上游那里建立过设备身份，
 * 换一套值等于换设备；只在缺字段（新账号/旧文件不完整）时补。
 */
export function mergeFingerprint(existingCredential, derivedFingerprint) {
  const existing = existingCredential ?? {};
  return {
    machineToken: typeof existing.machineToken === 'string' && existing.machineToken.length > 0
      ? existing.machineToken
      : derivedFingerprint.machineToken,
    machineType: typeof existing.machineType === 'string' && existing.machineType.length > 0
      ? existing.machineType
      : derivedFingerprint.machineType,
  };
}

export function deriveFingerprint(userId) {
  return { machineToken: deriveMachineToken(userId), machineType: deriveMachineType(userId) };
}
