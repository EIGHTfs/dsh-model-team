// forward 双模式用例（docs/15）：模式解析 / 递归守卫 / 降级 / 等价性。
// 约定：全部用假群名与假 provider 名，不依赖本机配置；期望值由输入推导或由导出常量给出。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODE,
  MODE_FORWARD,
  MODE_REWRITE,
  VALID_MODES,
  resolveMode,
} from '../src/plugin/adapter/mode.js';

// 本插件注册的 provider 路由名：用假值，避免与部署侧的 providerIds 绑定
const SELF_PROVIDER_IDS = ['test-team-provider'];
// 目标群声明的外部 provider（宿主侧路由名）：与上面不同名即"不是自己"
const EXTERNAL_PROVIDER = 'test-host-provider';

// 假 logger：只记 warn，用来证明"非法值告警一次"
function createRecordingLogger() {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(String(message)) };
}

test('mode：显式 forward 就用 forward', () => {
  const logger = createRecordingLogger();
  const mode = resolveMode({ group: { id: 'group-a', mode: MODE_FORWARD, provider: EXTERNAL_PROVIDER }, providerIds: SELF_PROVIDER_IDS, logger });
  assert.equal(mode, MODE_FORWARD);
  assert.equal(logger.warnings.length, 0, '合法值不该告警');
});

test('mode：显式 rewrite 就用 rewrite', () => {
  const logger = createRecordingLogger();
  const mode = resolveMode({ group: { id: 'group-a', mode: MODE_REWRITE, provider: EXTERNAL_PROVIDER }, providerIds: SELF_PROVIDER_IDS, logger });
  assert.equal(mode, MODE_REWRITE);
  assert.equal(logger.warnings.length, 0);
});

test('mode：未声明 → 默认值（forward）', () => {
  const logger = createRecordingLogger();
  const mode = resolveMode({ group: { id: 'group-a', provider: EXTERNAL_PROVIDER }, providerIds: SELF_PROVIDER_IDS, logger });
  assert.equal(mode, DEFAULT_MODE);
  assert.equal(mode, MODE_FORWARD, 'docs/15 规定默认是 forward');
  assert.equal(logger.warnings.length, 0, '未声明是合法状态，不该告警');
});

test('mode：非法值 → 告警一次并回退默认（不静默当 rewrite）', () => {
  const logger = createRecordingLogger();
  const illegalValue = 'forwrad'; // 故意拼错，模拟手写配置
  const mode = resolveMode({ group: { id: 'group-a', mode: illegalValue }, providerIds: SELF_PROVIDER_IDS, logger });

  assert.equal(mode, DEFAULT_MODE);
  assert.notEqual(mode, MODE_REWRITE, '非法值不得被当成 rewrite');
  assert.equal(logger.warnings.length, 1, '一次解析只告警一次');
  assert.equal(logger.warnings[0].includes(JSON.stringify(illegalValue)), true, '告警要带上非法值本身');
  assert.equal(VALID_MODES.includes(illegalValue), false);
});

test('mode：递归守卫——目标 provider 是自己时强制 rewrite（即使显式写了 forward）', () => {
  const logger = createRecordingLogger();
  const mode = resolveMode({
    group: { id: 'group-a', mode: MODE_FORWARD, provider: SELF_PROVIDER_IDS[0] },
    providerIds: SELF_PROVIDER_IDS,
    logger,
  });
  assert.equal(mode, MODE_REWRITE, '转发给自己必然打转，必须降回 rewrite');
  assert.equal(logger.warnings.length, 0, '守卫是正常判定，不是配置错误');
});
