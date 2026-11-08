// 悬浮件几何：单一实现（ui/js/float/geometry.js）+ 与主题 SDK 的转调/常量一致性。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const HOST_SOURCE = await fs.readFile(new URL('../ui/js/float/geometry.js', import.meta.url), 'utf8');
const SDK_SOURCE = await fs.readFile(new URL('../ui/theme-sdk/dock-geometry.ts', import.meta.url), 'utf8');
const SDK_DOCK_STATE_SOURCE = await fs.readFile(new URL('../ui/theme-sdk/dock-state.ts', import.meta.url), 'utf8');

function loadHostGeometry() {
  return new Function(`${HOST_SOURCE}
;return {
  clampDockPosition, computeOpenDir, computePanelPosition, measureSize, defaultAnchor, shouldStartDrag,
  DRAG_THRESHOLD_PX, PANEL_GAP_PX, BALL_FALLBACK_SIZE_PX, PANEL_FALLBACK_SIZE,
  DEFAULT_ANCHOR_INSET_PX, DEFAULT_ANCHOR_VERTICAL_RATIO,
};`)();
}

const geometry = loadHostGeometry();

test('夹取：整块留在视口内（右下越界 → 贴到 max；负值 → 0）', () => {
  const size = { width: 56, height: 56 };
  const view = { width: 1000, height: 800 };

  assert.deepEqual(geometry.clampDockPosition(-20, -5, size, view), { left: 0, top: 0 }, '负坐标夹到 0');
  assert.deepEqual(geometry.clampDockPosition(5000, 5000, size, view), { left: 944, top: 744 }, '右下越界贴到 max');
  assert.deepEqual(geometry.clampDockPosition(100, 200, size, view), { left: 100, top: 200 }, '视口内原样返回');
});

test('夹取：视口比控件还小 → 按 0（贴左上角，至少看得见一部分）', () => {
  const size = { width: 400, height: 300 };
  const tinyView = { width: 100, height: 80 };
  assert.deepEqual(geometry.clampDockPosition(50, 40, size, tinyView), { left: 0, top: 0 });
});

test('夹取：缺尺寸/非法数值不产生 NaN', () => {
  assert.deepEqual(geometry.clampDockPosition('abc', undefined, null, { width: 100, height: 100 }), { left: 0, top: 0 });
  assert.deepEqual(geometry.clampDockPosition(10, 20, { width: 10, height: 10 }, { width: 0, height: 0 }), { left: 0, top: 0 });
});

test('展开方向：以视口中心分象限（靠右向左、靠下向上）', () => {
  const view = { width: 1000, height: 800 };
  assert.equal(geometry.computeOpenDir({ left: 900, top: 100, width: 56, height: 56 }, view), 'down-left');
  assert.equal(geometry.computeOpenDir({ left: 10, top: 700, width: 56, height: 56 }, view), 'up-right');
  assert.equal(geometry.computeOpenDir({ left: 900, top: 700, width: 56, height: 56 }, view), 'up-left');
  assert.equal(geometry.computeOpenDir({ left: 10, top: 10, width: 56, height: 56 }, view), 'down-right');
});

test('面板定位：朝视口内侧展开并整体夹取（间距 PANEL_GAP_PX）', () => {
  const view = { width: 1000, height: 800 };
  const dock = { left: 900, top: 700, width: 56, height: 56 };
  const panel = { width: 384, height: 210 };

  const upLeft = geometry.computePanelPosition(dock, panel, 'up-left', view);
  assert.equal(upLeft.left, 900 + 56 - 384);
  assert.equal(upLeft.top, 700 - 210 - geometry.PANEL_GAP_PX);

  const downRight = geometry.computePanelPosition({ left: 10, top: 10, width: 56, height: 56 }, panel, 'down-right', view);
  assert.equal(downRight.left, 10);
  assert.equal(downRight.top, 10 + 56 + geometry.PANEL_GAP_PX);
});

test('拖动阈值：曼哈顿距离 > 4 才算拖动（斜向轻微移动算点击）', () => {
  assert.equal(geometry.shouldStartDrag(0, 0), false);
  assert.equal(geometry.shouldStartDrag(3, 1), false, '3+1 不超过阈值');
  assert.equal(geometry.shouldStartDrag(3, 2), true, '3+2 超过阈值');
  assert.equal(geometry.shouldStartDrag(-5, 0), true, '负方向同样按绝对值和');
});

test('测量：元素缺失/尺寸为 0 用兜底；默认锚点在视口内', () => {
  const fallback = { width: 56, height: 56 };
  assert.deepEqual(geometry.measureSize(null, fallback), fallback);
  assert.deepEqual(geometry.measureSize({ getBoundingClientRect: () => ({ width: 0, height: 0 }) }, fallback), fallback);
  assert.deepEqual(geometry.measureSize({ getBoundingClientRect: () => ({ width: 40, height: 30 }) }, fallback), { width: 40, height: 30 });

  const anchor = geometry.defaultAnchor(fallback, { width: 1000, height: 800 });
  assert.equal(anchor.left, 1000 - 56 - geometry.DEFAULT_ANCHOR_INSET_PX);
  assert.equal(anchor.top, 800 * geometry.DEFAULT_ANCHOR_VERTICAL_RATIO);
  assert.equal(anchor.left >= 0 && anchor.left <= 1000 - 56, true);
});

test('单一定义：SDK 只转调，不再出现实现体', () => {
  for (const functionName of ['clampDockPosition', 'computeOpenDir', 'computePanelPosition', 'shouldStartDrag', 'measureSize', 'defaultAnchor']) {
    // 导出名必须保持；实现体形式不再出现（只能是转调）
    assert.match(SDK_SOURCE, new RegExp(`export const ${functionName}\\b|export function ${functionName}\\(`), `${functionName} 的导出名必须保持`);
    assert.equal(new RegExp(`function ${functionName}\\([^)]*\\) \\{[^}]*Math\\.`).test(SDK_SOURCE), false, `${functionName} 不得含实现体`);
  }
  assert.equal(/export function clampDockPosition[\s\S]*?Math\.max/.test(SDK_SOURCE), false, 'SDK 不得再含夹取实现');
  assert.equal(/export function computeOpenDir[\s\S]*?\? 'up'/.test(SDK_SOURCE), false, 'SDK 不得再含象限实现');
  assert.match(SDK_SOURCE, /dshHostGeometry/, 'SDK 必须从宿主取实现');
});

test('常量与宿主一致（两处表达 ⇒ 门禁钉死）', () => {
  const readSdkConstant = (name) => {
    const matched = SDK_SOURCE.match(new RegExp(`export const ${name}\\s*=\\s*([^;]+);`));
    assert.ok(matched, `SDK 缺少常量 ${name}`);
    return matched[1].trim();
  };
  assert.equal(Number(readSdkConstant('DRAG_THRESHOLD_PX')), geometry.DRAG_THRESHOLD_PX);
  assert.equal(Number(readSdkConstant('PANEL_GAP_PX')), geometry.PANEL_GAP_PX);
  assert.equal(Number(readSdkConstant('BALL_FALLBACK_SIZE_PX')), geometry.BALL_FALLBACK_SIZE_PX);
  assert.equal(Number(readSdkConstant('DEFAULT_ANCHOR_INSET_PX')), geometry.DEFAULT_ANCHOR_INSET_PX);
  assert.equal(Number(readSdkConstant('DEFAULT_ANCHOR_VERTICAL_RATIO')), geometry.DEFAULT_ANCHOR_VERTICAL_RATIO);
  const sdkPanelFallback = SDK_SOURCE.match(/PANEL_FALLBACK_SIZE\s*=\s*\{\s*width:\s*(\d+),\s*height:\s*(\d+)/);
  assert.ok(sdkPanelFallback);
  assert.equal(Number(sdkPanelFallback[1]), geometry.PANEL_FALLBACK_SIZE.width);
  assert.equal(Number(sdkPanelFallback[2]), geometry.PANEL_FALLBACK_SIZE.height);
});

test('dock 状态：持久化只在宿主，SDK 侧不得出现 localStorage 或自己存 visible/left/top', () => {
  assert.equal(/localStorage/.test(SDK_DOCK_STATE_SOURCE), false, 'SDK 不许碰持久化');
  assert.equal(/setDockVisible|setItem\(/.test(SDK_DOCK_STATE_SOURCE), false, 'SDK 不许自己写显隐');
  assert.match(SDK_DOCK_STATE_SOURCE, /getDockState/, 'SDK 只能读宿主桥');
});
