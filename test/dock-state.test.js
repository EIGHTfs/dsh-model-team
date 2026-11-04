// G-dock2：悬浮件状态工厂（单一真相源）的用例。
//
// 为什么单测：显隐与位置原本散在三处，不同步就会出现「判定说隐藏、界面还亮着」与
// 「拖出去再刷新跳回固定位置」。这里把工厂契约钉住：
//   · subscribe 立即回调一次当前值（订阅者不必自己写首帧读取）
//   · setXxx 只改值 + 通知；写 DOM 由注册的 applier 落地（幂等可重放）
//   · 只持久化「收起态锚点」，显隐/形态/方向是运行时事实
//   · 旧键（dsh-model-team:anchor）要迁移进新键并删除，避免两份真相

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const DOCK_STATE_SOURCE = await fs.readFile(new URL('../ui/js/dock-state.js', import.meta.url), 'utf8');

// 每个用例独立加载：工厂是模块级单例，用例之间不能互相污染。
// localStorage 用内存桩注入（模块加载时就会读一次，所以桩必须在加载前装好）。
function loadDockState(initialStorage) {
  const store = new Map(Object.entries(initialStorage || {}));
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: (key) => { store.delete(key); },
    },
  };
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${DOCK_STATE_SOURCE}
;return {
  getDockState: getDockState,
  subscribeDockState: subscribeDockState,
  setDockVisible: setDockVisible,
  setDockAnchor: setDockAnchor,
  setDockOpenDir: setDockOpenDir,
  registerDockAppliers: registerDockAppliers,
  reapplyDockDom: reapplyDockDom
};`);
  const api = factory();
  return { api, store };
}

test('G-dock2-⑥：subscribe 立即回调一次当前值（R2：订阅者不必自己读首帧）', () => {
  const { api } = loadDockState();
  const seen = [];
  const unsubscribe = api.subscribeDockState((state) => seen.push(state));

  assert.equal(seen.length, 1, '订阅瞬间必须回调一次');
  assert.deepEqual(seen[0], { visible: false, anchor: null, shape: 'ball', openDir: 'down-left' });
  assert.equal(typeof unsubscribe, 'function');
});

test('G-dock2-⑦：显隐只有一份真相——改值会重放 DOM 且只通知一次', () => {
  const { api } = loadDockState();
  const applied = [];
  api.registerDockAppliers({
    visibility: (visible) => applied.push(visible),
    anchor: (anchor, shape) => applied.push(`${anchor ? 'anchor' : 'no-anchor'}:${shape}`),
  });
  applied.length = 0;   // 注册时会重放一次，这里只关心后续

  api.setDockVisible(true);
  assert.equal(api.getDockState().visible, true);
  assert.deepEqual(applied[0], true, 'DOM 由 applier 落地');
  assert.equal(applied.filter((item) => item === true).length >= 1, true);

  // 值没变时不再通知订阅者，但要重放一次 DOM（DOM 可能刚被重建过）
  const seen = [];
  api.subscribeDockState((state) => seen.push(state.visible));
  seen.length = 0;
  api.setDockVisible(true);
  assert.deepEqual(seen, [], '值未变不重复通知');
});

test('G-dock2-⑧：锚点持久化只存收起态锚点，刷新后能读回；显隐不落盘', () => {
  const first = loadDockState();
  first.api.setDockVisible(true);
  first.api.setDockAnchor({ left: 120.4, top: 88.6 });

  const saved = JSON.parse(first.store.get('dsh-model-team:dock-state-v2'));
  assert.deepEqual(saved, { anchor: { left: 120, top: 89 } }, '只存锚点（并取整），不存 visible');
  assert.equal(JSON.stringify(saved).includes('visible'), false);

  // 模拟刷新：用同一份存储重新加载工厂
  const second = loadDockState(Object.fromEntries(first.store));
  assert.deepEqual(second.api.getDockState().anchor, { left: 120, top: 89 });
  assert.equal(second.api.getDockState().visible, false, '显隐是运行时事实，不跨会话恢复');
});

test('G-dock2-⑨：旧键 dsh-model-team:anchor 迁移进新键并删除旧键', () => {
  const legacyAnchor = JSON.stringify({ left: 640, top: 320 });
  const { api, store } = loadDockState({ 'dsh-model-team:anchor': legacyAnchor });

  assert.deepEqual(api.getDockState().anchor, { left: 640, top: 320 }, '旧值要能读出来');
  assert.equal(store.has('dsh-model-team:anchor'), false, '迁移后旧键必须删除（避免两份真相）');
  assert.deepEqual(JSON.parse(store.get('dsh-model-team:dock-state-v2')).anchor, { left: 640, top: 320 });
});

test('G-dock2-⑩：openDir 变化会重放 DOM（文本换侧/面板换向），且不落盘', () => {
  const { api, store } = loadDockState();
  const appliedDirs = [];
  api.registerDockAppliers({
    visibility: () => {},
    anchor: (anchor, shape, openDir) => appliedDirs.push(openDir),
  });
  appliedDirs.length = 0;

  api.setDockOpenDir('down-right');
  assert.equal(api.getDockState().openDir, 'down-right');
  assert.deepEqual(appliedDirs, ['down-right']);
  // 非法方向忽略（避免把 dataset 写成空串）
  api.setDockOpenDir('sideways');
  assert.equal(api.getDockState().openDir, 'down-right');
  // 方向不进持久化
  assert.equal(store.get('dsh-model-team:dock-state-v2'), undefined);
});
