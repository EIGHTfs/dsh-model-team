// 导入落盘适配器：把通用的「导入一次凭据」落到反代账号存储（account-store）。
//
// 为什么单独一个文件：导入框架本身与平台无关（src/gateway/credential-import/），
// 但"账号文件长什么样、哪些字段算 token、已存在自己登录的账号要不要让路"是反代这边的语义。
// 这条边界让框架可以复用到别的凭据类型，也避免框架里出现 reverse 字样。
//
// 三条语义：
//   1. 导入来的账号标 origin='import:<sourceId>'、refreshable=false（M4 的续期调度必须跳过它）；
//   2. 同一 userId / 同一 originRef 重复导入 = 更新；
//   3. 已存在 refreshable=true（自己登录的）账号 → 导入不覆盖，返回 skipped + 原因。

import { createAccountStore } from './account-store.js';

// 对外账号视图：**永不包含 token**（access/refresh/machine token 一律不出现）
export function toPublicAccount(writeResult) {
  const credential = writeResult.credential ?? {};
  return {
    accountId: writeResult.accountId,
    userId: credential.userId ?? null,
    nickname: credential.nickname ?? null,
    machineId: credential.machineId ?? null,
    machineType: credential.machineType ?? null,
    origin: credential.origin ?? null,
    refreshable: credential.refreshable !== false,
    updatedAt: credential.updatedAt ?? null,
  };
}

export function createReverseImportSink({ dataRoot, logger } = {}) {
  const accountStore = createAccountStore({ dataRoot, logger });

  return {
    accountStore,
    // 供登录流程复用同一份 store（避免两处各建一个实例）
    async upsertImported({ platform, credential, origin, originRef }) {
      const writeResult = await accountStore.upsertByUserId(platform, {
        ...credential,
        origin,
        originRef,
        refreshable: false,
      }, { skipRefreshable: true });

      const outcome = writeResult.skipped ? 'skipped' : writeResult.created ? 'imported' : 'updated';
      return {
        outcome,
        ...(writeResult.reason ? { reason: writeResult.reason } : {}),
        account: toPublicAccount(writeResult),
      };
    },
  };
}
