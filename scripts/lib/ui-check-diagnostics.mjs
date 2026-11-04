// ui-check-diagnostics.mjs —— 场景失败时的现场诊断（只读客户端已有状态，不新增任何导出）。
//
// 为什么要它：门禁里有一类断言依赖**真实网络往返**（例如面板的 #fpTotal 要等
// GET /_team/stats/global）。重负载下这次往返可能超时，而"超时"有两种完全不同的原因：
//   ① 请求还在路上（预算不够）——调预算即可；
//   ② 请求回来了但字段没接上（真 bug）——必须红。
// 失败文案里带上 store 快照，下次一眼就能分辨，不用再重跑碰运气。

/**
 * 读 window.__teamStore 里与统计相关的当前快照。
 * 只读、只诊断：拿不到就明确写「store 不可用」，绝不因为诊断失败而改变断言结果。
 */
export async function describeStoreStats(page) {
  try {
    const snapshot = await page.evaluate(`(() => {
      const store = window.__teamStore;
      if (!store || typeof store.getState !== 'function') return { store: 'unavailable' };
      const state = store.getState();
      return {
        store: 'ok',
        globalType: typeof state.global,
        globalText: state.global && state.global.text ? String(state.global.text) : null,
        fpTotalText: document.getElementById('fpTotal') ? document.getElementById('fpTotal').textContent.trim() : null,
        lastErrors: Array.isArray(store.errors) ? store.errors.slice(-3) : null,
      };
    })()`);
    if (snapshot.store === 'unavailable') return 'store 不可用（window.__teamStore 缺失或没有 getState）';
    return `store 可用；state.global=${snapshot.globalType}`
      + `；state.global.text=${snapshot.globalText === null ? '(空)' : JSON.stringify(snapshot.globalText)}`
      + `；#fpTotal 当前=${JSON.stringify(snapshot.fpTotalText)}`
      + `；最近错误=${snapshot.lastErrors ? JSON.stringify(snapshot.lastErrors) : '(无)'}`;
  } catch (diagnoseError) {
    return `store 诊断读取失败：${diagnoseError.message}`;
  }
}
