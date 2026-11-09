#!/usr/bin/env node
// check-deploy-parity.mjs —— 部署副本一致性门禁：仓库代码 vs profile 里真实加载的那份，逐文件比 md5。
//
// 为什么需要这道门禁（真实事故 G-24）：
//   改完代码、门禁全绿、忘记跑 sync_plugin ⇒ 宿主加载的还是旧文件 ⇒ 线上行为没变。
//   「虚拟模型下 read_image 看不到图」那次就是这么产生的，而且表现是**静默丢数据**
//   （图被丢成占位文本，不报错），靠肉眼与单测都发现不了。
//
// 判据：两边都存在的文件，内容必须逐字节相同；只在仓库里新增的（尚未同步）算失败；
//      只在部署副本里的 `.js`/`.json`（旧布局残留）也算失败——它们会被宿主真的加载，
//      重构后一直躺着会把「加载的是哪一版」这件事变成谜（真实事故：8 个 src/gateway/support/*
//      跨过整次重构没人发现）。
//
// 换机器 / CI 没有部署副本时：显式 `--allow-no-deploy` 通过，并把结论写成「未核对」，
// 不假装绿（假绿正是这个项目反复吃亏的地方）。

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_NAME = 'dsh-model-team';

// 需要核对的源码区。刻意**不含** lib/client-parts/ 与 ui/：
// 它们是构建期输入，运行时只加载拼好的 lib/client.js，部署副本里没有分片是正常的。
const DEPLOYED_DIRECTORIES = ['src', 'config'];
const DEPLOYED_FILES = ['lib/client.js', 'cordis.patch.yml', 'package.json', 'README.md'];

// 构建产物：不入库，但在部署副本里必须存在且与「本地刚构建出来的那份」一致。
// 因此它不参与"仓库有、副本没有"的新增判定，也不参与"副本有、仓库没有"的残留判定——
// 单独按内容比对，本地还没构建时如实报「未核对」而不是假装绿。
const BUILD_ARTIFACTS = ['lib/client.js'];

// 反向检查（副本多出的文件）只看这两类扩展名：能被宿主加载、或能被当成配置读进去的
const STALE_FILE_EXTENSIONS = Object.freeze(['.js', '.json']);
// 豁免：依赖目录、隐藏文件（.DS_Store 等）、运行期产物（日志）
const STALE_IGNORED_DIRECTORIES = Object.freeze(['node_modules']);
const STALE_IGNORED_NAME_PREFIX = '.';
const STALE_IGNORED_SUFFIXES = Object.freeze(['.log']);

function parseArgs(argv) {
  const args = { allowNoDeploy: false, verbose: false };
  for (const token of argv) {
    if (token === '--allow-no-deploy') args.allowNoDeploy = true;
    else if (token === '--verbose') args.verbose = true;
  }
  return args;
}

// 部署副本位置：DSH_HOME 形如 <appdata>/<version>/.dsh，profiles 在它下面。
// 找不到就返回空数组（多个 profile 都查一遍）。
async function findDeployCopies() {
  const candidates = [];
  const dshHome = process.env.DSH_HOME || '';
  if (dshHome) {
    const profilesRoot = path.join(dshHome, 'profiles');
    let profileNames = [];
    try { profileNames = await fs.readdir(profilesRoot); } catch { profileNames = []; }
    for (const profileName of profileNames) {
      candidates.push(path.join(profilesRoot, profileName, 'local-plugins', PLUGIN_NAME));
      candidates.push(path.join(profilesRoot, profileName, 'node_modules', PLUGIN_NAME));
    }
  }
  candidates.push(path.join(os.homedir(), '.dsh', 'local-plugins', PLUGIN_NAME));

  // 按真实路径去重：profile 里 `node_modules/dsh-model-team` 通常是指向
  // `local-plugins/dsh-model-team` 的软链，两个路径其实是同一份文件——
  // 不去重会把同一处不一致报两遍，看起来像两个问题。
  const found = [];
  const seenRealPaths = new Set();
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(path.join(candidate, 'package.json'));
      if (!stat.isFile()) continue;
      const realPath = await fs.realpath(candidate);
      if (seenRealPaths.has(realPath)) continue;
      seenRealPaths.add(realPath);
      found.push({ path: candidate, realPath });
    } catch { /* 不是部署副本 */ }
  }
  return found;
}

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return createHash('md5').update(buffer).digest('hex');
}

async function listRepoFiles() {
  const files = [];
  for (const directory of DEPLOYED_DIRECTORIES) {
    const walk = async (relativeDirectory) => {
      const absoluteDirectory = path.join(REPO_ROOT, relativeDirectory);
      let entries = [];
      try { entries = await fs.readdir(absoluteDirectory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const relativePath = path.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) await walk(relativePath);
        else files.push(relativePath);
      }
    };
    await walk(directory);
  }
  for (const fileName of DEPLOYED_FILES) {
    // 产物不在仓库里也能比：只要本地构建过就在磁盘上；没构建过就跳过（由汇总处报「未核对」）
    try { await fs.access(path.join(REPO_ROOT, fileName)); files.push(fileName); } catch { /* 本地还没构建就跳过 */ }
  }
  return files;
}

// 扫部署副本里"仓库没有、但副本有"的 js/json：递归、跳过豁免项
async function collectStaleFiles({ deployRoot, repoFileSet }) {
  const staleFiles = [];
  for (const directory of DEPLOYED_DIRECTORIES) {
    const walk = async (relativeDirectory) => {
      let entries = [];
      try {
        entries = await fs.readdir(path.join(deployRoot, relativeDirectory), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        // 隐藏文件（.DS_Store 之类）先豁免，避免把系统垃圾报成"旧布局残留"
        if (entry.name.startsWith(STALE_IGNORED_NAME_PREFIX)) continue;
        const relativePath = path.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
          if (STALE_IGNORED_DIRECTORIES.includes(entry.name)) continue;
          await walk(relativePath);
          continue;
        }
        if (!entry.isFile()) continue;
        if (STALE_IGNORED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
        if (!STALE_FILE_EXTENSIONS.includes(path.extname(entry.name))) continue;
        // 构建产物由 build 生成，副本里有它是正常的，不算残留
        if (BUILD_ARTIFACTS.includes(relativePath.split(path.sep).join('/'))) continue;
        if (repoFileSet.has(relativePath)) continue;
        staleFiles.push(relativePath);
      }
    };
    await walk(directory);
  }
  return staleFiles;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const deployCopies = await findDeployCopies();

  if (!deployCopies.length) {
    if (args.allowNoDeploy) {
      console.log('⚠️ 未找到部署副本（--allow-no-deploy，本项未核对）');
      return 0;
    }
    console.error('❌ 找不到部署副本，无法核对');
    console.error('   若当前环境本来就没有部署（换机器 / CI），请显式加 --allow-no-deploy。');
    return 1;
  }

  const repoFiles = await listRepoFiles();
  const repoFileSet = new Set(repoFiles);
  const problems = [];
  const warnings = [];
  const staleFiles = new Set();

  for (const deployCopy of deployCopies) {
    const deployRoot = deployCopy.realPath;
    for (const relativePath of repoFiles) {
      const repoPath = path.join(REPO_ROOT, relativePath);
      const deployPath = path.join(deployRoot, relativePath);
      let deployExists = true;
      try { await fs.access(deployPath); } catch { deployExists = false; }
      if (!deployExists) {
        problems.push(`${deployCopy.path}\n   · 部署副本缺少 ${relativePath}（新增文件没同步）`);
        continue;
      }
      const [repoHash, deployHash] = await Promise.all([hashFile(repoPath), hashFile(deployPath)]);
      if (repoHash !== deployHash) {
        problems.push(`${deployCopy.path}\n   · ${relativePath} 内容不一致（仓库 ${repoHash.slice(0, 8)} / 部署 ${deployHash.slice(0, 8)}）`);
      } else if (args.verbose) {
        console.log(`  ✓ ${relativePath}`);
      }
    }
    // 反向：部署副本多出来的 js/json —— 宿主会真的加载它们，必须清掉（不是"只警告"）
    for (const relativePath of await collectStaleFiles({ deployRoot, repoFileSet })) {
      staleFiles.add(relativePath);
    }
  }

  warnings.forEach((warning) => console.log(`⚠️  ${warning}`));

  if (problems.length) {
    console.error(`❌ 部署副本与仓库不一致：${problems.length} 处`);
    problems.forEach((problem) => console.error(`   · ${problem}`));
    console.error('\n   修法：node 环境下跑插件的 sync_plugin（或手工复制），然后重启宿主让新代码生效。');
  }
  if (staleFiles.size > 0) {
    const sortedStaleFiles = [...staleFiles].sort();
    console.error(`❌ 部署副本多出仓库没有的文件：${sortedStaleFiles.length} 处`);
    sortedStaleFiles.forEach((relativePath) => console.error(`   · ${relativePath}（旧布局残留？）`));
    console.error('\n   修法：确认后从副本删除（或移入回收站），并检查是否重构时漏删。');
  }
  // 构建产物不在仓库里：必须"本地刚构建过"才能核对。缺了就明说未核对并失败——
  // 判绿等于告诉人「部署与源码一致」，而实际上那份产物根本没被检查过（假绿）。
  const missingArtifacts = [];
  for (const artifactPath of BUILD_ARTIFACTS) {
    try { await fs.access(path.join(REPO_ROOT, artifactPath)); } catch { missingArtifacts.push(artifactPath); }
  }
  if (missingArtifacts.length > 0) {
    console.error(`❌ 构建产物不存在，无法核对：${missingArtifacts.join('、')}`);
    console.error('   产物不入库（由 build 生成）。先跑 node build.cjs 再核对，或加 --allow-no-deploy 明确表示本项不核对。');
    return 1;
  }

  if (problems.length || staleFiles.size > 0) return 1;
  console.log(`✅ 部署副本一致：${deployCopies.length} 个副本、${repoFiles.length} 个文件逐字节相同、无残留文件`);
  return 0;
}

process.exit(await main());
