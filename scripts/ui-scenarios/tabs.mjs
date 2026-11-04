// 场景 tabs：底边栏三个 tab 切过去，视图真的换了、且只有一个是选中态。
//
// 这个场景防的是什么：
//   ① 三个 tab 都点得动，但 aria-selected 停在旧的那个（键盘/读屏用户会以为还在原视图）；
//   ② 切了 tab，标题 (#viewName) 没跟着变，或 #viewRoot 只剩空骨架（渲染函数抛错后的常见残局）。
//
// 用了哪些 DOM 钩子：
//   .team-tab[data-view]  三个 tab（list / contacts / profile）
//   #viewName             顶栏视图名
//   #viewRoot             视图内容容器
//   .group-item           列表视图的群行
//   #btnCreateGroup       通讯录视图的新建入口（只在通讯录里出现）
//   #btnImport            我的视图的导入按钮（只在「我的」里出现）
//
// 怎么故意改坏它（红证指引）：
//   改 ui/js/app.js 的 renderTabs()，把 aria-selected 恒设成 "true"（不再按 data-view 比对），
//   重新 build 后本场景会红在「选中态恰好一个」。

import { openApp } from '../lib/ui-check-env.mjs';

// 三个视图各自的特征钩子：只要在正确的视图里，这些一定存在
const VIEW_SIGNATURE_SELECTOR = {
  list: '.group-item',
  contacts: '#btnCreateGroup',
  profile: '#btnImport',
};

const VIEW_NAME_TEXT = {
  list: '消息',
  contacts: '通讯录',
  profile: '我的',
};

const READ_VIEW_STATE = `(() => {
  const tabs = Array.from(document.querySelectorAll('.team-tab[data-view]'));
  const selected = tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true');
  const viewRoot = document.getElementById('viewRoot');
  return {
    tabCount: tabs.length,
    selectedCount: selected.length,
    selectedView: selected.length === 1 ? selected[0].dataset.view : null,
    viewName: document.getElementById('viewName') ? document.getElementById('viewName').textContent.trim() : null,
    viewRootLength: viewRoot ? viewRoot.innerHTML.trim().length : 0,
    groupItemCount: document.querySelectorAll('.group-item').length,
    hasCreateGroup: Boolean(document.getElementById('btnCreateGroup')),
    hasImportButton: Boolean(document.getElementById('btnImport')),
  };
})()`;

function check(assertions, title, ok, detail) {
  assertions.push({ title, ok: Boolean(ok), detail: ok ? '' : String(detail == null ? '' : detail) });
}

export const scenario = {
  id: 'tabs',
  title: '三 tab 切换：选中态唯一、标题跟随、视图非空且各有特征元素',

  async run(page, ctx) {
    const assertions = [];
    await openApp(page, ctx.url);

    // 主窗口在预览壳里默认收起；这里只把它显示出来，切 tab 仍走真实点击
    await page.evaluate(`(() => {
      const app = document.getElementById('timApp');
      if (app) app.hidden = false;
      return true;
    })()`);
    // 先等客户端 boot 完成（store 出现）：底边栏是静态骨架，早就存在，
    // 但点击委托要靠 store 才生效——不等它，点 tab 会"点了没反应"
    await page.waitFor('window.__teamStore && window.__teamStore.getState().groups.length > 0',
      { description: '客户端 boot 完成且群列表已加载' });

    // 先把三个 tab 的数量对一次：少于 3 个说明底边栏被改动，后续断言没有意义
    const initial = await page.evaluate(READ_VIEW_STATE);
    check(assertions, '底边栏恰好 3 个 tab', initial.tabCount === 3, `实际 ${initial.tabCount} 个`);

    for (const view of ['list', 'contacts', 'profile']) {
      await page.evaluate(`document.querySelector('.team-tab[data-view="${view}"]').click()`);
      // 等标题换成该视图的文案：这是"切过去了"的最直接信号
      await page.waitFor(
        `document.getElementById('viewName').textContent.trim() === ${JSON.stringify(VIEW_NAME_TEXT[view])}`,
        { description: `切到 ${view} 后标题变为「${VIEW_NAME_TEXT[view]}」` },
      );
      const state = await page.evaluate(READ_VIEW_STATE);
      const signatureOk = await page.evaluate(`Boolean(document.querySelector(${JSON.stringify(VIEW_SIGNATURE_SELECTOR[view])}))`);

      check(assertions, `[${view}] 选中态恰好一个且就是它`,
        state.selectedCount === 1 && state.selectedView === view,
        `selectedCount=${state.selectedCount} selectedView=${state.selectedView}`);
      check(assertions, `[${view}] #viewName 文案为「${VIEW_NAME_TEXT[view]}」`,
        state.viewName === VIEW_NAME_TEXT[view], `实际「${state.viewName}」`);
      check(assertions, `[${view}] #viewRoot 非空（不是空白骨架）`,
        state.viewRootLength > 0, `innerHTML 长度=${state.viewRootLength}`);
      check(assertions, `[${view}] 特征元素存在：${VIEW_SIGNATURE_SELECTOR[view]}`,
        signatureOk, '该视图的特征钩子没找到');
    }

    // 列表视图的群行数量：fixture 有 3 个群，断「> 0」而不是等于 3（场景只防空白）
    const listState = await page.evaluate(`(() => {
      document.querySelector('.team-tab[data-view="list"]').click();
      return null;
    })()`);
    void listState;
    await page.waitFor('document.querySelectorAll(".group-item").length > 0', { description: '列表视图有群行' });
    const groupCount = await page.evaluate('document.querySelectorAll(".group-item").length');
    check(assertions, '列表视图 .group-item 数量 > 0', groupCount > 0, `实际 ${groupCount}`);

    return assertions;
  },
};
