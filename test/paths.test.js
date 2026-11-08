// 数据根解析用例：验证"env 优先、缺省主目录"，以及派生路径确实挂在数据根下。
// 重点防回归：解析函数若改成模块级常量缓存，改环境变量后的用例会立刻变红。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  CONFIG_FILE_NAME,
  DATA_DIRECTORY_NAME,
  DATA_ROOT_ENV_VAR,
  DEFAULT_DATA_DIRECTORY_NAME,
  DSH_HOME_ENV_VAR,
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

// ===== 三档优先级（G35：DSH_HOME 锚点）=====

test('数据根①：DSH_MODEL_TEAM_HOME 与 DSH_HOME 同时存在时，显式覆盖赢', () => {
  const dataRoot = getDataRoot({
    [DATA_ROOT_ENV_VAR]: '/tmp/explicit-root',
    [DSH_HOME_ENV_VAR]: '/srv/host-app/home/.dsh',
  }, '/home/example');

  assert.equal(dataRoot, path.resolve('/tmp/explicit-root'));
  assert.equal(dataRoot.includes(DATA_DIRECTORY_NAME), false, '显式覆盖是整根，不再拼子目录');
});

test('数据根②：只有 DSH_HOME 时，挂到 <DSH_HOME>/dsh-model-team', () => {
  const dshHome = '/srv/host-app/home/.dsh';
  const dataRoot = getDataRoot({ [DSH_HOME_ENV_VAR]: dshHome }, '/home/example');

  assert.equal(dataRoot, path.resolve(path.join(dshHome, DATA_DIRECTORY_NAME)));
  assert.equal(dataRoot.endsWith(path.join('.dsh', DATA_DIRECTORY_NAME)), true);
});

test('数据根③：两档都没有时回落到家目录隐藏目录（与 DSH_HOME 档用不同的目录名）', () => {
  const dataRoot = getDataRoot({}, '/home/example');

  assert.equal(dataRoot, path.join('/home/example', DEFAULT_DATA_DIRECTORY_NAME));
  assert.notEqual(DEFAULT_DATA_DIRECTORY_NAME, DATA_DIRECTORY_NAME, '两个常量必须区分开');
});

test('数据根：DSH_HOME 为空串 / 纯空白 → 回落家目录；尾斜杠不产生重复分隔符', () => {
  for (const emptyValue of ['', '   ']) {
    assert.equal(
      getDataRoot({ [DSH_HOME_ENV_VAR]: emptyValue }, '/home/example'),
      path.join('/home/example', DEFAULT_DATA_DIRECTORY_NAME),
      `DSH_HOME=${JSON.stringify(emptyValue)} 应视为未设置`,
    );
  }

  const withTrailingSlash = getDataRoot({ [DSH_HOME_ENV_VAR]: '/opt/dsh/.dsh//' }, '/home/example');
  assert.equal(withTrailingSlash, path.resolve('/opt/dsh/.dsh/dsh-model-team'));
  assert.equal(withTrailingSlash.includes('//'), false, '归一后不该出现重复分隔符');
});

test('数据根：实时读 env——同一进程内改 DSH_HOME 再调，结果跟着变（不做模块级缓存）', (t) => {
  setEnvironmentVariableForTest(t, DSH_HOME_ENV_VAR, '/tmp/dsh-home-first');
  assert.equal(getDataRoot(), path.resolve(path.join('/tmp/dsh-home-first', DATA_DIRECTORY_NAME)));

  process.env[DSH_HOME_ENV_VAR] = '/tmp/dsh-home-second';
  assert.equal(getDataRoot(), path.resolve(path.join('/tmp/dsh-home-second', DATA_DIRECTORY_NAME)));
});
