# 15 forward 双模式实施方案（G12）

> 定位：`12` 讲**为什么**要双模式；本文讲**怎么落地**、已定的三个决断、以及验收口径。
> 状态：**已实现**（0.2.1）。按第七节看板逐步提交；现有三个群以显式 `mode: "rewrite"` 保持线上行为不变，观察一轮后再删那三行翻默认。
> 一句话结论：**默认从 rewrite 翻成 forward**——因为 rewrite 的风险是长期且不可穷举的（每次上游协议微调都要改我们），
> forward 的风险是切换时一次性的（跑通后由宿主/pi-ai 承担协议细节）。

## 一、目标与默认值

| 项 | 规定 |
|---|---|
| 两种模式 | `forward`：只换 `provider`/`model`，其余 `options` 原样交回 `ctx.llm.stream()`；`rewrite`：现状（自己转消息、自己发 HTTP、自己解析流） |
| 默认 | 群配置**不声明 `mode`** → **forward** |
| 降级 | 目标协议在宿主没有适配器（`LlmError` code `NO_ADAPTER`）→ **同一次调用内**改走 rewrite |
| 递归守卫 | 目标 `provider` 属于本插件注册的 `providerIds` → 拒绝转发，直接 rewrite |
| 非法值 | `mode` 写了未知值 → warn 一次并回退默认（forward），不静默当成 rewrite |

## 二、三个已定决断

### 2.1 降级方式：运行期探测（不用静态能力位）

捕获宿主抛出的 `NO_ADAPTER` 即降级，**不维护协议能力清单**。

- 依据：宿主 `packages/llm/llm/src/index.ts:995` 就是 `throw new LlmError(..., 'NO_ADAPTER')`，这是稳定信号。
- 好处：新增协议自动获得 forward 能力，不需要先登记；忘登记不会误判。
- 代价：降级要等首次调用失败。**约束：只在首个 chunk 之前允许降级**；已经吐过块就不能重发（会重复输出）。

### 2.2 灰度：先按群显式，验证后再翻默认

实施期不让默认值立刻生效：

1. 代码落地时默认值就是 forward（按目标形态写）；
2. 但**同时**把现有三个群的配置显式写成 `mode: "rewrite"`，保持线上行为不变；
3. 观察一轮（覆盖带工具、带图片、长上下文各一次）确认无异常；
4. 再删掉那三行显式声明 → 默认值自然接管。

这样「默认 forward」是代码事实，「先 rewrite」是配置事实，两者不冲突，回滚只需加回一行配置。

**当前灰度状态（0.2.1 实施当天）**：运行时配置（`<dataRoot>/config.json`，该文件不入库）里
`agnes` / `agnes2` / `sa6400` 三个群都写了 `mode: "rewrite"`，读回校验一致。
观察一轮（带工具 / 带图 / 长上下文各一次）后，删掉这三行即可让默认 forward 接管；
删除前 forward 路径只由单测覆盖，不参与线上流量。

### 2.3 图片：交给宿主判定，但入口必须开着

**这里有个前提必须写清**：DSH 是按本插件 `resolveModel()` 申报的 `inputModalities` 决定「用户能不能附图片」的。
若 forward 下完全不声明，用户连附图入口都没有，宿主的拒绝永远轮不到——那不是「交给宿主判定」，是「永远不能用图」。

因此 forward 路径的规定是：

| 环节 | 做法 |
|---|---|
| `resolveModel` | **乐观声明** `['text','image']`（不因目标协议保守而关闭入口） |
| 三态门禁（`image-gate.js`） | forward 下**不执行**（那是 rewrite 路径的职责） |
| 目标协议不支持图片 | 由宿主适配器报错，错误原文透传，不翻译成我们的文案 |
| `image-prefetch.js` | forward 下**不执行**——宿主自己处理附件（`llm-pi-ai` 的 `userContent` 路径会读 attachment） |

## 三、风险与缓解

| 风险 | 缓解 |
|---|---|
| 递归自调用（目标 provider 就是我们自己） | 转发前硬判 `providerIds.includes(target.provider)` → 直接 rewrite |
| 双重包装：把宿主的 StreamChunk 再包一层 | forward 路径**逐块原样 yield**，禁止复用 `llm-protocol.js` 的拼装器 |
| usage 双计或口径漂移 | forward 只**旁路观测** chunk 里的 usage；请求行字段照写，但不再自己算 |
| 流中途失败后降级 | 只在首块前降级；已出块则原样抛错 |
| 压缩调用（`purpose:'compaction'`）走错链路 | 与 chat 同入口，`purpose` 原样透传，不特殊对待 |
| 并发 | 不引入模块级可变状态（现有约束不变） |

## 四、涉及文件

| 文件 | 操作 | 预估 | 说明 |
|---|---|---|---|
| `src/plugin/adapter/mode.js` | 新增 | +40 | 模式解析纯函数（显式 → 默认 forward；非法值回退） |
| `src/plugin/adapter/forward.js` | 新增 | +90 | 转发通道：解析目标 → 递归守卫 → 调 `llmStream` → 原样 yield + 旁路观测 usage |
| `src/plugin/adapter/adapter.js` | 修改 | ±60 | `stream()` 入口分流；`resolveModel` 按模式申报能力；forward 不跑 gate/prefetch |
| `src/plugin/index.js` | 修改 | +6 | 注入 `llmStream: (options) => ctx.llm.stream(options)` |
| `src/gateway/config/config.js` | 修改 | ±15 | `groups[].mode` 校验（`forward` / `rewrite`）与默认回填 |
| `test/forward-mode.test.js` | 新增 | +180 | 模式解析、递归守卫、`NO_ADAPTER` 降级、首块后不降级、等价性对拍 |
| `docs/02-契约.md` §六 | 修改 | ±12 | 新增「转发模式」条款：默认 forward、降级条件、递归守卫 |
| `docs/12` | 修改 | ±6 | 状态改为「方案已定，实施见 15」，优先级口径按新默认重写 |

## 五、影响分析

| 维度 | 程度 | 说明 |
|---|---|---|
| 现有功能 | **高** | 默认行为变化：未声明 `mode` 的群从 rewrite 变 forward（用 §2.2 的灰度控制） |
| 性能 | 低（正收益） | forward 少一层我们自己的 HTTP，理论上略快 |
| 兼容性 | 中 | 新增可选字段；旧配置不加也能跑（走 forward） |
| 安全性 | 低 | 不新增外连；凭据仍走宿主/baseURL 体系 |
| 可维护性 | **正收益** | rewrite 从「唯一路径」退为「特定协议的后备」，维护面收窄 |

## 六、验证方案

| 层 | 验什么 | 判据 |
|---|---|---|
| 单测 | `mode.js` 四类输入（显式 forward / 显式 rewrite / 未声明 / 非法值） | 四例各一条断言 |
| 单测 | 递归守卫 | 目标 provider 是自己 → 走 rewrite，且不调用 `llmStream`（用桩计数） |
| 单测 | 降级 | 桩抛 `NO_ADAPTER` → 同一次调用内走 rewrite；**首块后**抛则不降级、原样报错 |
| 等价性 | 同一批 fixture（含工具调用 / 图片 / 长文本 / usage）两模式对拍 | 「最终文本 + 工具调用序列 + usage + 错误码」逐项一致 |
| 回归 | 415 条既有用例 | 在 `mode:'rewrite'` 下**一条不改** |
| 真机 | forward 下跑一轮带工具 + 一轮带图 | 会话可继续、请求行 token 与速率正常、图能看见 |
| 门禁 | 八道 | 全绿 |

## 七、任务看板（按难度升序，每步一提交）

| 步 | 任务 | 提交信息 |
|---|---|---|
| 0 | 基准：415 用例 + 八道门禁，记录数字 | — |
| 1 | `mode.js` + 四例单测 | `feat(mode): 模式解析纯函数，默认 forward` |
| 2 | `config.js` 支持 `groups[].mode` | `feat(config): 群支持 mode 字段` |
| 3 | `forward.js` 骨架 + 递归守卫（暂不接主链路） | `feat(forward): 转发通道与递归守卫` |
| 4 | `adapter.js` 分流 + 注入 `llmStream` | `feat(adapter): stream 按模式分流` |
| 5 | `NO_ADAPTER` 降级（首块前）+ 首块后不降级 | `feat(forward): 同轮降级与不可降级判定` |
| 6 | 等价性测试 | `test(forward): 两模式输出等价` |
| 7 | 契约 §六 + `12` 状态 | `docs(02,12): 转发模式条款` |
| 8 | 三个群显式 `mode:'rewrite'` + 部署同步 + 全量门禁 | `chore(config): 显式 rewrite 保行为，待观察后翻默认` |

## 八、执行纪律

- 每步一提交，便于单独回滚；第 8 步之前**线上行为不变**（因为配置显式 rewrite）
- 改 `src/**` 后必须跑 `node scripts/check-deploy-parity.mjs`
- 不为了通过测试改断言语义；等价性用**新增**用例表达
- 发现阻塞性问题先报再改，不顺手扩大范围

## 九、本次不做

- 协议工厂（`buildRequest` / `parseStreamChunk` / `extractUsage` 的注册表与逐家实现）——先把双模式跑通，工厂是下一步
- 协议能力静态清单（已由 2.1 的运行期探测取代）
- forward 下宿主错误码到本项目 `ERROR_CODES` 的完整映射（先原样透传，攒够样本再归类）
