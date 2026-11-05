// config.json 读写：网关的唯一配置来源，核心要求是"坏配置不致命"。
// 需求意图：首次启动没有配置文件、文件被手工改坏、读权限异常，都不能让网关起不来；写回必须原子，避免中途断电留半个文件。
// 思路：读 -> 文件缺失就建目录并写空配置（info）/ 解析或读取失败就在内存降级空配置（warn），两条路径都不抛；
//      写 -> 同目录临时文件（带 pid）再 rename 覆盖。临时文件必须与目标同目录，跨设备 rename 会 EXDEV 失败。

import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfigPath, getDataRoot } from './paths.js';
import { GROUP_MODE_FIELD, GROUP_MODES, JSON_INDENT_WIDTH, TEMPORARY_FILE_SUFFIX } from './constants.js';
import { defaultLogger, describeFailure } from '../logger.js';

// 配置对象里承载群列表的字段名，读写两侧都引用这里，避免字面量散落
export const CONFIG_GROUPS_FIELD = 'groups';

// 人类可读的缩进宽度：配置文件会被手工打开，两格便于阅读
// 文件系统错误码：只有"文件不存在"才走自动创建分支，其余读取异常直接降级
const FILE_NOT_FOUND_CODE = 'ENOENT';

// 空配置工厂：每次返回新对象，防止调用方改到同一份共享数据
export function createEmptyConfig() {
  return { [CONFIG_GROUPS_FIELD]: [] };
}

// 是否形如配置对象（普通对象，非数组、非 null）
function isConfigObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 群级 mode 校验（docs/15 §一）：只认 forward / rewrite。
// 非法值**剔除**而不是改成 rewrite —— 剔除后语义回到"未声明"，由 adapter 走默认（forward）；
// 静默改成 rewrite 会让配置写错的人以为"我的选择生效了"，排查时看不到任何线索。
// 返回剔除明细，由 readConfig 统一告警（本函数保持纯函数，不碰 logger）。
export function normalizeGroupModes(groups) {
  const droppedModes = [];
  let changed = false;
  const normalizedGroups = groups.map((group) => {
    if (!isConfigObject(group) || !(GROUP_MODE_FIELD in group)) return group;
    const modeValue = group[GROUP_MODE_FIELD];
    if (GROUP_MODES.includes(modeValue)) return group;
    changed = true;
    droppedModes.push({ groupId: typeof group.id === 'string' ? group.id : null, modeValue });
    const groupCopy = { ...group };
    delete groupCopy[GROUP_MODE_FIELD];
    return groupCopy;
  });
  return { groups: changed ? normalizedGroups : groups, droppedModes };
}

// 归一化：groups 必须是数组；其它字段原样保留，便于后续扩展（账号/映射等）
// 返回 { config, wasRepaired, droppedModes }，wasRepaired=true 表示结构不合法被修过，
// droppedModes 是群级 mode 被判非法并剔除的明细（由调用方决定怎么告警）
export function normalizeConfig(rawConfig) {
  if (!isConfigObject(rawConfig)) {
    return { config: createEmptyConfig(), wasRepaired: true, droppedModes: [] };
  }
  if (!Array.isArray(rawConfig[CONFIG_GROUPS_FIELD])) {
    return { config: { ...rawConfig, [CONFIG_GROUPS_FIELD]: [] }, wasRepaired: true, droppedModes: [] };
  }
  const { groups, droppedModes } = normalizeGroupModes(rawConfig[CONFIG_GROUPS_FIELD]);
  if (droppedModes.length === 0) {
    return { config: rawConfig, wasRepaired: false, droppedModes };
  }
  return { config: { ...rawConfig, [CONFIG_GROUPS_FIELD]: groups }, wasRepaired: false, droppedModes };
}

// 读配置：任何失败都返回可用配置，不向调用方抛错（INV-06）
export async function readConfig({ dataRoot = getDataRoot(), logger = defaultLogger } = {}) {
  const configPath = getConfigPath(dataRoot);
  let rawConfigText;
  try {
    rawConfigText = await fs.readFile(configPath, 'utf8');
  } catch (readError) {
    if (readError?.code === FILE_NOT_FOUND_CODE) {
      return createMissingConfig({ dataRoot, configPath, logger });
    }
    logger.warn(`配置文件读取失败，本次以降级空配置运行：${describeFailure(readError)}`);
    return createEmptyConfig();
  }

  let parsedConfig;
  try {
    parsedConfig = JSON.parse(rawConfigText);
  } catch (parseError) {
    // 解析失败不能抛：网关要继续启动，用户还有机会从界面重写配置
    logger.warn(`配置文件解析失败，本次以降级空配置运行：${configPath}（${describeFailure(parseError)}）`);
    return createEmptyConfig();
  }

  const { config, wasRepaired, droppedModes } = normalizeConfig(parsedConfig);
  if (wasRepaired) {
    logger.warn(`配置文件结构不合法（${CONFIG_GROUPS_FIELD} 不是数组），已按空群列表处理：${configPath}`);
  }
  // 群级 mode 写错：逐条点名（含群 id 与原值），让用户能直接改回配置，而不是只看到"没生效"
  for (const droppedMode of droppedModes) {
    logger.warn(
      `群 ${droppedMode.groupId ?? '(无 id)'} 的 ${GROUP_MODE_FIELD} 值不合法：`
      + `${JSON.stringify(droppedMode.modeValue)}（只认 ${GROUP_MODES.join(' / ')}），已按未声明处理`,
    );
  }
  return config;
}

// 配置文件缺失时的兜底：建目录 + 写空配置；写不进去也只告警，启动不受影响
async function createMissingConfig({ dataRoot, configPath, logger }) {
  const emptyConfig = createEmptyConfig();
  logger.info(`配置文件不存在，已自动创建空配置：${configPath}`);
  try {
    await writeConfig(emptyConfig, { dataRoot, logger });
  } catch (writeError) {
    logger.warn(`空配置写入失败，本次仅在内存使用空配置：${describeFailure(writeError)}`);
  }
  return emptyConfig;
}

// 写配置：调用方传的是程序内部对象，结构不合法属于编码错误，这里直接抛出（不静默写坏文件）
export async function writeConfig(config, { dataRoot = getDataRoot(), logger = defaultLogger } = {}) {
  if (!isConfigObject(config) || !Array.isArray(config[CONFIG_GROUPS_FIELD])) {
    throw new TypeError(`writeConfig 需要形如 { ${CONFIG_GROUPS_FIELD}: [...] } 的配置对象`);
  }

  const configPath = getConfigPath(dataRoot);
  const temporaryPath = `${configPath}.${process.pid}${TEMPORARY_FILE_SUFFIX}`;
  const serializedConfig = `${JSON.stringify(config, null, JSON_INDENT_WIDTH)}\n`;

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  try {
    await fs.writeFile(temporaryPath, serializedConfig, 'utf8');
    await fs.rename(temporaryPath, configPath);
  } catch (writeError) {
    // 失败时清掉半成品，避免数据根里留下看不懂的临时文件
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw writeError;
  }

  logger.info(`配置已写入：${configPath}`);
  return configPath;
}

// ---------- HTTP 运行配置（docs/09 §11，缺省值集中在这里，避免散落各处） ----------

// 网关缺省端口：可用 env DSH_MODEL_TEAM_PORT 或 config.http.port 覆盖
export const DEFAULT_HTTP_PORT = 3177;

// 请求体上限缺省 8MB：对话消息可能很长，但也不能让人一把把内存吃穿
// 单兆字节字节数与缺省请求体上限（8MiB）：对话消息可能很长，但不能让人一把把内存吃穿
export const BYTES_PER_MEBIBYTE = 1024 * 1024;
export const DEFAULT_MAX_BODY_MEBIBYTES = 8;
export const DEFAULT_MAX_BODY_BYTES = DEFAULT_MAX_BODY_MEBIBYTES * BYTES_PER_MEBIBYTE;

// CORS 白名单里的通配符：§11 明令禁止，这里主动剔除而不是放行
const CORS_WILDCARD_ORIGIN = '*';

// 归一化 http 配置：类型不对一律回落缺省，非法来源直接过滤掉
export function resolveHttpConfig(config) {
  const httpConfig = config?.http ?? {};
  const configuredPort = httpConfig.port;
  const configuredMaxBodyBytes = httpConfig.maxBodyBytes;
  const configuredOrigins = Array.isArray(httpConfig.corsOrigins) ? httpConfig.corsOrigins : [];

  return {
    port: Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : DEFAULT_HTTP_PORT,
    corsOrigins: configuredOrigins.filter(
      (origin) => typeof origin === 'string' && origin.length > 0 && origin !== CORS_WILDCARD_ORIGIN,
    ),
    externalOpenAiCompat: httpConfig.externalOpenAiCompat === true,
    maxBodyBytes:
      Number.isInteger(configuredMaxBodyBytes) && configuredMaxBodyBytes > 0
        ? configuredMaxBodyBytes
        : DEFAULT_MAX_BODY_BYTES,
  };
}
