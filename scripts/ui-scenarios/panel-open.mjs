// 场景 panel-open：不点球，直接走打开路径验「面板本体」是否正确。
//
// 为什么需要它：G-dock B3 之后，悬停球在「拿不到宿主 projection」的环境（minihost 预览）按契约隐藏，
// 原来那个 panel 场景点不到球。但面板本身（五个字段、层级、可关闭）仍需真渲染覆盖——
// 所以这里绕开球，直接派发球上的 pointerdown/pointerup（与真实点击走同一套监听与 showPanel 分支），
// 断言面板本体。球"该不该显示"由判定单测（test/dock-decision.test.js）负责，不在这里重复。
//
// 用了哪些 DOM 钩子：
//   #floatBall（只作为事件目标，不要求可见）、#floatPanel（可见性靠 .hidden）
//   #fpGroup / #fpSession / #fpTarget / #fpRate / #fpTotal、#fpClose、.team-app
//
// 怎么故意改坏它（红证指引）：
//   把 ui/js/float.js 的 buildPanelFieldTexts 里任一字段的兜底改成空串（或让 fpRate 直接返回 '加载中'），
//   重新 build 后本场景会红在「五个字段都非空且不是加载中」。

import { openApp } from '../lib/ui-check-env.mjs';

const PANEL_FIELDS = ['fpGroup', 'fpSession', 'fpTarget', 'fpRate', 'fpTotal'];
const LOADING_PLACEHOLDER = /加载中|loading|正在/i;

// 与真实点球等价：pointerdown 记录 panelWasOpen，pointerup 在"没拖动"分支里 showPanel()
const OPEN_PANEL_WITHOUT_BALL = `(() => {
  const ball = document.getElementById('floatBall');
  if (!ball) return false;
  const rect = ball.getBoundingClientRect();
  const options = {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    button: 0, buttons: 1, clientX: rect.left + 1, clientY: rect.top + 1,
  };
  ball.dispatchEvent(new PointerEvent('pointerdown', options));
  ball.dispatchEvent(new PointerEvent('pointerup', { ...options, buttons: 0 }));
  return !document.getElementById('floatPanel').classList.contains('hidden');
})()`;

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
    rect: rect ? { width: rect.width, height: rect.height, top: rect.top, left: rect.left } : null,
    intersectsViewport: rect
      ? (rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth)
      : false,
    fields,
    panelZ: panel ? getComputedStyle(panel).zIndex : null,
    appZ: document.querySelector('.team-app') ? getComputedStyle(document.querySelector('.team-app')).zIndex : null,
  };
})()`;

function check(assertions, title, ok, detail) {
  assertions.push({ title, ok: Boolean(ok), detail: ok ? '' : String(detail == null ? '' : detail) });
}

export const scenario = {
  id: 'panel-open',
  title: '面板本体（不点球）：可见、五字段有值、层级低于主窗口、可关闭',

  async run(page, ctx) {
    const assertions = [];
    await openApp(page, ctx.url);
    await page.waitFor('window.__teamStore && document.getElementById("floatBall")',
      { description: '客户端 boot 完成且球节点存在' });

    const opened = await page.evaluate(OPEN_PANEL_WITHOUT_BALL);
    check(assertions, '走打开路径后面板不再带 .hidden', opened === true, `返回 ${opened}`);
    await page.waitFor('!document.getElementById("floatPanel").classList.contains("hidden")',
      { description: '面板展开' });
    // 全局请求量是异步拉的：等它落地再取值，否则会误判成"字段没接上"
    await page.waitFor('document.getElementById("fpTotal").textContent.trim() !== "—"',
      { timeoutMs: 8000, description: '全局请求量已加载到面板' });

    const panel = await page.evaluate(READ_PANEL);
    check(assertions, '面板可见且尺寸大于 0、与视口相交',
      panel.visible && panel.rect.width > 0 && panel.rect.height > 0 && panel.intersectsViewport,
      JSON.stringify(panel.rect));

    for (const fieldId of PANEL_FIELDS) {
      const text = panel.fields[fieldId];
      const exists = typeof text === 'string' && text.length > 0;
      // 「—」只允许出现在会话/目标这两行：预览环境没有真实宿主会话，本来就该是占位；
      // 速率与全局请求量必须真有数字，否则说明数据没接上。
      const allowPlaceholder = fieldId !== 'fpRate' && fieldId !== 'fpTotal';
      const hasConcreteValue = allowPlaceholder ? true : (/\d/.test(text || '') || /tok/.test(text || ''));
      check(assertions, `字段 #${fieldId} 非空且不是加载中`,
        exists && !LOADING_PLACEHOLDER.test(text) && hasConcreteValue, `实际「${text}」`);
    }

    // 层级方向：面板 < 主窗口（别搞反，面板盖住主窗口就是遮挡缺陷）
    const panelZ = Number(panel.panelZ);
    const appZ = Number(panel.appZ);
    check(assertions, '面板 computed z-index 低于主窗口 .team-app', panelZ < appZ,
      `panel=${panel.panelZ} app=${panel.appZ}`);

    await page.evaluate('document.getElementById("fpClose").click()');
    await page.waitFor('document.getElementById("floatPanel").classList.contains("hidden")',
      { description: '点关闭后面板收起' });
    const closed = await page.evaluate(READ_PANEL);
    check(assertions, '点关闭后面板隐藏', closed.visible === false, JSON.stringify(closed));

    return assertions;
  },
};
