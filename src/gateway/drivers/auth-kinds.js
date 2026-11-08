// 驱动的认证形态：配置型驱动用 API Key 引用，账号型驱动用 account:<platformId>/<accountId> 引用。
//
// 为什么单独一个文件：驱动注册表（index.js）会 import 各内置驱动，若驱动反过来 import index
// 取常量就形成循环依赖，常量在驱动对象初始化时可能还没赋值。真源放这里，index.js 原样再导出，
// 既有 import 路径（from './index.js'）保持不变。
//
// ⚠️ 这些**值是对外契约的一部分**（已存的群配置与驱动描述符里就是这些字面量）：
//    重命名常量可以，改值等于破坏存量配置与前端判别，必须有迁移方案。
export const AUTH_KINDS = Object.freeze({
  API_KEY: 'api-key',
  REVERSE_ACCOUNT: 'reverse-account',
});
