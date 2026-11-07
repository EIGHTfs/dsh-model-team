// 加群页账号区的界面约束（docs/17 §三 禁止项）——纯字符串层，不起 DOM。
// 运行时行为（点一次开窗、10 次轮询不重建、提交载荷）在 minihost+preview 里验。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const RENDER_SOURCE = await fs.readFile(new URL('../ui/js/view/reverse-account.js', import.meta.url), 'utf8');

function loadRenderLayer() {
  globalThis.escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return new Function(`${RENDER_SOURCE}
;return { renderReverseAccountsInner, renderReverseAccountPanel, reverseSubmitDisabledAttr, renderReverseSubmitNote };`)();
}

const DRIVER = Object.freeze({ id: 'reverse-qoder', name: 'Qoder', authKind: 'reverse-account', platformId: 'qoder' });

test('账号区有独立容器标记（轮询只重绘它，不整页重建）', () => {
  const html = loadRenderLayer().renderReverseAccountPanel(DRIVER, { accounts: [], login: null });
  assert.equal(html.includes('data-reverse-accounts'), true);
  assert.equal(html.includes('data-platform-id="qoder"'), true);
});

test('五态文案与按钮禁用规则（照 docs/17 §二/§五）', () => {
  const layer = loadRenderLayer();
  const idle = layer.renderReverseAccountsInner(DRIVER, { accounts: [], login: null });
  assert.equal(idle.includes('登录 Qoder'), true);
  assert.equal(idle.includes('（尚无账号）'), true);

  const starting = layer.renderReverseAccountsInner(DRIVER, { accounts: [], login: { state: 'starting' } });
  assert.match(starting, /id="btnReverseLogin"[^>]*disabled/);
  assert.equal(starting.includes('正在打开授权页…'), true);

  const waiting = layer.renderReverseAccountsInner(DRIVER, { accounts: [], login: { state: 'waiting', loginUrl: 'https://example.com/a' } });
  // 第 9 步起 waiting 不禁用：点它是"重新打开同一个授权页"（不新建会话）
  assert.equal(/id="btnReverseLogin"[^>]*disabled/.test(waiting), false);
  assert.equal(waiting.includes('重新打开 Qoder 授权页'), true);
  assert.equal(waiting.includes('等待授权…（浏览器里完成登录后会自动刷新）'), true);

  const granted = layer.renderReverseAccountsInner(DRIVER, { accounts: [{ accountId: 'a1', nickname: '账号一', origin: 'login' }], selectedAccountId: 'a1', login: { state: 'granted', accountLabel: '账号一' } });
  assert.equal(granted.includes('已登录：账号一'), true);
  assert.match(granted, /value="a1" selected/);

  const failed = layer.renderReverseAccountsInner(DRIVER, { accounts: [], login: { state: 'failed', errorText: '授权页已关闭' } });
  assert.equal(failed.includes('授权页已关闭'), true);
});

test('禁止项：界面不出现「导入」入口，也不出现命令行提示', () => {
  const layer = loadRenderLayer();
  const states = [null, { state: 'starting' }, { state: 'waiting', loginUrl: 'https://e/a' }, { state: 'granted', accountLabel: 'x' }, { state: 'failed', errorText: '授权已超时，请重新登录' }];
  for (const login of states) {
    const html = layer.renderReverseAccountsInner(DRIVER, { accounts: [], login });
    assert.equal(html.includes('导入'), false, `状态 ${login && login.state} 出现了「导入」`);
    assert.equal(html.includes('node scripts'), false);
    assert.equal(html.includes('btnReverseImport'), false);
  }
});

test('弹窗被拦：只有兜底链接，没有让用户点第二次的主按钮', () => {
  const layer = loadRenderLayer();
  const blocked = layer.renderReverseAccountsInner(DRIVER, { accounts: [], login: { state: 'waiting', blocked: true, loginUrl: 'https://e/a' } });
  assert.equal(blocked.includes('浏览器拦截了弹窗，点这里打开授权页'), true);
  assert.equal(/>打开授权页</.test(blocked), false, '「打开授权页」不得成为按钮文案');
});

test('提交按钮禁用与说明文案：无账号禁用并提示先登录', () => {
  const layer = loadRenderLayer();
  assert.equal(layer.reverseSubmitDisabledAttr(DRIVER, { accounts: [] }), ' disabled');
  assert.equal(layer.reverseSubmitDisabledAttr(DRIVER, { accounts: [{ accountId: 'a1' }] }), '');
  assert.equal(layer.renderReverseSubmitNote(DRIVER, { accounts: [] }).includes('尚未登录 Qoder，请先点「登录 Qoder」'), true);
});
