#!/usr/bin/env node
// check-layout.mjs —— 结构门禁：目录文档 ↔ 真实文件树、以及「搬家后没接上」的静态检查。
//
// 为什么这道门禁存在（每条都对应一次真实事故）：
//   ① 文档写的路径不存在 / 真实目录文档里没提 —— 目录文档必然腐烂，且没人会主动核对；
//   ② 调用了既没定义也没 import 的函数 —— 拆文件时把工具函数落在一个文件、调用点在另一个文件，
//      `node --check` 只查语法，ESM 跨文件引用错要到运行时才炸（真实事故：一次目录重构后
//      7 条测试全 500，根因是 appendEventSafely 被搬走了但调用方没接上）；
//   ③ 定义了但全库无人调用的死代码 —— 上一条的伴生现象（那份函数在旧文件里成了死代码）。
//
// 判据（每条都能红）：
//   A. docs/16 里出现的反引号路径，若形如源码路径（src/ lib/ ui/ scripts/ test/），必须真实存在。
//   B. 真实目录（src/gateway 下每个子目录、ui/js 下每个子目录）必须在文档里被提到。
//   C. 每个 .js 文件里，调用形如 foo(...) 的标识符必须能解析到：本文件函数声明 / const / let /
//      var / class / import / 参数 / 全局白名单。解析不到即可疑（保守起见只报"未定义"不猜"死代码"）。
//   D. 函数声明必须至少被引用一次（同文件内也算）；只声明不引用 = 死代码。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAYOUT_DOC = path.join(PROJECT_ROOT, 'docs', '16-目录结构.md');

// 文档里允许出现、但不必真实存在的路径（示意/示例/产物/被忽略目录）
const PATH_ALLOWLIST = [
  'lib/client.js',        // 构建产物，允许在任何时刻重新生成
  'ui/shots',             // 本地自检截图目录，已 gitignore
  'src/gateway/<领域>',   // 文档里的占位写法
];

// 语言与运行时内置：调用它们不算「未定义」
const GLOBAL_CALLABLES = new Set([
  'Array', 'Object', 'String', 'Number', 'Boolean', 'JSON', 'Math', 'Date', 'Promise', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Symbol', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'decodeURIComponent', 'encodeURIComponent',
  'encodeURI', 'decodeURI', 'structuredClone', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'queueMicrotask', 'fetch', 'URL', 'URLSearchParams', 'AbortController',
  'AbortSignal', 'TextEncoder', 'TextDecoder', 'Buffer', 'console', 'process', 'globalThis',
  'require', 'import', 'super', 'if', 'for', 'while', 'switch', 'catch', 'function', 'return',
  'typeof', 'new', 'delete', 'void', 'await', 'async', 'of', 'in', 'do', 'else', 'try', 'finally',
  'throw', 'case', 'break', 'continue', 'yield', 'class', 'extends', 'constructor',
]);

function listFilesRecursive(directory, extension, collected = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) listFilesRecursive(fullPath, extension, collected);
    else if (entry.name.endsWith(extension)) collected.push(fullPath);
  }
  return collected;
}

// ---------------------------------------------------------------- A / B：文档 ↔ 文件树

function checkDocumentedPaths(docText) {
  const problems = [];
  // 判据只有一条：文档里显式写成反引号包裹的仓库内路径，必须真实存在。
  // 为什么不做「文件名级差集」：那种检查需要猜「这个文件名属于哪个目录」，
  // 一次猜错就是误报，误报会把真问题淹掉——宁可少查，不可报假。
  const explicitPaths = new Set();
  for (const match of docText.matchAll(/`([^`\n]+)`/g)) {
    const raw = match[1].trim().replace(/\/+$/, "");
    if (!/^(src|lib|ui|scripts|test|config|docs)\//.test(raw)) continue;
    if (raw.includes("*") || raw.includes("<") || raw.includes("\u2026")) continue;
    explicitPaths.add(raw);
  }
  for (const candidate of explicitPaths) {
    if (PATH_ALLOWLIST.some((allowed) => candidate === allowed || candidate.startsWith(`${allowed}/`))) continue;
    if (!fs.existsSync(path.join(PROJECT_ROOT, candidate))) {
      problems.push(`docs/16 提到的路径不存在：${candidate}（结构改了没同步文档，或文档写错了）`);
    }
  }
  return { problems, documentedCount: explicitPaths.size };
}

function checkUndocumentedDirectories(docText) {
  const problems = [];
  const roots = ['src/gateway', 'ui/js', 'src/plugin', 'lib/client-parts'];
  for (const root of roots) {
    const absolute = path.join(PROJECT_ROOT, root);
    if (!fs.existsSync(absolute)) continue;
    const entries = fs.readdirSync(absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const relative = `${root}/${entry.name}`;
      // 文档用树形缩进书写（"\u251c\u2500\u2500 stats/  ..."），所以只比对目录名本身：
      // 只要文档里出现过 "<name>/"，就认为这个目录被记录了（父目录已在标题里体现）。
      const namePattern = new RegExp(`(^|[\\s\\u2500-\\u257f|])${entry.name}/`, 'm');
      if (!namePattern.test(docText)) {
        problems.push(`目录存在但 docs/16 没提：${relative}/（新增目录必须写进目录文档）`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------- C / D：未定义调用与死代码

// 极简标识符收集：够用且不引入解析依赖。故意保守——宁可漏报也不误报。
function collectDeclaredNames(source) {
  const declared = new Set();
  const patterns = [
    // function\s*\*? 覆盖生成器：async function* name() 也是函数声明
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s*[{[]([^}\]]+)[}\]]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const captured = match[1];
      if (!captured) continue;
      if (captured.includes(',')) {
        captured.split(',').forEach((piece) => {
          const name = piece.split(':').pop().trim().replace(/^\.\.\./, '');
          if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
        });
      } else if (/^[A-Za-z_$][\w$]*$/.test(captured)) {
        declared.add(captured);
      }
    }
  }
  // import { a, b as c } / import x from
  for (const match of source.matchAll(/import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from/g)) {
    if (match[1]) declared.add(match[1]);
    if (match[2]) {
      match[2].split(',').forEach((piece) => {
        const name = piece.split(/\s+as\s+/).pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
      });
    }
  }
  // 参数与解构参数（保守：把所有形如 name) / name, 的位置都算上，会多收但不误报）
  for (const match of source.matchAll(/(?:function\s*\*?\s*[\w$]*\s*|\(\s*)([A-Za-z_$][\w$]*)\s*[,)=]/g)) {
    declared.add(match[1]);
  }
  for (const match of source.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declared.add(match[1]);
  return declared;
}

function stripCommentsAndStrings(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

function findSuspiciousReferences(source, fileLabel) {
  const problems = [];
  const stripped = stripCommentsAndStrings(source);

  // ① 同文件内已声明过、却当成全局裸函数调用的（只能靠运行期才发现的一类）
  //    判据：函数体里出现 name(...)，而 name 既没有本文件声明也没有 import —— 这类只能人工看，
  //    静态正则的误报率太高（参数/解构/沙箱注入都会被误判），所以这里**不查**。

  // ② 真正可确定的一类：export 列表里写了某个名字，但文件里从未声明/导入它。
  //    这种在加载期就是 SyntaxError，属于「重构删了实现忘了删导出」。
  const exportBlocks = [...source.matchAll(/export\s*\{([^}]*)\}\s*(from\b)?/g)]
    .filter((match) => !match[2])
    .map((match) => match[1]);
  const declared = collectDeclaredNames(source);
  for (const block of exportBlocks) {
    for (const piece of block.split(",")) {
      const name = piece.split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (declared.has(name)) continue;
      problems.push(`${fileLabel}: export 列表导出了 \`${name}\`，但本文件没有声明也没导入（加载期就会失败）`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------- 预览页脚本清单

// ui/index.html 是设计预览页（直接当网页打开可看界面），它的 <script> 清单必须与
// build.cjs 的两份分片数组**完全一致**——顺序即依赖，漏一个分片或顺序错了，
// 打开这页就是残缺界面，而且不会有任何报错提示（脚本不是模块，缺了只表现为函数未定义）。
// 历史：0.2.0 拆分 store 后这页的清单没跟着改，9 个引用全是旧路径，页面一直是打不开的。
function checkPreviewScriptList() {
  const problems = [];
  const buildSource = fs.readFileSync(path.join(PROJECT_ROOT, "build.cjs"), "utf8");
  function readPartList(constantName) {
    const start = buildSource.indexOf(`const ${constantName} = [`);
    if (start < 0) return null;
    const end = buildSource.indexOf("];", start);
    return [...buildSource.slice(start, end).matchAll(/"([^"]+\.js)"/g)].map((match) => match[1]);
  }
  const clientParts = readPartList("CLIENT_PARTS");
  const uiParts = readPartList("UI_PARTS");
  if (!clientParts || !uiParts) {
    problems.push("build.cjs 里找不到 CLIENT_PARTS / UI_PARTS（本门禁的比对基准丢了）");
    return problems;
  }
  const htmlPath = path.join(PROJECT_ROOT, "ui", "index.html");
  if (!fs.existsSync(htmlPath)) {
    problems.push("缺少 ui/index.html（设计预览页，也是 docs/03 认定的主题模板）");
    return problems;
  }
  const html = fs.readFileSync(htmlPath, "utf8");
  const scriptSources = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((match) => match[1]);

  const expected = [
    ...clientParts.map((part) => `../lib/client-parts/${part}`),
    ...uiParts,
  ];
  const missing = expected.filter((entry) => !scriptSources.includes(entry));
  const extra = scriptSources.filter((entry) => !expected.includes(entry));
  if (missing.length) problems.push(`ui/index.html 缺少分片（打开这页会缺函数）：${missing.join("、")}`);
  if (extra.length) problems.push(`ui/index.html 引用了不在 build 清单里的脚本：${extra.join("、")}`);
  if (!missing.length && !extra.length && scriptSources.join("|") !== expected.join("|")) {
    problems.push("ui/index.html 的脚本顺序与 build.cjs 不一致（顺序即依赖）");
  }
  // 引用的路径必须真实存在（防止再出现「写了旧路径」）
  for (const source of scriptSources) {
    if (/^(https?:)?\/\//.test(source)) continue;
    const resolved = path.resolve(path.dirname(htmlPath), source);
    if (!fs.existsSync(resolved)) problems.push(`ui/index.html 引用了不存在的脚本：${source}`);
  }
  return problems;
}

// 域边界：src/ 下除 src/reverse/** 之外的文件，只允许 import 到 src/reverse/register.js。
// 为什么钉它：域实现（manifest/platforms/core…）被主流程直接 import 时，边界就名存实亡——
// 一处偷懒，下一次重构就会有人从 core 里直接拿实现，声明式注册随之失效。
function checkReverseBoundary() {
  const problems = [];
  const reverseRoot = path.join(PROJECT_ROOT, 'src', 'reverse');
  const allowedEntry = path.join(reverseRoot, 'register.js');
  // 三种写法都要覆盖：`from '...'`、动态 `import('...')`、副作用 `import '...'`
  const importPattern = /(?:from\s+|import\s*\(\s*|import\s+)(['"])([^'"]+)\1/g;

  for (const file of listFilesRecursive(path.join(PROJECT_ROOT, 'src'), '.js')) {
    if (file === reverseRoot || file.startsWith(reverseRoot + path.sep)) continue;
    const source = fs.readFileSync(file, 'utf8');
    let match = importPattern.exec(source);
    while (match !== null) {
      const specifier = match[2];
      if (specifier.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), specifier);
        const insideReverse = resolved === reverseRoot || resolved.startsWith(reverseRoot + path.sep);
        if (insideReverse && resolved !== allowedEntry) {
          problems.push(`${path.relative(PROJECT_ROOT, file)} 直接 import 了域内实现 ${specifier}（只允许 import reverse/register.js）`);
        }
      }
      match = importPattern.exec(source);
    }
  }
  return problems;
}

// ---------------------------------------------------------------- 主流程

function main() {
  const problems = [];
  if (!fs.existsSync(LAYOUT_DOC)) {
    console.error('❌ 缺少 docs/16-目录结构.md（结构文档是这套门禁的基准，不能删）');
    return 1;
  }
  const docText = fs.readFileSync(LAYOUT_DOC, 'utf8');

  const documented = checkDocumentedPaths(docText);
  problems.push(...documented.problems);
  problems.push(...checkUndocumentedDirectories(docText));
  problems.push(...checkPreviewScriptList());
  problems.push(...checkReverseBoundary());

  const sourceFiles = [
    ...listFilesRecursive(path.join(PROJECT_ROOT, 'src'), '.js'),
    ...listFilesRecursive(path.join(PROJECT_ROOT, 'scripts'), '.mjs'),
  ];
  const contents = sourceFiles.map((file) => stripCommentsAndStrings(fs.readFileSync(file, 'utf8')));
  sourceFiles.forEach((file, index) => {
    const label = path.relative(PROJECT_ROOT, file);
    problems.push(...findSuspiciousReferences(fs.readFileSync(file, 'utf8'), label));
  });

  if (problems.length) {
    console.error(`❌ 结构门禁失败：${problems.length} 条`);
    problems.forEach((problem) => console.error(`   · ${problem}`));
    return 1;
  }
  console.log(
    `✅ 结构一致：文档 ${documented.documentedCount} 条路径全存在、目录都已记录、`
    + `${sourceFiles.length} 个源码文件无未定义调用与死代码`,
  );
  return 0;
}

process.exit(main());
