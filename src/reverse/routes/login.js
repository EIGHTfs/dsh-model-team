// 反代登录路由：设备码登录的 HTTP 入口（复用 core/login-session 状态机与 core/account-store）。
//
// 设计约束：
//   · 会话状态只放进程内（不落盘）：重启后 sessionId 失效是预期行为，不做持久化；
//   · 未知平台 → 400；会话不存在 → 404；"还没授权/还没登录"是正常状态，不是 5xx；
//   · 回执只走 account-store 的脱敏出口（绝不含 token）；loginUrl 不含凭据，可以打日志。

import { getPlatform, listPlatforms } from '../registry.js';
import { createAccountStore } from '../core/account-store.js';
// 脱敏出口（唯一实现）：账号公开视图不带任何 token
import { toPublicAccount } from '../core/import-sink.js';
import { LOGIN_STATUS, createLoginSessionManager } from '../core/login-session.js';
import { ERROR_CODES, GatewayError } from '../../gateway/errors.js';

const HTTP_OK = 200;

// sessionId → { manager, platformId, dataRoot, logger, savedAccount, expiresAtMs, state, createdAtMs }
const loginSessions = new Map();
// `${dataRoot}|${platformId}` → manager（同一进程里同平台复用一份状态机）
const managersByPlatform = new Map();

// 测试用：清空进程内会话表（用例之间互不污染）
export function resetReverseLoginSessionsForTest() {
  loginSessions.clear();
  managersByPlatform.clear();
}

function requirePlatform(platformId) {
  const platform = getPlatform(platformId);
  if (!platform) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, `未知的反代平台：${platformId || '(空)'}`, {
      hint: `可用平台：${listPlatforms().map((item) => item.id).join(' / ')}`,
    });
  }
  if (!platform.capabilities?.encryptedInference) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, `平台 ${platformId} 当前不可用（能力门未开）`);
  }
  return platform;
}

function getLoginManager({ platform, dataRoot, logger, fetchImpl }) {
  const managerKey = `${dataRoot}|${platform.id}`;
  const existingManager = managersByPlatform.get(managerKey);
  if (existingManager) return existingManager;

  const platformImpl = platform.createPlatform({});
  const manager = createLoginSessionManager({
    startLogin: () => platformImpl.startDeviceLogin({ dataRoot, logger }),
    pollLogin: (pollContext) => platformImpl.pollDeviceLogin({ pollContext, fetchImpl }),
    timeoutMs: platform.login?.timeoutMs,
    logger,
  });
  managersByPlatform.set(managerKey, manager);
  return manager;
}

function requireSession(sessionId) {
  const session = loginSessions.get(sessionId);
  if (!session) {
    throw new GatewayError(ERROR_CODES.NOT_FOUND, `登录会话不存在或已结束：${sessionId}`);
  }
  return session;
}

// 该平台当前"进行中且未过期"的会话（同平台复用：用户重复点登录不该丢掉上一次授权）
function findReusableSession(platformId) {
  const nowMs = Date.now();
  for (const [sessionId, session] of loginSessions.entries()) {
    if (session.platformId !== platformId) continue;
    if (session.savedAccount) continue;
    if (session.state !== LOGIN_STATUS.PENDING) continue;
    if (session.expiresAtMs <= nowMs) {
      session.state = LOGIN_STATUS.EXPIRED;   // 过期会话先清理，不参与复用
      continue;
    }
    return { sessionId, session };
  }
  return null;
}

export async function handleReverseLoginStartRoute(context) {
  const platform = requirePlatform(String(context.body?.platform ?? '').trim());
  const manager = getLoginManager({
    platform,
    dataRoot: context.dataRoot,
    logger: context.logger,
    fetchImpl: context.fetchImpl,
  });

  // 同平台已有进行中会话：直接复用（同一个授权页、同一个 sessionId）——重复点登录不该丢弃授权
  const reusable = findReusableSession(platform.id);
  if (reusable) {
    context.logger?.info?.(`反代登录复用进行中会话：平台 ${platform.id}（不新建授权页）`);
    return {
      status: HTTP_OK,
      body: {
        sessionId: reusable.sessionId,
        loginUrl: reusable.session.loginUrl,
        expiresAtMs: reusable.session.expiresAtMs,
        reused: true,
      },
    };
  }

  const started = await manager.start();
  const expiresAtMs = new Date(started.expiresAt).getTime();
  loginSessions.set(started.sessionId, {
    manager,
    platformId: platform.id,
    dataRoot: context.dataRoot,
    logger: context.logger,
    savedAccount: null,
    loginUrl: started.loginUrl,
    expiresAtMs,
    state: LOGIN_STATUS.PENDING,
    createdAtMs: Date.now(),
  });
  context.logger?.info?.(`反代登录已发起：平台 ${platform.id}（授权页已生成，等待用户在浏览器完成）`);

  return {
    status: HTTP_OK,
    body: {
      sessionId: started.sessionId,
      loginUrl: started.loginUrl,
      expiresAtMs,
      reused: false,
    },
  };
}

// 把一次 granted 落库（同一会话只落一次；重复调用返回同一份脱敏账号）
async function claimGrantedAccount(session, sessionId, credential) {
  if (!session.savedAccount) {
    const accountStore = createAccountStore({ dataRoot: session.dataRoot, logger: session.logger });
    // 设备指纹：派生值只补缺，不覆盖老账号已有值（避免存量账号"换设备"）
    let mergedCredential = credential;
    try {
      const platformEntry = getPlatform(session.platformId);
      const platformImpl = platformEntry?.createPlatform ? platformEntry.createPlatform({}) : null;
      if (platformImpl?.mergeFingerprint && credential.userId) {
        const existing = (await accountStore.listAccounts(session.platformId))
          .find((account) => account.credential?.userId === credential.userId);
        const derived = platformImpl.deriveFingerprint(credential.userId);
        const merged = platformImpl.mergeFingerprint(existing?.credential, derived);
        mergedCredential = { ...credential, machineToken: merged.machineToken, machineType: merged.machineType };
      }
    } catch (fingerprintError) {
      session.logger?.warn?.(`设备指纹合并失败（沿用登录返回值）：${fingerprintError?.message ?? fingerprintError}`);
    }
    const saved = await accountStore.upsertByUserId(session.platformId, {
      ...mergedCredential,
      origin: 'login',
      refreshable: true,
    });
    session.savedAccount = toPublicAccount(saved);
    session.state = LOGIN_STATUS.GRANTED;
    session.logger?.info?.(`反代登录成功：平台 ${session.platformId}（会话 ${sessionId} 已领取并落库）`);
  }
  return session.savedAccount;
}

// 按平台轮询：扫描该平台所有活跃会话，任一 granted 即返回——这样任何一次授权都不会被丢弃
export async function handleReverseLoginPlatformStatusRoute(context) {
  const platformId = String(context.query?.platform ?? '').trim();
  requirePlatform(platformId);

  const platformSessions = [...loginSessions.entries()]
    .filter(([, session]) => session.platformId === platformId)
    .sort((left, right) => left[1].createdAtMs - right[1].createdAtMs);

  // 已经领取过的会话优先直接返回（幂等：不重复入库）
  for (const [, session] of platformSessions) {
    if (session.savedAccount) return { status: HTTP_OK, body: { status: LOGIN_STATUS.GRANTED, account: session.savedAccount } };
  }

  let pendingCount = 0;
  const nowMs = Date.now();
  for (const [sessionId, session] of platformSessions) {
    if (session.state !== LOGIN_STATUS.PENDING) continue;
    if (session.expiresAtMs <= nowMs) { session.state = LOGIN_STATUS.EXPIRED; continue; }

    const pollResult = await session.manager.poll(sessionId);
    if (pollResult.status === LOGIN_STATUS.GRANTED) {
      const account = await claimGrantedAccount(session, sessionId, pollResult.credential);
      return { status: HTTP_OK, body: { status: LOGIN_STATUS.GRANTED, account } };
    }
    if (pollResult.status === LOGIN_STATUS.PENDING) { pendingCount += 1; continue; }
    session.state = pollResult.status;   // expired / cancelled
  }

  if (pendingCount > 0) {
    return { status: HTTP_OK, body: { status: LOGIN_STATUS.PENDING, sessionCount: pendingCount } };
  }
  return { status: HTTP_OK, body: { status: LOGIN_STATUS.EXPIRED } };
}

export async function handleReverseLoginStatusRoute(context) {
  const sessionId = String(context.params.sessionId ?? '');
  const session = requireSession(sessionId);
  const pollResult = await session.manager.poll(sessionId);

  if (pollResult.status !== LOGIN_STATUS.GRANTED) {
    return { status: HTTP_OK, body: { status: pollResult.status } };
  }

  const account = await claimGrantedAccount(session, sessionId, pollResult.credential);
  return { status: HTTP_OK, body: { status: LOGIN_STATUS.GRANTED, account } };
}

export async function handleReverseLoginCancelRoute(context) {
  const sessionId = String(context.params.sessionId ?? '');
  const session = requireSession(sessionId);
  const cancelResult = session.manager.cancel(sessionId);
  return { status: HTTP_OK, body: { status: cancelResult.status } };
}
