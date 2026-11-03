// constants.js —— 客户端常量：请求前缀单点声明，防漂移测试读产物里的这一行。
// 持久化键（anchor / last-session）归 store.js 持有，这里不再重复定义。
var API_PREFIX = "/_team"; // 与服务端 src/gateway/constants.js 保持一致（有测试守护）
var API_TIMEOUT_MS = 8000;
var LOG_PREFIX = "dsh-model-team";
var STATS_REFRESH_MS = 30000;
