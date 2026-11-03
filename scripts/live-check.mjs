// Lead 活体验收：用真实 Agnes API 验证配置型驱动（key 走 env，不落盘）
import { openAiCompatibleDriver } from '../src/gateway/drivers/openai-compatible.js';

const group = {
  id: 'agnes',
  name: 'agnes(本机)',
  accessMode: 'official',
  driver: 'openai-compatible',
  baseURL: 'https://api.agnes-ai.cn/v1',
  auth: { type: 'bearer', header: 'Authorization', apiKeyRef: 'env:AGNES_API_KEY' },
  models: { endpoint: '/models' },
  request: { modelField: 'model', extraHeaders: {} },
  response: { usagePath: 'usage' }
};

const context = {
  group,
  credentials: { apiKey: process.env.AGNES_API_KEY },
  logger: { info(){}, warn(){}, error(){} }
};

const models = await openAiCompatibleDriver.fetchModels(context);
console.log('fetchModels 数量:', models.length, '| 样例:', models.slice(0,3).map(function(m){return m.id}).join(', '));

const result = await openAiCompatibleDriver.chatCompletions(context, {
  model: 'agnes-3.0-flash',
  messages: [{ role: 'user', content: '只回复两个字：收到' }],
  stream: false
});
console.log('chat ok:', result.ok, '| status:', result.status);
console.log('内容:', result.response?.choices?.[0]?.message?.content);
console.log('usage:', JSON.stringify(result.usage));
