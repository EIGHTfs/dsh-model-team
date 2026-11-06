#!/usr/bin/env node
// test-all.mjs —— 全量跑用例，并把「抖动」与「真失败」分开判定。
//
// 为什么需要它：`node --test` 默认按 CPU 并行，全量下偶发时序抖动（同一条用例单跑 10/10 绿），
// 直接把它当红会逼人「多跑几次撞绿」，那既不是诊断也会把正常用例改坏。
// 判据（docs/05 §测试抖动）：
//   全量绿                        → 通过
//   全量红、失败文件单跑全绿       → 抖动：**通过**，但必须落一条留痕（artifacts/flaky.jsonl）
//   全量红、单跑仍红               → 真失败：两次输出都打出来，exit 1
//
// 用法：
//   node scripts/test-all.mjs                 # 默认跑 test/*.test.js
//   node scripts/test-all.mjs --json          # 机器可读结果（接 CI）
//   node scripts/test-all.mjs --no-retry      # 严格全量：红就是红，不单跑复验
//   node scripts/test-all.mjs --files a.test.js b.test.js   # 指定文件集（演练/排查用）
//
// 零依赖：只用 node:child_process / node:fs。

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TEST_GLOB_DIRECTORY = 'test';
const TEST_FILE_SUFFIX = '.test.js';
const FLAKY_LOG_PATH = path.join(REPO_ROOT, 'artifacts', 'flaky.jsonl');
// 留痕里只保留失败断言附近的行，避免把整份 TAP 塞进去（几十 KB）
const FAILURE_TAIL_LINES = 40;

function parseArgs(argv) {
  const options = { json: false, retry: true, files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--json') options.json = true;
    else if (current === '--no-retry') options.retry = false;
    else if (current === '--files') {
      // 逗号或空格分隔都接受
      const collected = [];
      let cursor = index + 1;
      while (cursor < argv.length && !argv[cursor].startsWith('--')) {
        collected.push(...argv[cursor].split(',').filter(Boolean));
        cursor += 1;
      }
      options.files.push(...collected);
      index = cursor - 1;
    }
  }
  return options;
}

async function listTestFiles() {
  const directory = path.join(REPO_ROOT, DEFAULT_TEST_GLOB_DIRECTORY);
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith(TEST_FILE_SUFFIX)).sort();
  return names.map((name) => path.join('test', name));
}

// 跑一次 node --test；不抛错，把 exit code / 输出 / 耗时一起交回
function runTestFiles(fileArguments) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--test', ...fileArguments],
      { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          exitCode: error?.code ?? 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          durationMs: Date.now() - startedAt,
        });
      },
    );
  });
}

// TAP 里失败块形如：
//   not ok 3 - 测试名
//     ---
//     location: '/abs/path/test/foo.test.js:12:1'
// 先按块抓 location，抓不到再退回"输出里出现过的 test/*.test.js"
// 仓库内的文件给相对路径（好读、可直接复制去单跑）；仓库外（演练脚本）保留绝对路径
export function toDisplayPath(absolutePath) {
  const relativePath = path.relative(REPO_ROOT, absolutePath);
  return relativePath.startsWith('..') ? absolutePath : relativePath;
}

export function parseFailingFiles(output) {
  const failingFiles = new Set();
  const lines = String(output).split('\n');
  let insideFailureBlock = false;

  for (const line of lines) {
    if (/^not ok \d+ - /.test(line)) {
      insideFailureBlock = true;
      continue;
    }
    if (insideFailureBlock) {
      const locationMatch = /location:\s*'([^']+)'/.exec(line);
      if (locationMatch) {
        const filePath = locationMatch[1].split(':')[0];
        if (filePath.endsWith(TEST_FILE_SUFFIX)) failingFiles.add(toDisplayPath(filePath));
        insideFailureBlock = false;
        continue;
      }
      // 失败块里的断言详情可能很长；遇到下一个 ok/not ok 就收尾
      if (/^(ok|not ok) \d+ - /.test(line)) insideFailureBlock = false;
    }
  }

  // 兜底：TAP 头部有时只给汇总，直接在全文里找 test/*.test.js
  if (failingFiles.size === 0) {
    const fallbackMatches = String(output).match(/test\/[\w.-]+\.test\.js/g) ?? [];
    for (const matched of fallbackMatches) failingFiles.add(matched);
  }
  return [...failingFiles];
}

export function parsePassCount(output) {
  const matched = /# pass (\d+)/.exec(String(output));
  return matched ? Number(matched[1]) : null;
}

// 失败断言前的若干行：用于留痕时回看"当时红在哪"，不必翻整份输出
export function extractFailureTail(output) {
  const lines = String(output).split('\n');
  const firstFailureIndex = lines.findIndex((line) => /^not ok \d+ - /.test(line));
  if (firstFailureIndex < 0) return lines.slice(-FAILURE_TAIL_LINES).join('\n');
  return lines.slice(firstFailureIndex, firstFailureIndex + FAILURE_TAIL_LINES).join('\n');
}

async function appendFlakyRecord(record) {
  await fs.mkdir(path.dirname(FLAKY_LOG_PATH), { recursive: true });
  await fs.appendFile(FLAKY_LOG_PATH, `${JSON.stringify(record)}\n`, 'utf8');
}

function formatSeconds(durationMs) {
  return `${(durationMs / 1000).toFixed(1)} 秒`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const testFiles = options.files.length > 0 ? options.files : await listTestFiles();

  const firstRun = await runTestFiles(testFiles);
  const combinedOutput = `${firstRun.stdout}${firstRun.stderr}`;
  const passCount = parsePassCount(combinedOutput);

  if (firstRun.ok) {
    if (options.json) {
      console.log(JSON.stringify({ status: 'pass', passCount, durationMs: firstRun.durationMs }, null, 2));
    } else {
      console.log(`✅ 全量通过（${passCount ?? '?'} 例，${formatSeconds(firstRun.durationMs)}）`);
    }
    process.exit(0);
  }

  if (!options.retry) {
    console.error(combinedOutput.trim());
    console.error(`❌ 真失败（--no-retry：不做单跑复验）`);
    process.exit(1);
  }

  const failingFiles = parseFailingFiles(combinedOutput);
  if (failingFiles.length === 0) {
    // 连失败文件都解析不出：按真失败处理，避免"绿得不明不白"
    console.error(combinedOutput.trim());
    console.error('❌ 真失败（无法从输出解析出失败文件，未做单跑复验）');
    process.exit(1);
  }

  const retryRun = await runTestFiles(failingFiles);
  const retryOutput = `${retryRun.stdout}${retryRun.stderr}`;

  if (retryRun.ok) {
    const flakyRecord = {
      at: new Date().toISOString(),
      files: failingFiles,
      firstFailTail: extractFailureTail(combinedOutput),
    };
    await appendFlakyRecord(flakyRecord);
    if (options.json) {
      console.log(JSON.stringify({
        status: 'flaky',
        passCount,
        files: failingFiles,
        firstRunMs: firstRun.durationMs,
        retryMs: retryRun.durationMs,
        logPath: path.relative(REPO_ROOT, FLAKY_LOG_PATH),
      }, null, 2));
    } else {
      console.log(`⚠ 抖动：${failingFiles.join('、')} 首跑失败、单跑通过`);
      console.log(`  已记录到 ${path.relative(REPO_ROOT, FLAKY_LOG_PATH)}（累积到 3 条以上请单独立项定位）`);
    }
    process.exit(0);
  }

  // 单跑仍红：两次输出都打出来，便于对比"是并发抖动还是真坏"
  console.error('—— 首次全量输出 ——');
  console.error(combinedOutput.trim());
  console.error('—— 失败文件单跑输出 ——');
  console.error(retryOutput.trim());
  console.error(`❌ 真失败：${failingFiles.join('、')}（单跑仍红）`);
  process.exit(1);
}

// 只在直接执行时跑 main：被测试 import 时不产生副作用
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
