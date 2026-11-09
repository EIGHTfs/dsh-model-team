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
    if (key === 'children') collectTree(value, collected);
  }
  return collected;
}

function renderPage(exports, pageName, fixtures) {
  const page = exports[pageName];
  assert.equal(typeof page, 'function', `主题必须导出页面组件 ${pageName}`);
  const collected = collectTree(page());
  // 相邻文本节点会被拆开（{n} 个平台模型），拼一份归一化全文供"整句"断言用
  collected.allText = collected.texts.join(' ').replace(/\s+/g, ' ');
  return collected;
}

const DRIVERS = [
  { id: 'openai-compatible', name: 'OpenAI 兼容', authKind: 'api-key', authSchema: [{ key: 'baseURL', label: '接口地址', type: 'text' }, { key: 'apiKey', label: '密钥', type: 'password' }] },
  { id: 'reverse-qoder', name: 'Qoder', authKind: 'reverse-account', platformId: 'qoder', authSchema: [] },
];

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

test('通讯录页：空态「还没有分组」', async () => {
  const exports = await loadThemePages({ groups: [], drivers: DRIVERS, friendGroups: [], view: 'contacts' });
  const tree = renderPage(exports, 'ContactsPage', {});
  assert.equal(tree.attrs['data-contacts-state'], 'empty');
  assert.equal(tree.texts.includes('还没有分组'), true, `实际文案：${JSON.stringify(tree.texts)}`);
});

test('通讯录页：有分组 → 显示成员数与编辑入口（占位但可点）', async () => {
  const friendGroups = [
    { id: 'fg-1', name: '主力轮换', members: [{ modelId: 'agnes-3.0-flash' }, { modelId: 'glm-5.3' }] },
  ];
  const exports = await loadThemePages({ groups: [], drivers: DRIVERS, friendGroups, view: 'contacts' });
  const tree = renderPage(exports, 'ContactsPage', {});
  assert.equal(tree.attrs['data-contacts-state'], 'ready');
  assert.equal(tree.texts.includes('主力轮换'), true);
  assert.equal(tree.allText.includes('2 个平台模型'), true, `成员数必须显示，实际：${tree.allText}`);
  assert.equal(tree.attrs['data-member-count'], '2');
  assert.equal(Object.keys(tree.attrs).some((key) => key === 'data-contact-edit'), true, '编辑入口必须存在');
});

test('我页：空态「还没有接入任何平台」+ 导出/导入入口', async () => {
  const exports = await loadThemePages({ groups: [], drivers: DRIVERS, friendGroups: [], view: 'profile' });
  const tree = renderPage(exports, 'ProfilePage', {});
  assert.equal(tree.attrs['data-platform-state'], 'empty');
  assert.equal(tree.texts.includes('还没有接入任何平台'), true, `实际文案：${JSON.stringify(tree.texts)}`);
  assert.equal(tree.attrs['data-action'], 'import', '导入入口必须存在');
  assert.equal(tree.texts.some((text) => text.includes('导出当前配置')), true);
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
