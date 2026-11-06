// wait-for 工具用例：它自己必须先被证明"事件不来就会红，且红的时候说清楚现在是什么状态"。
import test from 'node:test';
import assert from 'node:assert/strict';

import { waitFor } from './helpers/wait-for.mjs';

test('waitFor：条件在若干次轮询后成立 → 返回（不抛）', async () => {
  let pollCount = 0;
  await waitFor(() => {
    pollCount += 1;
    return pollCount >= 3;
  }, { describe: '第三次轮询返回真', intervalMs: 1 });

  assert.equal(pollCount >= 3, true);
});

test('waitFor：条件永远不成立 → 抛错，且错误里带当前状态快照（不是只报超时）', async () => {
  let observedState = 'still-waiting';
  const neverTrue = () => false;
  neverTrue.snapshot = () => ({ observedState, pendingRows: 0 });

  await assert.rejects(
    () => waitFor(neverTrue, { describe: '一个永远不会到来的事件', timeoutMs: 60, intervalMs: 5 }),
    (error) => {
      assert.equal(error.message.includes('一个永远不会到来的事件'), true, '要写清等的是什么');
      assert.equal(error.message.includes('当前状态'), true, '必须有状态快照');
      assert.equal(error.message.includes('still-waiting'), true, '快照要包含真实状态值');
      return true;
    },
  );
});

test('waitFor：describe 传函数时也当快照用（predicate 上没挂 snapshot 的写法）', async () => {
  await assert.rejects(
    () => waitFor(() => false, {
      timeoutMs: 40,
      intervalMs: 5,
      describe: () => ({ 上游已关闭: false, 已落库行数: 0 }),
    }),
    (error) => {
      assert.equal(error.message.includes('上游已关闭'), true);
      assert.equal(error.message.includes('已落库行数'), true);
      return true;
    },
  );
});

test('waitFor：snapshot 选项（调用点最常用的写法）优先于其它快照来源', async () => {
  await assert.rejects(
    () => waitFor(() => false, {
      timeoutMs: 40,
      intervalMs: 5,
      describe: '上游连接已关闭',
      snapshot: () => ({ upstreamClosedAtAll: false, pendingRows: 0 }),
    }),
    (error) => {
      assert.equal(error.message.includes('upstreamClosedAtAll'), true);
      assert.equal(error.message.includes('false'), true);
      return true;
    },
  );
});

test('waitFor：支持异步 predicate（读接口/读文件这类状态）', async () => {
  let rows = 0;
  setTimeout(() => { rows = 1; }, 5);
  await waitFor(async () => rows === 1, { describe: '异步读到的行数', intervalMs: 2 });
  assert.equal(rows, 1);
});
