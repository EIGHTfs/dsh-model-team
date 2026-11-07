// Qoder 加密后端工厂：native（纯 Node，默认）与 wasm（官方客户端实现，可选）。
//
// 选择顺序（先显式、后默认）：
//   1) 调用方传入 kind（群配置将来可覆盖）
//   2) 环境变量 DSH_MODEL_TEAM_QODER_CRYPTO = native | wasm | auto
//   3) 默认 auto
// `auto` 的判定是**优先 native**：它零依赖、不需要二进制资产，任何环境都能跑；
// wasm 只在显式要求时使用（需要 assets 或数据根里那份 298KB 的 wasm）。
// 显式要求 wasm 但文件缺失 → 明确报「不可用」，**不静默换成 native**（换了就等于两条链路行为不同却看起来一样）。

import { buildEncryptedRequestWithNative } from './native.js';
import { buildEncryptedRequestWithWasm } from './wasm.js';

export const CRYPTO_BACKEND_ENV_VAR = 'DSH_MODEL_TEAM_QODER_CRYPTO';

export const CRYPTO_BACKEND_KINDS = Object.freeze({ NATIVE: 'native', WASM: 'wasm', AUTO: 'auto' });

export const CRYPTO_BACKEND_ERROR_CODES = Object.freeze({
  UNKNOWN_KIND: 'REVERSE_CRYPTO_UNKNOWN_KIND',
  WASM_MISSING: 'REVERSE_WASM_MISSING',
});

export function resolveBackendKind({ requested, environment = process.env } = {}) {
  const rawValue = requested ?? environment?.[CRYPTO_BACKEND_ENV_VAR];
  const normalized = typeof rawValue === 'string' ? rawValue.trim().toLowerCase() : '';
  if (normalized.length === 0 || normalized === CRYPTO_BACKEND_KINDS.AUTO) return CRYPTO_BACKEND_KINDS.NATIVE;
  if (normalized === CRYPTO_BACKEND_KINDS.NATIVE || normalized === CRYPTO_BACKEND_KINDS.WASM) return normalized;
  const error = new Error(`未知的 Qoder 加密后端：${rawValue}（可选 native | wasm | auto）`);
  error.code = CRYPTO_BACKEND_ERROR_CODES.UNKNOWN_KIND;
  throw error;
}

export function createCryptoBackend({ kind, environment = process.env, wasmPath, dataRoot } = {}) {
  const resolvedKind = resolveBackendKind({ requested: kind, environment });
  if (resolvedKind === CRYPTO_BACKEND_KINDS.WASM) {
    return { kind: CRYPTO_BACKEND_KINDS.WASM, buildEncryptedRequest: (input) => buildEncryptedRequestWithWasm({ ...input, wasmPath, environment, dataRoot }) };
  }
  return { kind: CRYPTO_BACKEND_KINDS.NATIVE, buildEncryptedRequest: (input) => buildEncryptedRequestWithNative(input) };
}

export default createCryptoBackend;
