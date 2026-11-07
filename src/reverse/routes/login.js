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

// sessionId → { manager, platformId, dataRoot, logger, savedAccount }
const loginSessions = new Map();
// `${dataRoot}|${platformId}` → manager（同一进程里同平台复用一份状态机）
const managersByPlatform = new Map();

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
    startLogin: () => platformImpl.startDeviceLogin({}),
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

export async function handleReverseLoginStartRoute(context) {
  const platform = requirePlatform(String(context.body?.platform ?? '').trim());
  const manager = getLoginManager({
    platform,
    dataRoot: context.dataRoot,
    logger: context.logger,
    fetchImpl: context.fetchImpl,
  });

  const started = await manager.start();
  loginSessions.set(started.sessionId, {
    manager,
    platformId: platform.id,
    dataRoot: context.dataRoot,
    logger: context.logger,
    savedAccount: null,
  });
  context.logger?.info?.(`反代登录已发起：平台 ${platform.id}（授权页已生成，等待用户在浏览器完成）`);

  return {
    status: HTTP_OK,
    body: {
      sessionId: started.sessionId,
      loginUrl: started.loginUrl,
      expiresAtMs: new Date(started.expiresAt).getTime(),
    },
  };
}

export async function handleReverseLoginStatusRoute(context) {
  const sessionId = String(context.params.sessionId ?? '');
  const session = requireSession(sessionId);
  const pollResult = await session.manager.poll(sessionId);

  if (pollResult.status !== LOGIN_STATUS.GRANTED) {
    return { status: HTTP_OK, body: { status: pollResult.status } };
  }

  // granted 只落盘一次：之后轮询直接回同一个脱敏账号
  if (!session.savedAccount) {
    const accountStore = createAccountStore({ dataRoot: session.dataRoot, logger: session.logger });
    const saved = await accountStore.upsertByUserId(session.platformId, {
      ...pollResult.credential,
      origin: 'login',
      refreshable: true,
    });
    session.savedAccount = toPublicAccount(saved);
  }
  return { status: HTTP_OK, body: { status: LOGIN_STATUS.GRANTED, account: session.savedAccount } };
}

export async function handleReverseLoginCancelRoute(context) {
  const sessionId = String(context.params.sessionId ?? '');
  const session = requireSession(sessionId);
  const cancelResult = session.manager.cancel(sessionId);
  return { status: HTTP_OK, body: { status: cancelResult.status } };
}
