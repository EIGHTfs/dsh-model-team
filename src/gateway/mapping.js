// 字段映射与 usage 解析：配置型驱动与统计层共用的"配置 → 请求/响应"翻译逻辑。
// 需求意图：不同 OpenAI 兼容平台的字段位置不一致（模型字段、usage 位置、缓存命中），
//          这些差异必须由配置表达，代码只做通用取值，不写死任何平台。
// 思路：全部实现为"纯函数 + 空值降级"——取不到就返回 undefined/—，绝不抛错，
//      免得一个平台的响应形状异常把整条转发链路打断。

// 请求体里模型字段的缺省路径（docs/08：request.modelField）
export const DEFAULT_MODEL_FIELD_PATH = 'model';

// 响应体里 usage 的缺省位置（docs/08：response.usagePath）
export const DEFAULT_USAGE_PATH = 'usage';

// 摘要模板变量缺失时的降级占位（INV-08：缺变量渲染为 —，不报错）
export const MISSING_VARIABLE_PLACEHOLDER = '—';

// 模板变量形如 {modelCount}：只认单词字符，避免误吃 JSON 里的花括号
export const SUMMARY_VARIABLE_PATTERN = /\{(\w+)\}/g;

// 按点号路径取值：中间段不是对象就返回 undefined，不做异常分支
export function readFieldByPath(sourceValue, fieldPath) {
  if (typeof fieldPath !== 'string' || fieldPath.length === 0) {
    return sourceValue;
  }
  let currentValue = sourceValue;
  for (const pathSegment of fieldPath.split('.')) {
    if (currentValue === null || currentValue === undefined || typeof currentValue !== 'object') {
      return undefined;
    }
    currentValue = currentValue[pathSegment];
  }
  return currentValue;
}

// 按点号路径写值：中间缺对象就补空对象（平台要求嵌套传模型名时用）
export function writeFieldByPath(targetObject, fieldPath, fieldValue) {
  const pathSegments = fieldPath.split('.');
  const lastSegment = pathSegments.pop();
  let currentObject = targetObject;
  for (const pathSegment of pathSegments) {
    if (typeof currentObject[pathSegment] !== 'object' || currentObject[pathSegment] === null) {
      currentObject[pathSegment] = {};
    }
    currentObject = currentObject[pathSegment];
  }
  currentObject[lastSegment] = fieldValue;
}

// 出站请求体：modelField 不是缺省 'model' 时把模型名搬到目标路径，其余字段原样透传
// 深拷贝后再改，避免污染调用方（网关可能复用同一个请求体对象）
export function prepareOutboundBody(requestBody, requestConfig) {
  const modelFieldPath = requestConfig?.modelField ?? DEFAULT_MODEL_FIELD_PATH;
  const outboundBody = structuredClone(requestBody ?? {});
  if (modelFieldPath === DEFAULT_MODEL_FIELD_PATH || !(DEFAULT_MODEL_FIELD_PATH in outboundBody)) {
    return outboundBody;
  }
  const targetModel = outboundBody[DEFAULT_MODEL_FIELD_PATH];
  delete outboundBody[DEFAULT_MODEL_FIELD_PATH];
  writeFieldByPath(outboundBody, modelFieldPath, targetModel);
  return outboundBody;
}

// token 数取值：只接受非负有限数（上游偶尔给字符串），其它一律当缺失
function toTokenCount(tokenCandidate) {
  const tokenValue = typeof tokenCandidate === 'string' ? Number(tokenCandidate) : tokenCandidate;
  if (typeof tokenValue !== 'number' || !Number.isFinite(tokenValue) || tokenValue < 0) {
    return null;
  }
  return tokenValue;
}

// 输入/输出 token：两种命名都认（蛇形是上游原始，驼峰是我们自己的旧行）
function pickPromptTokens(rawUsage) {
  return toTokenCount(rawUsage.prompt_tokens ?? rawUsage.promptTokens);
}

function pickCompletionTokens(rawUsage) {
  return toTokenCount(rawUsage.completion_tokens ?? rawUsage.completionTokens);
}

// 总 token：上游给了就用，没给才用两项相加兜底（不要反过来——上游的 total 可能含缓存口径差异）
function pickTotalTokens(rawUsage, promptTokens, completionTokens) {
  const explicitTotalTokens = toTokenCount(rawUsage.total_tokens ?? rawUsage.totalTokens);
  if (explicitTotalTokens !== null) return explicitTotalTokens;
  return promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null;
}

// 命中缓存的 token：三种来源按优先级取（嵌套路径 → 蛇形 → 别名）
function pickCachedTokens(rawUsage) {
  return toTokenCount(
    readFieldByPath(rawUsage, 'prompt_tokens_details.cached_tokens')
      ?? rawUsage.cache_read_input_tokens
      ?? rawUsage.cache_hit,
  );
}

// usage 归一化：蛇形字段 → 契约驼峰字段；上游没给 total_tokens 时用两项相加兜底。
// 只有真拿到缓存数才写 cacheHit —— 缺失写成 0 会让"没有数据"看起来像"命中率 0%"
export function extractUsage(responseBody, usagePath = DEFAULT_USAGE_PATH) {
  const rawUsage = readFieldByPath(responseBody, usagePath);
  if (rawUsage === null || rawUsage === undefined || typeof rawUsage !== 'object') {
    return null;
  }

  const promptTokens = pickPromptTokens(rawUsage);
  const completionTokens = pickCompletionTokens(rawUsage);
  const usage = {
    promptTokens,
    completionTokens,
    totalTokens: pickTotalTokens(rawUsage, promptTokens, completionTokens),
  };
  const cachedTokens = pickCachedTokens(rawUsage);
  if (cachedTokens !== null) {
    usage.cacheHit = cachedTokens;
  }
  return usage;
}

// 首字判据（docs/02 §5.1）：一个流式分片里出现"真正的内容"才算首字时刻。
// 只带 role 的开场分片、或 content 为空串的占位分片都不算 —— 把它们当成首字，
// 会把首字等待（TTFT）算进解码段，速率被低估，与本次修正的目的正好相反。
export const CONTENT_DELTA_FIELDS = Object.freeze(['content', 'reasoning_content', 'tool_calls']);

export function carriesFirstToken(payload) {
  const delta = payload?.choices?.[0]?.delta;
  if (!delta || typeof delta !== 'object') {
    return false;
  }
  for (const fieldName of CONTENT_DELTA_FIELDS) {
    const fieldValue = delta[fieldName];
    if (typeof fieldValue === 'string' && fieldValue.length > 0) {
      return true;
    }
    if (Array.isArray(fieldValue) && fieldValue.length > 0) {
      return true;
    }
  }
  return false;
}

// 摘要模板渲染：变量缺失降级为 —，空模板返回空串（INV-08）
export function renderSummaryTemplate(template, variables = {}) {
  if (typeof template !== 'string' || template.length === 0) {
    return '';
  }
  return template.replace(SUMMARY_VARIABLE_PATTERN, (wholeMatch, variableName) => {
    const variableValue = variables[variableName];
    if (variableValue === undefined || variableValue === null || String(variableValue).length === 0) {
      return MISSING_VARIABLE_PLACEHOLDER;
    }
    return String(variableValue);
  });
}
