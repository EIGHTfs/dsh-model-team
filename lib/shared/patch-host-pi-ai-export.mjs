#!/usr/bin/env node
// patch-host-pi-ai-export.mjs —— 给宿主包 @deepseek-ai/dsh-llm-pi-ai 补一个导出：resolveProfiles。
//
// 为什么需要它（背景，不是猜测）：
//   本插件要做 forward（把协议转换交给官方实现），需要构造宿主导出的 PiAiAdapter；
//   而它的 profiles() 必须返回 ResolvedPiAiProviderProfile，该类型除配置字段外还带
//   piProvider / modelErrors / retryPolicy —— 只能由包内的 resolveProfiles() 生成，
//   但包的公开导出面只有 { Config, PiAiAdapter, apply, inject, name, recordKeyFor, supportedProtocols }。
//
// 为什么可以用「补一行导出」解决：
//   宿主包发布的是**单文件打包产物** lib/index.js，resolveProfiles 以普通函数声明存在于该文件作用域内
//   （实测：`function resolveProfiles(providers, validation = "strict")`），
//   因此在文件末尾补 `export { resolveProfiles };` 即可让它可导入，无需改源码、无需重新编译。
//
// 用法：
//   node lib/shared/patch-host-pi-ai-export.mjs                 # 预演（默认，不改任何文件）
//   node lib/shared/patch-host-pi-ai-export.mjs --apply         # 真改（先备份，再校验）
//   node lib/shared/patch-host-pi-ai-export.mjs --revert        # 从最新备份还原
//   node lib/shared/patch-host-pi-ai-export.mjs --path <bundle> # 显式指定 lib/index.js
//
// 纪律：
//   · 默认预演；--apply 才写盘，且**先备份**（同目录 .bak-<时间戳>），可 --revert 还原
//   · 幂等：已导出则直接报「无需改动」，不重复追加
//   · 写完必验：动态 import 该文件，确认 resolveProfiles 是函数；验证失败自动回滚

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPORT_LINE = 'export { resolveProfiles };';
const SYMBOL_PATTERN = /function\s+resolveProfiles\s*\(/;
const EXPORT_PATTERN = /export\s*\{[^}]*\bresolveProfiles\b[^}]*\}/;

// 候选路径：显式参数 > 环境变量 > 宿主源码目录（本机常见布局）
function candidateBundles(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  if (process.env.DSH_PI_AI_BUNDLE) candidates.push(process.env.DSH_PI_AI_BUNDLE);
  const appRoot = process.env.DSH_APP_ROOT || '';
  if (appRoot) candidates.push(path.join(appRoot, 'packages/llm/llm-pi-ai/lib/index.js'));
  return candidates;
}

async function findBundle(explicitPath) {
  for (const candidate of candidateBundles(explicitPath)) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch { /* 继续试下一个 */ }
  }
  throw new Error(
    '找不到宿主包 bundle。请用 --path <.../dsh-llm-pi-ai/lib/index.js> 指定，'
    + '或设置环境变量 DSH_PI_AI_BUNDLE / DSH_APP_ROOT。',
  );
}

async function latestBackup(bundlePath) {
  const directory = path.dirname(bundlePath);
  const base = path.basename(bundlePath);
  const entries = await fs.readdir(directory);
  const backups = entries
    .filter((name) => name.startsWith(`${base}.bak-`))
    .sort()
    .reverse();
  return backups.length ? path.join(directory, backups[0]) : '';
}

async function verifyExport(bundlePath) {
  // 加查询串绕过 ESM 缓存：否则同一进程里第二次验证可能读到旧的模块实例
  const specifier = `${pathToFileURL(bundlePath).href}?probe=${Date.now()}`;
  const loaded = await import(specifier);
  return typeof loaded.resolveProfiles === 'function';
}

async function applyPatch(bundlePath) {
  const source = await fs.readFile(bundlePath, 'utf8');
  if (EXPORT_PATTERN.test(source)) {
    console.log(`✔ 已导出 resolveProfiles，无需改动：${bundlePath}`);
    return 0;
  }
  if (!SYMBOL_PATTERN.test(source)) {
    console.error(`❌ bundle 里找不到 function resolveProfiles(...)：${bundlePath}`);
    console.error('   宿主版本可能已改结构，请人工核对后再处理（本工具不改不认得的文件）。');
    return 1;
  }

  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backupPath = `${bundlePath}.bak-${timestamp}`;
  await fs.copyFile(bundlePath, backupPath);
  console.log(`📦 已备份：${backupPath}`);

  const patched = `${source.replace(/\s*$/, '')}\n${EXPORT_LINE}\n`;
  await fs.writeFile(bundlePath, patched, 'utf8');

  if (!(await verifyExport(bundlePath))) {
    await fs.copyFile(backupPath, bundlePath);
    console.error('❌ 补充导出后仍无法导入 resolveProfiles，已自动回滚到备份。');
    return 1;
  }
  console.log(`✅ 已补充导出并验证通过：${bundlePath}`);
  console.log('   注意：宿主升级会覆盖该文件，升级后需重跑本工具。');
  return 0;
}

async function revertPatch(bundlePath) {
  const backupPath = await latestBackup(bundlePath);
  if (!backupPath) {
    console.error(`❌ 没有找到备份（${path.basename(bundlePath)}.bak-*），无法还原。`);
    return 1;
  }
  await fs.copyFile(backupPath, bundlePath);
  console.log(`✅ 已从备份还原：${backupPath} → ${bundlePath}`);
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const explicitPath = argv.includes('--path') ? argv[argv.indexOf('--path') + 1] : '';
  const apply = argv.includes('--apply');
  const revert = argv.includes('--revert');

  let bundlePath;
  try {
    bundlePath = await findBundle(explicitPath);
  } catch (findError) {
    console.error(`❌ ${findError.message}`);
    return 1;
  }
  console.log(`目标 bundle：${bundlePath}`);

  if (revert) return revertPatch(bundlePath);

  if (!apply) {
    const source = await fs.readFile(bundlePath, 'utf8');
    const already = EXPORT_PATTERN.test(source);
    const hasSymbol = SYMBOL_PATTERN.test(source);
    console.log(`预演（未改动）：已导出=${already}，bundle 内有 resolveProfiles=${hasSymbol}`);
    console.log(already ? '→ 无需改动' : hasSymbol ? `→ --apply 会在文件末尾追加：${EXPORT_LINE}` : '→ ❌ 不认得的文件，不会改');
    return already || hasSymbol ? 0 : 1;
  }
  return applyPatch(bundlePath);
}

process.exit(await main());
