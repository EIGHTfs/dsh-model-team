// ui-scenarios/index.mjs —— 场景注册表。
//
// 加一个新场景只需三步：① 在 scripts/ui-scenarios/ 下写一个 .mjs（导出 scenario 对象）
// ② 在下面加一行 import ③ 把它写进 scenarios 数组。**不用改 check-ui.mjs**。
//
// 场景形状（check-ui.mjs 只依赖这三个字段）：
//   { id: string, title: string, run(page, ctx) -> Promise<assertion[]> }
//   assertion = { title: string, ok: boolean, detail?: string }
// ctx 由 check-ui.mjs 提供：{ url, shotDir, dataRoot, port }

import { scenario as zLayers } from './z-layers.mjs';
import { scenario as toastVisible } from './toast-visible.mjs';

export const scenarios = [
  zLayers,
  toastVisible,
];
