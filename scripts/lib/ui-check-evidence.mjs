// ui-check-evidence.mjs —— 断言失败时的证据落盘：截图 + 当前 DOM + console 日志。
//
// 为什么单独一个文件：证据是「给人排障用的产物」，与门禁的判定逻辑无关；
// 混在编排里时，改断言的人容易顺手改坏取证，导致真出事时没有可看的东西。
// 控制台错误的「良性过滤」规则也放这里：什么算噪声属于取证口径。

import fs from 'node:fs/promises';
import path from 'node:path';

// 浏览器会把「资源 404」也记成 error 级。以下两类与「界面能否被看见」无关，排除：
//   ① favicon：浏览器自己发的请求，预览页没有站点图标属正常；
//   ② /_team/sessions/current：宿主提供的会话接口，minihost 不实现（它只跑插件自己的路由），
//      客户端对此已有「宿主不给会话」的降级路径。
// 其余 404（自家 js/css/图片）一律保留为失败信号，绝不整体忽略网络错误。
const BENIGN_CONSOLE_ERROR_PATTERNS = [/favicon\.ico/i, /\/_team\/sessions\/current\b/];

function filterConsoleErrors(entries) {
  return entries.filter((entry) => !BENIGN_CONSOLE_ERROR_PATTERNS.some((pattern) => pattern.test(entry.text)));
}

// 失败时同时留三样：截图（人眼一看就知道被谁盖住）、DOM（能搜选择器与内联样式）、
// console 日志（页面报错原文）。只留截图的话，复盘时还得再跑一遍。
async function writeEvidence({ shotDir, scenarioId, assertions, page, consoleErrors }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = path.join(shotDir, `${scenarioId}-${stamp}`);
  await fs.mkdir(shotDir, { recursive: true });
  const shotPath = `${baseName}.jpg`;
  const domPath = `${baseName}.html`;
  const logPath = `${baseName}.log`;
  await page.screenshot(shotPath).catch(() => {});
  await page.evaluate('document.documentElement.outerHTML').then((html) => fs.writeFile(domPath, html)).catch(() => {});
  const lines = [];
  assertions.forEach((assertion) => {
    lines.push(`${assertion.ok ? 'PASS' : 'FAIL'} ${assertion.title}${assertion.detail ? ` :: ${assertion.detail}` : ''}`);
  });
  consoleErrors.forEach((entry) => lines.push(`CONSOLE ${entry.kind}/${entry.level} ${entry.text}`));
  await fs.writeFile(logPath, lines.join('\n') + '\n');
  return { shotPath, domPath, logPath };
}

export { filterConsoleErrors, writeEvidence };
