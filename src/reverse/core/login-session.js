// 设备码登录的**平台无关状态机**（本文件不出现任何平台名）。
//
// 平台只提供两个动作：
//   startLogin()  → { loginUrl, pollContext, intervalMs, expiresAt? }   生成授权页地址（不发网络请求）
//   pollLogin(pollContext) → { status:'pending' } | { status:'granted', credential }
// 其余的事（会话 id、总超时、取消、幂等、只允许一次 granted）都在这里做一次，各平台不用重复实现。
//
// 状态语义（写清楚，调用方不用猜）：
//   · granted 之后**永远**返回 granted + 同一份 credential（幂等；绝不再打上游）
//   · cancelled / expired 之后永远返回该终态（再 poll 也不会复活）
//   · 超时判定用注入的 now()（测试能拨表，不用真等 5 分钟）

import { randomUUID } from 'node:crypto';

export const LOGIN_STATUS = Object.freeze({
  PENDING: 'pending',
  GRANTED: 'granted',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
});

export const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;

export function createLoginSessionManager({
  startLogin,
  pollLogin,
  timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
  now = () => Date.now(),
  sessionIdFactory = () => randomUUID(),
  logger,
} = {}) {
  if (typeof startLogin !== 'function' || typeof pollLogin !== 'function') {
    throw new TypeError('createLoginSessionManager 需要 startLogin 与 pollLogin 两个函数');
  }

  const sessions = new Map();

  function readTerminalStatus(session) {
    if (session.status === LOGIN_STATUS.GRANTED) {
      return { status: LOGIN_STATUS.GRANTED, credential: session.credential };
    }
    if (session.status === LOGIN_STATUS.CANCELLED) return { status: LOGIN_STATUS.CANCELLED };
    if (session.status === LOGIN_STATUS.EXPIRED) return { status: LOGIN_STATUS.EXPIRED };
    return null;
  }

  return {
    async start() {
      const loginStart = await startLogin();
      const sessionId = sessionIdFactory();
      const startedAtMs = now();
      const expiresAtMs = startedAtMs + (loginStart.expiresAtMs ?? timeoutMs);
      sessions.set(sessionId, {
        sessionId,
        status: LOGIN_STATUS.PENDING,
        startedAtMs,
        expiresAtMs,
        intervalMs: loginStart.intervalMs,
        loginUrl: loginStart.loginUrl,
        pollContext: loginStart.pollContext,
        credential: null,
      });
      return {
        sessionId,
        // 授权参数（challenge/nonce/machine_id/client_id）都在 URL 里：用户只需要打开它
        loginUrl: loginStart.loginUrl,
        verificationUrl: loginStart.loginUrl,
        intervalMs: loginStart.intervalMs,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },

    async poll(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return { status: LOGIN_STATUS.EXPIRED };

      const terminal = readTerminalStatus(session);
      if (terminal) return terminal;

      if (now() >= session.expiresAtMs) {
        session.status = LOGIN_STATUS.EXPIRED;
        return { status: LOGIN_STATUS.EXPIRED };
      }

      const pollResult = await pollLogin(session.pollContext);
      if (pollResult?.status === LOGIN_STATUS.GRANTED && pollResult.credential) {
        // 只认第一次 granted：之后所有 poll 都命中上面的 terminal 分支
        session.status = LOGIN_STATUS.GRANTED;
        session.credential = pollResult.credential;
        return { status: LOGIN_STATUS.GRANTED, credential: pollResult.credential };
      }
      if (now() >= session.expiresAtMs) {
        session.status = LOGIN_STATUS.EXPIRED;
        return { status: LOGIN_STATUS.EXPIRED };
      }
      return { status: LOGIN_STATUS.PENDING };
    },

    // 取消是幂等的：已终态的会话不受影响
    cancel(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return { status: LOGIN_STATUS.EXPIRED };
      if (session.status === LOGIN_STATUS.PENDING) session.status = LOGIN_STATUS.CANCELLED;
      return { status: session.status };
    },

    // 排查用：拿到某会话的授权页地址（CLI 打印用，不含 token）
    describe(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return null;
      return { sessionId: session.sessionId, status: session.status, loginUrl: session.loginUrl, expiresAtMs: session.expiresAtMs };
    },
  };
}
