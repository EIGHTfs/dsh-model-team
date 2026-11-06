#!/usr/bin/env node
// 生成 Qoder COSY 的 golden 向量（native 实现 ↔ Python 参考实现逐字节对拍）。
//
// 用法：node scripts/reverse-cosy-vectors.mjs [--refs <qoder2api-hub 目录>]
//   默认 refs 取环境变量 QODER_REFS，其次 ../_refs/qoder2api-hub（相对仓库根）。
//
// 为什么要 Python 参与：参考实现（MIT，纯标准库）是与真实服务端对齐过的算法版本；
// 我们自己写的 native 版必须与它**逐字节一致**，否则"看起来能发请求"其实签名是错的。
// 本脚本负责：① 用我们的 payload 构造器产出 body 明文；② 交给 Python 签名；
// ③ 断言 JS native 的 Bearer 与 Python 完全相同；④ 落盘哈希（不含任何真实凭据）。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCosyBearer,
  buildEncryptedRequestWithNative,
  buildInferPayloadText,
  createCosySession,
  qoderEncode,
} from '../src/gateway/reverse/qoder/crypto/native.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = path.join(REPO_ROOT, 'test', 'fixtures', 'qoder-cosy-vectors.json');

const FAKE_CREDENTIAL = Object.freeze({
  accessToken: 'fake-access-token-for-vectors',
  refreshToken: 'fake-refresh-token-for-vectors',
  userId: 'user-vector-0001',
  nickname: '向量账号',
  machineId: '11111111-2222-4333-8444-555555555555',
  machineToken: 'fake-machine-token',
  machineType: 'x86_64_linux',
});

const CASES = [
  {
    name: 'plain-text',
    model: 'qfmodel',
    messages: [{ role: 'user', content: '你好，帮我把这句话翻译成英文。' }],
    tools: [],
  },
  {
    name: 'with-tools',
    model: 'qfmodel',
    messages: [{ role: 'user', content: '查一下北京天气' }],
    tools: [{
      type: 'function',
      function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
    }],
  },
  {
    name: 'with-system',
    model: 'dmodel',
    messages: [
      { role: 'system', content: '你是一个严谨的助手。' },
      { role: 'user', content: '用一句话解释 COSY 签名。' },
    ],
    tools: [],
  },
];

// 固定参数：tempKey（16 个 ASCII 字符）、requestId、date、RSA 填充字节
const FIXED = Object.freeze({
  tempKeyHex: '0123456789abcdef',
  rsaPaddingHex: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  nowMs: 1_793_983_148_000,
  inferBase: 'https://gateway.qoder.com.cn',
});

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function buildDeterministicRng({ requestId, tempKeyHex, rsaPaddingHex }) {
  const paddingBytes = Buffer.from(rsaPaddingHex, 'hex');
  return {
    hex: (length) => tempKeyHex.slice(0, length),
    uuid: () => requestId,
    bytes: (length) => {
      const repeated = Buffer.concat(Array.from({ length: Math.ceil(length / paddingBytes.length) + 1 }, () => paddingBytes));
      return repeated.subarray(0, length);
    },
  };
}

// Python 侧：固定 uuid / time / os.urandom 后调用参考实现的 CosySession.bearer
const PYTHON_PROGRAM = String.raw`
import sys, json, types, hashlib
refs = sys.argv[1]
sys.path.insert(0, refs)
import qoder_sign as S

payloads = json.loads(sys.stdin.read())
results = []
for case in payloads:
    fixed = case["fixed"]
    pad = bytes.fromhex(fixed["rsaPaddingHex"])
    state = {"i": 0}

    def fake_urandom(n, pad=pad, state=state):
        out = bytearray()
        while len(out) < n:
            out.append(pad[state["i"] % len(pad)])
            state["i"] += 1
        return bytes(out[:n])

    # ① 会话构造期：uuid4().hex 给 tempKey，os.urandom 给 RSA 填充
    S.uuid = types.SimpleNamespace(uuid4=lambda hex_value=fixed["tempKeyHex"]: types.SimpleNamespace(hex=hex_value))
    S.time = types.SimpleNamespace(time=lambda ms=fixed["nowMs"]: ms / 1000.0)
    S.os = types.SimpleNamespace(urandom=fake_urandom)
    session = S.CosySession(uid=case["credential"]["userId"], nickname=case["credential"]["nickname"],
                            access_token=case["credential"]["accessToken"],
                            refresh_token=case["credential"]["refreshToken"])

    # ② 签名期：str(uuid4()) 给 requestId
    class RequestId:
        def __str__(self):
            return fixed["requestId"]
    S.uuid = types.SimpleNamespace(uuid4=lambda rid=RequestId(): rid)
    S.time = types.SimpleNamespace(time=lambda ms=fixed["nowMs"]: ms / 1000.0)

    payload_b64, date, bearer = session.bearer(case["bodyText"], case["url"])
    results.append({
        "name": case["name"],
        "payloadB64": payload_b64,
        "cosyKey": session.cosy_key,
        "info": session.info,
        "date": date,
        "bearer": bearer,
        "tempKeyHex": fixed["tempKeyHex"],
        "bearerSha256": hashlib.sha256(bearer.encode("utf-8")).hexdigest(),
        "payloadSha256": hashlib.sha256(payload_b64.encode("utf-8")).hexdigest(),
        "cosyKeySha256": hashlib.sha256(session.cosy_key.encode("utf-8")).hexdigest(),
    })
print(json.dumps(results, ensure_ascii=False))
`;

function resolveRefsDirectory() {
  const argIndex = process.argv.indexOf('--refs');
  if (argIndex >= 0 && process.argv[argIndex + 1]) return path.resolve(process.argv[argIndex + 1]);
  if (process.env.QODER_REFS) return path.resolve(process.env.QODER_REFS);
  return path.resolve(REPO_ROOT, '..', '_refs', 'qoder2api-hub');
}

async function main() {
  const refsDirectory = resolveRefsDirectory();
  if (!fs.existsSync(path.join(refsDirectory, 'qoder_sign.py'))) {
    console.error(`❌ 找不到参考实现：${refsDirectory}/qoder_sign.py（用 --refs 指定目录）`);
    return 1;
  }

  const preparedCases = CASES.map((testCase, index) => {
    const requestId = `0000000${index + 1}-1111-4222-8333-444444444444`;
    const bodyText = buildInferPayloadText({
      messages: testCase.messages,
      tools: testCase.tools,
      model: testCase.model,
      requestId,
    });
    return {
      name: testCase.name,
      model: testCase.model,
      requestId,
      messages: testCase.messages,
      tools: testCase.tools,
      // 签名覆盖的是**编码后**的 body（真正发出去的那串），明文只用于哈希留证
      bodyText: qoderEncode(Buffer.from(bodyText, 'utf8')),
      bodyPlainText: bodyText,
      url: `${FIXED.inferBase}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`,
    };
  });

  const pythonInput = JSON.stringify(preparedCases.map((testCase) => ({
    name: testCase.name,
    bodyText: testCase.bodyText,
    url: testCase.url,
    credential: FAKE_CREDENTIAL,
    fixed: { ...FIXED, requestId: testCase.requestId },
  })));

  const pythonRun = spawnSync('python3', ['-c', PYTHON_PROGRAM, refsDirectory], {
    input: pythonInput,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (pythonRun.status !== 0) {
    console.error('❌ Python 参考实现运行失败：');
    console.error(pythonRun.stderr || pythonRun.stdout);
    return 1;
  }
  const pythonResults = JSON.parse(pythonRun.stdout);

  const vectors = [];
  for (const [index, preparedCase] of preparedCases.entries()) {
    const reference = pythonResults.find((entry) => entry.name === preparedCase.name);
    const rng = buildDeterministicRng({
      requestId: preparedCase.requestId,
      tempKeyHex: FIXED.tempKeyHex,
      rsaPaddingHex: FIXED.rsaPaddingHex,
    });
    const session = createCosySession({ credential: FAKE_CREDENTIAL, rng });
    const jsBearer = buildCosyBearer({
      session,
      bodyText: preparedCase.bodyText,
      rawUrl: preparedCase.url,
      requestId: preparedCase.requestId,
      nowMs: FIXED.nowMs,
    });

    if (jsBearer.bearer !== reference.bearer) {
      console.error(`❌ 对拍失败（${preparedCase.name}）：JS 与 Python 的 Bearer 不一致`);
      console.error(`   JS     : ${jsBearer.bearer.slice(0, 80)}…`);
      console.error(`   Python : ${reference.bearer.slice(0, 80)}…`);
      return 1;
    }
    // 顺带验证后端入口与手工装配一致（防止测试只测到半条路径）
    const backendResult = await buildEncryptedRequestWithNative({
      credential: FAKE_CREDENTIAL,
      messages: preparedCase.messages,
      tools: preparedCase.tools,
      model: preparedCase.model,
      inferBase: FIXED.inferBase,
      now: () => FIXED.nowMs,
      rng,
    });
    if (backendResult.headers.authorization !== reference.bearer) {
      console.error(`❌ 后端入口与手工签名不一致（${preparedCase.name}）`);
      return 1;
    }

    vectors.push({
      name: preparedCase.name,
      model: preparedCase.model,
      requestId: preparedCase.requestId,
      nowMs: FIXED.nowMs,
      tempKeyHex: FIXED.tempKeyHex,
      rsaPaddingHex: FIXED.rsaPaddingHex,
      inferBase: FIXED.inferBase,
      credential: FAKE_CREDENTIAL,
      messages: preparedCase.messages,
      tools: preparedCase.tools,
      bodySha256: sha256Hex(preparedCase.bodyPlainText),
      bodyEncodedSha256: sha256Hex(preparedCase.bodyText),   // bodyText 在这里已是编码后的串
      payloadSha256: reference.payloadSha256,
      cosyKeySha256: reference.cosyKeySha256,
      bearerSha256: reference.bearerSha256,
      bearerPrefix: reference.bearer.slice(0, 40),
      date: reference.date,
    });
    console.log(`✓ ${preparedCase.name}: Bearer 一致（sha256 ${reference.bearerSha256.slice(0, 16)}…，前缀 ${reference.bearer.slice(0, 40)}）`);
  }

  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify({
    generatedBy: 'scripts/reverse-cosy-vectors.mjs',
    reference: 'qoder2api-hub/qoder_sign.py（MIT）',
    note: '只存哈希与 Bearer 前缀；全部输入为假凭据，不含真实 token',
    vectors,
  }, null, 2)}\n`, 'utf8');
  console.log(`\n已写入 ${path.relative(REPO_ROOT, FIXTURE_PATH)}（${vectors.length} 组向量）`);
  return 0;
}

process.exit(await main());
