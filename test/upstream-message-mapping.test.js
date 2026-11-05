// G-16 消息映射回归：tool_calls / tool_call_id / developer→system
//
// 背景：旧实现只保留 role+content，助手消息的 tool-call 块被转成占位文本、tool 消息丢了
// 配对 id——上游看到「没有调用声明的工具结果」→ tool_call_mismatch（真机必现）。
// 本文件锁死契约 docs/02 §六「消息映射·工具 / 消息映射·role」的三条铁律。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toOpenAiMessages, toOpenAiToolCalls } from '../src/plugin/adapter/support.js';

test('工具链路：助手 tool-call 声明 + tool 结果配对（G-16 主场景）', () => {
  const messages = toOpenAiMessages([
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"p":"a"}' }],
    },
    {
      role: 'tool',
      toolCallId: 'c1',
      content: [{ type: 'text', text: 'ok' }],
    },
  ]);
  const assistant = messages.find((message) => message.role === 'assistant');
  assert.ok(assistant.tool_calls, 'assistant 必须带 tool_calls');
  assert.equal(assistant.tool_calls.length, 1);
  assert.equal(assistant.tool_calls[0].id, 'c1');
  assert.equal(assistant.tool_calls[0].type, 'function');
  assert.equal(assistant.tool_calls[0].function.name, 'read_file');
  assert.equal(assistant.tool_calls[0].function.arguments, '{"p":"a"}');
  assert.equal(assistant.content, null, '纯工具调用的正文应为 null，不是空串或占位文本');

  const tool = messages.find((message) => message.role === 'tool');
  assert.equal(tool.tool_call_id, 'c1', 'tool 消息必须带 tool_call_id');
  assert.equal(tool.content, 'ok');
});

test('助手消息文本 + 工具调用并存：文本保留、tool_calls 在、正文无占位', () => {
  const messages = toOpenAiMessages([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我先读一下文件。' },
        { type: 'tool-call', id: 'c2', name: 'read_file', arguments: '{"p":"b"}' },
      ],
    },
    { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'done' }] },
  ]);
  const assistant = messages[0];
  assert.equal(assistant.content, '我先读一下文件。', '文本部分原样保留');
  assert.ok(!assistant.content.includes('[tool-call'), '正文不得出现 tool-call 占位文本');
  assert.equal(assistant.tool_calls[0].id, 'c2');
  assert.equal(assistant.tool_calls[0].function.name, 'read_file');
});

test('多个 tool-call：顺序与 id 一一对应，arguments 非字符串兜底 {}', () => {
  const messages = toOpenAiMessages([
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', id: 'c3', name: 'first_tool', arguments: '{"a":1}' },
        { type: 'tool-call', id: 'c4', name: 'second_tool', arguments: '' },
        { type: 'tool-call', id: 'c5', name: 'third_tool', arguments: 123 },
      ],
    },
    { role: 'tool', toolCallId: 'c3', content: [{ type: 'text', text: '1' }] },
    { role: 'tool', toolCallId: 'c4', content: [{ type: 'text', text: '2' }] },
    { role: 'tool', toolCallId: 'c5', content: [{ type: 'text', text: '3' }] },
  ]);
  const toolCalls = messages[0].tool_calls;
  assert.deepEqual(toolCalls.map((call) => call.id), ['c3', 'c4', 'c5']);
  assert.equal(toolCalls[0].function.arguments, '{"a":1}');
  assert.equal(toolCalls[1].function.arguments, '{}', '空串 arguments 兜底为 {}');
  assert.equal(toolCalls[2].function.arguments, '{}', '非字符串 arguments 兜底为 {}');
});

test('developer → system（OpenAI 兼容接口只认 system/user/assistant/tool）', () => {
  const messages = toOpenAiMessages([{ role: 'developer', content: '项目约定' }]);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, '项目约定');
});

test('普通消息不带 tool_calls 字段（不能凭空加）', () => {
  const messages = toOpenAiMessages([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'text', text: '回复' }] },
  ]);
  for (const message of messages) {
    assert.ok(!('tool_calls' in message), `${message.role} 不应携带 tool_calls`);
  }
});

test('tool 消息 isError：正文前加失败标注但仍为文本', () => {
  const messages = toOpenAiMessages([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c9', name: 'boom_tool', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'c9', isError: true, content: [{ type: 'text', text: 'boom' }] },
  ]);
  const toolMsg = messages.find((message) => message.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 'c9');
  assert.ok(toolMsg.content.includes('boom'));
  assert.ok(typeof toolMsg.content === 'string');
});

test('toOpenAiToolCalls：无工具块返回 undefined（不产出空数组）', () => {
  assert.equal(toOpenAiToolCalls({ content: [{ type: 'text', text: 'x' }] }), undefined);
  assert.equal(toOpenAiToolCalls({ content: 'plain' }), undefined);
  assert.equal(toOpenAiToolCalls(null), undefined);
});

// ===== 以下五条对应契约 §六 参考实现补充的四条硬约束 =====

test('孤儿工具结果（有 result 无 call）→ 该条被丢弃', () => {
  const messages = toOpenAiMessages([
    { role: 'assistant', content: [{ type: 'text', text: '我不调工具' }] },
    { role: 'tool', toolCallId: 'orphan-1', content: [{ type: 'text', text: '孤儿结果' }] },
  ]);
  assert.ok(!messages.some((message) => message.role === 'tool'), '孤儿结果不应出现在输出');
});

test('调用 name 为空 → 该调用剔除、同批其他调用保留、其结果也剔除', () => {
  const messages = toOpenAiMessages([
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', id: 'bad', name: '', arguments: '{}' },
        { type: 'tool-call', id: 'good', name: 'read_file', arguments: '{"p":"x"}' },
      ],
    },
    { role: 'tool', toolCallId: 'bad', content: [{ type: 'text', text: 'bad' }] },
    { role: 'tool', toolCallId: 'good', content: [{ type: 'text', text: 'good' }] },
  ]);
  const assistant = messages.find((message) => message.role === 'assistant');
  assert.deepEqual(assistant.tool_calls.map((call) => call.id), ['good'], '空名调用被剔、其余保留');
  const toolIds = messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id);
  assert.deepEqual(toolIds, ['good'], '空名调用的结果也必须剔除（否则孤儿）');
});

test('顺序约束：assistant(tool_calls) 与 tool 结果之间的 developer → system 延后到 tool 之后', () => {
  const messages = toOpenAiMessages([
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c10', name: 'read_file', arguments: '{}' }],
    },
    { role: 'developer', content: '中途约定' },
    { role: 'tool', toolCallId: 'c10', content: [{ type: 'text', text: 'ok' }] },
  ]);
  const roles = messages.map((message) => message.role);
  const assistantIndex = roles.indexOf('assistant');
  const toolIndex = roles.indexOf('tool');
  assert.equal(roles[toolIndex - 1], 'assistant', 'tool 必须紧跟 assistant（中间不能插 system）');
  const systemAfterTool = roles.findIndex((role, index) => role === 'system' && index > assistantIndex);
  assert.ok(systemAfterTool > toolIndex, 'developer 映射的 system 必须在 tool 之后');
});

test('工具结果正文为空 → 输出 (no output) 占位', () => {
  const messages = toOpenAiMessages([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c11', name: 'run', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'c11', content: [] },
  ]);
  const tool = messages.find((message) => message.role === 'tool');
  assert.equal(tool.content, '(no output)');
});

test('普通纯文本消息 content 必须是字符串（不得包装成块数组）', () => {
  const messages = toOpenAiMessages([
    { role: 'user', content: '纯文本' },
    { role: 'assistant', content: [{ type: 'text', text: '回复' }] },
  ]);
  for (const message of messages) {
    assert.equal(typeof message.content, 'string', `${message.role} 的 content 必须是字符串`);
  }
});

// ===== G-17：tool-call.arguments 必须是原始 JSON 字符串（对象 → token 估算 NaN → 会话打不开）=====

test('G-17：finish() 产出的 tool-call.arguments 是字符串，且字节透传', async () => {
  const { StreamChunkBuilder } = await import('../src/plugin/adapter/llm-protocol.js');
  const runStream = (argumentText) => {
    const builder = new StreamChunkBuilder();
    builder.appendToolCallDelta({ index: 0, id: 'tc1', function: { name: 'read_file' } });
    if (argumentText !== undefined) builder.appendToolCallDelta({ index: 0, function: { arguments: argumentText } });
    return builder.finish({}).find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call');
  };

  // 保留键顺序与空格——parse→stringify 会规范化两者，字节一致才证明原样透传
  const raw = '{"b":2, "a": 1}';
  const blockEnd = runStream(raw);
  assert.ok(blockEnd, 'finish 应产出 tool-call 的 block-end');
  assert.equal(typeof blockEnd.block.arguments, 'string', 'arguments 必须是字符串（对象 → token 估算 NaN → 会话打不开）');
  assert.equal(blockEnd.block.arguments, raw, '必须字节一致');

  assert.equal(runStream(undefined)?.block?.arguments, '{}', '无 arguments 文本 → {}');
  assert.equal(runStream('')?.block?.arguments, '{}', '空串 → {}');
  assert.equal(runStream('   ')?.block?.arguments, '{}', '纯空白 → {}');
  const truncated = '{"path":"a.txt","optio';
  assert.equal(runStream(truncated)?.block?.arguments, truncated, '截断的非法 JSON 原样返回，不抛错');
});

// ===== G-17b（对话污染）：reasoning 块绝不能变成正文占位 =====

test('G-17b：assistant 的 reasoning 块 → 正文不含 reasoning、不含占位文本', () => {
  const messages = toOpenAiMessages([
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '内部思考过程' },
        { type: 'text', text: '最终回答' },
      ],
    },
  ]);
  const assistant = messages[0];
  assert.ok(!assistant.content.includes('reasoning'), 'reasoning 字样不得出现在正文');
  assert.ok(!assistant.content.includes('内容已省略'), '占位文本不得出现在正文');
  assert.ok(assistant.content.includes('最终回答'), '正文文本原样保留');
});

test('G-17b：纯 reasoning 的 assistant → 正文为空串（不产生占位文本）', () => {
  const messages = toOpenAiMessages([
    { role: 'assistant', content: [{ type: 'reasoning', text: '只想不说' }] },
  ]);
  assert.equal(messages[0].content, '', 'reasoning 静默丢弃后正文为空串，绝不能是占位文本');
});

test('G-17b：image 块仍产出占位文本（占位白名单行为不回退）', () => {
  const messages = toOpenAiMessages([
    { role: 'user', content: [{ type: 'image', data: 'xx' }] },
  ]);
  assert.ok(messages[0].content.includes('[image 内容已省略]'), 'image 占位文本必须保留');
});
