// 平台图标：群覆盖优先 → 平台声明回落，去重去空；无声明不写 avatar（docs/04 §二点五）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { normalizeIconCandidates, resolveGroupIcons, resolveGroupAvatar } from '../src/gateway/config/platform-presets.js';
import { listGroupsWithSummary } from '../src/gateway/group/groups.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

const PRESETS = Object.freeze([
  { id: 'agnes', name: 'Agnes', baseURL: 'https://api.agnes.ai/v1', icons: ['https://cdn.example.com/agnes.svg', 'A'] },
  { id: 'legacy', name: 'Legacy', baseURL: 'https://legacy.example/v1', avatar: '[L]' },
]);

test('归一化：去空、去重、保持顺序（数组与单值都接受）', () => {
  assert.deepEqual(normalizeIconCandidates(['a', '', 'a', '  ', 'b']), ['a', 'b']);
  assert.deepEqual(normalizeIconCandidates('solo', undefined, ['solo']), ['solo']);
  assert.deepEqual(normalizeIconCandidates([], null), []);
});

test('群图标优先：群自己声明的 icons 排在平台声明之前', () => {
  const icons = resolveGroupIcons({ id: 'agnes', name: 'Agnes', driver: 'openai-compatible', icons: ['https://mine/q.png'] }, PRESETS);
  assert.deepEqual(icons, ['https://mine/q.png', 'https://cdn.example.com/agnes.svg', 'A']);
});

test('群没有 icons：回落到平台声明（含文本候选）', () => {
  const icons = resolveGroupIcons({ id: 'agnes', name: 'Agnes', driver: 'openai-compatible' }, PRESETS);
  assert.deepEqual(icons, ['https://cdn.example.com/agnes.svg', 'A']);
});

test('旧字段 avatar 仍作为候选参与（向后兼容）', () => {
  assert.deepEqual(resolveGroupIcons({ id: 'legacy', name: 'Legacy', driver: 'openai-compatible' }, PRESETS), ['[L]']);
  assert.equal(resolveGroupAvatar({ id: 'legacy', name: 'Legacy', driver: 'openai-compatible' }, PRESETS), '[L]');
});

test('插件型平台：图标来自驱动声明（extraIconsByDriverId）', () => {
  const pluginIcons = { 'reverse-qoder': ['data:image/svg+xml;base64,QQ=='] };
  const icons = resolveGroupIcons({ id: 'qoder', name: 'Qoder', driver: 'reverse-qoder' }, PRESETS, pluginIcons);
  assert.deepEqual(icons, ['data:image/svg+xml;base64,QQ==']);
});

test('三处都没有 icons → 返回 undefined（出参不写 avatar/icons）', () => {
  assert.equal(resolveGroupIcons({ id: 'unknown', name: 'Unknown', driver: 'x' }, PRESETS), undefined);
  assert.equal(resolveGroupAvatar({ id: 'unknown', name: 'Unknown', driver: 'x' }, PRESETS), undefined);
});

test('群列表出参：icons 与 avatar 同时给出，avatar = icons[0]', async (t) => {
  const dataRoot = await createTempDirectory(t);
  // 本地 svg 用相对路径声明（相对 platforms.json 所在目录 = 数据根）
  await fs.mkdir(path.join(dataRoot, 'assets', 'platforms'), { recursive: true });
  await fs.writeFile(path.join(dataRoot, 'assets', 'platforms', 'agnes.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
  await fs.writeFile(path.join(dataRoot, 'platforms.json'), JSON.stringify({
    platforms: [{
      id: 'agnes', name: 'Agnes', baseURL: 'https://api.agnes.ai/v1',
      icons: ['assets/platforms/agnes.svg', 'https://cdn.example.com/agnes.svg', 'A'],
    }],
  }), 'utf8');
  await fs.writeFile(path.join(dataRoot, 'config.json'), JSON.stringify({
    groups: [{ id: 'agnes', name: 'Agnes', driver: 'openai-compatible', baseURL: 'https://api.agnes.ai/v1', avatar: 'G' }],
  }), 'utf8');
  const config = JSON.parse(await fs.readFile(path.join(dataRoot, 'config.json'), 'utf8'));

  const groups = await listGroupsWithSummary(config, { dataRoot, logger: createRecordingLogger(), fetchImpl: async () => { throw new Error('不该联网'); } });
  const [group] = groups;

  assert.deepEqual(group.icons.slice(0, 2), ['G', group.icons[1]], '群自己的 avatar 排第一');
  assert.match(group.icons[1], /^data:image\/svg\+xml;base64,/, '本地相对路径必须转成 data URI（不把文件路径塞给客户端）');
  assert.equal(group.icons[2], 'https://cdn.example.com/agnes.svg');
  assert.equal(group.icons[3], 'A');
  assert.equal(group.avatar, group.icons[0], 'avatar 保持向后兼容 = icons[0]');
});

test('群列表出参：没有任何图标时不写 avatar/icons', async (t) => {
  const dataRoot = await createTempDirectory(t);
  await fs.writeFile(path.join(dataRoot, 'config.json'), JSON.stringify({
    groups: [{ id: 'plain', name: 'Plain', driver: 'openai-compatible', baseURL: 'https://plain.example/v1' }],
  }), 'utf8');
  const config = JSON.parse(await fs.readFile(path.join(dataRoot, 'config.json'), 'utf8'));

  const groups = await listGroupsWithSummary(config, { dataRoot, logger: createRecordingLogger(), fetchImpl: async () => { throw new Error('不该联网'); } });
  assert.equal('icons' in groups[0], false);
  assert.equal('avatar' in groups[0], false);
});
