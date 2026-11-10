// G8：插件自有浮层的层级分配（z-layers）。
// 为什么要单测：层级错位只会在真实渲染里出现——弹窗被主窗口整块盖住、提示条藏在主窗口后面，
// 接口测试与语法检查都看不见。这里把「顺序」钉成断言，并顺带守住「CSS 里不许再出现层级魔数」，
// 否则下次有人图省事写个 2147482xxx，同一类遮挡会再犯一次。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const Z_LAYERS_SOURCE = await fs.readFile(new URL('../lib/client-parts/foundation/z-layers.js', import.meta.url), 'utf8');
// 0.4.0：legacy ui/css/** 已移除，层级契约改由「主题源码 + 宿主容器」两处守
const THEMES_DIR_URL = new URL('../ui/themes/', import.meta.url);
const THEME_HOST_SOURCE = await fs.readFile(new URL('../lib/client-parts/theme-epilogue.js', import.meta.url), 'utf8');

function loadZLayers() {
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${Z_LAYERS_SOURCE}
;return {
  PLUGIN_Z_BASE: PLUGIN_Z_BASE,
  PLUGIN_Z_LAYER_ORDER: PLUGIN_Z_LAYER_ORDER,
  pluginZIndex: pluginZIndex,
  pluginZLayerCssRoot: pluginZLayerCssRoot
};`);
  return factory();
}

test('G8-⑫：层级顺序钉死 —— 球 < 面板 < 主窗口 < 弹窗 < 提示', () => {
  const zLayers = loadZLayers();
  const byName = {};
  zLayers.PLUGIN_Z_LAYER_ORDER.forEach((layerName) => {
    byName[layerName] = zLayers.pluginZIndex(layerName);
  });

  assert.ok(byName.dock < byName.panel, '面板必须压在球之上');
  assert.ok(byName.panel < byName.app, '主窗口必须压在悬浮面板之上');
  assert.ok(byName.app < byName.modal, '弹窗必须压过主窗口（否则表单被遮住）');
  assert.ok(byName.modal < byName.toast, '提示必须最高（保存结果要能盖在弹窗上被看见）');
  assert.ok(byName.dock >= zLayers.PLUGIN_Z_BASE, '整块插件界面必须压住宿主界面（契约条款 4）');
});

test('G8-⑬：未知层名退回基数而不是 undefined（否则整条 z-index 声明会失效）', () => {
  const zLayers = loadZLayers();

  assert.equal(zLayers.pluginZIndex('no-such-layer'), zLayers.PLUGIN_Z_BASE);
  assert.equal(typeof zLayers.pluginZIndex('modal'), 'number');
});

test('G8-⑭：:root 变量覆盖每一层，且值就是 pluginZIndex 的结果', () => {
  const zLayers = loadZLayers();
  const cssRoot = zLayers.pluginZLayerCssRoot();

  assert.match(cssRoot, /^:root\{/);
  zLayers.PLUGIN_Z_LAYER_ORDER.forEach((layerName) => {
    const declaration = '--dmt-z-' + layerName + ':' + zLayers.pluginZIndex(layerName);
    assert.ok(cssRoot.includes(declaration), '缺少层级变量：' + declaration);
  });
});

test('G8-⑮：层级只许来自 z-layers.js —— 主题不写宿主级魔数、宿主容器用变量', async () => {
  const themeFileNames = (await fs.readdir(THEMES_DIR_URL)).filter((name) => name.endsWith('.tsx'));
  assert.ok(themeFileNames.length > 0, '至少要有一个主题源码');

  const hardcodedHostLayer = /z-index:\s*2147482\d{3}/;
  for (const fileName of themeFileNames) {
    const themeSource = await fs.readFile(new URL(fileName, THEMES_DIR_URL), 'utf8');
    assert.equal(hardcodedHostLayer.test(themeSource), false, `${fileName} 里出现宿主级 z-index 魔数（应只用容器内部相对顺序）`);
  }
  // 跨宿主那一档由宿主容器给：必须是变量，不能写死数字
  assert.match(THEME_HOST_SOURCE, /zIndex\s*=\s*["']var\(--dmt-z-app\)["']/, '宿主容器应使用 var(--dmt-z-app)');
  assert.equal(/zIndex\s*=\s*["']?2147482/.test(THEME_HOST_SOURCE), false, '宿主容器不得写死宿主级层级数字');
});
