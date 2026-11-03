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
