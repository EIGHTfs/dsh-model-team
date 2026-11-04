#!/usr/bin/env node
// gate-all.mjs —— 手动一次跑完全部门禁的入口。
//
// 定位：**人手动跑**（提交前、改完前端后）。本文件刻意不装 git hook、不写 install 脚本、
// 不改 .git/hooks、不碰 CI —— 门禁是被调用的命令，不是不可见的后台机制；
// 想接自动化的人自己在外层接（比如 CI 里就是一行 node scripts/gate-all.mjs）。
//
// 设计取舍：
//   · 任一道失败也继续跑完其余道 —— 一次就能看到全部问题，而不是修一个跑一次；
//   · 每道都打印「✓/✗ 名称 耗时」，最后一行汇总，失败则 exit 1；
//   · 不含浏览器端测试：那条路线已整体移除（见 docs/05 §三点五）——
//     真渲染的正确做法是人工看一次 + 机器断言在数据层，而不是把浏览器驱动成 CI 的靶子。
//   · 代码行门禁自己解析 scripts/code-lines.mjs 的输出并卡 400 行阈值
//     （那个脚本只打印数字、不做判定，参数是文件清单）。

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_CODE_LINES_PER_FILE = 400;

function parseArgs(argv) {
  const args = { only: '', allowNoDeploy: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--allow-no-deploy') args.allowNoDeploy = true;
    else if (argv[index] === '--only') { args.only = argv[index + 1] || ''; index += 1; }
  }
  return args;
}

function run(command, commandArgs, cwd) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(command, commandArgs, { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        output: `${stdout || ''}${stderr || ''}`.trim(),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

// 测试文件用通配符会被 shell 处理，这里自己列（顺序稳定，便于比对输出）
async function listTestFiles() {
  const directory = path.join(REPO_ROOT, 'test');
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith('.test.js')).sort();
  return names.map((name) => path.join('test', name));
}

// 代码行门禁：拿 git 索引里的 js/mjs（排除构建产物），逐文件卡阈值
async function listSourceFiles() {
  const listed = await run('git', ['ls-files', '*.js', '*.mjs'], REPO_ROOT);
  if (!listed.ok) return null;
  return listed.output.split('\n').map((line) => line.trim())
    .filter((line) => line && line !== 'lib/client.js' && !line.startsWith('artifacts/'));
}

async function collectGates(args) {
  const testFiles = await listTestFiles();
  const sourceFiles = await listSourceFiles();
  const gates = [
    { name: 'build', command: process.execPath, args: ['build.cjs'] },
    { name: 'test', command: process.execPath, args: ['--test', ...testFiles] },
    { name: 'contract', command: process.execPath, args: ['scripts/check-contract.mjs'] },
    { name: 'render', command: process.execPath, args: ['scripts/check-render.mjs'] },
    {
      name: 'deploy',
      command: process.execPath,
      // 没有部署副本的机器（CI / 换机）必须显式 --allow-no-deploy 才放行，不假装绿
      args: ['scripts/check-deploy-parity.mjs', ...(args.allowNoDeploy ? ['--allow-no-deploy'] : [])],
    },
    { name: 'css', command: process.execPath, args: ['scripts/check-css.mjs'] },
    {
      name: 'code-lines',
      command: process.execPath,
      args: ['scripts/code-lines.mjs', ...(sourceFiles || [])],
      // 这个脚本只打印、不判定：把它接成门禁就得自己看数字
      validate: (result) => {
        const offenders = result.output.split('\n')
          .filter((line) => line.trim())
          .map((line) => ({ code: Number(line.split('\t')[0]), file: line.split('\t')[1] }))
          .filter((entry) => Number.isFinite(entry.code) && entry.code > MAX_CODE_LINES_PER_FILE);
        if (!offenders.length) return { ok: true };
        return {
          ok: false,
          output: offenders.map((entry) => `${entry.file}: ${entry.code} 行 > ${MAX_CODE_LINES_PER_FILE}`).join('\n'),
        };
      },
    },
  ];
  return { gates, sourceFiles };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { gates, sourceFiles } = await collectGates(args);
  if (!sourceFiles) {
    console.error('✗ 无法用 git ls-files 列出源码文件（这个门禁需要 git 仓库上下文）');
    return 1;
  }

  const selected = gates
    .filter((gate) => !args.only || gate.name === args.only);
  if (!selected.length) {
    console.error(`没有匹配的门禁：--only ${args.only}（可用：${gates.map((gate) => gate.name).join(' / ')}）`);
    return 1;
  }

  const startedAt = Date.now();
  const results = [];
  for (const gate of selected) {
    const result = await run(gate.command, gate.args, REPO_ROOT);
    const verdict = gate.validate ? gate.validate(result) : { ok: result.ok, output: result.output };
    results.push({ ...gate, ...result, ...verdict });
    const seconds = (result.durationMs / 1000).toFixed(1);
    console.log(`${verdict.ok ? '✓' : '✗'} ${gate.name} ${seconds}s`);
    if (!verdict.ok) {
      // 失败时把原文打出来（截断到 4000 字，避免把整个测试报告糊满屏）
      const detail = String(verdict.output || result.output || '').slice(0, 4000);
      if (detail) console.log(detail.split('\n').map((line) => `    ${line}`).join('\n'));
    }
  }

  const failed = results.filter((result) => !result.ok);
  const totalSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n${results.length - failed.length} 道通过 / ${failed.length} 道失败，总耗时 ${totalSeconds}s`);
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(`✗ 未预期错误：${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
