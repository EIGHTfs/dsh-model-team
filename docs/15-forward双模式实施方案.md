# 15 forward 双模式：链路与实施方案（G12）

> 定位：`12` 讲为什么要有双模式；本文画清链路、定死边界与灰度。
> 状态：**已实现**（`mode.js` / `forward.js` / 配置校验 / 等价性用例）。线上三个群暂显式 `rewrite` 保行为，见 §五。

## 一、链路

```
DSH agent-loop
  │  ctx.llm.stream({ provider:'dsh-model-team', model:'dsh-model-team', sessionId, messages, tools, purpose })
  ▼
[llm 服务] 按 options.provider 路由 → 声明 dsh-model-team 的适配器（本插件）
  ▼
本插件 src/plugin/adapter/adapter.js  stream(options)
  │ ① normalizeSessionId(options.sessionId)
  │ ② 解析目标：session → 群 + 真实模型（分组轮转 / 父链回落 / 兜底群）
  │ ③ 按 mode 选内部实现
  ├──── rewrite：协议转换由我们做 ────
  │    adapter/support.js       dsh ContentBlock → OpenAI messages/tools
  │    transport/dispatcher.js  HTTP（群 baseURL + 群凭据）
  │    transport/sse.js + adapter/llm-protocol.js   SSE → StreamChunk
  │    image-prefetch / image-gate
  └──── forward：交给宿主已有 provider ────
       ctx.llm.stream({ ...options, provider: 群的 provider, model: 真实模型 })
       协议转换、HTTP、SSE 全部由该 provider 的适配器（pi-ai）负责
  ▼
StreamChunk 逐块 yield 回 DSH（forward 原样；rewrite 经 llm-protocol 组装）
  ▼
DSH 落会话；本插件旁路记录请求行（usage / latency / decodeMs / 目标来源）
```

| 职责 | rewrite | forward |
|---|---|---|
| 端点 | 群 `baseURL` | **宿主 provider 的** baseURL |
| 凭据 | 群 `auth` / `apiKeyRef` | **宿主 provider 的**凭据 |
| 消息/工具/图片转换 | 我们 | pi-ai |
| HTTP 发送 | 我们 | pi-ai |
| SSE → StreamChunk | 我们 | pi-ai |

**forward 的语义是「把这个群当作某个宿主 provider 的别名」**，因此它用对方的端点与凭据；群自己的 `baseURL` / `auth` 只在 rewrite 下生效。

## 二、为什么不能转发给 `dsh-model-team`

route 归注册者：`ctx.llm.stream` 按 `options.provider` 找声明该 route 的适配器（`packages/llm/llm/src/index.ts:483`），而本插件只声明了 `dsh-model-team`。转发给它就是调回我们自己 → 递归。所以：

- `group.provider` **必须是宿主里另一个适配器注册的 route**（pi-ai 那些，如 `agnes`、`sa6400`）
- 目标 provder 命中本插件 `providerIds` 时 → 守卫拦下，走 rewrite

## 三、模式与降级

| 情形 | 行为 |
|---|---|
| 群声明 `mode:"rewrite"` | 直接 rewrite |
| 群声明 `mode:"forward"` 且 `provider` 有效 | forward |
| 群未声明 `mode` | 默认 forward；但**未声明 `provider` 时无法转发** → rewrite 并记 info（灰度期常态） |
| `mode` 非法值 | 剔除该字段并 warn，语义回到「未声明」 |
| 宿主无该 provider（`LlmError.code === 'NO_ADAPTER'`） | 同一次调用内改走 rewrite，warn 含原文；**只在首块之前允许**，已出块不重发 |
| 宿主未注入 `llmStream` | warn 一次，走 rewrite |
| 目标形状 | 只支持**单模型**目标；分组轮换一律 rewrite |
| 图片 | forward 下 `resolveModel()` 声明 `['text','image']`；forward 路径不执行 `image-gate` / `image-prefetch`，由宿主适配器判定 |
| 请求行 | forward 的 usage 来自旁路观测，不重算；写入复用同一份 `recordRow` |

## 四、配置

```jsonc
{
  "groups": [
    // forward：复用宿主已有 provider（端点/凭据都用它的）
    { "id": "sa6400", "mode": "forward", "provider": "sa6400", ... },
    // rewrite：完全由本插件实现协议（群自己的 baseURL/auth 生效）
    { "id": "agnes2", "mode": "rewrite", ... }
  ]
}
```

## 五、灰度（当前线上状态）

三个群显式 `mode: "rewrite"`，行为与改动前完全一致。观察一轮后删掉那三行即翻默认：

| 群 | 可复用的宿主 provider | 删行后的结果 |
|---|---|---|
| `sa6400` | 有（同名） | forward |
| `agnes` | 有（同名） | forward |
| `agnes2` | 无 | 未声明 `provider` → rewrite（正确：它本来就不在宿主里） |

## 六、验收

| 层 | 判据 |
|---|---|
| 单测 | `mode.js` 四态；递归守卫（桩计数证明降级时未调 `llmStream`）；`NO_ADAPTER` 同轮降级；首块后不降级 |
| 等价性 | 同一 fixture 两模式对拍：文本 / 思考 / 工具调用序列 / 块边界 / usage / 完成原因逐项一致 |
| 回归 | 既有 435 条用例零改动 |
| 真机 | forward 下跑「带工具」与「带图」各一轮；请求行 token / 速率正常；图能看见 |
| 门禁 | 八道全绿 + `check-deploy-parity` |

## 七、后续（本次不做）

- 协议工厂（多协议 `buildRequest` / `parseStreamChunk` 注册表）：先把双模式跑通
- `provider` 的自动匹配（群 id 与宿主 provider id 同名时自动复用）：目前要求显式声明，避免猜错凭据/端点
- forward 下错误码到本项目 `ERROR_CODES` 的完整映射：先原样透传
