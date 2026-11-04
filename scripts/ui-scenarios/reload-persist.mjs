// 场景 reload-persist：整页刷新后，会话目标仍然在（目标被落盘并回读）。
//
// 这个场景防的是什么：
//   ① 切换目标只在内存里生效，刷新就丢（用户每次打开面板都看到「—」）；
//   ② 回读成功但显示不正确（面板显示的是上一份/别的目标）；
//   ③ 刷新后球该在的时候不在（球可见性与"是否选中本插件虚拟模型"这层关系被改坏）。
//
// 怎么设目标（真实 UI 路径）：进群聊 → 点 #btnAt 打开 @ 弹层 → ↓ + Enter 选中第一个群友
//   → 点 #btnSend 发送 → ui/js/chat.js 的 sendMessage() 从 @名字 反查模型，
//   派发 switch-target（后端 PUT /_team/session/:id/target 落盘）。
//
// 关于会话 id：宿主里它由槽位桥推进来；预览环境没有宿主，所以这里用**夹具能力**补一步——
//   通过 store 的公开动作 `dispatch({ type: 'session-changed', sessionId })` 注入（与宿主同一条路径）。
//   刷新后再注入一次同样的 id，才谈得上"回读"。
//
// 用了哪些 DOM 钩子：
//   .group-item、#btnAt、#atPop、#atList .at-item、#msgInput、#btnSend
//   #fpTarget（目标文本）、#floatDock（球的可见性）、.team-app
//
// 怎么故意改坏它（红证指引）：
//   把 ui/js/store-session.js 里 switchTarget 之后的落盘调用去掉（或让 applySessionChanged
//   不再回读目标），重新 build 后本场景会红在「刷新后 #fpTarget 与刷新前一致」。

import { openApp } from '../lib/ui-check-env.mjs';

const SESSION_ID = 'ui-check-session';

// 注入会话：与宿主槽位桥推进来的动作同名同形（store-dispatch 的 'session-changed'）
const INJECT_SESSION = `window.__teamStore.dispatch({ type: 'session-changed', sessionId: ${JSON.stringify(SESSION_ID)} })`;

const READ_TARGET = `(() => {
  const targetNode = document.getElementById('fpTarget');
  const dock = document.getElementById('floatDock');
  const store = window.__teamStore;
  const state = store ? store.getState() : null;
  return {
    targetText: targetNode ? targetNode.textContent.trim() : null,
    dockVisible: Boolean(dock) && getComputedStyle(dock).display !== 'none',
    effectiveTarget: state ? state.effectiveTarget : null,
    sessionId: state ? state.sessionId : null,
  };
})()`;

function check(assertions, title, ok, detail) {
  assertions.push({ title, ok: Boolean(ok), detail: ok ? '' : String(detail == null ? '' : detail) });
}

async function injectSession(page) {
  // .dmt-host 挂上 ≠ store 已建好（boot() 里先建 store 再挂骨架的顺序不保证），
  // 不等它直接 dispatch 会撞上 undefined（实测偶发）
  await page.waitFor('window.__teamStore', { description: 'store 已创建（可以注入会话）' });
  await page.evaluate(INJECT_SESSION);
  // 注入后客户端会去拉目标与统计：等 sessionId 落到 state 上，避免后面读到旧值
  await page.waitFor('window.__teamStore.getState().sessionId === ' + JSON.stringify(SESSION_ID),
    { description: '会话 id 已注入 store' });
}

export const scenario = {
  id: 'reload-persist',
  title: '刷新后目标仍在：面板文本一致 + 球可见性与虚拟模型选择一致',

  async run(page, ctx) {
    const assertions = [];
    await openApp(page, ctx.url);
    await page.waitFor('document.querySelector(".group-item")', { description: '群列表已渲染' });
    await injectSession(page);

    // 进群聊 → 打开 @ → ↓ + Enter 选中第一个群友 → 发送（发送里才真正切目标）
    await page.evaluate(`(() => {
      const app = document.getElementById('timApp');
      if (app) app.hidden = false;
      document.querySelector('.team-tab[data-view="list"]').click();
      document.querySelector('.group-item').click();
      return true;
    })()`);
    await page.waitFor('Boolean(document.getElementById("msgInput"))', { description: '进入群聊视图' });
    await page.waitFor('window.__teamStore.getState().models[window.__teamStore.getState().currentGroupId]'
      + ' && window.__teamStore.getState().models[window.__teamStore.getState().currentGroupId].length > 0',
      { description: '当前群模型目录已加载' });

    await page.evaluate('document.getElementById("btnAt").click()');
    await page.waitFor('!document.getElementById("atPop").classList.contains("hidden")', { description: '@ 弹层打开' });
    await page.evaluate('document.getElementById("msgInput").focus()');
    await page.pressKey('Enter');                       // 默认高亮第 0 条 = 第一个群友
    await page.waitFor('document.getElementById("msgInput").value.indexOf("@") === 0', { description: '输入框已写入 @名字' });
    await page.evaluate('document.getElementById("btnSend").click()');

    // 等目标真的落定：effectiveTarget 变成 model 且面板文本不再是「—」
    await page.waitFor('window.__teamStore.getState().effectiveTarget'
      + ' && window.__teamStore.getState().effectiveTarget.type === "model"',
      { description: '目标已切到某个模型' });
    await page.waitFor('document.getElementById("fpTarget").textContent.trim() !== "—"',
      { description: '面板 #fpTarget 已显示目标' });

    const beforeReload = await page.evaluate(READ_TARGET);
    check(assertions, '切换后 #fpTarget 不是「—」且等于目标模型名',
      beforeReload.targetText !== '—'
        && beforeReload.targetText.includes(String(beforeReload.effectiveTarget && beforeReload.effectiveTarget.id).replace(/^global:/, '')),
      JSON.stringify(beforeReload));

    // 整页刷新：这才是"持久化"的判据；刷新后重新注入同一个会话 id（宿主里由槽位桥做）
    await openApp(page, ctx.url);
    await injectSession(page);
    await page.waitFor('window.__teamStore.getState().effectiveTarget', { description: '刷新后目标已回读' });
    await page.waitFor('document.getElementById("fpTarget").textContent.trim() !== "—"',
      { description: '刷新后面板目标已显示' });

    const afterReload = await page.evaluate(READ_TARGET);
    check(assertions, '刷新后 #fpTarget 文本与刷新前一致', afterReload.targetText === beforeReload.targetText,
      `刷新前「${beforeReload.targetText}」→ 刷新后「${afterReload.targetText}」`);

    // 球可见性与「是否选中本插件虚拟模型」的关系：
    // 预览环境拿不到宿主 projection（判不了 → 客户端按 degraded 常显），因此这里只断
    // "选了虚拟模型时必须可见"这一半——反过来断"不是虚拟模型就必须隐藏"在降级环境下会假红。
    const metaResponse = await fetch(`http://127.0.0.1:${ctx.port}/_team/meta`);
    const meta = metaResponse.ok ? await metaResponse.json() : {};
    const virtualModel = typeof meta.virtualModel === 'string' ? meta.virtualModel : null;
    const targetId = String((afterReload.effectiveTarget && afterReload.effectiveTarget.id) || '').replace(/^global:/, '');
    const isVirtualModelSelected = Boolean(virtualModel) && targetId === virtualModel;
    check(assertions, '球可见性与「选中虚拟模型」一致（选中虚拟模型时球必须可见）',
      isVirtualModelSelected ? afterReload.dockVisible === true : true,
      `virtualModel=${virtualModel} target=${targetId} dockVisible=${afterReload.dockVisible}`);

    return assertions;
  },
};
