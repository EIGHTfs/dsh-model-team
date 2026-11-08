// 账号健康度与冷却（平台无关）：失败分类、指数退避、封顶窗口。
//
// 为什么单独存一份状态：冷却/熔断是**运行时健康度**，不是凭据的一部分。
// 塞进凭据文件会让「导出/备份凭据」把别人的临时冷却一起带走，也会让凭据文件频繁写。
// 落盘位置：与账号文件同目录的 `<accountId>.state.json`（0600、原子写）。
//
// 数值全部来自参考实现（qoder_accounts.py:1319-1330）：
//   · 软限流：600s 起、每次翻倍、封顶 7200s，offset=1
//   · 硬失败熔断：连续 3 次起、1800s 起、封顶 21600s，offset=threshold
//   · 未知失败降权：连续 5 次起、600s 起、封顶 7200s，offset=threshold
//   · 统一式 base * 2^(count-offset)，最多放大 20 步

import fs from 'node:fs/promises';
import path from 'node:path';

export const ACCOUNT_HEALTH_FILE_NAME_SUFFIX = '.state.json';
export const ACCOUNT_HEALTH_FILE_MODE = 0o600;

export const SOFT_RATE_BASE_SECONDS = 600;
export const SOFT_RATE_MAX_SECONDS = 7200;
export const BREAKER_THRESHOLD = 3;
export const BREAKER_BASE_SECONDS = 1800;
export const BREAKER_MAX_SECONDS = 21600;
export const DEGRADE_THRESHOLD = 5;
export const DEGRADE_BASE_SECONDS = 600;
export const DEGRADE_MAX_SECONDS = 7200;
export const MAX_BACKOFF_STEPS = 20;

// 冷却原因 → 对外错误码（进 docs/02）
export const ACCOUNT_COOLDOWN_REASONS = Object.freeze({
  SOFT_RATE: 'soft-rate',
  BREAKER: 'breaker',
  DEGRADE: 'degrade',
});
export const ACCOUNT_COOLDOWN_ERROR_CODES = Object.freeze({
  [ACCOUNT_COOLDOWN_REASONS.SOFT_RATE]: 'REVERSE_ACCOUNT_SOFT_LIMIT',
  [ACCOUNT_COOLDOWN_REASONS.BREAKER]: 'REVERSE_ACCOUNT_BREAKER',
  [ACCOUNT_COOLDOWN_REASONS.DEGRADE]: 'REVERSE_ACCOUNT_DEGRADED',
});

// 统一退避式：base * 2^(count-offset)，封顶 cap，最多放大 20 步（与参考实现同式）
export function exponentialBackoff(count, baseSeconds, capSeconds, offset) {
  const step = Math.max(0, Math.trunc(count) - Math.trunc(offset));
  return Math.min(baseSeconds * (2 ** Math.min(step, MAX_BACKOFF_STEPS)), capSeconds);
}

export function softRateBackoffSeconds(streak) {
  return exponentialBackoff(streak, SOFT_RATE_BASE_SECONDS, SOFT_RATE_MAX_SECONDS, 1);
}

export function breakerBackoffSeconds(fails) {
  return exponentialBackoff(fails, BREAKER_BASE_SECONDS, BREAKER_MAX_SECONDS, BREAKER_THRESHOLD);
}

export function degradeBackoffSeconds(fails) {
  return exponentialBackoff(fails, DEGRADE_BASE_SECONDS, DEGRADE_MAX_SECONDS, DEGRADE_THRESHOLD);
}

export function accountHealthFilePath({ dataRoot, platformId, accountId }) {
  return path.join(dataRoot, 'reverse', platformId, `${accountId}${ACCOUNT_HEALTH_FILE_NAME_SUFFIX}`);
}

function emptyState() {
  return { softRateStreak: 0, hardFailStreak: 0, unknownFailStreak: 0, cooldownUntilMs: 0, cooldownReason: null };
}

export function createAccountHealthStore({ dataRoot, platformId, now = () => Date.now(), logger } = {}) {
  async function readState(accountId) {
    try {
      const rawText = await fs.readFile(accountHealthFilePath({ dataRoot, platformId, accountId }), 'utf8');
      const parsed = JSON.parse(rawText);
      return { ...emptyState(), ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    } catch {
      return emptyState();
    }
  }

  async function writeState(accountId, state) {
    const filePath = accountHealthFilePath({ dataRoot, platformId, accountId });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    const payload = { ...state, updatedAt: new Date(now()).toISOString() };
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: ACCOUNT_HEALTH_FILE_MODE });
      await fs.rename(temporaryPath, filePath);
      await fs.chmod(filePath, ACCOUNT_HEALTH_FILE_MODE);
    } catch (writeError) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw writeError;
    }
    return payload;
  }

  return {
    readState,
    // 冷却中就不该再发请求：返回明确错误码与解冻时刻
    async cooldownOf(accountId) {
      const state = await readState(accountId);
      if (!state.cooldownUntilMs || state.cooldownUntilMs <= now()) {
        return { blocked: false, untilMs: 0, reason: null, code: null };
      }
      return {
        blocked: true,
        untilMs: state.cooldownUntilMs,
        reason: state.cooldownReason,
        code: ACCOUNT_COOLDOWN_ERROR_CODES[state.cooldownReason] ?? 'REVERSE_ACCOUNT_COOLDOWN',
      };
    },
    async recordSuccess(accountId) {
      return writeState(accountId, emptyState());
    },
    // 429：软限流窗口（复用同一个 cooldownUntil 字段）
    async recordSoftRate(accountId) {
      const state = await readState(accountId);
      const streak = state.softRateStreak + 1;
      const next = {
        ...state,
        softRateStreak: streak,
        hardFailStreak: 0,
        cooldownUntilMs: now() + softRateBackoffSeconds(streak) * 1000,
        cooldownReason: ACCOUNT_COOLDOWN_REASONS.SOFT_RATE,
      };
      await writeState(accountId, next);
      return { streak, cooldownUntilMs: next.cooldownUntilMs };
    },
    // 硬失败（5xx/网络）：连续达阈值才熔断；未达阈值只记数
    async recordHardFailure(accountId) {
      const state = await readState(accountId);
      const streak = state.hardFailStreak + 1;
      const shouldBreaker = streak >= BREAKER_THRESHOLD;
      const next = {
        ...state,
        hardFailStreak: streak,
        softRateStreak: 0,
        ...(shouldBreaker ? {
          cooldownUntilMs: now() + breakerBackoffSeconds(streak) * 1000,
          cooldownReason: ACCOUNT_COOLDOWN_REASONS.BREAKER,
        } : {}),
      };
      await writeState(accountId, next);
      return { streak, breaker: shouldBreaker, cooldownUntilMs: next.cooldownUntilMs };
    },
    // 未知失败（4xx 其它/解析失败）：连续达阈值才降权
    async recordUnknownFailure(accountId) {
      const state = await readState(accountId);
      const streak = state.unknownFailStreak + 1;
      const shouldDegrade = streak >= DEGRADE_THRESHOLD;
      const next = {
        ...state,
        unknownFailStreak: streak,
        ...(shouldDegrade ? {
          cooldownUntilMs: now() + degradeBackoffSeconds(streak) * 1000,
          cooldownReason: ACCOUNT_COOLDOWN_REASONS.DEGRADE,
        } : {}),
      };
      await writeState(accountId, next);
      return { streak, degraded: shouldDegrade, cooldownUntilMs: next.cooldownUntilMs };
    },
  };
}
