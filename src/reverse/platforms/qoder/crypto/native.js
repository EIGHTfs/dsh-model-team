// Qoder COSY 签名的 **纯 Node 原生实现**（零第三方依赖、不需要 wasm）。
//
// 算法实现改编自 qoder2api-hub 的 qoder_sign.py（MIT）。四段拼起来才是完整链路：
//   1. 自定义 Base64 变体编码请求体：std = base64(plain)；a = len(std)//3；
//      rearranged = std[n-a:] + std[a:n-a] + std[:a]；逐字符按自定义字母表映射，`=` → `$`
//   2. AES-128-CBC（**key == iv**，PKCS7）加密身份 JSON；RSA PKCS#1 v1.5 包裹 16 字节会话密钥
//   3. COSY 载荷：{cosyVersion, ideVersion, info, requestId, version} 排序紧凑 JSON 再 base64
//   4. Bearer = `COSY.<payload_b64>.<hex(md5(payload_b64\ndate\nbody\npath))>`
//      —— 签名覆盖 body 与**去掉 `/algo` 前缀**的 path
//
// 为什么还要 wasm 后端：RSA/AES/编码这三段是公开算法，可纯 JS 重写；wasm 是官方客户端的
// 原样实现（含不确定的内部字段）。二者对同一输入的 Bearer 必须逐字节一致，靠 golden 向量对拍钉住。

import { createCipheriv, createHash, createPublicKey, randomBytes, randomUUID } from 'node:crypto';

export const NATIVE_ERROR_CODES = Object.freeze({
  NOT_LOGGED_IN: 'REVERSE_NOT_LOGGED_IN',
  ENCRYPT_FAILED: 'REVERSE_ENCRYPT_FAILED',
});

// 服务端公钥：来自客户端链路（官方客户端硬编码），非本项目生成；换公钥必须随官方客户端一起换
export const SERVER_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

export const COSY_VERSION = '1.1.75';
export const COSY_CLIENT_TYPE = '5';
export const DEFAULT_USER_TYPE = 'personal_professional_trial';
export const INFER_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';

const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CUSTOM_PAD = '$';

if (CUSTOM_ALPHABET.length !== 64 || new Set(CUSTOM_ALPHABET).size !== 64) {
  throw new Error('Qoder 自定义字母表必须是 64 个互不相同的字符');
}

const STD_TO_CUSTOM = new Map();
for (let index = 0; index < 64; index += 1) STD_TO_CUSTOM.set(STD_ALPHABET[index], CUSTOM_ALPHABET[index]);

// 请求体编码：自定义 base64（三段轮转 + 换字母表）
export function qoderEncode(plainBuffer) {
  const std = Buffer.from(plainBuffer).toString('base64');
  const total = std.length;
  const segment = Math.floor(total / 3);
  const rearranged = std.slice(total - segment) + std.slice(segment, total - segment) + std.slice(0, segment);
  let encoded = '';
  for (const character of rearranged) {
    encoded += character === '=' ? CUSTOM_PAD : STD_TO_CUSTOM.get(character);
  }
  return encoded;
}

// 键排序 + 紧凑 JSON（服务端签名的字节与此强绑定，不能改成普通 JSON.stringify）
export function jsonSortedCompact(mapping) {
  const keys = Object.keys(mapping).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(mapping[key] ?? '')}`);
  return Buffer.from(`{${parts.join(',')}}`, 'utf8');
}

// 默认随机源（可注入：对拍需要固定 tempKey / requestId / RSA 填充）
export const defaultRng = Object.freeze({
  hex: (length) => randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length),
  uuid: () => randomUUID(),
  bytes: (length) => randomBytes(length),
});

export const defaultNow = () => Date.now();

function readRsaPublicKey() {
  const jwk = createPublicKey(SERVER_PUBLIC_KEY_PEM).export({ format: 'jwk' });
  const modulusBytes = Buffer.from(jwk.n, 'base64url');
  const exponentBytes = Buffer.from(jwk.e, 'base64url');
  let exponent = 0n;
  for (const byte of exponentBytes) exponent = (exponent << 8n) | BigInt(byte);
  return { modulus: BigInt(`0x${modulusBytes.toString('hex')}`), exponent, blockBytes: modulusBytes.length };
}

const RSA_KEY = readRsaPublicKey();

function modPow(base, exponent, modulus) {
  let result = 1n;
  let factor = base % modulus;
  let remaining = exponent;
  while (remaining > 0n) {
    if (remaining & 1n) result = (result * factor) % modulus;
    factor = (factor * factor) % modulus;
    remaining >>= 1n;
  }
  return result;
}

// PKCS#1 v1.5 type 2：填充 00 02 <非零随机 PS> 00 <明文>
// 手写而非 crypto.publicEncrypt：只有自己控制填充字节，才能与参考实现逐字节对拍
export function rsaEncryptPkcs1(plainBytes, rng = defaultRng) {
  const { modulus, exponent, blockBytes } = RSA_KEY;
  const paddingLength = blockBytes - 3 - plainBytes.length;
  if (paddingLength < 8) throw new RangeError('RSA 明文过长：PKCS#1 v1.5 要求至少 8 字节填充');
  const padding = [];
  while (padding.length < paddingLength) {
    for (const byte of rng.bytes(paddingLength - padding.length)) {
      if (byte !== 0) padding.push(byte);
      if (padding.length === paddingLength) break;
    }
  }
  const encodedMessage = Buffer.concat([
    Buffer.from([0x00, 0x02]),
    Buffer.from(padding),
    Buffer.from([0x00]),
    plainBytes,
  ]);
  const cipherInt = modPow(BigInt(`0x${encodedMessage.toString('hex')}`), exponent, modulus);
  return Buffer.from(cipherInt.toString(16).padStart(blockBytes * 2, '0'), 'hex');
}

// AES-128-CBC，key == iv，PKCS7（node:crypto 默认就是 PKCS7）
export function aesCbcEncrypt(plainBuffer, keyBuffer) {
  const cipher = createCipheriv('aes-128-cbc', keyBuffer, keyBuffer);
  return Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
}

export function md5Hex(text) {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

// COSY 会话：同一账号的 cosyKey/info 可复用（这里按请求现建，M4 再做会话缓存）
export function createCosySession({ credential, rng = defaultRng } = {}) {
  const tempKeyText = rng.hex(16);            // 16 个 ASCII 字符 → UTF-8 16 字节
  const tempKeyBytes = Buffer.from(tempKeyText, 'utf8');
  const cosyKey = rsaEncryptPkcs1(tempKeyBytes, rng).toString('base64');
  const identity = {
    name: credential?.nickname ?? '',
    aid: credential?.userId ?? '',
    uid: credential?.userId ?? '',
    yx_uid: '',
    organization_id: '',
    organization_name: '',
    user_type: DEFAULT_USER_TYPE,
    security_oauth_token: credential?.accessToken ?? '',
    refresh_token: credential?.refreshToken ?? '',
  };
  const info = aesCbcEncrypt(jsonSortedCompact(identity), tempKeyBytes).toString('base64');
  return { tempKeyText, tempKeyBytes, cosyKey, info };
}

// 生成的 Bearer 与载荷（对拍只比较这些串，不落盘真实凭据）
export function buildCosyBearer({ session, bodyText, rawUrl, requestId, nowMs }) {
  const rawPath = new URL(rawUrl).pathname || '/';
  const signedPath = rawPath.startsWith('/algo') ? rawPath.slice('/algo'.length) : rawPath;
  const payload = {
    cosyVersion: COSY_VERSION,
    ideVersion: '',
    info: session.info,
    requestId,
    version: 'v1',
  };
  const payloadB64 = jsonSortedCompact(payload).toString('base64');
  const date = String(Math.floor(nowMs / 1000));
  const signature = md5Hex([payloadB64, session.cosyKey, date, bodyText, signedPath].join('\n'));
  return { payloadB64, date, signedPath, signature, bearer: `Bearer COSY.${payloadB64}.${signature}` };
}

// 完整请求头（字段与官方 CLI 同形；machine 三件套必须由调用方给出，不从 accessToken 猜）
export function buildCosyHeaders({ credential, bodyText, rawUrl, modelKey, requestId, nowMs, session }) {
  const { date, bearer } = buildCosyBearer({ session, bodyText, rawUrl, requestId, nowMs });
  const headers = {
    'cosy-data-policy': 'agree',
    'content-type': 'application/json',
    'cosy-business-product': 'cli',
    'cosy-business-type': 'agent',
    'cosy-scene': 'assistant',
    'cosy-clienttype': COSY_CLIENT_TYPE,
    'cosy-date': date,
    'cosy-user': credential?.userId ?? '',
    'cosy-key': session.cosyKey,
    accept: 'text/event-stream',
    authorization: bearer,
    'accept-encoding': 'identity',
    'cosy-version': COSY_VERSION,
    'cosy-machineid': credential?.machineId ?? '',
    'cosy-machinetoken': credential?.machineToken ?? '',
    'cosy-machinetype': credential?.machineType ?? '',
    'login-version': 'v2',
    'user-agent': 'undici',
    'cache-control': 'no-cache',
  };
  if (modelKey) {
    headers['x-model-key'] = modelKey;
    headers['x-model-source'] = 'system';
  }
  return headers;
}

// 上游协议认的请求体（本函数输出即签名 body 的明文，必须是确定性 JSON）
export function buildInferPayloadText({ messages, tools, model, requestId }) {
  const history = [];
  let systemText = '';
  let userText = '';
  for (const message of Array.isArray(messages) ? messages : []) {
    const contentText = typeof message?.content === 'string' ? message.content : '';
    if (message?.role === 'system') {
      systemText = systemText.length > 0 ? `${systemText}\n${contentText}` : contentText;
      continue;
    }
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    if (role === 'user') userText = contentText;
    history.push({ role, content: contentText, ...(message?.tool_calls ? { tool_calls: message.tool_calls } : {}) });
  }
  const payload = {
    request_id: requestId,
    request_set_id: requestId,
    chat_record_id: requestId,
    session_id: requestId,
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: { text: userText, features: [], extra: { context: [], modelConfig: { key: model, is_reasoning: false }, originalContent: userText, chatPrompt: '', imageUrls: null } },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    agent_id: 'agent_common',
    task_id: 'common',
    session_type: 'qodercli',
    aliyun_user_type: '',
    model_config: { key: model, display_name: '', model: '', format: 'openai', is_vl: false, is_reasoning: false, api_key: '', url: '', source: 'system', max_input_tokens: 200000 },
    custom_model: null,
    system: systemText ? [{ type: 'text', text: systemText }] : [],
    messages: history,
    tools: Array.isArray(tools) ? tools : [],
    parameters: {},
  };
  return JSON.stringify(payload);
}

// 后端入口：native 的 buildEncryptedRequest（now/rng 可注入，测试据此逐字节对拍）
export async function buildEncryptedRequestWithNative({
  credential,
  messages,
  tools,
  model,
  inferBase = 'https://gateway.qoder.com.cn',
  now = defaultNow,
  rng = defaultRng,
} = {}) {
  if (typeof model !== 'string' || model.length === 0) {
    const modelError = new Error('Qoder 加密请求需要 model（运行时目录里的模型 key）');
    modelError.code = NATIVE_ERROR_CODES.ENCRYPT_FAILED;
    throw modelError;
  }
  if (!credential?.accessToken || !credential?.machineId || !credential?.machineToken || !credential?.machineType) {
    const loginError = new Error('反代账号未登录或设备身份不全：请先执行 node scripts/reverse-login.mjs --platform qoder');
    loginError.code = NATIVE_ERROR_CODES.NOT_LOGGED_IN;
    throw loginError;
  }

  const requestId = rng.uuid();
  const bodyPlainText = buildInferPayloadText({ messages, tools, model, requestId });
  const body = qoderEncode(Buffer.from(bodyPlainText, 'utf8'));
  const url = `${inferBase}${INFER_PATH}`;
  const session = createCosySession({ credential, rng });
  const nowMs = typeof now === 'function' ? now() : now;

  return {
    url,
    headers: buildCosyHeaders({ credential, bodyText: body, rawUrl: url, modelKey: model, requestId, nowMs, session }),
    body,
    bodyPlainText,
    requestId,
    session: { tempKeyText: session.tempKeyText, cosyKey: session.cosyKey, info: session.info },
  };
}
