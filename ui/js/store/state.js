// store-state.js —— 状态的形状与常量（唯一真相源只在这里定义"初始长什么样"）。
// 为什么单独成文件：拆分后各模块都要读 state，但"state 有哪些字段"必须只有一处定义，
// 否则新加字段时漏改某一处，就会出现"某块逻辑永远读到 undefined"的隐性 bug。

// 事件清单：只有这些广播会触发重渲染（契约 docs/13 §3.4）
var STORE_EVENTS = ['session:changed', 'target:changed', 'chat:updated', 'stats:updated', 'groups:updated', 'platforms:updated', 'view:changed', 'form:changed', 'db:changed'];
var STORAGE_WRITE_DEBOUNCE_MS = 150;
var RATE_PLACEHOLDER_TEXT = '— tok/s';
// 持久化键由工厂单点持有（视图不再自己读写 localStorage）
var ANCHOR_STORAGE_KEY = 'dsh-model-team:anchor';
var SESSION_STORAGE_KEY = 'dsh-model-team:last-session';

function createInitialState() {
  return {
    sessionId: null,
    sessionTitle: null,
    lastSessionId: null,
    // 会话 id 的来源：slot（宿主槽位，唯一可信）| fallback（服务端「最近活跃」推断）| none
    sessionIdSource: 'none',
    target: null,                 // 本会话显式绑定的目标（可能为 null）
    effectiveTarget: null,        // 实际生效的目标（含后端回落），面板/球/群聊都用它
    targetSource: 'none',         // explicit | parent | last-session | fallback-group | none
    groups: [],
    // drivers / friendGroups 必须在初始 state 里：渲染路径（platformOf）会直接读 state.drivers，
    // 缺字段时抛 TypeError 会把整条 boot 链打断，表现就是"群列表 0 个群但接口有数据"。
    drivers: [],
    friendGroups: [],
    // 群列表最近一次加载失败的原因（null = 没失败）：渲染层据此区分"真的空"与"加载失败"
    lastGroupsError: null,
    platforms: [],
    // 加群表单的「值」：只由 store/add-form.js 读写；主题经 useAddForm() 只读投影。
    addForm: { optionId: '', driverKey: '', values: {}, advancedField: null },
    // 数据库页（备份/恢复）的值：只由 store/db.js 读写；形状与 db.js 的 createDbState() 必须一致
    db: {
      phase: 'idle', error: null, backupSummary: null, preview: null,
      pendingImport: null, lastExport: null, lastImport: null,
    },
    currentGroupId: '',
    models: {},
    // 每个群的模型清单加载状态：'loading' | 'loaded' | 'error'。
    // 必须与 models 分开记：models[groupId] 缺省是 []，"还没拉"与"确实 0 个"取值一样，
    // 界面就会把"未知"显示成 0（G-13 同类问题），所以视图要能查到状态再决定显示 — 还是数字。
    modelsStatus: {},
    messages: {},
    rate: RATE_PLACEHOLDER_TEXT,
    global: { requests: 0, tokens: 0, text: '—' },
    view: 'list',
    anchor: null,
    errors: []
  };
}
