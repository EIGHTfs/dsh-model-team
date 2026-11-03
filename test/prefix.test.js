// 前缀防漂移用例：服务端前缀只有一个事实来源，客户端字面量必须与它一致。
// 背景：客户端半部（lib/client.js）跑在浏览器里，不能 import 服务端模块，只能写字面量——
//      这条用例就是"改了服务端忘了改客户端"的护栏。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { API_PREFIX } from '../src/gateway/constants.js';
import { ROUTES } from '../src/gateway/routes.js';
import { TEAM_ROUTE_PREFIX } from '../src/plugin/web-routes.js';

// 客户端在 lib/client.js 里自行声明前缀（浏览器端不能 import 服务端模块）
const CLIENT_PREFIX_PATTERN = /\bAPI_PREFIX\s*=\s*"(\/[^"]+)"/;

test('API_PREFIX 是唯一事实来源，且为 /_team', () => {
  assert.equal(API_PREFIX, '/_team');
});

test('所有内部端点的 pattern 都以 API_PREFIX 开头（没有第二套前缀）', () => {
  const internalRoutes = ROUTES.filter(
    (route) => route.pattern !== '/v1/chat/completions' && route.pattern !== '/v1/models',
  );

  assert.equal(internalRoutes.length >= 10, true, '内部端点数量应覆盖 docs 表');
  for (const route of internalRoutes) {
    assert.equal(
      route.pattern.startsWith(`${API_PREFIX}/`),
      true,
      `内部端点必须挂在前缀下：${route.pattern}`,
    );
  }
});

test('webServer 路由注册用的前缀直接取自 API_PREFIX', () => {
  assert.equal(TEAM_ROUTE_PREFIX, API_PREFIX);
});

test('防漂移：lib/client.js 里声明的 API_PREFIX 必须与服务端一致', async () => {
  const clientSource = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  const prefixMatch = CLIENT_PREFIX_PATTERN.exec(clientSource);

  assert.notEqual(prefixMatch, null, '客户端里找不到 API_PREFIX 声明');
  assert.equal(prefixMatch[1], API_PREFIX, '客户端前缀与服务端 API_PREFIX 已经漂移');
});
