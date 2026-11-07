// 凭据导入框架（通用扩展点，与任何平台/凭据类型无关）。
//
// 为什么在 gateway 层而不是某个平台目录：这是"从别处拿一份现有凭据"的通用能力——
// 宿主持有凭据服务、用户手里有 JSON、将来可能有环境变量/密钥管理器……这些都只是**来源**。
// 平台相关的部分（怎么落盘、哪些字段算账号、要不要接管续期）由调用方注入的 **sink** 决定。
//
// 新增一个来源 = 新增 sources/<id>.js（导出自描述对象）+ 在下面 IMPORT_SOURCE_MODULES 里加一行。
// 注册表里不出现任何平台名/来源名清单（铁律：一处登记）。

import { source as hostCredentialsSource } from './sources/host-credentials.js';
import { source as manualSource } from './sources/manual.js';

export const IMPORT_SOURCE_ERROR_CODES = Object.freeze({
  UNKNOWN_SOURCE: 'reverse-import-unknown-source',
  SOURCE_UNAVAILABLE: 'reverse-import-source-unavailable',
  INVALID_CREDENTIAL: 'reverse-import-invalid-credential',
});

const IMPORT_SOURCE_MODULES = [hostCredentialsSource, manualSource];

const importSources = new Map();

export function registerImportSource(source) {
  if (!source || typeof source.id !== 'string' || source.id.length === 0) {
    throw new TypeError('导入源必须有非空字符串 id');
  }
  if (importSources.has(source.id)) {
    throw new Error(`导入源 id 重复：${source.id}`);
  }
  importSources.set(source.id, source);
  return source;
}

for (const source of IMPORT_SOURCE_MODULES) registerImportSource(source);

export function listImportSources() {
  return [...importSources.values()];
}

export function getImportSource(sourceId) {
  return importSources.get(sourceId) ?? null;
}

function importError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

// 列出源及可用性（宿主没有对应服务时 available=false + reason，前端据此灰掉选项）
export async function describeImportSources({ deps } = {}) {
  const descriptions = [];
  for (const source of listImportSources()) {
    let available = true;
    let reason;
    try {
      const availability = typeof source.isAvailable === 'function' ? await source.isAvailable({ deps }) : true;
      // 源可以只回 false，也可以回 { available, reason } 把"为什么不可用"说清楚
      if (availability && typeof availability === 'object') {
        available = availability.available === true;
        reason = availability.reason;
      } else {
        available = availability === true;
      }
      if (!available && !reason) reason = '当前环境不满足该来源的可用条件（如宿主未提供对应服务）';
    } catch (availabilityError) {
      available = false;
      reason = availabilityError?.message ?? String(availabilityError);
    }
    descriptions.push({
      id: source.id,
      name: source.name,
      platforms: Array.isArray(source.platforms) ? source.platforms : [],
      available,
      ...(reason ? { reason } : {}),
    });
  }
  return descriptions;
}

// 导入一次：源 resolve → 调用方注入的 sink 落盘（sink 决定账号形状、脱敏与"是否覆盖"）
export async function importCredential({ platform, sourceId, ref, deps = {} } = {}) {
  const source = getImportSource(sourceId);
  if (!source) throw importError(IMPORT_SOURCE_ERROR_CODES.UNKNOWN_SOURCE, `未知的导入源：${sourceId}`);
  if (typeof platform !== 'string' || platform.length === 0) {
    throw importError(IMPORT_SOURCE_ERROR_CODES.INVALID_CREDENTIAL, '缺少 platform');
  }
  if (typeof source.isAvailable === 'function' && (await source.isAvailable({ deps })) !== true) {
    throw importError(IMPORT_SOURCE_ERROR_CODES.SOURCE_UNAVAILABLE, `导入源不可用：${source.name}`);
  }
  const sink = deps?.sink;
  if (!sink || typeof sink.upsertImported !== 'function') {
    throw new TypeError('importCredential 需要 deps.sink.upsertImported');
  }

  const credential = await source.resolve({ deps, ref });
  // origin 由框架统一打（调用方据此知道"这份凭据是哪来的"），sink 负责落盘与脱敏
  return sink.upsertImported({
    platform,
    credential,
    origin: `import:${source.id}`,
    originRef: typeof ref === 'string' ? ref : undefined,
  });
}
