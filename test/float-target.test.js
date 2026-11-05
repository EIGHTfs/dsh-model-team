// G6：球内改为「接活平台」头像/首字母牌 + 删群列表头部重复「我」入口。
// 被测代码是渲染层（ui/js/render.js）里的两个纯函数；加载方式同 test/target-source.test.js：
// 执行分片源码 + 最小垫片，不引入 DOM。
// 为什么不用 DOM 测试：仓里唯一的渲染入口是字符串拼接，纯函数断言能精确到"输出里有没有 img / 有没有文本"。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const FORMAT_SOURCE = await fs.readFile(new URL('../ui/js/format/ui-format.js', import.meta.url), 'utf8');
const RENDER_SOURCE = await fs.readFile(new URL('../ui/js/view/render.js', import.meta.url), 'utf8');
const CLIENT_SOURCE = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const FLOAT_SOURCE = await fs.readFile(new URL('../ui/js/float/float.js', import.meta.url), 'utf8');

// 球内标记已搬到 ui-format.js；它调用 render.js 的 renderAvatar（同一 bundle 作用域），
// 单测里按同名垫片注入，保证测的是真实拼装逻辑而不是复制品。
function loadRenderLayer() {
  globalThis.escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  globalThis.renderAvatar = (avatarText, fallbackName) => {
    const rawValue = String(avatarText == null ? '' : avatarText).trim();
    const isImageUrl = /^https?:\/\//i.test(rawValue) || /^data:/i.test(rawValue);
    const initial = String(fallbackName == null ? '' : fallbackName).trim().charAt(0).toUpperCase() || '?';
    if (isImageUrl) return `<img class="avatar-img" src="${globalThis.escapeHtml(rawValue)}" alt="" data-fallback="${initial}">`;
    return globalThis.escapeHtml(rawValue || initial);
  };
  // eslint-disable-next-line no-new-func
  const formatFactory = new Function(`${FORMAT_SOURCE}
;return { renderFloatTargetMarkup: renderFloatTargetMarkup };`);
  // eslint-disable-next-line no-new-func
  const renderFactory = new Function(`${RENDER_SOURCE}
;return { renderGroupList: renderGroupList };`);
  return Object.assign({}, formatFactory(), renderFactory());
}

test('G6-A：有 URL 头像 → 只有 <img>，不出现任何文字（模型名/首字母都不许露出来）', () => {
  const render = loadRenderLayer();

  const markup = render.renderFloatTargetMarkup({ avatar: 'https://cdn.example.com/logo.svg', name: 'Agnes' });

  assert.match(markup, /<img\b/, '有头像时必须渲染 img');
  assert.match(markup, /alt=""/, 'img 的 alt 必须为空，避免读屏重复朗读');
  assert.equal(markup.includes('fb-initial'), false, '有头像时不该出现首字母牌');
  assert.equal(/>[^<]*Agnes/.test(markup), false, '球内不允许出现平台名文字');
  assert.equal(/>[^<]*A</.test(markup), false, '球内不允许出现首字母文字（头像已承载信息）');
});

test('G6-A：无头像 → 首字母圆牌（复用 renderAvatar 的字母逻辑，大写、空名回落 ?）', () => {
  const render = loadRenderLayer();

  const withName = render.renderFloatTargetMarkup({ avatar: '', name: 'agnes' });
  assert.equal(withName.includes('<img'), false, '无头像时不该渲染 img');
  assert.match(withName, /class="fb-initial"/);
  assert.match(withName, />A</, '首字母必须大写（与 renderAvatar 同一份逻辑）');

  // 空名/无平台对象：不能崩，也不能输出空牌（'?' 是 renderAvatar 的既有回落）
  assert.match(render.renderFloatTargetMarkup({ avatar: '', name: '' }), />\?</);
  assert.match(render.renderFloatTargetMarkup(null), />\?</);
});

test('G6-C：球内改标记后 data-fb-target 钩子仍在，且渲染走它（门禁依赖，不许改名）', () => {
  // check-contract 读的是 ui/index.html 里的骨架钩子；产物里也必须保留同一容器
  assert.equal(CLIENT_SOURCE.includes('data-fb-target'), true, '产物骨架必须保留 data-fb-target');
  assert.match(FLOAT_SOURCE, /#floatBall \[data-fb-target\]/, '浮球必须通过这个容器写入标记');
  assert.match(FLOAT_SOURCE, /innerHTML = renderFloatTargetMarkup\(activePlatform\)/);
  // 可访问性：title / aria-label 要写清「目标名 · 平台名」
  assert.match(FLOAT_SOURCE, /setAttribute\(['"]aria-label['"], accessibleLabel\)/);
});

test('G6-B：群列表头部不再有第二个「我」入口（INV-13）', () => {
  const render = loadRenderLayer();

  const listHtml = render.renderGroupList(
    [{ id: 'agnes', name: 'agnes', avatar: '', summary: '官方接入', driverId: 'openai-compatible', lastUpdated: null }],
    'agnes',
    '',
  );

  assert.equal(listHtml.includes('btnMe'), false, '群列表头部不许再有「我」按钮');
  assert.equal(listHtml.includes('👤 我'), false, '群列表头部不许再有「我」文案');
  // 底边栏那个「我」tab 由 ui/index.html 骨架提供，渲染层不重复造
  // 产物里骨架是 JSON 字符串，引号被转义，所以按「data-view 后紧跟 profile」匹配
  assert.match(CLIENT_SOURCE, /data-view=\\?"profile\\?"/, '底边栏「我」入口仍在');
});
