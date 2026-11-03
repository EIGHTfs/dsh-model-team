// 插件注册用例：重启幂等、加载失败不拖垮宿主、apply 不返回对象（Invalid effect 防护）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, loadLlmModule, registerAdapterIdempotent } from '../src/plugin/index.js';
import * as pluginModule from '../src/plugin/index.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

// 结构断言：cordis 读的是模块导出面，不是 apply 的参数。
// 这条用例的价值就在"单测用假 ctx 测不出真机装配问题"——真机先报 cannot get property "llm"
// without inject（缺 inject），再报同一句（export default 把命名导出吃掉了）。
test('模块导出面：必须模块级导出 inject=[llm] 与 name（真机注入约定）', () => {
  assert.equal(Array.isArray(pluginModule.inject), true, 'inject 必须以数组形式模块级导出');
  assert.equal(pluginModule.inject.includes('llm'), true, '访问 ctx.llm 前必须先声明注入');
  assert.deepEqual(pluginModule.inject, ['llm'], '本插件只访问 llm 一个服务，多声明会拖慢激活');
  assert.equal(pluginModule.name, 'dsh-model-team', 'name 要与 package.json 的包名一致');
  assert.equal(typeof pluginModule.apply, 'function', 'cordis 调用的入口必须导出 apply');
});

// 回归守卫：DSH boot 用 `module.default || module` 取模块（packages/boot/app-boot/lib/index.js:162），
// 一旦重新加回 export default，命名空间的 inject / name 会被 `||` 吃掉 → 真机装配失败。
test('模块导出面：绝不能有 default 导出（否则 inject/name 被 module.default || module 吃掉）', () => {
  assert.equal(pluginModule.default, undefined, '存在 default 会顶掉命名空间，inject 立即失效');
  assert.equal(Object.keys(pluginModule).includes('default'), false, '导出键里也不该出现 default');
  // 反向确认命名导出确实在同一命名空间里（否则本用例无意义）
  assert.equal(typeof pluginModule.apply, 'function');
  assert.equal(Array.isArray(pluginModule.inject), true);
});

// 桩 LlmAdapter：只提供 apply 需要的两个导出
class StubLlmAdapter {}

// 桩 LlmError
class StubLlmError extends Error {}

// 假 ctx.llm：记录注册调用，可配置抛什么错
function createFakeLlmService({ throwOnRegister } = {}) {
  const registrations = [];
  return {
    registrations,
    registerAdapter(providerIds, adapter) {
      if (throwOnRegister) {
        throw throwOnRegister;
      }
      registrations.push({ providerIds, adapter });
    },
  };
}

test('注册幂等：首次注册成功，重复注册（already declared）视为等价跳过', () => {
  const logger = createRecordingLogger();
  const llmService = createFakeLlmService();

  const firstResult = registerAdapterIdempotent(llmService, ['dsh-model-team'], {}, { logger });
  assert.deepEqual(firstResult, { registered: true, skipped: false });

  const duplicateLlmService = createFakeLlmService({
    throwOnRegister: new Error("an adapter for provider 'dsh-model-team' is already declared"),
  });
  const duplicateResult = registerAdapterIdempotent(duplicateLlmService, ['dsh-model-team'], {}, { logger });

  assert.deepEqual(duplicateResult, { registered: false, skipped: true });
  assert.equal(logger.hasLine('warn', '视为等价跳过'), true);
});

test('注册幂等：非重复类错误必须抛出（不能吞配置错）', () => {
  const failingLlmService = createFakeLlmService({ throwOnRegister: new Error('registerAdapter 不在可用状态') });

  assert.throws(
    () => registerAdapterIdempotent(failingLlmService, ['dsh-model-team'], {}, { logger: createRecordingLogger() }),
    /不在可用状态/,
  );
});

test('注册幂等：宿主没提供 registerAdapter 时报明确 TypeError', () => {
  assert.throws(
    () => registerAdapterIdempotent({}, ['dsh-model-team'], {}, { logger: createRecordingLogger() }),
    TypeError,
  );
});

test('apply：注入 llmModule 时注册适配器，且不返回对象（Invalid effect 防护）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const llmService = createFakeLlmService();
  const logger = createRecordingLogger();

  const applyResult = await apply(
    { llm: llmService },
    {
      llmModule: { LlmAdapter: StubLlmAdapter, LlmError: StubLlmError },
      dataRoot,
      logger,
    },
  );

  assert.equal(applyResult, undefined, 'apply 不能返回对象字面量');
  assert.equal(llmService.registrations.length, 1);
  assert.deepEqual(llmService.registrations[0].providerIds, ['dsh-model-team']);

  const registeredAdapter = llmService.registrations[0].adapter;
  assert.equal(registeredAdapter instanceof StubLlmAdapter, true, '实例必须继承注入的基类');
  assert.equal((await registeredAdapter.listModels('dsh-model-team')).length, 1);
  assert.equal(logger.hasLine('info', '已注册模型路由适配器'), true);
});

test('apply：dsh-llm 加载失败 → 只打 error 不注册，且不抛（不拖垮宿主）', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const llmService = createFakeLlmService();
  const logger = createRecordingLogger();

  const applyResult = await apply(
    { llm: llmService },
    {
      dataRoot,
      logger,
      environment: { DSH_MODEL_TEAM_LLM_SPECIFIER: 'file:///definitely/not/exist.js' },
    },
  );

  assert.equal(applyResult, undefined);
  assert.equal(llmService.registrations.length, 0, '加载失败不能注册半成品');
  assert.equal(logger.hasLine('error', '无法加载'), true);
});

test('apply：模块缺 LlmAdapter/LlmError 导出 → 报错不注册', async (t) => {
  const dataRoot = await createTempDirectory(t);
  const llmService = createFakeLlmService();
  const logger = createRecordingLogger();

  await apply({ llm: llmService }, { llmModule: { somethingElse: true }, dataRoot, logger });

  assert.equal(llmService.registrations.length, 0);
  assert.equal(logger.hasLine('error', '没有导出 LlmAdapter/LlmError'), true);
});

test('loadLlmModule：优先级 注入 > env specifier > 缺省包名', async () => {
  const injected = await loadLlmModule({ llmModule: { marker: 'injected' } });
  assert.equal(injected.specifier, 'injected');
  assert.deepEqual(injected.module, { marker: 'injected' });

  const requestedSpecifiers = [];
  const fromEnv = await loadLlmModule({
    environment: { DSH_MODEL_TEAM_LLM_SPECIFIER: 'file:///tmp/custom-llm.js' },
    importer: async (specifier) => {
      requestedSpecifiers.push(specifier);
      return { marker: 'env' };
    },
  });
  assert.equal(fromEnv.specifier, 'file:///tmp/custom-llm.js');
  assert.deepEqual(requestedSpecifiers, ['file:///tmp/custom-llm.js']);

  const fromDefault = await loadLlmModule({
    environment: {},
    importer: async (specifier) => {
      requestedSpecifiers.push(specifier);
      return { marker: 'default' };
    },
  });
  assert.equal(fromDefault.specifier, '@deepseek-ai/dsh-llm');
  assert.deepEqual(requestedSpecifiers, ['file:///tmp/custom-llm.js', '@deepseek-ai/dsh-llm']);
});
