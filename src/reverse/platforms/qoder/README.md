# Qoder 平台实现（反代）

本目录是 Qoder 这一家平台的全部实现：登录、设备指纹、加密推理、模型目录、错误认领。
框架只按 `manifest.js` 的声明加载，不认识这里的任何细节——加一家新平台不需要改通用层。

> 本文件只放**实测事实**（谁测的、什么时候、看到什么），不放设想。未验证项单独一节，不许写成"已支持"。

## 一、目录职责

| 文件 | 职责 |
|---|---|
| `index.js` | 平台自描述：端点表、登录 profile、超时、能力位；同时是契约方法入口 |
| `oauth.js` | 设备码授权：拼授权 URL、轮询领 token、取 userinfo |
| `fingerprint.js` | 设备指纹由 `userId` 派生（`machineToken` / `machineType`），同 uid 恒定 |
| `headers.js` | COSY 头族（纯函数） |
| `claimers.js` | 上游业务错误的**认领规则**（如 `code:112` = 额度/权益不足） |
| `catalog.js` | 模型目录：远端拉取 + TTL 缓存 + 解析 |
| `infer.js` | 一次推理：加密请求 → SSE → 剥信封 → SSE 事件（交给上层） |
| `crypto/` | COSY 签名：`native`（纯 Node，默认）/ `wasm`（可选后端） |
| `envelope.js` | SSE 信封剥离 |
| `http-client.js` | 反代 HTTP 客户端（超时下沉到 I/O 边界） |
| `machine-id.js` | 本机标识解析（系统 id → 派生 → 持久化） |
| `wasm-path.js` | wasm 三档定位 |

## 二、登录实测

| 项 | 实测值 | 来源 |
|---|---|---|
| 授权站 | `https://qoder.com.cn` | 2026-11-08 运行实例实测（此前误用 `qoder.cn` 与另一家 client_id 混搭，导致"页面登录成功、插件收不到"） |
| client_id | `1c5e33e1-364d-4ce6-b02c-acaa81274a5c` | 同上（与授权站、redirect_uri 成套，不可拆开混用） |
| redirect_uri | `qoder-work-cn://` | 同上 |
| 轮询端点 | `GET https://openapi.qoder.com.cn/api/v1/deviceToken/poll` | 契约参数 `nonce` / `verifier` / `challenge_method=S256` |
| pending 语义 | 404、202 均视为"尚未授权" | 轮询日志可见 |
| 领取结果 | 2026-11-08 22:2x 一次真实登录：账号落库，昵称「理论永久最恒久」 | `/_team/reverse/accounts` 返回 `origin:login`、`refreshable:true` |

## 三、模型目录实测（远端拉取）

端点：`GET https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1`
**必须带 body**（body = `qoderEncode('{}')`，签名覆盖同一串）；裸 GET 实测 **403**。

2026-11-08 22:28 用真实账号拉取，`chat` 场景 **12 条**：

| key | 展示名 | price_factor | is_free |
|---|---|---|---|
| `qfmodel` | Qwen3.8-Flash | 0.04 | **true** |
| `dfmodel` | DeepSeek-Flash | 0.1 | — |
| `gfmodel` | GLM-5.3-Flash | 0.1 | — |
| `mmodel` | MiniMax-M3.1-Flash | 0.1 | — |
| `qmodel_38max` | Qwen3.8-Max | 0.2 | — |
| `jmodel` | Step-5-Preview | 0.3 | false |
| `auto` | Auto | 0.5 | — |
| `dmodel` | DeepSeek-V4-Pro | 0.5 | — |
| `fast` | Fast | 0.8 | — |
| `gmodel` | GLM-5.3 | 0.8 | false |
| `kmodel` | Kimi-K2.8-Preview | 0.8 | — |
| `kmodel_latest` | Kimi-K3.1-Pro | 1 | false |

- 缓存：进程内 10 分钟 TTL + `<dataRoot>/reverse/<platformId>/catalog.json`（0600，含 `fetchedAtMs`）。
- 拉取失败**不回落静态表**（代码里已无任何写死模型名）：非明文 JSON → `REVERSE_CATALOG_UNDECRYPTABLE`；非 2xx → `REVERSE_CATALOG_UPSTREAM_FAILED`；缺 `chat` → `REVERSE_CATALOG_SHAPE_INVALID`。

## 四、推理实测

| 项 | 实测值 | 说明 |
|---|---|---|
| 成功一次完整回复 | 2026-11-08 18:05:21，`status 200`，耗时 7.11s，`total 102.8k`，`completion 250` | 真实账号走 DSH 对话，请求行可查 |
| 加密链路 | 走 `/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1` | 公开 `/model/v1/chat/completions` 只认通用模型名，**不用于推理** |
| 响应形态 | SSE + 信封 `{headers, body, statusCode}`，`body` 是 JSON 字符串 | 剥壳后交给上层 |
| 速率 | 精确值需首字时刻（`decodeMs`）；缺首字时刻时只能给下界 | 见 `docs/02` §五.1 |

## 五、失败语义实测

| 场景 | 上游返回 | 我们的表现 |
|---|---|---|
| 额度/权益不足 | 单帧 `{"code":"112","message":"{\"pricingUrl\":…}"}`（HTTP 仍 200） | 认领为 `UPSTREAM_QUOTA_EXHAUSTED`，请求行 `status 402`、`claimedReason: qoder-code:112`；界面显示「额度/权益不足」，**不再出现"已完成但没回复"**（2026-11-08 22:35:18 实测） |
| 其它业务错误码 | `{code, message}` 且无 `choices` / 无 `usage` | `UPSTREAM_BUSINESS_ERROR`，`reason: qoder-code:<code>` |
| 401 / 403 | 上游拒绝 | 明确失败，**不重试、不换账号、不降级公开端点** |
| 加密失败 | 本地签名/加密异常 | 直接抛错，请求不发 |

## 六、防封与节流（数值口径）

| 族 | 触发 | 首次窗口 | 封顶 | 错误码 |
|---|---|---|---|---|
| 软限流 | 上游 429 | 600s | 7200s | `REVERSE_ACCOUNT_SOFT_LIMIT` |
| 熔断 | 连续 3 次硬失败（5xx/网络） | 1800s | 21600s | `REVERSE_ACCOUNT_BREAKER` |
| 降权 | 连续 5 次未知失败 | 600s | 7200s | `REVERSE_ACCOUNT_DEGRADED` |

- 冷却期内**不发上游请求**；401/403 不冷却（该重新登录）。
- 同一账号两次上游请求最小间隔 **1s**，不足则等待。
- 推理 UA = `undici`（与参考实现默认一致，可 `DSH_MODEL_TEAM_QODER_UA` 覆盖）。**不要**改成带插件名的 UA——那是最容易被识别为脚本的指纹。
- 设备指纹由 `userId` 派生且"只补不覆盖"：存量账号不会被改成新设备。

## 七、未验证项（不许当成已完成）

| 项 | 现状 |
|---|---|
| 真实 429 退避 | 只有注入桩用例，未撞过真实限流 |
| 额度重置时刻 | 已知 `112` 会因额度触发，**重置规则未实测** |
| 派生指纹被 CN 侧接受度 | 已用于登录并成功对话，但"换设备前后是否被区别对待"未验证 |
| wasm 后端 | native 为默认；wasm 仅在资源存在时可用，未做真实推理对拍 |

## 八、怎么跑

```bash
node scripts/reverse-login.mjs --platform qoder    # 登录（不打印 token）
node --test test/reverse-*.test.js                 # 本平台相关用例
node scripts/reverse-cosy-vectors.mjs              # 签名与参考实现逐字节对拍
```
