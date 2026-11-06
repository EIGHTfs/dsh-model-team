// 完整备份/还原（v2）用例：导出收集凭据本体、无法导出的引用、护栏，以及还原时的落盘/权限/路径防护。
// 全部在临时数据根里造文件，不碰真实数据；期望值由输入推导（字节数、模式位都从造的数据算）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  BACKUP_VERSION,
  MAX_CREDENTIAL_FILE_BYTES,
  UNRESOLVED_REASONS,
  collectCredentialFiles,
  exportBackup,
  restoreCredentialFiles,
  toSafeRelativePath,
} from '../src/gateway/config/backup.js';
import { importGroups } from '../src/gateway/group/groups.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

const KEY_CONTENT = 'sk-test-key-content';
const KEY_BYTES = Buffer.byteLength(KEY_CONTENT, 'utf8');

// 造一个 dataRoot + 一份凭据文件，返回可复用的上下文
async function createDataRootWithKey(t, { relativePath = 'agnes-key.txt', content = KEY_CONTENT } = {}) {
  const dataRoot = await createTempDirectory(t);
  const absolutePath = path.join(dataRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, 'utf8');
  return { dataRoot, relativePath, absolutePath };
}

function groupWithRef(id, apiKeyRef) {
  return { id, name: id, auth: { apiKeyRef } };
}

test('导出：file: 引用把凭据本体带进 credentialFiles（相对路径为键）', async (t) => {
  const { dataRoot, relativePath, absolutePath } = await createDataRootWithKey(t, { relativePath: 'credentials/sa6400.key' });
  const logger = createRecordingLogger();

  const backup = await exportBackup({ config: { groups: [groupWithRef('sa6400', `file:${relativePath}`)] }, dataRoot, logger });

  assert.equal(backup.version, BACKUP_VERSION);
  assert.equal(typeof backup.exportedAt, 'string');
  const entry = backup.credentialFiles[relativePath];
  assert.notEqual(entry, undefined, '键必须是相对 dataRoot 的路径');
  assert.equal(entry.path, relativePath);
  assert.equal(entry.content, KEY_CONTENT);
  assert.equal(entry.bytes, KEY_BYTES);
  const stats = await fs.stat(absolutePath);
  assert.equal(entry.mode, stats.mode & 0o777, 'mode 取真实文件模式');
  assert.deepEqual(backup.unresolvedRefs, []);

  // 日志只记文件名与字节数：绝不能出现明文
  const loggedText = logger.lines.map((line) => line.message).join('\n');
  assert.equal(loggedText.includes(KEY_CONTENT), false, '日志不许出现凭据明文');
  assert.equal(loggedText.includes(relativePath), true, '日志要能看出带了哪个文件');
});

test('导出：env: 与未知前缀进 unresolvedRefs，并各自带原因', async (t) => {
  const dataRoot = await createTempDirectory(t);

  const { credentialFiles, unresolvedRefs } = await collectCredentialFiles({
    groups: [
      groupWithRef('from-env', 'env:MY_SECRET_KEY'),
      groupWithRef('weird', 'vault:whatever'),
      // 没配凭据的群不该产生噪音
      { id: 'no-auth', name: 'no-auth' },
    ],
    dataRoot,
  });

  assert.deepEqual(credentialFiles, {});
  assert.equal(unresolvedRefs.length, 2);
  const envEntry = unresolvedRefs.find((item) => item.group === 'from-env');
  assert.equal(envEntry.apiKeyRef, 'env:MY_SECRET_KEY');
  assert.equal(envEntry.reason, UNRESOLVED_REASONS.ENV_REF);
  const weirdEntry = unresolvedRefs.find((item) => item.group === 'weird');
  assert.equal(weirdEntry.reason, UNRESOLVED_REASONS.UNSUPPORTED_REF);
});

test('导出：file: 指向不存在的文件 → unresolvedRefs（不静默跳过）', async (t) => {
  const dataRoot = await createTempDirectory(t);

  const { credentialFiles, unresolvedRefs } = await collectCredentialFiles({
    groups: [groupWithRef('missing', 'file:not-here.key')],
    dataRoot,
  });

  assert.deepEqual(credentialFiles, {});
  assert.equal(unresolvedRefs.length, 1);
  assert.equal(unresolvedRefs[0].reason, UNRESOLVED_REASONS.MISSING_FILE);
});

test('导出护栏：单文件超 64KB → 记 unresolvedRefs「超出导出上限」，不截断', async (t) => {
  const oversizedContent = 'k'.repeat(MAX_CREDENTIAL_FILE_BYTES + 1);
  const { dataRoot, relativePath } = await createDataRootWithKey(t, { relativePath: 'big.key', content: oversizedContent });

  const { credentialFiles, unresolvedRefs } = await collectCredentialFiles({
    groups: [groupWithRef('big', `file:${relativePath}`)],
    dataRoot,
  });

  assert.deepEqual(credentialFiles, {}, '超限文件不能进备份（截断的密钥等于坏密钥）');
  assert.equal(unresolvedRefs[0].reason, UNRESOLVED_REASONS.TOO_LARGE);
});

test('导出护栏：总量超 512KB 时，后面的文件记 unresolvedRefs', async (t) => {
  const dataRoot = await createTempDirectory(t);
  // 单文件都在 64KB 以内，但总量超 512KB：9 个 60KB
  const chunk = 'k'.repeat(60 * 1024);
  const groups = [];
  for (let index = 0; index < 9; index += 1) {
    const relativePath = `key-${index}.txt`;
    await fs.writeFile(path.join(dataRoot, relativePath), chunk, 'utf8');
    groups.push(groupWithRef(`group-${index}`, `file:${relativePath}`));
  }

  const { credentialFiles, unresolvedRefs } = await collectCredentialFiles({ groups, dataRoot });

  assert.equal(Object.keys(credentialFiles).length < groups.length, true, '总量受限时不可能全带走');
  assert.equal(unresolvedRefs.length > 0, true);
  assert.equal(unresolvedRefs.every((item) => item.reason === UNRESOLVED_REASONS.TOO_LARGE), true);
});

test('还原：按相对路径写盘、权限 0600，已存在的同名文件先备份', async (t) => {
  const { dataRoot, relativePath, absolutePath } = await createDataRootWithKey(t, { content: 'old-content' });
  const logger = createRecordingLogger();

  const result = await restoreCredentialFiles({
    credentialFiles: { [relativePath]: { path: relativePath, content: KEY_CONTENT, bytes: KEY_BYTES, mode: 0o600 } },
    dataRoot,
    logger,
  });

  assert.deepEqual(result.restoredCredentialFiles.map((item) => item.path), [relativePath]);
  assert.equal(await fs.readFile(absolutePath, 'utf8'), KEY_CONTENT);
  assert.equal((await fs.stat(absolutePath)).mode & 0o777, 0o600);

  const directoryEntries = await fs.readdir(dataRoot);
  const backups = directoryEntries.filter((name) => name.includes('.bak-'));
  assert.equal(backups.length, 1, '覆盖前必须先留备份');
  assert.equal(await fs.readFile(path.join(dataRoot, backups[0]), 'utf8'), 'old-content', '备份内容应是旧值');
});

test('还原：绝对路径与 .. 穿越一律拒绝（只记 skippedRefs，不写盘）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const outsidePath = path.join(path.dirname(dataRoot), 'escaped.key');

  const result = await restoreCredentialFiles({
    credentialFiles: {
      '../escaped.key': { path: '../escaped.key', content: 'x', bytes: 1 },
      '/etc/escaped.key': { path: '/etc/escaped.key', content: 'x', bytes: 1 },
    },
    dataRoot,
  });

  assert.deepEqual(result.restoredCredentialFiles, []);
  assert.equal(result.skippedRefs.length, 2);
  assert.equal(result.skippedRefs.every((item) => item.reason.length > 0), true);
  await assert.rejects(fs.stat(outsidePath), /ENOENT/, '穿越路径不许真的写出文件');
  assert.equal(toSafeRelativePath('/abs/key'), null);
  assert.equal(toSafeRelativePath('../x'), null);
  assert.equal(toSafeRelativePath('a/../b'), 'b', '归一化后仍在根内是允许的');
});

test('还原：v1 备份（没有 credentialFiles）不报错，也不产生假回执', async () => {
  const result = await restoreCredentialFiles({ credentialFiles: undefined, dataRoot: '/tmp/not-used' });
  assert.deepEqual(result.restoredCredentialFiles, []);
  assert.deepEqual(result.skippedRefs, []);
});

test('导入：群内联明文 apiKey 仍然拒收（明文只走 credentialFiles）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();

  const result = await importGroups({
    version: 2,
    groups: [{
      id: 'inline-plaintext',
      name: '带明文',
      accessMode: 'official',
      driver: 'openai-compatible',
      baseURL: 'http://127.0.0.1:9/v1',
      models: { static: [{ id: 'model-a' }] },
      auth: { apiKey: 'sk-leak' },
    }],
  }, { dataRoot, logger });

  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason.includes('明文凭证'), true);
  assert.equal(result.accepted.length, 0);
});
