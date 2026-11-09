// 头像四级回退（docs/03 §10.4.1 / docs/04 §二点五）：实现只有一处（ui/js/format/avatar-chain.js）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const SOURCE = await fs.readFile(new URL('../ui/js/format/avatar-chain.js', import.meta.url), 'utf8');

function loadAvatarChain() {
  return new Function(`${SOURCE}
;return { buildAvatarView, nextAvatarView, avatarInitial, isAvatarImageValue };`)();
}

const chain = loadAvatarChain();

test('① 在线/内联图片：直接给 <img> 要用的 src，其余候选留在 rest 里', () => {
  const view = chain.buildAvatarView(['https://cdn.example.com/logo.svg', 'Q'], 'Qoder');
  assert.equal(view.kind, 'image');
  assert.equal(view.src, 'https://cdn.example.com/logo.svg');
  assert.deepEqual(view.rest, ['Q'], '后面的候选要保留，失败时继续试');
  assert.equal(view.fallbackText, 'Q');
});

test('② 多个图片候选：第一个先赢，其余按顺序排队', () => {
  const view = chain.buildAvatarView(['data:image/svg+xml;base64,AAA', 'https://cdn.example.com/x.png'], 'Agnes');
  assert.equal(view.kind, 'image');
  assert.equal(view.src, 'data:image/svg+xml;base64,AAA');

  const afterFirstFails = chain.nextAvatarView(view.rest, view.fallbackText);
  assert.equal(afterFirstFails.kind, 'image');
  assert.equal(afterFirstFails.src, 'https://cdn.example.com/x.png');
  assert.deepEqual(afterFirstFails.rest, [], '最后一个图片失败后不该再有图片候选');
});

test('③ 文本候选（1~2 字符）：渲染文本，不再尝试图片', () => {
  const view = chain.buildAvatarView(['Q'], 'Qoder');
  assert.equal(view.kind, 'text');
  assert.equal(view.text, 'Q');

  const longText = chain.buildAvatarView(['ABCDEF'], 'X');
  assert.equal(longText.text, 'AB', '文本候选最多保留 2 个字符');
});

test('④ 都没有：名称首字符大写，名称也没有就是 ?', () => {
  assert.equal(chain.buildAvatarView([], 'qoder').text, 'Q');
  assert.equal(chain.buildAvatarView(undefined, 'agnes').text, 'A');
  assert.equal(chain.buildAvatarView([], '').text, '?');
  assert.equal(chain.buildAvatarView(['', '   '], null).text, '?');
});

test('图片全失败 → 落到文本候选；文本也没有 → 落到首字符', () => {
  const withText = chain.buildAvatarView(['https://a/x.png', 'Q'], 'Qoder');
  const afterImageFails = chain.nextAvatarView(withText.rest, withText.fallbackText);
  assert.equal(afterImageFails.kind, 'text');
  assert.equal(afterImageFails.text, 'Q');

  const imageOnly = chain.buildAvatarView(['https://a/x.png'], 'qoder');
  const afterAllFail = chain.nextAvatarView(imageOnly.rest, imageOnly.fallbackText);
  assert.equal(afterAllFail.kind, 'text');
  assert.equal(afterAllFail.text, 'Q', '全部失败必须落到首字符，不留空白');
});

test('去重与去空：重复候选只保留一次，空白候选忽略', () => {
  const view = chain.buildAvatarView(['  https://a/x.png  ', 'https://a/x.png', '', null, 'A'], 'Name');
  assert.equal(view.src, 'https://a/x.png');
  assert.deepEqual(view.rest, ['A'], '重复项与空项都要剔除');
});

test('单个字符串也当候选数组用（兼容旧调用点传 avatar 字符串）', () => {
  assert.equal(chain.buildAvatarView('https://a/x.png', 'X').kind, 'image');
  assert.equal(chain.buildAvatarView('Q', 'X').text, 'Q');
});

test('首字符工具：去空白、大写、空则 ?', () => {
  assert.equal(chain.avatarInitial('  agnes '), 'A');
  assert.equal(chain.avatarInitial(undefined), '?');
  assert.equal(chain.isAvatarImageValue('data:image/png;base64,AA'), true);
  assert.equal(chain.isAvatarImageValue('/assets/x.svg'), false, '相对路径不是图片值（服务端已转 data:）');
});
