// G-24 附加：单张图取不到时必须留下可排查的 debug 记录（哪张、为什么）。
//
// 为什么单测：这条日志只在"图发不出去"时出现，而图发不出去的表现是占位文本——
// 不记录的话，线上只能看到「2 张中 1 张可用」，看不出是哪张、什么原因。
// 同时要守住两点：正常成功不许刷日志；logger 是可选的，没有它也不能抛错。

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveImageUrls } from '../src/plugin/image/prefetch.js';

const REF = { attachmentId: 'sha256-debug', mediaType: 'image/png', bytes: 4096, width: 8, height: 8 };
const MESSAGES = [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', attachment: REF }] }];

function createLoggerRecorder() {
  const records = { debug: [], warn: [] };
  return {
    records,
    logger: {
      debug: (...args) => records.debug.push(args),
      warn: (...args) => records.warn.push(args),
    },
  };
}

test('G-24-debug-①：单张读取失败 → logger.debug 调一次，参数含 attachmentId 与原因', async () => {
  const { records, logger } = createLoggerRecorder();
  const attachments = {
    readImageRequest: async () => { throw new Error('生成请求版本失败'); },
    readImage: async () => { throw new Error('原图也读不到'); },
  };

  const urls = await resolveImageUrls(MESSAGES, { attachments, logger });

  assert.equal(urls.get('sha256-debug').error, '读取失败', 'Map 里仍保留 {error}，供序列化产出占位');
  assert.equal(records.debug.length, 1, '一张失败只打一条 debug');
  const [message, details] = records.debug[0];
  assert.match(String(message), /sha256-debug/, '日志里必须带 attachmentId');
  assert.equal(details.attachmentId, 'sha256-debug');
  assert.equal(details.reason, '原图也读不到', '要能看出真实失败原因');
  assert.equal(details.mediaType, 'image/png');
  assert.equal(details.bytes, 4096);
});

test('G-24-debug-②：图片过大 → 也记 debug（原因写清字节/上限），Map 仍是 error', async () => {
  const { records, logger } = createLoggerRecorder();
  const attachments = {
    readImageRequest: async () => ({ data: new Uint8Array(8), mediaType: 'image/png', bytes: 2 * 1024 * 1024 }),
    readImage: async () => null,
  };

  const urls = await resolveImageUrls(MESSAGES, { attachments, logger });

  assert.match(urls.get('sha256-debug').error, /图片过大/);
  assert.equal(records.debug.length, 1);
  assert.match(String(records.debug[0][1].reason), /图片过大/);
});

test('G-24-debug-③：成功取到图 → 不记 debug（正常路径不该刷日志）', async () => {
  const { records, logger } = createLoggerRecorder();
  const attachments = {
    readImageRequest: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', bytes: 3 }),
    readImage: async () => null,
  };

  const urls = await resolveImageUrls(MESSAGES, { attachments, logger });

  assert.match(urls.get('sha256-debug').url, /^data:image\/png;base64,/);
  assert.equal(records.debug.length, 0, '成功时不记 debug');
});

test('G-24-debug-④：没有 logger 时不抛错（logger 是可选依赖）', async () => {
  const attachments = {
    readImageRequest: async () => { throw new Error('x'); },
    readImage: async () => { throw new Error('y'); },
  };

  const urls = await resolveImageUrls(MESSAGES, { attachments });   // 不传 logger
  assert.equal(urls.get('sha256-debug').error, '读取失败');
});
