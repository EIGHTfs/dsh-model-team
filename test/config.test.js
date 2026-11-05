// config.json 容错用例（INV-06）：缺失自动建、损坏降级、读取异常降级、写回原子且不留临时文件。
// 这些用例是"坏配置不打死网关"的唯一证据，所以每条都断言了日志级别与返回值形状。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createEmptyConfig, normalizeConfig, readConfig, writeConfig } from '../src/gateway/config/config.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

test('config：文件缺失时自动创建目录与空配置，并打 info 日志', async (t) => {
  const dataRoot = path.join(await createTempDirectory(t), 'nested', 'data-root');
  const logger = createRecordingLogger();

  const config = await readConfig({ dataRoot, logger });

  assert.deepEqual(config, createEmptyConfig());
  const writtenConfig = JSON.parse(await fs.readFile(path.join(dataRoot, 'config.json'), 'utf8'));
  assert.deepEqual(writtenConfig, { groups: [] });
  assert.ok(logger.hasLine('info', '自动创建空配置'), '缺少 info 级"已自动创建空配置"日志');
});

test('config：解析失败时降级为空配置且不抛错，并打 warn 日志', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const configPath = path.join(dataRoot, 'config.json');
  await fs.writeFile(configPath, '{ "groups": [ 这不是合法 JSON', 'utf8');
  const logger = createRecordingLogger();

  const config = await readConfig({ dataRoot, logger });

  assert.deepEqual(config, createEmptyConfig());
  assert.ok(logger.hasLine('warn', '解析失败'), '缺少 warn 级"解析失败"日志');
  // 降级只发生在本进程内存里，坏文件不该被悄悄覆盖，用户还有机会修
  assert.match(await fs.readFile(configPath, 'utf8'), /这不是合法 JSON/);
});

test('config：读取异常（路径是目录）同样降级空配置，不抛致命错误', async (t) => {
  const dataRoot = await createTempDirectory(t);
  await fs.mkdir(path.join(dataRoot, 'config.json'));
  const logger = createRecordingLogger();

  const config = await readConfig({ dataRoot, logger });

  assert.deepEqual(config, createEmptyConfig());
  assert.ok(logger.hasLine('warn', '读取失败'), '缺少 warn 级"读取失败"日志');
});

test('config：结构不合法（groups 不是数组）时按空群列表处理并告警', async (t) => {
  const dataRoot = await createTempDirectory(t);
  await fs.writeFile(path.join(dataRoot, 'config.json'), JSON.stringify({ groups: 'oops', extra: 1 }), 'utf8');
  const logger = createRecordingLogger();

  const config = await readConfig({ dataRoot, logger });

  assert.deepEqual(config.groups, []);
  assert.equal(config.extra, 1, '未知字段应原样保留');
  assert.ok(logger.hasLine('warn', '结构不合法'));
});

test('config：合法配置原样读出', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const storedConfig = {
    groups: [{ id: 'agnes', name: 'agnes(本机)', accessMode: 'official', driver: 'openai-compatible' }],
  };
  await fs.writeFile(path.join(dataRoot, 'config.json'), JSON.stringify(storedConfig), 'utf8');

  const config = await readConfig({ dataRoot, logger: createRecordingLogger() });

  assert.deepEqual(config, storedConfig);
});

test('config：writeConfig 原子写 —— 落盘完整、无临时文件残留、可再读回', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  const configToWrite = { groups: [{ id: 'agnes' }, { id: 'eightfs' }] };

  const writtenPath = await writeConfig(configToWrite, { dataRoot, logger });
  const directoryEntries = await fs.readdir(dataRoot);

  assert.equal(writtenPath, path.join(dataRoot, 'config.json'));
  assert.deepEqual(directoryEntries, ['config.json'], '数据根不应残留临时文件');
  assert.deepEqual(JSON.parse(await fs.readFile(writtenPath, 'utf8')), configToWrite);
  assert.deepEqual(await readConfig({ dataRoot, logger }), configToWrite);
});

test('config：writeConfig 拒绝结构非法的入参（编码错误尽早暴露）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  await assert.rejects(() => writeConfig({ groups: 'not-an-array' }, { dataRoot }), TypeError);
  await assert.rejects(() => writeConfig(null, { dataRoot }), TypeError);
});

test('config：normalizeConfig 对非对象与数组输入都给出空配置', () => {
  assert.deepEqual(normalizeConfig([]).config, { groups: [] });
  assert.equal(normalizeConfig('nope').wasRepaired, true);
  assert.equal(normalizeConfig({ groups: [] }).wasRepaired, false);
});
