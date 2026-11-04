// G11c：真渲染门禁的外部路径解析——环境变量一旦设置就必须有效，不许静默回落候选。
//
// 为什么值得单测：这两处解析是整个门禁的"入口真话"。回归时不会有人在页面上看到报错，
// 只会看到门禁照常变绿——而它其实跑在另一个浏览器 / 另一份 useful-tools 上。
// 这里刻意**不往断言里写本机绝对路径**：所有"存在的文件/目录"都在临时目录里现造。
//
// 三条口径（两处解析各一份）：
//   ① 环境变量指向不存在的路径 → 抛错，且错误里带该路径
//   ② 环境变量指向存在但不可用（文件不可执行 / 目录缺 minihost+preview）→ 抛错
//   ③ 环境变量未设置 → 正常返回探测到的候选（本机有 DSH 的 browser-wrapper.sh / 兄弟目录 useful-tools）

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveChrome, resolveUsefulToolsRoot } from '../scripts/lib/ui-check-env.mjs';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ui-check-env-'));
}

// 造一个可执行文件（脚本内容无所谓：解析层只判"是不是可执行文件"）
async function createExecutableFile(directory, name) {
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, '#!/bin/sh\nexit 0\n');
  await fs.chmod(filePath, 0o755);
  return filePath;
}

// 造一个不可执行文件
async function createPlainFile(directory, name) {
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, 'not executable\n');
  await fs.chmod(filePath, 0o644);
  return filePath;
}

// 造一个形状正确的 useful-tools 目录（只要那两份脚本在）
async function createUsefulToolsShape(directory) {
  const hostDir = path.join(directory, 'lib', 'core', 'minihost');
  const previewDir = path.join(directory, 'lib', 'core', 'preview');
  await fs.mkdir(hostDir, { recursive: true });
  await fs.mkdir(previewDir, { recursive: true });
  await fs.writeFile(path.join(hostDir, 'host.mjs'), '// stub\n');
  await fs.writeFile(path.join(previewDir, 'gen.js'), '// stub\n');
  return directory;
}

test('G11c-①：DMT_CHROME 指向不存在的路径 → 抛错且错误里带该路径（不回落候选）', async () => {
  const tempRoot = await makeTempDir();
  const missingPath = path.join(tempRoot, 'no-such-chrome');

  await assert.rejects(
    () => resolveChrome(missingPath),
    (error) => {
      assert.match(error.message, /DMT_CHROME 已设置但不指向可执行文件/);
      assert.ok(error.message.includes(missingPath), '错误里必须带出被设置的那个路径');
      return true;
    },
  );
});

test('G11c-②：DMT_CHROME 指向不可执行文件 → 抛错', async () => {
  const tempRoot = await makeTempDir();
  const plainFile = await createPlainFile(tempRoot, 'chrome-plain');

  await assert.rejects(
    () => resolveChrome(plainFile),
    (error) => {
      assert.match(error.message, /DMT_CHROME 已设置但不指向可执行文件/);
      assert.ok(error.message.includes(plainFile));
      return true;
    },
  );
});

test('G11c-③：DMT_CHROME 指向可执行文件 → 原样返回（就是它，不换成别的）', async () => {
  const tempRoot = await makeTempDir();
  const executable = await createExecutableFile(tempRoot, 'chrome-ok');

  assert.equal(await resolveChrome(executable), executable);
});

test('G11c-④：DMT_CHROME 未设置 → 按候选清单探测并返回一个真实存在且可执行的文件', async () => {
  const resolved = await resolveChrome('');
  assert.equal(typeof resolved, 'string');
  assert.ok(resolved.length > 0);
  // 只断言"探测出来的东西真的存在"，不断言具体是哪条路径（换机器也能跑）
  const stat = await fs.stat(resolved);
  assert.ok(stat.isFile(), `探测结果应是文件：${resolved}`);
});

test('G11c-⑤：DSH_USEFUL_TOOLS_ROOT 指向不存在的目录 → 抛错且带该路径（不回落兄弟目录）', async () => {
  const tempRoot = await makeTempDir();
  const missingRoot = path.join(tempRoot, 'no-such-useful-tools');

  await assert.rejects(
    () => resolveUsefulToolsRoot(missingRoot),
    (error) => {
      assert.match(error.message, /DSH_USEFUL_TOOLS_ROOT 已设置但不是可用的 dsh-useful-tools/);
      assert.ok(error.message.includes(missingRoot));
      return true;
    },
  );
});

test('G11c-⑥：DSH_USEFUL_TOOLS_ROOT 指向缺 minihost/preview 的目录 → 抛错', async () => {
  const tempRoot = await makeTempDir();
  const wrongShape = path.join(tempRoot, 'empty-tools');
  await fs.mkdir(wrongShape, { recursive: true });

  await assert.rejects(
    () => resolveUsefulToolsRoot(wrongShape),
    /DSH_USEFUL_TOOLS_ROOT 已设置但不是可用的 dsh-useful-tools/,
  );
});

test('G11c-⑦：DSH_USEFUL_TOOLS_ROOT 指向形状正确的目录 → 原样返回', async () => {
  const tempRoot = await makeTempDir();
  const shaped = await createUsefulToolsShape(path.join(tempRoot, 'useful-tools'));

  assert.equal(await resolveUsefulToolsRoot(shaped), shaped);
});

test('G11c-⑧：DSH_USEFUL_TOOLS_ROOT 未设置 → 返回兄弟目录里那份（含两份脚本）', async () => {
  const resolved = await resolveUsefulToolsRoot('');
  assert.equal(typeof resolved, 'string');
  const hostScript = path.join(resolved, 'lib', 'core', 'minihost', 'host.mjs');
  const previewScript = path.join(resolved, 'lib', 'core', 'preview', 'gen.js');
  // 断"返回的目录里那两份脚本在"，而不是断具体路径
  await fs.access(hostScript);
  await fs.access(previewScript);
});
