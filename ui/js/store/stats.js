// store-stats.js —— 全局统计与会话目标加载（目标决定"当前群聊看哪个群"）。
// loadChat 由装配层注入（stats 依赖 chat 的加载结果，反过来 chat 不依赖 stats，避免循环）。

function createStatsLoaders(deps) {
  var api = deps.api;
  var state = deps.state;
  var broadcast = deps.broadcast;
  var loadChat = deps.loadChat;

  // 群聊默认显示「该会话目标所属的群」（契约条款 25）：
  // 目标是单模型 → 切到 target.platformId 对应的群；目标是分组或未设置 → 保留当前群聊；
  // 目标群不存在 → 回落当前群，再回落到第一个群。
  function pickGroupIdForTarget(target, groups, fallbackGroupId) {
    var groupList = groups || [];
    if (target && target.type === 'model' && target.platformId) {
      var matched = groupList.filter(function (group) { return group.id === target.platformId; })[0];
      if (matched) return matched.id;
    }
    if (fallbackGroupId && groupList.some(function (group) { return group.id === fallbackGroupId; })) {
      return fallbackGroupId;
    }
    return (groupList[0] && groupList[0].id) || '';
  }

  function loadStats() {
    // 速率按「当前群聊」统计：把群 id 传给服务端，由服务端按群筛行后算值
    // （不传就会把别的群的 token 与耗时也算进来，面板数字与标题对不上）
    return api.getGlobalStats({ groupId: state.currentGroupId }).then(function (stats) {
      state.rate = stats && stats.sessionRate ? stats.sessionRate : RATE_PLACEHOLDER_TEXT;
      state.global = {
        requests: stats && typeof stats.totalRows === 'number' ? stats.totalRows : 0,
        tokens: stats && typeof stats.totalTokens === 'number' ? stats.totalTokens : 0,
        text: stats ? stats.globalRequests + ' (' + stats.globalTokens + ')' : '—'
      };
      broadcast('stats:updated', { rate: state.rate, global: state.global });
    });
  }

  function loadTargetAndStats() {
    if (!state.sessionId) {
      state.target = null;
      broadcast('target:changed', { target: null });
      return loadStats();
    }
    return api.getSessionTarget(state.sessionId).then(function (payload) {
      // 后端出参：{ target, effectiveTarget, targetSource }；旧出参已被 api 层归一化成同形
      state.target = payload && payload.target ? payload.target : null;
      state.effectiveTarget = payload && payload.effectiveTarget ? payload.effectiveTarget : state.target;
      state.targetSource = payload && payload.targetSource ? payload.targetSource : 'none';
      // 群聊跟着「实际生效的目标」走（不是显式绑定，否则新会话会落到旧群）
      var nextGroupId = pickGroupIdForTarget(state.effectiveTarget, state.groups, state.currentGroupId);
      if (nextGroupId) state.currentGroupId = nextGroupId;
      broadcast('target:changed', { target: state.effectiveTarget, groupId: state.currentGroupId });
      return loadStats();
    }).then(function () {
      return loadChat(state.currentGroupId);
    });
  }

  return { loadStats: loadStats, loadTargetAndStats: loadTargetAndStats, pickGroupIdForTarget: pickGroupIdForTarget };
}
