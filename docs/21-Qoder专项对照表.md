# 21 Qoder 专项对照表（照着抄，不要重新设计）

> 用法：实现前逐行核对；实现后逐行回填「我们」。**任何与本表冲突的实现，以本表为准。**
> 证据列的文件行号都可直接跳转核对；两家参考不一致时**两列都列**，并注明真机判定前不要删任何一列。

## 一、域名与端点（CN）

| 项 | 值 | 证据 | 我们 |
|---|---|---|---|
| 授权页站点 | `https://qoder.com.cn` | `qoder_accounts.py:255` | 用 `https://qoder.cn`（providers-hub `qoder-product.js:318`）——两域实测**同一页面**（都跳 `/users/sign-in`，`data-dashboard-surface="cn"`），暂记「等价，待真机」 |
| 开放 API | `https://openapi.qoder.com.cn` | `qoder_accounts.py:253` | 一致 |
| 推理网关 | `https://gateway.qoder.com.cn` | `qoder_accounts.py:254`、`qoder-adapter.js:741` | 一致 |
| 授权路径 | `/device/selectAccounts` | `qoder.js:19`、`qoder_accounts.py:4463` | 一致 |
| 轮询路径 | `/api/v1/deviceToken/poll` | `qoder.js:21`、`qoder_accounts.py:305` | 一致 |
| 续期路径 | `/api/v1/deviceToken/refresh` | `qoder.js:23`、`qoder_accounts.py:306` | **未实现**（M4） |
| 用户信息 | `/api/v1/userinfo` | `qoder.js:25`、`qoder_accounts.py:4533` | 一致 |
| 公开对话（仅对照） | `/model/v1/chat/completions` | `qoder.js:27` | 只作目录对照，**不用于推理** |
| 加密推理 | `/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1` | `qoder-adapter.js:11`、`qoder-catalog.js:36` | 一致 |

## 二、设备授权（登录）参数

| 项 | CN 正确值 | 证据 | 我们 |
|---|---|---|---|
| `challenge_method` | `S256` | `qoder.js:79`、`qoder_accounts.py:4455` | 一致 |
| `nonce` 形态 | **带横线 uuid** | `qoder_accounts.py:4452,266` | 一致（intl 为 32-hex，profile 已区分） |
| `redirect_uri` | **必须带** `qoder-work-cn://` | `qoder_accounts.py:257,265,4458-4459` | 已补（`cn-python` profile）；providers-hub 不带 → 记为备选 profile |
| `client_id` | 两家不同：`1c5e33e1-364d-4ce6-b02c-acaa81274a5c`（Python CN） / `732aef47-9cf2-46a2-95fe-4cebb5d0d1fa`（providers-hub CN） | `qoder_accounts.py:256` vs `qoder-product.js:335` | 已 profile 化，日志打印尾 8 位，真机判定后删掉错的那套 |
| `machine_id` | **本机稳定 id**（不是每次随机） | `qoder_accounts.py:4462` | 已改（系统 id → 主机名+MAC 派生 → 持久化） |
| PKCE challenge | `base64url(sha256(verifier))`，**去 padding** | `qoder.js:49-53` | 一致 |

## 三、轮询

| 项 | 正确做法 | 证据 | 我们 |
|---|---|---|---|
| 方法/参数 | `GET ?nonce&verifier&challenge_method=S256` | `qoder.js:93-99`、`qoder_accounts.py:4489-4493` | 一致 |
| 宿主 | 必须 `openApiBase`（不是授权站点） | `qoder.js:89-91` | 一致 |
| pending 判定 | **404**（两家）+ **202**（Python 独有） | `qoder-oauth.js:82-85`、`qoder_accounts.py:4508-4511` | 已对齐 |
| 非 pending 错误 | 5xx 立即失败；网络异常容忍有限次 | `qoder-oauth.js:86-95` | 一致 |
| `User-Agent` | Python 轮询发 `QoderWork`；providers-hub 的 userinfo/续期发 `qoder/1.0.0` | `qoder_accounts.py:4501`、`qoder.js:221` | **未发送** ← 待对齐（对 404 无影响，但 token 阶段可能有门禁） |
| TTL | 600s（Python `LOGIN_TTL_SECONDS`）；providers-hub 300s | `qoder_accounts.py:299` | 300s ← 建议 600s |
| **会话生命周期** | 轮询必须能领取**任意**一次成功的授权；同平台不要产生孤儿会话 | 见 `docs/20` §七 | **正在修（第 9 步）** |

## 四、token 响应

| 字段 | 说明 | 证据 | 我们 |
|---|---|---|---|
| `token` / `device_token` / `access_token` | 登录响应用 `token`，续期用 `device_token`，三者都要兼容 | `qoder.js:133-140`、`qoder_accounts.py:4525` | 一致 |
| `refresh_token` | 续期用 | 同上 | 一致 |
| 过期 | `expires_at`（秒/毫秒/RFC3339 都兼容）或 `expires_in`(ms)，缺省 30 天 | `qoder.js:116-126`、`qoder_accounts.py:3647-3648` | 读不到就留空（不编造） |
| `user_id` / `name` | userinfo 返回，判重键与显示名 | `qoder.js:275`、`qoder_accounts.py:4544-4545` | 一致 |

## 五、续期（M4 才做，但规则先记死）

| 项 | 做法 | 证据 |
|---|---|---|
| 端点 | `POST /api/v1/deviceToken/refresh` | `qoder.js:23` |
| 载荷 | `{ refresh_token, machine_id }`（machine_id 必须原样回传） | `qoder-auth.js` 文件头 |
| 前缀分流 | `drt-` 前缀 → deviceToken；`jrt-`/PAT → jobToken | `qoder_accounts.py:2407` |
| 导入账号 | `refreshable:false` → **永不续期** | 我们 `account-store` 已落该字段 |

## 六、推理

| 项 | 正确做法 | 证据 | 我们 |
|---|---|---|---|
| 请求体 | 由 WASM/纯语言实现加密（自定义 base64 变体 + AES-128-CBC key==iv + RSA 封装会话密钥） | `qoder_accounts.py:5-30`、`qoder-wasm.js` 文件头 | 已实现（native 与 Python 逐字节对拍） |
| COSY 签名 | `md5(payload\ncosyKey\ndate\nbody\npath)`，`path` 去掉开头 `/algo` | `qoder_accounts.py:22-23` | 已实现 |
| `Bearer` 形态 | `COSY.<payload>.<sig>` | 同上 | 一致 |
| 头族 | `cosy-*` 系列 + **`Cosy-MachineToken` 与 `Cosy-MachineType` 必须成对** | `qoder-machine.js:31-37`（消融实验） | 已强制成对，缺一即抛 |
| 模型路由 | `x-model-key` 决定上游模型 | `qoder_accounts.py:26` | 一致 |
| 响应 | SSE，每帧多一层信封 `{headers, body, statusCode}`，`body` 是 JSON 字符串（未加密） | `qoder-envelope.js` 文件头 | 已实现剥壳 |
| 失败语义 | 401 不重试；加密失败不发请求；**永不降级公开端点** | 我们 `infer.js` 单测 | 已实现 |

## 七、我们犯过的错（按时间，写清代价）

| # | 错在哪 | 后果 | 教训（已落点） |
|---|---|---|---|
| 1 | 只读 providers-hub 一家就动手实现登录 | CN 少了 `redirect_uri`、`machine_id` 用随机值 | 写 `docs/19`，本表 §二 |
| 2 | 把「现象=超时」当根因 | 白改一轮参数 | `docs/20` §七：先看现象来自哪一层，再看会话生命周期 |
| 3 | 每次点击新建会话并停掉旧轮询 | 授权成功却被丢弃 | 第 9 步：按平台轮询 + 会话复用 |
| 4 | 界面里露内部术语（`reverse-qoder`、`authSchema`、`（反代）`） | 用户看不懂 | `docs/17` §三 禁止项 |
| 5 | 把「无 status 的回执」兜底成 `expired` | 错误伪装成超时 | 第 9 步：三种文案分开 |
| 6 | 轮询未发 `User-Agent` | 待验证是否影响 token 阶段 | 本表 §三 标「待对齐」 |

## 八、本表的使用纪律

1. 改任何 Qoder 相关代码前，先在本表找到对应行；**没有对应行就先加一行**（连同证据行号）再动手。
2. 两家参考冲突时（如 `client_id`、授权站点），**保留可切换 + 日志可观测**，真机一次定论后删掉多余分支。
3. 任何一行标着「未实现 / 待对齐」的，不许在文档或回复里说成「已支持」。
