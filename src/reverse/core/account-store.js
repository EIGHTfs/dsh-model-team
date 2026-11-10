// 反代账号的落盘存储（平台无关：本文件不出现任何平台名）。
//
// 为什么单独成文件：凭据是「一条账号链路」的实体，登录（login-session）、续期（M4）、
// 驱动（M3）都要读写它；三处各写一遍必然在字段名与权限上漂移。
//
// 三条硬约束：
//   1) 权限 0600：账号文件里有 token，同机其它用户不该能读；
//   2) 原子写：临时文件 + rename，崩溃/断电不留半截文件；
//   3) 判重键是 `userId`（服务端下发的稳定字段）—— `machineId` / `machineType` / `accessToken`
//      都不参与判重（铁律 4）：换台设备、续一次期都不该变成"新账号"。

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultLogger, describeFailure } from '../../gateway/logger.js';

export const ACCOUNT_DIRECTORY_NAME = 'reverse';
export const ACCOUNT_FILE_MODE = 0o600;
const ACCOUNT_FILE_EXTENSION = '.json';
// 与账号文件同目录、但**不是账号**的文件（都是我们自己的附属数据）：
//   <accountId>.state.json  账号健康状态（account-health.js 写）
//   catalog.json            平台模型目录缓存（platforms/<id>/catalog.js 写）
// 它们同样以 .json 结尾，不排除就会被当成账号读出（accountId="….state"/"catalog"、nickname=null）。
const NON_ACCOUNT_FILE_SUFFIXES = Object.freeze(['.state.json']);
const NON_ACCOUNT_FILE_NAMES = Object.freeze(['catalog.json']);

// 凭据字段白名单：落盘只写这些键，避免把调试用的临时字段一起存进去
const CREDENTIAL_FIELDS = Object.freeze([
  'accessToken',
  'refreshToken',
  'expiresAt',
  'userId',
  'nickname',
  'machineId',
  'machineType',
  'machineToken',
  'domain',
  // 来源与可续期标记：导入来的账号标 origin=import:<sourceId>、refreshable=false
  // （M4 的续期调度必须跳过 refreshable=false 的账号；导入不接管续期）
  'origin',
  'originRef',
  'refreshable',
]);

export function accountDirectoryFor({ dataRoot, platformId }) {
  return path.join(dataRoot, ACCOUNT_DIRECTORY_NAME, platformId);
}

export function accountFilePathFor({ dataRoot, platformId, accountId }) {
  return path.join(accountDirectoryFor({ dataRoot, platformId }), `${accountId}${ACCOUNT_FILE_EXTENSION}`);
}

// 只保留白名单字段，并丢掉空值（空串与 undefined 都不落盘，读侧按缺失处理）
function normalizeCredential(credential, nowIso) {
  const normalized = {};
  for (const fieldName of CREDENTIAL_FIELDS) {
    const fieldValue = credential?.[fieldName];
    if (typeof fieldValue === 'string' && fieldValue.trim().length > 0) {
      normalized[fieldName] = fieldValue;
    } else if (typeof fieldValue === 'number' && Number.isFinite(fieldValue)) {
      // expiresAt 允许是毫秒时间戳；读不到就不写（铁律 9：未知不编造）
      normalized[fieldName] = fieldValue;
    } else if (typeof fieldValue === 'boolean') {
      normalized[fieldName] = fieldValue;
    }
  }
  normalized.updatedAt = nowIso;
  return normalized;
}

export function createAccountStore({ dataRoot, logger = defaultLogger, now = () => Date.now() } = {}) {
  let warnedMissingUserId = false;

  async function readAccountFile(platformId, accountId) {
    const filePath = accountFilePathFor({ dataRoot, platformId, accountId });
    try {
      const rawText = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(rawText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new TypeError('账号文件结构不是对象');
      }
      return { accountId, filePath, credential: parsed };
    } catch (readError) {
      if (readError?.code === 'ENOENT') return null;
      // 损坏按「未登录」处理：删掉用户的密钥来"修复"是更糟的选择
      logger.warn(`账号文件不可用（按未登录处理）：${filePath}（${describeFailure(readError)}）`);
      return null;
    }
  }

  async function listAccounts(platformId) {
    const directory = accountDirectoryFor({ dataRoot, platformId });
    let fileNames = [];
    try {
      fileNames = await fs.readdir(directory);
    } catch {
      return [];
    }
    const accounts = [];
    const accountFileNames = fileNames.filter((name) => name.endsWith(ACCOUNT_FILE_EXTENSION)
      && !NON_ACCOUNT_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))
      && !NON_ACCOUNT_FILE_NAMES.includes(name));
    for (const fileName of accountFileNames) {
      const account = await readAccountFile(platformId, fileName.slice(0, -ACCOUNT_FILE_EXTENSION.length));
      if (account) accounts.push(account);
    }
    return accounts;
  }

  async function writeAccountFile({ platformId, accountId, credential }) {
    const filePath = accountFilePathFor({ dataRoot, platformId, accountId });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(credential, null, 2)}\n`, { encoding: 'utf8', mode: ACCOUNT_FILE_MODE });
      // rename 是原子的：要么看到旧文件、要么看到完整新文件，不会读到半份
      await fs.rename(temporaryPath, filePath);
      // writeFile 的 mode 只在新建时生效；覆盖已有文件要显式收紧
      await fs.chmod(filePath, ACCOUNT_FILE_MODE);
    } catch (writeError) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw writeError;
    }
    return filePath;
  }

  return {
    listAccounts,

    // 唯一入库入口：按 userId 判重（同一账号二次登录 = 更新，不新增）
    // options.skipRefreshable：导入场景用——已存在自己登录的账号（refreshable !== false）时不覆盖
    async upsertByUserId(platformId, credential, options = {}) {
      const normalized = normalizeCredential(credential, new Date(now()).toISOString());
      const userId = normalized.userId;

      if (!userId) {
        // 铁律 8：缺失 ≠ 不匹配——缺身份字段时只新增、不去重，并只 warn 一次
        if (!warnedMissingUserId) {
          warnedMissingUserId = true;
          logger.warn('登录返回缺少 userId，本次只新增不去重（下次拿到 userId 才能合并）');
        }
        const newAccountId = `account-${randomUUID()}`;
        const filePath = await writeAccountFile({ platformId, accountId: newAccountId, credential: normalized });
        return { accountId: newAccountId, filePath, created: true, merged: false, credential: normalized };
      }

      const existingAccounts = await listAccounts(platformId);
      const originRef = typeof normalized.originRef === 'string' && normalized.originRef.length > 0 ? normalized.originRef : null;
      const matchedAccount = existingAccounts.find((account) => {
        if (account.credential?.userId === userId) return true;
        // 同平台同 ref 也算同一个来源（还没拿到 userId 的导入可以据此更新）
        return originRef !== null && account.credential?.originRef === originRef;
      }) ?? null;

      if (matchedAccount && options.skipRefreshable === true && matchedAccount.credential?.refreshable !== false) {
        return {
          accountId: matchedAccount.accountId,
          filePath: matchedAccount.filePath,
          created: false,
          merged: false,
          skipped: true,
          reason: '已存在自己登录的账号（refreshable=true），导入不覆盖它',
          credential: matchedAccount.credential,
        };
      }
      // 已有账号沿用原 accountId（它是文件名的锚点，外部引用不该因为重新登录而变）
      const accountId = matchedAccount?.accountId ?? `account-${randomUUID()}`;
      const filePath = await writeAccountFile({ platformId, accountId, credential: normalized });
      return {
        accountId,
        filePath,
        created: matchedAccount === null,
        merged: matchedAccount !== null,
        skipped: false,
        credential: normalized,
      };
    },

    readAccount(platformId, accountId) {
      return readAccountFile(platformId, accountId);
    },
  };
}
