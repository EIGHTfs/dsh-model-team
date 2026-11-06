// Qoder 加密后端：wasm（官方客户端的 wasm-bindgen 实现，可选，不在库里分发）。
//
// 与 native 后端的区别：native 用公开算法重实现（AES/RSA/自定义 base64），wasm 直接用官方
// 客户端那份二进制。两者对同一输入产出的 Bearer 必须逐字节一致（golden 向量对拍）。
//
// 硬约束：显式要求 wasm 但找不到文件时**明确报不可用**，绝不回落 native——
// 回落会让"两条链路行为不同却看起来一样"，排查时根本分不清请求是谁发的。

import fs from 'node:fs';

import { loadGlue, COSY_VERSION } from './wasm-glue.js';
import { resolveQoderWasmPath } from '../wasm-path.js';
import { buildCosyHeaders, buildInferPayloadText, INFER_PATH, NATIVE_ERROR_CODES } from './native.js';

export const WASM_ERROR_CODES = Object.freeze({
  WASM_MISSING: 'REVERSE_WASM_MISSING',
  ENCRYPT_FAILED: 'REVERSE_ENCRYPT_FAILED',
});

const DEFAULT_CLIENT_METADATA = Object.freeze({
  client_type: '5',
  business_product: 'cli',
  business_type: 'agent',
  scene: 'assistant',
});

function wasmError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

// 运行时鉴权字段（Rust 侧识别身份的依据）
async function generateRuntimeAuthFields(glue, { uid, accessToken }) {
  const payloadText = JSON.stringify({
    uid,
    security_oauth_token: accessToken,
    organization_id: '',
    organization_tags: [],
    data_policy_agreed: false,
  });
  const rawJson = glue.callString((stack) => {
    const payloadPtr = glue.writeString(payloadText);
    glue.exports.generate_runtime_auth_fields(stack, payloadPtr, glue.lastLength());
  });
  return JSON.parse(rawJson);
}

async function createInferContext(glue, { credential }) {
  const authFields = await generateRuntimeAuthFields(glue, { uid: credential.userId ?? '', accessToken: credential.accessToken });
  const userInfoJson = JSON.stringify({
    uid: credential.userId ?? '',
    encrypt_user_info: authFields.encrypt_user_info,
    key: authFields.key,
    organization_id: '',
    organization_tags: [],
    data_policy_agreed: false,
  });
  return glue.callPointer((stack) => {
    // 参数顺序：(sp, machineId, len, version, len, userInfo, len, clientMeta, len)
    const machinePtr = glue.writeString(credential.machineId);
    const machineLen = glue.lastLength();
    const versionPtr = glue.writeString(COSY_VERSION);
    const versionLen = glue.lastLength();
    const userInfoPtr = glue.writeString(userInfoJson);
    const userInfoLen = glue.lastLength();
    const metadataPtr = glue.writeString(JSON.stringify(DEFAULT_CLIENT_METADATA));
    const metadataLen = glue.lastLength();
    glue.exports.qodercontext_new(stack, machinePtr, machineLen, versionPtr, versionLen, userInfoPtr, userInfoLen, metadataPtr, metadataLen);
  });
}

// 读 requestresult_url / requestresult_body 的返回串（Rust 侧新分配，必须释放）
function readResultString(glue, resultPointer, invoke) {
  let outPtr = 0;
  let outLen = 0;
  const dataView = glue.view();
  const stack = glue.exports.__wbindgen_add_to_stack_pointer(-16);
  try {
    invoke(stack, resultPointer);
    outPtr = dataView.getInt32(stack + 0, true);
    outLen = dataView.getInt32(stack + 4, true);
    return outPtr ? glue.readString(outPtr, outLen) : '';
  } finally {
    glue.exports.__wbindgen_add_to_stack_pointer(16);
    glue.freeString(outPtr, outLen);
  }
}

// wasm 后端入口：{ url, headers, body, ... }（headers 由 WASM 签名，必须原样透传）
export async function buildEncryptedRequestWithWasm({
  credential,
  messages,
  tools,
  model,
  inferBase = 'https://gateway.qoder.com.cn',
  environment = process.env,
  dataRoot,
  wasmPath,
  now,
  rng,
} = {}) {
  // 显式指定的路径同样要校验存在：不存在与"没找到"同属 WASM_MISSING，不能变成加载失败
  const explicitWasm = wasmPath && fs.existsSync(wasmPath) ? { path: wasmPath, source: 'explicit' } : null;
  const resolvedWasm = explicitWasm ?? (wasmPath ? null : resolveQoderWasmPath({ environment, dataRoot }));
  if (!resolvedWasm) {
    throw wasmError(WASM_ERROR_CODES.WASM_MISSING, 'Qoder WASM 不可用：把 qoder-auth-wasm.wasm 放到 <dataRoot>/reverse/qoder/，或用 DSH_MODEL_TEAM_QODER_WASM 指定路径（显式选了 wasm 后端时不回落 native）');
  }
  if (!credential?.accessToken || !credential?.machineId) {
    throw wasmError(NATIVE_ERROR_CODES.NOT_LOGGED_IN, '反代账号未登录：请先执行 node scripts/reverse-login.mjs --platform qoder');
  }

  let glue;
  try {
    glue = await loadGlue(resolvedWasm.path);
  } catch (glueError) {
    throw wasmError(WASM_ERROR_CODES.ENCRYPT_FAILED, 'Qoder WASM 加载失败', glueError);
  }

  let contextPointer = 0;
  try {
    contextPointer = await createInferContext(glue, { credential });
    // WASM 侧自己构造请求体（它的 payload 比 native 多内部字段），因此只传"对话"而非完整 body
    const askPayload = JSON.parse(buildInferPayloadText({ messages, tools, model, requestId: (rng?.uuid?.() ?? crypto.randomUUID()) }));
    const askText = JSON.stringify(askPayload);
    const resultPointer = glue.callPointer((stack) => {
      const hostPtr = glue.writeString(inferBase);
      const hostLen = glue.lastLength();
      const bodyPtr = glue.writeString(askText);
      const bodyLen = glue.lastLength();
      const keyPtr = glue.writeString(model);
      const keyLen = glue.lastLength();
      const sourcePtr = glue.writeString('system');
      const sourceLen = glue.lastLength();
      glue.exports.qodercontext_prepareInferRequest(stack, contextPointer, hostPtr, hostLen, bodyPtr, bodyLen, keyPtr, keyLen, sourcePtr, sourceLen);
    });
    try {
      const headerMap = glue.takeObject(glue.exports.requestresult_headers(resultPointer));
      const headers = {};
      if (headerMap instanceof Map) {
        for (const [headerName, headerValue] of headerMap) headers[String(headerName)] = String(headerValue);
      }
      const url = readResultString(glue, resultPointer, (stack, pointer) => glue.exports.requestresult_url(stack, pointer));
      return {
        url,
        headers,
        body: readResultString(glue, resultPointer, (stack, pointer) => glue.exports.requestresult_body(stack, pointer)),
        wasmSource: resolvedWasm.source,
        // 对拍与排查用：native 签名头（wasm 的 Bearer 在 headers 里，这里不重复）
        nativeHeadersForCompare: buildCosyHeaders({
          credential,
          bodyText: '',
          rawUrl: `${inferBase}${INFER_PATH}`,
          modelKey: model,
          requestId: 'compare',
          nowMs: typeof now === 'function' ? now() : (now ?? Date.now()),
          session: { cosyKey: '', info: '' },
        }),
      };
    } finally {
      glue.freePointer('__wbg_requestresult_free', resultPointer);
    }
  } catch (encryptError) {
    if (encryptError?.code) throw encryptError;
    throw wasmError(WASM_ERROR_CODES.ENCRYPT_FAILED, 'Qoder 请求体加密失败（WASM 调用异常）', encryptError);
  } finally {
    if (contextPointer) glue.freePointer('__wbg_qodercontext_free', contextPointer);
  }
}
