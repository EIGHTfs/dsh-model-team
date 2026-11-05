// G22：通讯录（好友分组）成员行头像恒显示 [?]。
// 为什么值得单测：成员头像取的是「成员所属群的头像」，而旧代码拿 member.platformId 去查
// driverById（键是驱动 id，如 openai-compatible），永远查不到；又读了后端并不存在的
// member.platformAvatar，两层都落空 → 每行都渲染字面量 [?]。这类缺陷接口全绿、页面不报错，
// 只有盯着渲染结果才看得见，所以把「输出里不许出现 [?]」钉成断言。
// 加载方式同 test/float-target.test.js：执行 ui/js/render.js 源码 + 最小垫片，不起 DOM。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const RENDER_SOURCE = await fs.readFile(new URL('../ui/js/view/render.js', import.meta.url), 'utf8');

function loadRenderLayer() {
  globalThis.escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${RENDER_SOURCE}
;return { renderAddressBook: renderAddressBook };`);
  return factory();
}

// 一平台群 + 一个引用它的好友分组：群头像给 URL，便于断言「真的用了群头像」
function buildAddressBookFixture() {
  const groups = [
    { id: 'p-alpha', name: 'Alpha 平台', avatar: 'https://cdn.example.com/alpha.png', driver: 'openai-compatible' },
    { id: 'p-beta', name: 'Beta 平台', avatar: '贝', driver: 'openai-compatible' },
  ];
  const friendGroups = [
    {
      id: 'main-fallback',
      name: '主力轮换组',
      strategy: 'fallback',
      members: [
        { platformId: 'p-alpha', modelId: 'alpha-1' },
        { platformId: 'p-beta', modelId: 'beta-1' },
      ],
    },
  ];
  // 不再需要 drivers：成员头像取的是群头像，与驱动无关（旧实现按驱动查才渲染出 [?]）
  return { groups, friendGroups };
}

test('G22-①：通讯录成员头像用所属群的头像，不得出现 [?]', () => {
  const render = loadRenderLayer();
  const fixture = buildAddressBookFixture();

  const html = render.renderAddressBook(fixture.friendGroups, fixture.groups);

  assert.equal(html.includes('[?]'), false, '成员行不能出现 [?]（platformId 是群 id，拿去查 driverId 永远查不到）');
  assert.match(html, /<img class="avatar-img" src="https:\/\/cdn\.example\.com\/alpha\.png"/, '群头像为 URL 时应渲染成 img.avatar-img');
  assert.match(html, /<span class="avatar">贝<\/span>/, '群头像是文字时直接用它');
  assert.match(html, /alpha-1/, '成员模型名照旧显示');
  assert.match(html, /\(来自 Alpha 平台\)/, '平台名来自群名');
});

test('G22-②：成员指向不存在的群时兜底是首字母，不是 [?]', () => {
  const render = loadRenderLayer();
  const fixture = buildAddressBookFixture();
  fixture.friendGroups = [{
    id: 'ghost-group',
    name: '幽灵成员组',
    strategy: 'round-robin',
    members: [{ platformId: 'ghost-platform', modelId: 'ghost-1' }],
  }];

  const html = render.renderAddressBook(fixture.friendGroups, fixture.groups);

  assert.equal(html.includes('[?]'), false, '群不存在也不能退回 [?]');
  assert.match(html, /<span class="avatar">G<\/span>/, '兜底应是 platformId 的首字母（大写）');
  assert.match(html, /\(来自 ghost-platform\)/, '平台名缺失时回落成 platformId');
});
