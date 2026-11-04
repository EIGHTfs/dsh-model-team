// G-img-tool：工具返回的图片（read_image 的 tool 消息图块）必须能被上游看到。
//
// 为什么单独一组用例：OpenAI 兼容协议**不允许 role:'tool' 的 content 放图**（必须是字符串），
// 所以正确形态是「tool 消息照旧发文本（带一句"附图见下一条消息"）→ 该批结果全部发完后
// 紧跟一条 user 消息承载 image_url」。顺序错了会破坏 assistant(tool_calls) ↔ tool 的配对，
// 上游直接 400——这条约束只有断言消息顺序才能守住。
//
// 输入形状按 DSH 的 read_image 实际返回：tool 消息 content = [ {type:'text'}, {type:'image', attachment} ]。

import test from 'node:test';
import assert from 'node:assert/strict';

import { toOpenAiMessages } from '../src/plugin/adapter-support.js';
import { collectImageRefs } from '../src/plugin/image-prefetch.js';

const ATTACHMENT_A = { attachmentId: 'sha256-aaaa', mediaType: 'image/png', bytes: 68, width: 2, height: 2 };
const ATTACHMENT_B = { attachmentId: 'sha256-bbbb', mediaType: 'image/png', bytes: 68, width: 2, height: 2 };
const DATA_URL_A = 'data:image/png;base64,iVBORw0KGgo=';
const DATA_URL_B = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

function imageUrlsFor(entries) {
  return new Map(Object.entries(entries));
}

// 一条 assistant(tool_calls) + 若干 tool 结果 + 结尾 user：模拟 DSH 的"模型调工具 → 工具回图"
function buildConversation(toolMessages) {
  return [
    { role: 'user', content: [{ type: 'text', text: '读一下这张图' }] },
    {
      role: 'assistant',
      // DSH 的调用声明是 content 里的 tool-call 块（不是顶层 toolCalls 字段）
      content: toolMessages.map((toolMessage) => ({
        type: 'tool-call',
        id: toolMessage.toolCallId,
        name: 'read_image',
        arguments: '{}',
      })),
    },
    ...toolMessages,
  ];
}

test('G-img-tool-①：tool 消息含图 → assistant(tool_calls) → tool(纯文本) → user(含 image_url)', () => {
  const messages = buildConversation([{
    role: 'tool',
    toolCallId: 'c1',
    content: [
      { type: 'text', text: '图片已读取：1920x1080' },
      { type: 'image', attachment: ATTACHMENT_A },
    ],
  }]);

  const converted = toOpenAiMessages(messages, '你是助手', imageUrlsFor({ 'sha256-aaaa': { url: DATA_URL_A } }));

  const toolIndex = converted.findIndex((message) => message.role === 'tool');
  const userImageIndex = converted.findIndex((message) => message.role === 'user'
    && Array.isArray(message.content) && message.content.some((block) => block.type === 'image_url'));

  assert.ok(toolIndex >= 0, '必须有一条 tool 消息');
  assert.equal(userImageIndex, toolIndex + 1, '附图 user 必须紧跟该批 tool 结果');

  const toolMessage = converted[toolIndex];
  assert.equal(typeof toolMessage.content, 'string', 'tool.content 必须是字符串（协议要求）');
  assert.match(toolMessage.content, /图片已读取/, '原文本要保留');
  assert.match(toolMessage.content, /附图见下一条消息/, '要告诉模型图在下一條');
  assert.equal(toolMessage.content.includes('[图片无法发送'), false, 'tool 文本里不能出现占位文本');

  const imageMessage = converted[userImageIndex];
  const imageBlock = imageMessage.content.find((block) => block.type === 'image_url');
  assert.match(imageBlock.image_url.url, /^data:image\/png;base64,/, 'image_url 必须是 data URL');
  assert.equal(imageMessage.content[0].type, 'text', '附图消息先有一句说明再是图');
});

test('G-img-tool-②：一批两个 tool 结果、只有后一个有图 → 附图 user 排在两个 tool 之后', () => {
  const messages = buildConversation([
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '第一批结果' }] },
    {
      role: 'tool',
      toolCallId: 'c2',
      content: [
        { type: 'text', text: '图片已读取' },
        { type: 'image', attachment: ATTACHMENT_B },
      ],
    },
  ]);

  const converted = toOpenAiMessages(messages, '', imageUrlsFor({ 'sha256-bbbb': { url: DATA_URL_B } }));
  const toolIndexes = converted.map((message, index) => (message.role === 'tool' ? index : -1)).filter((index) => index >= 0);
  const userImageIndex = converted.findIndex((message) => message.role === 'user'
    && Array.isArray(message.content) && message.content.some((block) => block.type === 'image_url'));

  assert.equal(toolIndexes.length, 2);
  assert.equal(userImageIndex, toolIndexes[1] + 1, '图必须等两个 tool 都发完');
  assert.ok(userImageIndex > toolIndexes[0] && userImageIndex > toolIndexes[1], '不能让 user 插在两个 tool 之间');
});

test('G-img-tool-③：tool 有图块但取不到图 → 明说未取到，且不生成空 user 消息', () => {
  const messages = buildConversation([{
    role: 'tool',
    toolCallId: 'c1',
    content: [
      { type: 'text', text: '图片已读取' },
      { type: 'image', attachment: ATTACHMENT_A },
    ],
  }]);

  // imageUrls 缺失或记的是 error：两种都要走"未取到"分支
  const withoutUrls = toOpenAiMessages(messages, '', undefined);
  const withError = toOpenAiMessages(messages, '', imageUrlsFor({ 'sha256-aaaa': { error: '图片过大' } }));

  for (const converted of [withoutUrls, withError]) {
    const toolMessage = converted.find((message) => message.role === 'tool');
    assert.match(toolMessage.content, /附图未取到/, '要说清楚没取到');
    assert.equal(toolMessage.content.includes('[图片无法发送'), false, '占位文本不该出现在 tool 文本里');
    const extraUserMessages = converted.filter((message) => message.role === 'user' && Array.isArray(message.content));
    assert.equal(extraUserMessages.length, 0, '取不到图时不许生成空 user 消息');
  }
});

test('G-img-tool-④：纯文本 tool 结果行为不变（仍是紧跟 assistant 的 tool 文本）', () => {
  const messages = buildConversation([{ role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '只有文字' }] }]);

  const converted = toOpenAiMessages(messages, '', undefined);
  const toolMessages = converted.filter((message) => message.role === 'tool');
  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0].content, '只有文字', '纯文本 tool 结果应逐字保留，不加任何后缀');
  assert.equal(converted.some((message) => Array.isArray(message.content) && message.content.some((b) => b.type === 'image_url')), false);
});

test('G-img-tool-⑤：collectImageRefs 也能扫到 tool 消息里的图块（预取不遗漏）', () => {
  const messages = buildConversation([{
    role: 'tool',
    toolCallId: 'c1',
    content: [
      { type: 'text', text: '图片已读取' },
      { type: 'image', attachment: ATTACHMENT_A },
    ],
  }]);

  const refs = collectImageRefs(messages);
  assert.equal(refs.has('sha256-aaaa'), true, 'tool 消息里的图必须进预取清单');
});

// ---------------------------------------------------------------- G-24 边界：多图 / 混排 / 部分取不到

test('G-24-①：同一条 tool 结果两个 image 块 → 同一条附图消息里按原顺序排放', () => {
  const messages = buildConversation([{
    role: 'tool',
    toolCallId: 'c1',
    content: [
      { type: 'text', text: '两张图都读到了' },
      { type: 'image', attachment: ATTACHMENT_A },
      { type: 'image', attachment: ATTACHMENT_B },
    ],
  }]);

  const converted = toOpenAiMessages(messages, '', imageUrlsFor({
    'sha256-aaaa': { url: DATA_URL_A },
    'sha256-bbbb': { url: DATA_URL_B },
  }));

  const toolIndex = converted.findIndex((message) => message.role === 'tool');
  const imageMessages = converted.filter((message) => message.role === 'user'
    && Array.isArray(message.content) && message.content.some((block) => block.type === 'image_url'));
  assert.equal(imageMessages.length, 1, '两张图要合并成一条附图消息，不许拆成两条');
  assert.equal(converted.indexOf(imageMessages[0]), toolIndex + 1, '附图消息紧跟 tool 结果');

  const imageUrlsInOrder = imageMessages[0].content
    .filter((block) => block.type === 'image_url')
    .map((block) => block.image_url.url);
  assert.deepEqual(imageUrlsInOrder, [DATA_URL_A, DATA_URL_B], '多图必须严格保持原有顺序');
  assert.match(converted[toolIndex].content, /附图见下一条消息/);
});

test('G-24-②：用户消息带图 + 工具结果带图混排 → 各自留在自己的位置，互不合并', () => {
  const attachmentC = { attachmentId: 'sha256-cccc', mediaType: 'image/png', bytes: 68, width: 2, height: 2 };
  const dataUrlC = 'data:image/png;base64,AAAA';
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '先看我这张' }, { type: 'image', attachment: attachmentC }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_image', arguments: '{}' }] },
    {
      role: 'tool',
      toolCallId: 'c1',
      content: [{ type: 'text', text: '工具读到的图' }, { type: 'image', attachment: ATTACHMENT_A }],
    },
  ];

  const converted = toOpenAiMessages(messages, '', imageUrlsFor({
    'sha256-aaaa': { url: DATA_URL_A },
    'sha256-cccc': { url: dataUrlC },
  }));

  // 第一条 user 消息自己带图（不进 tool 附图机制）
  const firstUser = converted.find((message) => message.role === 'user');
  const firstUserImages = firstUser.content.filter((block) => block.type === 'image_url').map((block) => block.image_url.url);
  assert.deepEqual(firstUserImages, [dataUrlC], '用户的图留在用户消息里，不被搬到别处');

  // tool 之后仍会追加一条附图消息，且只包含工具的图
  const toolIndex = converted.findIndex((message) => message.role === 'tool');
  const appendedUser = converted[toolIndex + 1];
  assert.equal(appendedUser.role, 'user');
  const appendedImages = appendedUser.content.filter((block) => block.type === 'image_url').map((block) => block.image_url.url);
  assert.deepEqual(appendedImages, [DATA_URL_A], '工具附图消息里不该混进用户的图');
  assert.equal(converted.filter((message) => message.role === 'user').length, 2, '两条 user 消息各司其职');
});

test('G-24-③：Map 里是 {error}（而不是 {url}）→ 该图不进附图消息，只在正文写明未取到', () => {
  const messages = buildConversation([{
    role: 'tool',
    toolCallId: 'c1',
    content: [
      { type: 'text', text: '图读到了但可能拿不到内容' },
      { type: 'image', attachment: ATTACHMENT_A },
    ],
  }]);

  const converted = toOpenAiMessages(messages, '', imageUrlsFor({
    'sha256-aaaa': { error: '图片过大（2000000 字节 > 1048576）' },
  }));

  const toolMessage = converted.find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /附图未取到/, '取不到要说清楚');
  assert.equal(toolMessage.content.includes('附图见下一条消息'), false, '没有附图就不能说"见下一条"');
  assert.equal(toolMessage.content.includes('[图片无法发送'), false, '占位文本不许进 tool 正文');
  assert.equal(converted.some((message) => Array.isArray(message.content)
    && message.content.some((block) => block.type === 'image_url')), false, '一张都没取到就不生成附图消息');
});

test('G-24-④：同一条 tool 结果里一有一无（一个 url、一个 error）→ 只带取到的那张', () => {
  const messages = buildConversation([{
    role: 'tool',
    toolCallId: 'c1',
    content: [
      { type: 'text', text: '两张图' },
      { type: 'image', attachment: ATTACHMENT_A },
      { type: 'image', attachment: ATTACHMENT_B },
    ],
  }]);

  const converted = toOpenAiMessages(messages, '', imageUrlsFor({
    'sha256-aaaa': { url: DATA_URL_A },
    'sha256-bbbb': { error: '读取失败' },
  }));

  const imageMessages = converted.filter((message) => message.role === 'user'
    && Array.isArray(message.content) && message.content.some((block) => block.type === 'image_url'));
  assert.equal(imageMessages.length, 1, '有一张能发就仍要有附图消息');
  const urls = imageMessages[0].content.filter((block) => block.type === 'image_url').map((block) => block.image_url.url);
  assert.deepEqual(urls, [DATA_URL_A], '只带取到的那张，顺序不变');
});

test('G-24-⑤：部分失败时正文必须体现「几张可用」，全成功时不许出现该提示', () => {
  // 一会儿要用两份独立会话：写成工厂，别复用同一份数组
  const buildTwoImages = () => buildConversation([{
    role: 'tool',
    toolCallId: 'c1',
    content: [
      { type: 'text', text: '两张图' },
      { type: 'image', attachment: ATTACHMENT_A },
      { type: 'image', attachment: ATTACHMENT_B },
    ],
  }]);

  // 一条成功、一条失败：模型必须能看出"只送到 1 张"
  const partial = toOpenAiMessages(buildTwoImages(), '', imageUrlsFor({
    'sha256-aaaa': { url: DATA_URL_A },
    'sha256-bbbb': { error: '读取失败' },
  }));
  const partialTool = partial.find((message) => message.role === 'tool');
  assert.match(partialTool.content, /2 张中 1 张可用/, '部分失败要如实告知张数');
  assert.match(partialTool.content, /附图见下一条消息/, '仍要指向附图消息');

  // 两张都成功：不许出现"几张可用"这种噪声
  const full = toOpenAiMessages(buildTwoImages(), '', imageUrlsFor({
    'sha256-aaaa': { url: DATA_URL_A },
    'sha256-bbbb': { url: DATA_URL_B },
  }));
  const fullTool = full.find((message) => message.role === 'tool');
  assert.match(fullTool.content, /（附图见下一条消息）$/, '全成功用简洁提示');
  assert.equal(fullTool.content.includes('张中'), false, '全成功时不该出现张数提示');
});
