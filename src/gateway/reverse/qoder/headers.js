// Qoder 设备身份头族（纯函数，M1 不联网）。
//
// 事实（docs/16 §二.1、§六）：每个请求都必须带 Cosy-MachineToken / Cosy-MachineType / Cosy-ClientType；
// 缺 machine 头族时服务端**不报错**，只是不下发活动与能力（曾表现为「积分已领取」但实际没领）。
// 所以这里的原则是：**缺字段就抛错，绝不静默发一个缺头的请求**——静默失败比报错难查一百倍。
//
// 本文件只放"头"相关的东西；端点与超时都在 qoder/index.js（铁律 17：同一条事实只写一处）。

// 头名集中成常量：调用方、测试与文档都引用同一份
export const COSY_HEADERS = Object.freeze({
  machineToken: 'Cosy-MachineToken',
  machineType: 'Cosy-MachineType',
  clientType: 'Cosy-ClientType',
  authorization: 'authorization',
  userAgent: 'user-agent',
  accept: 'accept',
});

// 与官方客户端同形的客户端类型（不是 node/undici 那种裸客户端标识）
export const COSY_CLIENT_TYPE = 'qoder';

// UA 必须是官方客户端形状：默认 UA（node）是最容易触发风控的特征之一
export const QODER_USER_AGENT = 'Qoder/1.0 (dsh-model-team; reverse)';

export const REQUEST_KINDS = Object.freeze({ chat: 'chat', stream: 'stream' });

// 缺失设备身份：用独立错误码，调用方据此提示"重新登录"而不是"重试"
export class MissingMachineIdentityError extends Error {
  constructor(message, missingFields) {
    super(message);
    this.name = 'MissingMachineIdentityError';
    this.code = 'MISSING_MACHINE_IDENTITY';
    this.missingFields = missingFields;
  }
}

function readFirstText(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }
  return null;
}

// 凭据字段两种命名都认（落盘用蛇形；内部对象可能是驼峰）
function pickCredentialFields(credential) {
  return {
    accessToken: readFirstText([credential?.access_token, credential?.accessToken]),
    machineToken: readFirstText([credential?.machine_token, credential?.machineToken, credential?.machine_id, credential?.machineId]),
    machineType: readFirstText([credential?.machine_type, credential?.machineType]),
  };
}

// 构造请求头：三件 Cosy 头族 + Authorization + UA；stream 额外带 accept
export function buildCosyHeaders({ credential, requestKind = REQUEST_KINDS.chat } = {}) {
  const { accessToken, machineToken, machineType } = pickCredentialFields(credential);
  const missingFields = [];
  if (!accessToken) missingFields.push('access_token');
  if (!machineToken) missingFields.push('machine_id');
  if (!machineType) missingFields.push('machine_type');
  if (missingFields.length > 0) {
    throw new MissingMachineIdentityError(
      `缺少设备身份字段：${missingFields.join('、')}；缺头会让服务端静默不下发能力，必须重新登录后再发请求`,
      missingFields,
    );
  }

  const headers = {
    [COSY_HEADERS.authorization]: `Bearer ${accessToken}`,
    [COSY_HEADERS.machineToken]: machineToken,
    [COSY_HEADERS.machineType]: machineType,
    [COSY_HEADERS.clientType]: COSY_CLIENT_TYPE,
    [COSY_HEADERS.userAgent]: QODER_USER_AGENT,
  };
  if (requestKind === REQUEST_KINDS.stream) {
    headers[COSY_HEADERS.accept] = 'text/event-stream';
  }
  return headers;
}
