// G-dock：悬浮球拖拽边界的纯数学用例。
//
// 为什么单测：夹取错了的表现是"球被拖出视口就再也抓不回来"，只有真的拖到屏幕外才看得见；
// 而窗口 resize 这条路径以前完全没人管。clampDockPosition 是唯一夹取入口，
// 拖动每帧、松手落位、落盘、恢复锚点、resize 全都调它——所以钉住它就钉住了全部路径。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const FLOAT_SOURCE = await fs.readFile(new URL('../ui/js/float.js', import.meta.url), 'utf8');

function loadClamp() {
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${FLOAT_SOURCE}
;return { clampDockPosition: clampDockPosition };`);
  return factory();
}

test('G-dock-⑥：clampDockPosition 四个方向都夹在"至少留 8px 可抓"的范围内', () => {
  const { clampDockPosition } = loadClamp();
  const size = { width: 56, height: 56 };
  const view = { width: 1000, height: 800 };

  // 左上越界（负坐标）→ 只能伸出到"还剩 8px 可见"
  assert.deepEqual(clampDockPosition(-500, -500, size, view), { left: -48, top: -48 });
  // 右上越界 → 左边最多推到 视口宽 - 8
  assert.deepEqual(clampDockPosition(5000, -10, size, view), { left: 992, top: -10 });
  // 左下越界
  assert.deepEqual(clampDockPosition(-10, 5000, size, view), { left: -10, top: 792 });
  // 右下越界
  assert.deepEqual(clampDockPosition(5000, 5000, size, view), { left: 992, top: 792 });
  // 视口内的点原样保留（夹取不能把正常位置挪走）
  assert.deepEqual(clampDockPosition(300, 200, size, view), { left: 300, top: 200 });
});

test('G-dock-⑦：窗口缩小后旧位置被夹回视口内（resize 的数学部分）', () => {
  const { clampDockPosition } = loadClamp();
  const size = { width: 56, height: 56 };
  const bigView = { width: 1600, height: 1000 };
  const smallView = { width: 420, height: 300 };

  const beforeResize = clampDockPosition(1400, 900, size, bigView);
  assert.deepEqual(beforeResize, { left: 1400, top: 900 });

  const afterResize = clampDockPosition(beforeResize.left, beforeResize.top, size, smallView);
  assert.ok(afterResize.left <= smallView.width - 8, `left=${afterResize.left} 必须落在视口内`);
  assert.ok(afterResize.top <= smallView.height - 8, `top=${afterResize.top} 必须落在视口内`);
  assert.ok(afterResize.left >= 8 - size.width, '左边界不能把球推到完全不可见');
  assert.ok(afterResize.top >= 8 - size.height, '上边界不能把球推到完全不可见');
});
