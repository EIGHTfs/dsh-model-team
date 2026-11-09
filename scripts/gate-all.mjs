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
//   · 不含浏览器端测试：那条路线已整体移除（见 docs/12 §三点五）——
//     真渲染的正确做法是人工看一次 + 机器断言在数据层，而不是把浏览器驱动成 CI 的靶子。
//   · 代码行门禁自己解析 scripts/code-lines.mjs 的输出并卡 400 行阈值
//     （那个脚本只打印数字、不做判定，参数是文件清单）。

import { execFile, execFileSync } from 'node:child_process';
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
    {
      name: "build",
      command: process.execPath,
      args: ["build.cjs"],
      // 产物一致性：判据是「磁盘上的产物是否已经是当前源码的构建结果」。
      // 做法：跑 build 之前先把产物读进内存，跑完再比——如果变了，说明跑之前它是陈旧的。
      // 产物**不入库**（源码入库、构建生成），所以这里不比对 git，只看磁盘：
      //   · 构建前没有产物（刚 clone / 刚清理过）→ 视为正常，构建后即最新；
      //   · 构建前有产物但与构建结果不同 → 说明有人手改了产物或忘了重建，报红。
      // 真实事故：面板标签从「本会话速率」改成「当前速率」，源码改了、产物没重建，界面上仍是旧文案。
      validate: (result, snapshot) => {
        if (!result.ok) return { ok: false, output: result.output };
        if (snapshot !== null && snapshot !== result.artifactAfter) {
          return {
            ok: false,
            output: "lib/client.js 与源码不同步：跑 build 之前它是陈旧的（现在已重建）。\n"
              + "  产物是构建生成的（不入库）；不要手改它，也不要提交它。",
          };
        }
        return { ok: true };
      },
    },
    // test 道走 test-all.mjs：全量红时先单跑失败文件，单跑绿判为抖动并留痕（docs/12）
    { name: 'test', command: process.execPath, args: ['scripts/test-all.mjs'] },
    { name: 'contract', command: process.execPath, args: ['scripts/check-contract.mjs'] },
    { name: 'render', command: process.execPath, args: ['scripts/check-render.mjs'] },
    // 界面约束（U-1~U-4，docs/03 §6.4）：自起假后端 + vm 里跑真渲染分片，不启浏览器。
    // 与 render 道的分工：render 验「条数 / 群友数与接口一致」，这道验「契约字段在界面上的显示规则」
    // （副标题逐字透传、空值不占位、无平台名硬编码、群友数三态）。
    { name: 'ui-contract', command: process.execPath, args: ['scripts/check-ui-contract.mjs'] },
    {
      name: 'deploy',
      command: process.execPath,
      // 没有部署副本的机器（CI / 换机）必须显式 --allow-no-deploy 才放行，不假装绿
      args: ['scripts/check-deploy-parity.mjs', ...(args.allowNoDeploy ? ['--allow-no-deploy'] : [])],
    },
    { name: 'css', command: process.execPath, args: ['scripts/check-css.mjs'] },
    { name: 'layout', command: process.execPath, args: ['scripts/check-layout.mjs'] },
    { name: 'doc-refs', command: process.execPath, args: ['scripts/check-doc-refs.mjs'] },
    // 会话 id 来源：只许槽位为准，「最近活跃」兜底不得被用来写目标（docs/14 §1.3）
    { name: 'session-source', command: process.execPath, args: ['scripts/check-session-id-source.mjs'] },
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
  const ARTIFACT_PATH = path.join(REPO_ROOT, "lib", "client.js");
  // 注意必须 await 在 try 内：fs.readFile 是 Promise，不在 try 里 await 的话
  // 缺文件时 rejection 会直接冒出去把整个门禁打成「未预期错误」（产物不入库后这是常态）。
  const readArtifact = async () => {
    try { return await fs.readFile(ARTIFACT_PATH, "utf8"); } catch { return null; }
  };

  for (const gate of selected) {
    // build 门禁要比对「跑之前」的产物：跑完再读一次即可判断它原本是否陈旧
    const snapshot = gate.name === "build" ? await readArtifact() : undefined;
    const result = await run(gate.command, gate.args, REPO_ROOT);
    if (gate.name === "build") result.artifactAfter = await readArtifact();
    const verdict = gate.validate ? gate.validate(result, snapshot) : { ok: result.ok, output: result.output };
    results.push({ ...gate, ...result, ...verdict });
    const seconds = (result.durationMs / 1000).toFixed(1);
    console.log(`${verdict.ok ? '✓' : '✗'} ${gate.name} ${seconds}s`);
    if (!verdict.ok) {
      // 失败时把原文打出来（截断到 4000 字，避免把整个测试报告糊满屏）
      const detail = String(verdict.output || result.output || '').slice(0, 4000);
      if (detail) console.log(detail.split('\n').map((line) => `    ${line}`).join('\n'));
    } else if (gate.name === 'test') {
      // test-all 判定"抖动"时 exit 0，但会打印一行 ⚠；只写进留痕文件、控制台看不到，等于没留。
      // 成功也把这行原样带出来（不加感叹、不改判：它仍是通过）
      const flakyLines = String(result.output ?? '')
        .split('\n')
        .filter((line) => line.includes('⚠ 抖动'));
      for (const flakyLine of flakyLines) console.log(`  ${flakyLine.trim()}`);
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
