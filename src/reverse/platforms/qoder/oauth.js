// Qoder 设备码登录（PKCE + 轮询）：只做协议，不含调度与存储。
//
// 协议依据（参考实现 `qoder-oauth.js` / `qoder.js`，逻辑照抄、架构不照抄）：
//   · 授权页 = `${authBase}/device/selectAccounts?challenge&challenge_method=S256&nonce&machine_id&client_id`
//     —— 授权参数**全在 URL 里**，用户打开链接、在页面上点授权即可，不需要手输任何码；
//   · 轮询   = GET `${openApiBase}/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256`
//     —— **404 表示"用户还没完成授权"，继续轮询**（不是错误）；2xx 但没 token 也继续；
//   · 身份   = 登录成功后再打一次 `/api/v1/userinfo`，判重键是它的 `user_id`；
//   · 续期载荷只需要 `{refresh_token, machine_id}`（M4 用，这里只保证字段齐全）。
//
// ⚠️ 将来接 UI 必须**两步走**：先调 `startDeviceLogin()` 拿 loginUrl 立刻返回给前端，
// 由前端在用户点击后的短暂窗口（transient activation ≈5 秒）内 `window.open`；
// **不能**把「生成 URL → 打开 → 等待授权」做成一次阻塞调用——参考实现踩过这个坑（弹窗被拦），
// 而且兜底用 `window.location.href` 会把整个设置页导航走。CLI 里没有该限制，可以阻塞等。

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { resolveMachineId } from './machine-id.js';

// PKCE 字符集：RFC 7636 的 unreserved（66 个字符），与参考实现一致
const PKCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
const PKCE_MIN_LENGTH = 43;
const PKCE_LENGTH_RANGE = 86;

export const LOGIN_ERROR_CODES = Object.freeze({
  POLL_FAILED: 'REVERSE_LOGIN_POLL_FAILED',
  USERINFO_FAILED: 'REVERSE_LOGIN_USERINFO_FAILED',
});

function loginError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// PKCE：verifier 43..128 位；challenge = base64url(sha256(verifier))，去掉 padding
export function createPkce() {
  const length = PKCE_MIN_LENGTH + Math.floor(PKCE_LENGTH_RANGE * Math.random());
  const randomPool = randomBytes(length);
  let verifier = '';
  for (let index = 0; index < length; index += 1) {
    verifier += PKCE_ALPHABET[randomPool[index] % PKCE_ALPHABET.length];
  }
  const challenge = createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return { verifier, challenge };
}

export const NONCE_STYLES = Object.freeze({ DASHED: 'dashed', HEX32: 'hex32' });

// nonce 形态按 profile 走：CN 两家参考都用带横线 uuid；intl 用 32 位无横线 hex
export function createNonce(nonceStyle = NONCE_STYLES.DASHED) {
  const uuid = randomUUID();
  return nonceStyle === NONCE_STYLES.HEX32 ? uuid.replace(/-/g, '') : uuid;
}

export function createDeviceSession({ machineId, nonceStyle = NONCE_STYLES.DASHED } = {}) {
  return {
    pkce: createPkce(),
    nonce: createNonce(nonceStyle),
    // machineId 现在由调用方（startDeviceLogin）解析成"本机稳定 id"；这里仍允许注入以便测试
    machineId: machineId ?? randomUUID(),
  };
}

// 授权页地址：五个基础参数 + **profile 决定的** redirect_uri（CN Python 参考要带，providers-hub/intl 不带）
// 授权站也由 profile 决定（`profile.authBase`）：两套 CN 配置的「授权站 + client_id + redirect_uri」成套，
// 混搭会出现「页面登录成功、轮询永远拿不到 token」。
export function buildAuthUrl({ session, endpoints, profile } = {}) {
  const loginProfile = profile ?? {};
  const clientId = loginProfile.clientId;
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new TypeError('buildAuthUrl 需要 profile.clientId');
  }
  const query = new URLSearchParams({
    challenge: session.pkce.challenge,
    challenge_method: 'S256',
    nonce: session.nonce,
    machine_id: session.machineId,
    client_id: clientId,
  });
  if (typeof loginProfile.redirectUri === 'string' && loginProfile.redirectUri.length > 0) {
    query.set('redirect_uri', loginProfile.redirectUri);
  }
  const authBase = typeof loginProfile.authBase === 'string' && loginProfile.authBase.length > 0
    ? loginProfile.authBase
    : endpoints.authBase;
  return `${authBase}${endpoints.deviceSelectPath}?${query.toString()}`;
}

// 轮询地址：挂 openApiBase（不是 authBase）；404 是"还没授权"
export function buildPollUrl({ session, endpoints }) {
  const query = new URLSearchParams({
    nonce: session.nonce,
    verifier: session.pkce.verifier,
    challenge_method: 'S256',
  });
  return `${endpoints.openApiBase}${endpoints.deviceTokenPoll}?${query.toString()}`;
}

function readFirstString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

// 设备码响应的字段名沿用参考实现的兼容列表（token / device_token / access_token）
export function parseTokenPayload(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const accessToken = readFirstString(payload, ['token', 'device_token', 'access_token']);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: readFirstString(payload, ['refresh_token', 'refreshToken']),
    userId: readFirstString(payload, ['user_id', 'userId']),
    nickname: readFirstString(payload, ['user_name', 'userName', 'nickname']),
    // expires_at 读不到就留空（铁律 9：未知不编造）
    expiresAt: readFirstString(payload, ['expires_at', 'expiresAt']),
  };
}

// 登录成功后补一次 userinfo：判重键 user_id 与显示名都优先取它
// UA 必须与登录 profile 一致：两家参考实现都在 userinfo / 续期上带自家 UA，
// 缺 UA 时服务端行为未验证（先对齐再谈是否必需）。
async function fetchUserInfo({ accessToken, endpoints, fetchImpl, userAgent }) {
  const headers = { accept: 'application/json', authorization: `Bearer ${accessToken}` };
  if (typeof userAgent === 'string' && userAgent.length > 0) headers['user-agent'] = userAgent;
  const response = await fetchImpl(`${endpoints.openApiBase}${endpoints.userInfo}`, {
    method: 'GET',
    headers,
  });
  if (!response.ok) {
    throw loginError(LOGIN_ERROR_CODES.USERINFO_FAILED, `userinfo 返回 HTTP ${response.status}`);
  }
  const body = await response.json();
  if (typeof body !== 'object' || body === null) return { userId: null, nickname: null };
  return {
    userId: readFirstString(body, ['user_id', 'userId', 'id']),
    nickname: readFirstString(body, ['name', 'nickname', 'user_name', 'userName']),
  };
}

// 生成一次登录：只拼 URL，不发网络请求（CLI 立刻能打开浏览器）。
// machineId 不传时按"本机稳定标识"解析（见 machine-id.js）——绝不每次随机。
export async function startDeviceLogin({ endpoints, login, profile, machineId, machineToken, timeoutMs, dataRoot, logger } = {}) {
  const loginProfile = profile ?? login;
  const resolvedMachine = machineId
    ? { machineId, source: 'explicit' }
    : await resolveMachineId({ dataRoot });
  const session = createDeviceSession({
    machineId: resolvedMachine.machineId,
    nonceStyle: loginProfile.nonceStyle,
  });
  const loginUrl = buildAuthUrl({ session, endpoints, profile: loginProfile });
  const authBase = typeof loginProfile.authBase === 'string' && loginProfile.authBase.length > 0
    ? loginProfile.authBase
    : endpoints.authBase;
  logger?.info?.(`登录 profile=${loginProfile.id ?? '(未命名)'}（授权站 ${new URL(authBase).host}，client_id 尾 8 位 ${String(loginProfile.clientId).slice(-8)}，redirect_uri ${loginProfile.redirectUri ?? '(不带)'}，machine_id 来源 ${resolvedMachine.source}）`);
  return {
    loginUrl,
    pollContext: {
      session,
      endpoints,
      machineId: session.machineId,
      machineType: login.machineType,
      machineToken: machineToken ?? randomUUID(),
      // UA 跟随 profile：授权站/凭据/UA 是同一套客户端身份，不能一半带一半不带
      userAgent: loginProfile.userAgent,
      // 轮询可观测日志要用它；不带凭据，仅状态码与字段名
      logger,
    },
    intervalMs: login.pollIntervalMs,
    expiresAtMs: login.timeoutMs ?? timeoutMs,
  };
}

// 轮询一次：404/无 token = pending；拿到 token = granted（再补 userinfo 组装凭据）
// 每次轮询都记一行可观测日志（状态码 + 是否含 token 字段），**绝不打印 token 值**：
// 「浏览器说登录成功、插件一直 pending」这类故障只有靠这行才能分清是哪个域/哪个状态。
export async function pollDeviceLogin({ pollContext, fetchImpl }) {
  const { session, endpoints, machineId, machineType, machineToken, logger, userAgent } = pollContext;
  const pollUrl = buildPollUrl({ session, endpoints });
  const pollHeaders = { accept: 'application/json' };
  if (typeof userAgent === 'string' && userAgent.length > 0) pollHeaders['user-agent'] = userAgent;
  const response = await fetchImpl(pollUrl, {
    method: 'GET',
    headers: pollHeaders,
  });

  // 404 = 会话还没就绪；202 = 已接受但尚未完成授权（Python 参考 qoder_accounts.py:4497-4498 同口径）
  if (response.status === 404 || response.status === 202) {
    logger?.info?.(`登录轮询：${new URL(pollUrl).host} → HTTP ${response.status}（等待授权）`);
    return { status: 'pending' };
  }
  if (!response.ok) {
    logger?.warn?.(`登录轮询：${new URL(pollUrl).host} → HTTP ${response.status}（服务端异常）`);
    throw loginError(LOGIN_ERROR_CODES.POLL_FAILED, `登录轮询返回 HTTP ${response.status}`);
  }

  const payload = await response.json();
  const tokenPayload = parseTokenPayload(payload);
  if (!tokenPayload) {
    logger?.warn?.(`登录轮询：HTTP ${response.status} 但没有 token 字段（回执字段：${Object.keys(payload ?? {}).join(',') || '空'}）`);
    return { status: 'pending' };
  }
  logger?.info?.(`登录轮询：HTTP ${response.status} 已拿到 token（长度 ${tokenPayload.accessToken.length}），继续取 userinfo`);

  let userInfo = { userId: null, nickname: null };
  if (endpoints.userInfo) {
    userInfo = await fetchUserInfo({ accessToken: tokenPayload.accessToken, endpoints, fetchImpl, userAgent });
  }

  // 判重键：userinfo 的 user_id 优先，其次设备码响应里的 user_id；
  // 两个都没有就让它缺——由存储层按铁律 8「缺身份只新增不去重」处理，这里不编造
  const userId = userInfo.userId ?? tokenPayload.userId ?? null;
  const nickname = userInfo.nickname ?? tokenPayload.nickname ?? null;

  return {
    status: 'granted',
    credential: {
      accessToken: tokenPayload.accessToken,
      ...(tokenPayload.refreshToken ? { refreshToken: tokenPayload.refreshToken } : {}),
      ...(tokenPayload.expiresAt ? { expiresAt: tokenPayload.expiresAt } : {}),
      ...(userId ? { userId } : {}),
      ...(nickname ? { nickname } : {}),
      machineId,
      machineType,
      machineToken,
      domain: new URL(endpoints.openApiBase).host,
    },
  };
}
