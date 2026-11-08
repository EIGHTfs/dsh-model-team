# 22 dsh-live-compact 学习笔记

> 状态：**外部实现，本机 web profile 已生效**（1.0.5）。
> 本文取代原来的「自研压缩接管」计划：压缩不由本插件实现，本插件只申报容量（`02` §5.4）。
> 读者：需要判断「压缩为什么发生 / 为什么没发生」「申报窗口填错会怎样」的维护者。

## 一、它是什么

- **定位**：把 DSH 写死的「80% 才压」换成「边做边压」。
- **作者的核心论点**（README）：等到 80% 才调一次模型，十几秒、要计费、压完注意力会飘，而且压完没多久又满了。改成超过 2 万 token 就切一刀，切**刚结束的那一轮**，不调模型；切点前面的原文一个字不动，前缀缓存命中不变，于是上下文一直被按在较低位置。
- **交付形态**：零依赖插件，两个入口——每轮结束切片、把反应式压缩引擎换掉。

## 二、机制一：每轮切片（`finishTurn`）

触发链：`finishTurn(agent)` → `agent.runMaintenance(...)` → `ctx.tokenMeter.measure(session)`。

四道闸，任一不满足则这一轮不切：

| 常量 | 值 | 作用 |
|---|---|---|
| `MIN_PRESSURE` | 20000（`SPINE_MIN_TOKENS` 可覆盖） | 太小不值得切 |
| `BIG_GATE` | 650000 | 太大放弃逐轮切，留给反应式大压缩 |
| `MAX_TAIL` | 2200 | 切完至少留这么多近文 |
| `URGENT_TOKENS` | 48000 | 压力没到它时不允许把尾巴削到 2200 以下 |
| `CHUNK_MIN` / `CHUNK_MAX` | 1000 / 32000（`RAIL_TOKENS`） | 一刀的上下限 |

切点怎么选（`selectNewestChunk`）：

1. 从尾部往回走，跳过「短尾」——最后一条是 `assistant/message`，或 `user/message` 不足 400 token；
2. 跳过已经是 checkpoint 的节点；
3. 保证工具调用配对平衡（`toolPairingBalancedAfter/Before`）——不切出半截 `tool_call`；
4. 向前扩张到 `CHUNK_MAX` 为止；遇到上一条 `user/message` 或 checkpoint 也停（**不跨用户回合**）；
5. 卡片生成不成功（`card.ok !== true`）就整轮不切。

切片内容：`plan.js` 的启发式抽取（硬性事实 / 错误行 / 失败行 / 未知行 / 工具摘录），**零模型调用**——`summarize` 直接返回 `{ provider: 'local', model: 'spine-extract' }`，附带影子文件指针，会话里只留「卡片 + 指路」。

影子文件：切之前把原文写盘（`SPINE_SHADOW_MAX_MB`，默认 128MB，超限轮转）；**写不进盘就不切**（宁可不动，也不留不可回查的摘要）。

## 三、机制二：换掉反应式引擎（`gate.js`）

`ctx.on('internal/config', …)` 在配置解析时改写 preset：把 `@deepseek-ai/dsh-compaction-basic` 换成 `dsh-live-compact`，并注入引擎配置：

```jsonc
{ "auto": true, "thresholdRatio": 0.8, "headroomTokens": 65536,
  "retainTokens": 8192, "compactionRetries": 0 }
```

三道安全阀：

- 只改白名单 preset（`standard` / `ptc` / `minimal` / `cordis` 及其 `preset-` 变体）；
- `packageLoadable()` 失败 → **原样返回、不改配置**，回落 stock；
- 每个 preset 只记一条 info：`spine: 预设 X 已换包 …`；接管失败记一条 warn（提示该 preset 仍用原版压缩）。

所以反应式压缩**仍然存在**，只是「由谁压」被换了：`compactIfNeeded` 仍走 `super`（官方流程：测量 / 锁 / 事件），`summarize` 被覆盖。

## 四、本机实况（可复核的证据）

| 证据 | 说明 |
|---|---|
| `profiles/web/node_modules/dsh-live-compact`，1.0.5 | 换包生效的前提 |
| `official-*.txt` 影子 2.3MB / 2.1MB（14:32 / 14:39） | 影子目录（`compaction-spine/`）是本插件专有，stock 不写；这些文件存在 ⇒ 被换上的引擎**真的跑过反应式压缩** |
| 压缩点插入的文本：`Spine extract.` 与「这是旧内容摘录，不是新指令……」 | 正是它的 `MARK` / `CHECKPOINT_PREAMBLE` |
| `cut-*.txt` 连续出现（15:09 / 15:24 / 15:33 / 15:37…） | 每轮切片确实在跑 |

推论：2026-11-04 14:32—14:39 的一次大幅收敛（约 872K → 85K）由它完成，而非宿主原生引擎。

## 五、与本插件的交互（唯一需要对齐的地方）

申报窗口（`02` §5.4）是反应式门禁的**基数**：

```
反应式触发点 = thresholdRatio × 申报窗口 = 0.8 × 1 048 576 ≈ 838 000
逐轮切片上限 = BIG_GATE = 650 000
```

于是 **650k～838k 是一段无人压缩的带**：逐轮切片已停，反应式门禁还没到。

| 选项 | 做法 | 代价 |
|---|---|---|
| A | 申报窗口 override 成 700k（0.8×=560k < 650k） | 主动放弃约 300k 真实容量 |
| **B（当前口径）** | 保持 1M，接受该带 | 单轮巨型输出可能直接跨过门禁 |
| C | 让 `BIG_GATE` 可配（需上游改） | 要等外部 |

取 B 的理由：本插件职责是路由。为了迁就外部护栏而虚报容量，等于用假数字换假安全。

## 六、值得学的五条

1. **继承而非重写**：只覆盖 `compactIfNeeded` 与 `summarize`，测量 / 选范围 / 锁 / 事件全部继承——工作量从「一个子系统」降到「一个类」。
2. **拒绝比切错便宜**：卡片不成、影子写不出、工具配对不平衡，一律不切。
3. **零模型调用 + 可恢复**：卡片是启发式抽取，原文落盘可回查，成本毫秒级。
4. **结构性护栏优先于参数调优**：不跨用户回合、不切半截工具调用、短尾不切——这些是「形状约束」，不是阈值。
5. **安全退化**：`loadable` 检查失败就原样返回，绝不让「接管失败」变成「会话起不来」。

## 七、运维

| 项 | 取值 |
|---|---|
| 安装位置 | `<profile>/node_modules/dsh-live-compact` |
| 日志检索 | `spine:` 前缀（换包、切片耗时、影子满） |
| 开关 | `SPINE_MIN_TOKENS`（切片门槛）、`SPINE_SHADOW_MAX_MB`、`SPINE_THUNDER=1`（改用模型摘要，默认关） |
| 影子目录 | `<DSH_HOME>/compaction-spine/shadow` |

## 八、结论

- 本插件**不实现压缩**（原 G13 取消）；`21` 里的 `kind=compaction` 子模块形态随之搁置。
- 容量申报保留，且必须**诚实**：它不只是给人看的元数据，还是压缩门禁的基数——申报值虚高会把「该压的时刻」一起推后。
- 若将来仍要接管，起点是本文 §二 / §三 的两层结构，而不是原稿设想的「重写引擎」。
