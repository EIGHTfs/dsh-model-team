// cdp-page.mjs —— 单个页面（tab）的句柄：把「控制台/异常收集」内建进来，场景只管断言。
//
// 从 cdp.mjs 拆出来是为了让两个文件各自职责单一：
//   cdp.mjs      管进程与连接（起浏览器、连 WebSocket、开/关 target）
//   cdp-page.mjs 管一个页面上的动作与观测（导航、求值、等条件、截图、控制台条目）
// 二者都只是协议封装，不含任何业务断言。

import fs from 'node:fs/promises';

// waitFor 只做「条件轮询」：间隔是轮询粒度，不是固定等待（固定 sleep 在慢机器上会假红）
const CONDITION_POLL_MS = 50;

function delay(milliseconds) {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

// 页面句柄：把「控制台/异常收集」内建进来，场景只管断言
export function createPage({ send, on, sessionId, targetId }) {
  const consoleEntries = [];

  function describeRemoteObject(remoteObject) {
    if (!remoteObject) return '';
    if (remoteObject.value !== undefined) return String(remoteObject.value);
    return remoteObject.description || remoteObject.unserializableValue || remoteObject.type || '';
  }

  on('Runtime.consoleAPICalled', (params, eventSessionId) => {
    if (eventSessionId !== sessionId) return;
    const text = (params.args || []).map(describeRemoteObject).join(' ');
    consoleEntries.push({ kind: 'console', level: params.type || 'log', text });
  });
  on('Runtime.exceptionThrown', (params, eventSessionId) => {
    if (eventSessionId !== sessionId) return;
    const details = params.exceptionDetails || {};
    const description = details.exception
      ? (details.exception.description || describeRemoteObject(details.exception))
      : (details.text || '未捕获异常');
    consoleEntries.push({ kind: 'exception', level: 'error', text: description });
  });
  on('Log.entryAdded', (params, eventSessionId) => {
    if (eventSessionId !== sessionId) return;
    const entry = params.entry || {};
    // 带上 url：浏览器把资源 404 也记成 error 级，不写 url 就分不清"自家资源挂了"与"favicon 没给"
    const where = entry.url ? ` ${entry.url}` : '';
    consoleEntries.push({ kind: 'log', level: entry.level || 'info', text: `${entry.source || ''}${where} ${entry.text || ''}`.trim() });
  });

  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, sessionId);
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const text = details.exception
        ? (details.exception.description || describeRemoteObject(details.exception))
        : (details.text || '未知异常');
      throw new Error(`页面内执行异常：${text}\n表达式：${expression}`);
    }
    return result.result ? result.result.value : undefined;
  }

  async function waitFor(expression, { timeoutMs = 10000, description = '' } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(`Boolean(${expression})`)) return;
      } catch (error) {
        lastError = error;   // 页面还没准备好时求值会抛，这是正常的，继续等到超时
      }
      await delay(CONDITION_POLL_MS);
    }
    const reason = lastError ? `；最后一次错误：${lastError.message}` : '';
    throw new Error(`等待条件超时（${timeoutMs}ms）：${description || expression}${reason}`);
  }

  // 真实键盘：用来走「方向键 + Enter 选中 @ 条目」这种只有按键才能触发的路径。
  // 只做场景真正用到的两个键；要更多键时在这里补定义，而不是在场景里手拼 dispatchKeyEvent。
  const KEY_DEFINITIONS = {
    Enter: { code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
    ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  };

  async function pressKey(keyName) {
    const definition = KEY_DEFINITIONS[keyName];
    if (!definition) throw new Error(`未定义的按键：${keyName}（在 cdp-page.mjs 的 KEY_DEFINITIONS 里补）`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...definition }, sessionId);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...definition, text: undefined }, sessionId);
  }

  // 真实鼠标点击：悬浮球用的是 pointerdown/pointerup（为了拖动），只有真实输入事件才会走那条路径
  async function mouseClick({ x, y }) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
  }

  async function goto(url) {
    await send('Page.navigate', { url }, sessionId);
    // 必须连地址一起确认：新 target 初始文档是 about:blank，它的 readyState 天生就是 "complete"，
    // 只等 readyState 会在"导航还没提交"时就当成加载完成（后续求值全打在空白页上）
    const expectedUrl = JSON.stringify(url);
    await waitFor(`location.href === ${expectedUrl} && document.readyState === "complete"`, {
      timeoutMs: 20000,
      description: `页面加载完成：${url}`,
    });
  }

  async function screenshot(filePath) {
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 80 }, sessionId);
    await fs.writeFile(filePath, Buffer.from(shot.data, 'base64'));
    return filePath;
  }

  // 只取 error 级：warning/notice 也有误报（如 404 favicon），门禁不该被它们绊住
  function consoleErrors() {
    return consoleEntries.filter((entry) => entry.level === 'error');
  }

  // 复用同一个标签页跑多个场景时，上一个场景的错误不能算到下一个场景头上
  function clearConsole() {
    consoleEntries.length = 0;
  }

  async function close() {
    try { await send('Target.closeTarget', { targetId }); } catch { /* 页面可能已关 */ }
  }

  const ready = (async () => {
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Log.enable', {}, sessionId);
  })();

  return {
    sessionId,
    ready,
    evaluate,
    pressKey,
    mouseClick,
    waitFor,
    goto,
    screenshot,
    consoleEntries: () => consoleEntries.slice(),
    clearConsole,
    consoleErrors,
    close,
  };
}
