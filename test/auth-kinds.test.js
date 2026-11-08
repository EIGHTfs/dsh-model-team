// 驱动认证形态常量：**值是对外契约的一部分**——已存的群配置、驱动描述符、前端判别都用这些字面量。
// 这个用例存在的唯一目的：防止以后有人"重命名常量时顺手改值"。
import test from 'node:test';
import assert from 'node:assert/strict';

import { AUTH_KINDS } from '../src/gateway/drivers/index.js';

test('AUTH_KINDS.REVERSE_ACCOUNT 的值必须保持 reverse-account（改值等于破坏已存群配置）', () => {
  assert.equal(AUTH_KINDS.REVERSE_ACCOUNT, 'reverse-account');
  assert.equal(AUTH_KINDS.API_KEY, 'api-key');
  assert.equal(Object.isFrozen(AUTH_KINDS), true, '常量表应冻结，防止运行期被改');
});
