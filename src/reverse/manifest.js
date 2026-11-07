// 反代域的**声明式清单**：唯一事实来源（docs/18 §二）。
//
// 纪律：
//   · 这里只放元数据，**不 import 任何实现**（handler/平台实现都写成字符串路径，由 register 动态加载）；
//   · 新增平台 / 新增路由 = 只改这个文件；
//   · 反代整体不可用时，主流程照常（register 里每一步失败只 warn，不抛）。

export const manifest = {
  id: 'reverse',

  // 平台：一个平台一条；module 是相对本目录的实现路径（register 动态 import）
  platforms: [
    {
      id: 'qoder',
      driverId: 'reverse-qoder',
      displayName: 'Qoder',
      module: './platforms/qoder/index.js',
      inferModule: './platforms/qoder/infer.js',
      capabilities: { encryptedInference: true, login: 'device-code' },
      cryptoBackends: ['native', 'wasm'],
    },
  ],

  // 路由：path 与实现分开写；handler 形如 '<相对路径>#<导出名>'
  routes: [
    { method: 'POST', path: '/_team/reverse/login/start', handler: './routes/login.js#handleReverseLoginStartRoute' },
    { method: 'GET', path: '/_team/reverse/login/:sessionId', handler: './routes/login.js#handleReverseLoginStatusRoute' },
    { method: 'POST', path: '/_team/reverse/login/:sessionId/cancel', handler: './routes/login.js#handleReverseLoginCancelRoute' },
    { method: 'GET', path: '/_team/reverse/accounts', handler: './routes/accounts.js#handleReverseAccountsRoute' },
    { method: 'GET', path: '/_team/reverse/import/sources', handler: './routes/import.js#handleReverseImportSourcesRoute' },
    { method: 'POST', path: '/_team/reverse/import', handler: './routes/import.js#handleReverseImportRoute' },
  ],

  // 凭据导入源（实现已在 core/import/sources/ 下按 id 自注册；清单用于 describeReverse 与将来按需注册）
  importSources: ['host-credentials', 'manual'],

  // 界面挂载点：加群页的"接入信息"段在反代平台下换成账号区（第 5 步实现 UI）
  uiMounts: [
    { slot: 'add-group.auth', kind: 'reverse-account', platformId: 'qoder' },
  ],
};

export default manifest;
