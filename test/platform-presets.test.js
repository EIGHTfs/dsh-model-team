// 平台清单加载器用例：用户覆盖 > 内置默认；坏 JSON 回落；非法项跳过；都没有返回空数组（200 不 500）。
// 数据全部来自 JSON 文件，代码里不出现任何平台字面量。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startGatewayHarness, buildGroup } from './helpers/gateway-harness.js';
import { writeConfig } from '../src/gateway/config/config.js';
import { API_PREFIX } from '../src/gateway/config/constants.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';
import {
  DEFAULT_PLATFORMS_FILE_URL,
  loadPlatformPresets,
} from '../src/gateway/config/platform-presets.js';

const REQUIRED_FIELDS = ['id', 'name', 'baseURL'];

// 造一个自定义平台（不含任何真实平台域名）
function buildCustomPreset(overrides = {}) {
  return {
    id: 'custom-platform',
    name: 'Custom Platform',
    avatar: 'data:image/png;base64,AAAA',
    baseURL: 'https://custom.example/v1',
    modelsEndpoint: '/models',
    homepage: 'https://custom.example',
    summaryTemplate: '自建 · {baseURL}',
    driverId: 'openai-compatible',
    ...overrides,
  };
}

async function writeUserPlatforms(dataRoot, platforms) {
  await fs.writeFile(path.join(dataRoot, 'platforms.json'), JSON.stringify({ platforms }, null, 2), 'utf8');
}

test('只有内置默认文件：返回内置清单（含 id/name/baseURL）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const harness = await startGatewayHarness(t);
  await writeConfig({ groups: [] }, { dataRoot: harness.dataRoot });

  const presets = await loadPlatformPresets({ dataRoot });

  assert.equal(presets.length >= 1, true);
  for (const preset of presets) {
    for (const fieldName of REQUIRED_FIELDS) {
      assert.equal(typeof preset[fieldName], 'string');
      assert.equal(preset[fieldName].length > 0, true);
    }
  }
});

test('用户 platforms.json 存在：整体覆盖内置默认（默认项不再出现）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  await writeUserPlatforms(dataRoot, [buildCustomPreset()]);

  const presets = await loadPlatformPresets({ dataRoot });

  assert.deepEqual(presets.map((preset) => preset.id), ['custom-platform']);
  assert.equal(presets.some((preset) => preset.id === 'agnes'), false, '默认项应被整体覆盖');
});

test('用户文件是坏 JSON：回落内置默认并 warn，不抛错', async (t) => {
  const dataRoot = await createTempDirectory(t);
  await fs.writeFile(path.join(dataRoot, 'platforms.json'), '{ this is not json', 'utf8');
  const logger = createRecordingLogger();

  const presets = await loadPlatformPresets({ dataRoot, logger });

  assert.equal(presets.length >= 1, true, '应回落到内置默认');
  assert.equal(logger.hasLine('warn', '不是合法 JSON'), true);
});

test('某项缺 baseURL：该项被跳过，其余照常', async (t) => {
  const dataRoot = await createTempDirectory(t);
  await writeUserPlatforms(dataRoot, [
    buildCustomPreset({ id: 'broken-item', baseURL: undefined }),
    buildCustomPreset({ id: 'good-item' }),
  ]);
  const logger = createRecordingLogger();

  const presets = await loadPlatformPresets({ dataRoot, logger });

  assert.deepEqual(presets.map((preset) => preset.id), ['good-item']);
  assert.equal(logger.hasLine('warn', '缺少必填字段'), true);
});

test('两个文件都不存在：返回空数组（端点 200 + 空清单，不 500）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const missingDefaultUrl = new URL('file:///nonexistent-dsh-model-team/platforms.json');

  const presets = await loadPlatformPresets({ dataRoot, defaultFileUrl: missingDefaultUrl });

  assert.deepEqual(presets, []);
});

test('GET /_team/platforms：默认清单走接口返回 200 + 非空数组', async (t) => {
  const harness = await startGatewayHarness(t);
  await writeConfig({ groups: [] }, { dataRoot: harness.dataRoot });

  const response = await harness.request(`${API_PREFIX}/platforms`);

  assert.equal(response.status, 200);
  assert.equal(Array.isArray(response.body.platforms), true);
  assert.equal(response.body.platforms.length >= 1, true);
  assert.equal(DEFAULT_PLATFORMS_FILE_URL.pathname.endsWith('/config/platforms.json'), true);
});

test('群列表 avatar：配置自带 / 预置回落 / 都没有省略', async (t) => {
  const harness = await startGatewayHarness(t);
  await writeConfig(
    {
      groups: [
        buildGroup({ id: 'with-avatar', name: '自带头像群', avatar: 'https://example.com/a.png', baseURL: 'http://127.0.0.1:9/v1' }),
        buildGroup({ id: 'agnes', name: 'agnes(本机)', baseURL: 'http://127.0.0.1:9/v1' }),
        buildGroup({ id: 'no-avatar-group', name: '自定义平台', baseURL: 'http://127.0.0.1:9/v1' }),
      ],
    },
    { dataRoot: harness.dataRoot },
  );

  const groups = (await harness.request(`${API_PREFIX}/groups`)).body.groups;
  const byId = new Map(groups.map((group) => [group.id, group]));
  const builtinPresets = await loadPlatformPresets({ dataRoot: harness.dataRoot });
  const agnesPreset = builtinPresets.find((preset) => preset.id === 'agnes');

  assert.equal(byId.get('with-avatar').avatar, 'https://example.com/a.png', '配置优先');
  assert.equal(byId.get('agnes').avatar, agnesPreset?.avatar, '配置没有时回落预置');
  assert.equal('avatar' in byId.get('no-avatar-group'), false, '都没有时省略字段');
});
