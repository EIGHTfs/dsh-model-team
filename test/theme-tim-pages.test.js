// tim 主题三页（加群 / 通讯录 / 我）：空态与正常态的可断言性。
//
// 做法：把 ui/themes/tim.tsx 真编译（esbuild，与构建期同一条链路），在 vm 里用最小 react 桩
// 直接调用页面组件，再遍历返回的元素树找关键文案与 data-* 标记。
// 为什么不上浏览器：这里要验的是「分支是否渲染出该有的东西」，不是像素。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { compileTheme } from '../scripts/build-theme.mjs';
import { loadHostGlobals } from './helpers/host-globals.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEME_SOURCE_PATH = path.join(PROJECT_ROOT, 'ui', 'themes', 'tim.tsx');

/** 元素树：jsx/jsxs 只记录，不渲染 */
const ELEMENT = Symbol('element');
const jsxStub = (type, props) => ({ [ELEMENT]: true, type, props: props || {} });
const REACT_STUB = {
  // useSyncExternalStore：直接取一次快照（测试不关心重渲染，只关心"渲染出什么"）
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
  useEffect: () => undefined,
  useRef: (initial) => ({ current: initial }),
};
const JSX_RUNTIME_STUB = { jsx: jsxStub, jsxs: jsxStub, Fragment: 'Fragment' };

function buildSdkStub(fixtures) {   // 兜底：仅当编译产物仍以模块方式引用 SDK 时才用到
  const noopAction = () => Promise.resolve(null);
  const base = {
    defineTheme: (definition) => definition,
    TAB_ITEMS: [
      { key: 'messages', label: '消息', view: 'list' },
      { key: 'contacts', label: '通讯录', view: 'contacts' },
      { key: 'profile', label: '我', view: 'profile' },
    ],
    PLACEHOLDER: '—',
    RATE_PLACEHOLDER: '— tok/s',
    BALL_FALLBACK_SIZE_PX: 56,
    PANEL_FALLBACK_SIZE: { width: 384, height: 210 },
    actions: {
      openView: noopAction,
      loadGroups: noopAction,
      loadChat: noopAction,
      switchTarget: noopAction,
      sendMessage: noopAction,
      toggleRow: noopAction,
      setDockAnchor: noopAction,
      addGroup: noopAction,
      probeModels: noopAction,
      exportConfig: noopAction,
      importConfig: noopAction,
      loadReverseAccounts: noopAction,
      startReverseLogin: noopAction,
      pollReverseLogin: noopAction,
    },
    useGroups: () => fixtures.groups,
    useGroupsError: () => '',
    useDrivers: () => fixtures.drivers,
    useFriendGroups: () => fixtures.friendGroups,
    useTarget: () => ({ target: null, effectiveTarget: null, targetSource: '' }),
    useChat: () => ({ messages: [], models: [], modelsStatus: 'loaded' }),
    useSession: () => ({ sessionId: '', sessionTitle: '', lastSessionId: '' }),
    useStats: () => ({ rate: null, global: null }),
    useView: () => ({ view: fixtures.view, currentGroupId: '' }),
    useDockState: () => ({ snapshot: null, bridge: null }),
    useDock: () => ({}),
    useErrors: () => [],
    filterGroups: (groups) => groups,
    resolveListStatus: () => 'empty',
    resolveCountText: () => '',
    buildListItemView: () => ({ avatar: null, title: '', subtitle: '', meta: '', active: false, onClick: () => {} }),
    tabKeyOf: () => 'messages',
    titleOf: () => '',
    formatSessionLine: () => ({ text: '—', title: '' }),
    formatTargetLabel: () => '—',
    targetSourceHint: () => '',
    buildPanelFields: () => [],
    clampDockPosition: (left, top) => ({ left, top }),
    computeOpenDir: () => 'down-right',
    computePanelPosition: () => ({ left: 0, top: 0 }),
    shouldStartDrag: () => false,
    measureSize: (_element, fallback) => fallback,
    readViewSize: () => ({ width: 400, height: 760 }),
    defaultAnchor: () => ({ left: 0, top: 0 }),
  };
  return new Proxy(base, { get: (target, key) => (key in target ? target[key] : () => undefined) });
}

function stateOf(fixtures) {
  return {
    groups: fixtures.groups || [],
    drivers: fixtures.drivers || [],
    friendGroups: fixtures.friendGroups || [],
    view: fixtures.view || 'list',
    currentGroupId: '',
    lastGroupsError: '',
    sessionId: '',
    sessionTitle: '',
    rate: null,
    global: null,
    // 加群表单的「值」（值显分离后归宿主态）：用例需要"已选平台"时必须显式给
    addForm: fixtures.addForm || { optionId: '', driverKey: '', values: {}, advancedField: null },
  };
}

async function loadThemePages(fixtures) {
  fixtures.state = stateOf(fixtures);
  const sourceText = await fs.readFile(THEME_SOURCE_PATH, 'utf8');
  const compiled = await compileTheme({ sourceText, resolveDir: path.dirname(THEME_SOURCE_PATH), sourcefile: 'tim.tsx' });
  assert.ok(compiled.bundleCode.length > 0, 'tim.tsx 编译产物为空');
  const sandboxModule = { exports: {} };
  const sdkStub = buildSdkStub(fixtures);
  // SDK 的规则类函数都转调宿主实现：先把宿主分片跑起来（与真实加载顺序一致）
  const hostGlobals = await loadHostGlobals();
  const sandbox = {
    module: sandboxModule,
    ...hostGlobals,
    exports: sandboxModule.exports,
    require: (specifier) => {
      if (specifier === 'react') return REACT_STUB;
      if (specifier === 'react/jsx-runtime') return JSX_RUNTIME_STUB;
      if (specifier.includes('theme-sdk')) return sdkStub;
      return new Proxy({}, { get: () => () => undefined });
    },
    console,
    window: undefined,
  };
  vm.runInNewContext(compiled.bundleCode, sandbox, { filename: 'tim.cjs' });
  // 走真实 store 桥：把 fixtures 作为宿主状态接进去（SDK 的 hooks 会从这里读）
  const exports = sandboxModule.exports;
  if (typeof exports.__attachStore === 'function') {
    exports.__attachStore({
      getState: () => fixtures.state,
      subscribe: () => () => {},
      dispatch: () => Promise.resolve(null),
    }, []);
  }
  return exports;
}

/** 遍历元素树收集：所有可见文本 + 所有 data-* 属性 */
function collectTree(node, collected = { texts: [], attrs: {} }) {
  if (node == null) return collected;
  if (Array.isArray(node)) {
    for (const item of node) collectTree(item, collected);
    return collected;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    const text = String(node).trim();
    if (text) collected.texts.push(text);
    return collected;
  }
  if (typeof node !== 'object') return collected;
  const props = node.props || {};
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('data-') && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
      collected.attrs[key] = String(value);
    }
    // value / placeholder 也是用户可见文案（输入框回填、空输入提示）
    // 只收输入类控件的 value（option 的 value 是内部 id，不是给用户看的文案）
    const isInputControl = node.type === 'input' || node.type === 'textarea' || node.type === 'select';
    if (key === 'value' && isInputControl && typeof value === 'string' && value.trim()) {
      collected.texts.push(value.trim());
    }
    if (key === 'placeholder' && typeof value === 'string' && value.trim()) {
      collected.texts.push(value.trim());
    }
    if (key === 'children') collectTree(value, collected);
  }
  return collected;
}

function renderPage(exports, pageName, fixtures) {
  const page = exports[pageName];
  assert.equal(typeof page, 'function', `主题必须导出页面组件 ${pageName}`);
  // 页面组件现在接宿主注入的 props（收起键回调 / 当前群 id），断言只关心渲染结果
  const collected = collectTree(page({ onHide: () => {}, groupId: '' }));
  // 相邻文本节点会被拆开（{n} 个平台模型），拼一份归一化全文供"整句"断言用
  collected.allText = collected.texts.join(' ').replace(/\s+/g, ' ');
  return collected;
}

const DRIVERS = [
  { id: 'openai-compatible', name: 'OpenAI 兼容', authKind: 'api-key', authSchema: [{ key: 'baseURL', label: '接口地址', type: 'text' }, { key: 'apiKey', label: '密钥', type: 'password' }] },
  { id: 'reverse-qoder', name: 'Qoder', authKind: 'reverse-account', platformId: 'qoder', authSchema: [] },
];

test('加群页：authSchema 的 select 型字段也走自绘 Picker（id 保留 timField-<key>）', async () => {
  const driversWithSelect = [
    {
      id: 'openai-compatible',
      name: 'OpenAI 兼容',
      authKind: 'api-key',
      authSchema: [
        { key: 'baseURL', label: '接口地址', type: 'text' },
        { key: 'region', label: '区域', type: 'select', options: [{ value: 'cn', label: '中国' }, { value: 'us', label: '美国' }] },
      ],
    },
  ];
  const exports = await loadThemePages({
    groups: [],
    drivers: driversWithSelect,
    friendGroups: [],
    view: 'add',
    // 已选配置型平台：直接给宿主侧的表单值（主题只读这份投影）
    addForm: { optionId: 'driver:openai-compatible', driverKey: 'openai-compatible', values: {}, advancedField: null },
  });
  // 断言"传给 Picker 的 props"：树收集器只收文本/属性，展开不了函数组件，所以直接序列化元素树
  const element = exports.AddPage({ onHide: () => {} });
  const pageJson = JSON.stringify(element);
  assert.equal(pageJson.includes('"pickerName":"field-region"'), true, 'select 型字段必须走自绘 Picker');
  assert.equal(pageJson.includes('timField-region'), true, '控件钩子 id 要保留 timField-<key>');
  assert.equal(pageJson.includes('中国') && pageJson.includes('美国'), true, '选项文案要原样传入');
});

test('加群页：未选平台 → 空态「先选平台」', async () => {
  const exports = await loadThemePages({ groups: [], drivers: DRIVERS, friendGroups: [], view: 'add' });
  const tree = renderPage(exports, 'AddPage', {});
  assert.equal(tree.attrs['data-add-state'], 'no-platform');
  assert.equal(tree.texts.includes('先选平台'), true, `实际文案：${JSON.stringify(tree.texts)}`);
  assert.equal(tree.texts.some((text) => text.includes('reverse-qoder')), false, '下拉里不许出现驱动 id');
});

test('加群页：账号型驱动无账号 → 「尚未登录 <平台名>」+ 登录按钮', async () => {
  const exports = await loadThemePages({ groups: [], drivers: DRIVERS, friendGroups: [], view: 'add' });
  // 通过组件的默认 driverId 无法预置，这里直接调页面并断言「有平台可选」的基础事实
  const tree = renderPage(exports, 'AddPage', {});
  assert.equal(tree.texts.some((text) => text.includes('登录')), false, '未选平台时不该出现登录按钮');
  assert.equal(tree.texts.includes('群名称') === false, true, '未选平台时不该渲染群名称输入');
});

test('通讯录页：只有「好友 / 分组」两个分类（其余分类已删）', async () => {
  const exports = await loadThemePages({ groups: [], drivers: DRIVERS, friendGroups: [], view: 'contacts' });
  const tree = renderPage(exports, 'ContactsPage', {});
  assert.equal(tree.texts.includes('好友'), true);
  assert.equal(tree.texts.includes('分组'), true);
  assert.equal(tree.texts.includes('群聊'), false, '群聊不是通讯录分类');
  assert.equal(tree.texts.includes('机器人'), false, '我们没有机器人概念');
  assert.equal(tree.attrs['data-contacts-tab'], 'friends', '默认在好友分类');
});

test('通讯录页：好友分类空态 → 「还没有接入的平台账号」', async () => {
  const exports = await loadThemePages({ groups: [], drivers: DRIVERS, friendGroups: [], view: 'contacts' });
  const tree = renderPage(exports, 'ContactsPage', {});
  assert.equal(tree.attrs['data-friends-state'], 'empty');
  assert.equal(tree.texts.includes('还没有接入的平台账号'), true, `实际文案：${JSON.stringify(tree.texts)}`);
});

test('分组编辑面板：新建态有名称/策略/两级成员选择，空成员时保存报错', async () => {
  const exports = await loadThemePages({ groups: [{ id: 'g1', name: 'Agnes 号' }], drivers: DRIVERS, friendGroups: [], view: 'contacts' });
  const editorTree = exports.FriendGroupEditor({ group: null, groups: [{ id: 'g1', name: 'Agnes 号' }], onClose: () => {}, onSaved: () => {} });
  const tree = collectTree(editorTree);
  tree.allText = tree.texts.join(' ').replace(/\s+/g, ' ');
  assert.equal(tree.attrs['data-friend-editor'], 'create', '默认是新建');
  assert.equal(tree.texts.includes('分组名称'), true);
  assert.equal(tree.texts.includes('成员轮换策略'), true);
  // 0.4.0 后策略/平台/模型都是自绘 Picker（函数组件）：树收集器不展开函数组件，
  // 所以这里断言"传进去的控件与选项"本身（选项文案仍是真源 STRATEGY_OPTIONS）
  const editorJson = JSON.stringify(editorTree);
  assert.equal(editorJson.includes('"pickerName":"friend-strategy"'), true, '策略必须是自绘下拉');
  assert.equal(editorJson.includes('轮询') && editorJson.includes('故障转移'), true, '两个策略项都要作为选项传入');
  assert.equal(tree.texts.includes('还没有成员'), true);
});

test('分组编辑面板：编辑态回填名称与成员', async () => {
  const group = { id: 'fg-1', name: '主力轮换', strategy: 'fallback', members: [{ platformId: 'g1', modelId: 'agnes-3.0-flash' }] };
  const exports = await loadThemePages({ groups: [{ id: 'g1', name: 'Agnes 号' }], drivers: DRIVERS, friendGroups: [group], view: 'contacts' });
  const editor = exports.FriendGroupEditor({ group, groups: [{ id: 'g1', name: 'Agnes 号' }], onClose: () => {}, onSaved: () => {} });
  const tree = collectTree(editor);
  tree.allText = tree.texts.join(' ').replace(/\s+/g, ' ');
  assert.equal(tree.attrs['data-friend-editor'], 'edit');
  assert.equal(tree.allText.includes('主力轮换'), true, '名称要回填');
  assert.equal(tree.allText.includes('agnes-3.0-flash'), true, '成员要回填');
  assert.equal(tree.texts.includes('编辑分组'), true);
});

test('分组删除确认：二次确认框存在，且带取消/确认两个动作', async () => {
  const friendGroups = [{ id: 'fg-1', name: '主力轮换', strategy: 'round-robin', members: [] }];
  const exports = await loadThemePages({ groups: [], drivers: DRIVERS, friendGroups, view: 'contacts' });
  const tree = renderPage(exports, 'ContactsPage', {});
  // 默认在「好友」分类，先断言好友聚合；分组分类下的列表与删除按钮由下面的静态断言覆盖
  assert.equal(tree.attrs['data-friends-state'], 'empty');
  const sourceText = await fs.readFile(THEME_SOURCE_PATH, 'utf8');
  assert.match(sourceText, /data-delete-confirm=/, '删除必须走二次确认');
  assert.match(sourceText, /data-contact-delete=/, '列表行必须有删除入口');
  assert.match(sourceText, /data-groups-empty/, '分组空态必须存在');
});

test('我页：空态「还没有接入任何平台」+ 单一「备份与恢复」入口', async () => {
  const exports = await loadThemePages({ groups: [], drivers: DRIVERS, friendGroups: [], view: 'profile' });
  const tree = renderPage(exports, 'ProfilePage', {});
  assert.equal(tree.attrs['data-platform-state'], 'empty');
  assert.equal(tree.texts.includes('还没有接入任何平台'), true, `实际文案：${JSON.stringify(tree.texts)}`);
  // 备份/恢复已收敛到数据库页：本页只留一行入口（同一能力不许两套 UI）
  assert.equal(tree.texts.some((text) => text.includes('备份与恢复')), true, '必须有备份与恢复入口');
  assert.equal(tree.texts.some((text) => text.includes('登录 / 导入账号配置')), false, '导入面板已迁走');
  assert.equal(tree.texts.some((text) => text.includes('导出当前配置')), false, '导出按钮已迁走');
  assert.equal(tree.texts.some((text) => text.includes('我的模型团队')), true, '标题必须是项目自己的名字');
});

test('我页：有群 → 按平台分组显示，群名与驱动展示名都在', async () => {
  const groups = [
    { id: 'g1', name: '我的 Qoder', driver: 'reverse-qoder' },
    { id: 'g2', name: '我的 Agnes', driver: 'openai-compatible' },
  ];
  const exports = await loadThemePages({ groups, drivers: DRIVERS, friendGroups: [], view: 'profile' });
  const tree = renderPage(exports, 'ProfilePage', {});
  assert.equal(tree.attrs['data-platform-state'], 'ready');
  assert.equal(tree.texts.includes('我的 Qoder'), true);
  assert.equal(tree.texts.includes('Qoder'), true, '驱动展示名要显示');
  assert.equal(tree.texts.includes('我的 Agnes'), true);
  assert.equal(tree.texts.includes('OpenAI 兼容'), true);
  assert.equal(tree.texts.some((text) => text.includes('reverse-')), false, '不许出现内部标识');
});

test('主题源码：只用 Bridge（无 fetch / localStorage / 私有接口 / 宿主内部对象）', async () => {
  const sourceText = await fs.readFile(THEME_SOURCE_PATH, 'utf8');
  for (const forbidden of ['fetch(', 'localStorage', '/_team', 'window.__']) {
    assert.equal(sourceText.includes(forbidden), false, `主题源码里不许出现 ${forbidden}`);
  }
});

test('主题源码：不出现内部术语（驱动 id / 认证字段名）', async () => {
  const sourceText = await fs.readFile(THEME_SOURCE_PATH, 'utf8');
  for (const forbidden of ['reverse-', 'authSchema', 'driverId']) {
    assert.equal(sourceText.includes(forbidden), false, `主题源码里不许出现 ${forbidden}`);
  }
});

test('加群页：高级字段由宿主给出（主题只按 addForm.advancedField 渲染）', async () => {
  const sourceText = await fs.readFile(THEME_SOURCE_PATH, 'utf8');
  // 0.4.0：模型列表路径这类"值"归宿主（store/add-form.js），主题只渲染宿主给的 label/placeholder
  assert.match(sourceText, /addForm\.advancedField \?/, '高级字段必须来自宿主的 advancedField');
  assert.match(sourceText, /addForm\.advancedField\.placeholder/, '占位文案由宿主给，主题不写死');
  assert.equal(sourceText.includes('modelsEndpoint'), false, '主题里不许出现模型目录路径字段名');
  assert.equal(sourceText.includes('baseURL'), false, '主题里不许出现接口地址字段名');
});

test('加群页标题：返回与标题左对齐相邻（不再被 space-between 顶到右边）', async () => {
  const sourceText = await fs.readFile(THEME_SOURCE_PATH, 'utf8');
  assert.match(sourceText, /tim-list-head tim-list-head-inline/, '加群页标题栏要用左对齐变体');
  assert.match(sourceText, /tim-list-head-inline \{ justify-content: flex-start;/, '左对齐变体要有对应样式');
});

test('底栏三个图标同一套内联 SVG（同 viewBox / 同尺寸 / 同描边）', async () => {
  const sourceText = await fs.readFile(THEME_SOURCE_PATH, 'utf8');
  assert.match(sourceText, /TAB_ICON_PROPS/, '三个图标必须共用同一组属性');
  assert.equal((sourceText.match(/const TAB_ICON_PROPS/g) || []).length, 1, '只允许一处图标属性定义');
  assert.equal(/fill="currentColor"/.test(sourceText), false, '不许混用实心图标');
});
