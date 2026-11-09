// 事件驱动整改：产品代码里不许再用「定时器等状态变化」。
// 允许的定时器只有三类：I/O 超时、协议轮询、UI 动画/去抖；这里用白名单钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const readSource = (relativePath) => fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

const EPILOGUE_SOURCE = await readSource('lib/client-parts/theme-epilogue.js');
const APP_SOURCE = await readSource('ui/js/app.js');
const DOCK_SOURCE = await readSource('lib/client-parts/dock.js');

test('theme-epilogue：不再轮询 store 就绪（无 setInterval / 无 50ms 常量）', () => {
  assert.equal(/setInterval/.test(EPILOGUE_SOURCE), false, '不许再轮询');
  assert.equal(/THEME_STORE_POLL_MS/.test(EPILOGUE_SOURCE), false, '轮询常量必须删除');
  assert.equal(/__dmtThemeAttachStore/.test(EPILOGUE_SOURCE), true, '必须提供"就绪即通知"的钩子');
});

test('theme-epilogue：事件监控路径里**没有**任何超时（事件必达）', () => {
  // 依据 skill event-driven-no-timeout-fallback：能事件驱动就不许用超时兜底。
  // 就绪事件必达的两条路径：①app.js 装配后同步调钩子 ②主题晚挂时直接读 __teamStore。
  assert.equal(/setTimeout\(/.test(EPILOGUE_SOURCE), false, '不许对"就绪事件"设超时');
  assert.equal(/THEME_STORE_READY_WARN_MS/.test(EPILOGUE_SOURCE), false, '超时常量必须删除');
  assert.equal(/warnTimer/.test(EPILOGUE_SOURCE), false, '不允许残留告警定时器');
  assert.match(EPILOGUE_SOURCE, /__teamStore/, '必须保留"主题晚挂直接读现值"这条路径');
});

test('装配层：__teamStore 赋值后立刻主动通知主题（同一处，不靠轮询）', () => {
  const assignIndex = APP_SOURCE.indexOf('window.__teamStore = store;');
  const notifyIndex = APP_SOURCE.indexOf('window.__dmtThemeAttachStore');
  assert.ok(assignIndex >= 0, '必须有 store 赋值');
  assert.ok(notifyIndex > assignIndex, '通知必须发生在赋值之后');
  const between = APP_SOURCE.slice(assignIndex, notifyIndex);
  assert.equal(between.includes('setTimeout'), false, '中间不许插定时器等状态');
});

test('dock.js：视图切换用微任务排队，不用 0ms 定时器', () => {
  assert.equal(/setTimeout/.test(DOCK_SOURCE), false, '零延定时器排队应改微任务');
  assert.match(DOCK_SOURCE, /Promise\.resolve\(\)\.then/, '改用微任务');
});

test('产品代码 setInterval 只剩协议轮询（白名单逐条说明）', async () => {
  // 允许清单：路径 → 理由。协议轮询用递归 setTimeout；唯一例外是 SSE 心跳——
  // 它是**服务端**往长连接里写注释帧（代理 20~60s 空闲就断），属于协议要求，不是客户端轮询。
  const allowed = new Map([
    ['src/gateway/routes/stream.js', 'SSE 心跳：每 20s 写一行 ": ping" 防代理断连（docs/09 stream 端点规定）'],
  ]);
  const roots = ['ui/js', 'src', 'lib/client-parts'];
  const offenders = [];
  const walk = async (relativeDir) => {
    let entries;
    try {
      entries = await fs.readdir(new URL(`../${relativeDir}/`, import.meta.url), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relativePath = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) { await walk(relativePath); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const sourceText = await readSource(relativePath);
      if (/setInterval\(/.test(sourceText) && !allowed.has(relativePath)) offenders.push(relativePath);
    }
  };
  for (const root of roots) await walk(root);
  assert.deepEqual(offenders, [], `这些文件仍有 setInterval，需要在允许清单里写明协议理由：${offenders.join(', ')}`);
});

test('主题 SDK 的两个剩余实现体已改为转调（buildPanelFields / readViewSize）', async () => {
  const sdkSource = await readSource('ui/theme-sdk/dock-geometry.ts');
  assert.match(sdkSource, /export const buildPanelFields = .*hostPanelFields\(\)/, 'buildPanelFields 必须转调宿主');
  assert.match(sdkSource, /export const readViewSize = .*hostGeometry\(\)/, 'readViewSize 必须转调宿主');
  assert.equal(/function buildPanelFields|function readViewSize/.test(sdkSource), false, 'SDK 不许再有实现体');
});

test('同一能力只有一处实现：面板字段 / 来源提示文案', async () => {
  const panelFieldsSource = await readSource('ui/js/float/panel-fields.js');
  const floatSource = await readSource('ui/js/float/float.js');
  const targetSourceSource = await readSource('ui/js/float/target-source.js');

  assert.equal((panelFieldsSource.match(/function buildPanelFields/g) || []).length, 1);
  assert.equal(/function buildPanelFieldTexts/.test(floatSource), false, 'float.js 不许再有面板字段实现');

  for (const hint of ['（继承上一会话）', '（继承父会话）', '（兜底群默认）']) {
    assert.equal(targetSourceSource.includes(hint), true, `来源提示必须在 target-source.js：${hint}`);
    assert.equal(floatSource.includes(hint), false, `float.js 不许复制来源文案：${hint}`);
  }
});
