// 消息顺序：同一份后端数据反复构建必须完全一致（无重复、无乱序），
// 同秒多条保持后端行顺序，SSE 到达的新行按时间插到正确位置（靠整体重载而不是 unshift）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const MESSAGES_SOURCE = await fs.readFile(new URL('../ui/js/view/messages.js', import.meta.url), 'utf8');
const UI_FORMAT_SOURCE = await fs.readFile(new URL('../ui/js/format/ui-format.js', import.meta.url), 'utf8');

function loadMessages() {
  return new Function(`${UI_FORMAT_SOURCE}
${MESSAGES_SOURCE}
;return { buildMessages };`)();
}

const ROWS = [
  { time: '10:00:01', status: 200, statusText: '成功', model: 'agnes-3.0-flash', latency: '1.2s' },
  { time: '10:00:01', status: 200, statusText: '成功', model: 'agnes-2.5-flash', latency: '0.9s' },
  { time: '10:00:03', status: 402, statusText: '额度不足', model: 'qfmodel', latency: '0.3s' },
];
const EVENTS = [{ type: 'sys', time: '10:00:02', text: '已切换路由至 agnes-2.5-flash' }];

function signature(messages) {
  return messages.map((message) => `${message.type}|${message.time}|${message.row ? message.row.model : message.text}`);
}

test('同一份数据反复构建：序列完全一致（进 3 次页面不会变）', () => {
  const { buildMessages } = loadMessages();
  const first = signature(buildMessages('agnes', ROWS, EVENTS));
  const second = signature(buildMessages('agnes', ROWS, EVENTS));
  const third = signature(buildMessages('agnes', ROWS, EVENTS));

  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.equal(first.length, 4, '3 条请求行 + 1 条系统提示');
});

test('同一秒多条：保持后端行顺序，不被重排', () => {
  const { buildMessages } = loadMessages();
  const messages = buildMessages('agnes', ROWS, []);
  const sameSecond = messages.filter((message) => message.time === '10:00:01').map((message) => message.row.model);
  assert.deepEqual(sameSecond, ['agnes-3.0-flash', 'agnes-2.5-flash'], '同秒按后端行顺序稳定排列');
});

test('新行按时间插入正确位置（不是无脑追加到末尾）', () => {
  const { buildMessages } = loadMessages();
  const before = signature(buildMessages('agnes', ROWS, EVENTS));
  const newRow = { time: '10:00:02', status: 200, statusText: '成功', model: 'agnes-3.0-pro', latency: '2.0s' };
  const after = signature(buildMessages('agnes', [...ROWS, newRow], EVENTS));

  assert.equal(after.length, before.length + 1);
  assert.equal(after[after.length - 1].includes('qfmodel'), true, '最后一条仍是最晚的 10:00:03');
  assert.equal(after.indexOf('row|10:00:02|agnes-3.0-pro') > 0, true, '10:00:02 的新行落在同秒系统提示附近，而不是末位');
});
