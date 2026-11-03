#!/usr/bin/env node
//
// 契约一致性门禁：docs/02-契约.md 的端点表 vs src/gateway/routes.js 的路由表。
//
// 需求意图：端点表曾出现「文档写 15 个、代码实际 25 个」的漂移，靠人眼核对必然复发；
//           把这条比对做成可执行门禁，改端点漏改文档时立刻变红。
// 为什么用文本解析而不是 import routes.js：routes 依赖 drivers/index 等模块，
//           直接 import 会触发驱动扫描等副作用，门禁本身不该产生副作用。
// 退出码：0 = 一致；1 = 有差异（并打印差异明细）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const ROUTES_FILE = path.join(PROJECT_ROOT, 'src/gateway/routes.js');
const CONSTANTS_FILE = path.join(PROJECT_ROOT, 'src/gateway/constants.js');
const CONTRACT_FILE = path.join(PROJECT_ROOT, 'docs/02-契约.md');

const EXIT_OK = 0;
const EXIT_MISMATCH = 1;

/** 从 constants.js 读端点前缀，避免门禁自己再写一份 "/_team" 造成第三处真源 */
function readApiPrefix() {
  const source = fs.readFileSync(CONSTANTS_FILE, 'utf8');
  const matched = source.match(/API_PREFIX\s*=\s*['"]([^'"]+)['"]/);
  if (!matched) throw new Error(`无法从 ${CONSTANTS_FILE} 解析 API_PREFIX`);
  return matched[1];
}

/** 把模板字面量里的 ${API_PREFIX} 还原成实际前缀，与契约文档里的写法对齐 */
function normalizePattern(rawPattern, apiPrefix) {
  return rawPattern.replace(/\$\{API_PREFIX\}/g, apiPrefix).trim();
}

/** 解析 routes.js：抓 { method: 'X', pattern: '...' 或 `...` } 两种写法 */
function readRoutes(apiPrefix) {
  const source = fs.readFileSync(ROUTES_FILE, 'utf8');
  // 声明段从 `export const ROUTES` 到其后第一个行首的 `]`（数组元素都是单行对象，
  // 行首 `]` 只会出现在数组结束处；结尾可能是 `]);` 也可能是 `].map(...)`）
  const declarationStart = source.indexOf('export const ROUTES');
  if (declarationStart < 0) throw new Error(`无法在 ${ROUTES_FILE} 定位 ROUTES 声明段`);
  const declarationEnd = source.indexOf('\n]', declarationStart);
  if (declarationEnd < 0) throw new Error('ROUTES 声明段没有找到结束的 ]');
  const declaration = source.slice(declarationStart, declarationEnd + 2);

  const entryPattern = /\{\s*method:\s*'([A-Z]+)',\s*pattern:\s*(?:'([^']*)'|`([^`]*)`)/g;
  const entries = [];
  let matched;
  while ((matched = entryPattern.exec(declaration)) !== null) {
    const method = matched[1];
    const rawPattern = matched[2] ?? matched[3] ?? '';
    entries.push(`${method} ${normalizePattern(rawPattern, apiPrefix)}`);
  }
  if (entries.length === 0) throw new Error('ROUTES 解析结果为空，可能是写法变了');
  return entries;
}

/** 解析契约文档：只认 §二 端点总表章节内的「| 序号 | 方法 | `路径` |」表格行 */
function readContractEndpoints() {
  const source = fs.readFileSync(CONTRACT_FILE, 'utf8');
  const sectionStart = source.indexOf('## 二、端点总表');
  const sectionEnd = source.indexOf('## 三、', sectionStart);
  if (sectionStart < 0 || sectionEnd < 0) {
    throw new Error('契约文档没有找到 §二 端点总表 或 §三 的边界');
  }
  const section = source.slice(sectionStart, sectionEnd);

  const rowPattern = /^\|\s*\d+\s*\|\s*(GET|POST|PUT|DELETE)\s*\|\s*`([^`]+)`/gm;
  const entries = [];
  let matched;
  while ((matched = rowPattern.exec(section)) !== null) {
    entries.push(`${matched[1]} ${matched[2].trim()}`);
  }
  if (entries.length === 0) throw new Error('契约文档解析结果为空，可能是表格格式变了');
  return entries;
}

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

function main() {
  const apiPrefix = readApiPrefix();
  const routeEntries = readRoutes(apiPrefix);
  const contractEntries = readContractEndpoints();

  const onlyInContract = difference(contractEntries, routeEntries);
  const onlyInRoutes = difference(routeEntries, contractEntries);

  if (onlyInContract.length === 0 && onlyInRoutes.length === 0) {
    console.log(`✅ 端点一致：${routeEntries.length} 条（契约与路由表逐条对应）`);
    return EXIT_OK;
  }

  console.error('❌ 端点不一致：');
  if (onlyInContract.length > 0) {
    console.error('  契约里有、routes.js 里没有（文档写多了或代码删了端点）：');
    for (const item of onlyInContract) console.error(`    - ${item}`);
  }
  if (onlyInRoutes.length > 0) {
    console.error('  routes.js 里有、契约里没有（新增端点忘了写文档）：');
    for (const item of onlyInRoutes) console.error(`    + ${item}`);
  }
  console.error(`\n  契约 ${contractEntries.length} 条 / 路由 ${routeEntries.length} 条`);
  return EXIT_MISMATCH;
}

process.exit(main());
