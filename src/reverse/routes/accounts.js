// 反代账号列表路由：返回脱敏账号（accountId/userId/nickname/origin/refreshable/updatedAt），绝不含 token。

import { createAccountStore } from '../core/account-store.js';
import { toPublicAccount } from '../core/import-sink.js';
import { getPlatform, listPlatforms } from '../registry.js';
import { ERROR_CODES, GatewayError } from '../../gateway/errors.js';

const HTTP_OK = 200;

export async function handleReverseAccountsRoute(context) {
  const platformId = String(context.query?.platform ?? '').trim();
  if (platformId.length === 0) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, '缺少 platform（例如 ?platform=qoder）');
  }
  if (!getPlatform(platformId)) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, `未知的反代平台：${platformId}`, {
      hint: `可用平台：${listPlatforms().map((item) => item.id).join(' / ')}`,
    });
  }
  const accountStore = createAccountStore({ dataRoot: context.dataRoot, logger: context.logger });
  const accounts = await accountStore.listAccounts(platformId);
  return { status: HTTP_OK, body: accounts.map((account) => toPublicAccount(account)) };
}
