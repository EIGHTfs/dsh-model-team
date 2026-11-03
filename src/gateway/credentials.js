// 凭证引用解析：配置里只存引用（env:<NAME> / file:<相对路径>），明文 Key 永远不落库、不进日志。
// 需求意图：某个群配错或漏配凭证时，只让这个群标记"未配置凭证"，不能影响网关主进程和其它群。
// 思路：所有分支返回统一结果对象（成功 { ok, value, source } / 失败 { ok:false, code, message }），任何情况都不抛；
//      文件引用的相对路径以数据根为基准，绝对路径原样使用。本模块刻意不写日志，凭证值不会因日志外泄。

import fs from 'node:fs/promises';
import path from 'node:path';
import { getDataRoot } from './paths.js';

// 两种受支持的引用前缀
export const ENV_REF_PREFIX = 'env:';
export const FILE_REF_PREFIX = 'file:';

// 解析失败原因码：调用方据此区分"没配"与"配了但取不到"，前端文案与排错都依赖它
export const CREDENTIAL_FAILURE_CODES = Object.freeze({
  MISSING_REF: 'MISSING_API_KEY_REF',
  UNSUPPORTED_SCHEME: 'UNSUPPORTED_API_KEY_REF_SCHEME',
  EMPTY_TARGET: 'EMPTY_API_KEY_REF_TARGET',
  ENV_NOT_SET: 'API_KEY_ENV_NOT_SET',
  FILE_NOT_FOUND: 'API_KEY_FILE_NOT_FOUND',
  FILE_READ_FAILED: 'API_KEY_FILE_READ_FAILED',
  EMPTY_VALUE: 'API_KEY_VALUE_EMPTY',
});

// 凭证在驱动 context.credentials 里的字段名，网关与驱动共用同一个约定
export const CREDENTIALS_API_KEY_FIELD = 'apiKey';

// 文件末尾换行不属于 Key 本身，读入后必须裁掉
const SURROUNDING_WHITESPACE_PATTERN = /^\s+|\s+$/g;

// 失败结果工厂：统一形状，避免各处手拼对象
function failure(code, message, source = null) {
  return { ok: false, code, message, source, value: null };
}

// 解析一份 apiKeyRef
export async function resolveApiKeyRef(apiKeyRef, { dataRoot = getDataRoot(), environment = process.env } = {}) {
  if (typeof apiKeyRef !== 'string' || apiKeyRef.trim().length === 0) {
    return failure(CREDENTIAL_FAILURE_CODES.MISSING_REF, '未配置 apiKeyRef，该群按"未配置凭证"处理');
  }

  const normalizedRef = apiKeyRef.trim();
  const source = normalizedRef;

  if (normalizedRef.startsWith(ENV_REF_PREFIX)) {
    return resolveFromEnvironment(normalizedRef.slice(ENV_REF_PREFIX.length).trim(), environment);
  }
  if (normalizedRef.startsWith(FILE_REF_PREFIX)) {
    return resolveFromFile(normalizedRef.slice(FILE_REF_PREFIX.length).trim(), dataRoot);
  }

  // 未知前缀一律拒绝：宁可不发请求，也不要把引用串当 Key 发给上游
  return failure(
    CREDENTIAL_FAILURE_CODES.UNSUPPORTED_SCHEME,
    `不支持的 apiKeyRef 前缀：${source}（仅支持 ${ENV_REF_PREFIX}<NAME> 与 ${FILE_REF_PREFIX}<相对路径>）`,
    source,
  );
}

// env:<NAME> 分支
function resolveFromEnvironment(environmentName, environment) {
  if (environmentName.length === 0) {
    return failure(CREDENTIAL_FAILURE_CODES.EMPTY_TARGET, `${ENV_REF_PREFIX} 之后缺少环境变量名`);
  }
  const environmentValue = environment[environmentName];
  if (typeof environmentValue !== 'string' || environmentValue.trim().length === 0) {
    return failure(
      CREDENTIAL_FAILURE_CODES.ENV_NOT_SET,
      `环境变量 ${environmentName} 未设置或为空（配置里只存引用，实际 Key 由部署侧注入）`,
      `${ENV_REF_PREFIX}${environmentName}`,
    );
  }
  return { ok: true, value: environmentValue.trim(), source: `${ENV_REF_PREFIX}${environmentName}`, code: null, message: null };
}

// file:<相对路径> 分支
async function resolveFromFile(relativePath, dataRoot) {
  if (relativePath.length === 0) {
    return failure(CREDENTIAL_FAILURE_CODES.EMPTY_TARGET, `${FILE_REF_PREFIX} 之后缺少文件路径`);
  }
  const absolutePath = path.isAbsolute(relativePath) ? relativePath : path.resolve(dataRoot, relativePath);
  const source = `${FILE_REF_PREFIX}${relativePath}`;

  let fileContent;
  try {
    fileContent = await fs.readFile(absolutePath, 'utf8');
  } catch (readError) {
    if (readError?.code === 'ENOENT') {
      return failure(CREDENTIAL_FAILURE_CODES.FILE_NOT_FOUND, `凭证文件不存在：${absolutePath}`, source);
    }
    return failure(CREDENTIAL_FAILURE_CODES.FILE_READ_FAILED, `凭证文件读取失败：${absolutePath}（${readError?.message ?? readError}）`, source);
  }

  const trimmedValue = fileContent.replace(SURROUNDING_WHITESPACE_PATTERN, '');
  if (trimmedValue.length === 0) {
    return failure(CREDENTIAL_FAILURE_CODES.EMPTY_VALUE, `凭证文件内容为空：${absolutePath}`, source);
  }
  return { ok: true, value: trimmedValue, source, code: null, message: null };
}

// 群级便捷入口：网关按群解引用一次，把结果直接塞进 DriverContext.credentials
// 返回 { ok, credentials, source } 或 { ok:false, credentials:{}, error }
export async function resolveGroupCredentials(group, { dataRoot = getDataRoot(), environment = process.env } = {}) {
  const apiKeyRef = group?.auth?.apiKeyRef;
  const resolvedRef = await resolveApiKeyRef(apiKeyRef, { dataRoot, environment });
  if (!resolvedRef.ok) {
    return { ok: false, credentials: {}, source: resolvedRef.source, error: resolvedRef };
  }
  return {
    ok: true,
    credentials: { [CREDENTIALS_API_KEY_FIELD]: resolvedRef.value },
    source: resolvedRef.source,
    error: null,
  };
}
