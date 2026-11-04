// ui-check-env.mjs —— 真渲染门禁的「外部环境」部分：探测浏览器与 useful-tools、找空闲端口、
// 起/停 minihost、造隔离 fixture。与断言无关，也与「怎么跑场景」无关。
//
// 放在单独文件里的原因：这些代码几乎全是失败路径（探测不到、起不来、收不干净），
// 与编排逻辑（跑场景、打印、存证据）混在一个文件里时，改断言的人会不小心动到清理逻辑。

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 本模块在 scripts/lib/ 下，仓库根是上两级
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const HOST_START_TIMEOUT_MS = 30000;
const PORT_RELEASE_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------- 外部路径探测

async function isExecutableFile(candidate) {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return false;
    await fs.access(candidate, 1);   // X_OK
    return true;
  } catch { return false; }
}

// 浏览器：DMT_CHROME 优先；否则按候探测（DSH 应用数据目录里的 wrapper / PATH 里的常见名字）
async function resolveChrome(executablePathFromEnv) {
  const appDataRoot = process.env.DSH_APP_DATA || '';
  const candidates = [
    executablePathFromEnv,
    appDataRoot ? path.join(appDataRoot, 'browser-wrapper.sh') : '',
    '/volume1/@appdata/DeepSeekHarness-NAS/browser-wrapper.sh',
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) return candidate;
  }
  throw new Error(
    '找不到 Chrome 可执行文件。请设置 DMT_CHROME=<路径>（本机可用 DSH 的 browser-wrapper.sh）。\n'
    + `已探测：${candidates.join(' | ')}`,
  );
}

// useful-tools：DSH_USEFUL_TOOLS_ROOT 优先；否则从本仓库的兄弟目录里找「含 minihost/preview 的那份」
async function resolveUsefulToolsRoot(rootFromEnv) {
  const candidates = [rootFromEnv, path.join(REPO_ROOT, '..', 'dsh-useful-tools')].filter(Boolean);
  for (const candidate of candidates) {
    const hostScript = path.join(candidate, 'lib', 'core', 'minihost', 'host.mjs');
    const previewScript = path.join(candidate, 'lib', 'core', 'preview', 'gen.js');
    if (await isExecutableFile(process.execPath) && await pathExists(hostScript) && await pathExists(previewScript)) {
      return candidate;
    }
  }
  throw new Error(
    '找不到 dsh-useful-tools（需要其中的 minihost 与 preview 生成器）。请设置 DSH_USEFUL_TOOLS_ROOT=<目录>。\n'
    + `已探测：${candidates.join(' | ')}`,
  );
}

async function pathExists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

// ---------------------------------------------------------------- 端口与进程

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastReason = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
      lastReason = `HTTP ${response.status}`;
    } catch (error) {
      lastReason = error && error.message ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`等待 ${url} 超时（${timeoutMs}ms）：${lastReason}`);
}

// 先按进程组收（minihost 会 fork 每请求子进程），再确认端口不再接受连接
async function stopProcessGroup(childProcess, port) {
  if (!childProcess) return;
  const killGroup = (signal) => {
    try { process.kill(-childProcess.pid, signal); } catch { /* 已退出 */ }
  };
  killGroup('SIGTERM');
  const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/_team/friend-groups`);
      await delay(100);
    } catch {
      break;   // 端口不再应答 = 进程真的走了
    }
  }
  killGroup('SIGKILL');
}

// ---------------------------------------------------------------- fixture

function buildFixtureConfig() {
  const group = (id, name, models) => ({
    id,
    name,
    accessMode: 'compatible',
    driver: 'openai-compatible',
    baseURL: 'http://127.0.0.1:9/v1',       // 自检不真的打上游：模型目录走 models.static
    defaultModel: models[0],
    auth: { type: 'bearer', header: 'Authorization', apiKeyRef: 'file:ui-check-key.txt' },
    models: { static: models },
    request: { modelField: 'model', extraHeaders: {} },
    response: { usagePath: 'usage' },
  });
  return {
    groups: [
      group('p-alpha', 'Alpha 平台', ['alpha-1', 'alpha-2']),
      group('p-beta', 'Beta 平台', ['beta-1', 'beta-2']),
      group('p-gamma', 'Gamma 平台', ['gamma-1']),
    ],
    friendGroups: [],
    virtualModel: 'dsh-model-team',
    contextWindowFallback: 1048576,
  };
}

async function prepareFixture() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dmt-ui-check-'));
  const dataRoot = path.join(tempRoot, 'data');
  await fs.mkdir(path.join(dataRoot, 'sessions'), { recursive: true });
  await fs.writeFile(path.join(dataRoot, 'config.json'), JSON.stringify(buildFixtureConfig(), null, 2) + '\n');
  await fs.writeFile(path.join(dataRoot, 'ui-check-key.txt'), 'ui-check-not-a-real-key\n');
  return { tempRoot, dataRoot };
}



// 起 minihost 并等到它自己的 API 应答：detached 是必须的（它会为每个请求 fork 子进程，
// 只有整组 SIGTERM 才能连根收掉），数据根通过环境变量隔离，绝不碰真实配置。
async function startMinihost({ hostScript, pluginRoot, port, previewPath, dataRoot, logPath }) {
  const logHandle = await fs.open(logPath, 'w');
  const childProcess = spawn(process.execPath, [
    hostScript, '--plugin', pluginRoot, '--port', String(port), '--preview', previewPath, '--quiet',
  ], {
    detached: true,
    stdio: ['ignore', logHandle.fd, logHandle.fd],
    env: { ...process.env, DSH_MODEL_TEAM_HOME: dataRoot },
  });
  try {
    await waitForHttp(`http://127.0.0.1:${port}/_team/friend-groups`, HOST_START_TIMEOUT_MS);
  } catch (startError) {
    await stopProcessGroup(childProcess, port);
    throw startError;
  }
  return { process: childProcess, logPath };
}


// 打开预览页并等客户端挂载。为什么要重试一次：
// 实测这个内联 1.3MB 客户端 + React UMD 的页面偶发「首帧脚本没挂载」（页面已完整加载、
// 没有任何控制台错误，就是 .dmt-host 不出现），重新导航一次即恢复。
// 重试有上界（2 次）：第二次仍不挂载就照实红——绝不用无限重试掩盖真实的挂载失败。
// 单次挂载预算：正常一次加载约 1s；实测偶发要等更久（渲染进程冷启 + 1.4MB 内联脚本解析）。
// 给 8s 一轮、最多 3 轮（最坏 24s 才判红）：预算不是"断言强度"，只是给冷启动留余量，
// 压小它能显著压低抖动时的总耗时。轮数有上界，绝不无限重试。
const APP_MOUNT_TIMEOUT_MS = 8000;
const APP_MOUNT_ATTEMPTS = 3;

async function openApp(page, url) {
  let lastError = null;
  for (let attempt = 1; attempt <= APP_MOUNT_ATTEMPTS; attempt += 1) {
    await page.goto(url);
    try {
      await page.waitFor('document.querySelector(".dmt-host")', {
        timeoutMs: APP_MOUNT_TIMEOUT_MS,
        description: '客户端脚本挂载 .dmt-host',
      });
      // 只有重试过才打印：让"这次为什么慢"在日志里自证，而不是靠人猜
      if (attempt > 1) console.log(`   ↩ 首次挂载未完成，第 ${attempt} 次重新加载后成功`);
      return attempt;
    } catch (mountError) {
      lastError = mountError;
    }
  }
  throw lastError;
}

export {
  isExecutableFile,
  pathExists,
  resolveChrome,
  resolveUsefulToolsRoot,
  findFreePort,
  delay,
  waitForHttp,
  stopProcessGroup,
  buildFixtureConfig,
  prepareFixture,
  startMinihost,
  openApp,
  HOST_START_TIMEOUT_MS,
};
