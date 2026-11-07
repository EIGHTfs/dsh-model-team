// 第 8 步追加：宿主 credentials 服务按需求值（getter），不可用不拖垮插件，后置就绪下次请求即生效。
import test from 'node:test';
import assert from 'node:assert/strict';

import { describeImportSources, importCredential } from '../src/reverse/core/import/index.js';
import { createReverseImportSink } from '../src/reverse/core/import-sink.js';
import { createRecordingLogger, createTempDirectory } from './helpers/test-environment.js';

async function createDeps(t, credentialGetter) {
  const dataRoot = await createTempDirectory(t);
  const logger = createRecordingLogger();
  return { logger, deps: { credentials: credentialGetter, sink: createReverseImportSink({ dataRoot, logger }) } };
}

test('credentials 服务不可用：源标记不可用并给原因，插件与其它源照常', async (t) => {
  const { logger, deps } = await createDeps(t, () => null);

  const descriptions = await describeImportSources({ deps });
  const hostSource = descriptions.find((entry) => entry.id === 'host-credentials');
  assert.equal(hostSource.available, false);
  assert.equal(hostSource.reason, '宿主未提供 credentials 服务或尚未就绪');
  assert.equal(descriptions.find((entry) => entry.id === 'manual').available, true, '其它源不受影响');
  assert.deepEqual(logger.lines.filter((line) => line.level === 'error'), [], '不把"尚未就绪"当错误');
});

test('credentials 后置可用：下一次请求立即变为可用（进程内即时生效）', async (t) => {
  let service = null;
  const { deps } = await createDeps(t, () => service);

  const beforeReady = await describeImportSources({ deps });
  assert.equal(beforeReady.find((entry) => entry.id === 'host-credentials').available, false);

  service = { async resolve(ref) { return { value: JSON.stringify({ accessToken: 'a', machineId: 'm', machineToken: 'mt', machineType: 't', userId: 'u-' + ref }) }; } };

  const afterReady = await describeImportSources({ deps });
  assert.equal(afterReady.find((entry) => entry.id === 'host-credentials').available, true, '同一进程内下一次请求就应生效');

  const result = await importCredential({ platform: 'qoder', sourceId: 'host-credentials', ref: 'main', deps });
  assert.equal(result.outcome, 'imported');
  assert.equal(result.account.userId, 'u-main');
  assert.equal(JSON.stringify(result).includes('accessToken'), false, '回执仍然脱敏');
});

test('getter 抛错：按不可用处理，不把异常抛给调用方', async (t) => {
  const { deps } = await createDeps(t, () => { throw new Error('host not ready'); });

  const descriptions = await describeImportSources({ deps });
  const hostSource = descriptions.find((entry) => entry.id === 'host-credentials');
  assert.equal(hostSource.available, false);
  assert.equal(typeof hostSource.reason, 'string');
});
