// constants.js —— 客户端常量：请求前缀单点声明，防漂移测试读产物里的这一行。
// 持久化键（anchor / last-session）归 store.js 持有，这里不再重复定义。
var API_PREFIX = "/_team"; // 与服务端 src/gateway/constants.js 保持一致（有测试守护）
var API_TIMEOUT_MS = 8000;
var LOG_PREFIX = "dsh-model-team";
var STATS_REFRESH_MS = 30000;

// INV-14：只有当前 session 选中本插件的虚拟模型时才显示悬浮窗。
// provider 是 llm 适配器注册的路由名（src/plugin/adapter.js DEFAULT_PROVIDER_ID），
// model 是 config.virtualModel 的缺省值 —— 两个字段分开比，不能混。
// 这两个字面量必须与服务端一致，test/prefix.test.js 守漂移。
var OUR_PROVIDER_ID = "dsh-model-team";
var VIRTUAL_MODEL_ID = "dsh-model-team";
// 宿主 projection 的取键（ui-model-selection 插件负责投影）
var MODEL_SELECTION_PROJECTION_KEY = "modelSelection";
