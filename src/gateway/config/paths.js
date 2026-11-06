// 数据根路径解析：config.json、drivers/ 等全部持久化文件挂在同一个数据根下。
// 需求意图：同一份代码要能跑在多台机器与多个实例上，落盘位置不能写死，必须由部署侧决定。
// 思路（三档，逐级回落）：
//   1) DSH_MODEL_TEAM_HOME —— 显式覆盖（测试 / 多实例隔离 / 迁移都走它）；
//   2) DSH_HOME 非空     —— 挂到 <DSH_HOME>/dsh-model-team；DSH_HOME 由宿主/系统提供，
//                          它带版本号这一层由系统负责，我们只负责「认它」；
//   3) 家目录缺省         —— <home>/.dsh-model-team（没有宿主上下文的裸跑场景）。
// 为什么第 2 档要认 DSH_HOME：HOME 在套件部署里也带版本号，升级换目录时按 homedir 推导会
// 直接指向一个新空目录（真实事故：升级后 0 个群 + 凭据缺失）。
// 解析时实时读环境，不做模块级常量缓存——否则测试注入环境变量后会一直拿到首次解析的旧值。

import os from 'node:os';
import path from 'node:path';

// 部署侧覆盖数据根的变量名（多实例隔离、测试临时根、迁移都走它）
export const DATA_ROOT_ENV_VAR = 'DSH_MODEL_TEAM_HOME';

// 宿主数据根的变量名（系统提供、只读；我们只在它下面挂自己的目录）
export const DSH_HOME_ENV_VAR = 'DSH_HOME';

// 挂在 DSH_HOME 下的目录名（**与家目录缺省值区分开**：一个是 dsh-model-team，一个是 .dsh-model-team）
export const DATA_DIRECTORY_NAME = 'dsh-model-team';

// 缺省数据目录名：跟随 Node CLI 在家目录下放隐藏目录的惯例
export const DEFAULT_DATA_DIRECTORY_NAME = '.dsh-model-team';

// 数据根内的固定文件名与子目录名集中在此，调用方不再各自拼字符串
export const CONFIG_FILE_NAME = 'config.json';
export const DRIVERS_DIRECTORY_NAME = 'drivers';
export const SESSIONS_DIRECTORY_NAME = 'sessions';
export const STATS_DIRECTORY_NAME = 'stats';
export const SESSION_MAPPING_EXTENSION = '.json';
export const SESSION_EVENTS_EXTENSION = '.events.jsonl';
export const REQUEST_ROWS_FILE_NAME = 'requests.jsonl';
export const GROUP_STATE_FILE_NAME = 'groups-state.json';

// 读一个环境变量并归一：空串 / 纯空白视为未设置（与既有口径一致）
function readEnvironmentText(environment, variableName) {
  const rawValue = environment?.[variableName];
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) return null;
  return rawValue.trim();
}

// 解析数据根（三档优先级，见文件头）：空串与纯空白一律视为未设置
export function getDataRoot(environment = process.env, homeDirectory = os.homedir()) {
  const configuredRoot = readEnvironmentText(environment, DATA_ROOT_ENV_VAR);
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }
  const dshHome = readEnvironmentText(environment, DSH_HOME_ENV_VAR);
  if (dshHome) {
    // path.join + path.resolve：尾斜杠不会产生 `//`，相对路径也会被归一成绝对路径
    return path.resolve(path.join(dshHome, DATA_DIRECTORY_NAME));
  }
  return path.join(homeDirectory, DEFAULT_DATA_DIRECTORY_NAME);
}

// 配置文件绝对路径
export function getConfigPath(dataRoot = getDataRoot()) {
  return path.join(dataRoot, CONFIG_FILE_NAME);
}

// 外挂驱动目录绝对路径（运行时扫描该目录下的 .js）
export function getDriversDirectory(dataRoot = getDataRoot()) {
  return path.join(dataRoot, DRIVERS_DIRECTORY_NAME);
}

// 会话映射与事件流的存放目录
export function getSessionsDirectory(dataRoot = getDataRoot()) {
  return path.join(dataRoot, SESSIONS_DIRECTORY_NAME);
}

// 请求行（RequestRow）存放目录
export function getStatsDirectory(dataRoot = getDataRoot()) {
  return path.join(dataRoot, STATS_DIRECTORY_NAME);
}

// 会话映射文件：<数据根>/sessions/<安全文件名>.json（文件名由 session-store 负责编码）
export function getSessionMappingPath(sessionFileName, dataRoot = getDataRoot()) {
  return path.join(getSessionsDirectory(dataRoot), `${sessionFileName}${SESSION_MAPPING_EXTENSION}`);
}

// 会话事件流文件：追加式 JSONL，前端按行读即可
export function getSessionEventsPath(sessionFileName, dataRoot = getDataRoot()) {
  return path.join(getSessionsDirectory(dataRoot), `${sessionFileName}${SESSION_EVENTS_EXTENSION}`);
}

// 请求行文件：全量追加 + 环形截断
export function getRequestRowsPath(dataRoot = getDataRoot()) {
  return path.join(getStatsDirectory(dataRoot), REQUEST_ROWS_FILE_NAME);
}

// 好友分组的轮询游标状态（INV-12：必须落盘，重启不能清零）
export function getGroupStatePath(dataRoot = getDataRoot()) {
  return path.join(dataRoot, GROUP_STATE_FILE_NAME);
}
