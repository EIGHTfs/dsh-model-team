// ui-contract-harness.mjs —— 界面契约门禁的**公共底座**：自起后端、vm 加载渲染层、断言工具。
//
// 为什么抽出来：check-ui-contract.mjs 里「断言」与「怎么把被测代码跑起来 / 怎么起后端」混在一起，
// 前者是门禁的知识，后者是与具体断言无关的机械活。混着写的结果是主文件顶到 400 行上限，
// 再往下压就只能牺牲可读性——而 docs/05 §二 明令禁止为压行数牺牲可读性。
//
// 这里只放「与断言无关」的东西：
//   · 后端：探空闲端口 → 起 mock-team-server → 等就绪 → 跑完关掉（不依赖人先手工起服务）；
//   · 渲染层：把 ui/js 的分片按真实 bundle 的作用域顺序拼起来在 vm 里执行；
//   · 源码扫描面：ui/js 与 ui/themes 的文件清单；
//   · 输出：断言结果的统一打印。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, '..', '..');

export const PATHS = {
  renderSource: path.join(PROJECT_ROOT, 'ui/js/view/render.js'),
  formatSource: path.join(PROJECT_ROOT, 'ui/js/format/ui-format.js'),
  mockServer: path.join(PROJECT_ROOT, 'scripts/mock-team-server.mjs'),
  platformPreset: path.join(PROJECT_ROOT, 'config/platforms.json'),
  reversePlatforms: path.join(PROJECT_ROOT, 'src/reverse/platforms'),
};

const UI_SOURCE_DIRECTORIES = ['ui/js', 'ui/themes'].map((relativePath) => path.join(PROJECT_ROOT, relativePath));
const UI_SOURCE_EXTENSIONS = /\.(js|mjs|cjs|ts|tsx|jsx|html|css)$/;
const REQUEST_TIMEOUT_MS = 8000;
const MOCK_READY_TIMEOUT_MS = 15000;
const MOCK_READY_POLL_INTERVAL_MS = 120;

export const readTextFile = (filePath) => fs.readFileSync(filePath, 'utf8');

/** 读目录项：不存在或没权限时返回空数组（扫描面为空由断言自己判红，不在这里抛） */
export function readDirectoryEntries(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * 在隔离上下文里执行渲染分片，取回渲染函数。
 * 分片是「给浏览器用的普通脚本」（没有 export），要拿到函数只能执行它；vm 给空沙箱，
 * 既拿得到函数又不污染门禁进程的全局（与 check-render.mjs 同一做法）。
 */
export function loadRenderLayer(sourceText, filename = 'ui/js/view/render.js') {
  const sandbox = vm.createContext({ console });
  try {
    return vm.runInContext(`${sourceText}\n;({ renderGroupList: renderGroupList, renderChat: renderChat })`, sandbox, { filename });
  } catch (error) {
    throw new Error(`执行 ${filename} 失败（拿不到 renderGroupList/renderChat）：${error.message}`);
  }
}

/** 界面源码清单：U-3 的扫描面（ui/js 与 ui/themes 递归） */
export function collectUiSourceFiles() {
  const files = [];
  const walk = (directory) => {
    for (const entry of readDirectoryEntries(directory)) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(fullPath); continue; }
      if (!UI_SOURCE_EXTENSIONS.test(entry.name)) continue;
      files.push({ path: path.relative(PROJECT_ROOT, fullPath).split(path.sep).join('/'), text: readTextFile(fullPath) });
    }
  };
  for (const directory of UI_SOURCE_DIRECTORIES) walk(directory);
  return files;
}

/**
 * 两个分片在真实 bundle 里是同一个作用域（build.cjs 的 UI_PARTS 顺序 format → render）：
 * 展示口径函数住在 ui-format.js 且要调用 render.js 的 escapeHtml，所以必须拼起来再执行。
 */
export const readSources = () => ({
  renderSourceText: `${readTextFile(PATHS.formatSource)}\n${readTextFile(PATHS.renderSource)}`,
  uiFiles: collectUiSourceFiles(),
});

function listenOnEphemeralPort(host) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForBackend(baseUrl, deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/_team/groups`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) return;
    } catch {
      // 还没起来，继续等：子进程 listen 与父进程探测有先后，不是错误
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, MOCK_READY_POLL_INTERVAL_MS));
  }
  throw new Error(`假后端 ${baseUrl} 在 ${MOCK_READY_TIMEOUT_MS}ms 内没有就绪`);
}

/**
 * 自起假后端：先探一个空闲端口，再起 mock-team-server。
 * 为什么不复用固定的 8766：gate-all 要能在任何机器任何时刻跑，不该要求人先手工起服务；
 * 也不能直接连 8766——那可能是别的进程占着，连上去验的就不是本次代码了。
 */
export async function startMockBackend() {
  const port = await listenOnEphemeralPort('127.0.0.1');
  const child = spawn(process.execPath, [PATHS.mockServer, '--port', String(port)], { cwd: PROJECT_ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  let childStderr = '';
  child.stderr.on('data', (chunk) => { childStderr += String(chunk); });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForBackend(baseUrl, Date.now() + MOCK_READY_TIMEOUT_MS);
  } catch (error) {
    child.kill();
    const detail = childStderr.trim() ? `（子进程 stderr：${childStderr.trim().slice(0, 300)}）` : '';
    throw new Error(`${error.message}${detail}`);
  }
  return { baseUrl, close: () => child.kill() };
}

export async function fetchGroups(baseUrl) {
  const groupsEndpoint = `${baseUrl}/_team/groups`;
  let response;
  try {
    response = await fetch(groupsEndpoint, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (networkError) {
    throw new Error(`连不上后端 ${groupsEndpoint}（${networkError.message}）`);
  }
  if (!response.ok) throw new Error(`GET ${groupsEndpoint} 返回 HTTP ${response.status}`);
  const payload = await response.json();
  const groups = Array.isArray(payload) ? payload : payload && payload.groups;
  if (!Array.isArray(groups)) throw new Error(`GET ${groupsEndpoint} 响应里没有 groups 数组`);
  return groups;
}

export function readArgument(argv, flagName) {
  const flagIndex = argv.indexOf(flagName);
  return flagIndex < 0 ? '' : String(argv[flagIndex + 1] || '');
}

/** 后端来源：给了 --base 就用它（人工排查），否则自起假后端并在结束时关掉 */
export async function withBackend(argv, run) {
  const explicitBase = readArgument(argv, '--base');
  const backend = explicitBase ? null : await startMockBackend();
  try {
    return await run(explicitBase || backend.baseUrl);
  } finally {
    if (backend) backend.close();
  }
}

export function printAssertionResult(assertionResult) {
  console.log(`${assertionResult.ok ? '✓' : '✗'} ${assertionResult.id} ${assertionResult.title}`);
  for (const problem of assertionResult.problems) String(problem).split('\n').forEach((line) => console.log(`    ${line}`));
}
