#!/usr/bin/env node
// check-css.mjs —— 样式层门禁：不启浏览器，直接对 CSS 与层级常量做断言。
//
// 为什么这道门禁存在：
//   历史上真实出现过两个只有"人眼看页面"才能发现的缺陷——
//     ① 弹窗被主窗口整块盖住（`.modal-mask` 的 z-index 是字面量 300，主窗口是 2147482002）；
//     ② 提示条永远看不见（`.toast` 是 200，被主窗口压住）。
//   这两个缺陷的共同点是：**都能从源码静态判定**，根本不需要真的开一个浏览器去量像素。
//   所以真渲染门禁被移除后，这两类问题由本文件守住——它跑一次几十毫秒、零抖动。
//
// 判据（每条都能红）：
//   1. 插件浮层的 z-index 必须引用 `var(--dmt-z-<层>)`，不许写字面量；字面量 ≥ 100 直接失败。
//   2. 五个关键部件的层名映射必须正确：球=dock、面板=panel、主窗口=app、弹窗=modal、提示条=toast。
//   3. 层级顺序常量必须满足 dock/recall < panel < app < modal < toast。
//   4. 提示条靠 opacity 显隐：默认 0、`.show` 为 1，且 position: fixed（否则不在浮层上下文）。
//   5. 弹窗遮罩必须 position: fixed + inset: 0 + 层名 modal（否则不是一个全屏遮罩）。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_DIR = path.join(PROJECT_ROOT, 'ui', 'css');
const Z_LAYERS_PATH = path.join(PROJECT_ROOT, 'lib', 'client-parts', 'foundation', 'z-layers.js');

// 浮层里允许的字面量上限：小于它的多是"元素在自己定位上下文里的局部层级"（如下拉层 20），
// 越过它的几乎一定是"想压住宿主界面"，那必须走统一分配。
const LITERAL_Z_INDEX_LIMIT = 100;

// 部件 → 期望层名。左边是 CSS 选择器（取最外层那条规则），右边是 z-layers.js 里的层名。
const EXPECTED_LAYER_BY_SELECTOR = [
  ['.float-dock', 'dock'],
  ['.float-panel', 'panel'],
  ['.team-app', 'app'],
  ['.modal-mask', 'modal'],
  ['.toast', 'toast'],
];

function listCssFiles() {
  return fs.readdirSync(CSS_DIR).filter((name) => name.endsWith('.css')).map((name) => path.join(CSS_DIR, name));
}

// 极简规则提取：足够覆盖本项目（无嵌套语法、无 @layer）。返回 [{ selector, body, file, line }]
function extractRules(cssText, file) {
  const rules = [];
  const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(stripped)) !== null) {
    const selector = match[1].trim().replace(/\s+/g, ' ');
    if (!selector || selector.startsWith('@')) continue;
    const line = stripped.slice(0, match.index).split('\n').length;
    rules.push({ selector, body: match[2], file, line });
  }
  return rules;
}

function readDeclarations(body) {
  const declarations = {};
  body.split(';').forEach((chunk) => {
    const separator = chunk.indexOf(':');
    if (separator < 0) return;
    const property = chunk.slice(0, separator).trim().toLowerCase();
    const value = chunk.slice(separator + 1).trim();
    if (property) declarations[property] = value;
  });
  return declarations;
}

function loadZLayerOrder() {
  const source = fs.readFileSync(Z_LAYERS_PATH, 'utf8');
  const sandbox = vm.createContext({ console });
  return vm.runInContext(
    `${source}\n;({ pluginZIndex: pluginZIndex, order: PLUGIN_Z_LAYER_ORDER })`,
    sandbox,
    { filename: 'z-layers.js' },
  );
}

function main() {
  const problems = [];
  const rules = listCssFiles().flatMap((file) => extractRules(fs.readFileSync(file, 'utf8'), path.relative(PROJECT_ROOT, file)));
  const zLayers = loadZLayerOrder();

  // ① 无层级魔数：任何字面量 z-index 越过阈值即失败
  rules.forEach((rule) => {
    const declaration = readDeclarations(rule.body)['z-index'];
    if (declaration === undefined) return;
    const literal = /^-?\d+$/.test(declaration) ? Number(declaration) : null;
    if (literal !== null && literal >= LITERAL_Z_INDEX_LIMIT) {
      problems.push(
        `${rule.file}:${rule.line} 「${rule.selector}」的 z-index 是字面量 ${literal}`
        + `（≥ ${LITERAL_Z_INDEX_LIMIT} 必须改引用 var(--dmt-z-<层>)，否则改层级要翻遍所有样式）`,
      );
    }
  });

  // ② 关键部件必须引用正确的层名
  EXPECTED_LAYER_BY_SELECTOR.forEach(([selector, expectedLayer]) => {
    const matched = rules.filter((rule) => rule.selector.split(',').map((part) => part.trim()).includes(selector));
    if (!matched.length) {
      problems.push(`找不到选择器「${selector}」的样式规则（部件被改名或删除？同步更新本门禁）`);
      return;
    }
    const declaration = matched.map((rule) => readDeclarations(rule.body)['z-index']).find(Boolean);
    if (!declaration) {
      problems.push(`「${selector}」没有声明 z-index（浮层会被后来者盖住）`);
      return;
    }
    const expectedVariable = `var(--dmt-z-${expectedLayer}`;
    if (!declaration.includes(expectedVariable)) {
      problems.push(`「${selector}」的 z-index 是「${declaration}」，应引用 ${expectedVariable}…）`);
    }
  });

  // ③ 层级顺序：常量必须严格递增
  const order = zLayers.order;
  const orderChecks = [['dock', 'panel'], ['panel', 'app'], ['app', 'modal'], ['modal', 'toast']];
  orderChecks.forEach(([lower, upper]) => {
    const lowerValue = zLayers.pluginZIndex(lower);
    const upperValue = zLayers.pluginZIndex(upper);
    if (!(lowerValue < upperValue)) {
      problems.push(`层级顺序错误：${lower}(${lowerValue}) 必须低于 ${upper}(${upperValue})`);
    }
  });
  if (order.indexOf('recall') >= 0 && zLayers.pluginZIndex('recall') >= zLayers.pluginZIndex('panel')) {
    problems.push('层级顺序错误：recall 必须低于 panel（呼出按钮不该压住面板）');
  }

  // ④ 提示条：opacity 显隐 + fixed 定位
  const toastBase = rules.find((rule) => rule.selector === '.toast');
  const toastShown = rules.find((rule) => rule.selector === '.toast.show');
  if (!toastBase || !toastShown) {
    problems.push('缺少 .toast 或 .toast.show 规则（提示条无法显示/隐藏）');
  } else {
    const base = readDeclarations(toastBase.body);
    const shown = readDeclarations(toastShown.body);
    if (base.position !== 'fixed') problems.push(`.toast 的 position 是「${base.position}」，应为 fixed`);
    if (base.opacity === undefined) {
      problems.push('.toast 未声明默认 opacity（默认可见会导致一进页面就闪提示条）');
    } else if (Number(base.opacity) !== 0) {
      problems.push(`.toast 默认 opacity 应为 0，实际「${base.opacity}」`);
    }
    if (Number(shown.opacity) !== 1) {
      problems.push(`.toast.show 的 opacity 应为 1（否则淡入到半透明、看起来像没出来），实际「${shown.opacity}」`);
    }
  }

  // ⑤ 弹窗遮罩：全屏 + fixed
  const modalMask = rules.find((rule) => rule.selector === '.modal-mask');
  if (!modalMask) {
    problems.push('缺少 .modal-mask 规则（弹窗没有遮罩层）');
  } else {
    const declarations = readDeclarations(modalMask.body);
    if (declarations.position !== 'fixed') problems.push(`.modal-mask 的 position 是「${declarations.position}」，应为 fixed`);
    const inset = declarations.inset || [declarations.top, declarations.right, declarations.bottom, declarations.left].join(' ');
    if (!inset || !/0/.test(inset)) problems.push('.modal-mask 未铺满视口（缺少 inset: 0 或四边为 0）');
  }

  if (problems.length) {
    console.error(`❌ 样式层门禁失败：${problems.length} 条`);
    problems.forEach((problem) => console.error(`   · ${problem}`));
    return 1;
  }
  console.log(`✅ 样式层一致：${rules.length} 条规则、${EXPECTED_LAYER_BY_SELECTOR.length} 个关键部件层级引用正确、无层级魔数`);
  return 0;
}

process.exit(main());
