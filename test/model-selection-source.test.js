// 投影入口适配层：五个通道各一条 + 优先级 + 全缺失返回 null。
//
// 为什么单独测这一层：它是"宿主换版本时唯一要改的地方"（真机实测 0.2.2 里
// session.projections.faceOf 已不存在，但重构前的老路径能取到值），
// 通道探测错一次就会让悬浮球永久隐藏，所以每条通道都要有独立用例钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const SOURCE_LAYER = await fs.readFile(new URL('../ui/js/interaction/model-selection-source.js', import.meta.url), 'utf8');

function loadAdapter() {
  // 分片是普通脚本（无 import）：给它最小 console 垫片后取函数
  return new Function('console', `${SOURCE_LAYER}
;return { resolveModelSelectionSource, MODEL_SELECTION_KEY };`)({ info() {}, warn() {} });
}

const adapter = loadAdapter();
const OURS = { next: { provider: 'dsh-model-team', model: 'dsh-model-team' }, lastUsed: null };

function createFace(initialValue) {
  let current = initialValue;
  const listeners = new Set();
  return {
    getSnapshot: () => current,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    push(nextValue) { current = nextValue; listeners.forEach((listener) => listener()); },
  };
}

test('通道①：props.useProjection 返回 face（有 getSnapshot/subscribe）', () => {
  const face = createFace(OURS);
  const source = adapter.resolveModelSelectionSource({ useProjection: () => face });
  assert.equal(source.channel, 'useProjection-face');
  assert.deepEqual(source.getSnapshot(), OURS);

  let notified = 0;
  const unsubscribe = source.subscribe(() => { notified += 1; });
  face.push({ next: { provider: 'other', model: 'other-model' } });
  assert.equal(notified, 1, '订阅回调必须被触发');
  unsubscribe();
  face.push({ next: null });
  assert.equal(notified, 1, '退订后不再回调');
});

test('通道①降级形：useProjection 返回的是值而不是 face', () => {
  const source = adapter.resolveModelSelectionSource({ useProjection: () => OURS });
  assert.equal(source.channel, 'useProjection-value');
  assert.deepEqual(source.getSnapshot(), OURS);
  const unsubscribe = source.subscribe(() => {});
  assert.equal(typeof unsubscribe, 'function', '值通道也要给 noop 退订（调用方不必分支）');
});

test('通道②：props.session.projections.faceOf(modelSelection)', () => {
  const face = createFace(OURS);
  const source = adapter.resolveModelSelectionSource({
    session: { projections: { faceOf: (key) => (key === adapter.MODEL_SELECTION_KEY ? face : null) } },
  });
  assert.equal(source.channel, 'session-face');
  assert.deepEqual(source.getSnapshot(), OURS);
});

test('通道③：props.modelSelection 直接是值', () => {
  const source = adapter.resolveModelSelectionSource({ modelSelection: OURS });
  assert.equal(source.channel, 'props-value');
  assert.deepEqual(source.getSnapshot(), OURS);
});

test('通道④：值裹在 session.getSnapshot() 里', () => {
  const source = adapter.resolveModelSelectionSource({
    session: { getSnapshot: () => ({ modelSelection: OURS, sessionId: 'session-1' }) },
  });
  assert.equal(source.channel, 'session-snapshot');
  assert.deepEqual(source.getSnapshot(), OURS);
});

test('通道⑤：一条都不通 → 返回 null（调用方按 degraded 处理，不猜）', () => {
  assert.equal(adapter.resolveModelSelectionSource({}), null);
  assert.equal(adapter.resolveModelSelectionSource({ session: {} }), null);
  assert.equal(adapter.resolveModelSelectionSource({ session: { projections: {} } }), null);
  assert.equal(adapter.resolveModelSelectionSource(null), null);
  assert.equal(adapter.resolveModelSelectionSource(undefined), null);
});

test('优先级：useProjection 存在时不再看 session.projections', () => {
  const projectionFace = createFace('from-useProjection');
  const sessionFace = createFace('from-session');
  const source = adapter.resolveModelSelectionSource({
    useProjection: () => projectionFace,
    session: { projections: { faceOf: () => sessionFace } },
  });
  assert.equal(source.channel, 'useProjection-face');
  assert.equal(source.getSnapshot(), 'from-useProjection');
});

test('优先级：没有 useProjection 时，session face 优先于 props 直传值', () => {
  const sessionFace = createFace('from-session');
  const source = adapter.resolveModelSelectionSource({
    modelSelection: 'from-props',
    session: { projections: { faceOf: () => sessionFace } },
  });
  assert.equal(source.channel, 'session-face');
  assert.equal(source.getSnapshot(), 'from-session');
});

test('容错：useProjection 抛错 / face 取值抛错都不炸（退到下一条通道或返回 null）', () => {
  const source = adapter.resolveModelSelectionSource({
    useProjection: () => { throw new Error('hook shape changed'); },
    modelSelection: OURS,
  });
  assert.equal(source.channel, 'props-value', 'useProjection 抛错后退到 props 直传');

  const brokenFace = { getSnapshot: () => { throw new Error('boom'); }, subscribe: () => () => {} };
  const brokenSource = adapter.resolveModelSelectionSource({ useProjection: () => brokenFace });
  assert.equal(brokenSource.channel, 'useProjection-face');
  assert.equal(brokenSource.getSnapshot(), undefined, '取值抛错返回 undefined，不把异常抛给判定');
});
