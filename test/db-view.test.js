// 数据库页的显示投影（纯函数）：把服务端原始响应折叠成"用户能看懂的行"。
// 这些断言锁的是"界面文案从哪来"——数字必须来自服务端回执，不自己算。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const DB_VIEW_SOURCE = await fs.readFile(new URL('../ui/js/format/db-view.js', import.meta.url), 'utf8');
const dbView = new Function(`${DB_VIEW_SOURCE}
;return { summarizeBackup: summarizeBackup, previewImport: previewImport, buildImportReceipt: buildImportReceipt, describeDbFailure: describeDbFailure };`)();

const BACKUP = Object.freeze({
  version: 2,
  exportedAt: '2026-11-10T12:34:56.789Z',
  groups: [{ id: 'g1' }, { id: 'g2' }],
  credentialFiles: { 'credentials/a.key': 'x', 'credentials/b.key': 'y', 'credentials/c.key': 'z' },
  unresolvedRefs: [{ path: 'credentials/missing.key', reason: '不存在' }],
});

test('summarizeBackup：版本/时间/群数/凭据数/未导出引用数全部来自备份本体', () => {
  const summary = dbView.summarizeBackup(BACKUP);
  assert.equal(summary.versionText, 'v2');
  assert.equal(summary.exportedAtText, '2026-11-10 12:34:56');
  assert.equal(summary.groupCount, 2);
  assert.equal(summary.credentialFileCount, 3);
  assert.equal(summary.unresolvedRefCount, 1);
});

test('summarizeBackup：空对象与 null 都不抛，计数为 0、文案占位', () => {
  for (const input of [null, undefined, {}, 'not-an-object']) {
    const summary = dbView.summarizeBackup(input);
    assert.equal(summary.groupCount, 0);
    assert.equal(summary.credentialFileCount, 0);
    assert.equal(summary.unresolvedRefCount, 0);
    assert.equal(summary.versionText, '—');
  }
});

test('previewImport：形状不对要标出来，缺 id 的条目单独计数', () => {
  const good = dbView.previewImport(BACKUP, 'backup.json');
  assert.equal(good.isBackupShaped, true);
  assert.equal(good.groupCount, 2);
  assert.equal(good.invalidCount, 0);
  assert.equal(good.fileName, 'backup.json');

  const bad = dbView.previewImport({ groups: [{ id: 'ok' }, { name: '缺 id' }] }, 'x.json');
  assert.equal(bad.groupCount, 2);
  assert.equal(bad.invalidCount, 1);

  const notBackup = dbView.previewImport({ hello: 1 }, 'x.json');
  assert.equal(notBackup.isBackupShaped, false);
  assert.equal(notBackup.groupCount, 0);
});

test('buildImportReceipt：数字全部取服务端回执，拒绝/跳过明细原样保留', () => {
  const receipt = dbView.buildImportReceipt({
    imported: 2,
    updated: 3,
    rejected: [{ index: 4, reason: '凭证引用了明文' }],
    restoredCredentialFiles: 5,
    skippedRefs: [{ path: 'credentials/m.key', reason: '不在数据根内' }],
  });
  assert.equal(receipt.headline, '导入完成：新增 2 条，更新 3 条，拒绝 1 条');
  const rowMap = Object.fromEntries(receipt.rows.map((row) => [row.label, row.value]));
  assert.deepEqual(rowMap, { 新增: '2', 更新: '3', 拒绝: '1', 凭据还原: '5', 跳过引用: '1' });
  assert.deepEqual(receipt.rejectedRows, [{ index: 4, reason: '凭证引用了明文' }]);
  assert.deepEqual(receipt.skippedRows, [{ path: 'credentials/m.key', reason: '不在数据根内' }]);
});

test('buildImportReceipt：空回执也是合法输入（0 条 + 空明细）', () => {
  const receipt = dbView.buildImportReceipt(null);
  assert.equal(receipt.headline, '导入完成：新增 0 条，更新 0 条，拒绝 0 条');
  assert.deepEqual(receipt.rejectedRows, []);
  assert.deepEqual(receipt.skippedRows, []);
});

test('describeDbFailure：409 的码要能被识别成"需要确认"，文案取服务端原文', () => {
  const needConfirm = dbView.describeDbFailure({
    code: 'confirmation-required',
    message: '整体替换会删除现有群，需确认后重试',
    hint: '请求体带 confirm: true 再提交',
  });
  assert.equal(needConfirm.needsConfirm, true);
  assert.equal(needConfirm.title, '整体替换会删除现有群，需确认后重试');
  assert.equal(needConfirm.detail, '请求体带 confirm: true 再提交');

  const other = dbView.describeDbFailure({ code: 'invalid-request', message: '导入内容必须是 { groups: [...] }' });
  assert.equal(other.needsConfirm, false);
  assert.equal(other.title, '导入内容必须是 { groups: [...] }');
  assert.equal(dbView.describeDbFailure(null).title, '操作失败');
});
