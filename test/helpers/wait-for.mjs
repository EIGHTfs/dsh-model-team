// 测试专用「等状态」工具：**超时 = 失败**，绝不"超时后继续"。
//
// 为什么需要它：用固定 sleep 等异步收敛，慢机器上会偶发红、快机器上又看不出问题，
// 而且失败信息只有"等了 400ms"——不知道当前到底是什么状态。这里改成：
//   轮询 predicate 直到为真 → 通过；到时限仍不为真 → 抛错，且错误里带**当前状态快照**。
//
// 用法：
//   await waitFor(() => upstreamClosed, { describe: '上游连接已关闭' });
//   await waitFor(async () => (await readRows()).length === 1, {
//     describe: '请求行已落库',
//     snapshot: async () => ({ rows: await readRows() }),   // 也可挂在 predicate.snapshot 上
//   });

export const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
export const DEFAULT_WAIT_INTERVAL_MS = 10;

function sleep(milliseconds) {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

// 快照：优先 snapshot 选项，其次 predicate.snapshot()，再次 describe 传函数；都没有就明说"没给快照"
async function readStateSnapshot(predicate, describe, snapshot) {
  try {
    if (typeof snapshot === 'function') return JSON.stringify(await snapshot());
    if (typeof predicate?.snapshot === 'function') return JSON.stringify(await predicate.snapshot());
    if (typeof describe === 'function') return JSON.stringify(await describe());
  } catch (snapshotError) {
    return `（快照读取失败：${snapshotError?.message ?? snapshotError}）`;
  }
  return '（未提供快照：给 waitFor 传 describe 函数或 predicate.snapshot）';
}

// 轮询直到条件为真；超时抛错（测试探针语义：事件不来就是要红）
export async function waitFor(predicate, {
  timeoutMs = Number(process.env.DMT_WAIT_TIMEOUT_MS) || DEFAULT_WAIT_TIMEOUT_MS,
  intervalMs = DEFAULT_WAIT_INTERVAL_MS,
  describe = '条件',
  snapshot,
} = {}) {
  if (typeof predicate !== 'function') {
    throw new TypeError('waitFor 需要一个返回真/假（或 Promise）的 predicate 函数');
  }
  const startedAtMs = Date.now();
  const descriptionText = typeof describe === 'string' ? describe : '条件';

  for (;;) {
    if (await predicate()) return;
    if (Date.now() - startedAtMs >= timeoutMs) {
      const stateSnapshot = await readStateSnapshot(predicate, describe, snapshot);
      throw new Error(`等待「${descriptionText}」超时（${timeoutMs}ms）：当前状态 = ${stateSnapshot}`);
    }
    await sleep(intervalMs);
  }
}
