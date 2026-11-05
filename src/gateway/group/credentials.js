// 加群表单的凭证与模型归一：把 authSchema 的扁平字段转成群配置里的"凭证引用 + models"。
// 需求意图：前端按 authSchema 动态渲染表单，用户在密码框里粘贴明文 Key；
//          明文只落盘成数据根下的凭证文件，配置里永远只存 env:/file: 引用，响应也不回显明文。

import fs from 'node:fs/promises';
import path from 'node:path';
import { getDataRoot } from '../config/paths.js';
import { ERROR_CODES, GatewayError } from '../errors.js';
import { defaultLogger, describeFailure } from '../logger.js';
import { normalizeModelList } from '../model/catalog.js';

// 数据根下的凭证目录与文件后缀：一个群一个文件，便于单独轮换
export const CREDENTIALS_DIRECTORY_NAME = 'credentials';
export const CREDENTIAL_FILE_SUFFIX = '.key';
// 凭证文件权限：仅属主可读写；CIFS 等不支持 chmod 的环境降级为 warn
export const CREDENTIAL_FILE_MODE = 0o600;

// 模型列表来源：自动拉取（调 /models）或手动填写
export const MODEL_SOURCE_AUTO = 'auto';
export const MODEL_SOURCE_MANUAL = 'manual';
export const DEFAULT_MODELS_ENDPOINT = '/models';
// 手动模型名按行拆分（兼容 CRLF）
const MANUAL_MODEL_LINE_SEPARATOR = /\r?\n/;

// 配置里存的引用形态（相对数据根，迁移时不用改）
export function toCredentialReference(groupId) {
  return `file:${CREDENTIALS_DIRECTORY_NAME}/${groupId}${CREDENTIAL_FILE_SUFFIX}`;
}

// 凭证文件的绝对路径（写盘与测试断言共用同一处推导）
export function toCredentialPath(groupId, dataRoot = getDataRoot()) {
  return path.join(dataRoot, CREDENTIALS_DIRECTORY_NAME, `${groupId}${CREDENTIAL_FILE_SUFFIX}`);
}

// 明文 Key 落盘：只写该群自己的文件，尽量收紧到 600；失败只 warn（不能让加群失败）
export async function persistGroupApiKey(groupId, plaintextApiKey, { dataRoot = getDataRoot(), logger = defaultLogger } = {}) {
  const credentialPath = toCredentialPath(groupId, dataRoot);
  await fs.mkdir(path.dirname(credentialPath), { recursive: true });
  await fs.writeFile(credentialPath, plaintextApiKey, { encoding: 'utf8', mode: CREDENTIAL_FILE_MODE });
  try {
    await fs.chmod(credentialPath, CREDENTIAL_FILE_MODE);
  } catch (chmodError) {
    logger.warn(`凭证文件权限未能收紧到 600（${credentialPath}）：${describeFailure(chmodError)}`);
  }
  return toCredentialReference(groupId);
}

// 表单提交归一：同时兼容"扁平字段"（authSchema 直出）与旧写法（嵌套 auth/models）
export function normalizeGroupSubmission(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new GatewayError(ERROR_CODES.INVALID_REQUEST, '群配置必须是对象');
  }
  const auth = payload.auth ?? {};
  const pickText = (candidates) => candidates.find((value) => typeof value === 'string' && value.trim().length > 0) ?? null;

  return {
    authType: typeof auth.type === 'string' && auth.type.length > 0 ? auth.type : 'bearer',
    // 引用优先：两者都给时以引用为准，明文不落盘
    submittedApiKeyRef: pickText([auth.apiKeyRef, payload.apiKeyRef]),
    submittedApiKey: pickText([auth.apiKey, payload.apiKey]),
    modelSource: pickText([payload.modelSource, payload.models?.source]) ?? MODEL_SOURCE_AUTO,
    manualModels: payload.manualModels
      ?? payload.models?.manualModels
      // static 全为字符串时才等价于"每行一个名字"；对象数组由 addGroup 直接采用，不做 join
      ?? (Array.isArray(payload.models?.static) && payload.models.static.every((entry) => typeof entry === 'string')
        ? payload.models.static.join('\n')
        : null),
  };
}

// 手动模型名归一：按行拆分、去空行、去首尾空白
export function toStaticModelList(manualModels) {
  const rawLines = Array.isArray(manualModels)
    ? manualModels
    : String(manualModels ?? '').split(MANUAL_MODEL_LINE_SEPARATOR);
  return rawLines.map((line) => String(line).trim()).filter((line) => line.length > 0);
}

// modelSource + manualModels → 群配置里的 models（auto=endpoint，manual=static）
export function buildGroupModels({ modelSource, manualModels }, { logger = defaultLogger } = {}) {
  if (modelSource === MODEL_SOURCE_MANUAL) {
    const staticModels = toStaticModelList(manualModels);
    if (staticModels.length === 0) {
      throw new GatewayError(ERROR_CODES.INVALID_REQUEST, '选择手动填写模型时必须给出至少一个模型名', {
        hint: '模型名每行一个，例如 my-model-a',
      });
    }
    return { static: normalizeModelList(staticModels, { logger }) };
  }
  return { endpoint: DEFAULT_MODELS_ENDPOINT };
}
