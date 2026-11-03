// 驱动注册表与加载器：内置配置型驱动 + 运行时扫描数据根 drivers/ 下的 .js。
// 需求意图：平台接入能力可以靠新增文件扩展、不需要重启网关；但任何一个驱动写坏或加载报错，
//          都不能拖垮网关主进程，也不能让其它驱动不可用（INV-05 错误隔离）。
// 思路：注册表分可用驱动（id -> 实现）与加载记录（文件 -> 状态）两张表；扫描时逐文件 try/catch，
//      import 与结构校验都在 try 内，失败只记 failed + warn 后继续下一个文件；重新扫描带 mtime 查询串，
//      让被编辑过的文件重新求值——代价是模块实例不唯一，所以驱动不得依赖模块级状态。

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDriversDirectory } from '../paths.js';
import { defaultLogger, describeFailure } from '../logger.js';
import { openAiCompatibleDriver } from './openai-compatible.js';

// 只扫 .js：数据根里其它文件（说明文档、备份）一律忽略
export const DRIVER_FILE_EXTENSION = '.js';

// 驱动目录的模块类型声明文件：让外挂 .js 一律按 ESM 解析，
// 不依赖宿主 Node 的模块语法自动探测（旧版本 Node 会把 ESM 语法当 CJS，直接语法报错）
export const DRIVERS_MODULE_TYPE_FILE_NAME = 'package.json';
const DRIVERS_MODULE_TYPE_CONTENT = '{\n  "type": "module"\n}\n';

// 目录不存在的错误码：区分"还没放驱动"和"目录读不了"
const DIRECTORY_NOT_FOUND_CODE = 'ENOENT';

// accessMode 取值（docs/07）：official 走公开 API，reverse 走浏览器凭证/私有接口
export const ACCESS_MODES = Object.freeze({
  OFFICIAL: 'official',
  REVERSE: 'reverse',
});

// 加载记录状态：前端/测试据此区分"能用"与"加载失败"
export const DRIVER_STATUSES = Object.freeze({
  AVAILABLE: 'available',
  FAILED: 'failed',
});

// 列表排序权重：official 必须排在 reverse 之前（docs/07 展示顺序）
const ACCESS_MODE_SORT_WEIGHT = Object.freeze({
  [ACCESS_MODES.OFFICIAL]: 0,
  [ACCESS_MODES.REVERSE]: 1,
});

// 内置驱动（随包分发，不走数据根扫描）
const BUILT_IN_DRIVERS = Object.freeze([openAiCompatibleDriver]);

// 可用驱动：driverId -> 驱动实现
const availableDrivers = new Map();

// 加载记录：来源键（内置用 builtin:<id>，外挂用文件绝对路径）-> 状态明细
const driverLoadRecords = new Map();

// 把驱动结构校验拆成独立函数：外挂加载与内置注册共用同一套判据
function assertDriverShape(driverCandidate, originLabel) {
  if (typeof driverCandidate !== 'object' || driverCandidate === null) {
    throw new TypeError(`${originLabel}：默认导出不是对象`);
  }
  const { id, name, accessMode, authSchema } = driverCandidate;
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new TypeError(`${originLabel}：缺少字符串字段 id`);
  }
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new TypeError(`${originLabel}：缺少字符串字段 name`);
  }
  // accessMode 必须显式声明：缺失时绝不能默认当 official，否则合规边界会被悄悄放宽
  if (!Object.values(ACCESS_MODES).includes(accessMode)) {
    throw new TypeError(`${originLabel}：accessMode 必须是 ${ACCESS_MODES.OFFICIAL} 或 ${ACCESS_MODES.REVERSE}`);
  }
  if (!Array.isArray(authSchema)) {
    throw new TypeError(`${originLabel}：authSchema 必须是数组（无凭证字段时给空数组）`);
  }
  return driverCandidate;
}

// 注册驱动；id 冲突直接拒绝，避免外挂驱动顶掉内置驱动
export function registerDriver(driverCandidate, { originLabel = '驱动' } = {}) {
  const driver = assertDriverShape(driverCandidate, originLabel);
  const existingDriver = availableDrivers.get(driver.id);
  if (existingDriver) {
    throw new Error(`${originLabel}：驱动 id 与已注册驱动重复 -> ${driver.id}`);
  }
  availableDrivers.set(driver.id, driver);
  driverLoadRecords.set(`builtin:${driver.id}`, {
    source: `builtin:${driver.id}`,
    id: driver.id,
    accessMode: driver.accessMode,
    status: DRIVER_STATUSES.AVAILABLE,
    message: null,
  });
  return driver;
}

// 重扫前清掉外挂部分：删掉文件后列表里就不该再有它（内置驱动保留）
function clearExternalDrivers() {
  for (const [sourceKey, record] of driverLoadRecords) {
    if (sourceKey.startsWith('builtin:')) {
      continue;
    }
    driverLoadRecords.delete(sourceKey);
  }
  for (const [driverId, driver] of availableDrivers) {
    if (BUILT_IN_DRIVERS.some((builtInDriver) => builtInDriver.id === driver.id)) {
      continue;
    }
    availableDrivers.delete(driverId);
  }
}

// 初次导入时把内置驱动装上；外挂驱动由网关启动时调用 loadExternalDrivers()
export function resetDriverRegistry() {
  availableDrivers.clear();
  driverLoadRecords.clear();
  for (const builtInDriver of BUILT_IN_DRIVERS) {
    registerDriver(builtInDriver, { originLabel: `内置驱动 ${builtInDriver.id}` });
  }
}

// 保证驱动目录是 ESM 作用域：只在缺失时写，用户自带的 package.json 不动
async function ensureDriversModuleType(driversDir, logger) {
  const moduleTypeFilePath = path.join(driversDir, DRIVERS_MODULE_TYPE_FILE_NAME);
  try {
    await fs.writeFile(moduleTypeFilePath, DRIVERS_MODULE_TYPE_CONTENT, { encoding: 'utf8', flag: 'wx' });
    // 文案要自解释：日志里能看出"为什么数据根会多出这个文件"
    logger.info(`drivers 目录缺少 package.json，已创建 {"type": "module"} 以支持 ESM 驱动：${driversDir}`);
  } catch (writeError) {
    if (writeError?.code !== 'EEXIST') {
      throw writeError;
    }
  }
}

// 动态 import 单个文件；带 mtime 查询串让编辑后的文件重新求值
async function importDriverFile(driverFilePath) {
  const fileStats = await fs.stat(driverFilePath);
  const moduleUrl = `${pathToFileURL(driverFilePath).href}?mtime=${fileStats.mtimeMs}`;
  const moduleNamespace = await import(moduleUrl);
  // 兼容两种导出习惯：default 优先，其次具名 driver
  return moduleNamespace.default ?? moduleNamespace.driver;
}

// 扫描数据根 drivers/ 目录：单文件失败只影响它自己，返回值供调用方展示"哪些驱动没加载上"
export async function loadExternalDrivers({ driversDir = getDriversDirectory(), logger = defaultLogger } = {}) {
  clearExternalDrivers();

  let directoryEntries;
  try {
    directoryEntries = await fs.readdir(driversDir, { withFileTypes: true });
  } catch (readdirError) {
    // 目录不存在 = 还没有外挂驱动。这里刻意不主动建目录：启动阶段不在用户数据根造文件
    if (readdirError?.code !== DIRECTORY_NOT_FOUND_CODE) {
      logger.warn(`驱动目录读取失败，跳过外挂驱动扫描：${describeFailure(readdirError)}`);
    }
    return { statuses: listDriverStatuses(), availableCount: availableDrivers.size, failedCount: 0 };
  }

  const driverFileNames = directoryEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(DRIVER_FILE_EXTENSION) && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();

  // 只有真的存在 .js 驱动才补模块类型声明：空目录不动用户数据根
  if (driverFileNames.length > 0) {
    try {
      await ensureDriversModuleType(driversDir, logger);
    } catch (moduleTypeError) {
      logger.warn(`drivers 目录的 package.json 写入失败（不影响已有驱动）：${describeFailure(moduleTypeError)}`);
    }
  }

  for (const driverFileName of driverFileNames) {
    const driverFilePath = path.join(driversDir, driverFileName);
    try {
      const exportedDriver = await importDriverFile(driverFilePath);
      const driver = assertDriverShape(exportedDriver, `驱动文件 ${driverFileName}`);
      if (availableDrivers.has(driver.id)) {
        throw new Error(`驱动 id 与已注册驱动重复 -> ${driver.id}`);
      }
      availableDrivers.set(driver.id, driver);
      driverLoadRecords.set(driverFilePath, {
        source: driverFilePath,
        id: driver.id,
        accessMode: driver.accessMode,
        status: DRIVER_STATUSES.AVAILABLE,
        message: null,
      });
    } catch (loadError) {
      // 记录失败明细：网关与前端都能看到"这个文件为什么没生效"，但流程继续
      driverLoadRecords.set(driverFilePath, {
        source: driverFilePath,
        id: driverFileName.replace(DRIVER_FILE_EXTENSION, ''),
        accessMode: null,
        status: DRIVER_STATUSES.FAILED,
        message: describeFailure(loadError),
      });
      logger.warn(`驱动加载失败，已隔离并跳过：${driverFileName}（${describeFailure(loadError)}）`);
    }
  }

  const statuses = listDriverStatuses();
  return {
    statuses,
    availableCount: statuses.filter((record) => record.status === DRIVER_STATUSES.AVAILABLE).length,
    failedCount: statuses.filter((record) => record.status === DRIVER_STATUSES.FAILED).length,
  };
}

// 取单个驱动实现（网关转发前用）
export function getDriver(driverId) {
  return availableDrivers.get(driverId) ?? null;
}

// 加载记录明细（含 failed 与失败原因），按来源排序便于稳定展示
export function listDriverStatuses() {
  return [...driverLoadRecords.values()].sort((leftRecord, rightRecord) => leftRecord.source.localeCompare(rightRecord.source));
}

// 对外元数据（DriverMeta，见 M0 数据模型）：只暴露前端渲染需要的字段，不外泄实现
function toDriverMeta(driver) {
  const driverMeta = {
    id: driver.id,
    name: driver.name,
    accessMode: driver.accessMode,
    authSchema: driver.authSchema,
  };
  if (typeof driver.avatar === 'string' && driver.avatar.length > 0) {
    driverMeta.avatar = driver.avatar;
  }
  return driverMeta;
}

// 驱动列表：official 在前、同类按 id 稳定排序
export function listDrivers() {
  return [...availableDrivers.values()]
    .sort((leftDriver, rightDriver) => {
      const accessModeGap = ACCESS_MODE_SORT_WEIGHT[leftDriver.accessMode] - ACCESS_MODE_SORT_WEIGHT[rightDriver.accessMode];
      if (accessModeGap !== 0) {
        return accessModeGap;
      }
      return leftDriver.id.localeCompare(rightDriver.id);
    })
    .map(toDriverMeta);
}

// 模块加载即装好内置驱动，调用方不必先手动 register
resetDriverRegistry();
