// 上游 max_tokens 上限的自适应学习（真实问题：agnes 不报上限，只在 400 里说）。
//
// 背景：`GET /v1/models` 只回 id/object/created/owned_by/supported_endpoint_types，
// 既没有 max_tokens 也没有 context_length —— 限制**查不到**，只能从拒绝里学。
// 策略：捕获 400 的错误文案 → 解析该模型的声明上限 → 进程内存记住「可用值 = 上限 − 1」→ 后续请求直接用它。
//
// 设计取舍（存储介质已改为**纯内存**）：
//   1) 只在进程内存里记（Map）：撞到即学、秒级完成，省掉落盘的读写与失效维护；
//      代价是重启后要重新撞一次 400 才能再学到 —— 这是明确接受的预期行为（见单测）；
//   2) 群配置 `groups[].request.maxTokens` 优先于学习值（人工明确指定就该压过猜测）；
//   3) 取 min(原值, 可用值, 声明上限)：上限比原值大时不必抬高请求，抬高只会改变上游行为而没收益。

import { getDataRoot } from './paths.js';
import { defaultLogger } from '../logger.js';

// 目前能识别的文案（都能实测对上；认不出的一律返回 null → 不重试，宁可少认不可误判）：
//   · 中文：`max_tokens 不能超过 65536`
//   · 英文（token 短语在前）：`max_tokens must not exceed 4096` / `max tokens at most 2048`
//   · 英文（maximum 在前）：`maximum max tokens is 4096` / `the maximum number of tokens allowed is 2048`
//   · 英文（limit/cap 在后）：`max output tokens limit: 8192` / `tokens cap 4096`
const MAX_TOKENS_LIMIT_PATTERNS = Object.freeze([
  // token 短语 + 限定义关键词 + 数字
  /max[_\s]*tokens?[^0-9]{0,64}?(?:不能超过|exceed|greater\s+than|at\s+most|maximum)[^0-9]{0,64}?(\d+)/i,
  // maximum / max 在前，token 短语在后：`maximum max tokens is 4096`
  /(?:maximum|max)[^0-9]{0,32}?(?:max[_\s]*)?tokens?[^0-9]{0,32}?(\d+)/i,
  // token 短语 + limit/cap + 数字：`tokens limit 8192`
  /(?:max[_\s]*)?tokens?[^0-9]{0,32}?(?:limit|cap)[^0-9]{0,32}?(\d+)/i,
]);

// 合理性下限：真实上限基本都在 256 以上；低于它的数字更可能是别的参数（重试次数、页码），
// 拿它去夹 max_tokens 会把正常请求压成几 token，比不学更糟
const MIN_PLAUSIBLE_MAX_TOKENS = 256;

// 解析上游错误文案里的 max_tokens 上限；解析不出返回 null（调用方据此决定"不重试"）
export function parseMaxTokensLimit(errorText) {
  if (typeof errorText !== 'string' || errorText.length === 0) return null;
  for (const pattern of MAX_TOKENS_LIMIT_PATTERNS) {
    const matched = pattern.exec(errorText);
    if (!matched) continue;
    const limitValue = Number(matched[1]);
    if (!Number.isFinite(limitValue) || limitValue < MIN_PLAUSIBLE_MAX_TOKENS) continue;
    return Math.trunc(limitValue);
  }
  return null;
}

// (群, 模型) → 上限：模块内统一 key 形状，避免各处拼接出现 `a::b` 与 `a/b` 两种写法
export function limitKeyFor(groupId, modelId) {
  return `${groupId ?? ''}::${modelId ?? ''}`;
}

// 夹取规则：
//   1) 还没学到上限 → 发 configured ?? requested。人工写的高值有机会先试一次，
//      这样才能测出"上游是不是已经放宽"。
//   2) 已经学到上限 → 一律发 min(configured ?? requested, effective, learned)。
//      **学习值封顶配置值**：否则配置写得偏高时，每个请求都要先撞一次 400 再重发，
//      代价是多一次往返、上游多记一次失败、日志里持续冒出 400 掩盖真问题。
//   3) 想重新探测更高上限：最近一次学习只在进程内存里，重启进程即回到规则 1。
// 返回 { maxTokens, source }，source 只用于日志/排查（configured / learned / requested / none）
export function capMaxTokens({ requested, configured, effective, learned }) {
  const usableRequested = typeof requested === 'number' && Number.isFinite(requested) && requested > 0
    ? Math.trunc(requested)
    : null;
  const usableConfigured = typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? Math.trunc(configured)
    : null;
  const usableLearned = typeof learned === 'number' && Number.isFinite(learned) && learned > 0
    ? Math.trunc(learned)
    : null;
  // effective = "上游声明上限 − 1"这一档：上游按值直接判、边界排他（发上限本身会被拒），
  // 所以真正能用的值比声明上限小 1。它优先于声明上限，避免每次请求都要先撞一次 400。
  const usableEffective = typeof effective === 'number' && Number.isFinite(effective) && effective > 0
    ? Math.trunc(effective)
    : null;

  // 学到过（声明上限或可用值）之后，它们就是天花板：取值顺序 configured → effective → learned
  if (usableLearned !== null || usableEffective !== null) {
    const ceiling = usableEffective !== null && usableLearned !== null
      ? Math.min(usableEffective, usableLearned)
      : (usableEffective ?? usableLearned);
    const base = usableConfigured ?? usableRequested;
    if (base === null) {
      const source = usableEffective !== null && usableEffective <= (usableLearned ?? Infinity) ? 'effective' : 'learned';
      return { maxTokens: ceiling, source };
    }
    const capped = Math.min(base, ceiling);
    // 谁真正生效：配置更小就是人工值；否则看是不是 effective 那一档
    const source = usableConfigured !== null && usableConfigured <= ceiling
      ? 'configured'
      : (usableEffective !== null && ceiling === usableEffective ? 'effective' : 'learned');
    return { maxTokens: capped, source };
  }
  // 还没学到：配置优先，其次宿主原值
  if (usableConfigured !== null) return { maxTokens: usableConfigured, source: 'configured' };
  return { maxTokens: usableRequested, source: usableRequested === null ? 'none' : 'requested' };
}

// 上限存储：**纯进程内存**（不写盘、不读盘），按 dataRoot 隔离，测试之间互不污染。
// 为什么不留落盘：撞到即学、秒级完成，落盘只换来读写的维护成本与失效问题；
// 重启后重新撞一次 400 是可接受的代价（依据见 docs/12 R10）。
export function createLimitsStore({ dataRoot = getDataRoot(), logger = defaultLogger } = {}) {
  // key = `<groupId>::<modelId>`；value = { maxTokens, effective, learnedAt }
  const learnedByKey = new Map();
  void dataRoot;   // 保留参数：调用方按数据根隔离实例，内存实现下仅用于签名兼容与排查
  void logger;     // 保留参数：本实现不产生日志，签名保持一致，调用方无需分支

  return {
    // 取某群某模型学到的声明上限；没有就 null
    async getLimit(groupId, modelId) {
      const stored = learnedByKey.get(limitKeyFor(groupId, modelId));
      const value = stored?.maxTokens;
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
    },

    // 取"可用值"（effective）：没学到或只在撞到但没验成功时返回 null
    async getEffectiveLimit(groupId, modelId) {
      const stored = learnedByKey.get(limitKeyFor(groupId, modelId));
      const value = stored?.effective;
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
    },

    // 学到上限：只写内存；返回写入后的声明上限。
    // maxTokens = 上游声明的上限（证据）；effective = 本次验成功的可用值（null 表示还没验成功）。
    async learnLimit(groupId, modelId, maxTokens, { effective } = {}) {
      const normalizedValue = Math.trunc(maxTokens);
      const normalizedEffective = effective === null
        ? null
        : (typeof effective === 'number' && Number.isFinite(effective) && effective > 0
          ? Math.trunc(effective)
          : Math.max(1, normalizedValue - 1));
      learnedByKey.set(limitKeyFor(groupId, modelId), {
        maxTokens: normalizedValue,
        effective: normalizedEffective,
        learnedAt: new Date().toISOString(),
      });
      return normalizedValue;
    },

    // 测试/排查用：当前进程内记住的全量快照
    async snapshot() {
      return Object.fromEntries(learnedByKey.entries());
    },
  };
}
