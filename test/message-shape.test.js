// G3：消息形状探测与归一化用例。
// 核心回归：legacy（≤0.1.6 的包裹式工具结果）下，工具调用绝不能被整体剔除 ——
// 那会让上游看到「凭空出现的工具输出」，模型表现为提前判定对话结束或循环思考。

import test from 'node:test';
import assert from 'node:assert/strict';

import { detectMessageShape, normalizeHarnessMessages } from '../src/plugin/adapter/message-shape.js';
import { toOpenAiMessages } from '../src/plugin/adapter/support.js';

// 助手侧两条工具调用（name 非空，才会进 tool_calls[]）
const ASSISTANT_WITH_CALLS = {
  role: 'assistant',
  content: [
    { type: 'text', text: '我来查两件事' },
    { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
    { type: 'tool-call', id: 'call_2', name: 'list_dir', arguments: '{"path":"."}' },
  ],
};

// ≤0.1.6：工具结果包在 user 消息的 content 里
const LEGACY_USER_WITH_RESULTS = {
  role: 'user',
  content: [
    { type: 'tool-result', toolCallId: 'call_1', content: 'a.txt 内容' },
    { type: 'tool-result', toolCallId: 'call_2', content: '目录列表', isError: false },
  ],
};

// 0.1.7+：一等 tool 消息，toolCallId/isError 在顶层
const TOOL_ROLE_MESSAGES = [
  { role: 'tool', toolCallId: 'call_1', content: 'a.txt 内容' },
  { role: 'tool', toolCallId: 'call_2', content: '目录列表', isError: false },
];

test('G3-①：legacy 形状（user 内嵌两个 tool-result）→ tool_calls 与 tool_call_id 都齐全，不许整体剔除', () => {
  const messages = [ASSISTANT_WITH_CALLS, LEGACY_USER_WITH_RESULTS];
  assert.equal(detectMessageShape(messages), 'legacy');

  const openAiMessages = toOpenAiMessages(messages, undefined);

  const assistantEntry = openAiMessages.find((entry) => entry.role === 'assistant');
  assert.ok(assistantEntry, '助手消息必须还在');
  assert.deepEqual(
    (assistantEntry.tool_calls ?? []).map((toolCall) => toolCall.id),
    ['call_1', 'call_2'],
    '两条调用都必须保留（历史事故：结果 id 集合为空导致调用被整体剔除）',
  );

  const toolEntries = openAiMessages.filter((entry) => entry.role === 'tool');
  assert.deepEqual(toolEntries.map((entry) => entry.tool_call_id), ['call_1', 'call_2']);
  assert.equal(toolEntries[0].content, 'a.txt 内容');
  // 顺序硬约束：tool 必须紧跟带 tool_calls 的 assistant
  assert.equal(openAiMessages[openAiMessages.indexOf(assistantEntry) + 1].role, 'tool');
});

test('G3-②：tool-role 形状（0.1.7+ 现状）→ 输出与改动前逐字节一致', () => {
  const messages = [ASSISTANT_WITH_CALLS, ...TOOL_ROLE_MESSAGES];
  assert.equal(detectMessageShape(messages), 'tool-role');

  const openAiMessages = toOpenAiMessages(messages, 'system prompt');

  assert.deepEqual(openAiMessages, [
    { role: 'system', content: 'system prompt' },
    {
      role: 'assistant',
      content: '我来查两件事',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'call_2', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'a.txt 内容' },
    { role: 'tool', tool_call_id: 'call_2', content: '目录列表' },
  ]);
});

test('G3-③：混合形状（一段历史里两种都有）→ 仍能正确配对', () => {
  const messages = [
    ASSISTANT_WITH_CALLS,
    LEGACY_USER_WITH_RESULTS,
    { role: 'assistant', content: [{ type: 'text', text: '继续' }] },
    { role: 'user', content: '谢谢' },
  ];
  // 混合形态判 tool-role（新版角色是权威判据）
  assert.equal(detectMessageShape([...messages, ...TOOL_ROLE_MESSAGES]), 'tool-role');

  const openAiMessages = toOpenAiMessages(messages, undefined);
  const toolEntries = openAiMessages.filter((entry) => entry.role === 'tool');
  assert.deepEqual(toolEntries.map((entry) => entry.tool_call_id), ['call_1', 'call_2']);
  assert.deepEqual(
    openAiMessages.find((entry) => entry.role === 'assistant').tool_calls.map((toolCall) => toolCall.id),
    ['call_1', 'call_2'],
  );
});

test('G3-④：整段历史没有工具结果 → 探测 none，输出不带 tool_calls', () => {
  const messages = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: [{ type: 'text', text: '你好，有什么可以帮你' }] },
  ];
  assert.equal(detectMessageShape(messages), 'none');

  const openAiMessages = toOpenAiMessages(messages, undefined);
  assert.equal(openAiMessages.some((entry) => entry.tool_calls !== undefined), false);
  assert.deepEqual(openAiMessages, [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好，有什么可以帮你' },
  ]);
});

test('G3 归一化：legacy 块升成 tool 消息，剩余正文保留在同一条 user 消息里', () => {
  const normalized = normalizeHarnessMessages([
    { role: 'user', content: [{ type: 'text', text: '看下这两处' }, { type: 'tool-result', toolCallId: 'call_1', content: '结果' }] },
  ]);
  assert.deepEqual(normalized, [
    { role: 'tool', toolCallId: 'call_1', content: '结果' },
    { role: 'user', content: [{ type: 'text', text: '看下这两处' }] },
  ]);
});

test('G3 归一化：新形状输入原样返回同一引用（零开销、不影响 0.1.7+ 行为）', () => {
  const messages = [ASSISTANT_WITH_CALLS, ...TOOL_ROLE_MESSAGES];
  assert.equal(normalizeHarnessMessages(messages), messages);
});

test('G3 归一化：legacy 块里的 isError 只在存在时携带', () => {
  const [withError] = normalizeHarnessMessages([{ role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: 'x', isError: true }] }]);
  const [withoutError] = normalizeHarnessMessages([{ role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: 'y' }] }]);
  assert.equal(withError.isError, true);
  assert.equal('isError' in withoutError, false);
});
