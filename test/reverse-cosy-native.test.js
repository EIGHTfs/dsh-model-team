// Qoder COSY 加密层（M3a）：native 实现与 Python 参考实现逐字节对拍 + 后端选择 + wasm 缺失语义。
//
// golden 向量由 scripts/reverse-cosy-vectors.mjs 生成（Python 侧跑 qoder2api-hub 的签名实现）。
// 这里只存/比哈希，不含任何真实凭据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

import {
  CRYPTO_BACKEND_ERROR_CODES,
  CRYPTO_BACKEND_ENV_VAR,
  createCryptoBackend,
  resolveBackendKind,
} from '../src/reverse/platforms/qoder/crypto/index.js';
import {
  buildEncryptedRequestWithNative,
  buildInferPayloadText,
  qoderEncode,
} from '../src/reverse/platforms/qoder/crypto/native.js';

const FIXTURE = JSON.parse(await fs.readFile(
  new URL('./fixtures/qoder-cosy-vectors.json', import.meta.url), 'utf8',
));

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// 与生成器同一套确定性随机源：tempKey / requestId / RSA 填充全部固定
function buildDeterministicRng(vector) {
  const paddingBytes = Buffer.from(vector.rsaPaddingHex, 'hex');
  return {
    hex: (length) => vector.tempKeyHex.slice(0, length),
    uuid: () => vector.requestId,
    bytes: (length) => {
      const repeated = Buffer.concat(Array.from({ length: Math.ceil(length / paddingBytes.length) + 1 }, () => paddingBytes));
      return repeated.subarray(0, length);
    },
  };
}

for (const vector of FIXTURE.vectors) {
  test(`golden 对拍（${vector.name}）：native 的 Bearer 与 Python 参考实现逐字节一致`, async () => {
    const result = await buildEncryptedRequestWithNative({
      credential: vector.credential,
      messages: vector.messages,
      tools: vector.tools,
      model: vector.model,
      inferBase: vector.inferBase,
      now: () => vector.nowMs,
      rng: buildDeterministicRng(vector),
    });

    assert.equal(sha256Hex(result.headers.authorization), vector.bearerSha256, 'Bearer 必须逐字节一致');
    assert.equal(result.headers.authorization.startsWith(vector.bearerPrefix), true);
    assert.equal(result.headers['cosy-date'], vector.date);
    assert.equal(sha256Hex(result.session.cosyKey), vector.cosyKeySha256, 'cosyKey（RSA 包裹后的会话密钥）必须一致');
    assert.equal(sha256Hex(result.headers.authorization.split('.')[1]), vector.payloadSha256, 'COSY payload 必须一致');
    assert.equal(sha256Hex(result.body), vector.bodyEncodedSha256, '请求体（自定义 base64）必须一致');
    assert.equal(sha256Hex(result.bodyPlainText), vector.bodySha256, '签名前的明文 body 必须一致');
  });
}

test('后端选择：默认 auto → native（零依赖优先）', () => {
  assert.equal(resolveBackendKind({ environment: {} }), 'native');
  assert.equal(resolveBackendKind({ environment: { [CRYPTO_BACKEND_ENV_VAR]: 'auto' } }), 'native');
  assert.equal(createCryptoBackend({ environment: {} }).kind, 'native');
});

test('后端选择：native / wasm 可显式指定，环境变量生效', () => {
  assert.equal(resolveBackendKind({ environment: { [CRYPTO_BACKEND_ENV_VAR]: 'native' } }), 'native');
  assert.equal(resolveBackendKind({ environment: { [CRYPTO_BACKEND_ENV_VAR]: 'wasm' } }), 'wasm');
  assert.equal(resolveBackendKind({ environment: { [CRYPTO_BACKEND_ENV_VAR]: '  WASM  ' } }), 'wasm', '大小写与空白要容忍');
  assert.equal(createCryptoBackend({ kind: 'wasm', environment: {} }).kind, 'wasm');
});

test('后端选择：未知取值 → 明确报错（不猜、不回落）', () => {
  assert.throws(
    () => resolveBackendKind({ environment: { [CRYPTO_BACKEND_ENV_VAR]: 'rust' } }),
    (error) => error.code === CRYPTO_BACKEND_ERROR_CODES.UNKNOWN_KIND,
  );
});

test('wasm 后端：文件缺失时明确报「不可用」，绝不静默换成 native', async () => {
  const backend = createCryptoBackend({ kind: 'wasm', environment: {}, wasmPath: '/nonexistent/qoder-auth-wasm.wasm' });
  const vector = FIXTURE.vectors[0];

  await assert.rejects(
    () => backend.buildEncryptedRequest({
      credential: vector.credential,
      messages: vector.messages,
      tools: vector.tools,
      model: vector.model,
    }),
    (error) => error.code === 'REVERSE_WASM_MISSING',
  );
});

test('注入 now / rng 生效：同参两次逐字节相同，换时间则签名不同', async () => {
  const vector = FIXTURE.vectors[0];
  const runOnce = (nowMs) => buildEncryptedRequestWithNative({
    credential: vector.credential,
    messages: vector.messages,
    tools: vector.tools,
    model: vector.model,
    inferBase: vector.inferBase,
    now: () => nowMs,
    rng: buildDeterministicRng(vector),
  });

  const first = await runOnce(vector.nowMs);
  const second = await runOnce(vector.nowMs);
  const later = await runOnce(vector.nowMs + 1000);

  assert.equal(first.headers.authorization, second.headers.authorization, '固定 time/rng 必须可复现');
  assert.notEqual(first.headers['cosy-date'], later.headers['cosy-date'], '换时间 → date 变');
  assert.notEqual(first.headers.authorization, later.headers.authorization, 'date 进签名 → Bearer 随之变');
});

test('未登录：缺 accessToken / machine 三件套 → 明确报 REVERSE_NOT_LOGGED_IN', async () => {
  await assert.rejects(
    () => buildEncryptedRequestWithNative({
      credential: { accessToken: 'x', machineId: 'm' },
      messages: [{ role: 'user', content: 'hi' }],
      model: 'qfmodel',
    }),
    (error) => error.code === 'REVERSE_NOT_LOGGED_IN',
  );
});

test('请求体可独立复算：payload 文本与编码后再解码回环一致', () => {
  const vector = FIXTURE.vectors[0];
  const bodyText = buildInferPayloadText({
    messages: vector.messages,
    tools: vector.tools,
    model: vector.model,
    requestId: vector.requestId,
  });
  assert.equal(sha256Hex(bodyText), vector.bodySha256, '同输入必须产出同一份 body 明文');
  assert.equal(sha256Hex(qoderEncode(Buffer.from(bodyText, 'utf8'))), vector.bodyEncodedSha256);
});
