// Qoder 平台自描述（M1 骨架：只给元数据 + 契约方法，不联网）。
//
// 铁律 2：一个平台的全部元数据都在这一个 `platform` 对象里 —— 框架按注册表驱动，
// 新增平台只需要在 reverse/index.js 加一行 import，不需要在别处补登记。
// 铁律 17：端点、超时只在本文件写一次；envelope.js / headers.js 不重复这些值。

import { buildCosyHeaders, REQUEST_KINDS } from './headers.js';
import { unwrapEnvelope } from './envelope.js';
import { pollDeviceLogin, startDeviceLogin } from './oauth.js';
import { isQoderWasmAvailable } from './wasm-path.js';
import { deriveFingerprint, mergeFingerprint } from './fingerprint.js';
import { displayNameFor, isKnownCatalogKey, listCatalogKeys } from './catalog.js';

// 未实现的网络方法统一抛这个错误：M1 不允许"悄悄发请求"
export const NOT_IMPLEMENTED_CODE = 'REVERSE_NOT_IMPLEMENTED';

function notImplemented(methodName) {
  const error = new Error(`Qoder ${methodName} 尚未实现（M1 只做骨架与纯函数）`);
  error.code = NOT_IMPLEMENTED_CODE;
  return error;
}

export const platform = {
  // 上游错误认领模块（字符串路径；由注册器动态加载，通用层不认识它）
  streamErrorClaimersModule: './claimers.js',
  streamErrorClaimersBase: import.meta.url,
  // 内部 id 与对外驱动 id 是两个空间；换算在 reverse/index.js（此处只声明结果）
  id: 'qoder',
  // 驱动展示名（drivers 列表里给用户看的）
  name: 'Qoder',
  driverId: 'reverse-qoder',

  // 端点表：全部相对路径；base 只有国内版（国际版本机 SNI 不可达，试点不做）
  endpoints: Object.freeze({
    openApiBase: 'https://openapi.qoder.com.cn',
    // authBase 是**兜底值**：真正生效的是 profile.authBase（见 login.profiles）。
    // 教训（2026-11-08）：两套 CN 客户端配置的「授权站 + client_id + redirect_uri」是**成套**的
    // —— providers-hub 用 qoder.cn + 732aef47…（不带 redirect_uri），Python 用 qoder.com.cn +
    // 1c5e33e1…（带 qoder-work-cn://）。我们曾把两家的参数混在一套里（授权站取 A、client_id 取 B），
    // 现象正是「浏览器在授权站显示登录成功，插件轮询一直拿不到 token」。
    // 定论前先不删任何一家：默认 Python 那套，另一套留作可切换 profile。
    authBase: 'https://qoder.com.cn',
    deviceSelectPath: '/device/selectAccounts',
    inferBase: 'https://gateway.qoder.com.cn',
    inferPath: '/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1',
    publicChatPath: '/model/v1/chat/completions',
    deviceCode: '/api/v1/deviceCode',
    deviceTokenPoll: '/api/v1/deviceToken/poll',
    deviceTokenRefresh: '/api/v1/deviceToken/refresh',
    userInfo: '/api/v1/userinfo',
    usage: '/api/v1/usage',
  }),

  // 登录参数：**一套 profile 必须自带 authBase + clientId + redirectUri + userAgent**。
  // 为什么把 authBase 收进 profile：两套 CN 配置的授权站与参数是绑定的，混用会出现
  // 「授权页显示成功、轮询一直 pending」。把四者放在同一对象里，切换就是成套切换，不可能再混搭。
  login: Object.freeze({
    machineType: 'mac-arm64',
    pollIntervalMs: 1_000,
    timeoutMs: 300_000,
    defaultProfile: 'cn-python',
    profileEnvVar: 'DSH_MODEL_TEAM_QODER_LOGIN_PROFILE',
    profiles: Object.freeze({
      // 默认：CN Python 参考（qoder_accounts.py:250-266,4450-4463）——授权站 qoder.com.cn + 带 redirect_uri + UA QoderWork
      'cn-python': Object.freeze({
        id: 'cn-python',
        authBase: 'https://qoder.com.cn',
        clientId: '1c5e33e1-364d-4ce6-b02c-acaa81274a5c',
        redirectUri: 'qoder-work-cn://',
        nonceStyle: 'dashed',
        userAgent: 'QoderWork/1.1.75',
      }),
      // 备选：providers-hub 的 CN 成套值（qoder-product.js:316-319）——授权站 qoder.cn、不带 redirect_uri、UA qoder/1.0.0
      'cn-providers': Object.freeze({
        id: 'cn-providers',
        authBase: 'https://qoder.cn',
        clientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
        nonceStyle: 'dashed',
        userAgent: 'qoder/1.0.0',
      }),
      // 国际版：client_id 不同 + nonce 为 32 位无横线 hex
      intl: Object.freeze({
        id: 'intl',
        authBase: 'https://qoder.com',
        clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
        nonceStyle: 'hex32',
        userAgent: 'Qoder/1.1.75',
      }),
    }),
  }),

  // 解析本次实际生效的授权站：profile 自带优先，缺失才回落 endpoints.authBase
  resolveAuthBase(profile) {
    const fromProfile = profile?.authBase;
    if (typeof fromProfile === 'string' && fromProfile.length > 0) return fromProfile;
    return platform.endpoints.authBase;
  },

  // 超时与轮询参数：与端点一样，只在这里出现
  timeouts: Object.freeze({
    requestMs: 30_000,
    loginTotalMs: 300_000,
    pollIntervalMs: 1_000,
  }),

  capabilities: Object.freeze({
    streaming: true,
    tools: true,
    images: false,
    reasoning: false,
    // 加密推理通道：native 后端（纯 Node）始终可用，所以这里恒为 true；
    // wasm 是可选后端，缺失只影响 wasmBackend 位，不影响该平台能不能跑
    encryptedInference: true,
    wasmBackend: isQoderWasmAvailable(),
    catalogKeys: Object.freeze(['qfmodel', 'dmodel']),
  }),

  // 契约方法：纯函数直接接；需要网络/加密的在 M1 明确抛「未实现」
  createPlatform({ http, crypto, now } = {}) {
    const dependencies = { http, crypto, now };
    return {
      dependencies,
      // 登录：生成授权页 URL（不联网）与轮询（每次一个 HTTP），状态机在 core/login-session.js
      startDeviceLogin({ machineId, machineToken, dataRoot, logger, profileName } = {}) {
        return startDeviceLogin({
          endpoints: platform.endpoints,
          login: platform.login,
          profile: resolveLoginProfile({ platform, profileName, environment: process.env }),
          machineId,
          machineToken,
          dataRoot,
          logger,
        });
      },
      pollDeviceLogin({ pollContext, fetchImpl }) {
        return pollDeviceLogin({ pollContext, fetchImpl });
      },
      // 设备指纹：登录成功时由 uid 派生；老账号已有值优先（只补不覆盖）
      deriveFingerprint(userId) { return deriveFingerprint(userId ?? ''); },
      mergeFingerprint(existingCredential, derived) { return mergeFingerprint(existingCredential, derived); },
      // 续期是 M4 的范围
      refreshCredential() { throw notImplemented('refreshCredential'); },
      // 取模型清单需要网络（M2/M3）
      listModels() { throw notImplemented('listModels'); },
      // 加密请求体需要 WASM（M3）
      encodeRequestBody() { throw notImplemented('encodeRequestBody'); },
      // 纯函数：头族与信封剥离现在就能用
      buildHeaders({ credential, requestKind = REQUEST_KINDS.chat } = {}) {
        return buildCosyHeaders({ credential, requestKind });
      },
      decodeStreamChunk(rawEvent) {
        return unwrapEnvelope(rawEvent);
      },
      // 目录映射（纯数据）
      isKnownModel(catalogKey) { return isKnownCatalogKey(catalogKey); },
      listModelsMeta() { return listCatalogKeys().map((key) => ({ key, displayName: displayNameFor(key) })); },
    };
  },
};

// 解析本次登录用哪套 profile：显式参数 → 环境变量 → 默认（cn-python）；名字不认识就回落默认并提示
export function resolveLoginProfile({ platform: platformEntry = platform, profileName, environment = process.env } = {}) {
  const login = platformEntry.login ?? {};
  const profiles = login.profiles ?? {};
  const requested = typeof profileName === 'string' && profileName.length > 0
    ? profileName
    : (typeof environment?.[login.profileEnvVar] === 'string' ? environment[login.profileEnvVar].trim() : '');
  if (requested && profiles[requested]) return profiles[requested];
  return profiles[login.defaultProfile] ?? Object.values(profiles)[0];
}

export default platform;
