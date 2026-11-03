// 群列表 lastUpdated 用例：请求行优先 → 群配置时间 → config.json mtime → null；只回 ISO 字符串。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startGatewayHarness } from './helpers/gateway-harness.js';
import { readConfig, writeConfig } from '../src/gateway/config.js';
import { resolveGroupLastUpdatedIso } from '../src/gateway/group-last-updated.js';

const NEWER_REQUEST_ISO = '2026-11-02T11:24:25.691Z';
const OLDER_REQUEST_ISO = '2026-11-02T10:00:00.000Z';

// 直接写请求行文件（读取端只做 JSON.parse，不校验字段完整性）
async function writeRequestRows(dataRoot, requestRows) {
  const requestRowsPath = path.join(dataRoot, 'stats', 'requests.jsonl');
  await fs.mkdir(path.dirname(requestRowsPath), { recursive: true });
  await fs.writeFile(requestRowsPath, requestRows.map((row) => JSON.stringify(row)).join('\n'));
}

async function findGroupEntry(harness, groupId) {
  const listResponse = await harness.request('/_team/groups');
  assert.equal(listResponse.status, 200);
  return listResponse.body.groups.find((group) => group.id === groupId) ?? null;
}

test('有请求行：lastUpdated 取该群最近一条请求的时间（ISO）', async (t) => {
  const harness = await startGatewayHarness(t);
  await writeRequestRows(harness.dataRoot, [
    { time: '10:00:00', startedAtMs: Date.parse(OLDER_REQUEST_ISO), account: { id: 'agnes' } },
    { time: '11:24:25', startedAtMs: Date.parse(NEWER_REQUEST_ISO), groupId: 'agnes', account: { id: 'someone-else' } },
  ]);

  const groupEntry = await findGroupEntry(harness, 'agnes');

  assert.notEqual(groupEntry, null);
  assert.equal(groupEntry.lastUpdated, NEWER_REQUEST_ISO);
});

test('无请求行但有群配置时间：回落到配置里的 updatedAt', async (t) => {
  const harness = await startGatewayHarness(t);
  const config = await readConfig({ dataRoot: harness.dataRoot });
  const configSavedAt = '2026-10-31T08:15:00.000Z';
  const nextGroups = config.groups.map((group) => (
    group.id === 'agnes' ? { ...group, updatedAt: configSavedAt } : group
  ));
  await writeConfig({ ...config, groups: nextGroups }, { dataRoot: harness.dataRoot });

  const groupEntry = await findGroupEntry(harness, 'agnes');

  assert.equal(groupEntry.lastUpdated, configSavedAt);
});

test('无请求行也无配置时间：回落到 config.json 的 mtime', async (t) => {
  const harness = await startGatewayHarness(t);
  const configStats = await fs.stat(path.join(harness.dataRoot, 'config.json'));

  const groupEntry = await findGroupEntry(harness, 'agnes');

  assert.equal(groupEntry.lastUpdated, new Date(configStats.mtimeMs).toISOString());
});

test('请求行与配置时间都有：请求行优先（更新的那个赢）', async (t) => {
  const harness = await startGatewayHarness(t);
  const config = await readConfig({ dataRoot: harness.dataRoot });
  const nextGroups = config.groups.map((group) => (
    group.id === 'agnes' ? { ...group, updatedAt: '2026-10-01T00:00:00.000Z' } : group
  ));
  await writeConfig({ ...config, groups: nextGroups }, { dataRoot: harness.dataRoot });
  await writeRequestRows(harness.dataRoot, [
    { time: '11:24:25', startedAtMs: Date.parse(NEWER_REQUEST_ISO), groupId: 'agnes' },
  ]);

  const groupEntry = await findGroupEntry(harness, 'agnes');

  assert.equal(groupEntry.lastUpdated, NEWER_REQUEST_ISO, '请求行比配置时间新，用请求行');
});

test('完全没有可用时间：lastUpdated 为 null', () => {
  assert.equal(resolveGroupLastUpdatedIso({ group: { id: 'nobody' }, requestRows: [], configModifiedAtMs: null }), null);
});

test('lastUpdated 只出现在列表出参：群详情形状不变', async (t) => {
  const harness = await startGatewayHarness(t);

  const detailResponse = await harness.request('/_team/groups/agnes');

  assert.equal(detailResponse.status, 200);
  assert.equal('lastUpdated' in detailResponse.body.group, false, '详情不新增字段');
});
