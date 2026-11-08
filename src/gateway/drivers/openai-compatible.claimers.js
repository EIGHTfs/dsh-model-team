// 官方 OpenAI 兼容驱动的"上游错误帧"认领者。
//
// 有些兼容实现会先回 200、再把错误塞进一帧 `{ error: { message, type, code } }`；
// 不认领的话网关会把它当"没有 choices 的无关帧"跳过，最后记成成功空回复。
//
// 本文件只干认领这一件事（不含推理/登录等职责），由驱动声明里的字符串路径动态加载。

const ERROR_FRAME_MESSAGE_LIMIT = 120;

function readErrorText(errorBody) {
  const message = typeof errorBody?.message === 'string' ? errorBody.message.trim() : '';
  if (message.length > 0) return message.slice(0, ERROR_FRAME_MESSAGE_LIMIT);
  const code = typeof errorBody?.code === 'string' || typeof errorBody?.code === 'number' ? String(errorBody.code) : '';
  return code;
}

export const claimers = [{
  id: 'error-frame',
  claim(payload) {
    const errorBody = payload?.error;
    if (!errorBody || typeof errorBody !== 'object') return null;
    const errorType = typeof errorBody.type === 'string' && errorBody.type.length > 0 ? errorBody.type : '(无 type)';
    const text = readErrorText(errorBody);
    return {
      code: 'UPSTREAM_ERROR_FRAME',
      message: `上游返回错误帧：${text || errorType}`,
      reason: `openai-error:${errorType}`,
      status: 502,
    };
  },
}];
