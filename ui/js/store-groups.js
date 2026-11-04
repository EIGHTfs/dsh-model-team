// store-groups.js —— 群列表与平台清单的加载（四个接口逐接口容错）。
// 依赖以参数注入，模块内不引用全局状态，便于单独验证"一个接口失败不清空其它数据"。

function createGroupLoaders(deps) {
  var api = deps.api;
  var state = deps.state;
  var broadcast = deps.broadcast;
  var reportError = deps.reportError;
  // api.js 的失败上报通道把 /groups 的失败写进这里（apiJson 对失败只上报不 reject，
  // 只看 Promise 状态会把 500 当成"成功返回空"）
  var apiFailureSink = deps.apiFailureSink || { groups: null };

  // 失败原因给渲染层看的一句话（不含栈，避免把内部细节写进界面）
  function describeLoadFailure(reason) {
    if (!reason) return '接口无响应';
    if (typeof reason === 'string') return reason;
    return reason.message ? String(reason.message) : String(reason);
  }

  // 四个接口并发拉，但**任一失败不许清空其它三份**：
  // Promise.all 的"一败全败"会让单个 500（如 platforms 挂掉）把群列表也变成空，
  // 而界面上只会显示"0 个群"，与真实数据矛盾（实测过）。
  function loadGroups() {
    apiFailureSink.groups = null;
    var requests = [api.getGroups(), api.getDrivers(), api.getFriendGroups(), api.getPlatforms()];
    var requestNames = ['groups', 'drivers', 'friend-groups', 'platforms'];
    return Promise.all(requests.map(function (request) {
      // 每个请求都兜成 settled：allSettled 在旧 WebView 上不一定有，这里不依赖它
      return Promise.resolve(request).then(
        function (value) { return { status: 'fulfilled', value: value }; },
        function (reason) { return { status: 'rejected', reason: reason }; },
      );
    })).then(function (settled) {
      var failed = [];
      settled.forEach(function (entry, index) {
        if (entry.status === 'rejected') {
          failed.push(requestNames[index]);
          reportError('load-groups:' + requestNames[index], entry.reason);
          return;                       // 保留上一份数据，绝不清空
        }
        var value = entry.value;
        if (index === 0) state.groups = value || [];
        else if (index === 1) state.drivers = value || [];
        else if (index === 2) state.friendGroups = value && value.groups ? value.groups : [];
        else state.platforms = value || [];
      });
      // 群列表的成功与失败要分开记：三条来源都算失败——Promise 被 reject、
      // apiJson 上报的 HTTP/JSON/网络失败（它不会 reject）、以及返回 null。
      state.lastGroupsError = apiFailureSink.groups
        || (settled[0].status === 'rejected' ? describeLoadFailure(settled[0].reason) : null);
      if (!state.currentGroupId && state.groups.length) state.currentGroupId = state.groups[0].id;
      broadcast('groups:updated', { groups: state.groups, failed: failed });
      return state.groups;
    });
  }

  // 只刷新平台清单：平台预置是数据文件（config/platforms.json 或 <dataRoot>/platforms.json），
  // 运行时可能被修改，因此每次进入「加群」视图都要重取，不能只在启动时拉一次。
  function loadPlatforms() {
    return api.getPlatforms().then(function (platforms) {
      state.platforms = platforms || [];
      broadcast('platforms:updated', { platforms: state.platforms });
      return state.platforms;
    });
  }

  return { describeLoadFailure: describeLoadFailure, loadGroups: loadGroups, loadPlatforms: loadPlatforms };
}
