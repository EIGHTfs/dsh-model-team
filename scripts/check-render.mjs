#!/usr/bin/env node
//
// 渲染 vs 返回 比对门禁。
//
// 为什么需要它：check-contract 只比「端点表 ↔ 路由表」与「DOM 钩子」，单测用的是构造数据；
// 而真实事故是「接口返回 3 个群、界面渲染 0 个」——数据在穿层时丢了，两边各自看都正常。
// 这里把**后端真实返回**喂给**仓库里的渲染分片**，直接核对条数 / id 集合 / 驱动列。
//
// 用法：
//   node scripts/check-render.mjs
//   DMT_BACKEND=http://127.0.0.1:30800 node scripts/check-render.mjs
//
// 退出码：0 = 渲染与返回一致；1 = 有差异或后端不可用。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const RENDER_SOURCE_PATH = path.join(PROJECT_ROOT, 'ui/js/render.js');

// 缺省打运行中的插件宿主；换了端口用 DMT_BACKEND 覆盖，不写死第二处地址
const BACKEND_BASE = (process.env.DMT_BACKEND || 'http://127.0.0.1:30801').replace(/\/+$/, '');
const GROUPS_ENDPOINT = `${BACKEND_BASE}/_team/groups`;
const REQUEST_TIMEOUT_MS = 8000;

const EXIT_OK = 0;
const EXIT_MISMATCH = 1;

/**
 * 在隔离上下文里执行渲染分片，取回纯渲染函数。
 * 为什么用 vm 而不是字符串求值：分片是"给浏览器用的普通脚本"（没有 export），
 * 要拿到其中函数只能执行它；vm 给它一个空沙箱，既拿得到函数，也不会污染门禁进程的全局。
 * render.js 的函数在调用时才碰全局（escapeHtml 等都在同文件内定义），空沙箱足够。
 */
function loadRenderLayer() {
  const source = fs.readFileSync(RENDER_SOURCE_PATH, 'utf8');
  const sandbox = vm.createContext({ console });
  const exported = vm.runInContext(
    `${source}\n;({ renderGroupList: renderGroupList, renderChat: renderChat })`,
    sandbox,
    { filename: 'ui/js/render.js' },
  );
  return exported;
}

/**
 * 纯渲染断言（不需要后端、不需要浏览器、不需要宿主 projection）。
 * 为什么放在这道门禁里：G-dock 之后「依赖悬浮球显隐」的场景在预览垫片下跑不了，
 * 而面板本体的正确性（五个字段有内容、层级低于主窗口）必须仍然被机器守住。
 * 这里直接跑 float.js 的 buildPanelFieldTexts 与 z-layers.js 的层级函数——
 * 与运行时用的是同一份代码，不是复制品。
 */
function loadFloatPanelTexts() {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, 'ui/js/float.js'), 'utf8');
  const sandbox = vm.createContext({ console });
  return vm.runInContext(
    `${source}\n;({ buildPanelFieldTexts: buildPanelFieldTexts })`,
    sandbox,
    { filename: 'ui/js/float.js' },
  );
}

function loadZLayerOrder() {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, 'lib/client-parts/foundation/z-layers.js'), 'utf8');
  const sandbox = vm.createContext({ console });
  return vm.runInContext(
    `${source}\n;({ pluginZIndex: pluginZIndex })`,
    sandbox,
    { filename: 'lib/client-parts/foundation/z-layers.js' },
  );
}

function checkPanelRenderContract() {
  const problems = [];
  const LOADING_PLACEHOLDER = /加载中|loading|正在/i;

  // ① 五个字段的文案函数：给一份"数据都到齐"的输入，输出必须全部有内容且不是加载中
  const { buildPanelFieldTexts } = loadFloatPanelTexts();
  const texts = buildPanelFieldTexts({
    groupName: '示例平台群',
    sessionLabel: '示例会话（abcdef12）',
    targetLabel: '示例模型',
    rate: '12.5 tok/s',
    globalText: '34 次 (总计 5.6k tok)',
  });
  for (const fieldName of ['fpGroup', 'fpSession', 'fpTarget', 'fpRate', 'fpTotal']) {
    const value = String(texts[fieldName] || '').trim();
    if (!value) problems.push(`面板字段 ${fieldName} 渲染为空`);
    else if (LOADING_PLACEHOLDER.test(value)) problems.push(`面板字段 ${fieldName} 渲染成加载中：${value}`);
  }
  // ② 空输入也必须落回占位符（禁止空字符串——空字段在界面上就是"没接上"）
  const emptyTexts = buildPanelFieldTexts({});
  for (const fieldName of ['fpGroup', 'fpSession', 'fpTarget', 'fpRate', 'fpTotal']) {
    if (!String(emptyTexts[fieldName] || '').trim()) problems.push(`面板字段 ${fieldName} 空输入时没有占位符`);
  }
  // ③ 层级：面板必须低于主窗口（方向别搞反）
  const { pluginZIndex } = loadZLayerOrder();
  if (!(pluginZIndex('panel') < pluginZIndex('app'))) {
    problems.push(`面板层级不低于主窗口：panel=${pluginZIndex('panel')} app=${pluginZIndex('app')}`);
  }
  // ④ 五个字段的 DOM 锚点必须在主题骨架里存在（否则运行时 setFloatText 找不到节点）
  const themeHtml = fs.readFileSync(path.join(PROJECT_ROOT, 'ui/index.html'), 'utf8');
  for (const fieldName of ['fpGroup', 'fpSession', 'fpTarget', 'fpRate', 'fpTotal', 'fpClose']) {
    if (!themeHtml.includes(`id="${fieldName}"`)) problems.push(`主题骨架缺少 #${fieldName}`);
  }
  return problems;
}

/** 读后端真实群列表：任何失败都要给出可执行的提示，而不是静默空数组 */
async function fetchGroups() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(GROUPS_ENDPOINT, { signal: controller.signal });
  } catch (networkError) {
    throw new Error(`连不上后端 ${GROUPS_ENDPOINT}（${networkError.message}）；先起插件宿主，或用 DMT_BACKEND 指定地址`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`GET ${GROUPS_ENDPOINT} 返回 HTTP ${response.status}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch (parseError) {
    throw new Error(`GET ${GROUPS_ENDPOINT} 返回的不是 JSON（${parseError.message}）`);
  }
  const groups = Array.isArray(payload) ? payload : payload && payload.groups;
  if (!Array.isArray(groups)) {
    throw new Error(`GET ${GROUPS_ENDPOINT} 响应里没有 groups 数组`);
  }
  return groups;
}

/** 从渲染结果里抓出实际渲染出来的群 id（顺序保留，便于报告缺失项） */
function extractRenderedIds(html) {
  const ids = [];
  const idPattern = /data-group-id="([^"]*)"/g;
  let matched;
  while ((matched = idPattern.exec(html)) !== null) {
    ids.push(matched[1]);
  }
  return ids;
}

function countRenderedItems(html) {
  const itemPattern = /class="group-item(?:\s|")/g;
  return (html.match(itemPattern) || []).length;
}

function describeDifference({ renderedIds, apiIds, groups, html }) {
  const renderedSet = new Set(renderedIds);
  const apiSet = new Set(apiIds);
  const missing = apiIds.filter((id) => !renderedSet.has(id));
  const extra = renderedIds.filter((id) => !apiSet.has(id));
  const missingDrivers = groups
    .filter((group) => {
      const driver = typeof group.driver === 'string' ? group.driver : '';
      return driver.length > 0 && html.indexOf(driver) < 0;
    })
    .map((group) => `${group.id}(${group.driver})`);
  return { missing, extra, missingDrivers };
}

/**
 * 群友数比对：每个群的 /_team/groups/:id/models 长度，必须与渲染出的 [群友: N] 一致。
 * 为什么单独核这一项：models 缺省是 []，"还没拉到"与"确实 0 个"取值一样，
 * 历史事故就是界面上「群友恒为 0」——只有把接口长度和渲染值放在一起比才抓得住。
 */
async function fetchGroupModelCount(groupId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BACKEND_BASE}/_team/groups/${encodeURIComponent(groupId)}/models`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const models = Array.isArray(payload) ? payload : payload && payload.models;
    if (!Array.isArray(models)) throw new Error('响应里没有 models 数组');
    return models.length;
  } finally {
    clearTimeout(timer);
  }
}

async function checkGroupMemberCounts(groups, render) {
  const mismatches = [];
  for (const group of groups) {
    const expectedCount = await fetchGroupModelCount(group.id);
    const models = new Array(expectedCount).fill(null).map((_, index) => ({ id: `m-${index}`, name: `m-${index}` }));
    const html = String(render.renderChat(group, models, [], null, 'loaded') || '');
    const expectedTag = `[群友: ${expectedCount}]`;
    if (!html.includes(expectedTag)) {
      const renderedMatch = /\[群友: ([^\]]+)\]/.exec(html);
      const renderedValue = renderedMatch ? renderedMatch[1] : '(未渲染)';
      mismatches.push(`群 ${group.id}：渲染 ${renderedValue} / 接口 ${expectedCount}`);
    }
  }
  return mismatches;
}

async function main() {
  const panelProblems = checkPanelRenderContract();
  if (panelProblems.length > 0) {
    console.error('❌ 面板纯渲染断言不通过：');
    for (const problem of panelProblems) console.error(`    ${problem}`);
    return EXIT_MISMATCH;
  }
  console.log('✅ 面板纯渲染断言通过：五字段非空且非加载中、空输入落占位符、层级 panel < app、骨架锚点齐全');

  const groups = await fetchGroups();
  const apiIds = groups.map((group) => String(group.id));
  const render = loadRenderLayer();
  const html = String(render.renderGroupList(groups, null, '') || '');
  const renderedIds = extractRenderedIds(html);
  const renderedCount = countRenderedItems(html);

  const { missing, extra, missingDrivers } = describeDifference({ renderedIds, apiIds, groups, html });
  const countMismatched = renderedCount !== groups.length || renderedIds.length !== groups.length;

  const memberMismatches = await checkGroupMemberCounts(groups, render);

  if (!countMismatched && missing.length === 0 && extra.length === 0 && missingDrivers.length === 0 && memberMismatches.length === 0) {
    console.log(`✅ 渲染一致：${groups.length} 个群（逐 id 对得上，驱动列都非空，群友数与接口一致）`);
    return EXIT_OK;
  }

  console.error('❌ 渲染与接口返回不一致：');
  console.error(`  渲染 ${renderedCount} 条 / 接口 ${groups.length} 条`);
  if (missing.length > 0) console.error(`  缺：${missing.join(', ')}`);
  if (extra.length > 0) console.error(`  多（接口里没有）：${extra.join(', ')}`);
  if (missingDrivers.length > 0) console.error(`  驱动列缺失：${missingDrivers.join(', ')}`);
  if (memberMismatches.length > 0) {
    console.error('  群友数与接口不一致：');
    for (const item of memberMismatches) console.error(`    ${item}`);
  }
  return EXIT_MISMATCH;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`❌ ${error && error.message ? error.message : error}`);
    process.exit(EXIT_MISMATCH);
  });
