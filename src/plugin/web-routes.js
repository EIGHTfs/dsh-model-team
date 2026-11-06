// 把网关路由挂到 DSH 自己的 webServer 上（同源，不开额外端口）。
// 需求意图：前端面板要读 /_team/*（群列表、请求行、统计），必须同源可达；独立 3177 端口在插件
//          生命周期里没人启动，面板只能拿到"网关未连接"。
// 为什么这么做：
//   1) 同源：前端不需要知道端口、不需要 CORS、不会被浏览器当跨站
//   2) 无额外监听面：不新增对外端口，不引入未鉴权的独立服务
//   3) 生命周期正确：路由随插件 fiber 一起注册/注销，重启不会重复注册
// 思路：webServer.register 的 prefix handler 收到的是原始 req/res（路径不剥前缀），
//      因此直接复用 http-server 的管道（handleGatewayRequest），不另写一套分发。

import { API_PREFIX } from '../gateway/config/constants.js';
import { resolveHttpConfig } from '../gateway/config/config.js';
import { getDataRoot } from '../gateway/config/paths.js';
import { handleGatewayRequest } from '../gateway/transport/http-server.js';
import { resolveGatewayDeps } from '../gateway/gateway-deps.js';
import { defaultLogger, describeFailure } from '../gateway/logger.js';

// 面板数据源前缀（docs/09 §6 端点表）
export const TEAM_ROUTE_PREFIX = API_PREFIX;

// 外部 OpenAI 兼容入口前缀（受 config.http.externalOpenAiCompat 门禁，默认不挂）
export const OPENAI_ROUTE_PREFIX = '/v1';

// 注册一条 prefix 路由，返回 disposer（webServer.register 的返回值）
function registerPrefixRoute({ webServer, path, deps }) {
  return webServer.register({
    kind: 'prefix',
    path,
    // deps 在注册时解析一次：缺省值与独立服务完全同源（resolveGatewayDeps 是唯一入口）
    handler: (incomingRequest, outgoingResponse) =>
      handleGatewayRequest({ ...deps, incomingRequest, outgoingResponse }),
  });
}

// 按当前配置挂载路由：/_team 总是挂；/v1 仅在 externalOpenAiCompat 打开时挂。
// 同步实现：cordis 的 effect 回调必须同步返回 disposer，所以配置由调用方先读好传进来。
// 返回 { disposers, externalOpenAiCompat }，由调用方在 fiber 的 effect 里统一注销。
export function registerGatewayRoutes({
  webServer,
  config = {},
  dataRoot = getDataRoot(),
  logger = defaultLogger,
  clock,
  fetchImpl,
  jsonlResolver,
  sessionSource,
  sessionLookup,
  getSessionService,
  providerIds,
  credentials,
} = {}) {
  if (!webServer || typeof webServer.register !== 'function') {
    throw new TypeError('webServer.register 不可用：宿主版本不匹配或 webServer 服务未加载');
  }

  const httpConfig = resolveHttpConfig(config);
  // 依赖缺省值在这里解析一次：插件入口与独立服务的 handler 行为因此一致
  const deps = resolveGatewayDeps({ dataRoot, logger, clock, fetchImpl, jsonlResolver, sessionSource, sessionLookup, getSessionService, providerIds, credentials });
  const disposers = [
    registerPrefixRoute({ webServer, path: TEAM_ROUTE_PREFIX, deps }),
  ];

  // 外部入口默认关闭（docs/09 §11）：关闭时连路由都不挂，避免留一个可被扫到的面
  if (httpConfig.externalOpenAiCompat) {
    disposers.push(
      registerPrefixRoute({ webServer, path: OPENAI_ROUTE_PREFIX, deps }),
    );
  }

  return { disposers, externalOpenAiCompat: httpConfig.externalOpenAiCompat };
}

// 统一注销：单条失败不影响其它条（disposer 抛错不能让插件卸载失败）
export function disposeGatewayRoutes(disposers = [], { logger = defaultLogger } = {}) {
  for (const dispose of disposers) {
    try {
      dispose?.();
    } catch (disposeError) {
      logger.warn(`路由注销失败（已忽略）：${describeFailure(disposeError)}`);
    }
  }
}
