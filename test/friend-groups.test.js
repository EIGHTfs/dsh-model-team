// 好友分组配置与游标状态用例（docs/11 §35-48 / INV-12）：校验、CRUD、游标持久化、删除前引用保护。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  countSessionsReferencingGroup,
  deleteFriendGroup,
  findFriendGroup,
  listFriendGroups,
  normalizeFriendGroup,
  readGroupCursor,
  saveFriendGroup,
  writeGroupCursor,
} from '../src/gateway/group/friend-groups.js';
import { writeConfig, readConfig } from '../src/gateway/config/config.js';
import { writeSessionTarget } from '../src/gateway/session/store.js';
import { GatewayError } from '../src/gateway/errors.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

function buildGroupPayload(overrides = {}) {
  return {
    id: 'ds-high-avail',
    name: 'DeepSeek-高可用组',
    strategy: 'round-robin',
    members: [
      { platformId: 'agnes', modelId: 'deepseek-v3' },
      { platformId: 'workbuddy', modelId: 'deepseek-v3' },
    ],
    ...overrides,
  };
}

test('分组校验：缺成员/缺 name/非法策略/非法 id 一律拒绝', () => {
  assert.throws(() => normalizeFriendGroup(buildGroupPayload({ members: [] })), GatewayError);
  assert.throws(() => normalizeFriendGroup(buildGroupPayload({ name: '' })), GatewayError);
  assert.throws(() => normalizeFriendGroup(buildGroupPayload({ strategy: 'random' })), GatewayError);
  assert.throws(() => normalizeFriendGroup(buildGroupPayload({ id: 'bad id' })), GatewayError);
  // 成员重复会被去重但保留顺序
  const normalized = normalizeFriendGroup(
    buildGroupPayload({
      members: [
        { platformId: 'agnes', modelId: 'm1' },
        { platformId: 'agnes', modelId: 'm1' },
        { platformId: 'workbuddy', modelId: 'm1' },
      ],
    }),
  );
  assert.equal(normalized.members.length, 2);
});

test('分组 CRUD：保存后可读、同 id 覆盖、列表跳过脏配置', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  await writeConfig({ groups: [] }, { dataRoot });

  await saveFriendGroup(buildGroupPayload(), { dataRoot, logger });
  const configAfterSave = await readConfig({ dataRoot, logger });
  assert.equal(findFriendGroup(configAfterSave, 'ds-high-avail', { logger })?.name, 'DeepSeek-高可用组');

  await saveFriendGroup(buildGroupPayload({ name: '改名后的组' }), { dataRoot, logger });
  const configAfterUpdate = await readConfig({ dataRoot, logger });
  assert.equal(listFriendGroups(configAfterUpdate, { logger }).length, 1);
  assert.equal(findFriendGroup(configAfterUpdate, 'ds-high-avail', { logger }).name, '改名后的组');

  const configWithDirty = { ...configAfterUpdate, friendGroups: [...configAfterUpdate.friendGroups, { id: 'broken' }] };
  await writeConfig(configWithDirty, { dataRoot, logger });
  assert.equal(listFriendGroups(configWithDirty, { logger }).length, 1, '脏配置被跳过而不是拖垮列表');
});

test('游标持久化：写入后新实例（重新读文件）仍在同一位置（INV-12）', async (t) => {
  const dataRoot = await createTempDirectory(t);

  assert.equal(await readGroupCursor('g1', { dataRoot }), 0, '缺省从 0 开始');
  await writeGroupCursor('g1', 2, { dataRoot });
  await writeGroupCursor('g2', 1, { dataRoot });

  // 模拟"进程重启"：直接读磁盘文件，不依赖任何内存态
  const statePath = path.join(dataRoot, 'groups-state.json');
  const storedState = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(storedState.cursors.g1, 2);
  assert.equal(storedState.cursors.g2, 1);
  assert.equal(await readGroupCursor('g1', { dataRoot }), 2, '重新读取仍是上次位置');
});

test('删除保护：被会话引用时 409 且带引用计数；未被引用才真删', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  await writeConfig({ groups: [] }, { dataRoot });
  await saveFriendGroup(buildGroupPayload(), { dataRoot, logger });

  await writeSessionTarget('sess-ref', { type: 'group', id: 'ds-high-avail' }, { dataRoot, logger });

  const referenceStats = await countSessionsReferencingGroup('ds-high-avail', { dataRoot, logger });
  assert.equal(referenceStats.count, 1);
  assert.deepEqual(referenceStats.sessionIds, ['sess-ref']);

  await assert.rejects(
    () => deleteFriendGroup('ds-high-avail', { dataRoot, logger }),
    (deleteError) => deleteError instanceof GatewayError
      && deleteError.code === 'friend-group-in-use'
      && deleteError.status === 409
      && deleteError.details.referencedSessions === 1,
  );

  // 会话切走后就能删
  await writeSessionTarget('sess-ref', { type: 'model', id: 'm1', platformId: 'agnes' }, { dataRoot, logger });
  const removeResult = await deleteFriendGroup('ds-high-avail', { dataRoot, logger });
  assert.deepEqual(removeResult, { removed: 'ds-high-avail' });
});

// ---- id 可选（docs/02 端点 13）：创建时不传 id，由 name 生成；显式 id 仍严格校验 ----

test('创建：不传 id → 按 name 生成 slug（小写 / 非字母数字转 - / 压缩连字符 / 去首尾）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  await writeConfig({ groups: [] }, { dataRoot });

  const saved = await saveFriendGroup(
    { name: 'DeepSeek 高可用组!!', strategy: 'round-robin', members: [{ platformId: 'agnes', modelId: 'm1' }] },
    { dataRoot, logger },
  );
  assert.equal(saved.id, 'deepseek', '中文与符号被裁掉后剩下 ASCII 片段');
  assert.equal(listFriendGroups(await readConfig({ dataRoot, logger }), { logger })[0].id, 'deepseek');
  assert.equal(logger.hasLine('info', '好友分组 id 自动生成'), true, '自动生成要有明确日志标记');

  // 纯中文名 → 没有可用字符，回落固定名
  const chineseOnly = await saveFriendGroup(
    { name: '高可用组', strategy: 'round-robin', members: [{ platformId: 'agnes', modelId: 'm1' }] },
    { dataRoot, logger },
  );
  assert.equal(chineseOnly.id, 'friend-group');
});

test('创建：同名撞车追加 -2 / -3（不覆盖已有分组）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  await writeConfig({ groups: [] }, { dataRoot });

  const first = await saveFriendGroup({ name: 'pool', strategy: 'round-robin', members: [{ platformId: 'agnes', modelId: 'm1' }] }, { dataRoot, logger });
  const second = await saveFriendGroup({ name: 'pool', strategy: 'round-robin', members: [{ platformId: 'agnes', modelId: 'm2' }] }, { dataRoot, logger });
  const third = await saveFriendGroup({ name: 'pool', strategy: 'round-robin', members: [{ platformId: 'agnes', modelId: 'm3' }] }, { dataRoot, logger });

  assert.equal(first.id, 'pool');
  assert.equal(second.id, 'pool-2');
  assert.equal(third.id, 'pool-3');
  assert.equal(listFriendGroups(await readConfig({ dataRoot, logger }), { logger }).length, 3, '三个分组都要在，不许互相覆盖');
});

test('更新：显式传 id 原样保留（不生成、不改写）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  await writeConfig({ groups: [] }, { dataRoot });

  const saved = await saveFriendGroup(buildGroupPayload({ id: 'my-own.id_1' }), { dataRoot, logger });
  assert.equal(saved.id, 'my-own.id_1');
  assert.equal(logger.hasLine('info', '好友分组 id 自动生成'), false, '显式 id 时不该打"自动生成"日志');
});

test('创建：显式 id 非法仍 400（不因为可缺省就放过坏 id）', () => {
  assert.throws(
    () => normalizeFriendGroup(buildGroupPayload({ id: 'bad id' })),
    (validationError) => validationError instanceof GatewayError && validationError.status === 400,
  );
});

