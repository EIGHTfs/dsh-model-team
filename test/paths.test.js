// 数据根解析用例：验证"env 优先、缺省主目录"，以及派生路径确实挂在数据根下。
// 重点防回归：解析函数若改成模块级常量缓存，改环境变量后的用例会立刻变红。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  CONFIG_FILE_NAME,
  DATA_ROOT_ENV_VAR,
  DEFAULT_DATA_DIRECTORY_NAME,
  DRIVERS_DIRECTORY_NAME,
  getConfigPath,
  getDataRoot,
  getDriversDirectory,
} from '../src/gateway/config/paths.js';
import { setEnvironmentVariableForTest } from './helpers/test-environment.js';

test('数据根：环境变量优先于主目录缺省值', () => {
  const dataRoot = getDataRoot({ [DATA_ROOT_ENV_VAR]: '/tmp/dsh-model-team-env-root' }, '/home/example');
  assert.equal(dataRoot, path.resolve('/tmp/dsh-model-team-env-root'));
});

test('数据根：未设置环境变量时回落到主目录下的固定目录名', () => {
  const dataRoot = getDataRoot({}, '/home/example');
  assert.equal(dataRoot, path.join('/home/example', DEFAULT_DATA_DIRECTORY_NAME));
});

test('数据根：空串与纯空白都视为未设置', () => {
  const emptyValueRoot = getDataRoot({ [DATA_ROOT_ENV_VAR]: '   ' }, '/home/example');
  assert.equal(emptyValueRoot, path.join('/home/example', DEFAULT_DATA_DIRECTORY_NAME));
});

test('数据根：每次调用实时读 process.env，不做模块级缓存', (t) => {
  const runtimeRoot = '/tmp/dsh-model-team-runtime-root';
  setEnvironmentVariableForTest(t, DATA_ROOT_ENV_VAR, runtimeRoot);
  assert.equal(getDataRoot(), path.resolve(runtimeRoot));
});

test('派生路径：config.json 与 drivers/ 都挂在数据根之下', () => {
  const dataRoot = '/tmp/dsh-model-team-paths';
  assert.equal(getConfigPath(dataRoot), path.join(dataRoot, CONFIG_FILE_NAME));
  assert.equal(getDriversDirectory(dataRoot), path.join(dataRoot, DRIVERS_DIRECTORY_NAME));
  assert.equal(CONFIG_FILE_NAME, 'config.json');
  assert.equal(DRIVERS_DIRECTORY_NAME, 'drivers');
});
