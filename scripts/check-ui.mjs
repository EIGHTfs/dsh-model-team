#!/usr/bin/env node
// check-ui.mjs —— 真渲染门禁的编排层：起 minihost（同源页面 + API）→ 起浏览器 → 跑场景 → 收尾清理。
//
// 与其他门禁的分工：check-contract / check-render / 单测都在「数据与字符串」层面；
// 这一道专门抓「元素在 DOM 里、但人看不见」——层级被盖住、宽度为 0、透明度为 0。
// 只做编排，不写断言：断言在 scripts/ui-scenarios/*.mjs，加场景不用改本文件。
// 外部环境相关的活（探测路径、起停进程、造 fixture）在 scripts/lib/ui-check-env.mjs。
//
// 外部依赖全部走「环境变量优先 + 候选探测」：本文件不写死任何机器专属路径，
// 探测不到就明确报错并告诉你该设哪个变量（静默降级会让门禁变成永远绿）。

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { filterConsoleErrors, writeEvidence } from './lib/ui-check-evidence.mjs';
import {
  prepareFixture,
  resolveChrome,
  resolveUsefulToolsRoot,
  findFreePort,
  waitForHttp,
  startMinihost,
  stopProcessGroup,
} from './lib/ui-check-env.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFLIGHT_TIMEOUT_MS = 20000;
const DEFAULT_SHOT_DIR = path.join(REPO_ROOT, 'artifacts', 'ui-check');

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const args = { only: '', list: false, shotDir: DEFAULT_SHOT_DIR, allowSkip: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--list') args.list = true;
    else if (token === '--allow-skip') args.allowSkip = true;
    else if (token === '--only') { args.only = argv[index + 1] || ''; index += 1; }
    else if (token === '--shot-dir') { args.shotDir = path.resolve(argv[index + 1] || DEFAULT_SHOT_DIR); index += 1; }
  }
  return args;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { scenarios } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'ui-scenarios', 'index.mjs')).href);

  if (args.list) {
    scenarios.forEach((scenario) => console.log(`${scenario.id}\t${scenario.title}`));
    return 0;
  }

  const selected = args.only ? scenarios.filter((scenario) => scenario.id === args.only) : scenarios;
  if (!selected.length) {
    console.error(`没有匹配的场景：--only ${args.only}（用 --list 看可用 id）`);
    return 1;
  }

  let chromePath = '';
  let usefulToolsRoot = '';
  try {
    chromePath = await resolveChrome(process.env.DMT_CHROME || '');
    usefulToolsRoot = await resolveUsefulToolsRoot(process.env.DSH_USEFUL_TOOLS_ROOT || '');
  } catch (resolveError) {
    console.error(`❌ ${resolveError.message}`);
    return 1;
  }

  // 前置自检：wrapper 版本打不出来说明内核环境坏了——此时「跳过」会让门禁失去意义，默认算失败
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      execFile(chromePath, ['--version'], { timeout: PREFLIGHT_TIMEOUT_MS }, (error, out) => {
        if (error) reject(error); else resolve({ stdout: out });
      });
    });
    console.log(`🖥  浏览器：${chromePath}（${stdout.trim()}）`);
  } catch (preflightError) {
    const message = `浏览器前置自检失败：${preflightError.message}`;
    if (args.allowSkip) {
      console.log(`⚠️  ${message}（--allow-skip，按跳过处理）`);
      return 0;
    }
    console.error(`❌ ${message}\n   若当前环境确实没有浏览器，请显式加 --allow-skip。`);
    return 1;
  }

  const startedAt = Date.now();
  const { tempRoot, dataRoot } = await prepareFixture();
  const shotDir = args.shotDir;
  let minihost = null;
  let browser = null;
  let cdp = null;
  let port = 0;
  let failureCount = 0;

  try {
    const { generatePreview } = await import(pathToFileURL(path.join(usefulToolsRoot, 'lib/core/preview/gen.js')).href);
    const previewPath = path.join(tempRoot, 'preview.html');
    const generated = await generatePreview({ plugin: REPO_ROOT, out: previewPath });
    if (!generated.ok) throw new Error(`生成预览页失败：${generated.error}`);

    port = await findFreePort();
    const started = await startMinihost({
      hostScript: path.join(usefulToolsRoot, 'lib', 'core', 'minihost', 'host.mjs'),
      pluginRoot: REPO_ROOT,
      port,
      previewPath,
      dataRoot,
      logPath: path.join(tempRoot, 'minihost.log'),
    });
    minihost = started.process;
    console.log(`🛠  minihost：pid ${minihost.pid} 端口 ${port}（数据根 ${dataRoot}）`);

    const { launchBrowser, connect } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/cdp.mjs')).href);
    const userDataDir = path.join(tempRoot, 'chrome-profile');
    browser = await launchBrowser({ executablePath: chromePath, userDataDir, port: await findFreePort() });
    cdp = await connect(browser.webSocketUrl);

    const pageUrl = `http://127.0.0.1:${port}/`;
    // 所有场景复用同一个标签页：实测「每个场景新建一个 target」时，第二个标签页偶发长时间
    // 不执行脚本（30s 都等不到 .dmt-host，且没有任何控制台错误）。场景本身都以 goto 开头，
    // 复用标签页不会串状态；控制台条目按场景 clearConsole 归零。
    const page = await cdp.newPage();
    await page.ready;
    for (const scenario of selected) {
      page.clearConsole();
      const assertions = [];
      let scenarioError = null;
      try {
        const produced = await scenario.run(page, { url: pageUrl, shotDir, dataRoot, port });
        assertions.push(...produced);
      } catch (error) {
        scenarioError = error;
      }
      const consoleErrors = filterConsoleErrors(page.consoleErrors());
      assertions.push({
        title: '页面无 console error / 未捕获异常',
        ok: consoleErrors.length === 0,
        detail: consoleErrors.map((entry) => `${entry.kind}: ${entry.text}`).join(' | '),
      });
      if (scenarioError) {
        assertions.push({ title: '场景执行未抛错', ok: false, detail: scenarioError.message });
      }

      console.log(`\n▶ ${scenario.id} · ${scenario.title}`);
      assertions.forEach((assertion) => {
        console.log(`  ${assertion.ok ? '✅' : '❌'} ${assertion.title}${assertion.ok || !assertion.detail ? '' : `\n      ${assertion.detail}`}`);
      });

      const failed = assertions.filter((assertion) => !assertion.ok);
      if (failed.length) {
        failureCount += failed.length;
        const evidence = await writeEvidence({ shotDir, scenarioId: scenario.id, assertions, page, consoleErrors });
        console.log(`  📎 证据：${evidence.shotPath}\n           ${evidence.domPath}\n           ${evidence.logPath}`);
      }
    }
    await page.close();
  } catch (error) {
    console.error(`❌ 门禁执行中断：${error && error.stack ? error.stack : error}`);
    failureCount += 1;
  } finally {
    if (cdp) cdp.close();
    if (browser) await browser.stop();
    if (minihost) await stopProcessGroup(minihost, port);
    await fs.rm(tempRoot, { recursive: true, force: true });
    console.log(`\n🧹 已清理：浏览器进程组、minihost 进程组（端口 ${port}）、临时数据根 ${dataRoot}`);
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (failureCount) {
    console.error(`\n❌ 真渲染门禁失败：${failureCount} 条断言不通过（耗时 ${seconds}s）`);
    return 1;
  }
  console.log(`\n✅ 真渲染门禁通过：${selected.length} 个场景（耗时 ${seconds}s）`);
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(`❌ 未预期错误：${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
