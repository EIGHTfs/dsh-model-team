// mock-data.js —— 阶段 1 的假数据，形态等同后端各接口的返回产物。
// 字段严格照 docs/M0-数据模型.md；RequestRow.title 由后端拼好完整原始日志，前端只负责塞进 title 属性。
// 数据只在本文件维护，读取一律经由 api.js；本文件不发起任何请求。

// MOCK_DRIVERS：DriverMeta[]，等同 GET /_team/drivers
// accessMode 目前恒为 official（本项目只做合法接入），字段保留作为将来扩展位，界面不按它分组
// authSchema 的 type 支持 text / password / textarea / select；manualModels 只在 modelSource=manual 时显示
const MOCK_DRIVERS = [
  {
    id: 'codearts',
    name: 'CodeArts (华为云)',
    avatar: '[C]',
    accessMode: 'official',
    authSchema: [
      { key: 'baseURL', label: 'API 地址', type: 'text', required: false, placeholder: 'https://api.example.com/v1' },
      { key: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: '平台控制台申请的公网 API Key' },
      {
        key: 'modelSource',
        label: '模型列表来源',
        type: 'select',
        required: false,
        options: [
          { value: 'auto', label: '自动拉取（调 /models）' },
          { value: 'manual', label: '手动填写' }
        ]
      },
      {
        key: 'manualModels',
        label: '模型名（每行一个）',
        type: 'textarea',
        required: false,
        placeholder: 'codearts-qwen-235b\ncodearts-pangu-72b',
        showWhen: { key: 'modelSource', value: 'manual' }
      }
    ]
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    avatar: '[W]',
    accessMode: 'official',
    authSchema: [
      { key: 'baseURL', label: 'API 地址', type: 'text', required: false, placeholder: 'https://api.example.com/v1' },
      { key: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'wb-xxxxxxxxxxxxxxxx' },
      {
        key: 'modelSource',
        label: '模型列表来源',
        type: 'select',
        required: false,
        options: [
          { value: 'auto', label: '自动拉取（调 /models）' },
          { value: 'manual', label: '手动填写' }
        ]
      },
      {
        key: 'manualModels',
        label: '模型名（每行一个）',
        type: 'textarea',
        required: false,
        placeholder: 'glm-5.3-flash\ndeepseek-v4.1-flash',
        showWhen: { key: 'modelSource', value: 'manual' }
      }
    ]
  }
];

// MOCK_GROUPS：PlatformAccount[]，一个平台账号 = 一个群
// summary 是网关按 env 模板渲染好的成品串，前端不做二次拼装；第三条刻意留长，用于长度兜底
const MOCK_GROUPS = [
  {
    id: 'eightfs',
    name: 'eightfs(1a1cd1a2)',
    avatar: '[W]',
    driverId: 'workbuddy',
    credentialRef: 'local://workbuddy/eightfs',
    summary: '限速 120/min · 余额 $8.42 · 并发 4',
    lastTime: '03:50'
  },
  {
    id: 'hw-cloud',
    name: 'huawei-cloud(7c4b91ce)',
    avatar: '[C]',
    driverId: 'codearts',
    credentialRef: 'local://codearts/hw-cloud',
    summary: '5h 42/60 · 周 388/500 · 余 1.2k credit',
    lastTime: '02:11'
  }
];

// MOCK_MODELS_BY_GROUP：群友 = 模型，键为 PlatformAccount.id
const MOCK_MODELS_BY_GROUP = {
  eightfs: [
    { id: 'global:glm-5.3-flash', name: 'glm-5.3-flash' },
    { id: 'global:deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' },
    { id: 'global:gpt-5.2-turbo', name: 'gpt-5.2-turbo' }
  ],
  'hw-cloud': [
    { id: 'global:codearts-qwen-235b', name: 'codearts-qwen-235b' },
    { id: 'global:codearts-pangu-72b', name: 'codearts-pangu-72b' }
  ]
};

// MOCK_ROWS_BY_GROUP：RequestRow[]，群友消息 = 请求记录行
// title 是后端产出的完整原始日志串（含 account），前端直接放进 title 属性
const MOCK_ROWS_BY_GROUP = {
  eightfs: [
    {
      time: '03:47:12',
      status: 200,
      statusText: '成功',
      model: 'global:deepseek-v4.1-flash',
      account: { name: 'eightfs(1a1cd1a2)', id: 'eightfs' },
      ip: '192.0.2.10',
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      latency: '8.42s',
      tokens: '96.3k',
      credit: '0.31',
      cacheHit: '92.4%',
      requestId: 'req-2b1f70c9d3e14a88',
      title: '时间 03:47:12 | 状态 200 成功 | 模型 global:deepseek-v4.1-flash | 会话账号 eightfs(1a1cd1a2) [eightfs] | IP 192.0.2.10 | UA Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 | 耗时 8.42s | token 96.3k | credit 0.31 | 命中率 92.4% | req-id req-2b1f70c9d3e14a88'
    },
    {
      time: '03:48:55',
      status: 200,
      statusText: '成功',
      model: 'global:glm-5.3-flash',
      account: { name: 'eightfs(1a1cd1a2)', id: 'eightfs' },
      ip: '192.0.2.10',
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
      latency: '12.07s',
      tokens: '184.2k',
      credit: '0.44',
      cacheHit: '98.1%',
      requestId: 'req-91ac4de7750f2b36',
      title: '时间 03:48:55 | 状态 200 成功 | 模型 global:glm-5.3-flash | 会话账号 eightfs(1a1cd1a2) [eightfs] | IP 192.0.2.10 | UA Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15 | 耗时 12.07s | token 184.2k | credit 0.44 | 命中率 98.1% | req-id req-91ac4de7750f2b36'
    },
    {
      time: '03:49:31',
      status: 429,
      statusText: '限流',
      model: 'global:gpt-5.2-turbo',
      account: { name: 'eightfs(1a1cd1a2)', id: 'eightfs' },
      ip: '192.0.2.10',
      ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      latency: '0.38s',
      tokens: '0',
      credit: '0.00',
      cacheHit: '—',
      requestId: 'req-5f30be2a1c9d4407',
      title: '时间 03:49:31 | 状态 429 限流 | 模型 global:gpt-5.2-turbo | 会话账号 eightfs(1a1cd1a2) [eightfs] | IP 192.0.2.10 | UA Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 | 耗时 0.38s | token 0 | credit 0.00 | 命中率 — | req-id req-5f30be2a1c9d4407'
    },
    {
      time: '03:50:06',
      status: 200,
      statusText: '成功',
      model: 'global:glm-5.3-flash',
      account: { name: 'eightfs(1a1cd1a2)', id: 'eightfs' },
      ip: '192.0.2.10',
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      latency: '14.13s',
      tokens: '252.6k',
      credit: '0.52',
      cacheHit: '99.9%',
      requestId: 'req-7e8c519feca47062',
      title: '时间 03:50:06 | 状态 200 成功 | 模型 global:glm-5.3-flash | 会话账号 eightfs(1a1cd1a2) [eightfs] | IP 192.0.2.10 | UA Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 | 耗时 14.13s | token 252.6k | credit 0.52 | 命中率 99.9% | req-id req-7e8c519feca47062'
    }
  ],
  'hw-cloud': [
    {
      time: '01:58:03',
      status: 200,
      statusText: '成功',
      model: 'global:codearts-qwen-235b',
      account: { name: 'huawei-cloud(7c4b91ce)', id: 'hw-cloud' },
      ip: '198.51.100.20',
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      latency: '21.66s',
      tokens: '312.8k',
      credit: '1.24',
      cacheHit: '88.6%',
      requestId: 'req-c4a90f1b6e2d8735',
      title: '时间 01:58:03 | 状态 200 成功 | 模型 global:codearts-qwen-235b | 会话账号 huawei-cloud(7c4b91ce) [hw-cloud] | IP 198.51.100.20 | UA Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 | 耗时 21.66s | token 312.8k | credit 1.24 | 命中率 88.6% | req-id req-c4a90f1b6e2d8735'
    },
    {
      time: '02:11:47',
      status: 500,
      statusText: '上游错误',
      model: 'global:codearts-pangu-72b',
      account: { name: 'huawei-cloud(7c4b91ce)', id: 'hw-cloud' },
      ip: '198.51.100.20',
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
      latency: '3.04s',
      tokens: '0',
      credit: '0.00',
      cacheHit: '—',
      requestId: 'req-88de3bb0c17f5a24',
      title: '时间 02:11:47 | 状态 500 上游错误 | 模型 global:codearts-pangu-72b | 会话账号 huawei-cloud(7c4b91ce) [hw-cloud] | IP 198.51.100.20 | UA Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15 | 耗时 3.04s | token 0 | credit 0.00 | 命中率 — | req-id req-88de3bb0c17f5a24'
    }
  ]
};

// MOCK_GLOBAL_STATS：悬浮面板的全局统计
const MOCK_GLOBAL_STATS = {
  currentModel: 'global:glm-5.3-flash',
  currentGroupId: 'eightfs',
  sessionRate: '14.5 tok/s',
  globalRequests: '1,234 次',
  globalTokens: '总计 2.5M tok'
};

// MOCK_SESSION_ID + MOCK_SESSION_MAP：SessionModelMap，key = dsh 会话 id
const MOCK_SESSION_ID = 'sess-preview';
const MOCK_SESSION_MAP = {
  'sess-preview': { platform: 'eightfs', model: 'global:glm-5.3-flash' }
};

// MOCK_FRIEND_GROUPS：FriendGroup[]，等同 GET /_team/friend-groups
// strategy：round-robin（轮询，游标全局共享）/ fallback（故障转移，优先 members[0]）
const MOCK_FRIEND_GROUPS = [
  {
    id: 'ds-high-avail',
    name: 'DeepSeek-高可用组',
    strategy: 'round-robin',
    cursor: 1,
    members: [
      { platformId: 'codearts', modelId: 'deepseek-v3' },
      { platformId: 'workbuddy', modelId: 'deepseek-v3' }
    ]
  },
  {
    id: 'claude-frugal',
    name: 'Claude-省钱组',
    strategy: 'fallback',
    cursor: 0,
    members: [
      { platformId: 'workbuddy', modelId: 'claude-3.7-sonnet' },
      { platformId: 'codearts', modelId: 'claude-3.5-haiku' }
    ]
  }
];

// MOCK_TARGET_BY_SESSION：按会话返回不同目标，用于验证「进群聊默认显示该会话目标所属群」（契约条款 25）
// 新出参（契约 docs/19 §三）：{ target, effectiveTarget, targetSource }
// 这里刻意覆盖三种来源：显式绑定 / 继承上一会话 / 分组兜底
const MOCK_TARGET_BY_SESSION = {
  'sess-preview': {
    target: { type: 'model', id: 'global:glm-5.3-flash', platformId: 'eightfs' },
    effectiveTarget: { type: 'model', id: 'global:glm-5.3-flash', platformId: 'eightfs' },
    targetSource: 'explicit'
  },
  'session-two': {
    target: { type: 'model', id: 'global:deepseek-v4.1-flash', platformId: 'hw-cloud' },
    effectiveTarget: { type: 'model', id: 'global:deepseek-v4.1-flash', platformId: 'hw-cloud' },
    targetSource: 'explicit'
  },
  'session-inherit': {
    target: null,
    effectiveTarget: { type: 'model', id: 'global:glm-5.3-flash', platformId: 'eightfs' },
    targetSource: 'last-session'
  },
  'session-group': {
    target: { type: 'group', id: 'ds-high-avail' },
    effectiveTarget: { type: 'group', id: 'ds-high-avail' },
    targetSource: 'explicit'
  }
};

// MOCK_SESSION_TARGET：SessionTarget，等同 /_team/session/:id/target（新结构 type/id）
const MOCK_SESSION_TARGET = {
  'sess-preview': { type: 'model', id: 'global:glm-5.3-flash' }
};

// MOCK_PLATFORMS：PlatformPreset[]，等同 GET /_team/platforms
// 平台信息全部来自后端预置（名称/图标/基址/摘要模板），前端不写死任何平台域名
const MOCK_PLATFORMS = [
  {
    id: 'agnes',
    name: 'Agnes',
    avatar: 'https://cdn.example.com/logo-agnes.svg',
    baseURL: 'https://api.example.com/agnes/v1',
    modelsEndpoint: '/models',
    homepage: 'https://example.com',
    summaryTemplate: '官方接入 · {baseURL}',
    driverId: 'codearts'
  },
  {
    id: 'codearts',
    name: 'CodeArts (华为云)',
    avatar: '[C]',
    baseURL: 'https://api.example.com/codearts/v1',
    modelsEndpoint: '/models',
    homepage: 'https://example.com',
    summaryTemplate: '官方接入 · {baseURL}',
    driverId: 'codearts'
  }
];

// MOCK_SESSION_EVENTS：会话事件流（self-message = 我发出的 @，system = 系统提示），键为群 id
// 后端产物，前端不自造；设计稿用它在聊天流里展示「我的气泡 + 系统提示」
const MOCK_SESSION_EVENTS = {
  eightfs: [
    { time: '03:46:30', type: 'self-message', text: '@global:glm-5.3-flash', model: 'global:glm-5.3-flash' },
    { time: '03:47:02', type: 'self-message', text: '@global:deepseek-v4.1-flash', model: 'global:deepseek-v4.1-flash' },
    { time: '03:50:30', type: 'system', text: '已切换当前会话模型为 glm-5.3-flash' }
  ],
  'hw-cloud': [
    { time: '02:00:00', type: 'system', text: '已切换当前会话模型为 codearts-qwen-235b' }
  ]
};

// MOCK_EXPORT：等同 GET /_team/export 的返回，只含账号配置
const MOCK_EXPORT = {
  version: '0.1.0',
  exportedAt: '2026-11-02 12:50:00',
  groups: MOCK_GROUPS.map(function (group) {
    return {
      id: group.id,
      name: group.name,
      driverId: group.driverId,
      credentialRef: group.credentialRef,
      summary: group.summary
    };
  })
};
