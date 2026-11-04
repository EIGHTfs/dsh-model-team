// G-dock2：悬浮件位置夹取与展开方向的纯数学用例。
//
// 为什么单测：夹取错了的表现是"球被拖出视口就再也抓不回来"或"拖出去再刷新又跳回固定位置"，
// 只有真的拖到屏幕外才看得见。clampDockPosition 是唯一夹取入口（拖动每帧、松手落位、落盘、
// 恢复锚点、resize、面板定位全走它），computeOpenDir 决定文本在球的哪一侧。
//
// 语义要点（与旧版不同）：
//   · min = 0（控件不许伸出左/上边）
//   · max = max(0, 视口 - 控件尺寸)：整块留在视口内
//   · 视口比控件还小时退化到 0（贴左上角，至少能看见一部分）

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const FLOAT_SOURCE = await fs.readFile(new URL('../ui/js/float.js', import.meta.url), 'utf8');

function loadFloatLayer() {
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${FLOAT_SOURCE}
;return { clampDockPosition: clampDockPosition, computeOpenDir: computeOpenDir };`);
  return factory();
}

test('G-dock2-①：四边越界都夹回「整块可见」（左上不能为负，右下不超出视口）', () => {
  const { clampDockPosition } = loadFloatLayer();
  const size = { width: 56, height: 56 };
  const view = { width: 1000, height: 800 };

  assert.deepEqual(clampDockPosition(-500, -500, size, view), { left: 0, top: 0 });
  assert.deepEqual(clampDockPosition(5000, 10, size, view), { left: 944, top: 10 });
  assert.deepEqual(clampDockPosition(10, 5000, size, view), { left: 10, top: 744 });
  assert.deepEqual(clampDockPosition(5000, 5000, size, view), { left: 944, top: 744 });
  assert.deepEqual(clampDockPosition(300, 200, size, view), { left: 300, top: 200 });
});

test('G-dock2-②：视口比控件还小时退化为贴左上角（不会出现负坐标/NaN）', () => {
  const { clampDockPosition } = loadFloatLayer();
  const size = { width: 200, height: 120 };

  assert.deepEqual(clampDockPosition(50, 50, size, { width: 120, height: 80 }), { left: 0, top: 0 });
  assert.deepEqual(clampDockPosition(-10, -10, size, { width: 0, height: 0 }), { left: 0, top: 0 });
});

test('G-dock2-③：球与面板各用自己尺寸夹取（同一函数，不同尺寸 → 不同上限）', () => {
  const { clampDockPosition } = loadFloatLayer();
  const view = { width: 1000, height: 800 };
  const ballSize = { width: 56, height: 56 };
  const panelSize = { width: 384, height: 210 };

  assert.equal(clampDockPosition(5000, 0, ballSize, view).left, 944, '球：1000 - 56');
  assert.equal(clampDockPosition(5000, 0, panelSize, view).left, 616, '面板：1000 - 384');
  assert.equal(clampDockPosition(5000, 5000, panelSize, view).top, 590, '面板：800 - 210');
});

test('G-dock2-④：窗口缩小后旧位置被夹回视口内（resize 的数学部分）', () => {
  const { clampDockPosition } = loadFloatLayer();
  const size = { width: 56, height: 56 };
  const bigView = { width: 1600, height: 1000 };
  const smallView = { width: 420, height: 300 };

  const beforeResize = clampDockPosition(1400, 900, size, bigView);
  assert.deepEqual(beforeResize, { left: 1400, top: 900 }, '大视口内不该被移动');

  const afterResize = clampDockPosition(beforeResize.left, beforeResize.top, size, smallView);
  assert.deepEqual(afterResize, { left: 364, top: 244 }, '420-56 / 300-56');
});

test('G-dock2-⑤：展开方向按象限判定——球靠右→向左展开（文本在左），靠左→向右展开', () => {
  const { computeOpenDir } = loadFloatLayer();
  const view = { width: 1000, height: 800 };
  const boxAt = (left, top) => ({ left, top, width: 56, height: 56 });

  assert.equal(computeOpenDir(boxAt(900, 100), view), 'down-left', '右上 → 向左展开');
  assert.equal(computeOpenDir(boxAt(100, 100), view), 'down-right', '左上 → 向右展开（文本在球右侧）');
  assert.equal(computeOpenDir(boxAt(900, 700), view), 'up-left', '右下 → 向左上展开');
  assert.equal(computeOpenDir(boxAt(100, 700), view), 'up-right', '左下 → 向右上展开');
  // 边界：正好落在中心线上算"靠右/靠下"（>= 判定），保证方向始终有解
  assert.equal(computeOpenDir(boxAt(472, 372), view), 'up-left', '中心线上算「靠右/靠下」');
});
