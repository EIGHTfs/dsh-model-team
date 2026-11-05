// 网关请求依赖的缺省值收敛处：独立 HTTP 服务与插件内 webServer 两条入口共用同一份。
// 需求意图：同一份 handler 在两条入口下行为必须一致——缺 clock / fetchImpl / jsonlResolver 时
//          不能各写一套兜底（曾因插件侧未传 clock 导致所有写路径 500）。
// 思路：只在请求入口（http-server 的 handleGatewayRequest）解析一次，其余模块一律拿结果对象用。

import { getDataRoot } from './config/paths.js';
import { createClock } from './clock.js';
import { defaultLogger } from './logger.js';
import { defaultJsonlSessionResolver } from './session/store.js';
import { createEmptySessionLookup, createEmptySessionSource } from './session/current.js';
import { DEFAULT_PROVIDER_ID } from '../plugin/adapter/adapter.js';

// 归一化请求依赖：调用方给了就用，没给就落到同一批缺省实现
export function resolveGatewayDeps(options = {}) {
  return {
    dataRoot: options.dataRoot ?? getDataRoot(),
    logger: options.logger ?? defaultLogger,
    clock: options.clock ?? createClock(),
    // 上游 HTTP 客户端：缺省用运行时 fetch，测试可注入桩
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    // 会话日志回退解析（只读）：缺省实现读配置里的 jsonlGlob
    jsonlResolver: options.jsonlResolver ?? defaultJsonlSessionResolver,
    // 当前会话来源：插件侧注入宿主 sessions 适配器；独立服务与测试缺省为无活跃会话
    sessionSource: options.sessionSource ?? createEmptySessionSource(),
    // 按 id 查会话（拿标题用）：缺省实现永远查不到 → 404
    sessionLookup: options.sessionLookup ?? createEmptySessionLookup(),
    // 宿主 sessions 服务（惰性 getter）：目标回落的父链要靠它；缺省永远取不到
    getSessionService: options.getSessionService ?? (() => null),
    // 适配器注册的路由名：插件入口把 ctx.llm.registerAdapter 实际收到的那个数组原样注入，
    // 是 GET /_team/meta 的唯一来源（客户端据此判 INV-14，不能各算一份）。
    // 独立网关没有注册动作，回落成与注册缺省一致的单路由名。
    providerIds: options.providerIds ?? [DEFAULT_PROVIDER_ID],
  };
}
