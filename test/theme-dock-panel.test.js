// theme-dock-panel.test.js —— L0/L1 的**数据层**断言（不需要浏览器、不需要 react 渲染）。
//
// 为什么这么做：task-3 的验收里「球可见/拖动/刷新保持」需要真宿主（React 由宿主注入，仓库没有），
// 而「几何夹取、象限方向、拖动阈值、五行政文、D-6 会话行、来源提示文案」全部是纯函数——
// 能在数据层判定的就必须在数据层判定（docs/05 §三点五）。真渲染留给宿主验证，不在这里假装。
//
// 被测的是**将进产物的同一份代码**：ui/themes/base/views/dock.tsx 由构建期同一个编译器编译后在 vm 里执行。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { compileTheme } from '../scripts/build-theme.mjs';
import { loadHostGlobals } from './helpers/host-globals.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 几何/文案口径现在住在 SDK（主题只负责画）：单测直接打 SDK 的纯函数
const DOCK_SOURCE_PATH = path.join(PROJECT_ROOT, 'ui', 'theme-sdk', 'dock-geometry.ts');
const LEGACY_TARGET_SOURCE_PATH = path.join(PROJECT_ROOT, 'ui', 'js', 'float', 'target-source.js');

/** react 只被组件体用到；模块加载期只需要这个桩（拿纯函数时不会调用任何 hook） */
const REACT_STUB = {
  useCallback: (callback) => callback,
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (initialValue) => ({ current: initialValue }),
  useState: (initialValue) => [initialValue, () => {}],
};

/** JSX 编译成 jsx/jsxs 调用（automatic runtime）；模块加载期不会真的执行组件，桩返回 null 即可 */
const JSX_RUNTIME_STUB = {
  jsx: () => null,
  jsxs: () => null,
  Fragment: 'Fragment',
};

async function loadDockModule() {
  const sourceText = await fs.readFile(DOCK_SOURCE_PATH, 'utf8');
  const compiled = await compileTheme({ sourceText, resolveDir: path.dirname(DOCK_SOURCE_PATH), sourcefile: 'dock-geometry.ts' });
  assert.ok(compiled.bundleCode.length > 0, 'dock.tsx 的编译产物为空');
  const sandboxModule = { exports: {} };
  // SDK 只是转调宿主实现：先把宿主分片跑进同一沙箱（真实加载顺序也是宿主在前）
  vm.runInNewContext(compiled.bundleCode, {
    module: sandboxModule,
    exports: sandboxModule.exports,
    require: (specifier) => {
      if (specifier === 'react') return REACT_STUB;
      if (specifier === 'react/jsx-runtime') return JSX_RUNTIME_STUB;
      throw new Error(`dock.tsx 不该 require：${specifier}`);
    },
    window: undefined,
    console,
    ...(await loadHostGlobals()),
  }, { filename: 'dock.cjs' });
  return sandboxModule.exports;
}

/** legacy 的两个纯函数：直接在 vm 里跑旧分片，拿「现状的真相」来比 */
async function loadLegacyFunctions() {
  const targetSource = await fs.readFile(LEGACY_TARGET_SOURCE_PATH, 'utf8');
  const geometrySource = await fs.readFile(path.join(PROJECT_ROOT, 'ui', 'js', 'float', 'geometry.js'), 'utf8');
  const panelFieldsSource = await fs.readFile(path.join(PROJECT_ROOT, 'ui', 'js', 'float', 'panel-fields.js'), 'utf8');
  const sandbox = vm.createContext({
    console,
    warnOnce: () => {},
    findElement: () => null,
    escapeHtml: (value) => String(value == null ? '' : value),
    getDockState: () => ({ anchor: null, openDir: 'down-left', visible: false, shape: 'ball' }),
    setDockOpenDir: () => {},
  });
  vm.runInContext(geometrySource, sandbox, { filename: 'geometry.js' });
  vm.runInContext(panelFieldsSource, sandbox, { filename: 'panel-fields.js' });
  vm.runInContext(targetSource, sandbox, { filename: 'target-source.js' });
  // 0.4.0：legacy 的 float.js 已删除，单一实现就在 float/panel-fields.js 与 float/target-source.js
  return {
    buildPanelFieldTexts: sandbox.buildPanelFieldTexts,
    targetSourceHintOf: sandbox.targetSourceHintOf,
  };
}

// vm 里造出来的对象/数组原型来自另一个 realm，deepEqual 会因原型不同而误报；
// 统一先过一遍 JSON 化成当前 realm 的普通值再比。
const plain = (value) => JSON.parse(JSON.stringify(value));

const VIEW = { width: 1920, height: 1080 };
const BALL = { width: 56, height: 56 };

test('clampDockPosition：四角都能把整块留在视口内（G-dock2：拖出去不许跳回）', async () => {
  const dock = await loadDockModule();
  const cases = [
    { input: { left: -400, top: -400 }, expected: { left: 0, top: 0 }, label: '左上角越界' },
    { input: { left: 9999, top: 9999 }, expected: { left: VIEW.width - BALL.width, top: VIEW.height - BALL.height }, label: '右下角越界' },
    { input: { left: -50, top: 9999 }, expected: { left: 0, top: VIEW.height - BALL.height }, label: '左下角越界' },
    { input: { left: 9999, top: -50 }, expected: { left: VIEW.width - BALL.width, top: 0 }, label: '右上角越界' },
  ];
  for (const { input, expected, label } of cases) {
    assert.deepEqual(plain(dock.clampDockPosition(input.left, input.top, BALL, VIEW)), expected, label);
  }
  // 视口比控件还小时按 0 处理（贴左上角，至少看得见一部分）
  assert.deepEqual(plain(dock.clampDockPosition(100, 100, { width: 800, height: 900 }, { width: 400, height: 300 })), { left: 0, top: 0 });
  // 界内不动：夹取不能顺手改合法位置
  assert.deepEqual(plain(dock.clampDockPosition(300, 200, BALL, VIEW)), { left: 300, top: 200 });
});

test('computeOpenDir：按象限决定朝哪边长（靠右 → 面板向左，靠下 → 向上）', async () => {
  const dock = await loadDockModule();
  const rectAt = (left, top) => ({ left, top, width: BALL.width, height: BALL.height });
  assert.equal(dock.computeOpenDir(rectAt(VIEW.width - 60, 100), VIEW), 'down-left');
  assert.equal(dock.computeOpenDir(rectAt(60, 100), VIEW), 'down-right');
  assert.equal(dock.computeOpenDir(rectAt(VIEW.width - 60, VIEW.height - 60), VIEW), 'up-left');
  assert.equal(dock.computeOpenDir(rectAt(60, VIEW.height - 60), VIEW), 'up-right');
});

test('computePanelPosition：锚点 + 面板尺寸 + 方向，结果整块在视口内', async () => {
  const dock = await loadDockModule();
  const panel = { width: 384, height: 210 };
  const ballAtRightBottom = { left: VIEW.width - BALL.width, top: VIEW.height - BALL.height, ...BALL };
  const upLeft = plain(dock.computePanelPosition(ballAtRightBottom, panel, 'up-left', VIEW));
  // 向左：右边缘对齐球的右边缘；向上：顶在球的上方再留 12px 间隙
  assert.equal(upLeft.left, ballAtRightBottom.left + BALL.width - panel.width);
  assert.equal(upLeft.top, ballAtRightBottom.top - panel.height - 12);

  const ballAtLeftTop = { left: 0, top: 0, ...BALL };
  const downRight = plain(dock.computePanelPosition(ballAtLeftTop, panel, 'down-right', VIEW));
  assert.equal(downRight.left, 0);
  assert.equal(downRight.top, BALL.height + 12);

  // 极端：球贴右下角、面板比视口还宽 → 必须夹回视口内（否则面板被裁掉一半）
  const huge = plain(dock.computePanelPosition({ left: 0, top: 0, ...BALL }, { width: 5000, height: 5000 }, 'down-right', VIEW));
  assert.deepEqual(huge, { left: 0, top: 0 });
});

test('shouldStartDrag：曼哈顿距离 > 4px 才算拖动（否则是点击 → 开合切换）', async () => {
  const dock = await loadDockModule();
  assert.equal(dock.shouldStartDrag(0, 0), false);
  assert.equal(dock.shouldStartDrag(2, 2), false, '4px 以内仍是点击');
  assert.equal(dock.shouldStartDrag(4, 0), false, '等于 4px 也不算拖（F-01 的手感边界）');
  assert.equal(dock.shouldStartDrag(3, 2), true);
  assert.equal(dock.shouldStartDrag(0, 5), true);
});

test('formatSessionLine：D-6 —— 无标题显示「未命名会话」，完整 id 走 title', async () => {
  const dock = await loadDockModule();
  const sessionId = 'session-00000000-0000-4000-8000-000000000000';

  const untitled = plain(dock.formatSessionLine(sessionId, null));
  assert.equal(untitled.text, '未命名会话', 'D-6：无标题不许显示 00000000 这类纯噪音');
  assert.equal(untitled.title, sessionId, '完整 id 必须留在 title 上，否则无法追溯');

  const titled = plain(dock.formatSessionLine(sessionId, '修登录'));
  assert.equal(titled.text, '修登录（00000000）');
  assert.equal(titled.title, sessionId);

  assert.deepEqual(plain(dock.formatSessionLine(null, null)), { text: '—', title: '' }, '草稿会话显示占位符');
  assert.equal(dock.formatSessionLine('session-abcdef12-3456', '  ').text, '未命名会话', '只有空白的标题也算没标题');
});

test('formatTargetLabel：group → @分组名，model → 去掉 global: 前缀的 id，无 → —（与 legacy targetLabel 对齐）', async () => {
  const dock = await loadDockModule();
  const friendGroups = [{ id: 'g-1', name: '主力组' }];
  assert.equal(dock.formatTargetLabel({ type: 'group', id: 'g-1' }, friendGroups), '@主力组', '分组名取好友分组里的名字');
  assert.equal(dock.formatTargetLabel({ type: 'group', id: 'g-404' }, friendGroups), '@g-404', '分组名取不到时回落 id');
  assert.equal(dock.formatTargetLabel({ type: 'model', id: 'global:glm-5.3-flash' }), 'glm-5.3-flash', 'global: 是内部命名空间，用户不该看见');
  assert.equal(dock.formatTargetLabel({ type: 'model', model: 'deepseek-v3' }), 'deepseek-v3', '没有 id 时看 model 字段');
  assert.equal(dock.formatTargetLabel(null), '—');
});

test('targetSourceHint：三值映射与 ui/js/float/target-source.js 逐字一致（同一事实两处表达 ⇒ 门禁）', async () => {
  const dock = await loadDockModule();
  const legacy = await loadLegacyFunctions();
  for (const source of ['parent', 'last-session', 'fallback-group']) {
    assert.equal(
      dock.targetSourceHint(source),
      legacy.targetSourceHintOf(source),
      `targetSource=${source} 的文案必须与 legacy 完全一致`,
    );
  }
  assert.equal(dock.targetSourceHint(''), '', '空值 = 本会话显式绑定，不提示');
  assert.equal(dock.targetSourceHint('unknown-source'), '', '未知来源不渲染（不许当正常值显示）');
});

test('buildPanelFields：五行文案与 legacy buildPanelFieldTexts 逐字一致（含空值占位）', async () => {
  const dock = await loadDockModule();
  const legacy = await loadLegacyFunctions();

  const fixtures = [
    {
      label: '数据齐全',
      legacy: { groupName: 'agnes(1a2b3c4d)', sessionLabel: '修登录（00000000）', targetLabel: 'glm-5.3-flash', rate: '12.5 tok/s', globalText: '12 次 (总计 345.0k tok)' },
      modern: { groupName: 'agnes(1a2b3c4d)', sessionText: '修登录（00000000）', targetLabel: 'glm-5.3-flash', rate: '12.5 tok/s', globalText: '12 次 (总计 345.0k tok)' },
    },
    {
      label: '全空（面板首帧）',
      legacy: {},
      modern: {},
    },
    {
      label: '只有速率缺失',
      legacy: { groupName: '群', sessionLabel: '—', targetLabel: '—', rate: '', globalText: '—' },
      modern: { groupName: '群', sessionText: '—', targetLabel: '—', rate: '', globalText: '—' },
    },
    {
      label: '带来源提示',
      legacy: { groupName: '群', sessionLabel: '—', targetLabel: '@主力组', rate: '— tok/s', globalText: '3 次 (总计 1.2k tok)' },
      modern: { groupName: '群', sessionText: '—', targetLabel: '@主力组', targetSourceHintText: '（继承父会话）', rate: '— tok/s', globalText: '3 次 (总计 1.2k tok)' },
    },
  ];

  for (const fixture of fixtures) {
    const legacyTexts = legacy.buildPanelFieldTexts(fixture.legacy);
    const modernFields = plain(dock.buildPanelFields(fixture.modern));
    const modernValues = modernFields.map((field) => field.value);
    const expected = [legacyTexts.fpGroup, legacyTexts.fpSession, legacyTexts.fpTarget, legacyTexts.fpRate, legacyTexts.fpTotal];

    if (fixture.label === '带来源提示') {
      // 来源提示在 legacy 里是紧邻的 <span class="fp-target-source">，TSX 侧是独立 hint（同位置的小字）；
      // 两边的**可见文本**必须一致：value + hint 拼接后等于 legacy 的 fpTarget 文本。
      const targetVisibleText = `${modernFields[2].value}${modernFields[2].hint || ''}`;
      assert.equal(targetVisibleText, `${legacyTexts.fpTarget}（继承父会话）`, '目标行的可见文本（值+提示）必须与 legacy 一致');
      assert.equal(modernFields[2].hint, '（继承父会话）', '提示必须是独立 hint，不能拼进 value（否则无法单独换样式）');
      assert.deepEqual([modernValues[0], modernValues[1], modernValues[3], modernValues[4]], [expected[0], expected[1], expected[3], expected[4]]);
      continue;
    }
    assert.equal(modernFields[2].hint, undefined, `${fixture.label}：没有来源提示时不该有 hint`);
    assert.deepEqual(modernValues, expected, `${fixture.label}：五行文案必须与 legacy 逐字一致`);
    for (const value of modernValues) {
      assert.ok(String(value).length > 0, `${fixture.label}：五行不得出现空串`);
    }
  }
});

test('buildPanelFields：会话行的 title 属性只在有 sessionId 时给出（D-6 的可追溯通道）', async () => {
  const dock = await loadDockModule();
  const withId = plain(dock.buildPanelFields({ sessionText: '未命名会话', sessionTitle: 'session-abcdef12-3456' }));
  assert.equal(withId[1].title, 'session-abcdef12-3456');
  const withoutId = plain(dock.buildPanelFields({ sessionText: '—' }));
  assert.equal(withoutId[1].title, undefined, '没有 id 时不渲染 title 属性（空 attribute 会变空悬停框）');
});
