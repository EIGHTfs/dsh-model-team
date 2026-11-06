// Qoder 设备身份头族（M1 纯函数）：三件 Cosy 头必须齐全且值原样；缺 machine_* 必须抛错，绝不静默发缺头请求。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COSY_CLIENT_TYPE,
  COSY_HEADERS,
  MissingMachineIdentityError,
  QODER_USER_AGENT,
  REQUEST_KINDS,
  buildCosyHeaders,
} from '../src/gateway/reverse/qoder/headers.js';

// 注意：machine_token 与 machine_id 是两个字段。头族要的是 machine_token；
// machine_id 只随凭据持久化并进续期载荷，**不用于请求头**。
const CREDENTIAL = Object.freeze({
  access_token: 'access-token-example',
  refresh_token: 'refresh-token-example',
  machine_token: 'machine-token-example',
  machine_id: 'machine-id-abc123',
  machine_type: 'mac-arm64',
});

test('头族齐全：三件 Cosy 头 + Authorization 形状正确，值与凭据逐字节一致', () => {
  const headers = buildCosyHeaders({ credential: CREDENTIAL });

  assert.equal(headers[COSY_HEADERS.machineToken], CREDENTIAL.machine_token, '头族要的是 machine_token，不是 machine_id');
  assert.notEqual(headers[COSY_HEADERS.machineToken], CREDENTIAL.machine_id, 'machine_id 不得顶替 machine_token');
  assert.equal(headers[COSY_HEADERS.machineType], CREDENTIAL.machine_type);
  assert.equal(headers[COSY_HEADERS.clientType], COSY_CLIENT_TYPE);
  assert.equal(headers[COSY_HEADERS.authorization], `Bearer ${CREDENTIAL.access_token}`);
  assert.equal(headers[COSY_HEADERS.userAgent], QODER_USER_AGENT);
});

test('不多带头：除了 token（在 Authorization 里）不把凭据塞进别的字段', () => {
  const headers = buildCosyHeaders({ credential: CREDENTIAL });

  assert.deepEqual(
    Object.keys(headers).sort(),
    [COSY_HEADERS.accept, COSY_HEADERS.authorization, COSY_HEADERS.clientType,
      COSY_HEADERS.machineToken, COSY_HEADERS.machineType, COSY_HEADERS.userAgent].filter((name) => name in headers).sort(),
  );
  // 除了 authorization，任何头都不许出现 access_token/refresh_token 明文
  const headersWithoutAuthorization = { ...headers };
  delete headersWithoutAuthorization[COSY_HEADERS.authorization];
  const serializedOthers = JSON.stringify(headersWithoutAuthorization);
  assert.equal(serializedOthers.includes(CREDENTIAL.access_token), false);
  assert.equal(serializedOthers.includes(CREDENTIAL.refresh_token), false);
});

test('stream 请求额外带 accept: text/event-stream；chat 请求不带', () => {
  const streamHeaders = buildCosyHeaders({ credential: CREDENTIAL, requestKind: REQUEST_KINDS.stream });
  const chatHeaders = buildCosyHeaders({ credential: CREDENTIAL });

  assert.equal(streamHeaders[COSY_HEADERS.accept], 'text/event-stream');
  assert.equal(COSY_HEADERS.accept in chatHeaders, false);
});

test('缺 machine_token：抛 MissingMachineIdentityError（清单点machine_token），不静默发请求', () => {
  const credentialWithoutMachine = { access_token: CREDENTIAL.access_token, machine_type: CREDENTIAL.machine_type };

  assert.throws(
    () => buildCosyHeaders({ credential: credentialWithoutMachine }),
    (error) => {
      assert.equal(error instanceof MissingMachineIdentityError, true);
      assert.equal(error.code, 'MISSING_MACHINE_IDENTITY');
      assert.deepEqual(error.missingFields, ['machine_token']);
      return true;
    },
  );
});

test('反例（铁律 9）：只给 machine_id、没给 machine_token → 必须抛错，绝不用 machine_id 顶替', () => {
  assert.throws(
    () => buildCosyHeaders({
      credential: { access_token: 't', machine_id: 'machine-id-abc123', machine_type: 'mac-arm64' },
    }),
    (error) => {
      assert.equal(error instanceof MissingMachineIdentityError, true);
      assert.deepEqual(error.missingFields, ['machine_token'], '清单必须点名 machine_token');
      assert.equal(error.message.includes('machine_token'), true);
      return true;
    },
  );
});

test('缺 machine_type / 缺 token：同样抛错，缺失清单逐项列全', () => {
  assert.throws(
    () => buildCosyHeaders({ credential: { access_token: 't', machine_token: 'mt' } }),
    (error) => error.missingFields.includes('machine_type'),
  );
  assert.throws(
    () => buildCosyHeaders({ credential: { machine_token: 'mt', machine_type: 'mac' } }),
    (error) => error.missingFields.includes('access_token'),
  );
  assert.throws(
    () => buildCosyHeaders({ credential: {} }),
    (error) => error.missingFields.length === 3,
  );
  assert.throws(() => buildCosyHeaders({ credential: null }), /缺少设备身份字段/);
});

test('空串 / 纯空白不算"有值"（避免发一个看起来有头、其实为空的请求）', () => {
  assert.throws(
    () => buildCosyHeaders({ credential: { access_token: 't', machine_token: '   ', machine_type: 'mac' } }),
    (error) => error.missingFields.includes('machine_token'),
  );
});
