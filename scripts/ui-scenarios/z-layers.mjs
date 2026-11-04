// 场景 z-layers：好友分组弹窗必须压在插件主窗口之上，且只存在一个遮罩。
//
// 为什么是这个场景：G8 期间真实发生过「弹窗被主窗口整块盖住」——DOM 里节点在、无障碍树里也查得到，
// 纯函数测试与接口测试永远绿，只有人眼/几何测量才发现。所以这里断言的是**几何与层级**，
// 不是快照：改了样式只要不变式仍成立就继续绿。

import { openApp } from '../lib/ui-check-env.mjs';

// 预览壳里主窗口默认是收起的（宿主里由「进入群聊界面」展开）。这里直接置 hidden=false，
// 是为了把被测对象限定在"层级"本身，而不是"怎么打开主窗口"那段交互。
const REVEAL_APP_AND_OPEN_CONTACTS = `(() => {
  const app = document.getElementById('timApp');
  if (app) app.hidden = false;
  const panel = document.getElementById('floatPanel');
  if (panel) panel.classList.add('hidden');
  const contactsTab = document.querySelector('.team-tab[data-view="contacts"]');
  if (contactsTab) contactsTab.click();
  return Boolean(document.getElementById('btnCreateGroup'));
})()`;

// store 是客户端装配出来的唯一真相源（app.js 挂到 window.__teamStore）；
// 用它的 groups 判断"群列表已到手"，比猜时间稳
const GROUPS_READY = `(() => {
  const store = window.__teamStore;
  if (!store) return false;
  return (store.getState().groups || []).length > 0;
})()`;

// 一次性把后面要比的值都取回来：分多次 evaluate 会让"取到一半页面变了"这种假红出现
const COLLECT_LAYERS = `(() => {
  const style = getComputedStyle(document.documentElement);
  const readVar = (name) => Number(style.getPropertyValue(name).trim());
  const readZ = (selector) => {
    const element = document.querySelector(selector);
    return element ? Number(getComputedStyle(element).zIndex) : NaN;
  };
  const masks = Array.from(document.querySelectorAll('.modal-mask'));
  const modal = masks[0] || null;
  const rect = modal ? modal.getBoundingClientRect() : null;
  const modalStyle = modal ? getComputedStyle(modal) : null;
  return {
    vars: {
      dock: readVar('--dmt-z-dock'),
      panel: readVar('--dmt-z-panel'),
      app: readVar('--dmt-z-app'),
      modal: readVar('--dmt-z-modal'),
      toast: readVar('--dmt-z-toast'),
    },
    elementZ: {
      dock: readZ('.float-dock'),
      panel: readZ('.float-panel'),
      app: readZ('.team-app'),
      modal: readZ('.modal-mask'),
    },
    maskCount: masks.length,
    modal: rect ? {
      width: rect.width,
      height: rect.height,
      opacity: Number(modalStyle.opacity),
      intersectsViewport: rect.bottom > 0 && rect.right > 0
        && rect.top < window.innerHeight && rect.left < window.innerWidth,
    } : null,
  };
})()`;

function check(assertions, title, ok, detail) {
  assertions.push({ title, ok: Boolean(ok), detail: ok ? '' : String(detail == null ? '' : detail) });
}

export const scenario = {
  id: 'z-layers',
  title: '弹窗层级：变量顺序递增、遮罩唯一、弹窗几何可见',

  async run(page, ctx) {
    const assertions = [];

    // 打开页面并等客户端挂载（openApp 内含一次有上界的重载重试，见 ui-check-env.mjs 里的说明）
    await openApp(page, ctx.url);
    await page.waitFor(REVEAL_APP_AND_OPEN_CONTACTS, { description: '打开通讯录视图' });
    // 平台群是异步拉的：没等它，弹窗里的平台/模型下拉会是空的（本场景只看层级，但空表单
    // 会掩盖真正的层级问题——弹窗内容为 0 高时"被盖住"反而看不出来）
    await page.waitFor(GROUPS_READY, { description: 'store 里平台群已加载' });
    await page.evaluate('document.getElementById("btnCreateGroup").click()');
    await page.waitFor('document.querySelector(".modal-mask")', { description: '新建分组弹窗出现' });

    const layers = await page.evaluate(COLLECT_LAYERS);
    const order = ['dock', 'panel', 'app', 'modal', 'toast'];

    // ① 层级变量严格递增：这是"谁压谁"的唯一真相源（z-layers.js 一张有序列表）
    const varValues = order.map((name) => layers.vars[name]);
    const varsIncreasing = varValues.every((value, index) => index === 0 || value > varValues[index - 1]);
    check(assertions, '层级变量严格递增 dock < panel < app < modal < toast', varsIncreasing,
      `实际：${order.map((name) => `${name}=${layers.vars[name]}`).join(' ')}`);

    // ② 真实元素的 computed z-index 也要递增：变量写对、元素没用上，同样会被主窗口盖住
    const elementOrder = ['dock', 'panel', 'app', 'modal'];
    const elementValues = elementOrder.map((name) => layers.elementZ[name]);
    const elementsIncreasing = elementValues.every((value, index) => index === 0 || value > elementValues[index - 1]);
    check(assertions, '元素 computed z-index 递增（.float-dock < .float-panel < .team-app < .modal-mask）',
      elementsIncreasing,
      `实际：${elementOrder.map((name) => `${name}=${layers.elementZ[name]}`).join(' ')}`);

    // ③ 遮罩唯一：叠两个遮罩时 × 关掉的只是第一个，页面会卡在半关状态
    check(assertions, '弹窗遮罩只有一个', layers.maskCount === 1, `实际 .modal-mask 计数 = ${layers.maskCount}`);

    // ④ 弹窗真的被看见：宽高 > 0、不透明、且与视口相交（被整块盖住时这四项会一起不成立）
    const modal = layers.modal;
    const modalVisible = Boolean(modal) && modal.width > 0 && modal.height > 0 && modal.opacity > 0 && modal.intersectsViewport;
    check(assertions, '弹窗可见（宽高 > 0、opacity > 0、与视口相交）', modalVisible,
      modal ? JSON.stringify(modal) : '没有找到 .modal-mask');

    return assertions;
  },
};
