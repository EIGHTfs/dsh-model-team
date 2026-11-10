// 数据库页的值层（store/db.js）：状态机 + 409 二次确认。
// 注入 api / download 桩：不碰真实网络与真实下载，断言"状态怎么走、请求体怎么组"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const DB_SOURCE = await fs.readFile(new URL('../ui/js/store/db.js', import.meta.url), 'utf8');
const DB_VIEW_SOURCE = await fs.readFile(new URL('../ui/js/format/db-view.js', import.meta.url), 'utf8');
const ADD_FORM_DEPS = await fs.readFile(new URL('../ui/js/format/driver-view.js', import.meta.url), 'utf8');

function createHarness({ exportResult, importResponses } = {}) {
  const events = [];
  const downloads = [];
  const importCalls = [];
  const state = {};
  const responses = Array.isArray(importResponses) ? importResponses.slice() : [];
  const factory = new Function(`${ADD_FORM_DEPS}\n${DB_VIEW_SOURCE}\n${DB_SOURCE}
;return { createDbActions: createDbActions, createDbState: createDbState };`)();
  // apiPostRaw / apiServerError 在真实产物里由 foundation/api.js 提供（同一作用域），测试里给出等价桩
  const harnessGlobals = {
    apiPostRaw: async (path, payload) => {
      importCalls.push({ path, payload });
      return responses.shift() || { imported: 0, updated: 0, rejected: [] };
    },
    apiServerError: (body, fallbackMessage, fallbackCode) => {
      const error = new Error(body?.error?.message || fallbackMessage);
      error.code = body?.error?.code || fallbackCode;
      error.hint = body?.error?.hint || '';
      return error;
    },
  };
  globalThis.apiPostRaw = harnessGlobals.apiPostRaw;
  globalThis.apiServerError = harnessGlobals.apiServerError;
  const actions = factory.createDbActions({
    api: { exportConfig: async () => (exportResult !== undefined ? exportResult : { version: 2, groups: [{ id: 'g' }], credentialFiles: {} }) },
    state,
    broadcast: (eventName) => events.push(eventName),
    download: (fileName, text) => { downloads.push({ fileName, bytes: text.length }); return { fileName, bytes: text.length }; },
  });
  return { actions, state, events, downloads, importCalls };
}

const BACKUP_TEXT = JSON.stringify({ version: 2, groups: [{ id: 'g1' }], credentialFiles: {} });

test('导出：idle → exporting → done，并把摘要/文件名/大小记下来', async () => {
  const harness = createHarness({});
  await harness.actions.exportDbBackup();
  assert.equal(harness.state.db.phase, 'done');
  assert.equal(harness.state.db.lastExport.fileName.startsWith('model-team-backup-'), true);
  assert.equal(harness.state.db.backupSummary.groupCount, 1);
  assert.equal(harness.downloads.length, 1, '下载端口必须被调用一次（主题不自己落盘）');
  assert.deepEqual(harness.events.slice(0, 2), ['db:changed', 'db:changed']);
});

test('导出失败（服务端没给内容）→ error 态 + 可读文案', async () => {
  const harness = createHarness({ exportResult: null });
  await harness.actions.exportDbBackup();
  assert.equal(harness.state.db.phase, 'error');
  assert.equal(harness.state.db.error.title, '导出失败：服务端没有返回内容');
  assert.equal(harness.downloads.length, 0);
});

test('合并导入：importing → done，回执数字来自服务端', async () => {
  const harness = createHarness({ importResponses: [{ imported: 3, updated: 1, rejected: [], restoredCredentialFiles: 2, skippedRefs: [] }] });
  await harness.actions.importDbBackup({ text: BACKUP_TEXT, fileName: 'b.json' });
  assert.equal(harness.state.db.phase, 'done');
  assert.equal(harness.state.db.lastImport.headline, '导入完成：新增 3 条，更新 1 条，拒绝 0 条');
  assert.equal(harness.state.db.pendingImport, null);
  assert.equal(harness.importCalls.length, 1);
  assert.equal(harness.importCalls[0].payload.mode, 'merge');
});

test('整体替换：首次不带确认 → 409 → need-confirm 并暂存请求体；确认后带 confirm:true 重发成功', async () => {
  const harness = createHarness({
    importResponses: [
      { error: { code: 'confirmation-required', message: '整体替换会删除现有群，需确认后重试', hint: '请求体带 confirm: true 再提交' } },
      { imported: 1, updated: 0, rejected: [] },
    ],
  });
  await harness.actions.importDbBackup({ text: BACKUP_TEXT, fileName: 'b.json', mode: 'replace' });
  assert.equal(harness.state.db.phase, 'need-confirm');
  assert.equal(harness.state.db.error.needsConfirm, true);
  assert.equal(harness.state.db.error.detail, '请求体带 confirm: true 再提交');
  assert.deepEqual(harness.state.db.pendingImport, { text: BACKUP_TEXT, fileName: 'b.json' });
  assert.equal(harness.importCalls[0].payload.mode, 'replace');
  assert.equal(harness.importCalls[0].payload.confirm, undefined, '首次不许带确认');

  await harness.actions.confirmDbReplace();
  assert.equal(harness.state.db.phase, 'done');
  assert.equal(harness.state.db.pendingImport, null, '确认后必须清掉待确认内容');
  assert.equal(harness.importCalls[1].payload.confirm, true, '确认重发必须带 confirm:true');
});

test('导入内容不是 JSON / 不是备份形状 → error，且不发请求', async () => {
  const notJson = createHarness({});
  await notJson.actions.importDbBackup({ text: 'hello', fileName: 'x.json' });
  assert.equal(notJson.state.db.phase, 'error');
  assert.equal(notJson.state.db.error.title, '内容不是合法 JSON');
  assert.equal(notJson.importCalls.length, 0);

  const notBackup = createHarness({});
  await notBackup.actions.previewDbImport({ text: JSON.stringify({ hello: 1 }), fileName: 'x.json' });
  assert.equal(notBackup.state.db.phase, 'error');
  assert.equal(notBackup.state.db.error.title.startsWith('这不是一份备份文件'), true);
});

test('resetDbPage：清空全部状态（含待确认的导入）', async () => {
  const harness = createHarness({ importResponses: [{ error: { code: 'confirmation-required', message: '需确认' } }] });
  await harness.actions.importDbBackup({ text: BACKUP_TEXT, fileName: 'b.json', mode: 'replace' });
  assert.notEqual(harness.state.db.pendingImport, null);
  harness.actions.resetDbPage();
  assert.equal(harness.state.db.phase, 'idle');
  assert.equal(harness.state.db.pendingImport, null);
  assert.equal(harness.state.db.lastImport, null);
});
