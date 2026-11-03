// constants.js —— 客户端常量：请求前缀单点声明，防漂移测试读产物里的这一行。
// 持久化键（anchor / last-session）归 store.js 持有，这里不再重复定义。
var API_PREFIX = "/_team"; // 与服务端 src/gateway/constants.js 保持一致（有测试守护）
var API_TIMEOUT_MS = 8000;
var LOG_PREFIX = "dsh-model-team";
var STATS_REFRESH_MS = 30000;

// INV-14 的判定依据（虚拟模型名 / 注册路由名）不在客户端写死：
// 两者都可由部署方改（config.virtualModel / options.providerIds），改完客户端必须跟着走，
// 所以启动时从 GET /_team/meta 取（契约 02 §3.8）。
// 宿主 projection 的取键（ui-model-selection 插件负责投影）
var MODEL_SELECTION_PROJECTION_KEY = "modelSelection";
