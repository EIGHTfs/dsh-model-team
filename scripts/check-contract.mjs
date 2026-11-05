#!/usr/bin/env node
//
// 契约一致性门禁。目前覆盖两项：
//   ① 端点表：docs/02-契约.md §二 ↔ src/gateway/routes.js 的 ROUTES
//   ② DOM 钩子：docs/03-UI规范.md §2.1~§2.2 ↔ ui/index.html
//
// 需求意图：文档与代码的「同一事实两处表达」必须由机器钉死，靠人核对必然复发
//          （历史上出现过文档写 15 个端点而代码实际 25 个）。
// 为什么用文本解析而不是 import 源码：routes.js 依赖 drivers/index 等模块，
//          import 会触发驱动扫描副作用；门禁本身必须无副作用。
// 退出码：0 = 全部一致；1 = 有差异（并打印差异明细）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');

const ROUTES_FILE = path.join(PROJECT_ROOT, 'src/gateway/routes/index.js');
const CONSTANTS_FILE = path.join(PROJECT_ROOT, 'src/gateway/config/constants.js');
const CONTRACT_FILE = path.join(PROJECT_ROOT, 'docs/02-契约.md');
const UI_SPEC_FILE = path.join(PROJECT_ROOT, 'docs/03-UI规范.md');
const THEME_HTML_FILE = path.join(PROJECT_ROOT, 'ui/index.html');

const EXIT_OK = 0;
const EXIT_MISMATCH = 1;

// 状态类由 JS 在运行时添加，不应出现在静态 html 里；校验时必须排除，
// 否则每次都会误报「主题缺 .hidden」。
const STATE_ONLY_HOOKS = new Set(['.hidden', '.is-dragging', '[aria-selected="true"]']);

/** 从 constants.js 读端点前缀，避免门禁自己再写一份 "/_team" 造成第三处真源 */
function readApiPrefix() {
  const source = fs.readFileSync(CONSTANTS_FILE, 'utf8');
  const matched = source.match(/API_PREFIX\s*=\s*['"]([^'"]+)['"]/);
  if (!matched) throw new Error(`无法从 ${CONSTANTS_FILE} 解析 API_PREFIX`);
  return matched[1];
}

/** 把模板字面量里的 ${API_PREFIX} 还原成实际前缀，与契约文档写法对齐 */
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

  // 解析自检：上面按「第一个行首 ]」截断。若数组里出现多行对象，或在结束标记之后又追加了路由，
  // 会静默少解析几条——那时差异会伪装成「契约写多了」，把门禁引向错误结论（去改文档而不是查解析）。
  // 用整份文件里 `{ method:` 的出现次数对账，不一致就当场报解析失败，不进入比对。
  const declaredCount = (source.match(/\{\s*method\s*:/g) || []).length;
  if (entries.length !== declaredCount) {
    throw new Error(`ROUTES 解析不完整：解析到 ${entries.length} 条 / 文件里有 ${declaredCount} 条（检查 routes.js 是否出现多行路由对象，或数组结束标记之后还有追加项）`);
  }
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

/** 解析 UI 规范 §2.1~§2.2：抓 `#id` 与 `.class` 两种钩子 */
function readRequiredUiHooks() {
  const source = fs.readFileSync(UI_SPEC_FILE, 'utf8');
  const sectionStart = source.indexOf('### 2.1');
  const sectionEnd = source.indexOf('### 2.3', sectionStart);
  if (sectionStart < 0 || sectionEnd < 0) {
    throw new Error('UI 规范没有找到 §2.1 或 §2.3 的边界');
  }
  const section = source.slice(sectionStart, sectionEnd);

  const hookPattern = /`([#.][A-Za-z][A-Za-z0-9_-]*)`/g;
  const hooks = new Set();
  let matched;
  while ((matched = hookPattern.exec(section)) !== null) {
    const hook = matched[1];
    if (!STATE_ONLY_HOOKS.has(hook)) hooks.add(hook);
  }
  if (hooks.size === 0) throw new Error('UI 规范解析结果为空，可能是表格格式变了');
  return [...hooks];
}

/** 在主题 html 里查钩子是否存在：`#x` 查 id="x"，`.x` 查 class 里含 x */
function isHookPresentInTheme(themeSource, hook) {
  const name = hook.slice(1);
  if (hook.startsWith('#')) return new RegExp(`id=["']${name}["']`).test(themeSource);
  return new RegExp(`class=["'][^"']*\\b${name}\\b`).test(themeSource);
}

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

function checkEndpoints() {
  const apiPrefix = readApiPrefix();
  const routeEntries = readRoutes(apiPrefix);
  const contractEntries = readContractEndpoints();
  const onlyInContract = difference(contractEntries, routeEntries);
  const onlyInRoutes = difference(routeEntries, contractEntries);

  if (onlyInContract.length === 0 && onlyInRoutes.length === 0) {
    console.log(`✅ 端点一致：${routeEntries.length} 条（契约与路由表逐条对应）`);
    return true;
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
  return false;
}

function checkUiHooks() {
  const requiredHooks = readRequiredUiHooks();
  const themeSource = fs.readFileSync(THEME_HTML_FILE, 'utf8');
  const missing = requiredHooks.filter((hook) => !isHookPresentInTheme(themeSource, hook));

  if (missing.length === 0) {
    console.log(`✅ DOM 钩子齐全：${requiredHooks.length} 个（主题 html 均含）`);
    return true;
  }

  console.error('❌ DOM 钩子缺失（主题没实现契约要求的锚点）：');
  for (const hook of missing) console.error(`    - ${hook}`);
  console.error(`\n  契约要求 ${requiredHooks.length} 个 / 缺失 ${missing.length} 个`);
  return false;
}

// INV-14 的代码级红线：显隐只能由判定结论驱动，不许在别处「强制显示」。
// 历史事故：槽位注册失败时曾 applyDockVisibility(true)「降级为显示」，
// 结果任何模型下都挂着一个球——与 INV-14「判不了就隐藏」直接冲突。
function checkDockVisibilityRedLine() {
  const clientPartsDir = path.join(PROJECT_ROOT, 'lib', 'client-parts');
  const offenders = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(fullPath); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const source = fs.readFileSync(fullPath, 'utf8');
      source.split('\n').forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//')) return;          // 注释里提到不算违规
        if (/applyDockVisibility\(\s*true\s*\)/.test(line)) {
          offenders.push(`${path.relative(PROJECT_ROOT, fullPath)}:${index + 1}`);
        }
      });
    }
  };
  walk(clientPartsDir);
  if (!offenders.length) {
    console.log('✅ INV-14 红线：客户端没有「绕过判定强制显示」的写死路径');
    return true;
  }
  console.error('❌ INV-14 红线被越：以下位置强制显示悬浮球（只能由判定结论 ours 驱动）');
  offenders.forEach((spot) => console.error(`   · ${spot}`));
  return false;
}

function main() {
  // 解析类异常（契约/路由文件格式变了、ROUTES 少解析）单独收敛成一行错误：
  // 直接抛栈会淹没真正要看的那句「解析到 N 条 / 文件里有 M 条」。
  try {
    const endpointResult = checkEndpoints();
    const uiHookResult = checkUiHooks();
    const dockRedLineOk = checkDockVisibilityRedLine();
    return endpointResult && uiHookResult && dockRedLineOk ? EXIT_OK : EXIT_MISMATCH;
  } catch (parseError) {
    console.error(`❌ ${parseError?.message || parseError}`);
    return EXIT_MISMATCH;
  }
}

process.exit(main());
