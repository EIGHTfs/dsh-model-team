// INV-14 防漂移：客户端判定"当前 session 选中虚拟模型"用的是两个字面量常量
// （OUR_PROVIDER_ID / VIRTUAL_MODEL_ID）。它们必须与服务端实际注册的名字一致，
// 否则悬浮球会永远判成"不是我们的模型"而不显示 —— 这类漂移在单测里只能靠读源码守护。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { DEFAULT_PROVIDER_ID } from '../src/plugin/adapter.js';

const CLIENT_PATH = new URL('../lib/client.js', import.meta.url);
const PROVIDER_PATTERN = /^var OUR_PROVIDER_ID = "([^"]+)";$/m;
const VIRTUAL_MODEL_PATTERN = /^var VIRTUAL_MODEL_ID = "([^"]+)";$/m;

async function readClientSource() {
  return fs.readFile(CLIENT_PATH, 'utf8');
}

test('INV-14 防漂移：客户端 OUR_PROVIDER_ID 与适配器注册名一致', async () => {
  const clientSource = await readClientSource();
  const matched = PROVIDER_PATTERN.exec(clientSource);

  assert.notEqual(matched, null, '客户端里找不到 OUR_PROVIDER_ID 声明');
  assert.equal(matched[1], DEFAULT_PROVIDER_ID, '客户端 provider 与适配器注册名已经漂移');
});

test('INV-14 防漂移：客户端 VIRTUAL_MODEL_ID 与虚拟模型缺省名一致', async () => {
  const clientSource = await readClientSource();
  const matched = VIRTUAL_MODEL_PATTERN.exec(clientSource);

  assert.notEqual(matched, null, '客户端里找不到 VIRTUAL_MODEL_ID 声明');
  // 缺省虚拟模型 id 就是 provider id（src/gateway/router.js 与 adapter.js 同口径）
  assert.equal(matched[1], DEFAULT_PROVIDER_ID, '客户端虚拟模型名与缺省值已经漂移');
});
