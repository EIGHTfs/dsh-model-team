// 列表规则：单一实现（ui/js/format/list-rules.js）+ 与主题 SDK 的数据一致性。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const HOST_SOURCE = await fs.readFile(new URL('../ui/js/format/list-rules.js', import.meta.url), 'utf8');
const SDK_SOURCE = await fs.readFile(new URL('../ui/theme-sdk/list-rules.ts', import.meta.url), 'utf8');

function loadHostRules() {
  return new Function(`${HOST_SOURCE}
;return {
  TAB_ITEMS, GROUP_COUNT_SUFFIX, LOAD_FAILED_TEXT,
  filterGroups, resolveListStatus, resolveSummaryText, resolveCountText, formatUpdatedAt, buildListItemView, tabKeyOf, titleOf,
};`)();
}

const rules = loadHostRules();

test('过滤：空关键词返回全量副本；name/summary/driver/id 任一命中且大小写不敏感', () => {
  const groups = [
    { id: 'agnes', name: 'Agnes', summary: '已连接 · api.example.com', driver: 'openai-compatible' },
    { id: 'qoder', name: 'Qoder', summary: '额度 100', driver: 'reverse-qoder' },
  ];

  const all = rules.filterGroups(groups, '');
  assert.equal(all.length, 2);
  assert.notEqual(all, groups, '空关键词也要返回副本，避免调用方误改原数组');
  all.push({ id: 'x' });
  assert.equal(groups.length, 2);

  assert.deepEqual(rules.filterGroups(groups, '  AGNES ').map((group) => group.id), ['agnes'], '大小写与空白都不影响');
  assert.deepEqual(rules.filterGroups(groups, 'api.example').map((group) => group.id), ['agnes'], 'summary 也参与匹配');
  assert.deepEqual(rules.filterGroups(groups, 'reverse').map((group) => group.id), ['qoder'], 'driver 也参与匹配');
  assert.deepEqual(rules.filterGroups(groups, 'qoder').map((group) => group.id), ['qoder'], 'id 也参与匹配');
  assert.deepEqual(rules.filterGroups(groups, '不存在').length, 0);
  assert.deepEqual(rules.filterGroups(null, 'x'), [], '非数组输入不炸');
});

test('三态：空列表 + 有失败原因 = 加载失败；空且无失败 = 确实没有群', () => {
  assert.equal(rules.resolveListStatus([{ id: 'a' }], ''), 'loaded');
  assert.equal(rules.resolveListStatus([], 'network down'), 'load-failed');
  assert.equal(rules.resolveListStatus([], ''), 'empty');
});

test('摘要：空/全空白不占位（返回空串），有内容原样透传（不吃前后空格）', () => {
  assert.equal(rules.resolveSummaryText(null), '');
  assert.equal(rules.resolveSummaryText('   '), '');
  assert.equal(rules.resolveSummaryText('  有内容 恒等 '), '  有内容 恒等 ', '判空用 trim，渲染不 trim');
});

test('计数：失败 → 加载失败；否则 N 个群（0 也照常显示）', () => {
  assert.equal(rules.resolveCountText('load-failed', 0), rules.LOAD_FAILED_TEXT);
  assert.equal(rules.resolveCountText('loaded', 2), '2 个群 · 每个群 = 一个平台账号');
  assert.equal(rules.resolveCountText('empty', 0), '0 个群 · 每个群 = 一个平台账号', '确实没有群时才允许出现 0 个群');
});

test('时间列：缺失/非法为空；今天显示 HH:mm；更早显示 MM-DD', () => {
  assert.equal(rules.formatUpdatedAt(null), '');
  assert.equal(rules.formatUpdatedAt('not-a-date'), '');
  assert.equal(rules.formatUpdatedAt(''), '');

  const now = new Date();
  const minutesAgo = new Date(now.getTime() - 60 * 1000);
  const todayText = rules.formatUpdatedAt(minutesAgo.toISOString());
  assert.match(todayText, /^\d{2}:\d{2}$/, '当天必须是 HH:mm');

  const longAgo = new Date(now.getFullYear() - 1, 0, 5, 12, 0, 0);
  assert.equal(rules.formatUpdatedAt(longAgo.toISOString()), '01-05');
});

test('行数据：active 按当前群判定；副标题与时间用同一套口径', () => {
  const item = rules.buildListItemView(
    { id: 'qoder', name: 'Qoder', avatar: '[Q]', summary: '', lastUpdated: null },
    'qoder',
  );
  assert.equal(item.title, 'Qoder');
  assert.equal(item.avatar, '[Q]');
  assert.equal(item.subtitle, '', '空摘要 → 空串（调用方整行不渲染）');
  assert.equal(item.meta, '');
  assert.equal(item.active, true);

  const other = rules.buildListItemView({ id: 'agnes' }, 'qoder');
  assert.equal(other.active, false);
  assert.equal(other.title, '', 'name 缺失不编造');
});

test('tab 映射：三 tab 顺序固定；chat/add/db 都停在第 1 个', () => {
  assert.deepEqual(rules.TAB_ITEMS, [
    { key: 'messages', label: '消息', view: 'list' },
    { key: 'contacts', label: '通讯录', view: 'contacts' },
    { key: 'profile', label: '我', view: 'profile' },
  ]);
  assert.equal(rules.tabKeyOf('list'), 'messages');
  assert.equal(rules.tabKeyOf('chat'), 'messages');
  assert.equal(rules.tabKeyOf('add'), 'messages');
  assert.equal(rules.tabKeyOf('db'), 'messages');
  assert.equal(rules.tabKeyOf('contacts'), 'contacts');
  assert.equal(rules.tabKeyOf('profile'), 'profile');
});

test('顶栏标题：各视图名映射；未知视图回落「消息」', () => {
  assert.equal(rules.titleOf('chat'), '群聊');
  assert.equal(rules.titleOf('add'), '加群');
  assert.equal(rules.titleOf('contacts'), '通讯录');
  assert.equal(rules.titleOf('profile'), '我');
  assert.equal(rules.titleOf('db'), '数据库');
  assert.equal(rules.titleOf('list'), '消息');
  assert.equal(rules.titleOf('unknown-view'), '消息');
});

test('单一实现：SDK 只转调；TAB_ITEMS 数据必须与宿主逐项一致', () => {
  assert.match(SDK_SOURCE, /dshHostListRules/, 'SDK 必须从宿主取实现');
  assert.equal(/function filterGroups\(groups[\s\S]*?\.filter\(/.test(SDK_SOURCE), false, 'SDK 不得再有过滤实现');
  assert.match(SDK_SOURCE, /export const filterGroups/, '过滤的导出名必须保持（转调）');

  const sdkTabs = [...SDK_SOURCE.matchAll(/\{ key: '(messages|contacts|profile)', label: '([^']+)', view: '([^']+)' \}/g)]
    .map((matched) => ({ key: matched[1], label: matched[2], view: matched[3] }));
  assert.deepEqual(sdkTabs, rules.TAB_ITEMS, 'SDK 的 TAB_ITEMS 与宿主必须一致');
});
