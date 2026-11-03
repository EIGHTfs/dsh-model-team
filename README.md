# dsh-model-team

> DSH 插件：会话级模型路由 + 群聊式切换 UI。DSH 里只注册**一个**虚拟模型；真实模型切换 = 点开悬浮窗 → 进群聊 → @群友（或 @好友分组，由分组按策略轮换）。

## 功能

- **单模型注册**：dsh 模型选择器里只多出一个模型，真实模型由网关按会话映射改写后转发
- **会话级路由**：每个会话独立选择，互不影响
- **合法接入优先**：平台走官方 API + API Key（配置型驱动，零代码加平台）
- **群聊隐喻 UI**：平台账号 = 群，模型 = 群友，请求记录 = 群友消息，@ = 切换
- **悬浮窗**：右下角浮球，显示当前群聊 / 会话（标题 + 短 id）/ 当前目标 / 本会话速率 / 全局请求量；可拖拽、位置记忆；点击开合切换
- **群聊风格主窗口**：底边栏三 tab（消息 / 通讯录 / 我，内联 SVG 图标）；群列表带搜索与更新时间
- **群聊记录**：请求行 + 我发出的 `@目标` + 系统提示，按时间排序；**按群隔离**（不同平台账号的记录互不混入）
- **会话秒感知**：切换会话时悬浮窗与聊天记录立即跟随（槽位桥，零轮询）
- **好友分组（轮换组）**：不同平台的同名模型可聚合成组，按 `round-robin` 或 `fallback` 派发

## 安装

```bash
# 1) 放进某个 DSH profile 的 local-plugins，并建立 node_modules 链接
#    <profile>/local-plugins/dsh-model-team
#    <profile>/node_modules/dsh-model-team → ../local-plugins/dsh-model-team
#    profile 的 package.json：dependencies 用 link:local-plugins/dsh-model-team，
#    dsh.profile.bundles 追加 dsh-model-team

# 2) 首次加载需重启一次宿主（bundles 只在启动时读取）
/var/packages/DeepSeekHarness-NAS/scripts/start-stop-status stop
/var/packages/DeepSeekHarness-NAS/scripts/start-stop-status start
```

之后修改代码免重启：profile 的 `cordis.patch.yml` 里 `hmr.root` 含 `local-plugins` 即可热重载。

## 使用

1. 模型选择器里选 `模型团队 · 模型群聊`（唯一新增的模型）
2. 右下角悬浮球 → 面板显示 当前群聊 / 会话 / 当前目标 / 本会话速率 / 全局请求量
3. 面板「进入群聊界面」→ 主窗口（底边栏：消息 / 通讯录 / 我）
4. 消息页「＋ 加群」→ 选平台 → 填 API 地址与 Key → 「获取可用模型」→ 编辑模型目录 → 校验并添加群
5. 群聊里输入 `@模型名` 或 `@分组名` 发送，即切换本会话目标（回车发送，Shift+Enter 换行）

## 数据根

```
<DSH_HOME>/../.dsh-model-team/      可用 DSH_MODEL_TEAM_HOME 覆盖
  config.json            群配置（凭证只存引用）
  platforms.json         平台预置覆盖（可选）
  groups-state.json      分组轮转游标
  sessions/<id>.json     会话目标映射；<id>.events.jsonl 事件
  stats/requests.jsonl   请求行
  credentials/*.key      明文 Key 落盘（600）；删群时移入 .trash/
```

## 开发

```bash
node --test test/*.test.js     # 用例
node build.cjs                 # 拼接 lib/client-parts/ + ui/ → lib/client.js（产物，勿手改）
node scripts/code-lines.mjs ui/js/*.js   # 代码行统计（空行/注释不计入上限）
```

## 版本记录

| 版本 | 内容 |
|---|---|
| 0.1.0 | 首个版本：单虚拟模型注册与会话级路由；配置容错与凭证引用；动态驱动加载（配置型 OpenAI 兼容）；会话映射与目标回落（父链 / 上一会话 / 兜底群）；分组轮转与故障转移；请求行统计与 `/_team` 端点；客户端分片构建与群聊式界面（悬浮窗、群列表、群聊、通讯录、加群、模型目录） |
