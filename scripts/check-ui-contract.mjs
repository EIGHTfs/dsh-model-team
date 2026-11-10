#!/usr/bin/env node
//
// 界面约束门禁（0.4.0 起）。三条都是**静态可判**、且不依赖任何渲染分片：
//   U-3  界面源码不得出现平台名字面量（平台名只能来自声明：config/platforms.json 与反代自描述）
//   U-7  加群下拉的"选项投影"只许 {id,label}——不允许把 baseURL / modelsEndpoint 这类值塞进选项
//   U-8  主题源码不得出现值字段名（值显分离：值归 store/add-form.js，主题只渲染）
//
// 为什么不再"执行 render.js 再比对 HTML"：渲染层（ui/js/view/render.js）已随 legacy 界面删除；
// 主题的渲染断言由 test/theme-tim-pages.test.js 与 scripts/check-render.mjs 的产物断言覆盖。
//
// 退出码：0 = 通过；1 = 有不一致。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORM_PRESET_PATH = path.join(PROJECT_ROOT, 'config', 'platforms.json');
const REVERSE_PLATFORMS_DIRECTORY = path.join(PROJECT_ROOT, 'src', 'reverse', 'platforms');
const UI_JS_DIRECTORY = path.join(PROJECT_ROOT, 'ui', 'js');
const THEMES_DIRECTORY = path.join(PROJECT_ROOT, 'ui', 'themes');
const DRIVER_VIEW_PATH = path.join(UI_JS_DIRECTORY, 'format', 'driver-view.js');

// 平台名太短（如 "ai"）会误伤普通英文单词，达不到 3 个字符的一律不参与扫描
const MIN_PLATFORM_NAME_LENGTH = 3;
// 主题里不允许出现的"值字段名"（值显分离的硬判据）
const FORBIDDEN_THEME_FIELD_NAMES = Object.freeze(['baseURL', 'modelsEndpoint', 'driverId']);

function readTextFile(absolutePath) {
  return fs.readFileSync(absolutePath, 'utf8');
}

function listFilesRecursive(directory, extension) {
  const collected = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collected.push(...listFilesRecursive(fullPath, extension));
    else if (entry.name.endsWith(extension)) collected.push(fullPath);
  }
  return collected;
}

/** 扫描前去掉注释：注释不会渲染到界面上，判红只会逼人删掉有用的说明 */
function stripCommentsForScan(sourceText) {
  const withoutBlockComments = sourceText.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''));
  return withoutBlockComments.split('\n')
    .map((line) => {
      const commentIndex = line.search(/(^|\s)\/\//);
      return commentIndex < 0 ? line : line.slice(0, commentIndex);
    })
    .join('\n');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 平台名的真源：预置清单 + 反代自描述目录名 */
function readDeclaredPlatformNames(problems) {
  const names = new Map();
  try {
    const presets = JSON.parse(readTextFile(PLATFORM_PRESET_PATH));
    for (const platform of presets.platforms || []) {
      for (const declaredName of [platform.id, platform.name]) {
        if (typeof declaredName === 'string') names.set(declaredName.toLowerCase(), declaredName);
      }
    }
  } catch (error) {
    problems.push(`读不到平台预置真源 config/platforms.json（${error.message}）——没有真源就无法判断哪些名字算平台名`);
  }
  try {
    for (const entry of fs.readdirSync(REVERSE_PLATFORMS_DIRECTORY, { withFileTypes: true })) {
      if (entry.isDirectory()) names.set(entry.name.toLowerCase(), entry.name);
    }
  } catch {
    // 反代目录不存在时只用预置清单：不因此判失败
  }
  return [...names.values()].filter((name) => name.length >= MIN_PLATFORM_NAME_LENGTH);
}

function checkNoPlatformNameLiteral() {
  const problems = [];
  const platformNames = readDeclaredPlatformNames(problems);
  const scannedFiles = [
    ...listFilesRecursive(UI_JS_DIRECTORY, '.js'),
    ...listFilesRecursive(THEMES_DIRECTORY, '.tsx'),
  ];
  if (scannedFiles.length === 0) return ['没有可扫描的界面源码（ui/js 与 ui/themes 都不存在）'];
  if (platformNames.length === 0) return ['没有取到任何平台名——扫描清单为空时不能算通过'];

  const patterns = platformNames.map((name) => ({
    name,
    pattern: new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(name)}([^A-Za-z0-9_]|$)`, 'i'),
  }));
  for (const filePath of scannedFiles) {
    const relativePath = path.relative(PROJECT_ROOT, filePath).split(path.sep).join('/');
    const originalLines = readTextFile(filePath).split('\n');
    stripCommentsForScan(readTextFile(filePath)).split('\n').forEach((scannedLine, index) => {
      for (const { name, pattern } of patterns) {
        if (!pattern.test(scannedLine)) continue;
        problems.push(`${relativePath}:${index + 1} 出现平台名字面量「${name}」：${String(originalLines[index] || scannedLine).trim().slice(0, 120)}`);
      }
    });
  }
  return problems;
}

function loadDriverView() {
  const source = readTextFile(DRIVER_VIEW_PATH);
  return vm.runInNewContext(`${source}\n;({ listGroupOptions: listGroupOptions })`, {}, { filename: 'driver-view.js' });
}

function checkGroupOptionProjection() {
  const problems = [];
  const { listGroupOptions } = loadDriverView();
  const options = listGroupOptions(
    [{ id: 'openai-compatible', name: '通用入口' }],
    [{ id: 'preset-a', name: '预置甲', baseURL: 'https://example.invalid/v1', modelsEndpoint: '/models' }],
  );
  if (!Array.isArray(options) || options.length !== 2) {
    problems.push(`选项投影条数不对：期望 2（1 预置 + 1 驱动），实际 ${Array.isArray(options) ? options.length : typeof options}`);
    return problems;
  }
  for (const option of options) {
    const keys = Object.keys(option).sort().join(',');
    if (keys !== 'id,label') problems.push(`选项必须只有 id 与 label，实际键：${keys}`);
    if (typeof option.id !== 'string' || typeof option.label !== 'string') problems.push('选项的 id/label 必须是字符串');
  }
  // 预置项的"值"绝不允许出现在投影里
  const projected = JSON.stringify(options);
  for (const forbidden of ['https://example.invalid', '/models', 'baseURL', 'modelsEndpoint']) {
    if (projected.includes(forbidden)) problems.push(`选项投影里混进了值字段内容：${forbidden}`);
  }
  return problems;
}

function checkThemeHasNoValueFields() {
  const problems = [];
  const themeFiles = listFilesRecursive(THEMES_DIRECTORY, '.tsx');
  if (themeFiles.length === 0) return ['ui/themes 下没有 .tsx 主题'];
  for (const filePath of themeFiles) {
    const relativePath = path.relative(PROJECT_ROOT, filePath).split(path.sep).join('/');
    const sourceText = readTextFile(filePath);
    for (const fieldName of FORBIDDEN_THEME_FIELD_NAMES) {
      if (sourceText.includes(fieldName)) {
        problems.push(`${relativePath} 出现值字段名「${fieldName}」——值应归 store/add-form.js，主题只渲染`);
      }
    }
  }
  return problems;
}

const ASSERTIONS = [
  { id: 'U-3', title: '界面源码无平台名字面量', run: checkNoPlatformNameLiteral },
  { id: 'U-7', title: '加群选项投影只有 id/label', run: checkGroupOptionProjection },
  { id: 'U-8', title: '主题不含值字段名（值显分离）', run: checkThemeHasNoValueFields },
];

function main() {
  console.log('🔎 界面约束门禁（0.4.0：U-3 / U-7 / U-8，全部静态判定）');
  let failed = 0;
  for (const assertion of ASSERTIONS) {
    const problems = assertion.run();
    if (problems.length === 0) {
      console.log(`✅ ${assertion.id} ${assertion.title}`);
      continue;
    }
    failed += 1;
    console.error(`❌ ${assertion.id} ${assertion.title}：${problems.length} 处`);
    for (const problem of problems.slice(0, 10)) console.error(`   · ${problem}`);
  }
  const passed = ASSERTIONS.length - failed;
  console.log(passed === ASSERTIONS.length ? `✅ ${passed}/${ASSERTIONS.length} 通过` : `❌ ${passed}/${ASSERTIONS.length} 通过`);
  return passed === ASSERTIONS.length ? 0 : 1;
}

process.exit(main());
