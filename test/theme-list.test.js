// theme-list.test.js —— M4 的数据层断言：群列表三态 + summary 四条硬规则 + tab 映射 + 长名省略。
//
// 为什么要这一层：M4 的必做项（summary 原样/空值不占位/失败态/三 tab）全部可以先在数据层判死。
// 「原样渲染」「空值不渲染」「失败不显示 0 个群」这三条只要渲染函数对，界面就是对的；
// 只有观感（颜色、间距）才必须靠人眼。
//
// 同 U-1/U-2 的口径在 classic 侧复现：check-ui-contract 验的是 legacy 渲染层，
// 这里用 classic 自己的纯函数验同一组事实（C-1 透传 + D-4 判空），两边一起看才算守住。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { compileTheme } from '../scripts/build-theme.mjs';
import { loadHostGlobals } from './helpers/host-globals.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 列表与 tab 的口径住在 SDK（主题只负责画）
const LIST_SOURCE_PATH = path.join(PROJECT_ROOT, 'ui', 'theme-sdk', 'list-rules.ts');
// 样式已内联进主题文件（单文件主题）：静态断言改为在 classic.tsx 的 styles 模板里找规则
const THEME_SOURCE_PATH = path.join(PROJECT_ROOT, 'ui', 'themes', 'classic.tsx');

const REACT_STUB = {
  useCallback: (callback) => callback,
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (initialValue) => ({ current: initialValue }),
  useState: (initialValue) => [initialValue, () => {}],
};
const JSX_RUNTIME_STUB = { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' };

async function compileModule(sourcePath) {
  const sourceText = await fs.readFile(sourcePath, 'utf8');
  const compiled = await compileTheme({ sourceText, resolveDir: path.dirname(sourcePath), sourcefile: path.basename(sourcePath) });
  assert.ok(compiled.bundleCode.length > 0, `${path.basename(sourcePath)} 的编译产物为空`);
  const sandboxModule = { exports: {} };
  vm.runInNewContext(compiled.bundleCode, {
    module: sandboxModule,
    exports: sandboxModule.exports,
    require: (specifier) => {
      if (specifier === 'react') return REACT_STUB;
      if (specifier === 'react/jsx-runtime') return JSX_RUNTIME_STUB;
      // list.tsx / shell-tabs.tsx 会 import theme-sdk（hooks/actions），单测里用不到具体实现
      return new Proxy({}, { get: () => () => undefined });
    },
    console,
    window: undefined,
    ...(await loadHostGlobals()),
  }, { filename: path.basename(sourcePath) });
  return sandboxModule.exports;
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const RULES = await compileModule(LIST_SOURCE_PATH);
const LIST = RULES;
const TABS = RULES;

// ---------------------------------------------------------------- summary 四条规则（P0）

test('summary 原样透传：普通文案逐字输出，不做任何加工', () => {
  const cases = [
    '限速 60/min · 余 12 credit',
    '5h 12/60 · 余额 $3.2',
    '{baseURL}',                       // 占位符必须原样出现，不能被替换成地址
    'Token 剩余 2.5M',                 // 声明方自己拼好的成品
  ];
  for (const summary of cases) {
    assert.equal(LIST.resolveSummaryText(summary), summary, `summary 必须逐字透传：${summary}`);
  }
});

test('summary 保留首尾空格（判空用 trim，渲染用原值 —— 吃掉空格就是加工内容）', () => {
  assert.equal(LIST.resolveSummaryText('  有内容的摘要  '), '  有内容的摘要  ');
});

test('summary 为空 → 不渲染副标题（D-4）：空串 / 纯空格 / 字段缺失', () => {
  for (const summary of ['', '   ', '\t\n', null, undefined]) {
    assert.equal(LIST.resolveSummaryText(summary), '', `${JSON.stringify(summary)} 必须判为空 → 整行不渲染`);
  }
});

test('buildListItemView：副标题空串即不渲染，内容与选中态正确', () => {
  const withSummary = plain(LIST.buildListItemView(
    { id: 'agnes', name: 'agnes(1a2b3c4d)', summary: '限速 60/min · 余 12 credit', lastUpdated: '2026-11-02T11:20:00.000Z' },
    'agnes',
    () => {},
  ));
  assert.equal(withSummary.title, 'agnes(1a2b3c4d)');
  assert.equal(withSummary.subtitle, '限速 60/min · 余 12 credit');
  assert.equal(withSummary.meta, '11-02');
  assert.equal(withSummary.active, true, '当前群必须是选中态');

  const blankSummary = plain(LIST.buildListItemView({ id: 'x', name: 'x', summary: '   ' }, '', () => {}));
  assert.equal(blankSummary.subtitle, '', '纯空格 → 空串 → skin 不渲染副标题节点');
  assert.equal(blankSummary.active, false);
});

// ---------------------------------------------------------------- 三态与计数（P0）

test('列表三态：有群 = loaded；空 + 无失败 = empty；空 + 有失败 = load-failed', () => {
  assert.equal(LIST.resolveListStatus([{ id: 'a' }], ''), 'loaded');
  assert.equal(LIST.resolveListStatus([{ id: 'a' }], 'HTTP 500'), 'loaded', '有数据时即使有历史错误也照常显示数据');
  assert.equal(LIST.resolveListStatus([], ''), 'empty');
  assert.equal(LIST.resolveListStatus([], 'HTTP 500'), 'load-failed');
});

test('计数文案：失败显示「加载失败」，绝不显示「0 个群」', () => {
  assert.equal(LIST.resolveCountText('load-failed', 0), '加载失败');
  assert.equal(LIST.resolveCountText('loaded', 2), '2 个群 · 每个群 = 一个平台账号');
  assert.equal(LIST.resolveCountText('empty', 0), '0 个群 · 每个群 = 一个平台账号', '确实没有群时才允许出现 0 个群');
});

// ---------------------------------------------------------------- 搜索（P1）

test('搜索过滤：name / summary / driver / id 任一命中；大小写不敏感；空词返回全部', () => {
  const groups = [
    { id: 'agnes', name: 'agnes(1a2b3c4d)', summary: '限速 60/min · 余 12 credit', driver: 'openai-compatible' },
    { id: 'codearts', name: 'codearts(9f8e7d6c)', summary: '5h 12/60 · 余额 $3.2', driver: 'openai-compatible' },
  ];
  assert.equal(LIST.filterGroups(groups, '').length, 2);
  assert.equal(LIST.filterGroups(groups, 'code').length, 1);
  assert.equal(LIST.filterGroups(groups, 'CODEARTS').length, 1, '大小写不敏感');
  assert.equal(LIST.filterGroups(groups, '余额').length, 1, 'summary 也参与搜索');
  assert.equal(LIST.filterGroups(groups, 'openai').length, 2, 'driver 也参与搜索');
  assert.equal(LIST.filterGroups(groups, '没有这个').length, 0);
});

// ---------------------------------------------------------------- 三 tab（P0）

test('tab 映射：chat/add/db 都停在「消息」，contacts/profile 各自高亮', () => {
  assert.equal(TABS.tabKeyOf('list'), 'messages');
  assert.equal(TABS.tabKeyOf('chat'), 'messages');
  assert.equal(TABS.tabKeyOf('add'), 'messages');
  assert.equal(TABS.tabKeyOf('db'), 'messages');
  assert.equal(TABS.tabKeyOf('contacts'), 'contacts');
  assert.equal(TABS.tabKeyOf('profile'), 'profile');
  assert.deepEqual(plain(TABS.TAB_ITEMS).map((item) => item.label), ['消息', '通讯录', '我'], '底栏顺序固定（条款 6）');
});

test('顶栏标题：每个视图都有可读标题', () => {
  assert.equal(TABS.titleOf('list'), '消息');
  assert.equal(TABS.titleOf('chat'), '群聊');
  assert.equal(TABS.titleOf('add'), '加群');
  assert.equal(TABS.titleOf('contacts'), '通讯录');
  assert.equal(TABS.titleOf('profile'), '我');
  assert.equal(TABS.titleOf('db'), '数据库');
});

// ---------------------------------------------------------------- 布局（P1，静态断言）

test('长群名不撑破：.cl-list-name 必须同时有 min-width:0 与省略号；tab 选中态靠 aria-selected', async () => {
  const css = await fs.readFile(THEME_SOURCE_PATH, 'utf8');
  const nameBlock = /\[data-theme-root="classic"\] \.cl-list-name\s*\{([^}]*)\}/.exec(css);
  assert.ok(nameBlock, '找不到 .cl-list-name 规则');
  assert.match(nameBlock[1], /min-width:\s*0/, 'flex 子项缺 min-width:0 就不会收缩（超长名会撑破）');
  assert.match(nameBlock[1], /text-overflow:\s*ellipsis/);
  assert.match(nameBlock[1], /white-space:\s*nowrap/);
  assert.match(css, /\.cl-list-main\s*\{[^}]*min-width:\s*0/, '主列也要 min-width:0');
  assert.match(css, /\[aria-selected="true"\]/, '选中态必须由 aria-selected 驱动（V-7 的判据）');
});
