# 21 Qoder 专项操作与证据表

> 用法：逐步核对输入、源码行为和真实输出。外部实现是有版本范围的证据，不是未经验证的厂商契约。
> 本表记录平台细节；总契约以 `02` 为准，低耦合边界以 `18` 为准，活动缺口以 `06` §二为准。
> 核对：2026-11-08，源码基线 `c2f6418`。字段 / 参数一致不等于完整功能验收通过。

## 一、域名与端点（CN）

| 项 | 值 | 证据 | 我们 |
|---|---|---|---|
| 授权页站点 | 两份客户端配置分别使用 `qoder.com.cn` / `qoder.cn` | `qoder_accounts.py:250-266`；部署 `qoder-product.js:318` | 本项目当前用 `qoder.cn`；未登录时都能显示登录页，**不能据此判定授权与发 token 语义等价** |
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
| `redirect_uri` | Python 的 CN 配置带 `qoder-work-cn://`；另一客户端配置不带，不能拆开 client_id 与 redirect_uri 任意混用 | `qoder_accounts.py:250-266,4453-4463`；部署 `qoder.js:76-84` | 已 profile 化（本项目 `platforms/qoder/index.js:50-58`）；尚无证据证明某套参数是截图故障根因 |
| `client_id` | 两家不同：`1c5e33e1-364d-4ce6-b02c-acaa81274a5c`（Python CN） / `732aef47-9cf2-46a2-95fe-4cebb5d0d1fa`（providers-hub CN） | `qoder_accounts.py:256` vs `qoder-product.js:335` | 已 profile 化，日志打印尾 8 位，真机判定后删掉错的那套 |
| `machine_id` | 源函数优先读取官方客户端文件，缺失时回落 UUID；不是系统 machine-id 的证据 | `qoder_accounts.py:4427-4439,4462` | 当前采用独立持久化策略；正确性须单独验证，不能借字段名断言厂商必需 |
| PKCE challenge | `base64url(sha256(verifier))`，**去 padding** | `qoder.js:49-53` | 一致 |

## 三、轮询

| 项 | 正确做法 | 证据 | 我们 |
|---|---|---|---|
| 领取谁推进 | 授权页打开与后台领取是独立阶段，不能依赖用户停留在前端标签页 | 部署 `qoder-oauth.js:134-148` 启动 result Promise；本项目 `core/login-session.js:73-85` 由状态请求触发 poll | **实现流程不同**；须验证前端切标签 / 离开后的领取与落盘，不得把单次轮询打桩当作相同流程 |
| 方法/参数 | `GET ?nonce&verifier&challenge_method=S256` | `qoder.js:93-99`、`qoder_accounts.py:4489-4493` | 参数同形，不代表上述推进机制已对齐 |
| 宿主 | 必须 `openApiBase`（不是授权站点） | `qoder.js:89-91` | 一致 |
| pending 判定 | **404**（两家）+ **202**（Python 独有） | `qoder-oauth.js:82-85`、`qoder_accounts.py:4508-4511` | 已对齐 |
| 非 pending 错误 | 5xx 立即失败；网络异常容忍有限次 | `qoder-oauth.js:86-95` | 一致 |
| `User-Agent` | Python 轮询发 `QoderWork`；providers-hub 的 userinfo/续期发 `qoder/1.0.0` | `qoder_accounts.py:4501`、`qoder.js:221` | **未发送** ← 待对齐（对 404 无影响，但 token 阶段可能有门禁） |
| TTL | 两份实现有不同等待期限；不能据此推断故障由等待时间引起 | `qoder_accounts.py:298-299`；部署 `qoder-oauth.js:69-70` | 保留可观测的失败结局；**不调预算修故障**，根因证据见 `20` |
| **会话生命周期** | 结果必须属于本次操作；复用、取消、再登录不能串账号 | `src/reverse/routes/login.js:65-105,147-179` | 已写平台级查询与复用逻辑；真实操作关联仍未验收，见 `06` R-07 |

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
| 请求体 | 自定义 Base64 编码请求体；AES-CBC 加密身份数据，RSA 封装会话密钥 | `qoder_sign.py:76-85,629-679`；`crypto/native.js:131-195` | native 签名与 Python 向量对拍已有记录；请求体语义及 WASM 兼容不是同一项证据 |
| COSY 签名 | `md5(payload\ncosyKey\ndate\nbody\npath)`，`path` 去掉开头 `/algo` | `qoder_sign.py:629-644`；`crypto/native.js:151-164` | 已有算法实现；不能代替上游真实成功 |
| `Bearer` 形态 | `COSY.<payload>.<sig>` | `qoder_sign.py:629-644` | 字节对拍不等于认证通过 |
| 设备头 | 按实际推理 / 账号请求分别核对，不能把活动接口的消融结论推广到所有请求 | `crypto/native.js:168-195`；M1 `headers.js` | **native 请求并未调用 M1 的缺值守卫**，不能宣称所有路径都强制完整头族 |
| 模型路由 | `x-model-key` | `qoder_sign.py:679`；`crypto/native.js:191-194` | 有实现，真实模型能力仍待验证 |
| 响应 | SSE 外层信封；剥壳后还须遵守调用方流契约 | `platforms/qoder/infer.js:81-90` | 剥壳已有模块，接入公共解析器仍有 R-04 缺口 |
| **群接入** | 账号引用由反代插件声明，并由公共认证契约解析 | `src/gateway/group/groups.js:163-188`；`config/credentials.js:45-57` | **未打通**：隔离探针中 `account:` 被拒绝，见 `06` R-03 |
| **输出接缝** | 驱动流输出必须与 model-team 消费方契约一致 | `platforms/qoder/infer.js:81-90`；`gateway/transport/sse.js:87-95` | **未打通**：解析后对象直接交给 `event.data` 解析器被判无效，见 `06` R-04 |
| **真实可用性** | 一次性导入既有账号后，在 DSH 完成真实回复并记录 usage / finish | 当前实例只读 API + `06` R-05/R-06 | **未验收**；已有账号或签名对拍都不能替代真实完整对话 |

## 七、我们犯过的错（按时间，写清代价）

| # | 错在哪 | 后果 | 教训（已落点） |
|---|---|---|---|
| 1 | 没读实际函数就把参数差异判为缺陷 | 换 client_id / redirect_uri 不能证明修好 | 成套记录来源与当前实现，未知结论不下发修改 |
| 2 | 根据“授权已超时”文案推断原因 | 界面错误分类不等于根因 | `20` 只保留事实、证据缺口和可验证要求 |
| 3 | 把二次点击 / 旧授权页当作已发生事实 | 缺少同次操作关联证据 | 按 `20` §八验证关联与复用，不能编造事件序列 |
| 4 | 内部术语与额外导入入口露到登录界面 | 用户入口和需求不一致 | 前端暂缓；恢复时按 `17` 主路径验收 |
| 5 | 只测加密或信封模块就宣布能聊天 | 群接入与流转换仍可能阻断 | 必须通过 `06` R-03/R-04/R-06 的完整调用链 |
| 6 | 只按 header 名或来源注释断言防封效果 | 没有证明实际请求包含正确值 | 分接口核对实际发送与实际响应，不推广另一接口的结论 |

## 八、本表的使用纪律

1. 改任何 Qoder 相关代码前，先在本表找到对应行；**没有对应行就先加一行**（连同证据行号）再动手。
2. 两家参考冲突时（如 `client_id`、授权站点），**保留可切换 + 日志可观测**，真机一次定论后删掉多余分支。
3. 任何一行标着「未实现 / 待对齐」的，不许在文档或回复里说成「已支持」。
