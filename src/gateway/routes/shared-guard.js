// 路由层共用守卫：把"每个路由文件各写一份"的准入判断收在一处。
//
// 为什么单独成文件：同一个 8 行函数曾在 5 个路由文件里逐字节重复（md5 一致），
// 其中 4 份是死代码（只有 sessions 真的调用它）——重复 + 死代码叠在一起，
// 改一次准入规则要么漏改、要么改到没人用的那份还以为生效了。

import { resolveHttpConfig } from '../config/config.js';
import { ERROR_CODES, GatewayError } from '../errors.js';

// /v1/chat/completions 是否对外开放（docs/09 §11：默认关闭；dsh 自身走 LlmAdapter，不经 HTTP）
export function assertExternalOpenAiCompatEnabled(config) {
  if (resolveHttpConfig(config).externalOpenAiCompat) {
    return;
  }
  throw new GatewayError(ERROR_CODES.NOT_FOUND, '未开放外部 OpenAI 兼容入口', {
    hint: '在 config.json 里设置 http.externalOpenAiCompat: true 后再试',
  });
}
