// 反代凭据导入端点：列出可用来源 + 执行一次导入。
//
// 两个端点都走同一套"来源注册表 + account-store"：源可插拔，平台名只来自调用方参数，
// 回执**永不包含 token**（account 视图由 import/index.js 的 toPublicAccount 统一脱敏）。

import { describeImportSources, importCredential } from '../core/import/index.js';
import { createReverseImportSink } from '../core/import-sink.js';
import { ERROR_CODES, GatewayError } from '../../gateway/errors.js';

const HTTP_OK = 200;

// 导入相关的失败一律按 400 上抛（来源不存在 / 来源不可用 / 凭据字段不合法），不是服务端故障
function toImportGatewayError(error) {
  if (error instanceof GatewayError) return error;
  return new GatewayError(ERROR_CODES.INVALID_REQUEST, error?.message ?? String(error), {
    hint: '检查 sourceId 是否存在、该来源是否可用，以及凭据字段是否齐全',
  });
}

export async function handleReverseImportSourcesRoute(context) {
  const sink = createReverseImportSink({ dataRoot: context.dataRoot, logger: context.logger });
  const sources = await describeImportSources({
    deps: { credentials: context.credentials, sink },
  });
  return { status: HTTP_OK, body: sources };
}

export async function handleReverseImportRoute(context) {
  const body = context.body ?? {};
  const sink = createReverseImportSink({ dataRoot: context.dataRoot, logger: context.logger });
  try {
    const result = await importCredential({
      platform: body.platform,
      sourceId: body.sourceId,
      ref: body.ref,
      deps: { credentials: context.credentials, sink },
    });
    return { status: HTTP_OK, body: result };
  } catch (importError) {
    throw toImportGatewayError(importError);
  }
}
