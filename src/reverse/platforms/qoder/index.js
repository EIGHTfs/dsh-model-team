// Qoder 平台自描述（M1 骨架：只给元数据 + 契约方法，不联网）。
//
// 铁律 2：一个平台的全部元数据都在这一个 `platform` 对象里 —— 框架按注册表驱动，
// 新增平台只需要在 reverse/index.js 加一行 import，不需要在别处补登记。
// 铁律 17：端点、超时只在本文件写一次；envelope.js / headers.js 不重复这些值。

import { buildCosyHeaders, REQUEST_KINDS } from './headers.js';
import { unwrapEnvelope } from './envelope.js';
import { pollDeviceLogin, startDeviceLogin } from './oauth.js';
import { isQoderWasmAvailable } from './wasm-path.js';
import { displayNameFor, isKnownCatalogKey, listCatalogKeys } from './catalog.js';

// 未实现的网络方法统一抛这个错误：M1 不允许"悄悄发请求"
export const NOT_IMPLEMENTED_CODE = 'REVERSE_NOT_IMPLEMENTED';

function notImplemented(methodName) {
  const error = new Error(`Qoder ${methodName} 尚未实现（M1 只做骨架与纯函数）`);
  error.code = NOT_IMPLEMENTED_CODE;
  return error;
}

export const platform = {
  // 内部 id 与对外驱动 id 是两个空间；换算在 reverse/index.js（此处只声明结果）
  id: 'qoder',
  // 驱动展示名（drivers 列表里给用户看的）
  name: 'Qoder（反代）',
  driverId: 'reverse-qoder',

  // 端点表：全部相对路径；base 只有国内版（国际版本机 SNI 不可达，试点不做）
  endpoints: Object.freeze({
    openApiBase: 'https://openapi.qoder.com.cn',
    // 授权页挂在 authBase（≠ openApiBase）：写错 host 会让登录永远失败
    authBase: 'https://qoder.cn',
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

  // 登录参数：clientId 取国内版 prod 值；machineType/machineToken 是设备身份（头族用）
  login: Object.freeze({
    clientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
    machineType: 'mac-arm64',
    pollIntervalMs: 1_000,
    timeoutMs: 300_000,
  }),

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
      // 登录：生成授权页 URL（不联网）与轮询（每次一个 HTTP），状态机在 reverse/login-session.js
      startDeviceLogin({ machineId, machineToken } = {}) {
        return startDeviceLogin({
          endpoints: platform.endpoints,
          login: platform.login,
          machineId,
          machineToken,
        });
      },
      pollDeviceLogin({ pollContext, fetchImpl }) {
        return pollDeviceLogin({ pollContext, fetchImpl });
      },
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

export default platform;
