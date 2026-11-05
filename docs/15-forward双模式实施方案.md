# 15 forward 双模式：链路与实施方案（G12）

> 定位：`12` 讲为什么要有双模式；本文画清链路、定死边界与实施口径。
> 状态：**已搁置**（2026-11-05）。阻塞原因见 `08` 的 G12 行：forward 依赖宿主 `resolveProfiles`，该函数存在于 bundle 但未导出。
> 恢复时先跑 `node lib/shared/patch-host-pi-ai-export.mjs --apply` 补导出（幂等、带备份、写完自动验证），再按 §六 实施。

## 一、链路

```
DSH agent-loop
  │  ctx.llm.stream({ provider:'dsh-model-team', model:'dsh-model-team', sessionId, messages, tools, purpose })
  ▼
[llm 服务] 按 provider 路由 → 声明 dsh-model-team 的适配器（本插件）
  ▼
本插件 src/plugin/adapter/adapter.js  stream(options)
  │ ① normalizeSessionId(options.sessionId)
  │ ② 解析目标：session → 群 + 真实模型（分组轮转 / 父链回落 / 兜底群）
  │ ③ 按 mode 选内部实现 —— forward 与 rewrite 的全部区别
  ├──── rewrite：协议转换由我们做 ────
  │    adapter/support.js       dsh ContentBlock → OpenAI messages/tools
  │    transport/dispatcher.js  发 HTTP（群 baseURL + 群凭据）
  │    transport/sse.js + adapter/llm-protocol.js   SSE → StreamChunk
  │    image-prefetch / image-gate
  └──── forward：协议转换交给官方库 ────
       new PiAiAdapter({
         profiles: () => Map([[群id, 由群配置解析出的 profile]])   // 端点 = 群 baseURL
         resolveApiKey: async () => 群自己的凭据
         auth: { credentials: new InMemoryCredentialStore(), … }
       })
       for await (chunk of piai.stream({ provider: 群id, model: 真实模型, …options })) yield chunk
       // 官方负责 messages / images / tools / usage / SSE → StreamChunk
  ▼
StreamChunk 逐块 yield 回 DSH（forward 原样；rewrite 经 llm-protocol 组装）
  ▼
DSH 落会话；本插件旁路记录请求行（usage / latency / decodeMs / 目标来源）
```

**两种模式的差异只在「③之后由谁做协议转换」；输入（群、真实模型、消息、工具）与输出（StreamChunk）完全相同。**

| 职责 | rewrite | forward |
|---|---|---|
| 端点 | 群 `baseURL` | 群 `baseURL`（同一个） |
| 凭据 | 群 `auth` / `apiKeyRef` | 群 `auth` / `apiKeyRef`（同一个） |
| 消息/工具/图片 → 上游协议 | `adapter/support.js`（我们） | `PiAiAdapter`（官方库） |
| HTTP 发送 | `dispatcher.js`（我们） | `PiAiAdapter`（官方库） |
| SSE → StreamChunk | `sse.js` + `llm-protocol.js`（我们） | `PiAiAdapter`（官方库） |
| usage 提取 | 我们 | 官方；我们旁路观测后落行 |

**为什么不经过 `ctx.llm.stream`**：该入口按 `options.provider` 路由，route 归注册者（`packages/llm/llm/src/index.ts:483`），而本插件只声明了 `dsh-model-team`——转发给它等于调回自己。且 `GenerateOptions`（`types.ts:509-556`）没有 `request` 字段，**不存在 per-call 端点/凭据覆盖**，借别人的 route 就必然用别人的 key。所以 forward 直接实例化官方适配器，端点和凭据都用群自己的。

## 二、能力探测

| 项 | 做法 |
|---|---|
| 官方包是否可加载 | 启动时 `import('@deepseek-ai/dsh-llm-pi-ai')` 探测一次并缓存结果；失败则该群走 rewrite 并 **warn 一次**（不每请求刷屏） |
| profile 怎么拼 | 用包内导出的 `Config`（zod schema）解析群配置得到，缺项走包默认；**不手写** `ResolvedPiAiProviderProfile` |
| 凭据怎么给 | `resolveApiKey` 返回群 `auth` / `apiKeyRef` 解出的值（复用现有 `credentials.js`） |

## 二点五、宿主能力自愈（启动补导出 / 卸载还原）

forward 需要宿主包导出 `resolveProfiles`。宿主没导出时，插件在 `apply` 阶段自己补上，`dispose` 阶段还原——不依赖人工跑脚本。

| 时机 | 动作 |
|---|---|
| `apply` | `import.meta.resolve(@deepseek-ai/dsh-llm-pi-ai)` 定位 bundle（不写死路径）→ 读文件 → **已导出则什么都不做**；未导出则：备份原文到内存 → 末尾追加 `export { resolveProfiles };` → 动态 import 验证是函数 → 失败则**回滚并 warn 一次**，插件照常加载（forward 降级 rewrite） |
| `dispose` | **只在我们确实补过、且当前文件内容与我们写入的一致时**才还原（比对内容，不比时间戳）；否则不动——避免踩掉宿主升级或别人的补丁 |
| 权限不足 / 文件只读 | warn 一次（含路径与原因），降级 rewrite，**不抛错、不影响插件加载** |
| 宿主升级 | 文件被覆盖 → 我们的补丁消失 → 下次 `apply` 自动重补 |
| 并发（主实例 + 测试实例） | 不做跨进程锁；还原前校验内容一致，不一致就留给对方，只 warn |
| 门禁 / 单测进程 | `NODE_TEST_CONTEXT` 存在时跳过自动补导出（跑测试不该改宿主文件）；测这段逻辑的用例直接调 `ensureHostExport` 并注入假 bundle |

**为什么要「内容一致才还原」**：直接按备份覆盖回去，会把宿主升级后的新文件、或另一个实例刚补的导出一起抹掉——那比不还原糟得多。

## 三、降级与失败语义

| 情形 | 行为 |
|---|---|
| 群声明 `mode:"rewrite"` | 直接 rewrite，不构造官方适配器 |
| 群未声明 `mode` | 默认 forward |
| 官方包 import 失败 | 该群 rewrite + warn 一次（探测结果缓存） |
| 适配器构造失败 / `stream()` 在首块前抛错 | 同一次调用内改走 rewrite，warn 含原文 |
| 首块之后抛错 | 原样抛出，**不重发**（会重复输出） |
| 群缺 `baseURL` 或凭据 | 沿用现有配置校验错误（`INVALID_BASE_URL` / `MISSING_CREDENTIAL`），不进入 forward |
| 目标形状 | 只支持**单模型**目标；分组轮换一律 rewrite |

## 四、配置

```jsonc
{ "groups": [
  { "id": "agnes", "mode": "forward", "baseURL": "…", "auth": { … } },   // 官方库转换，端点/凭据用本群
  { "id": "agnes2", "mode": "rewrite", "baseURL": "…", "auth": { … } }   // 我们自己转换
] }
```

`groups[].mode` 只认 `forward` / `rewrite`；非法值剔除并逐条 warn，语义回到「未声明」。**没有 `provider` 字段**。

## 五、验收

| 层 | 判据 |
|---|---|
| 单测 | `mode.js` 四态；官方包探测失败 → rewrite + 只 warn 一次；首块前抛错 → 降级；首块后抛错 → 不降级 |
| 可行性探针（不入库） | 用群配置造出 profile，对着本地 stub 上游跑通一次 `piai.stream()`，证明能产出 StreamChunk |
| 等价性 | 同一 fixture 两模式对拍：文本 / 思考 / 工具调用序列 / 块边界 / usage / 完成原因逐项一致 |
| 回归 | 既有 435 条用例零改动 |
| 真机 | forward 下跑「带工具」与「带图」各一轮；请求行 token / 速率正常；图能看见 |
| 门禁 | 八道全绿 + `check-deploy-parity` |

## 六、任务看板

| 步 | 任务 | 判据 |
|---|---|---|
| 1 | **可行性探针（不入库）**：用群配置拼 profile → 对本地 stub 上游跑通 `piai.stream()` | 能产出文本/工具/usage 三类 chunk |
| 2 | `forward.js` 换成官方库形态；删除 `provider` 相关逻辑 | 单测：探测失败降级、首块前降级 |
| 3 | 官方包一次性探测 + 失败只 warn 一次 | 桩：连续 5 次调用只 warn 1 次 |
| 4 | 等价性用例（同一 fixture，两模式投影一致） | 六项投影无差异 |
| 5 | 配置校验只保留 `mode`；契约 §6.1 与本文一致 | `check-contract` 通过 |
| 6 | 灰度：三群暂显式 `rewrite`；真机验 forward 后删三行 | 线上行为不变直到删行 |

## 七、本次不做

- 协议工厂（多协议 `buildRequest` / `parseStreamChunk` 注册表）：官方库已覆盖 pi-ai 支持的协议族
- 多协议能力位清单：以「官方包能否构造」为唯一判据
- forward 下错误码到本项目 `ERROR_CODES` 的完整映射：先原样透传
