# dsh-model-team

在 DSH 模型列表里只出现一个虚拟模型，真正的模型按会话映射；切换发生在插件自己的群聊界面里。

## 功能

| 功能 | 做什么 | 入口 |
|---|---|---|
| 单虚拟模型 | 模型列表只多出一个入口，其余由插件按会话路由 | DSH 模型选择器 |
| 群聊界面 | 平台账号=群、模型=群友，`@` 切换当前会话目标 | 悬浮球 → 进入群聊界面 |
| 悬浮面板 | 显示当前群聊、会话、目标、速率与总请求量 | 点击悬浮球 |
| 分组与故障转移 | 同名模型聚合，按策略轮转/故障转移 | 通讯录 → 好友分组 |
| 请求行统计 | 每次请求的模型、状态、耗时、token、命中率 | 群聊内请求卡片、面板 |
| 凭据引用 | 群里只存引用，不存明文 Key | 加群页「凭证」 |
| 反代账号 | 用真实账号登录后接入，账号由插件保管 | 加群页「登录」 |
| 模型目录 | 运行时从上游拉取，按缓存周期刷新 | 加群页「获取可用模型」 |
| 主题 | 一个主题 = 一个 `.tsx`；默认 `tim`，`classic` 可选 | 构建期配置 `theme.source` |
| 备份与还原 | 导出/导入完整配置与凭据文件（界面上暂无入口，接口可用） | 接口 / 数据库页（0.4.x 补） |
| 外部 OpenAI 兼容入口 | 可选对外提供 `/v1/chat/completions` | 配置 `http.externalOpenAiCompat` |

## 环境要求

| 宿主 | 运行时 | 平台 |
|---|---|---|
| DSH 0.2.x（`@deepseek-ai/dsh-llm >=0.2.0 <0.3.0`） | Node `^22.19.0 \|\| >=24.0.0` | Linux / macOS |

## 用法

### 面板与界面

```
悬浮球                      # 点击展开面板：当前群聊 / 会话 / 目标 / 速率 / 总量
[ 进入群聊界面 > ]          # 打开主窗口，底边栏三 tab：消息 / 通讯录 / 我
＋加群                      # 消息页右上角：选平台 → 填名称 → 登录或填引用 → 校验并添加
```

### 群聊指令

```
@模型名                     # 把当前目标切到该模型（消息流里出现我的气泡 + 系统提示）
@分组名                     # 切到分组：按策略轮转
```

### 加群与账号

```
选平台 Qoder → 登录 Qoder   # 弹出授权页，完成后自动选中账号
获取可用模型                # 反代平台从上游现拉；配置型平台按 API 地址探测
校验并添加群                # 成功后回到列表，不成功会显示原因
```

### 自测脚本

```
node scripts/reverse-login.mjs --platform <平台id>    # 反代登录（不打印 token）
node scripts/reverse-cosy-vectors.mjs                 # 签名与参考实现逐字节对拍
```

## API

内部端点前缀 `/_team`；对外入口裸路径 `/v1`（默认关闭）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/_team/groups` | 群列表（含摘要） |
| POST | `/_team/groups` | 加群 |
| PATCH | `/_team/groups/:id` | 部分更新 |
| DELETE | `/_team/groups/:id` | 删群 |
| GET | `/_team/groups/:id/models` | 该群模型列表 |
| POST | `/_team/groups/:id/verify` | 校验凭证 |
| GET/PUT | `/_team/session/:id/target` | 读写会话目标 |
| GET | `/_team/stats/session/:id` | 请求行 + 会话速率 |
| GET | `/_team/stats/global` | 全局总量 |
| GET | `/_team/reverse/accounts` | 反代账号（脱敏） |
| POST | `/_team/models/probe` | 探测模型 |
| GET/POST | `/_team/export`、`/_team/import` | 备份与还原 |
| GET | `/v1/models`、`POST /v1/chat/completions` | 外部兼容入口（需开启） |

```bash
curl -s http://<host>:<port>/_team/groups
# {"groups":[{"id":"…","name":"…","driver":"openai-compatible","summary":"已连接 · https://…"}]}
```

```bash
curl -s -X POST http://<host>:<port>/_team/groups \
  -H 'content-type: application/json' \
  -d '{"name":"示例群","driver":"openai-compatible","baseURL":"https://api.example.com/v1","auth":{"apiKeyRef":"env:EXAMPLE_KEY"},"models":{"endpoint":"/models"}}'
# {"group":{"id":"…","name":"示例群","driver":"openai-compatible", …}}
```

## 状态

**0.4.2 起进入「维护暂停」状态**：代码可用，但以下功能**未经真实使用环境验证**，按现状发布：

| 项 | 状态 |
|---|---|
| 加群页选平台后加载账号 | 已修，**未在重启后的主实例验收** |
| 网络失败文案（不再出现 `signal is aborted without reason`） | 已改，**未验证** |
| 登录成功后自动关闭授权页 | 已修，**未验证** |
| 账号列表脏数据（`.state.json` 被当账号） | 已修，**需宿主重启后复验** |
| `max_tokens` 超过上游上限 | 仍会先失败一次再降级重试，**未修** |

完整待办与接手须知见 [`docs/26-待办清单.md`](docs/26-待办清单.md)；已知缺陷见 [`docs/13-差异与已知问题.md`](docs/13-差异与已知问题.md)。

**界面**：0.4.0 起界面完全由主题渲染，`ui/` 下没有 HTML 骨架、也没有独立 CSS，界面与样式都在 `ui/themes/*.tsx` 里，构建期编译进 `lib/client.js`。默认主题 `tim`，`classic` 为对照主题。

## 文档索引

- [`docs/00-索引.md`](docs/00-索引.md) — 文档入口与铁律
- [`docs/03-UI与主题契约.md`](docs/03-UI与主题契约.md) — 界面条款 / 主题契约 / Bridge / 验收判据
- [`docs/13-差异与已知问题.md`](docs/13-差异与已知问题.md) — 已知缺口
- [`docs/26-待办清单.md`](docs/26-待办清单.md) — 维护暂停的移交表（未验证 / 未实现）
- [`docs/02-契约.md`](docs/02-契约.md) — 端点 / 字段 / 错误码
- [`docs/12-工程执行约定.md`](docs/12-工程执行约定.md) — 交付纪律与发布闸门
- [`docs/16-目录结构.md`](docs/16-目录结构.md) — 代码放在哪、为什么
