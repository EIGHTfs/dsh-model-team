#!/usr/bin/env node
// check-css.mjs —— 样式层门禁：不启浏览器，直接对**主题内联样式**与层级常量做断言。
//
// 0.4.0 起 legacy 的 ui/css/** 与 ui/app.css 已移除，界面样式全部来自主题 TSX 的 THEME_STYLES。
// 本门禁保留它原本最有价值的两条判据（这两类缺陷历史上真实出现过、且只能静态判定）：
//   ① 层级只许来自 z-layers.js：主题里**不得出现宿主级 z-index 字面量**（2147482xxx），
//      也不得有 ≥ 100 的字面量（那几乎一定是"想压住宿主界面"，必须走统一分配）；
//      主题内部的相对层级（1/2/3…）允许——它只表达同一容器内的先后。
//   ② 层级顺序常量必须严格递增（dock/recall < panel < app < modal < toast）。
//
// 已随 legacy 一起下线的判据（记在这里，避免以后有人问"为什么没检查了"）：
//   · `.float-dock/.float-panel/.team-app/.modal-mask/.toast` 的选择器映射 —— 那些类名属于 legacy 骨架；
//     主题用自有类名，契约锚点由 check-contract（主题源码）守。
//   · `.toast` 的 opacity 显隐、`.modal-mask` 的 inset —— 同属 legacy 选择器，主题各有实现方式。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEMES_DIR = path.join(PROJECT_ROOT, 'ui', 'themes');
const THEME_HOST_PATH = path.join(PROJECT_ROOT, 'lib', 'client-parts', 'theme-epilogue.js');
const Z_LAYERS_PATH = path.join(PROJECT_ROOT, 'lib', 'client-parts', 'foundation', 'z-layers.js');

// 主题里允许的最大"局部"层级：超过它基本等于想压住宿主界面
const LITERAL_Z_INDEX_LIMIT = 100;
// 宿主级层级基数（z-layers.js 的 PLUGIN_Z_BASE）：出现即违规，主题不该持这个数值
const HOST_LAYER_LITERAL_PATTERN = /z-index:\s*2147482\d{3}/;

function listThemeFiles() {
  return fs.readdirSync(THEMES_DIR)
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => path.join(THEMES_DIR, name));
}

/** 取主题里所有 `z-index: …` 声明（含数值与变量两种形态） */
function readZIndexDeclarations(themeSource) {
  return [...themeSource.matchAll(/z-index:\s*([^;}\n]+)/g)].map((matched) => matched[1].trim());
}

function loadZLayerOrder() {
  const source = fs.readFileSync(Z_LAYERS_PATH, 'utf8');
  const sandbox = { globalThis: {}, module: { exports: {} }, exports: {} };
  vm.runInNewContext(
    `${source}\n;({ pluginZIndex: pluginZIndex, order: PLUGIN_Z_LAYER_ORDER })`,
    sandbox,
    { filename: 'z-layers.js' },
  );
  return vm.runInNewContext(
    `${source}\n;({ pluginZIndex: pluginZIndex, order: PLUGIN_Z_LAYER_ORDER })`,
    {},
  );
}

function main() {
  const problems = [];
  const themeFiles = listThemeFiles();
  if (themeFiles.length === 0) {
    console.error('❌ 样式层门禁失败：ui/themes 下没有 .tsx 主题（界面样式已无来源）');
    return 1;
  }

  // ① 主题不得持宿主级层级字面量；≥100 的字面量也要报（应走变量或容器内部小序号）
  for (const themeFile of themeFiles) {
    const themeSource = fs.readFileSync(themeFile, 'utf8');
    const relativePath = path.relative(PROJECT_ROOT, themeFile);
    if (HOST_LAYER_LITERAL_PATTERN.test(themeSource)) {
      problems.push(`${relativePath}：出现宿主级 z-index 字面量（2147482xxx 必须由宿主容器用 var(--dmt-z-app) 给）`);
    }
    for (const declaration of readZIndexDeclarations(themeSource)) {
      if (!/^\d+$/.test(declaration)) continue;   // var(--dmt-z-*)/calc()/常量表达式都放行
      const literalValue = Number(declaration);
      if (literalValue >= LITERAL_Z_INDEX_LIMIT) {
        problems.push(`${relativePath}：z-index 字面量 ${literalValue} ≥ ${LITERAL_Z_INDEX_LIMIT}（应引用 var(--dmt-z-<层>) 或用容器内部小序号）`);
      }
    }
  }

  // ② 宿主容器必须用变量写跨宿主层级（否则主题与宿主的层级关系不受控）
  const themeHostSource = fs.readFileSync(THEME_HOST_PATH, 'utf8');
  if (!/zIndex\s*=\s*["']var\(--dmt-z-app\)["']/.test(themeHostSource)) {
    problems.push('theme-epilogue.js：宿主容器没有用 var(--dmt-z-app) 写层级（跨宿主层级必须由变量给）');
  }

  // ③ 层级顺序常量严格递增
  const zLayers = loadZLayerOrder();
  const orderChecks = [['dock', 'panel'], ['panel', 'app'], ['app', 'modal'], ['modal', 'toast']];
  for (const [lower, upper] of orderChecks) {
    const lowerValue = zLayers.pluginZIndex(lower);
    const upperValue = zLayers.pluginZIndex(upper);
    if (!(lowerValue < upperValue)) {
      problems.push(`层级顺序错误：${lower}(${lowerValue}) 必须低于 ${upper}(${upperValue})`);
    }
  }
  if (zLayers.order.indexOf('recall') >= 0 && zLayers.pluginZIndex('recall') >= zLayers.pluginZIndex('panel')) {
    problems.push('层级顺序错误：recall 必须低于 panel（呼出按钮不该压住面板）');
  }

  if (problems.length) {
    console.error(`❌ 样式层门禁失败：${problems.length} 条`);
    for (const problem of problems) console.error(`   · ${problem}`);
    return 1;
  }
  console.log(`✅ 样式层一致：${themeFiles.length} 个主题、层级只来自 z-layers.js、顺序正确`);
  return 0;
}

process.exit(main());
