// 完整备份/还原（导出 v2）：配置 + 凭据文件本体，目标是"导出即可完整恢复"。
// 口径：为保证「导出即可完整恢复」，凭据本体随备份走；风险由 DSH 的访问控制承担（进入页面才能操作插件）。
//
// 两条纪律不变：
//   1) 日志只记文件名与字节数，**绝不打明文**；
//   2) 群内联的明文 apiKey 仍拒收——明文只从 credentialFiles 这一个入口写盘，保持形状单一。

import fs from 'node:fs/promises';
import path from 'node:path';
import { ENV_REF_PREFIX, FILE_REF_PREFIX } from './credentials.js';
import { describeFailure } from '../logger.js';

// 备份格式版本：v1 只有 groups；v2 增加 credentialFiles / unresolvedRefs
export const BACKUP_VERSION = 2;

// 护栏：单文件 64KB、总量 512KB。超限只记进 unresolvedRefs，绝不截断（截断的密钥等于坏密钥）
export const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;
export const MAX_CREDENTIAL_TOTAL_BYTES = 512 * 1024;

// 还原时凭据文件的权限：只有属主可读写
export const CREDENTIAL_FILE_MODE = 0o600;

// unresolvedRefs 里的原因文案（前端直接展示，保持稳定）
export const UNRESOLVED_REASONS = Object.freeze({
  ENV_REF: '环境变量引用无法随文件导出',
  UNSUPPORTED_REF: '不支持的引用前缀，无法导出',
  INVALID_PATH: '引用路径不合法（禁止绝对路径与 ..）',
  MISSING_FILE: '文件不存在',
  READ_FAILED: '文件读取失败',
  TOO_LARGE: '超出导出上限',
});

// 把 file: 后面的相对路径规范化成 dataRoot 内的安全路径；不合法返回 null。
// 导出与还原共用同一份判定——两边规则一旦分叉，就会出现"能导出不能导入"或反过来。
export function toSafeRelativePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) return null;
  const trimmedPath = rawPath.trim();
  if (path.isAbsolute(trimmedPath)) return null;
  const normalizedPath = path.normalize(trimmedPath);
  if (normalizedPath === '.' || normalizedPath.startsWith('..')) return null;
  return normalizedPath;
}

// 文件模式转成 JSON 里好读的十进制（0o600 = 384），与备份样例一致
function toModeNumber(stats) {
  return typeof stats.mode === 'number' ? stats.mode & 0o777 : CREDENTIAL_FILE_MODE;
}

// 收集一个群的凭据文件；返回 { entry } / { unresolved }（二选一）
async function collectOneRef({ group, apiKeyRef, dataRoot, remainingBytes }) {
  const unresolvedRef = (reason) => ({
    unresolved: { group: group?.id ?? null, apiKeyRef, reason },
  });

  if (apiKeyRef.startsWith(ENV_REF_PREFIX)) {
    return unresolvedRef(UNRESOLVED_REASONS.ENV_REF);
  }
  if (!apiKeyRef.startsWith(FILE_REF_PREFIX)) {
    return unresolvedRef(UNRESOLVED_REASONS.UNSUPPORTED_REF);
  }

  const declaredPath = apiKeyRef.slice(FILE_REF_PREFIX.length).trim();
  const safeRelativePath = toSafeRelativePath(declaredPath);
  if (!safeRelativePath) {
    return unresolvedRef(UNRESOLVED_REASONS.INVALID_PATH);
  }

  const absolutePath = path.resolve(dataRoot, safeRelativePath);
  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch (statError) {
    // 不静默跳过：读不到的引用要让人看见"这份备份缺了什么"
    const isMissing = statError?.code === 'ENOENT';
    return unresolvedRef(isMissing ? UNRESOLVED_REASONS.MISSING_FILE : UNRESOLVED_REASONS.READ_FAILED);
  }
  if (stats.size > MAX_CREDENTIAL_FILE_BYTES) {
    return unresolvedRef(UNRESOLVED_REASONS.TOO_LARGE);
  }
  if (stats.size > remainingBytes) {
    return unresolvedRef(UNRESOLVED_REASONS.TOO_LARGE);
  }

  let content;
  try {
    content = await fs.readFile(absolutePath, 'utf8');
  } catch {
    return unresolvedRef(UNRESOLVED_REASONS.READ_FAILED);
  }
  // 用真实字节数（读到的内容才是备份里真正带走的东西）
  const bytes = Buffer.byteLength(content, 'utf8');
  return {
    entry: {
      key: safeRelativePath,
      value: { path: safeRelativePath, content, bytes, mode: toModeNumber(stats) },
      bytes,
    },
  };
}

// 遍历所有群的 apiKeyRef，收集能随备份走的凭据文件
export async function collectCredentialFiles({ groups, dataRoot }) {
  const credentialFiles = {};
  const unresolvedRefs = [];
  let totalBytes = 0;

  for (const group of groups ?? []) {
    const apiKeyRef = group?.auth?.apiKeyRef;
    if (typeof apiKeyRef !== 'string' || apiKeyRef.trim().length === 0) continue;

    const result = await collectOneRef({
      group,
      apiKeyRef: apiKeyRef.trim(),
      dataRoot,
      remainingBytes: MAX_CREDENTIAL_TOTAL_BYTES - totalBytes,
    });
    if (result.unresolved) {
      unresolvedRefs.push(result.unresolved);
      continue;
    }
    credentialFiles[result.entry.key] = result.entry.value;
    totalBytes += result.entry.bytes;
  }

  return { credentialFiles, unresolvedRefs };
}

// 导出 v2：配置原样 + 凭据本体 + 无法导出的引用
export async function exportBackup({ config, dataRoot, logger }) {
  const groups = config?.groups ?? [];
  const { credentialFiles, unresolvedRefs } = await collectCredentialFiles({ groups, dataRoot });

  const fileNames = Object.keys(credentialFiles);
  const totalBytes = Object.values(credentialFiles).reduce((total, entry) => total + entry.bytes, 0);
  if (logger && typeof logger.info === 'function') {
    // 只记文件名与字节数：哪怕日志被打走，也拿不到 Key
    logger.info(`备份导出：${groups.length} 个群、${fileNames.length} 个凭据文件（${fileNames.join('、')}，合计 ${totalBytes} 字节）`);
  }

  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    groups,
    credentialFiles,
    unresolvedRefs,
  };
}

// 还原一份凭据文件：先备份已存在的同名文件，再以 0600 写入
async function restoreOneFile({ relativePath, entry, dataRoot }) {
  const safeRelativePath = toSafeRelativePath(entry?.path ?? relativePath);
  if (!safeRelativePath) {
    return { skipped: { path: String(entry?.path ?? relativePath), reason: '路径不合法（禁止绝对路径与 ..）' } };
  }
  const absolutePath = path.resolve(dataRoot, safeRelativePath);
  // 双保险：归一化之后再确认一次仍在数据根内（跨平台分隔符也能挡住）
  if (absolutePath !== dataRoot && !absolutePath.startsWith(dataRoot + path.sep)) {
    return { skipped: { path: safeRelativePath, reason: '目标路径不在数据根内' } };
  }
  if (typeof entry?.content !== 'string') {
    return { skipped: { path: safeRelativePath, reason: '缺少 content' } };
  }

  const bytes = Buffer.byteLength(entry.content, 'utf8');
  if (bytes > MAX_CREDENTIAL_FILE_BYTES) {
    return { skipped: { path: safeRelativePath, reason: '超出导入上限' } };
  }

  // 已存在就先备份；备份失败要冒泡到外层记 skippedRefs —— **绝不静默覆盖**用户的现有密钥
  let existingFile = false;
  try {
    const stats = await fs.stat(absolutePath);
    existingFile = stats.isFile();
  } catch {
    existingFile = false;
  }
  let backupPath = null;
  if (existingFile) {
    backupPath = `${absolutePath}.bak-${Date.now()}`;
    await fs.copyFile(absolutePath, backupPath);
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, entry.content, { encoding: 'utf8', mode: CREDENTIAL_FILE_MODE });
  // writeFile 的 mode 只对"新建"生效；已存在的文件要显式收紧权限
  await fs.chmod(absolutePath, CREDENTIAL_FILE_MODE);

  return { restored: { path: safeRelativePath, bytes }, backupPath };
}

// 还原 credentialFiles：逐条写盘，非法路径/超限只记 skipped，不中断其它文件
export async function restoreCredentialFiles({ credentialFiles, dataRoot, logger }) {
  const restoredCredentialFiles = [];
  const skippedRefs = [];
  if (!credentialFiles || typeof credentialFiles !== 'object') {
    return { restoredCredentialFiles, skippedRefs };
  }

  for (const [relativePath, entry] of Object.entries(credentialFiles)) {
    try {
      const result = await restoreOneFile({ relativePath, entry, dataRoot });
      if (result.skipped) {
        skippedRefs.push(result.skipped);
      } else {
        restoredCredentialFiles.push(result.restored);
      }
    } catch (restoreError) {
      skippedRefs.push({ path: String(entry?.path ?? relativePath), reason: describeFailure(restoreError) });
    }
  }

  if (logger && typeof logger.info === 'function' && restoredCredentialFiles.length > 0) {
    const fileNames = restoredCredentialFiles.map((item) => item.path).join('、');
    logger.info(`备份还原：写入 ${restoredCredentialFiles.length} 个凭据文件（${fileNames}）`);
  }
  return { restoredCredentialFiles, skippedRefs };
}
