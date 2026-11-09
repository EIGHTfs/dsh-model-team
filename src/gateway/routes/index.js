// 端点路由表：docs/09 §6 的端点与处理器的唯一登记处。
// 处理器按领域放在同目录的 groups/sessions/models/stats/config 里；本文件只保留路由表与匹配逻辑，
// check-contract.mjs 解析的就是这里的 ROUTES 数组。

import { API_PREFIX } from '../config/constants.js';

import {
  handleFriendGroupListRoute, handleFriendGroupRemoveRoute, handleFriendGroupSaveRoute,
  handleGroupCreateRoute, handleGroupDetailRoute, handleGroupListRoute,
  handleGroupUpdateRoute,
  handleGroupModelsRoute, handleGroupRemoveRoute, handleGroupVerifyRoute,
} from './groups.js';
import {
  handleChatCompletionsRoute, handleSessionEventsRoute, handleSessionModelReadRoute,
  handleSessionModelWriteRoute, handleSessionTargetReadRoute, handleSessionTargetWriteRoute,
} from './sessions.js';
import { handleDriversRoute, handleMetaRoute, handleModelListRoute, handleModelProbeRoute } from './models.js';
import { handleGlobalStatsRoute, handleSessionStatsRoute } from './stats.js';
import { handleExportRoute, handleImportRoute, handlePlatformListRoute } from './config.js';
// 会话查询直接复用 session/current.js 的两个 handler（同属「会话」领域，不必再包一层）
import { handleCurrentSessionRoute, handleSessionDetailRoute } from '../session/current.js';
import { handleStreamRoute } from './stream.js';

export const ROUTES = Object.freeze([
  { method: 'POST', pattern: '/v1/chat/completions', handler: handleChatCompletionsRoute },
  { method: 'GET', pattern: '/v1/models', handler: handleModelListRoute },
  { method: 'GET', pattern: `${API_PREFIX}/drivers`, handler: handleDriversRoute },
  { method: 'GET', pattern: `${API_PREFIX}/platforms`, handler: handlePlatformListRoute },
  { method: 'POST', pattern: `${API_PREFIX}/models/probe`, handler: handleModelProbeRoute },
  // 顺序敏感：current 是保留字，必须排在 :id 前面，否则会被当成 id 抢走
  { method: 'GET', pattern: `${API_PREFIX}/sessions/current`, handler: handleCurrentSessionRoute },
  { method: 'GET', pattern: `${API_PREFIX}/sessions/:id`, handler: handleSessionDetailRoute },
  { method: 'GET', pattern: `${API_PREFIX}/groups`, handler: handleGroupListRoute },
  { method: 'POST', pattern: `${API_PREFIX}/groups`, handler: handleGroupCreateRoute },
  { method: 'PATCH', pattern: `${API_PREFIX}/groups/:id`, handler: handleGroupUpdateRoute },
  { method: 'GET', pattern: `${API_PREFIX}/groups/:id`, handler: handleGroupDetailRoute },
  { method: 'DELETE', pattern: `${API_PREFIX}/groups/:id`, handler: handleGroupRemoveRoute },
  { method: 'GET', pattern: `${API_PREFIX}/friend-groups`, handler: handleFriendGroupListRoute },
  { method: 'POST', pattern: `${API_PREFIX}/friend-groups`, handler: handleFriendGroupSaveRoute },
  { method: 'DELETE', pattern: `${API_PREFIX}/friend-groups/:id`, handler: handleFriendGroupRemoveRoute },
  { method: 'GET', pattern: `${API_PREFIX}/groups/:id/models`, handler: handleGroupModelsRoute },
  { method: 'POST', pattern: `${API_PREFIX}/groups/:id/verify`, handler: handleGroupVerifyRoute },
  { method: 'GET', pattern: `${API_PREFIX}/session/:id/model`, handler: handleSessionModelReadRoute },
  { method: 'PUT', pattern: `${API_PREFIX}/session/:id/model`, handler: handleSessionModelWriteRoute },
  { method: 'GET', pattern: `${API_PREFIX}/session/:id/target`, handler: handleSessionTargetReadRoute },
  { method: 'PUT', pattern: `${API_PREFIX}/session/:id/target`, handler: handleSessionTargetWriteRoute },
  { method: 'GET', pattern: `${API_PREFIX}/session/:id/events`, handler: handleSessionEventsRoute },
  { method: 'GET', pattern: `${API_PREFIX}/stats/session/:id`, handler: handleSessionStatsRoute },
  { method: 'GET', pattern: `${API_PREFIX}/stats/global`, handler: handleGlobalStatsRoute },
  { method: 'GET', pattern: `${API_PREFIX}/export`, handler: handleExportRoute },
  { method: 'POST', pattern: `${API_PREFIX}/import`, handler: handleImportRoute },
  // 客户端元信息（契约 02 §2.9 #26）：只读、无副作用，客户端启动取一次
  { method: 'GET', pattern: `${API_PREFIX}/meta`, handler: handleMetaRoute },
  // 请求完成事件流（SSE）：前端唯一订阅点，避免"猜宿主 hook"（docs/09）
  { method: 'GET', pattern: `${API_PREFIX}/stream`, handler: handleStreamRoute },
].map((route) => ({ ...route, segments: route.pattern.split('/').filter((segment) => segment.length > 0) })));

// 单段匹配：`:` 开头为参数占位，其余按字面比较
function matchRoutePattern(patternSegments, pathSegments) {
  if (patternSegments.length !== pathSegments.length) {
    return null;
  }
  const routeParams = {};
  for (const [segmentIndex, patternSegment] of patternSegments.entries()) {
    if (patternSegment.startsWith(':')) {
      routeParams[patternSegment.slice(1)] = decodeURIComponent(pathSegments[segmentIndex]);
      continue;
    }
    if (patternSegment !== pathSegments[segmentIndex]) {
      return null;
    }
  }
  return routeParams;
}

// 贡献路由：由域自己挂进来（见 transport/route-contributors.js），主流程不 import 域实现。
// 这里保持两个兼容出口：attachContributedRoutes 供"静态注入"测试用，listContributedRoutes 供断言用。
import { collectContributedRoutes } from '../transport/route-contributors.js';

let staticContributedRoutes = [];

export function attachContributedRoutes(routes) {
  staticContributedRoutes = Array.isArray(routes) ? [...routes] : [];
  return staticContributedRoutes.length;
}

export function listContributedRoutes(options = {}) {
  return [...staticContributedRoutes, ...collectContributedRoutes(options)];
}

function withSegments(route) {
  return route.segments ? route : { ...route, segments: String(route.pattern).split('/').filter((segment) => segment.length > 0) };
}

// 分发：先找得到路径，再看方法；路径命中但方法不对要报 405 而不是 404
export function findRoute(method, pathname, extraRoutes = []) {
  const pathSegments = pathname.split('/').filter((segment) => segment.length > 0);
  let methodMismatch = false;
  const candidateRoutes = [...ROUTES, ...staticContributedRoutes.map(withSegments), ...(Array.isArray(extraRoutes) ? extraRoutes : []).map(withSegments)];
  for (const route of candidateRoutes) {
    const routeParams = matchRoutePattern(route.segments, pathSegments);
    if (!routeParams) {
      continue;
    }
    if (route.method !== method) {
      methodMismatch = true;
      continue;
    }
    return { route, params: routeParams };
  }
  return methodMismatch ? { methodMismatch: true } : null;
}
