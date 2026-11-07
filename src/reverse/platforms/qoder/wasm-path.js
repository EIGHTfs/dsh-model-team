// Qoder WASM 文件定位（三档，按序尝试）。
//
// 为什么需要单独一个文件：wasm 是**可选资产**（不入库、随部署补），缺它只应少一个平台的能力，
// 绝不能让插件加载失败。定位逻辑集中在这里，能力门与桥接层都只问它"有没有"。
//
// 三档顺序（先显式、后约定）：
//   ① DSH_MODEL_TEAM_QODER_WASM —— 显式指定（测试 / 特殊部署）
//   ② <pluginRoot>/assets/reverse/qoder/qoder-auth-wasm.wasm —— 源码/开发部署
//   ③ <dataRoot>/reverse/qoder/qoder-auth-wasm.wasm —— 用户自备（npm 安装后的正规位置）
// 找不到返回 null（**不抛**）：由能力门决定"这个平台这一路不可用"。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDataRoot } from '../../../gateway/config/paths.js';

export const QODER_WASM_ENV_VAR = 'DSH_MODEL_TEAM_QODER_WASM';
export const QODER_WASM_FILE_NAME = 'qoder-auth-wasm.wasm';

// 插件根目录：本文件在 src/reverse/platforms/qoder/ 下，向上四层即仓库/安装根
const PLUGIN_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export function pluginRootDirectory() {
  return PLUGIN_ROOT;
}

function isReadableFile(candidatePath) {
  try {
    return fs.statSync(candidatePath).isFile();
  } catch {
    return false;
  }
}

// 三档候选（含来源标签，日志与测试都用它区分"从哪儿加载的"）
export function listWasmCandidates({ environment = process.env, dataRoot = getDataRoot() } = {}) {
  const explicitPath = typeof environment?.[QODER_WASM_ENV_VAR] === 'string'
    ? environment[QODER_WASM_ENV_VAR].trim()
    : '';
  return [
    ...(explicitPath.length > 0 ? [{ path: path.resolve(explicitPath), source: 'env' }] : []),
    { path: path.join(PLUGIN_ROOT, 'assets', 'reverse', 'qoder', QODER_WASM_FILE_NAME), source: 'plugin-assets' },
    { path: path.join(dataRoot, 'reverse', 'qoder', QODER_WASM_FILE_NAME), source: 'data-root' },
  ];
}

// 按序找第一个存在的；没有就返回 null（调用方按"能力不可用"处理，不要抛）
export function resolveQoderWasmPath(options = {}) {
  for (const candidate of listWasmCandidates(options)) {
    if (isReadableFile(candidate.path)) return candidate;
  }
  return null;
}

export function isQoderWasmAvailable(options = {}) {
  return resolveQoderWasmPath(options) !== null;
}
