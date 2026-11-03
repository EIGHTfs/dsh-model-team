// 目标来源提示的唯一口径：悬浮球与请求卡片共用同一份映射。
// 为什么要单独成文件：两处各写一份必然漂移，而"来源文案不一致"会让用户以为是两套语义。
// 语义边界（契约 02 §3.2 targetSource）：
//   - 空值 = 本会话显式绑定，不需要提示（**不是**缺失字段，所以不显示 `—`）
//   - 已知回落来源 = 显示括号小字
//   - 未知字符串 = 不渲染（别把未知值当正常值展示），只告警一次，便于发现后端新增来源忘了同步
var TARGET_SOURCE_HINTS = {
  "last-session": "（继承上一会话）",
  parent: "（继承父会话）",
  "fallback-group": "（兜底群默认）"
};

function targetSourceHintOf(targetSource) {
  if (typeof targetSource !== "string" || targetSource.length === 0) return "";
  var hint = TARGET_SOURCE_HINTS[targetSource];
  if (hint === undefined) {
    warnOnce("未知 targetSource：" + targetSource, null);
    return "";
  }
  return hint;
}

// 请求卡片上的来源标记：没有提示内容时整段不渲染（含分隔符），避免出现空 span 或孤立的分隔点
function renderTargetSourceBadge(targetSource) {
  var hint = targetSourceHintOf(targetSource);
  if (!hint) return "";
  return '<span class="req-source">' + escapeHtml(hint) + "</span>";
}
