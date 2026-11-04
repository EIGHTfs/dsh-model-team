// G8：好友分组表单（纯函数层 + api 抬错）。
// 为什么单测这些点：① id 派生是唯一一处生成逻辑，撞名/中文名/超长名都只能从这里纠正；
// ② 前端校验必须与后端 normalizeFriendGroup 给出同一条判据，判错就会"界面不让存、接口其实能收"；
// ③ api 层曾经用 apiJson（把 400/409 吞成 null），弹窗里只剩"保存失败"四个字，
//    服务端原文（「分组 x 正被 N 个会话使用」）必须能被抬出来——这条只有拒绝路径能验。
// 加载方式同 test/import-preview.test.js：执行分片源码 + 少量全局垫片。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const RULES_SOURCE = await fs.readFile(new URL('../ui/js/friend-group-form.js', import.meta.url), 'utf8');
const VIEW_SOURCE = await fs.readFile(new URL('../ui/js/friend-group-view.js', import.meta.url), 'utf8');
const API_SOURCE = await fs.readFile(new URL('../lib/client-parts/foundation/api.js', import.meta.url), 'utf8');

function installRenderShims() {
  globalThis.escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // render.js 里的策略中文名；表单复用同一份，测试按同样内容垫上
  globalThis.STRATEGY_LABELS = { 'round-robin': '轮询', fallback: '故障转移' };
}

function loadFormLayer() {
  installRenderShims();
  // 规则层与视图层在构建产物里是同一作用域（build.cjs 顺序拼接），这里照同样方式拼接后执行，
  // 免得测试里造出一套"两个模块互相 import"的假结构。
  const factory = new Function(`${RULES_SOURCE}
${VIEW_SOURCE}
;return {
  deriveFriendGroupId: deriveFriendGroupId,
  validateFriendGroupForm: validateFriendGroupForm,
  normalizeFriendGroupDraft: normalizeFriendGroupDraft,
  renderFriendGroupForm: renderFriendGroupForm,
  FRIEND_GROUP_ID_PATTERN: FRIEND_GROUP_ID_PATTERN,
  FRIEND_GROUP_ID_MAX_LENGTH: FRIEND_GROUP_ID_MAX_LENGTH
};`);
  return factory();
}

// fetch 替身：把 (状态码, JSON 体) 原样交回，apiPostRaw 不看 response.ok、只读 body，
// 与真实 apiJson/apiPostRaw 的差异就在这一点上（这也正是能读到错误体的原因）
function loadApiLayer(responses) {
  globalThis.API_PREFIX = '/_team';
  globalThis.API_TIMEOUT_MS = 8000;
  globalThis.formatTokenCount = (value) => String(value);
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options && options.method, body: options && options.body });
    const canned = responses.shift() || { status: 200, body: {} };
    return { ok: canned.status < 400, status: canned.status, json: async () => canned.body };
  };
  const factory = new Function(`${API_SOURCE}
;return { api: api, apiServerError: apiServerError };`);
  return { ...factory(), calls };
}

test('G8-①：分组名派生 id —— 小写化、非字母数字转连字符、连续连字符合并', () => {
  const form = loadFormLayer();

  assert.equal(form.deriveFriendGroupId('Main Fallback', []), 'main-fallback');
  assert.equal(form.deriveFriendGroupId('GPT 主力 组', []), 'gpt');
  assert.equal(form.deriveFriendGroupId('a  ---  b', []), 'a-b');
  assert.equal(form.deriveFriendGroupId('  Trailing-  ', []), 'trailing');
});

test('G8-②：中文/纯符号名派生不出 id 时兜底 group，结果必须匹配后端正则', () => {
  const form = loadFormLayer();

  const chineseOnly = form.deriveFriendGroupId('主力组', []);
  const symbolsOnly = form.deriveFriendGroupId('***', []);
  assert.equal(chineseOnly, 'group');
  assert.equal(symbolsOnly, 'group');
  assert.match(chineseOnly, form.FRIEND_GROUP_ID_PATTERN, '兜底 id 也要过后端的同一条正则');
});

test('G8-③：与已有 id 撞名时加 -2 / -3，且绝不与已有 id 重复', () => {
  const form = loadFormLayer();

  assert.equal(form.deriveFriendGroupId('main', ['main']), 'main-2');
  assert.equal(form.deriveFriendGroupId('main', ['main', 'main-2']), 'main-3');
  const derived = form.deriveFriendGroupId('main', ['main', 'main-2']);
  assert.equal(['main', 'main-2'].includes(derived), false);
});

test('G8-④：超长分组名截断到 64 字符以内（含撞名后缀），不破后端长度上限', () => {
  const form = loadFormLayer();

  const longName = 'a'.repeat(120);
  const derived = form.deriveFriendGroupId(longName, []);
  assert.equal(derived.length, form.FRIEND_GROUP_ID_MAX_LENGTH);
  const derivedWithSuffix = form.deriveFriendGroupId(longName, [derived]);
  assert.ok(derivedWithSuffix.length <= form.FRIEND_GROUP_ID_MAX_LENGTH, '加后缀后仍不得超长');
  assert.match(derivedWithSuffix, form.FRIEND_GROUP_ID_PATTERN);
});

test('G8-⑤：校验四类必填 —— 名字空 / 成员空 / 策略非法 / id 非法', () => {
  const form = loadFormLayer();
  const validMembers = [{ platformId: 'p1', modelId: 'm1' }];

  const emptyName = form.validateFriendGroupForm({ id: 'ok', name: '   ', strategy: 'round-robin', members: validMembers });
  assert.equal(emptyName.ok, false);
  assert.match(emptyName.errors.name, /分组名不能为空/);

  const emptyMembers = form.validateFriendGroupForm({ id: 'ok', name: '名字', strategy: 'round-robin', members: [] });
  assert.equal(emptyMembers.ok, false);
  assert.match(emptyMembers.errors.members, /至少要有一个成员/);

  const badStrategy = form.validateFriendGroupForm({ id: 'ok', name: '名字', strategy: 'random', members: validMembers });
  assert.equal(badStrategy.ok, false);
  assert.match(badStrategy.errors.strategy, /round-robin/);

  const badId = form.validateFriendGroupForm({ id: '-bad id', name: '名字', strategy: 'round-robin', members: validMembers });
  assert.equal(badId.ok, false);
  assert.match(badId.errors.id, /以字母或数字开头/);
});

test('G8-⑥：合法草稿 ok=true；编辑态不把自己算成 id 冲突', () => {
  const form = loadFormLayer();
  const draft = { id: 'main', name: '主力', strategy: 'fallback', members: [{ platformId: 'p1', modelId: 'm1' }] };

  assert.deepEqual(form.validateFriendGroupForm(draft, { existingIds: [], mode: 'create' }), { ok: true, errors: {} });
  // 编辑同一个分组：existingIds 已排除自己，这里再传一次 self id 也不该报冲突
  assert.equal(form.validateFriendGroupForm(draft, { existingIds: ['main'], mode: 'edit' }).ok, true);
  // 新建时撞上已有 id 必须报出来（否则会覆盖别人的分组）
  assert.match(form.validateFriendGroupForm(draft, { existingIds: ['main'], mode: 'create' }).errors.id, /已被占用/);
});

test('G8-⑦：保存失败把服务端 message/code/hint 抬成 reject（不许吞成 null）', async () => {
  const apiLayer = loadApiLayer([{ status: 400, body: { error: { code: 'invalid-request', message: 'members 必须是非空数组', hint: '至少给一个成员' } } }]);

  await assert.rejects(
    () => apiLayer.api.createFriendGroup({ id: 'x', name: 'n', strategy: 'round-robin', members: [] }),
    (error) => {
      assert.equal(error.message, 'members 必须是非空数组');
      assert.equal(error.code, 'invalid-request');
      assert.equal(error.hint, '至少给一个成员');
      return true;
    },
  );
  assert.equal(apiLayer.calls[0].url, '/_team/friend-groups');
  assert.equal(apiLayer.calls[0].method, 'POST');
});

test('G8-⑧：删除被引用时 reject，message 原文是「正被 N 个会话使用」', async () => {
  const apiLayer = loadApiLayer([{ status: 409, body: { error: { code: 'friend-group-in-use', message: '分组 main 正被 2 个会话使用', hint: '先切换会话目标' } } }]);

  await assert.rejects(
    () => apiLayer.api.deleteFriendGroup('main'),
    (error) => {
      assert.equal(error.code, 'friend-group-in-use');
      assert.match(error.message, /正被 2 个会话使用/);
      return true;
    },
  );
  assert.equal(apiLayer.calls[0].method, 'DELETE', '删除必须走 DELETE，不是 POST');
  assert.equal(apiLayer.calls[0].url, '/_team/friend-groups/main');
});

test('G8-⑨：保存成功返回 { group }；删除成功返回 { removed }', async () => {
  const saveLayer = loadApiLayer([{ status: 201, body: { group: { id: 'main', name: '主力', strategy: 'round-robin', members: [{ platformId: 'p1', modelId: 'm1' }] } } }]);
  const saved = await saveLayer.api.createFriendGroup({ id: 'main', name: '主力', strategy: 'round-robin', members: [{ platformId: 'p1', modelId: 'm1' }] });
  assert.equal(saved.group.id, 'main');

  const removeLayer = loadApiLayer([{ status: 200, body: { removed: 'main' } }]);
  const removed = await removeLayer.api.deleteFriendGroup('main');
  assert.equal(removed.removed, 'main');
});

test('G8-⑩：提交前归一化去空白、按平台::模型去重且保留顺序', () => {
  const form = loadFormLayer();

  const normalized = form.normalizeFriendGroupDraft({
    id: ' main ', name: ' 主力组 ', strategy: 'fallback',
    members: [
      { platformId: 'p1', modelId: 'm1' },
      { platformId: ' p1 ', modelId: ' m1 ' },
      { platformId: 'p2', modelId: 'm2' },
      { platformId: '', modelId: 'm3' },
    ],
  });

  assert.equal(normalized.id, 'main');
  assert.equal(normalized.name, '主力组');
  assert.deepEqual(normalized.members, [{ platformId: 'p1', modelId: 'm1' }, { platformId: 'p2', modelId: 'm2' }]);
});

test('G8-⑪：表单 HTML 含成员行、策略选中、错误文案与服务端失败原文', () => {
  const form = loadFormLayer();

  const html = form.renderFriendGroupForm({
    mode: 'edit',
    groups: [{ id: 'p1', name: 'CodeArts' }],
    modelsByGroupId: { p1: [{ id: 'm1', name: 'm1 显示名' }] },
    modelsStatus: { p1: 'loaded' },
    draft: {
      id: 'main', name: '主力', strategy: 'fallback',
      members: [{ platformId: 'p1', modelId: 'm1' }, { platformId: 'p1', modelId: 'm2' }],
      platformPick: 'p1', modelPick: 'm1',
    },
    errors: { name: '分组名不能为空' },
    formError: '分组 main 正被 2 个会话使用',
    deleteArmed: false,
  });

  assert.match(html, /data-remove-member="0"/, '成员行要能移除');
  assert.match(html, /\[主\]/, 'fallback 组第一名成员标主');
  assert.match(html, /\[备\]/, '其余成员标备');
  assert.match(html, /<option value="fallback" selected>/, '策略下拉选中当前值');
  assert.match(html, /分组名不能为空/, '字段错误要渲染出来');
  assert.match(html, /正被 2 个会话使用/, '服务端失败原文要渲染出来');
  assert.match(html, /id="btnSaveFriendGroup"/);
  assert.match(html, /id="btnDeleteFriendGroup"/, '编辑态才有删除按钮');
  assert.equal(form.renderFriendGroupForm({ mode: 'create', groups: [], draft: { members: [] } }).includes('btnDeleteFriendGroup'), false, '新建态不出现删除');
});
