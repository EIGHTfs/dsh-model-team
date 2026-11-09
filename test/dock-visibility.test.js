// INV-14 显隐落点（B14 步 4）：从 legacy #floatDock 迁到主题宿主根 [data-dmt-theme-host]。
//
// 为什么要单测：显隐错一次的表现是"球该消失却还在"或"整块界面被藏掉"，
// 后者在真机上就是会话区拿不到焦点（历史坑）。所以这里钉住两条：
//   ① 有主题宿主 → 只写 data-dock-visible，绝不碰 .dmt-host 的 display
//   ② 没有主题宿主 → 退回容器级兜底（legacy / 主题未挂载）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const DOCK_SOURCE = await fs.readFile(new URL('../lib/client-parts/dock.js', import.meta.url), 'utf8');

/** 造一个只够 setDockVisibility 用的假 document */
function createFakeDocument({ themeHost = null, mountHost = null } = {}) {
  const attributes = [];
  const styleWrites = [];
  const fakeThemeHost = themeHost
    ? {
      setAttribute(name, value) { attributes.push([name, value]); themeHost.attributes[name] = value; },
      getAttribute(name) { return themeHost.attributes[name] ?? null; },
    }
    : null;
  const fakeMountHost = mountHost
    ? { style: new Proxy({}, { set(target, key, value) { styleWrites.push([key, value]); target[key] = value; return true; } }) }
    : null;
  return {
    attributes,
    styleWrites,
    document: {
      querySelector(selector) {
        if (selector === '[data-dmt-theme-host]') return fakeThemeHost;
        return null;
      },
      getElementById() { return null; },
    },
    mountHost: fakeMountHost,
  };
}

/** 在沙箱里求值 dock.js，取出 setDockVisibility（并把 dockMountedHost 暴露出来供第②组用） */
function loadDockModule({ documentImpl, mountHost }) {
  const factory = new Function(
    'document', 'window', '__mountHost',
    `${DOCK_SOURCE}
;dockMountedHost = __mountHost;
;return { setDockVisibility: setDockVisibility };`,
  );
  return factory(documentImpl, { addEventListener() {}, removeEventListener() {} }, mountHost);
}

test('有主题宿主：显隐只写 data-dock-visible，不碰容器 display', () => {
  const themeHost = { attributes: {} };
  const fake = createFakeDocument({ themeHost, mountHost: { style: {} } });
  const dock = loadDockModule({ documentImpl: fake.document, mountHost: fake.mountHost });

  dock.setDockVisibility(false);
  assert.equal(themeHost.attributes['data-dock-visible'], 'false', '隐藏必须落在主题根属性上');
  assert.deepEqual(fake.styleWrites, [], '不得改 .dmt-host 的 display（会把主窗口一起藏掉）');

  dock.setDockVisibility(true);
  assert.equal(themeHost.attributes['data-dock-visible'], 'true', '显示同样走该属性');
  assert.deepEqual(fake.styleWrites, []);
});

test('没有主题宿主：退回容器级兜底（不会残留"判了隐藏却还显示"）', () => {
  const fake = createFakeDocument({ themeHost: null, mountHost: { style: {} } });
  const dock = loadDockModule({ documentImpl: fake.document, mountHost: fake.mountHost });

  dock.setDockVisibility(false);
  assert.deepEqual(fake.styleWrites.at(-1), ['display', 'none'], '无主题根时隐藏容器');

  dock.setDockVisibility(true);
  assert.deepEqual(fake.styleWrites.at(-1), ['display', ''], '恢复显示');
});

test('两者都没有：静默返回，不抛错', () => {
  const fake = createFakeDocument({});
  const dock = loadDockModule({ documentImpl: fake.document, mountHost: null });
  assert.doesNotThrow(() => dock.setDockVisibility(false));
});

test('源码层断言：显隐不再依赖 legacy #floatDock 节点', async () => {
  const source = DOCK_SOURCE;
  const visibilityBlock = source.slice(source.indexOf('function setDockVisibility'));
  assert.equal(visibilityBlock.includes('floatDock'), false, 'setDockVisibility 里不应再出现 floatDock');
  assert.equal(visibilityBlock.includes('data-dock-visible'), true);
});
