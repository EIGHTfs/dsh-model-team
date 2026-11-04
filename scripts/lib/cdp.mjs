// cdp.mjs —— 零依赖的 Chrome DevTools Protocol 客户端（只够真渲染自检用）。
//
// 为什么自己写：本仓库零依赖，不能装 playwright/puppeteer；Node 22 自带全局 WebSocket，
// 够我们把「起浏览器 → 开页 → 求值 → 截图 → 收控制台错误 → 收进程」这条链走完。
//
// 这一层只管协议：不判断页面业务、不写断言。场景在 scripts/ui-scenarios/*.mjs。
// 超时策略：每个 CDP 调用都有超时（否则页面卡死会把门禁一起挂住）；
// waitFor 只轮询条件，不做「固定睡 N 毫秒」——固定睡眠在慢机器上会假红、在快机器上白等。

import { spawn } from 'node:child_process';

import { createPage } from './cdp-page.mjs';

const LAUNCH_TIMEOUT_MS = 20000;     // 起浏览器到 CDP 端口可用
const VERSION_POLL_MS = 100;         // 轮询 /json/version 的间隔
const RESPONSE_TIMEOUT_MS = 15000;   // 单个 CDP 调用的响应超时
const CONDITION_POLL_MS = 50;        // waitFor 内部轮询间隔（条件驱动，不是固定等待）
const TERMINATE_GRACE_MS = 3000;     // SIGTERM 到 SIGKILL 的宽限

function delay(milliseconds) {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

// 读 /json/version 直到拿到 webSocketDebuggerUrl；失败要带原因，不能只说"启动失败"
async function fetchWebSocketUrl(port, deadline) {
  const versionUrl = `http://127.0.0.1:${port}/json/version`;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(versionUrl);
      if (response.ok) {
        const info = await response.json();
        if (info && info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
        lastError = '/json/version 没有 webSocketDebuggerUrl';
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
    }
    await delay(VERSION_POLL_MS);
  }
  throw new Error(`启动浏览器后 ${LAUNCH_TIMEOUT_MS}ms 内 CDP 端口不可用（${versionUrl}：${lastError}）`);
}

// 起浏览器并连上：detached=true 是为了能按进程组整组收掉（Chrome 会派生多个子进程）
export async function launchBrowser({ executablePath, userDataDir, port, extraArgs = [] }) {
  if (!executablePath) throw new Error('launchBrowser 缺少 executablePath');
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
    ...extraArgs,
  ];
  const childProcess = spawn(executablePath, args, { detached: true, stdio: 'ignore' });
  let closed = false;
  childProcess.on('exit', () => { closed = true; });

  const webSocketUrl = await fetchWebSocketUrl(port, Date.now() + LAUNCH_TIMEOUT_MS).catch(async (launchError) => {
    await stop();
    throw launchError;
  });

  let stopPromise = null;
  // 必须可重复调用：场景失败、断言失败、finally 都可能各调一次
  function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (closed) return;
      try { process.kill(-childProcess.pid, 'SIGTERM'); } catch { /* 已经没了 */ }
      const deadline = Date.now() + TERMINATE_GRACE_MS;
      while (!closed && Date.now() < deadline) await delay(50);
      if (!closed) {
        try { process.kill(-childProcess.pid, 'SIGKILL'); } catch { /* 已经没了 */ }
      }
    })();
    return stopPromise;
  }

  return { webSocketUrl, processId: childProcess.pid, stop };
}

// 连上浏览器级 WebSocket（后续用 sessionId 区分页面）
export async function connect(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error(`连接 CDP 失败：${webSocketUrl}`)), { once: true });
  });

  const pendingCalls = new Map();
  const eventHandlers = new Map();
  let nextMessageId = 1;

  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id) {
      const pendingCall = pendingCalls.get(message.id);
      if (!pendingCall) return;
      pendingCalls.delete(message.id);
      clearTimeout(pendingCall.timer);
      if (message.error) pendingCall.reject(new Error(`${message.error.message || 'CDP 错误'}（${message.error.code}）`));
      else pendingCall.resolve(message.result);
      return;
    }
    const handlers = eventHandlers.get(message.method);
    if (!handlers) return;
    handlers.forEach((handler) => {
      try { handler(message.params, message.sessionId); } catch { /* 监听器自身出错不能打断协议流 */ }
    });
  });

  function send(method, params = {}, sessionId) {
    if (socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP 连接已关闭，无法发送 ${method}`));
    }
    const id = nextMessageId;
    nextMessageId += 1;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCalls.delete(id);
        reject(new Error(`CDP 调用超时 ${RESPONSE_TIMEOUT_MS}ms：${method}`));
      }, RESPONSE_TIMEOUT_MS);
      pendingCalls.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify(payload));
    });
  }

  function on(method, handler) {
    if (!eventHandlers.has(method)) eventHandlers.set(method, new Set());
    eventHandlers.get(method).add(handler);
  }

  async function newPage() {
    const created = await send('Target.createTarget', { url: 'about:blank' });
    const attached = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    return createPage({ send, on, sessionId: attached.sessionId, targetId: created.targetId });
  }

  function close() {
    try { socket.close(); } catch { /* 已关闭 */ }
  }

  return { send, on, newPage, close };
}

// 页面句柄在 cdp-page.mjs（本文件只管进程与连接）
