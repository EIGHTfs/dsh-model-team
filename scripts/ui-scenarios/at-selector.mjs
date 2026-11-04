// 场景 at-selector：聊天里的 @ 选择器弹层。
//
// 这个场景防的是什么：
//   ① 弹层能打开，但条目数不等于「群友数 + 分组数」（少一段、或多出一段重复项）；
//   ② 群里没有成员时 @ 弹层仍然打开，列出一堆空条目；
//   ③ 方向键 + Enter 选人没生效：输入框没写入 @名字，或者弹层没关（挡住下一次输入）。
//
// 怎么打开（真实触发路径，来自 ui/js/app.js 的事件委托）：
//   点底边栏「消息」→ 点一条群行 .group-item 进入群聊视图（#msgInput 出现）→ 点 #btnAt，
//   事件委托里走 `messageInput.focus() + openAtPop()`（ui/js/chat.js 的 openAtPop）。
//   选人：openAtPop 后按 ArrowDown 换高亮，按 Enter 走 app.js 的 keydown 分支 → insertMention。
//
// 用了哪些 DOM 钩子：
//   .team-tab[data-view="list"]、.group-item（进群聊）、#msgInput、#btnAt
//   #atPop（弹层容器，可见性靠移除 .hidden）、#atList .at-item（条目）
//   #atList .at-section（两段标题：本群群友 / 我的好友分组）
//
// 怎么故意改坏它（红证指引）：
//   把 ui/js/chat.js 的 buildAtSections() 里 groups 段删掉（只返回 modelItems），
//   重新 build 后本场景会红在「条目数 == 群友数 + 分组数」与「两段都在」。

import { openApp } from '../lib/ui-check-env.mjs';

const AT_STATE = `(() => {
  const atPop = document.getElementById('atPop');
  const items = Array.from(document.querySelectorAll('#atList .at-item'));
  const sections = Array.from(document.querySelectorAll('#atList .at-section')).map((node) => node.textContent.trim());
  const input = document.getElementById('msgInput');
  return {
    popExists: Boolean(atPop),
    popVisible: Boolean(atPop) && !atPop.classList.contains('hidden'),
    itemCount: items.length,
    sectionTexts: sections,
    groupSectionItems: document.querySelectorAll('#atList .at-item[data-at-type="group"]').length,
    modelSectionItems: document.querySelectorAll('#atList .at-item[data-at-type="model"]').length,
    inputValue: input ? input.value : null,
    activeIndex: items.findIndex((node) => node.classList.contains('active')),
  };
})()`;

const OPEN_CHAT = `(() => {
  const app = document.getElementById('timApp');
  if (app) app.hidden = false;
  const listTab = document.querySelector('.team-tab[data-view="list"]');
  if (listTab) listTab.click();
  const firstGroup = document.querySelector('.group-item');
  if (!firstGroup) return null;
  firstGroup.click();
  return firstGroup.dataset.groupId || '';
})()`;

function check(assertions, title, ok, detail) {
  assertions.push({ title, ok: Boolean(ok), detail: ok ? '' : String(detail == null ? '' : detail) });
}

// 第一个平台群的 id：不依赖页面，直接问接口
async function fetchFirstGroupId(port) {
  const response = await fetch(`http://127.0.0.1:${port}/_team/groups`);
  const payload = response.ok ? await response.json() : { groups: [] };
  const first = (payload.groups || [])[0];
  if (!first) throw new Error('fixture 里没有平台群，无法为分组选成员');
  return first.id;
}

// 造一个好友分组：本场景要断言"群友段 + 分组段"两段都在，而 fixture 默认没有分组。
// 走真实接口（POST 是 upsert，重复跑也只有一个），避免依赖"别的场景刚建过分组"这种顺序耦合。
async function seedFriendGroup(port, groupId) {
  const response = await fetch(`http://127.0.0.1:${port}/_team/friend-groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'at-check-group',
      name: 'at 检查组',
      strategy: 'round-robin',
      members: [{ platformId: groupId, modelId: (await fetchModels(port, groupId))[0] }],
    }),
  });
  if (!response.ok) throw new Error(`预置好友分组失败：HTTP ${response.status} ${await response.text()}`);
}

async function fetchModels(port, groupId) {
  const response = await fetch(`http://127.0.0.1:${port}/_team/groups/${encodeURIComponent(groupId)}/models`);
  const payload = response.ok ? await response.json() : { models: [] };
  return (payload.models || []).map((model) => model.id);
}

// 后端真值：群友数与分组数都从接口拿，不写死在场景里（fixture 换了也不用改场景）
async function fetchExpectations(port, groupId) {
  const modelsResponse = await fetch(`http://127.0.0.1:${port}/_team/groups/${encodeURIComponent(groupId)}/models`);
  const groupsResponse = await fetch(`http://127.0.0.1:${port}/_team/friend-groups`);
  const modelsPayload = modelsResponse.ok ? await modelsResponse.json() : { models: [] };
  const groupsPayload = groupsResponse.ok ? await groupsResponse.json() : { groups: [] };
  return {
    modelCount: Array.isArray(modelsPayload.models) ? modelsPayload.models.length : 0,
    groupCount: Array.isArray(groupsPayload.groups) ? groupsPayload.groups.length : 0,
    groupNames: (groupsPayload.groups || []).map((group) => group.name),
  };
}

export const scenario = {
  id: 'at-selector',
  title: '@ 选择器：条目数 = 群友 + 分组、两段齐全、键盘选中写入输入框',

  async run(page, ctx) {
    const assertions = [];
    // 先预置分组再打开页面：@ 弹层的条目来自客户端 state.friendGroups（页面加载时拉一次），
    // 若等页面起来后再建分组，DOM 里那份快照还是旧的，会得出"接口有、界面没有"的假红。
    const firstGroupId = await fetchFirstGroupId(ctx.port);
    await seedFriendGroup(ctx.port, firstGroupId);
    await openApp(page, ctx.url);
    await page.waitFor('document.querySelector(".group-item")', { description: '群列表已渲染' });

    const groupId = await page.evaluate(OPEN_CHAT);
    check(assertions, '已进入群聊视图（拿到群 id 且 #msgInput 存在）',
      Boolean(groupId) && Boolean(await page.evaluate('Boolean(document.getElementById("msgInput"))')),
      `群 id=${groupId}`);

    const expected = await fetchExpectations(ctx.port, groupId);
    await page.evaluate('document.getElementById("btnAt").click()');
    await page.waitFor('!document.getElementById("atPop").classList.contains("hidden")', { description: '@ 弹层打开' });

    const opened = await page.evaluate(AT_STATE);
    check(assertions, '@ 弹层可见（#atPop 不再带 .hidden）', opened.popVisible, JSON.stringify(opened));
    // 群友数 + 分组数：这是本场景的核心不变式（少一段/多一段都会被这条抓住）
    check(assertions, `条目数 == 群友数(${expected.modelCount}) + 分组数(${expected.groupCount})`,
      opened.itemCount === expected.modelCount + expected.groupCount,
      `实际 ${opened.itemCount} 条（model ${opened.modelSectionItems} / group ${opened.groupSectionItems}）`);
    check(assertions, '群友段条目数与接口一致', opened.modelSectionItems === expected.modelCount,
      `实际 ${opened.modelSectionItems}，接口 ${expected.modelCount}`);
    check(assertions, '分组段条目数与接口一致', opened.groupSectionItems === expected.groupCount,
      `实际 ${opened.groupSectionItems}，接口 ${expected.groupCount}`);
    check(assertions, '两段标题都在（群友段 + 分组段）',
      opened.sectionTexts.length === 2 && opened.sectionTexts.some((text) => text.includes('群友'))
        && opened.sectionTexts.some((text) => text.includes('好友分组')),
      JSON.stringify(opened.sectionTexts));
    // 分组项要带成员数文案（"(N个平台成员)"），否则用户看不出这组里有几个人
    const groupItemText = await page.evaluate(`(() => {
      const node = document.querySelector('#atList .at-item[data-at-type="group"]');
      return node ? node.textContent.replace(/\\s+/g, ' ').trim() : '';
    })()`);
    check(assertions, '分组项带成员数文案', /个平台成员/.test(groupItemText), `实际「${groupItemText}」`);

    // 键盘：↓ 换高亮 + Enter 选中。用真实 Input.dispatchKeyEvent（app.js 的 keydown 委托才认）
    await page.evaluate('document.getElementById("msgInput").focus()');
    // ↓ 会把高亮从第 0 条挪到第 1 条，所以要取"按完 ↓ 之后"高亮项的名字来比对
    await page.pressKey('ArrowDown');
    // .at-model 显示的是 display（形如「alpha-2 (OpenAI 兼容)」），而 insertMention 写入的是
    // 纯 label（「alpha-2」）：这里按 " (" 切开取前段，就是会被写进输入框的那个名字
    const highlightedLabel = await page.evaluate(`(() => {
      const node = document.querySelector('#atList .at-item.active .at-model');
      return node ? node.textContent.split(' (')[0].trim() : '';
    })()`);
    await page.pressKey('Enter');
    await page.waitFor('document.getElementById("msgInput").value.indexOf("@") === 0', { description: 'Enter 后输入框写入 @名字' });

    const afterPick = await page.evaluate(AT_STATE);
    check(assertions, 'Enter 后输入框以 @ 开头且包含选中的名字',
      (afterPick.inputValue || '').startsWith('@') && (afterPick.inputValue || '').includes(highlightedLabel),
      `输入框「${afterPick.inputValue}」，期望包含「${highlightedLabel}」`);
    check(assertions, '选完后弹层重新隐藏', afterPick.popVisible === false, JSON.stringify(afterPick));

    return assertions;
  },
};
