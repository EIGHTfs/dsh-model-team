// 驱动注册表与加载器用例（INV-05）：坏驱动被隔离成 failed，好驱动与内置驱动照常可用。
// 每个用例结束都 reset，避免外挂驱动在用例之间残留（注册表是模块级单例）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DRIVER_STATUSES,
  getDriver,
  listDriverStatuses,
  listDrivers,
  loadExternalDrivers,
  resetDriverRegistry,
} from '../src/gateway/drivers/index.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

// 正常驱动源码：reverse 形态，用来验证"外挂驱动也能声明自己的 accessMode"
const GOOD_DRIVER_SOURCE = `export default {
  id: 'demo-reverse-driver',
  name: '演示反代驱动',
  accessMode: 'reverse',
  authSchema: [{ key: 'cookie', label: '浏览器 Cookie', type: 'password', required: true }],
  async fetchModels() { return []; },
  async chatCompletions() { return { response: {}, usage: null }; },
};
`;

// 导入阶段就抛错：模拟驱动作者写了个有副作用/依赖缺失的模块
const THROWING_DRIVER_SOURCE = `throw new Error('坏驱动在导入阶段就炸了');
export default {};
`;

// 结构不合法：缺 accessMode，必须被拒（不能默认当 official 放进来）
const INVALID_SHAPE_DRIVER_SOURCE = `export default { id: 'missing-access-mode', name: '缺 accessMode', authSchema: [] };
`;

async function prepareDriversDirectory(t) {
  const dataRoot = await createTempDirectory(t);
  const driversDir = path.join(dataRoot, 'drivers');
  t.after(() => resetDriverRegistry());
  return { dataRoot, driversDir };
}

test('内置驱动：注册表自带 openai-compatible，且为 official', () => {
  resetDriverRegistry();
  const drivers = listDrivers();

  assert.ok(drivers.length >= 1);
  const builtInDriver = drivers.find((driver) => driver.id === 'openai-compatible');
  assert.equal(builtInDriver.accessMode, 'official');
  assert.ok(Array.isArray(builtInDriver.authSchema));
  assert.equal(typeof getDriver('openai-compatible').chatCompletions, 'function');
});

test('外挂驱动：目录里的 .js 被扫到并标记 available', async (t) => {
  const { driversDir } = await prepareDriversDirectory(t);
  await fs.mkdir(driversDir, { recursive: true });
  await fs.writeFile(path.join(driversDir, 'demo-driver.js'), GOOD_DRIVER_SOURCE, 'utf8');

  const scanResult = await loadExternalDrivers({ driversDir, logger: createRecordingLogger() });
  const scannedDriver = listDrivers().find((driver) => driver.id === 'demo-reverse-driver');

  assert.equal(scanResult.failedCount, 0);
  assert.equal(scannedDriver.accessMode, 'reverse');
  assert.equal(scannedDriver.name, '演示反代驱动');
  assert.equal(typeof getDriver('demo-reverse-driver').fetchModels, 'function');
});

test('错误隔离：坏驱动 failed，好驱动与内置驱动仍可用（INV-05）', async (t) => {
  const { driversDir } = await prepareDriversDirectory(t);
  await fs.mkdir(driversDir, { recursive: true });
  await fs.writeFile(path.join(driversDir, 'good-driver.js'), GOOD_DRIVER_SOURCE, 'utf8');
  await fs.writeFile(path.join(driversDir, 'throwing-driver.js'), THROWING_DRIVER_SOURCE, 'utf8');
  await fs.writeFile(path.join(driversDir, 'invalid-driver.js'), INVALID_SHAPE_DRIVER_SOURCE, 'utf8');
  const logger = createRecordingLogger();

  const scanResult = await loadExternalDrivers({ driversDir, logger });

  const availableStatuses = scanResult.statuses.filter((record) => record.status === DRIVER_STATUSES.AVAILABLE);
  const failedStatuses = scanResult.statuses.filter((record) => record.status === DRIVER_STATUSES.FAILED);

  assert.equal(scanResult.failedCount, 2);
  assert.equal(availableStatuses.filter((record) => record.id === 'demo-reverse-driver').length, 1);
  assert.ok(availableStatuses.some((record) => record.id === 'openai-compatible'), '内置驱动不应被牵连');
  assert.ok(failedStatuses.some((record) => record.message.includes('导入阶段就炸了')));
  assert.ok(failedStatuses.some((record) => record.message.includes('accessMode')));
  assert.equal(getDriver('missing-access-mode'), null, '结构非法的驱动不得进入注册表');
  assert.equal(logger.lines.filter((line) => line.level === 'warn').length >= 2, true);
});

test('id 冲突：外挂驱动不得顶掉内置驱动', async (t) => {
  const { driversDir } = await prepareDriversDirectory(t);
  await fs.mkdir(driversDir, { recursive: true });
  await fs.writeFile(
    path.join(driversDir, 'shadow.js'),
    `export default { id: 'openai-compatible', name: '冒名驱动', accessMode: 'official', authSchema: [] };\n`,
    'utf8',
  );

  const scanResult = await loadExternalDrivers({ driversDir, logger: createRecordingLogger() });
  const builtInDriver = getDriver('openai-compatible');

  assert.equal(scanResult.failedCount, 1);
  assert.equal(builtInDriver.name, 'OpenAI 兼容（配置型）', '内置驱动不能被外挂覆盖');
});

test('目录约定：空 drivers 目录与缺失目录都不写 package.json、不造目录', async (t) => {
  const { driversDir } = await prepareDriversDirectory(t);
  const logger = createRecordingLogger();

  const missingDirectoryScan = await loadExternalDrivers({ driversDir, logger });
  assert.equal(missingDirectoryScan.availableCount, 1, '只有内置驱动');
  await assert.rejects(() => fs.stat(driversDir), '启动阶段不应在数据根造 drivers 目录');

  await fs.mkdir(driversDir, { recursive: true });
  const emptyDirectoryScan = await loadExternalDrivers({ driversDir, logger });
  assert.equal(emptyDirectoryScan.availableCount, 1);
  await assert.rejects(() => fs.stat(path.join(driversDir, 'package.json')), '没有驱动文件就不该写 package.json');
  assert.equal(logger.hasLine('info', 'package.json'), false);
});

test('热加载：新增驱动文件后重扫即可出现，且那时才补 drivers/package.json', async (t) => {
  const { driversDir } = await prepareDriversDirectory(t);
  await fs.mkdir(driversDir, { recursive: true });
  const logger = createRecordingLogger();

  const firstScan = await loadExternalDrivers({ driversDir, logger });
  assert.equal(firstScan.availableCount, 1, '只有内置驱动');

  await fs.writeFile(path.join(driversDir, 'later-driver.js'), GOOD_DRIVER_SOURCE, 'utf8');
  const secondScan = await loadExternalDrivers({ driversDir, logger });

  assert.equal(secondScan.availableCount, 2);
  assert.ok(listDrivers().some((driver) => driver.id === 'demo-reverse-driver'));
  const moduleTypeFile = JSON.parse(await fs.readFile(path.join(driversDir, 'package.json'), 'utf8'));
  assert.equal(moduleTypeFile.type, 'module', '驱动目录必须声明 ESM 作用域');
  assert.ok(logger.hasLine('info', '以支持 ESM 驱动'), '补 package.json 时要打可自解释的 info 日志');
});

test('目录扫描：非 .js 与隐藏文件被忽略', async (t) => {
  const { driversDir } = await prepareDriversDirectory(t);
  await fs.mkdir(driversDir, { recursive: true });
  await fs.writeFile(path.join(driversDir, 'readme.md'), '# 说明', 'utf8');
  await fs.writeFile(path.join(driversDir, '.hidden-driver.js'), THROWING_DRIVER_SOURCE, 'utf8');
  await fs.writeFile(path.join(driversDir, 'good-driver.js'), GOOD_DRIVER_SOURCE, 'utf8');

  const scanResult = await loadExternalDrivers({ driversDir, logger: createRecordingLogger() });

  assert.equal(scanResult.failedCount, 0);
  assert.equal(scanResult.availableCount, 2, '内置驱动 + 一个真正的 .js');
  assert.equal(listDriverStatuses().length, 2);
});

test('resetDriverRegistry：清掉外挂驱动，只留内置', async (t) => {
  const { driversDir } = await prepareDriversDirectory(t);
  await fs.mkdir(driversDir, { recursive: true });
  await fs.writeFile(path.join(driversDir, 'good-driver.js'), GOOD_DRIVER_SOURCE, 'utf8');
  await loadExternalDrivers({ driversDir, logger: createRecordingLogger() });

  resetDriverRegistry();

  assert.equal(getDriver('demo-reverse-driver'), null);
  assert.deepEqual(listDrivers().map((driver) => driver.id), ['openai-compatible']);
});
