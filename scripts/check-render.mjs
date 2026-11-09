#!/usr/bin/env node
//
// 渲染 vs 返回 比对门禁。
//
// 为什么需要它：check-contract 只比「端点表 ↔ 路由表」与「DOM 钩子」，单测用的是构造数据；
// 而真实事故是「接口返回 3 个群、界面渲染 0 个」——数据在穿层时丢了，两边各自看都正常。
// 这里把**后端真实返回**喂给**仓库里的渲染分片**，直接核对条数 / id 集合 / 驱动列。
//
// 用法：
//   node scripts/check-render.mjs                        # 自带 fixture（缺省，可重复跑）
//   DMT_BACKEND=<后端地址> node scripts/check-render.mjs  # 对指定后端核对（集成检查，地址由调用方给）
//
// 退出码：0 = 渲染与返回一致；1 = 有差异或后端不可用。
//
// 后端从哪来（这条别改回「默认连部署」）：
//   缺省**自带**一个进程内网关 + 临时数据根，监听系统分配的空闲端口，跑完即关——
//   不依赖任何正在运行的宿主、不读真实配置，任何机器任何时刻都能跑。
//   脚本里**不写任何具体地址或端口**：写过一次就变成「只对这台机器的部署有效」。
//   历史教训：曾经默认连本机部署的固定端口，宿主正忙时这个门禁自己超时红掉，
//   把「部署忙」误报成「渲染不一致」。

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { createGatewayServer } from '../src/gateway/transport/http-server.js';
import { writeConfig } from '../src/gateway/config/config.js';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const RENDER_SOURCE_PATH = path.join(PROJECT_ROOT, 'ui/js/view/render.js');
// 展示口径函数住在 ui-format.js，它们要调用 render.js 的 escapeHtml——真实 bundle 里两者同作用域
// （build.cjs 的 UI_PARTS 顺序 format → render），所以这里也必须拼成一个作用域再执行。
const FORMAT_SOURCE_PATH = path.join(PROJECT_ROOT, 'ui/js/format/ui-format.js');
// 列表规则（过滤/三态/计数/时间/行数据）已搬到 format/list-rules.js（单一实现，render 只调用）
const LIST_RULES_SOURCE_PATH = path.join(PROJECT_ROOT, 'ui/js/format/list-rules.js');
// 头像四级回退（单一实现）：render 只调用
const AVATAR_CHAIN_SOURCE_PATH = path.join(PROJECT_ROOT, 'ui/js/format/avatar-chain.js');
// float.js 的几何函数已搬到 float/geometry.js（单一实现）
const GEOMETRY_SOURCE_PATH = path.join(PROJECT_ROOT, 'ui/js/float/geometry.js');
// 面板五字段口径已搬到 float/panel-fields.js（单一实现）
const PANEL_FIELDS_SOURCE_PATH = path.join(PROJECT_ROOT, 'ui/js/float/panel-fields.js');

// 只有显式给了 DMT_BACKEND 才连真实部署；否则用下面的进程内 fixture
const EXPLICIT_BACKEND = (process.env.DMT_BACKEND || '').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 8000;
const FIXTURE_API_KEY_ENV = 'DMT_RENDER_FIXTURE_KEY'; // dsh-skip-sensitive

const EXIT_OK = 0;
const EXIT_MISMATCH = 1;

/**
 * 在隔离上下文里执行渲染分片，取回纯渲染函数。
 * 为什么用 vm 而不是字符串求值：分片是"给浏览器用的普通脚本"（没有 export），
 * 要拿到其中函数只能执行它；vm 给它一个空沙箱，既拿得到函数，也不会污染门禁进程的全局。
 * view/render.js 的函数在调用时才碰全局（escapeHtml 等都在同文件内定义），空沙箱足够。
 */
function loadRenderLayer() {
  const source = `${fs.readFileSync(FORMAT_SOURCE_PATH, 'utf8')}\n${fs.readFileSync(LIST_RULES_SOURCE_PATH, 'utf8')}\n${fs.readFileSync(AVATAR_CHAIN_SOURCE_PATH, 'utf8')}\n${fs.readFileSync(RENDER_SOURCE_PATH, 'utf8')}`;
  const sandbox = vm.createContext({ console });
  const exported = vm.runInContext(
    `${source}\n;({ renderGroupList: renderGroupList, renderChat: renderChat })`,
    sandbox,
    { filename: 'ui-format.js + render.js（同一作用域）' },
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
  const source = `${fs.readFileSync(GEOMETRY_SOURCE_PATH, 'utf8')}\n${fs.readFileSync(PANEL_FIELDS_SOURCE_PATH, 'utf8')}\n${fs.readFileSync(path.join(PROJECT_ROOT, 'ui/js/float/float.js'), 'utf8')}`;
  const sandbox = vm.createContext({ console });
  return vm.runInContext(
    `${source}\n;({ buildPanelFieldTexts: buildPanelFieldTexts })`,
    sandbox,
    { filename: 'ui/js/float/float.js' },
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
  // ④ 面板锚点必须在**主题源码**里存在（0.4.0 起契约绑主题；legacy 骨架 ui/index.html 不再是基准）。
  //    面板五字段（#fpGroup/#fpSession/#fpTarget/#fpRate/#fpTotal）与收起/关闭键（#fpMin/#fpClose）
  //    已在 B14 判定下线（主题面板不展示五行、且条款 8 禁止收起/关闭整窗键），这里只校验保留的锚点。
  const themesDirectory = path.join(PROJECT_ROOT, 'ui/themes');
  const themeSources = fs.readdirSync(themesDirectory)
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => fs.readFileSync(path.join(themesDirectory, name), 'utf8'));
  for (const anchorId of ['floatPanel', 'fpHead', 'fpTitle', 'fpEnter']) {
    if (!themeSources.some((source) => source.includes(`id="${anchorId}"`))) {
      problems.push(`主题源码缺少 #${anchorId}（浮层/面板锚点，legacy 骨架已不再是基准）`);
    }
  }
  return problems;
}

/**
 * 自带后端：临时数据根 + fixture 配置 + 进程内网关（监听 0 端口）。
 * 为什么不用真实部署：门禁要在任何机器、任何时刻可重复跑；连部署会让「宿主忙」变成「门禁红」。
 */
async function startFixtureBackend() {
  // 凭证走环境变量引用：门禁自己给一个假值，绝不读机器上的真实凭据
  process.env[FIXTURE_API_KEY_ENV] = 'render-gate-fixture-not-a-real-key';
  const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dmt-render-'));

  // 上游也要自带：/_team/groups/:id/models 会真的去问上游（本仓库没有「静态模型」捷径），
  // 所以给一个进程内 stub：路径 /v1/<群 id>/models 返回该群的固定模型清单。
  // 每个群用不同路径，才能验证「群友数逐群不同」这件事——共用一份清单就测不出串组。
  const modelsByGroupId = new Map();
  const stubUpstream = http.createServer((request, response) => {
    const matched = /^\/v1\/([^/]+)\/models$/.exec(request.url || '');
    if (!matched) { response.writeHead(404); response.end(); return; }
    const models = modelsByGroupId.get(decodeURIComponent(matched[1])) || [];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: models.map((modelId) => ({ id: modelId, name: modelId })) }));
  });
  await new Promise((resolveListen) => stubUpstream.listen(0, '127.0.0.1', resolveListen));
  const stubOrigin = `http://127.0.0.1:${stubUpstream.address().port}`;
  const buildGroup = (id, name, models) => {
    modelsByGroupId.set(id, models);
    return {
      id,
      name,
      accessMode: 'compatible',
      driver: 'openai-compatible',
      baseURL: `${stubOrigin}/v1/${encodeURIComponent(id)}`,
      defaultModel: models[0],
      auth: { type: 'bearer', header: 'Authorization', apiKeyRef: `env:${FIXTURE_API_KEY_ENV}` },
      models: { static: models },
      request: { modelField: 'model', extraHeaders: {} },
      response: { usagePath: 'usage' },
    };
  };
  await writeConfig({
    groups: [
      buildGroup('fixture-alpha', 'Alpha 平台', ['alpha-1', 'alpha-2']),
      buildGroup('fixture-beta', 'Beta 平台', ['beta-1']),
      buildGroup('fixture-gamma', 'Gamma 平台', ['gamma-1', 'gamma-2', 'gamma-3']),
    ],
    friendGroups: [],
    virtualModel: 'dsh-model-team',
    contextWindowFallback: 1048576,
  }, { dataRoot });

  const server = createGatewayServer({
    dataRoot,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    fetchImpl: globalThis.fetch,
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise((resolveClose) => server.close(resolveClose));
      await new Promise((resolveClose) => stubUpstream.close(resolveClose));
      await fs.promises.rm(dataRoot, { recursive: true, force: true });
    },
  };
}

/** 读后端群列表：任何失败都要给出可执行的提示，而不是静默空数组 */
async function fetchGroups(baseUrl) {
  const groupsEndpoint = `${baseUrl}/_team/groups`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(groupsEndpoint, { signal: controller.signal });
  } catch (networkError) {
    throw new Error(`连不上后端 ${groupsEndpoint}（${networkError.message}）`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`GET ${groupsEndpoint} 返回 HTTP ${response.status}：${errorBody.slice(0, 200)}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch (parseError) {
    throw new Error(`GET ${groupsEndpoint} 返回的不是 JSON（${parseError.message}）`);
  }
  const groups = Array.isArray(payload) ? payload : payload && payload.groups;
  if (!Array.isArray(groups)) {
    throw new Error(`GET ${groupsEndpoint} 响应里没有 groups 数组`);
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
async function fetchGroupModelCount(baseUrl, groupId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/_team/groups/${encodeURIComponent(groupId)}/models`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const models = Array.isArray(payload) ? payload : payload && payload.models;
    if (!Array.isArray(models)) throw new Error('响应里没有 models 数组');
    return models.length;
  } finally {
    clearTimeout(timer);
  }
}

async function checkGroupMemberCounts(baseUrl, groups, render) {
  const mismatches = [];
  for (const group of groups) {
    const expectedCount = await fetchGroupModelCount(baseUrl, group.id);
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

  // 后端来源：显式给了地址就连它（集成检查）；否则自起进程内 fixture（门禁缺省形态）
  let backendBase = EXPLICIT_BACKEND;
  let fixture = null;
  if (!backendBase) {
    fixture = await startFixtureBackend();
    backendBase = fixture.baseUrl;
    console.log(`🧪 自带 fixture 后端：${backendBase}（进程内，跑完即关）`);
  }
  try {
    return await runComparison(backendBase);
  } finally {
    if (fixture) await fixture.close();
  }
}

async function runComparison(backendBase) {
  const groups = await fetchGroups(backendBase);
  const apiIds = groups.map((group) => String(group.id));
  const render = loadRenderLayer();
  const html = String(render.renderGroupList(groups, null, '') || '');
  const renderedIds = extractRenderedIds(html);
  const renderedCount = countRenderedItems(html);

  const { missing, extra, missingDrivers } = describeDifference({ renderedIds, apiIds, groups, html });
  const countMismatched = renderedCount !== groups.length || renderedIds.length !== groups.length;

  const memberMismatches = await checkGroupMemberCounts(backendBase, groups, render);

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
