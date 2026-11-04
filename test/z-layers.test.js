// G8：插件自有浮层的层级分配（z-layers）。
// 为什么要单测：层级错位只会在真实渲染里出现——弹窗被主窗口整块盖住、提示条藏在主窗口后面，
// 接口测试与语法检查都看不见。这里把「顺序」钉成断言，并顺带守住「CSS 里不许再出现层级魔数」，
// 否则下次有人图省事写个 2147482xxx，同一类遮挡会再犯一次。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const Z_LAYERS_SOURCE = await fs.readFile(new URL('../lib/client-parts/foundation/z-layers.js', import.meta.url), 'utf8');
const LAYOUT_CSS = await fs.readFile(new URL('../ui/css/layout.css', import.meta.url), 'utf8');
const PANELS_CSS = await fs.readFile(new URL('../ui/css/panels.css', import.meta.url), 'utf8');

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

test('G8-⑮：CSS 只许引用层级变量，不许再写 2147482xxx 这类魔数（防回退）', () => {
  // 只检查插件层级的基数字段；mention 浮层用的是窗口内的相对层级（20），与宿主无关
  const hardcoded = /z-index:\s*2147482\d{3}/;
  assert.equal(hardcoded.test(LAYOUT_CSS), false, 'layout.css 里仍有硬编码层级');
  assert.equal(hardcoded.test(PANELS_CSS), false, 'panels.css 里仍有硬编码层级');

  assert.match(LAYOUT_CSS, /\.float-dock\s*\{[^}]*z-index:\s*var\(--dmt-z-dock/, '悬浮球应引用变量');
  assert.match(LAYOUT_CSS, /\.float-panel\s*\{[^}]*z-index:\s*var\(--dmt-z-panel/, '悬浮面板应引用变量');
  assert.match(LAYOUT_CSS, /\.float-recall\s*\{[^}]*z-index:\s*var\(--dmt-z-recall/, '呼出按钮应引用变量');
  assert.match(LAYOUT_CSS, /\.team-app\s*\{[^}]*z-index:\s*var\(--dmt-z-app/, '主窗口应引用变量');
  assert.match(PANELS_CSS, /\.modal-mask\s*\{[^}]*z-index:\s*var\(--dmt-z-modal/, '弹窗应引用变量');
  assert.match(PANELS_CSS, /\.toast\s*\{[^}]*z-index:\s*var\(--dmt-z-toast/, '提示条应引用变量');
});
