// api-mock-transport.js —— 设计稿专用的假数据源：只提供「路径 → 假 JSON」，不定义任何接口方法。
// 接口名、路径、返回结构统一在 lib/client-parts/foundation/api-real.js（唯一一份）。
// 新增接口时这里只需补一条路由；没补的路径统一返回 { ok: true }，不会把预览页炸掉。

const MOCK_API_ROUTES = [
  {
    pattern: /^\/drivers$/,
    reply: function () { return { drivers: MOCK_DRIVERS }; }
  },
  {
    pattern: /^\/platforms$/,
    reply: function () { return { platforms: MOCK_PLATFORMS }; }
  },
  {
    pattern: /^\/groups$/,
    reply: function () { return { groups: MOCK_GROUPS }; }
  },
  {
    pattern: /^\/groups\/([^/]+)\/models$/,
    reply: function (matched) { return { models: MOCK_MODELS_BY_GROUP[matched[1]] || [] }; }
  },
  {
    pattern: /^\/groups\/([^/]+)$/,
    reply: function (matched) {
      return MOCK_GROUPS.filter(function (group) { return group.id === matched[1]; })[0] || null;
    }
  },
  {
    pattern: /^\/friend-groups$/,
    reply: function () { return { groups: MOCK_FRIEND_GROUPS }; }
  },
  {
    pattern: /^\/sessions\/current$/,
    reply: function () { return { sessionId: MOCK_SESSION_ID, activeAt: new Date().toISOString() }; }
  },
  {
    pattern: /^\/session\/([^/]+)\/target$/,
    reply: function (matched) {
      // 直接透出新出参结构：{ target, effectiveTarget, targetSource }
      const bySession = MOCK_TARGET_BY_SESSION[matched[1]];
      if (bySession) return bySession;
      const fallbackTarget = MOCK_SESSION_TARGET[matched[1]] || null;
      return { target: fallbackTarget, effectiveTarget: fallbackTarget, targetSource: fallbackTarget ? 'explicit' : 'none' };
    }
  },
  {
    pattern: /^\/session\/([^/]+)\/events$/,
    reply: function (matched) { return { events: MOCK_SESSION_EVENTS[matched[1]] || [] }; }
  },
  {
    pattern: /^\/stats\/session\/([^/]+)$/,
    reply: function (matched) { return { rows: MOCK_ROWS_BY_GROUP[matched[1]] || [] }; }
  },
  {
    pattern: /^\/models\/probe$/,
    reply: function (_matched) {
      const lastProbe = MOCK_PROBE_REQUEST;
      const apiKey = String((lastProbe && lastProbe.apiKey) || '');
      if (!apiKey) {
        return { error: { code: 'probe-unauthorized', message: 'missing api key', hint: '请在接入信息里填写 API Key' } };
      }
      if (apiKey.indexOf('bad') === 0) {
        return { error: { code: 'probe-unauthorized', message: 'unauthorized', hint: '平台返回 401' } };
      }
      if (apiKey.indexOf('slow') === 0) {
        return { error: { code: 'probe-timeout', message: 'timeout', hint: '上游 15s 未响应' } };
      }
      return {
        models: [
          { id: 'agnes-3.0-flash', name: 'agnes-3.0-flash' },
          { id: 'agnes-2.5-flash', name: 'agnes-2.5-flash' },
          { id: 'deepseek-v4.1-flash', name: '' }
        ],
        count: 3
      };
    }
  },
  {
    pattern: /^\/stats\/global$/,
    reply: function () { return MOCK_GLOBAL_STATS; }
  },
  {
    pattern: /^\/export$/,
    reply: function () { return MOCK_EXPORT; }
  },
  {
    pattern: /^\/import$/,
    reply: function () { return { ok: true }; }
  }
];

// 传输函数：api-real.js 的 apiJson() 在注入后直接调它（同步返回假 JSON）
function mockTransport(path) {
  const cleanPath = String(path || '').split('?')[0];
  const route = MOCK_API_ROUTES.filter(function (item) { return item.pattern.test(cleanPath); })[0];
  if (!route) return { ok: true };
  return route.reply(route.pattern.exec(cleanPath));
}

// 注入到唯一的数据层实现（此时 api-real.js 已加载）
// 记录最近一次探测请求的入参，便于 mock 按 apiKey 模拟不同的错误码
let MOCK_PROBE_REQUEST = null;

function mockTransportWithProbe(path, options) {
  if (String(path || '').split('?')[0] === '/models/probe' && options && options.body) {
    try { MOCK_PROBE_REQUEST = typeof options.body === 'string' ? JSON.parse(options.body) : options.body; }
    catch (error) { MOCK_PROBE_REQUEST = null; }
  }
  return mockTransport(path, options);
}

apiSetTransport(mockTransportWithProbe);
