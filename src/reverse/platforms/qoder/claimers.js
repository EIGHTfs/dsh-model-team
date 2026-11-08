// Qoder 的"上游业务错误帧"认领者（平台自留，通用层不认识这里的任何东西）。
//
// 实测形态：上游偶发 HTTP 200 + 单帧 `{"code":"112","message":"{\"pricingUrl\":...}"}`，
// 没有 choices、没有 usage。112 的语义是额度/权益不足（message 里给的是定价页）。
// 这类帧必须被认领成失败，否则请求行会记成成功、用户只看到"已完成但没有回复"。
//
// 本文件只干认领这一件事，由平台声明里的字符串路径动态加载。

const BUSINESS_ERROR_MESSAGE_LIMIT = 120;
const QUOTA_EXHAUSTED_CODE = '112';

export const claimers = [{
  id: 'business-error',
  claim(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    // 正常内容帧：有 choices
    if (Array.isArray(payload.choices) && payload.choices.length > 0) return null;
    // usage-only 尾帧（有 usage、无 choices）是正常收尾，严禁误判
    if (payload.usage) return null;
    const rawCode = payload.code;
    if (rawCode === undefined || rawCode === null || String(rawCode).trim().length === 0) return null;

    const businessCode = String(rawCode).trim();
    const upstreamText = String(payload.message ?? '').slice(0, BUSINESS_ERROR_MESSAGE_LIMIT);
    if (businessCode === QUOTA_EXHAUSTED_CODE) {
      return {
        code: 'UPSTREAM_QUOTA_EXHAUSTED',
        message: `额度/权益不足：${upstreamText || '上游未给出说明'}`,
        reason: `qoder-code:${businessCode}`,
        status: 402,
      };
    }
    return {
      code: 'UPSTREAM_BUSINESS_ERROR',
      message: `上游业务错误（code ${businessCode}）：${upstreamText || '上游未给出说明'}`,
      reason: `qoder-code:${businessCode}`,
    };
  },
}];
