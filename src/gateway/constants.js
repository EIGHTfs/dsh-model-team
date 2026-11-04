import { readFileSync } from 'node:fs';

// 出站默认 User-Agent：不设置时 Node 的 undici 会发字面量 `node`，
// 上游无法区分"正规客户端"与"滥用脚本"，被限流也没法申诉。
// 版本号从 package.json 读（不硬编码，发版自动跟随）；读不到就回落包名，绝不让插件因为读配置失败起不来。
// 明确**不伪装浏览器 UA**：API 请求带浏览器 UA 反而是风控可疑信号。
const PACKAGE_JSON_URL = new URL('../../package.json', import.meta.url);

function readPackageVersion() {
  try {
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_URL, 'utf8'));
    return typeof packageJson.version === 'string' ? packageJson.version : '';
  } catch (readError) {
    return '';
  }
}

// 可注入版本读取器：单测用它模拟"读 package.json 失败"，不必真去改仓库文件
export function resolveDefaultUserAgent(readVersion = readPackageVersion) {
  let version = '';
  try { version = String(readVersion() || '').trim(); } catch (readError) { version = ''; }
  return version ? `dsh-model-team/${version}` : 'dsh-model-team';
}

export const DEFAULT_USER_AGENT = resolveDefaultUserAgent();

// 端点公共前缀：唯一事实来源（服务端所有路由注册、路径匹配、日志与错误提示都从这里取）。
// 改名/换前缀只改这一行；客户端半部不能 import 本文件，靠 test/prefix-drift.test.js 防漂移。
export const API_PREFIX = '/_team';

// HTTP 状态码：多处复用，集中在这里避免各文件各写一份字面量
export const HTTP_STATUS = Object.freeze({
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  INTERNAL_ERROR: 500,
  UPSTREAM_ERROR: 502,
  UPSTREAM_TIMEOUT: 504,
});

// 原子写的临时文件后缀（配置/游标/请求行共用同一约定）
export const TEMPORARY_FILE_SUFFIX = '.tmp';

// 人工可读 JSON 的缩进宽度（配置与状态文件会被手工打开）
export const JSON_INDENT_WIDTH = 2;
