// G1：消息排序契约（docs/24 B10）。当前实现按"当天毫秒偏移"排序，跨日必错——
// 本文件是门禁：它现在应当是**红**的，修好排序后才会绿（R4：门禁必须先对已知缺陷变红）。
//
// 为什么默认 skip：这个缺陷是"用户决定先不修"的已知项，让它把 `gate-all` 的 test 门禁
// 一直拖红会掩盖**新增**回归。门禁本身不消失——显式带开关跑就是红的：
//   MESSAGES_SORT_CONTRACT=1 node --test test/messages-sort-contract.test.js
const RUN_KNOWN_DEFECT_CONTRACT = process.env.MESSAGES_SORT_CONTRACT === '1';
const contractTest = RUN_KNOWN_DEFECT_CONTRACT ? test : test.skip;
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const MESSAGES_SOURCE = await fs.readFile(new URL('../ui/js/view/messages.js', import.meta.url), 'utf8');

function loadMessages() {
  return new Function(`${MESSAGES_SOURCE}
;return { buildMessages, messageSortValue };`)();
}

const { buildMessages } = loadMessages();

/** 抽出「这一条是哪个模型/time」便于断言 */
const labels = (messages) => messages.map((message) => (message.row ? `${message.time}|${message.row.model}` : `${message.time}|${message.type}`));

contractTest('① 同日内按时间升序（基础）', () => {
  const rows = [
    { time: '10:00:01', status: 200, model: 'first' },
    { time: '10:00:05', status: 200, model: 'second' },
    { time: '10:00:09', status: 200, model: 'third' },
  ];
  assert.deepEqual(labels(buildMessages('g', rows, [])), [
    '10:00:01|first',
    '10:00:05|second',
    '10:00:09|third',
  ]);
});

contractTest('② 跨午夜：昨天 23:50 的行必须排在今天 00:11 之前', () => {
  const yesterdayLate = { time: '23:50:00', at: '2026-11-09T23:50:00+08:00', status: 200, model: 'yesterday-late' };
  const todayEarly = { time: '00:11:00', at: '2026-11-10T00:11:00+08:00', status: 200, model: 'today-early' };

  const ordered = labels(buildMessages('g', [todayEarly, yesterdayLate], []));
  assert.deepEqual(ordered, ['23:50:00|yesterday-late', '00:11:00|today-early'], '今天 00:11 必须排在昨天 23:50 之后');
});

contractTest('③ 绝对时间优先：只给 startedAtMs（没有 time/at）时也必须能排序', () => {
  // 请求行记录的是绝对时刻（startedAtMs）。只要它存在，就必须参与比较——
  // 否则两条都会退化成"没有时间"，顺序变成后端顺序而非时间顺序。
  const yesterday = { startedAtMs: Date.parse('2026-11-09T23:50:00+08:00'), status: 200, model: 'yesterday' };
  const today = { startedAtMs: Date.parse('2026-11-10T00:11:00+08:00'), status: 200, model: 'today' };

  const { messageSortValue } = loadMessages();
  assert.equal(messageSortValue(today) > messageSortValue(yesterday), true, '绝对时间必须参与排序键');

  const ordered = buildMessages('g', [today, yesterday], []).map((message) => message.row.model);
  assert.deepEqual(ordered, ['yesterday', 'today'], '按绝对时间升序');
});

contractTest('④ 同秒稳定：同一秒多条保持后端返回顺序（不互换）', () => {
  const rows = [
    { time: '10:00:01', status: 200, model: 'a' },
    { time: '10:00:01', status: 200, model: 'b' },
    { time: '10:00:01', status: 200, model: 'c' },
  ];
  assert.deepEqual(labels(buildMessages('g', rows, [])), ['10:00:01|a', '10:00:01|b', '10:00:01|c']);
});

contractTest('⑤ 没有时间字段的条目排最后，不参与比较', () => {
  const rows = [
    { status: 200, model: 'no-time' },
    { time: '10:00:05', status: 200, model: 'has-time' },
  ];
  assert.deepEqual(labels(buildMessages('g', rows, [])), ['10:00:05|has-time', '|no-time']);
});
