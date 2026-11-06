// 上游 max_tokens 上限的自适应学习（真实问题：agnes 不报上限，只在 400 里说）。
//
// 背景：`GET /v1/models` 只回 id/object/created/owned_by/supported_endpoint_types，
// 既没有 max_tokens 也没有 context_length —— 限制**查不到**，只能从拒绝里学。
// 策略：捕获 400 的错误文案 → 解析上限 → 落 <dataRoot>/limits.json → 后续请求发之前就夹住。
//
// 三条设计取舍：
//   1) 学习值写盘并与内存缓存合一：进程内不重复读文件，跨进程（重启/多实例）靠文件；
//   2) 群配置 `groups[].request.maxTokens` 优先于学习值（人工明确指定就该压过猜测）；
//   3) 取 min(原值, 上限)：上限比原值大时不必抬高请求，抬高只会改变上游行为而没收益。

import fs from 'node:fs/promises';
import path from 'node:path';
import { getDataRoot, getConfigPath } from './paths.js';
import { defaultLogger, describeFailure } from '../logger.js';

// 学习结果落盘位置：与 config.json 同目录，方便人工打开检查
export const LIMITS_FILE_NAME = 'limits.json';
export const LIMITS_VERSION = 1;

// 中文文案：`max_tokens 不能超过 65536`（agnes 实测）
const MAX_TOKENS_LIMIT_PATTERN_ZH = /max[_\s]*tokens?\s*不能超过\s*(\d+)/i;
// 英文文案兜底：max_tokens ... exceed / greater than / at most ... N
const MAX_TOKENS_LIMIT_PATTERN_EN = /max[_\s]*tokens?[^0-9]{0,64}?(?:exceed|greater\s+than|at\s+most|maximum)[^0-9]{0,64}?(\d+)/i;

// 解析上游错误文案里的 max_tokens 上限；解析不出返回 null（调用方据此决定"不重试"）
export function parseMaxTokensLimit(errorText) {
  if (typeof errorText !== 'string' || errorText.length === 0) return null;
  const matched = MAX_TOKENS_LIMIT_PATTERN_ZH.exec(errorText) ?? MAX_TOKENS_LIMIT_PATTERN_EN.exec(errorText);
  if (!matched) return null;
  const limitValue = Number(matched[1]);
  if (!Number.isFinite(limitValue) || limitValue <= 0) return null;
  return Math.trunc(limitValue);
}

// (群, 模型) → 上限：模块内统一 key 形状，避免各处拼接出现 `a::b` 与 `a/b` 两种写法
export function limitKeyFor(groupId, modelId) {
  return `${groupId ?? ''}::${modelId ?? ''}`;
}

// 夹取：显式配置 > 学习值 > 原值；结果永远是"不超过上游已知上限"的最小值。
// 返回 { maxTokens, source }，source 只用于日志（config / learned / requested）
export function capMaxTokens({ requested, configMax, learned }) {
  const usableRequested = typeof requested === 'number' && Number.isFinite(requested) && requested > 0
    ? Math.trunc(requested)
    : null;
  const usableConfig = typeof configMax === 'number' && Number.isFinite(configMax) && configMax > 0
    ? Math.trunc(configMax)
    : null;
  const usableLearned = typeof learned === 'number' && Number.isFinite(learned) && learned > 0
    ? Math.trunc(learned)
    : null;

  // 上限候选：配置值（人工指定）与学习值都算"上限"；两者都有时取更保守的那个
  const ceilings = [usableConfig, usableLearned].filter((value) => value !== null);
  const ceiling = ceilings.length > 0 ? Math.min(...ceilings) : null;
  if (ceiling === null) {
    return { maxTokens: usableRequested, source: usableRequested === null ? 'none' : 'requested' };
  }
  const source = usableConfig !== null && ceiling === usableConfig ? 'config' : 'learned';
  if (usableRequested === null) return { maxTokens: ceiling, source };
  return { maxTokens: Math.min(usableRequested, ceiling), source };
}

// 读盘：缺失/损坏都当"还没学到"，绝不让一个坏文件挡住请求
async function readLimitsFile(absolutePath, logger) {
  try {
    const rawText = await fs.readFile(absolutePath, 'utf8');
    const parsed = JSON.parse(rawText);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.limits !== 'object' || parsed.limits === null) {
      return {};
    }
    return parsed.limits;
  } catch (readError) {
    if (readError?.code === 'ENOENT') return {};
    logger.warn(`上游上限记录读取失败，按空记录继续：${describeFailure(readError)}`);
    return {};
  }
}

// 原子写：同目录临时文件 → rename；失败只告警（学不到就下次再学，不能因此打断对话）
async function writeLimitsFile(absolutePath, limits, logger) {
  const payload = { version: LIMITS_VERSION, updatedAt: new Date().toISOString(), limits };
  const temporaryPath = `${absolutePath}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, absolutePath);
  } catch (writeError) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    logger.warn(`上游上限记录写入失败，本次仅在内存生效：${describeFailure(writeError)}`);
  }
}

// 进程内共享的上限存储：按 dataRoot 隔离（测试用临时数据根时互不污染）
export function createLimitsStore({ dataRoot = getDataRoot(), logger = defaultLogger } = {}) {
  // 惰性加载：第一次用到才读盘，读到的对象常驻内存
  let limitsCache = null;
  let loadingPromise = null;
  const absolutePath = path.join(dataRoot, LIMITS_FILE_NAME);

  async function ensureLoaded() {
    if (limitsCache) return limitsCache;
    if (!loadingPromise) {
      loadingPromise = readLimitsFile(absolutePath, logger).then((loaded) => {
        limitsCache = loaded;
        return loaded;
      });
    }
    return loadingPromise;
  }

  return {
    // 取某群某模型学到的上限；没有就 null
    async getLimit(groupId, modelId) {
      const limits = await ensureLoaded();
      const stored = limits[limitKeyFor(groupId, modelId)];
      const value = typeof stored === 'number' ? stored : stored?.maxTokens;
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
    },

    // 学到上限：写内存 + 落盘；返回写入后的值
    async learnLimit(groupId, modelId, maxTokens) {
      const limits = await ensureLoaded();
      const normalizedValue = Math.trunc(maxTokens);
      limits[limitKeyFor(groupId, modelId)] = {
        maxTokens: normalizedValue,
        learnedAt: new Date().toISOString(),
      };
      await writeLimitsFile(absolutePath, limits, logger);
      return normalizedValue;
    },

    // 测试/排查用：当前内存里的全量快照
    async snapshot() {
      return { ...(await ensureLoaded()) };
    },
  };
}

// 便于单测与其它模块直接拿默认路径
export function getLimitsPath(dataRoot = getDataRoot()) {
  return path.join(dataRoot, LIMITS_FILE_NAME);
}

// 与配置文件同目录是刻意的：备份/迁移数据根时两者一起走
export function getLimitsDirectoryHint() {
  return path.dirname(getConfigPath());
}
