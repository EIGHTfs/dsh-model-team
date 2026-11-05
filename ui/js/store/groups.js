// store-groups.js —— 群列表与平台清单的加载（四个接口逐接口容错）。
// 依赖以参数注入，模块内不引用全局状态，便于单独验证"一个接口失败不清空其它数据"。
//
// 结构：本文件所有函数都是"传 context 进来做一件事"，工厂只负责组装依赖 ——
// 原来这些都挤在 createGroupLoaders 一个函数里（116 行代码、嵌套 5 层），
// 改一条重试规则要连着广播、归因、落表一起重读。

// 启动加载的四个接口：下标稳定（0=groups 是"群列表本身"，重试判定要用到）
var GROUP_REQUEST_NAMES = ['groups', 'drivers', 'friend-groups', 'platforms'];
// 有界重试：第一次失败多半是"宿主路由还没就绪/冷启慢"；不重试会让 state.groups 永久为空
var DEFAULT_GROUP_RETRY_DELAYS_MS = [500, 2000];

// 有界重试调度：只对失败的接口重拉，成功的那几份由调用方负责保留。
// 与具体 store 无关，所以单独放在模块级。
// options.fetchOnce(indices) -> Promise<{ failedIndices, rejectionReasons }>
// options.onRound(result)    -> 需要重试的下标数组（返回空数组表示收工）
function runGroupLoadsWithRetry(options) {
  var retryDelays = options.retryDelays;
  var schedule = options.schedule;
  var describeName = options.describeName;
  var pendingIndices = options.initialIndices;
  var retryRound = 0;

  function runRound() {
    return options.fetchOnce(pendingIndices).then(handleRoundResult);
  }

  // 一轮收尾：先问调用方还要不要重试，不再重试就出结果（早返回，避免层层 if 缩进）
  function handleRoundResult(fetchResult) {
    var failedForRetry = options.onRound(fetchResult) || [];
    if (failedForRetry.length === 0) return options.finalResult();
    if (retryRound >= retryDelays.length) return options.finalResult();

    retryRound += 1;
    pendingIndices = failedForRetry;
    logRetryRound(failedForRetry);
    return waitThenRunNextRound();
  }

  function logRetryRound(failedIndices) {
    if (typeof console === 'undefined' || !console.info) return;
    var failedNameList = failedIndices.map(describeName).join('、');
    console.info('[groups] 第 ' + retryRound + ' 轮重试 ← ' + failedNameList);
  }

  function waitThenRunNextRound() {
    return new Promise(function (resolve) {
      schedule(function () { resolve(runRound()); }, retryDelays[retryRound - 1]);
    });
  }

  return runRound();
}

// 失败原因给渲染层看的一句话（不含栈，避免把内部细节写进界面）
function describeLoadFailure(reason) {
  if (!reason) return '接口无响应';
  if (typeof reason === 'string') return reason;
  return reason.message ? String(reason.message) : String(reason);
}

// 单个请求兜成 settled：不依赖 Promise.allSettled（旧 WebView 上不一定有）
function settleRequest(request) {
  return Promise.resolve(request).then(
    function (value) { return { status: 'fulfilled', value: value }; },
    function (reason) { return { status: 'rejected', reason: reason }; }
  );
}

// 落结果：失败的接口保留上一份数据（绝不清空），成功的按表写进 state
function applySettledResults(context, indices, settled) {
  var failedIndices = [];
  var rejectionReasons = {};
  settled.forEach(function (entry, position) {
    var index = indices[position];
    if (entry.status === 'rejected') {
      failedIndices.push(index);
      rejectionReasons[index] = entry.reason;
      context.reportError('load-groups:' + context.names[index], entry.reason);
      return;                       // 保留上一份数据，绝不清空
    }
    context.appliers[index](entry.value);
  });
  return { failedIndices: failedIndices, rejectionReasons: rejectionReasons };
}

// 四个接口并发拉，但**任一失败不许清空其它三份**：
// Promise.all 的"一败全败"会让单个 500（如 platforms 挂掉）把群列表也变成空，
// 而界面上只会显示"0 个群"，与真实数据矛盾（实测过）。
function fetchGroupRequests(context, indices) {
  var requests = indices.map(function (index) { return context.fetchers[index](); });
  return Promise.all(requests.map(settleRequest)).then(function (settled) {
    return applySettledResults(context, indices, settled);
  });
}

// 需要重试的下标：接口层失败的 + 群列表本身被 apiFailureSink 标记失败的
function collectRetryIndices(context, fetchResult) {
  var failedForRetry = fetchResult.failedIndices.slice();
  if (context.apiFailureSink.groups && failedForRetry.indexOf(0) < 0) failedForRetry.push(0);
  return failedForRetry;
}

// 失败归因：apiJson 把非 2xx/网络失败吞成 null（不进 rejected 分支），
// 所以群列表本身还要单独看 apiFailureSink —— 两者任一都算失败。
// 错误原因要尽量具体：界面靠它区分"接口失败"与"确实没有群"
function resolveGroupsLoadError(context, fetchResult) {
  if (context.apiFailureSink.groups) return context.apiFailureSink.groups;
  if (fetchResult.failedIndices.indexOf(0) >= 0) return describeLoadFailure(fetchResult.rejectionReasons[0]);
  return null;
}

// 没有当前群时落到第一个群：刷新后不该出现"有群但没选中"
function ensureCurrentGroupSelected(state) {
  if (!state.currentGroupId && state.groups.length) state.currentGroupId = state.groups[0].id;
}

// 广播：群列表变化统一从这里出，界面只订阅、不自己判断成败
function broadcastGroupsUpdate(context, fetchResult) {
  var failed = fetchResult.failedIndices.map(function (index) { return context.names[index]; });
  context.broadcast('groups:updated', { groups: context.state.groups, failed: failed });
}

// 依赖与两张表（取数 / 落 state）在这里组装：工厂只持有 context，不自己攒一堆局部变量
function createGroupLoadContext(deps) {
  var api = deps.api;
  var state = deps.state;
  return {
    api: api,
    state: state,
    broadcast: deps.broadcast,
    reportError: deps.reportError,
    // api.js 的失败上报通道把 /groups 的失败写进这里（apiJson 对失败只上报不 reject，
    // 只看 Promise 状态会把 500 当成"成功返回空"）
    apiFailureSink: deps.apiFailureSink || { groups: null },
    names: GROUP_REQUEST_NAMES,
    fetchers: [
      function () { return api.getGroups(); },
      function () { return api.getDrivers(); },
      function () { return api.getFriendGroups(); },
      function () { return api.getPlatforms(); }
    ],
    appliers: [
      function (value) { state.groups = value || []; },
      function (value) { state.drivers = value || []; },
      // 好友分组接口返回的是 { groups }，取内层数组；形状不对时给空数组而不是 undefined
      function (value) { state.friendGroups = value && value.groups ? value.groups : []; },
      function (value) { state.platforms = value || []; }
    ]
  };
}

// options 可注入调度器与延迟（单测里同步跑完整条重试链，避免真实 sleep）
function loadGroupsWith(context, options) {
  var settings = options || {};
  var retryDelays = Array.isArray(settings.retryDelays) ? settings.retryDelays : DEFAULT_GROUP_RETRY_DELAYS_MS;
  var schedule = typeof settings.schedule === 'function'
    ? settings.schedule
    : function (run, delayMs) { return setTimeout(run, delayMs); };

  context.apiFailureSink.groups = null;
  return runGroupLoadsWithRetry({
    retryDelays: retryDelays,
    schedule: schedule,
    initialIndices: [0, 1, 2, 3],
    describeName: function (index) { return context.names[index]; },
    fetchOnce: function (indices) {
      context.apiFailureSink.groups = null;    // 每轮重新判定：上一轮的失败不能算到这一轮
      return fetchGroupRequests(context, indices);
    },
    onRound: function (fetchResult) {
      // 顺序有讲究：先算重试集，再归因、回落当前群、广播，最后按"这轮是否全成功"清失败态
      var failedForRetry = collectRetryIndices(context, fetchResult);
      context.state.lastGroupsError = resolveGroupsLoadError(context, fetchResult);
      ensureCurrentGroupSelected(context.state);
      broadcastGroupsUpdate(context, fetchResult);
      if (failedForRetry.length === 0) context.state.lastGroupsError = null;   // 成功即清空失败态
      return failedForRetry;
    },
    finalResult: function () { return context.state.groups; }
  });
}

// 只刷新平台清单：平台预置是数据文件（config/platforms.json 或 <dataRoot>/platforms.json），
// 运行时可能被修改，因此每次进入「加群」视图都要重取，不能只在启动时拉一次。
function loadPlatformsWith(context) {
  return context.api.getPlatforms().then(function (platforms) {
    context.state.platforms = platforms || [];
    context.broadcast('platforms:updated', { platforms: context.state.platforms });
    return context.state.platforms;
  });
}

function createGroupLoaders(deps) {
  var context = createGroupLoadContext(deps);
  return {
    describeLoadFailure: describeLoadFailure,
    loadGroups: function (options) { return loadGroupsWith(context, options); },
    loadPlatforms: function () { return loadPlatformsWith(context); }
  };
}
