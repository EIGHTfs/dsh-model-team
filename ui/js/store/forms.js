// forms.js —— 表单类动作：加群 / 探测模型 / 导出导入 / 反代登录。
//
// 为什么单独一个模块：这些动作不写 store 状态（表单草稿归调用方），只做"调一次接口、把结果原样交回"。
// 把它们塞进 loaders 会让「拉数据」与「提交数据」混在一起，也让 loaders 的容错口径被误用
// （提交失败必须把原因抛给界面，不能像列表加载那样吞成空值）。
//
// 错误口径：一律 reject 出带 message 的 Error（服务端原文），调用方直接显示，不自己编文案。

function createFormActions(deps) {
  var api = deps.api;

  return {
    // 加群：成功回 { group }，失败 reject（服务端 message 原样带出）
    addGroup: function (payload) { return api.createGroup(payload); },
    // 探测可用模型：主题只给结构化输入，**线格式（含 driverId 字段名）在这里组装**——
    // 让界面代码不必记住接口字段名，改名也只改这一处。
    // 回 { models: [...] } 或 { error: { message } }（不抛，形状由服务端定）
    probeModels: function (input) {
      var request = input || {};
      var payload = { driverId: request.driver };
      if (request.accountRef) {
        payload.apiKeyRef = request.accountRef;
      } else {
        payload.baseURL = request.baseURL || '';
        payload.modelsEndpoint = '/models';
        payload.apiKey = request.apiKey || '';
      }
      return api.probeModels(payload);
    },
    // 导出备份：回完整备份对象（调用方负责触发下载）
    exportConfig: function () { return api.exportConfig(); },
    // 导入：回 { imported, updated, rejected } 回执
    importConfig: function (payload) { return api.importConfig(payload); },
    // 反代账号列表（服务端脱敏：不含 token）
    loadReverseAccounts: function (platformId) { return api.getReverseAccounts(platformId); },
    // 发起设备码登录：回 { loginUrl, sessionId, reused }
    startReverseLogin: function (platformId) { return api.startReverseLogin(platformId); },
    // 按平台轮询：回 { ok, status, body }（要区分 404/5xx，所以不能走 apiJson）
    pollReverseLogin: function (platformId) { return api.getReverseLoginStatusRaw(platformId); }
  };
}
