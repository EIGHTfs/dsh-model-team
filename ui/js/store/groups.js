// store-groups.js —— 群列表与平台清单的加载（四个接口逐接口容错）。
// 依赖以参数注入，模块内不引用全局状态，便于单独验证"一个接口失败不清空其它数据"。

// 有界重试调度：只对失败的接口重拉，成功的那几份由调用方负责保留。
// 放在模块级（而不是塞进 createGroupLoaders）是为了两件事：
//   ① 工厂函数保持可读——它只管"怎么取数/怎么落到 state"，重试流程单独一段；
//   ② 这段逻辑与具体 store 无关，坏了好定位。
// options.fetchOnce(indices) -> Promise<{ failedIndices, rejectionReasons }>
// options.onRound(result)    -> 需要重试的下标数组（返回空数组表示收工）
function runGroupLoadsWithRetry(options) {
  var retryDelays = options.retryDelays;
  var schedule = options.schedule;
  var describeName = options.describeName;
  var pendingIndices = options.initialIndices;
  var retryRound = 0;

  function runRound() {
    return options.fetchOnce(pendingIndices).then(function (fetchResult) {
      var failedForRetry = options.onRound(fetchResult) || [];
      if (failedForRetry.length === 0) return options.finalResult();
      if (retryRound >= retryDelays.length) return options.finalResult();

      retryRound += 1;
      pendingIndices = failedForRetry;
      var failedNameList = failedForRetry.map(describeName).join('、');
      if (typeof console !== 'undefined' && console.info) {
        console.info('[groups] 第 ' + retryRound + ' 轮重试 ← ' + failedNameList);
      }
      return new Promise(function (resolve) {
        schedule(function () { resolve(runRound()); }, retryDelays[retryRound - 1]);
      });
    });
  }

  return runRound();
}

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
  // 启动加载的四个接口：下标稳定（0=groups 是"群列表本身"，重试判定要用到）
  var GROUP_REQUEST_NAMES = ['groups', 'drivers', 'friend-groups', 'platforms'];
  // 有界重试：第一次失败多半是"宿主路由还没就绪/冷启慢"；不重试会让 state.groups 永久为空
  var DEFAULT_GROUP_RETRY_DELAYS_MS = [500, 2000];

  function fetchGroupRequests(indices) {
    var requests = indices.map(function (index) {
      if (index === 0) return api.getGroups();
      if (index === 1) return api.getDrivers();
      if (index === 2) return api.getFriendGroups();
      return api.getPlatforms();
    });
    return Promise.all(requests.map(function (request) {
      // 每个请求都兜成 settled：allSettled 在旧 WebView 上不一定有，这里不依赖它
      return Promise.resolve(request).then(
        function (value) { return { status: 'fulfilled', value: value }; },
        function (reason) { return { status: 'rejected', reason: reason }; },
      );
    })).then(function (settled) {
      var failedIndices = [];
      var rejectionReasons = {};
      settled.forEach(function (entry, position) {
        var index = indices[position];
        if (entry.status === 'rejected') {
          failedIndices.push(index);
          rejectionReasons[index] = entry.reason;
          reportError('load-groups:' + GROUP_REQUEST_NAMES[index], entry.reason);
          return;                       // 保留上一份数据，绝不清空
        }
        var value = entry.value;
        if (index === 0) state.groups = value || [];
        else if (index === 1) state.drivers = value || [];
        else if (index === 2) state.friendGroups = value && value.groups ? value.groups : [];
        else state.platforms = value || [];
      });
      return { failedIndices: failedIndices, rejectionReasons: rejectionReasons };
    });
  }

  // options 可注入调度器与延迟（单测里同步跑完整条重试链，避免真实 sleep）
  function loadGroups(options) {
    var settings = options || {};
    var retryDelays = Array.isArray(settings.retryDelays) ? settings.retryDelays : DEFAULT_GROUP_RETRY_DELAYS_MS;
    var schedule = typeof settings.schedule === 'function'
      ? settings.schedule
      : function (run, delayMs) { return setTimeout(run, delayMs); };

    apiFailureSink.groups = null;
    return runGroupLoadsWithRetry({
      retryDelays: retryDelays,
      schedule: schedule,
      initialIndices: [0, 1, 2, 3],
      describeName: function (index) { return GROUP_REQUEST_NAMES[index]; },
      fetchOnce: function (indices) {
        apiFailureSink.groups = null;    // 每轮重新判定：上一轮的失败不能算到这一轮
        return fetchGroupRequests(indices);
      },
      onRound: function (fetchResult) {
        // apiJson 把非 2xx/网络失败吞成 null（不进 rejected 分支），所以群列表本身
        // 还要单独看 apiFailureSink.groups —— 两者任一都算失败。
        var failedForRetry = fetchResult.failedIndices.slice();
        if (apiFailureSink.groups && failedForRetry.indexOf(0) < 0) failedForRetry.push(0);
        var failed = fetchResult.failedIndices.map(function (index) { return GROUP_REQUEST_NAMES[index]; });
        // 错误原因要尽量具体：界面靠它区分"接口失败"与"确实没有群"
        state.lastGroupsError = apiFailureSink.groups
          || (fetchResult.failedIndices.indexOf(0) >= 0 ? describeLoadFailure(fetchResult.rejectionReasons[0]) : null);
        if (!state.currentGroupId && state.groups.length) state.currentGroupId = state.groups[0].id;
        broadcast('groups:updated', { groups: state.groups, failed: failed });
        if (failedForRetry.length === 0) state.lastGroupsError = null;   // 成功即清空失败态
        return failedForRetry;
      },
      finalResult: function () { return state.groups; },
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
