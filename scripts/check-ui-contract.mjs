#!/usr/bin/env node
//
// check-ui-contract.mjs —— 界面约束门禁（U-1 ~ U-4）
//
// 为什么需要它：这四条约束都是「同一个事实两处表达」——契约里写一遍、界面实现里又写一遍。
// 只靠人工看界面守不住：实现里一个 `|| '—'` 就能把「加载失败」静默说成「加载中」，
// 一个空 div 就能把「没有副标题」变成「副标题是空行」。按 docs/12 R4，两处表达必须有机器门禁。
//
// 为什么不启浏览器（docs/12 §三点五）：四条断言的判据全部落在「后端返回值 → 渲染文本」这一层，
// 能在数据层判定的就在数据层判定——直接执行仓库里的真渲染分片（ui/js/view/render.js），
// 把数据喂进去再对输出做结构断言。几十毫秒、零抖动，且验的是运行时同一份代码，不是复制品。
//
// 四条的判据（docs/03 §6.4）：
//   U-1 summary 逐字透传     —— /_team/groups 的 summary 必须与副标题渲染文本完全一致（不解析、不替换）
//   U-2 summary 为空不占位   —— 空串 / 只有空格 / 字段缺失都不能留下副标题节点（D-4）
//   U-3 无平台名硬编码       —— ui/js 与 ui/themes 不得出现平台名字面量（平台名只能由接口声明）
//   U-4 群友数三态           —— loading→`—`、loaded→N、error→`加载失败`（D-3）
//
// 用法：
//   node scripts/check-ui-contract.mjs                                 # 自起假后端（gate-all 走这条，不依赖手工起服务）
//   node scripts/check-ui-contract.mjs --base http://127.0.0.1:8766    # 对指定后端跑（人工排查用）
//   node scripts/check-ui-contract.mjs --self-test                     # 变异自证：每条断言都要能红、也能绿
//
// 退出码：0 = 全部通过（自证模式下 = 自证全部成立）；1 = 有不通过项或环境不可用。

import fs from 'node:fs';
import path from 'node:path';

import {
  PATHS,
  PROJECT_ROOT,
  collectUiSourceFiles,
  fetchGroups,
  loadRenderLayer,
  printAssertionResult,
  readArgument,
  readDirectoryEntries,
  readSources,
  readTextFile,
  withBackend,
} from './lib/ui-contract-harness.mjs';

import {
  CLASSIC_SELF_TEST_VARIANTS,
  checkClassicEmptySummary,
  checkClassicSummaryPassthrough,
  loadClassicListHelpers,
} from './lib/ui-contract-classic.mjs';

const PLATFORM_PRESET_PATH = PATHS.platformPreset;
const REVERSE_PLATFORMS_DIRECTORY = PATHS.reversePlatforms;

// 太短的名字（如 'ai'、'glm'）会命中大量无关标识符，制造满屏误报；平台名一般 ≥4 字符
const MIN_PLATFORM_NAME_LENGTH = 4;
const EXIT_OK = 0;
const EXIT_FAILED = 1;

const SUMMARY_NODE_PATTERN = /<div class="group-summary">([\s\S]*?)<\/div>/;
const MEMBER_COUNT_PATTERN = /<span class="group-tag">\[群友: ([\s\S]*?)\]<\/span>/;

const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeHtmlText = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const describeRawValue = (rawValue) => (rawValue === undefined ? '(字段缺失)' : `「${String(rawValue)}」`);

/**
 * 把渲染出的 HTML 文本还原成「用户实际看到的字」。
 * 为什么必须还原再比：副标题里一个 `&` 会让 HTML 源码是 `&amp;`，页面文本仍是 `&`；
 * 直接比源码会把「正确透传」误判成「被加工」（假红）。
 */
function decodeHtmlEntities(text) {
  const namedEntities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return String(text).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity) => {
    if (namedEntities[entity] !== undefined) return namedEntities[entity];
    if (entity[0] !== '#') return whole;
    const codePoint = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : whole;
  });
}
/** 按 data-group-id 切出单个群项的 HTML：整体正则抓第一条会串行，必须按 id 定位 */
function extractGroupItemHtml(listHtml, groupId) {
  const markerIndex = listHtml.indexOf(`data-group-id="${escapeHtmlText(groupId)}"`);
  if (markerIndex < 0) return null;
  const itemStart = listHtml.lastIndexOf('<li', markerIndex);
  const itemEnd = listHtml.indexOf('</li>', markerIndex);
  return itemStart < 0 || itemEnd < 0 ? null : listHtml.slice(itemStart, itemEnd);
}

/** U-1 的单群比较：接口 summary 必须等于副标题渲染文本（不解析占位符、不替换、不加前缀） */
function compareOneGroupSummary(listHtml, group) {
  if (typeof group.summary !== 'string') {
    return [`群 ${group.id}：读出的 summary 不是字符串（${JSON.stringify(group.summary)}）——GET 必须返回成品字符串，写入形状才是对象（docs/02 §3.9）`];
  }
  if (group.summary.trim() === '') return []; // 空值归 U-2 管：这里只比「有内容时必须逐字一致」
  const itemHtml = extractGroupItemHtml(listHtml, String(group.id));
  if (itemHtml === null) return [`群 ${group.id}：渲染结果里找不到该群（data-group-id 缺失）`];
  const matchedSummary = SUMMARY_NODE_PATTERN.exec(itemHtml);
  if (!matchedSummary) return [`群 ${group.id}：summary 非空却没有副标题节点（接口值 ${JSON.stringify(group.summary)}）`];
  const renderedText = decodeHtmlEntities(matchedSummary[1]);
  if (renderedText === group.summary) return [];
  return [`群 ${group.id}：副标题被加工过\n        接口：${JSON.stringify(group.summary)}\n        渲染：${JSON.stringify(renderedText)}`];
}

/** U-1：至少有一个群能被比、且每个可比群都逐字一致（一个群都没有时不能算通过） */
function checkSummaryPassthrough(context) {
  const groups = Array.isArray(context.groups) ? context.groups : [];
  if (groups.length === 0) return ['后端 /_team/groups 没有群可核对——断言不能空转：至少要有 1 个群才谈得上「逐字透传」'];
  const comparableCount = groups.filter((group) => typeof group.summary === 'string' && group.summary.trim() !== '').length;
  const problems = comparableCount === 0 ? ['后端所有群的 summary 都是空串，没有一条能证明「逐字透传」——请给至少一个带 summary 的群'] : [];
  const listHtml = String(context.renderApi.renderGroupList(groups, null, '', {}) || '');
  for (const group of groups) problems.push(...compareOneGroupSummary(listHtml, group));
  return problems;
}

/**
 * U-2 的夹具：空串 / 只有空格 / 字段缺失三种缺省形态 + 一个对照组。
 * 用夹具而不是后端数据：契约缺省值在任何后端上都必须成立，
 * 靠「恰好有一个空 summary 的群」来验，等于把断言绑在某份假数据上。
 */
function buildSummaryFixtureGroups() {
  const shared = { name: '副标题判空夹具', driver: 'openai-compatible', lastUpdated: '2026-01-01T00:00:00.000Z' };
  return {
    control: { ...shared, id: 'fixture-summary-control', summary: '透传原文 · 余 12 credit' },
    empty: { ...shared, id: 'fixture-summary-empty', summary: '' },
    blank: { ...shared, id: 'fixture-summary-blank', summary: '   ' },
    missing: { ...shared, id: 'fixture-summary-missing' },
  };
}

/** U-2：summary 为空时该条不得留下副标题节点（空 div 在列表里就是一条视觉空行） */
function checkEmptySummaryNoPlaceholder(context) {
  const fixture = buildSummaryFixtureGroups();
  const groups = [fixture.control, fixture.empty, fixture.blank, fixture.missing];
  const listHtml = String(context.renderApi.renderGroupList(groups, null, '', {}) || '');
  const problems = [];
  // 对照组先立起来：看不见节点时，「空值看不见节点」这种结论毫无意义（前提不成立比断言失败更危险）
  const controlItemHtml = extractGroupItemHtml(listHtml, fixture.control.id);
  const controlSummary = controlItemHtml === null ? null : SUMMARY_NODE_PATTERN.exec(controlItemHtml);
  if (!controlSummary) {
    problems.push('对照组（summary 非空）没有渲染出副标题节点——断言前提不成立，不能据此判断空值行为');
  } else if (decodeHtmlEntities(controlSummary[1]) !== fixture.control.summary) {
    problems.push(`对照组副标题被加工：接口 ${JSON.stringify(fixture.control.summary)} / 渲染 ${JSON.stringify(decodeHtmlEntities(controlSummary[1]))}`);
  }
  for (const [label, group] of [['空字符串', fixture.empty], ['只有空格', fixture.blank], ['字段缺失', fixture.missing]]) {
    const itemHtml = extractGroupItemHtml(listHtml, group.id);
    if (itemHtml === null) {
      problems.push(`${label}的群没有渲染出来，无法判断副标题是否占位`);
      continue;
    }
    const matchedSummary = SUMMARY_NODE_PATTERN.exec(itemHtml);
    if (matchedSummary) {
      problems.push(`${label} summary=${describeRawValue(group.summary)} 仍渲染出副标题节点 ${matchedSummary[0].trim()}——docs/03 D-4 要求 trim 后为空即不渲染`);
    }
  }
  return problems;
}

/** 预置平台声明的名字（config/platforms.json 是预置真源；读不到就没法判定，必须记成问题） */
function readPresetPlatformNames(problems) {
  const presetNames = [];
  try {
    const parsedPresets = JSON.parse(readTextFile(PLATFORM_PRESET_PATH));
    for (const platform of parsedPresets.platforms || []) {
      for (const declaredName of [platform.id, platform.name]) if (typeof declaredName === 'string') presetNames.push(declaredName);
    }
  } catch (error) {
    problems.push(`读不到平台预置真源 config/platforms.json（${error.message}）——没有真源就无法判断「哪些名字算平台名」`);
  }
  return presetNames;
}

/** 反代平台的自描述名：目录名即 id，展示名在 index.js 的自描述对象里（铁律 2：一个平台的元数据只写那儿） */
function readReversePlatformNames() {
  const reverseNames = [];
  for (const entry of readDirectoryEntries(REVERSE_PLATFORMS_DIRECTORY)) {
    if (!entry.isDirectory()) continue;
    reverseNames.push(entry.name);
    try {
      const displayNameMatch = /\bname:\s*'([^']{2,})'/.exec(readTextFile(path.join(REVERSE_PLATFORMS_DIRECTORY, entry.name, 'index.js')));
      if (displayNameMatch) reverseNames.push(displayNameMatch[1]);
    } catch {
      // 自描述文件缺失时只用目录名：目录名已足够代表该平台 id，不因此判失败
    }
  }
  return reverseNames;
}

/**
 * 平台名的真源（R4 铁律 1：真源唯一、文档只是投影）= 预置声明 + 反代自描述。
 * 不把平台名写死在这道门禁里——那会让「新加一个平台」变成「门禁也要改」。
 */
function readDeclaredPlatformNames(problems = []) {
  const uniqueNames = new Map();
  for (const name of [...readPresetPlatformNames(problems), ...readReversePlatformNames()]) {
    // 同名的大小写变体（agnes / Agnes）只留一个：报告里出现两行同义命中，会让人以为是两处缺陷
    if (name.length >= MIN_PLATFORM_NAME_LENGTH && !uniqueNames.has(name.toLowerCase())) uniqueNames.set(name.toLowerCase(), name);
  }
  return [...uniqueNames.values()];
}

/**
 * 扫描前先去注释：注释不会渲染到界面上，把注释里的举例也判红，
 * 只会逼着人删掉有用的说明（R4 铁律 3：不手工登记例外表，改用通用规则）。
 */
function stripCommentsForScan(sourceText) {
  const withoutBlockComments = sourceText.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''));
  return withoutBlockComments.split('\n')
    .map((line) => {
      const commentIndex = line.search(/(^|\s)\/\//);
      return commentIndex < 0 ? line : line.slice(0, commentIndex);
    })
    .join('\n');
}

/** U-3：界面源码不得出现平台名字面量（平台名只能由接口/驱动声明，界面不认识任何平台） */
function checkNoPlatformNameLiteral(context) {
  const problems = [];
  const platformNames = readDeclaredPlatformNames(problems);
  if (!context.uiFiles.length) return ['没有可扫描的界面源码（ui/js 与 ui/themes 都不存在）——扫描面为空时不能算通过'];
  if (!platformNames.length) return ['没有取到任何平台名（预置与反代自描述都是空的）——扫描清单为空时不能算通过'];
  // 边界只认字母数字下划线：`agnes-3.0-flash` 这种「平台名前缀 + 型号」也算硬编码
  const patterns = platformNames.map((name) => ({ name, pattern: new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(name)}([^A-Za-z0-9_]|$)`, 'i') }));
  for (const file of context.uiFiles) {
    const originalLines = file.text.split('\n');
    stripCommentsForScan(file.text).split('\n').forEach((scannedLine, index) => {
      for (const { name, pattern } of patterns) {
        if (!pattern.test(scannedLine)) continue;
        problems.push(`${file.path}:${index + 1} 出现平台名字面量「${name}」：${String(originalLines[index] || scannedLine).trim().slice(0, 120)}`);
      }
    });
  }
  return problems;
}

/** U-4：群友数三态——未加载 `—`、已加载 N、加载失败 `加载失败`（三者必须互相可区分） */
function checkMemberCountTriState(context) {
  const problems = [];
  const models = [{ id: 'model-1' }, { id: 'model-2' }, { id: 'model-3' }];
  const fixtures = [
    { state: 'loading', expected: '—', reason: '还没拉到 ≠ 0 个群友' },
    // 期望值由夹具条数算出来：写死一个数字会让「已加载显示固定值」的实现也通过
    { state: 'loaded', expected: String(models.length), reason: '已加载必须是接口条数，不能写死' },
    { state: 'error', expected: '加载失败', reason: '加载失败 ≠ 加载中（docs/03 D-3）' },
  ];
  for (const { state, expected, reason } of fixtures) {
    const chatHtml = String(context.renderApi.renderChat({ id: 'fixture-member-count', name: '群友数三态夹具' }, models, [], null, state) || '');
    const matchedCount = MEMBER_COUNT_PATTERN.exec(chatHtml);
    if (!matchedCount) {
      problems.push(`modelsStatus=${state}：群聊头部没有群友数节点`);
      continue;
    }
    const renderedText = decodeHtmlEntities(matchedCount[1]).trim();
    if (renderedText !== expected) problems.push(`modelsStatus=${state}：渲染 ${JSON.stringify(renderedText)}，契约要求 ${JSON.stringify(expected)}（${reason}）`);
  }
  return problems;
}

const ASSERTIONS = [
  { id: 'U-1', title: 'summary 逐字透传', run: checkSummaryPassthrough },
  { id: 'U-2', title: 'summary 为空不占位', run: checkEmptySummaryNoPlaceholder },
  { id: 'U-3', title: '无平台名硬编码', run: checkNoPlatformNameLiteral },
  { id: 'U-4', title: '群友数三态（—/N/加载失败）', run: checkMemberCountTriState },
  // classic（TSX）侧的同一组摘要规则：新界面必须受同一道门禁约束
  { id: 'U-5', title: 'classic 副标题逐字透传', run: checkClassicSummaryPassthrough },
  { id: 'U-6', title: 'classic 空 summary 不占位', run: checkClassicEmptySummary },
];

const buildContext = ({ renderSourceText, uiFiles, groups, classicList }) => ({ renderApi: loadRenderLayer(renderSourceText), renderSourceText, uiFiles, groups, classicList });

const runAssertions = (context) => ASSERTIONS.map((assertion) => {
  const problems = assertion.run(context);
  return { id: assertion.id, title: assertion.title, ok: problems.length === 0, problems };
});

async function runDefault(argv) {
  return withBackend(argv, async (baseUrl) => {
    const groups = await fetchGroups(baseUrl);
    console.log('🔎 界面约束门禁（U-1 ~ U-4）');
    console.log(`   后端：${baseUrl}${readArgument(argv, '--base') ? '（外部给出）' : '（本次自起假后端，跑完即关）'}`);
    console.log('   渲染层：ui/js/format/ui-format.js + ui/js/view/render.js（同一作用域执行真分片，不启浏览器）');
    console.log(`   后端群列表 ${groups.length} 个：${groups.map((group) => `${group.id}=${JSON.stringify(group.summary)}`).join(' / ')}`);
    const results = runAssertions(buildContext({ ...readSources(), groups, classicList: await loadClassicListHelpers() }));
    for (const gateResult of results) printAssertionResult(gateResult);
    const passed = results.filter((gateResult) => gateResult.ok).length;
    console.log(passed === results.length ? `✅ ${passed}/${results.length} 通过` : `❌ ${passed}/${results.length} 通过`);
    return passed === results.length ? EXIT_OK : EXIT_FAILED;
  });
}

// ---------------------------------------------------------------------------
// 变异自证（docs/12 R4 铁律 2：新门禁必须先拿已知违例跑一次，必须变红；不红 = 摆设）
//
// 每条断言构造两个变体：「违例变体」必须红、「合规变体」必须绿。
// 变体只在内存里改渲染分片或界面源码文本，**不写任何文件**：真正的实现改动要批准后单独做。
// 违例侧用替身/包装表达（实现被修好之后仍然有效），合规侧用契约要求的实现表达（幂等补丁，
// 已经实现过就原样返回），所以自证结论不依赖仓库当前恰好是哪种状态。
// ---------------------------------------------------------------------------

const SUMMARY_NODE_TEMPLATE = '<div class="group-summary">${escapeHtml(group.summary)}</div>';
const EMPTY_SUMMARY_GUARD = [
  '// 副标题：trim 后为空即不输出节点（空 div 会在群列表里留一条视觉空行，docs/03 D-4）',
  'function renderGroupSummaryLine(summaryText) {',
  "  const rawText = String(summaryText == null ? '' : summaryText);",
  "  return rawText.trim() ? `<div class=\"group-summary\">${escapeHtml(rawText)}</div>` : '';",
  '}',
  '',
].join('\n');
const MEMBER_COUNT_CURRENT_EXPRESSION = "${modelsStatus === undefined || modelsStatus === 'loaded' ? models.length : '—'}";
const MEMBER_COUNT_CONFORMING_EXPRESSION = "${modelsStatus === 'error' ? '加载失败' : modelsStatus === undefined || modelsStatus === 'loaded' ? models.length : '—'}";

function requirePatch(sourceText, fromText, toText, label) {
  if (!sourceText.includes(fromText)) {
    throw new Error(`自证补丁锚点不匹配（${label}）——界面源码已改动，请同步更新本脚本的变体表\n    期望锚点：${fromText}`);
  }
  return sourceText.replace(fromText, toText);
}

/** 判空渲染的补丁（幂等：已经实现过就原样返回，重复跑自证不报错） */
function applyEmptySummaryGuard(sourceText) {
  if (sourceText.includes('renderGroupSummaryLine(')) return sourceText;
  const renderGroupListHead = 'function renderGroupList(groups, currentGroupId, filterText, options) {';
  const withGuardFunction = requirePatch(sourceText, renderGroupListHead, `${EMPTY_SUMMARY_GUARD}${renderGroupListHead}`, 'U-2 插入判空函数');
  return requirePatch(withGuardFunction, SUMMARY_NODE_TEMPLATE, '${renderGroupSummaryLine(group.summary)}', 'U-2 副标题改为判空渲染');
}

/** 群友数三态的补丁（幂等：已经用函数或内联分支实现过就原样返回） */
function applyMemberCountContract(sourceText) {
  if (sourceText.includes('formatMemberCount(')) return sourceText;
  if (sourceText.includes(MEMBER_COUNT_CONFORMING_EXPRESSION)) return sourceText;
  return requirePatch(sourceText, MEMBER_COUNT_CURRENT_EXPRESSION, MEMBER_COUNT_CONFORMING_EXPRESSION, 'U-4 补 error 分支');
}

/** 违例替身：一个「空 summary 也照样输出节点」的极简渲染器（就是历史形态） */
function renderGroupListWithEmptySummaryNode(groups) {
  const itemsHtml = groups.map((group) => `<li class="group-item" data-group-id="${escapeHtmlText(group.id)}">`
    + `<div class="group-main"><div class="group-line"><span class="group-name">${escapeHtmlText(group.name)}</span></div>`
    + `<div class="group-summary">${escapeHtmlText(group.summary == null ? '' : group.summary)}</div></div></li>`).join('');
  return `<ul class="group-list" id="groupList">${itemsHtml}</ul>`;
}

function injectPlatformLiteral(uiFiles) {
  const targetIndex = Math.max(0, uiFiles.findIndex((file) => file.path.endsWith('.js')));
  return uiFiles.map((file, index) => (index === targetIndex ? { ...file, text: `${file.text}\nconst SELF_TEST_PLATFORM_LABEL = 'Qoder';\n` } : file));
}

function neutralizePlatformNames(uiFiles) {
  const replacements = readDeclaredPlatformNames([]).map((name) => new RegExp(escapeRegExp(name), 'gi'));
  return uiFiles.map((file) => ({ ...file, text: replacements.reduce((accumulated, pattern) => accumulated.replace(pattern, 'PLATFORM_NAME'), file.text) }));
}

const withGroupListRenderer = (context, renderGroupList) => ({ ...context, renderApi: { ...context.renderApi, renderGroupList } });
const withChatRenderer = (context, renderChat) => ({ ...context, renderApi: { ...context.renderApi, renderChat } });
const withRenderSource = (context, renderSourceText) => ({ ...context, renderApi: loadRenderLayer(renderSourceText) });

const SELF_TEST_VARIANTS = [
  {
    assertionId: 'U-1', expect: 'red', label: '把 summary 换成固定文案（不再透传）',
    apply: (context) => withGroupListRenderer(context, (groups, ...restArguments) => context.renderApi.renderGroupList(
      groups.map((group) => ({ ...group, summary: '官方接入 · 固定文案' })), ...restArguments)),
  },
  { assertionId: 'U-1', expect: 'green', label: '真渲染分片（不做任何改动）', apply: (context) => context },
  { assertionId: 'U-2', expect: 'red', label: '空 summary 也照样输出节点（历史形态）', apply: (context) => withGroupListRenderer(context, renderGroupListWithEmptySummaryNode) },
  { assertionId: 'U-2', expect: 'green', label: 'trim 判空后才输出节点（D-4 修法）', apply: (context) => withRenderSource(context, applyEmptySummaryGuard(context.renderSourceText)) },
  { assertionId: 'U-3', expect: 'red', label: "在界面源码里插一条 'Qoder' 字面量", apply: (context) => ({ ...context, uiFiles: injectPlatformLiteral(context.uiFiles) }) },
  { assertionId: 'U-3', expect: 'green', label: '把平台名换成中性占位名（其余真源码噪声不变）', apply: (context) => ({ ...context, uiFiles: neutralizePlatformNames(context.uiFiles) }) },
  {
    assertionId: 'U-4', expect: 'red', label: '把 error 当 loaded 处理',
    apply: (context) => withChatRenderer(context, (group, models, messages, platform, modelsStatus) => context.renderApi.renderChat(
      group, models, messages, platform, modelsStatus === 'error' ? 'loaded' : modelsStatus)),
  },
  { assertionId: 'U-4', expect: 'green', label: 'error 渲染「加载失败」（D-3 修法）', apply: (context) => withRenderSource(context, applyMemberCountContract(context.renderSourceText)) },
];

async function runSelfTest(argv) {
  return withBackend(argv, async (baseUrl) => {
    const groups = await fetchGroups(baseUrl);
    const context = buildContext({ ...readSources(), groups, classicList: await loadClassicListHelpers() });
    console.log('🎯 变异自证（每条断言都必须「能红」且「能绿」）');
    const realResults = runAssertions(context);
    for (const gateResult of realResults) printAssertionResult(gateResult);
    console.log(`   真源码现状：${realResults.filter((gateResult) => gateResult.ok).length}/${realResults.length} 条通过`);
    const outcomes = [...SELF_TEST_VARIANTS, ...CLASSIC_SELF_TEST_VARIANTS].map((variant) => {
      const problems = ASSERTIONS.find((assertion) => assertion.id === variant.assertionId).run(variant.apply(context));
      const actual = problems.length === 0 ? 'green' : 'red';
      return { variant, actual, matched: actual === variant.expect, firstProblem: problems[0] || '(无问题)' };
    });
    for (const outcome of outcomes) {
      const kind = outcome.variant.expect === 'red' ? '违例变体' : '合规变体';
      console.log(`${outcome.matched ? '✓' : '✗'} ${outcome.variant.assertionId} ${kind}：${outcome.variant.label} → ${outcome.actual === 'red' ? '红' : '绿'}`);
      if (!outcome.matched) console.log(`    期望 ${outcome.variant.expect}，实际 ${outcome.actual}；断言输出：${outcome.firstProblem}`);
    }
    const verifiedCount = outcomes.filter((outcome) => outcome.matched).length;
    const total = SELF_TEST_VARIANTS.length + CLASSIC_SELF_TEST_VARIANTS.length;
    if (verifiedCount < total) {
      console.log(`❌ 自证 ${verifiedCount}/${total}（有断言抓不住违例、或正确实现下也红——门禁不可信）`);
      return EXIT_FAILED;
    }
    console.log(`✅ 自证 ${verifiedCount}/${total} 通过（4 条断言都能红也能绿）`);
    return EXIT_OK;
  });
}

async function main() {
  const argv = process.argv.slice(2);
  process.exit(argv.includes('--self-test') ? await runSelfTest(argv) : await runDefault(argv));
}

main().catch((error) => {
  console.error(`❌ ${error && error.message ? error.message : error}`);
  process.exit(EXIT_FAILED);
});
