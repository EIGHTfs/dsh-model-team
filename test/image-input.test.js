// G15：图片输入。三条链路各自可测：
//   ① 能力申报（resolveModel 的 inputModalities）
//   ② 三态门禁（未加载 / 明确不支持 / 缺附件服务）
//   ③ 预取 → 同步序列化（image_url 块、失败占位、纯文本仍是字符串）

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { buildOpenAiRequestBody, toOpenAiMessages } from '../src/plugin/adapter/support.js';
import { DEFAULT_IMAGE_POLICY, resolveImageUrls } from '../src/plugin/image/prefetch.js';
import { assertImageInputAllowed } from '../src/plugin/image/gate.js';
import { createModelTimAdapter } from '../src/plugin/adapter/adapter.js';
import { writeConfig } from '../src/gateway/config/config.js';
import { createFixedClock } from '../src/gateway/clock.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

class StubAdapter {}
class StubLlmError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const IMAGE_REF = { attachmentId: 'sha256-deadbeef', mediaType: 'image/png', bytes: 68, width: 2, height: 2 };
const IMAGE_BLOCK = { type: 'image', attachment: IMAGE_REF };
const DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

function imageMessage(text) {
  return { role: 'user', content: text === undefined ? [IMAGE_BLOCK] : [{ type: 'text', text }, IMAGE_BLOCK] };
}

test('G15-①：image 块 + Map 有 url → 输出 image_url，且不再出现「内容已省略」', () => {
  const imageUrls = new Map([[IMAGE_REF.attachmentId, { url: DATA_URL }]]);
  const messages = [imageMessage('这张图里是什么')];

  const openAiMessages = toOpenAiMessages(messages, undefined, imageUrls);
  const content = openAiMessages[0].content;

  assert.equal(Array.isArray(content), true, '图文混排时 content 必须是块数组');
  const imageBlock = content.find((block) => block.type === 'image_url');
  assert.deepEqual(imageBlock, { type: 'image_url', image_url: { url: DATA_URL } });
  assert.equal(JSON.stringify(openAiMessages).includes('内容已省略'), false);
});

test('G15-②：image 块但 Map 记 error → 输出占位文本、没有 image_url、不抛错', () => {
  const imageUrls = new Map([[IMAGE_REF.attachmentId, { error: '图片过大（9 字节 > 8）' }]]);
  const openAiMessages = toOpenAiMessages([imageMessage(undefined)], undefined, imageUrls);
  const serialized = JSON.stringify(openAiMessages);

  assert.equal(serialized.includes('image_url'), false);
  assert.match(serialized, /图片无法发送：图片过大/);
});

test('G15-③：纯文本消息 → content 仍是字符串（回归保护）', () => {
  const openAiMessages = toOpenAiMessages([{ role: 'user', content: [{ type: 'text', text: '你好' }] }], '系统提示', new Map());
  assert.equal(openAiMessages[0].role, 'system');
  assert.equal(openAiMessages[1].content, '你好');
  assert.equal(typeof openAiMessages[1].content, 'string');
});

test('G15-④：文字 + 图片混排 → 数组里文本块与图片块都在，顺序不变', () => {
  const imageUrls = new Map([[IMAGE_REF.attachmentId, { url: DATA_URL }]]);
  const openAiMessages = toOpenAiMessages([imageMessage('先看这张')], undefined, imageUrls);
  const content = openAiMessages[0].content;

  assert.deepEqual(content[0], { type: 'text', text: '先看这张' });
  assert.equal(content[1].type, 'image_url');
});

test('G15-⑤：有图但拿不到附件服务 → UNSUPPORTED_CONTENT「图片输入需要附件服务」', () => {
  assert.throws(
    () => assertImageInputAllowed({
      modelId: 'dsh-model-team',
      declaredModalities: ['text', 'image'],
      attachmentsAvailable: false,
      hasImage: true,
      LlmErrorClass: StubLlmError,
    }),
    (error) => error.code === 'UNSUPPORTED_CONTENT' && /图片输入需要附件服务/.test(error.message),
  );
});

test('G15-⑥：resolveModel 在附件服务可用时申报 inputModalities 含 image', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  await writeConfig({ groups: [{ id: 'g', name: 'g', driver: 'openai-compatible', models: { static: [{ id: 'm', contextLength: 128000 }] } }] }, { dataRoot });

  const ModelTimAdapter = createModelTimAdapter({
    BaseAdapter: StubAdapter,
    LlmErrorClass: StubLlmError,
    deps: {
      dataRoot,
      logger,
      clock: createFixedClock(),
      getAttachmentsService: () => ({ readImageRequest: async () => null }),
    },
  });
  const adapter = new ModelTimAdapter();
  const resolved = await adapter.resolveModel('dsh-model-team', 'dsh-model-team');

  assert.deepEqual(resolved.inputModalities, ['text', 'image']);
  assert.equal(Array.isArray(resolved.inputModalities), true);
});

test('G15-⑦：能力列表未加载（undefined）→ INVALID_REQUEST，文案是「尚未加载」而不是「不支持」', () => {
  assert.throws(
    () => assertImageInputAllowed({
      modelId: 'dsh-model-team',
      declaredModalities: undefined,
      attachmentsAvailable: true,
      hasImage: true,
      LlmErrorClass: StubLlmError,
    }),
    (error) => error.code === 'INVALID_REQUEST'
      && /尚未加载/.test(error.message)
      && /不支持/.test(error.message) === false,
  );
});

test('G15-⑧：模型明确不含 image → UNSUPPORTED_CONTENT', () => {
  assert.throws(
    () => assertImageInputAllowed({
      modelId: 'dsh-model-team',
      declaredModalities: ['text'],
      attachmentsAvailable: true,
      hasImage: true,
      LlmErrorClass: StubLlmError,
    }),
    (error) => error.code === 'UNSUPPORTED_CONTENT' && /不支持图片输入/.test(error.message),
  );
});

test('G15-⑨：图片全部读取失败 → 仍返回 Map（不是 undefined），序列化产出占位文本', async () => {
  const attachments = {
    readImageRequest: async () => { throw new Error('boom'); },
    readImage: async () => { throw new Error('boom'); },
  };
  const logger = createRecordingLogger();

  const urls = await resolveImageUrls([imageMessage(undefined)], { attachments, logger });

  assert.equal(urls instanceof Map, true, '必须保留 Map 形态：undefined 会让模型以为"本来就没有图"');
  assert.equal(urls.size, 1, '失败也要留下记录，序列化才有依据产出占位');
  assert.equal([...urls.values()].every((entry) => !entry.url), true);

  const openAiMessages = toOpenAiMessages([imageMessage(undefined)], undefined, urls);
  const serialized = JSON.stringify(openAiMessages);
  assert.equal(serialized.includes('image_url'), false);
  assert.match(serialized, /图片无法发送：/);
});

test('G15-补：请求体里 messages 带 image_url（buildOpenAiRequestBody 透传映射）', () => {
  const imageUrls = new Map([[IMAGE_REF.attachmentId, { url: DATA_URL }]]);
  const requestBody = buildOpenAiRequestBody({ messages: [imageMessage('看图')], system: 'sys' }, 'target-model', imageUrls);
  const serialized = JSON.stringify(requestBody);

  assert.equal(requestBody.model, 'target-model');
  assert.match(serialized, /"type":"image_url"/);
  assert.match(serialized, new RegExp(`"url":"${DATA_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.equal(DEFAULT_IMAGE_POLICY.maxBytes > 0, true);
});
