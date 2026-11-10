#!/usr/bin/env node
//
// 渲染层门禁（0.4.0 起）：界面只剩主题，所以这里守三件**静态可判**的事：
//   ① 主题源码必须提供契约锚点（面板/球/主窗口/底栏）——缺了就是主题漏实现；
//   ② 面板五字段的取值口径（float/panel-fields.js 纯函数）非空、空输入落占位符；
//   ③ 产物必须内联主题 bundle，且**不得**再含已删除的 legacy 渲染函数
//      （这条正是 0.4.0 删除 legacy 视觉层后的防回潮断言）。
//
// 为什么不再"把后端数据喂给渲染分片再比对 HTML"：那条路依赖 ui/js/view/render.js，
// 该文件已随 legacy 界面整体删除；主题的渲染断言由 `test/theme-tim-pages.test.js` 覆盖。
//
// 退出码：0 = 通过；1 = 有差异。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEMES_DIR = path.join(PROJECT_ROOT, 'ui', 'themes');
const PANEL_FIELDS_PATH = path.join(PROJECT_ROOT, 'ui', 'js', 'float', 'panel-fields.js');
const Z_LAYERS_PATH = path.join(PROJECT_ROOT, 'lib', 'client-parts', 'foundation', 'z-layers.js');
const CLIENT_ARTIFACT_PATH = path.join(PROJECT_ROOT, 'lib', 'client.js');
const THEME_HOST_PATH = path.join(PROJECT_ROOT, 'lib', 'client-parts', 'theme-epilogue.js');

// 已删除的 legacy 渲染函数：产物里再出现就是"有人把旧层搬回来了"
const RETIRED_RENDER_SYMBOLS = Object.freeze([
  'function renderGroupList',
  'function renderChat',
  'function renderAddGroup',
  'function renderAddressBook',
  'function renderProfile',
  'function initFloatControls',
  'function initViewEvents',
]);

// 主题必须提供的契约锚点（与 check-contract 的"保留"集合一致）
const REQUIRED_THEME_ANCHORS = Object.freeze(['floatBall', 'floatPanel', 'fpHead', 'fpTitle', 'fpEnter']);

function readThemes() {
  return fs.readdirSync(THEMES_DIR)
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => ({ name, source: fs.readFileSync(path.join(THEMES_DIR, name), 'utf8') }));
}

function loadPanelFields() {
  const source = fs.readFileSync(PANEL_FIELDS_PATH, 'utf8');
  const sandbox = { globalThis: {}, module: { exports: {} }, exports: {} };
  return vm.runInNewContext(`${source}\n;({ buildPanelFieldTexts: buildPanelFieldTexts })`, sandbox, { filename: 'panel-fields.js' });
}

function loadZLayerOrder() {
  const source = fs.readFileSync(Z_LAYERS_PATH, 'utf8');
  return vm.runInNewContext(`${source}\n;({ pluginZIndex: pluginZIndex })`, {}, { filename: 'z-layers.js' });
}

function main() {
  const problems = [];
  const themes = readThemes();
  if (themes.length === 0) {
    console.error('❌ 渲染门禁失败：ui/themes 下没有 .tsx 主题');
    return 1;
  }

  // ① 主题锚点
  for (const anchorId of REQUIRED_THEME_ANCHORS) {
    const provided = themes.some(({ source }) => source.includes(`id="${anchorId}"`));
    if (!provided) problems.push(`主题源码缺少 #${anchorId}（契约锚点，docs/03 §2.1~§2.2）`);
  }

  // ② 面板五字段口径（纯函数，不依赖 DOM）
  const panelFields = loadPanelFields();
  const sample = panelFields.buildPanelFieldTexts({
    groupName: 'agnes(本机)',
    sessionId: 'session-0123456789abcdef',
    sessionTitle: '示例会话',
    target: { type: 'model', id: 'agnes-3.0-flash', platformId: 'agnes' },
    rate: '12.3 tok/s',
    globalText: '1.2K tok',
  });
  for (const [fieldKey, fieldValue] of Object.entries(sample || {})) {
    if (typeof fieldValue !== 'string' || fieldValue.trim().length === 0) {
      problems.push(`面板字段 ${fieldKey} 空值时没有占位符（会渲染成空白）`);
    }
  }
  // 空输入：每个字段都必须落到占位符（不能渲染成空白）
  const emptySample = panelFields.buildPanelFieldTexts({});
  for (const [fieldKey, fieldValue] of Object.entries(emptySample || {})) {
    if (String(fieldValue == null ? '' : fieldValue).trim().length === 0) {
      problems.push(`面板字段 ${fieldKey} 空输入时没有占位符`);
    }
  }

  // ③ 层级：面板必须低于主窗口
  const zLayers = loadZLayerOrder();
  if (!(zLayers.pluginZIndex('panel') < zLayers.pluginZIndex('app'))) {
    problems.push(`面板层级不低于主窗口：panel=${zLayers.pluginZIndex('panel')} app=${zLayers.pluginZIndex('app')}`);
  }

  // ④ 产物：主题 bundle 在、legacy 渲染函数不在
  const artifact = fs.readFileSync(CLIENT_ARTIFACT_PATH, 'utf8');
  if (!artifact.includes('var THEME_FACTORY = function')) problems.push('产物缺少主题 bundle（THEME_FACTORY）');
  if (!artifact.includes('var THEME_META = ')) problems.push('产物缺少主题 meta（THEME_META）');
  for (const symbol of RETIRED_RENDER_SYMBOLS) {
    if (artifact.includes(symbol)) problems.push(`产物里仍有已删除的 legacy 渲染函数：${symbol}`);
  }
  const themeHostSource = fs.readFileSync(THEME_HOST_PATH, 'utf8');
  if (!/zIndex\s*=\s*["']var\(--dmt-z-app\)["']/.test(themeHostSource)) {
    problems.push('theme-epilogue.js：宿主容器没有用 var(--dmt-z-app) 写层级');
  }

  if (problems.length > 0) {
    console.error(`❌ 渲染门禁失败：${problems.length} 条`);
    for (const problem of problems) console.error(`   · ${problem}`);
    return 1;
  }
  console.log(`✅ 渲染契约通过：${themes.length} 个主题锚点齐全、面板五字段有占位、层级 panel < app、`
    + `产物含主题 bundle 且不含 legacy 渲染函数（${RETIRED_RENDER_SYMBOLS.length} 个黑名单）`);
  return 0;
}

process.exit(main());
