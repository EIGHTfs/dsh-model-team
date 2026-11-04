// 场景 toast-visible：保存分组后那条「分组已保存」必须真的被看见。
//
// 为什么是这个场景：G8 期间真实出现过「toast 从来不可见」——它的 z-index 是 200，而插件主窗口
// 是 2147482002，于是提示被整块盖住；元素在 DOM 里、文本也有，`textContent` 断言全绿，
// 只有几何测量能发现。所以这里断言存在性 + 几何 + 不透明度 + 与视口的相交 + 层级压过弹窗。

import { openApp } from '../lib/ui-check-env.mjs';

const REVEAL_APP_AND_OPEN_CONTACTS = `(() => {
  const app = document.getElementById('timApp');
  if (app) app.hidden = false;
  const panel = document.getElementById('floatPanel');
  if (panel) panel.classList.add('hidden');
  const contactsTab = document.querySelector('.team-tab[data-view="contacts"]');
  if (contactsTab) contactsTab.click();
  return Boolean(document.getElementById('btnCreateGroup'));
})()`;

// 走真实 UI 建一个分组：名字填进去（触发 input → id 派生）、加一个成员、保存。
// 前置由调用方保证：「模型下拉里已经有可选模型」——模型目录是异步拉的，
// 没等它就点添加只会得到"先选好平台与模型"，保存会被前端校验拦住，toast 自然不出现。
const CREATE_GROUP = `(() => {
  const nameInput = document.getElementById('friendGroupName');
  nameInput.value = 'ui-check 场景组';
  nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  const addButton = document.getElementById('btnAddFriendGroupMember');
  if (!addButton) return 'no-add-button';
  addButton.click();
  const memberRows = document.querySelectorAll('#friendGroupForm .contact-member').length;
  if (memberRows === 0) return 'no-member-added';
  const saveButton = document.getElementById('btnSaveFriendGroup');
  if (!saveButton) return 'no-save-button';
  saveButton.click();
  return 'members=' + memberRows;
})()`;

// store 是客户端唯一真相源（app.js 挂到 window.__teamStore）：群列表到位才能开弹窗
const GROUPS_READY = `(() => {
  const store = window.__teamStore;
  if (!store) return false;
  return (store.getState().groups || []).length > 0;
})()`;

// 模型下拉已就绪：至少一个选项，且选中的不是占位空值
const MODEL_PICKER_READY = `(() => {
  const modelSelect = document.getElementById('friendGroupModelPick');
  if (!modelSelect || modelSelect.options.length === 0) return false;
  return Boolean(modelSelect.value);
})()`;

const COLLECT_TOAST = `(() => {
  const toastNode = document.getElementById('toast');
  if (!toastNode) return { found: false };
  const rect = toastNode.getBoundingClientRect();
  const style = getComputedStyle(toastNode);
  const modalNode = document.querySelector('.modal-mask');
  return {
    found: true,
    text: toastNode.textContent,
    className: toastNode.className,
    width: rect.width,
    height: rect.height,
    opacity: Number(style.opacity),
    zIndex: Number(style.zIndex),
    modalZIndex: modalNode ? Number(getComputedStyle(modalNode).zIndex) : null,
    intersectsViewport: rect.bottom > 0 && rect.right > 0
      && rect.top < window.innerHeight && rect.left < window.innerWidth,
  };
})()`;

const TOAST_VISIBLE = `(() => {
  const toastNode = document.getElementById('toast');
  if (!toastNode || !toastNode.classList.contains('show')) return false;
  return Number(getComputedStyle(toastNode).opacity) > 0.5;
})()`;

function check(assertions, title, ok, detail) {
  assertions.push({ title, ok: Boolean(ok), detail: ok ? '' : String(detail == null ? '' : detail) });
}

export const scenario = {
  id: 'toast-visible',
  title: '提示条真的可见：几何、不透明度、层级高过弹窗',

  async run(page, ctx) {
    const assertions = [];

    // 打开页面并等客户端挂载（openApp 内含一次有上界的重载重试，见 ui-check-env.mjs 里的说明）
    await openApp(page, ctx.url);
    await page.waitFor(REVEAL_APP_AND_OPEN_CONTACTS, { description: '打开通讯录视图' });
    // 平台群异步加载：没有群就没有"平台下拉"，添加成员会失败，保存被校验拦住，toast 不会出现
    await page.waitFor(GROUPS_READY, { description: 'store 里平台群已加载' });
    await page.evaluate('document.getElementById("btnCreateGroup").click()');
    await page.waitFor('document.getElementById("friendGroupName")', { description: '弹窗表单出现' });
    await page.waitFor(MODEL_PICKER_READY, { timeoutMs: 10000, description: '模型下拉加载出可选项' });

    // 记下弹窗层高：保存成功后弹窗会被关掉，那时再取就取不到了
    const modalZIndexBefore = await page.evaluate(
      'Number(getComputedStyle(document.querySelector(".modal-mask")).zIndex)',
    );

    const createResult = await page.evaluate(CREATE_GROUP);
    check(assertions, '保存动作已从 UI 发起（已添加成员并点了保存）',
      typeof createResult === 'string' && createResult.startsWith('members=') && createResult !== 'members=0',
      `返回：${createResult}`);

    await page.waitFor(TOAST_VISIBLE, { timeoutMs: 8000, description: 'toast 出现并淡入到可见' });
    const toast = await page.evaluate(COLLECT_TOAST);

    check(assertions, 'toast 元素存在且文案是保存成功', toast.found && /分组已保存/.test(toast.text || ''),
      JSON.stringify(toast));
    check(assertions, 'toast 有实际尺寸（宽高 > 0）', toast.found && toast.width > 0 && toast.height > 0,
      `width=${toast.width} height=${toast.height}`);
    check(assertions, 'toast 不透明（opacity > 0.5）', toast.found && toast.opacity > 0.5, `opacity=${toast.opacity}`);
    check(assertions, 'toast 与视口相交（不是被移到屏幕外）', toast.found && toast.intersectsViewport === true,
      JSON.stringify(toast));
    check(assertions, 'toast 层级高于弹窗层', toast.found && toast.zIndex > modalZIndexBefore,
      `toast=${toast.zIndex} modal=${modalZIndexBefore}`);

    return assertions;
  },
};
