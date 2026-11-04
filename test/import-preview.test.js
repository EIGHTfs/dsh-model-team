// G7：导入回执的字段名与文案。
// 为什么要单测这两点：① 列读 group.driverId 时后端返回的是 driver，表格该列恒空，
// 只有真导入一次才看得出；② 旧文案「只展示结果、不写入存储」与真实行为（merge upsert）相反，
// 会让人以为导入没生效。两者都是"跑起来不报错、但说的是假话"的类型。
// 加载方式同 test/target-source.test.js：执行分片源码 + escapeHtml 垫片。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const ADMIN_SOURCE = await fs.readFile(new URL('../ui/js/admin.js', import.meta.url), 'utf8');

function loadAdminLayer() {
  globalThis.escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${ADMIN_SOURCE}
;return {
  renderImportPreviewTable: renderImportPreviewTable,
  buildImportResultNote: buildImportResultNote
};`);
  return factory();
}

test('G7-①：导入预览表用 group.driver，驱动列不能是空的（不许出现 undefined）', () => {
  const admin = loadAdminLayer();

  const tableHtml = admin.renderImportPreviewTable([
    { id: 'sa6400', name: 'sa6400', driver: 'openai-compatible', credentialRef: 'file:credentials/sa6400.key' },
  ]);

  assert.match(tableHtml, /openai-compatible/, '驱动值必须出现在表格里');
  assert.equal(tableHtml.includes('undefined'), false, '驱动字段读错时会出现 undefined');
  assert.match(tableHtml, /<th>driver<\/th>/, '表头必须写 driver（与契约字段名一致）');
  assert.equal(tableHtml.includes('driverId'), false, '不许再出现 driverId 表头');
});

test('G7-②：导入说明写真实行为（合并写入），不再出现「阶段 1 / 不写入存储」', () => {
  const admin = loadAdminLayer();

  const note = admin.buildImportResultNote(3, 1);

  assert.match(note, /可导入 3 个平台账号/);
  assert.match(note, /结构不合法 1 条/);
  assert.match(note, /合并写入/, '必须说明会写入');
  assert.match(note, /upsert/, '必须说明同名覆盖语义');
  assert.equal(note.includes('阶段'), false, '不许再出现阶段编号');
  assert.equal(note.includes('不写入存储'), false, '旧文案与新行为相反');
});
