// 反代声明式注册用例（G42 第 4 步）：
//   manifest 是唯一事实来源；register 幂等、失败只降级；describeReverse 形状固定。
import test from 'node:test';
import assert from 'node:assert/strict';

import { manifest } from '../src/reverse/manifest.js';
import { describeReverse, registerReverse } from '../src/reverse/register.js';
import { listContributedRoutes } from '../src/gateway/routes/index.js';
import { resetRouteContributorsForTest } from '../src/gateway/transport/route-contributors.js';
import { createRecordingLogger } from './helpers/test-environment.js';

test('manifest：只放元数据，平台与路由声明齐全', () => {
  assert.equal(manifest.id, 'reverse');
  assert.equal(manifest.platforms.length >= 1, true);
  const qoder = manifest.platforms.find((entry) => entry.id === 'qoder');
  assert.equal(qoder.driverId, 'reverse-qoder');
  assert.equal(qoder.displayName, 'Qoder');
  assert.equal(typeof qoder.module, 'string', '实现只给路径字符串，不在清单里 import');
  assert.equal(Array.isArray(qoder.cryptoBackends), true);
  for (const route of manifest.routes) {
    assert.match(route.handler, /^\.\/.+\.js#.+$/);
    assert.match(route.path, /^\/_team\//);
  }
  assert.deepEqual([...manifest.importSources].sort(), ['host-credentials', 'manual']);
  assert.equal(manifest.uiMounts[0].kind, 'reverse-account');
});

test('registerReverse：幂等（重复调用复用同一份结果，不重复贡献路由）', async () => {
  resetRouteContributorsForTest();
  const logger = createRecordingLogger();

  const first = registerReverse({ logger });
  const second = registerReverse({ logger });
  assert.equal(first, second, '同一进程内重复调用返回同一个 Promise');

  const registration = await first;
  assert.equal(registration.routes, manifest.routes.length);
  assert.deepEqual(registration.failed, []);
  assert.equal(listContributedRoutes().length, manifest.routes.length, '贡献路由数 = 清单里的路由数');

  // 再调一次仍然是同一份结果，路由不会被注册两遍
  const again = await registerReverse({ logger });
  assert.equal(again, registration);
  assert.equal(listContributedRoutes().length, manifest.routes.length);
});

test('registerReverse：ctx/credentials 缺失也能完成（只降级，不抛）', async () => {
  const logger = createRecordingLogger();
  const registration = await registerReverse({ logger, credentials: null });

  assert.equal(typeof registration.dispose, 'function');
  assert.equal(typeof registration.routes, 'number');
  assert.equal(typeof registration.drivers, 'number');
  assert.equal(typeof registration.importSources, 'number');
});

test('describeReverse：形状固定（平台可用性 + 导入源）', () => {
  const description = describeReverse();

  assert.equal(Array.isArray(description.platforms), true);
  const qoder = description.platforms.find((entry) => entry.id === 'qoder');
  assert.deepEqual(Object.keys(qoder).sort(), ['available', 'capabilities', 'displayName', 'driverId', 'id']);
  assert.equal(qoder.driverId, 'reverse-qoder');
  assert.equal(qoder.displayName, 'Qoder');
  assert.equal(qoder.available, true);
  assert.deepEqual(description.importSources, ['host-credentials', 'manual']);
});

test('dispose：撤销路由贡献（dispose 后贡献路由清空）', async () => {
  const logger = createRecordingLogger();
  const registration = await registerReverse({ logger });
  assert.equal(listContributedRoutes().length > 0, true);

  registration.dispose();
  assert.equal(listContributedRoutes().length, 0, 'dispose 后不再贡献任何路由');
});
