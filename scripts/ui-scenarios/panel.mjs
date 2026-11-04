// 场景 panel：悬浮球 → 悬浮面板（五个字段都有值、面板不压住主窗口、关闭能收起）。
//
// 这个场景防的是什么：
//   ① 面板能展开，但字段停在「加载中」/空串（数据没接上，页面上看不出错）；
//   ② 面板的层级跑到主窗口之上（面板该在主窗口之下：它是"球旁边的快捷卡片"，盖住主窗口就挡操作）；
//   ③ 关闭按钮点了不生效（面板收不起来，挡住后面的界面）。
//
// 怎么打开（真实触发路径，来自 ui/js/float.js）：
//   悬浮球用 **pointerdown/pointerup** 实现拖动与点击二合一（不是 click），
//   所以必须用真实鼠标事件点 #floatBall（Input.dispatchMouseEvent），
//   点到球心后 pointerup 走 `showPanel()` → #floatPanel 移除 .hidden。
//   关闭点 #fpClose（它自己绑了 click，直接 .click() 即可）。
//
// 用了哪些 DOM 钩子：
//   #floatBall（球心坐标）、#floatPanel（可见性靠 .hidden）
//   #fpGroup / #fpSession / #fpTarget / #fpRate / #fpTotal（五个字段）
//   #fpClose（关闭）、.team-app（主窗口，用于层级比较）
//
// 怎么故意改坏它（红证指引）：
//   把 ui/css/layout.css 里 .float-panel 的 z-index 临时改成 var(--dmt-z-app) 之上
//   （或直接删掉那一行 z-index），重新 build 后本场景会红在「面板层级低于主窗口」。

import { openApp } from '../lib/ui-check-env.mjs';

const PANEL_FIELDS = ['fpGroup', 'fpSession', 'fpTarget', 'fpRate', 'fpTotal'];

// 「加载中」占位：客户端在数据没到时会写这些词，本场景要求五个字段里最多允许出现「—」
const LOADING_PLACEHOLDER = /加载中|loading|正在/i;

const READ_PANEL = `(() => {
  const panel = document.getElementById('floatPanel');
  const rect = panel ? panel.getBoundingClientRect() : null;
  const fields = {};
  for (const id of ${JSON.stringify(PANEL_FIELDS)}) {
    const node = document.getElementById(id);
    fields[id] = node ? node.textContent.trim() : null;
  }
  return {
    visible: Boolean(panel) && !panel.classList.contains('hidden'),
    rect: rect ? { width: rect.width, height: rect.height } : null,
    fields,
    panelZ: panel ? getComputedStyle(panel).zIndex : null,
    appZ: document.querySelector('.team-app') ? getComputedStyle(document.querySelector('.team-app')).zIndex : null,
  };
})()`;

function check(assertions, title, ok, detail) {
  assertions.push({ title, ok: Boolean(ok), detail: ok ? '' : String(detail == null ? '' : detail) });
}

export const scenario = {
  id: 'panel',
  title: '悬浮面板：五字段有值、层级低于主窗口、可关闭',

  async run(page, ctx) {
    const assertions = [];
    await openApp(page, ctx.url);
    // 等 boot 完成：球是静态骨架节点，boot 前它的位置与监听都没就绪，点它会"没反应"
    await page.waitFor('window.__teamStore', { description: '客户端 boot 完成' });
    await page.waitFor('document.getElementById("floatBall")', { description: '悬浮球存在' });

    // 球心坐标：用真实鼠标事件点它（球只监听 pointer 系列，直接在 JS 里 .click() 不会触发展开）
    const ballCenter = await page.evaluate(`(() => {
      const ball = document.getElementById('floatBall');
      const rect = ball.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    await page.mouseClick(ballCenter);
    await page.waitFor('!document.getElementById("floatPanel").classList.contains("hidden")',
      { description: '点球后面板展开' });

    // 全局请求量是异步拉的（state.global 到达后才写 #fpTotal，未到是「—」）：
    // 等它落地再取值，否则会误判成"字段没接上"。等不到才算真红。
    await page.waitFor('document.getElementById("fpTotal").textContent.trim() !== "—"',
      { timeoutMs: 8000, description: '全局请求量已加载到面板' });

    const opened = await page.evaluate(READ_PANEL);
    check(assertions, '面板可见且尺寸大于 0', opened.visible && opened.rect.width > 0 && opened.rect.height > 0,
      JSON.stringify(opened.rect));

    // 五个字段逐个查：存在、非空、不是「加载中」
    for (const fieldId of PANEL_FIELDS) {
      const text = opened.fields[fieldId];
      const exists = typeof text === 'string';
      const notLoading = exists && !LOADING_PLACEHOLDER.test(text);
      // 允许「—」的理由：fixture 没有真实宿主会话，所以「会话」行与「当前目标」在未设置时本来就该是 —，
      // 这不是缺陷（生产里 有会话 时才会有值）；「加载中」则不同，是数据没接上，必须红。
      const allowDash = fieldId !== 'fpRate' && fieldId !== 'fpTotal';
      const hasValue = exists && text.length > 0 && (allowDash ? true : text.includes('tok') || /\d/.test(text));
      check(assertions, `字段 #${fieldId} 有值且不是加载中`, exists && notLoading && hasValue,
        `实际「${text}」`);
    }

    // 层级方向：面板 < 主窗口（别搞反，面板盖住主窗口就是遮挡缺陷）
    const panelZ = Number(opened.panelZ);
    const appZ = Number(opened.appZ);
    check(assertions, '面板 computed z-index 低于主窗口 .team-app', panelZ < appZ,
      `panel=${opened.panelZ} app=${opened.appZ}`);

    // 关闭：点 #fpClose 后面板收起
    await page.evaluate('document.getElementById("fpClose").click()');
    await page.waitFor('document.getElementById("floatPanel").classList.contains("hidden")',
      { description: '点关闭后面板收起' });
    const closed = await page.evaluate(READ_PANEL);
    check(assertions, '点关闭后面板隐藏', closed.visible === false, JSON.stringify(closed));

    return assertions;
  },
};
