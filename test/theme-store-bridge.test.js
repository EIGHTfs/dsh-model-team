// theme-store-bridge.test.js —— Theme SDK 状态桥的纯逻辑单测。
//
// 为什么这些断言值得存在：store 是「原地修改 + 事件广播」，React 只认引用变化。
// 桥接错一步的现象都很隐蔽——界面不更新（版本号没动）、或者每帧重渲染（每次都是新引用）。
// 这两类都不会报错，只能靠断言钉住。
//
// 加载方式：ui/theme-sdk 是 TS 源码，这里用构建期的同一个编译器（scripts/build-theme.mjs）
// 把它编成 CJS 再在 vm 里执行——测的是**将进产物的同一份代码**，不是复制品。
// store-bridge.ts 刻意不 import react（react 只在 hooks.ts 里），所以这条测试不需要装 react。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { compileTheme } from '../scripts/build-theme.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_SOURCE_PATH = path.join(PROJECT_ROOT, 'ui', 'theme-sdk', 'store-bridge.ts');
const CONTRACT_SOURCE_PATH = path.join(PROJECT_ROOT, 'ui', 'theme-sdk', 'contract.ts');

// 编译在模块加载期只做一次：每个用例各自在**新沙箱**里执行同一份产物。
// 为什么要拆开「编译」与「执行」：
//   · 每个用例需要独立的模块状态（版本号是模块级变量），所以执行必须新建沙箱；
//   · 反复调用编译器既慢，又把「用例之间共享编译器状态」这种与断言无关的因素引进来——
//     实测出现过「整份文件 6 个用例同时报导出函数不存在」，而原因是编译产物为空字符串。
//   · 所以这里显式断言产物非空：一旦编译异常，报的是「产物为空」而不是下游的「不是函数」。
async function compileModuleOnce(sourcePath) {
  const sourceText = await fs.readFile(sourcePath, 'utf8');
  const compiled = await compileTheme({ sourceText, resolveDir: path.dirname(sourcePath), sourcefile: path.basename(sourcePath) });
  assert.ok(compiled.bundleCode && compiled.bundleCode.length > 0, `${path.basename(sourcePath)} 的编译产物为空`);
  return compiled.bundleCode;
}

/** 在全新沙箱里执行产物，拿到一份独立的模块实例 */
function instantiateModule(bundleCode, fileName) {
  const sandboxModule = { exports: {} };
  vm.runInNewContext(bundleCode, {
    module: sandboxModule,
    exports: sandboxModule.exports,
    require: () => { throw new Error('theme-sdk 的这两个模块不该在运行期 require 任何模块'); },
    console,
  }, { filename: fileName });
  return sandboxModule.exports;
}

const BRIDGE_BUNDLE = await compileModuleOnce(BRIDGE_SOURCE_PATH);
const CONTRACT_BUNDLE = await compileModuleOnce(CONTRACT_SOURCE_PATH);

const loadBridgeModule = () => instantiateModule(BRIDGE_BUNDLE, 'store-bridge.cjs');
const loadContractModule = () => instantiateModule(CONTRACT_BUNDLE, 'contract.cjs');

/** 假 store：与 ui/js/store/index.js 暴露的三个方法同形（getState/subscribe/dispatch） */
function createFakeStore(initialState) {
  const listenersByEvent = new Map();
  return {
    getState: () => initialState,
    subscribe(eventName, listener) {
      const list = listenersByEvent.get(eventName) || [];
      list.push(listener);
      listenersByEvent.set(eventName, list);
      return () => listenersByEvent.set(eventName, (listenersByEvent.get(eventName) || []).filter((item) => item !== listener));
    },
    dispatch: () => undefined,
    emit(eventName) {
      for (const listener of listenersByEvent.get(eventName) || []) listener();
    },
    listenerCount(eventName) {
      return (listenersByEvent.get(eventName) || []).length;
    },
  };
}

test('attachStore：每次广播版本号 +1；解绑后不再变', async () => {
  const bridge = loadBridgeModule();
  const store = createFakeStore({ view: 'list' });
  bridge.attachStore(store, ['view:changed', 'groups:updated']);
  const startVersion = bridge.getStoreVersion();

  store.emit('view:changed');
  assert.equal(bridge.getStoreVersion(), startVersion + 1, '一次广播必须让版本号 +1');
  store.emit('groups:updated');
  assert.equal(bridge.getStoreVersion(), startVersion + 2, '不同事件的广播都要算数');

  bridge.detachStore();
  store.emit('view:changed');
  assert.equal(bridge.getStoreVersion(), startVersion + 2, '解绑后广播不该再推进版本号');
  assert.equal(store.listenerCount('view:changed'), 0, '解绑必须真的退订（否则重复挂载会 +2）');
});

test('attachStore：重复接同一个 store 不会双倍推进版本号', async () => {
  const bridge = loadBridgeModule();
  const store = createFakeStore({ view: 'list' });
  bridge.attachStore(store, ['view:changed']);
  bridge.attachStore(store, ['view:changed']);
  const startVersion = bridge.getStoreVersion();
  store.emit('view:changed');
  assert.equal(bridge.getStoreVersion(), startVersion + 1, '重复 attach 必须先解绑旧订阅');
  bridge.detachStore();
});

test('createSelectionCache：版本号变了才重算 selector，版本没变直接用缓存', async () => {
  const bridge = loadBridgeModule();
  const store = createFakeStore({ groups: [{ id: 'a' }] });
  bridge.attachStore(store, ['groups:updated']);
  const selectGroups = bridge.createSelectionCache();
  let selectorCalls = 0;
  const selector = (state) => {
    selectorCalls += 1;
    return state.groups;
  };

  const first = selectGroups(selector);
  assert.equal(selectorCalls, 1);
  const second = selectGroups(selector);
  assert.equal(selectorCalls, 1, '版本号没变时不该重算（否则每次渲染都造新引用）');
  assert.equal(second, first);

  store.emit('groups:updated');
  selectGroups(selector);
  assert.equal(selectorCalls, 2, '版本号变了必须重算');
  bridge.detachStore();
});

test('createSelectionCache：isEqual 判定相等时返回上一个引用', async () => {
  const bridge = loadBridgeModule();
  const store = createFakeStore({ stats: { rows: 1 } });
  bridge.attachStore(store, ['stats:updated']);
  // 切片每次新建对象，但用「内容相等」判等：引用必须保持上一次的
  const selectStats = bridge.createSelectionCache((previous, next) => previous.rows === next.rows);
  const first = selectStats((state) => ({ rows: state.stats.rows }));
  store.emit('stats:updated');
  const second = selectStats((state) => ({ rows: state.stats.rows }));
  assert.equal(second, first, 'isEqual 相等时必须返回旧引用，下游 memo 才不失效');

  // 内容真的变了：必须给新引用，否则界面永远不更新
  store.getState().stats.rows = 2;
  store.emit('stats:updated');
  const third = selectStats((state) => ({ rows: state.stats.rows }));
  assert.notEqual(third, first);
  assert.equal(third.rows, 2);
  bridge.detachStore();
});

test('未接 store 就读状态：报可执行的错，而不是静默返回 undefined', async () => {
  const bridge = loadBridgeModule();
  bridge.detachStore();
  assert.throws(() => bridge.getRawState(), /attachStore/);
});

test('defineTheme：合法定义被冻结，非法 id / 版本 / Root 一律抛错', async () => {
  const contract = loadContractModule();
  const valid = contract.defineTheme({
    meta: { id: 'probe', name: '探针', contractVersion: contract.THEME_CONTRACT_VERSION },
    Root: () => null,
  });
  assert.ok(Object.isFrozen(valid), '主题定义必须冻结，避免运行期被挂字段');
  assert.equal(valid.meta.id, 'probe');

  assert.throws(() => contract.defineTheme({ meta: { id: 'Bad_Id', name: 'x', contractVersion: 1 }, Root: () => null }), /meta\.id/);
  assert.throws(() => contract.defineTheme({ meta: { id: 'probe', name: 'x', contractVersion: 2 }, Root: () => null }), /contractVersion/);
  assert.throws(() => contract.defineTheme({ meta: { id: 'probe', name: 'x', contractVersion: 1 } }), /Root/);
});
