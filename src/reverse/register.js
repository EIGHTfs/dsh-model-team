// 反代域的唯一注册器：读 manifest → 挂载（路由 / 驱动 / 导入源）。
//
// 三条纪律（docs/18 §二）：
//   1. 主流程只通过这一处接触反代（插件入口调一次 registerReverse）；
//   2. 任何一步失败只 warn 并继续——反代不可用时主流程必须照常工作；
//   3. 清单里的实现都是字符串路径，本文件按路径动态加载，不静态 import 域内实现。

import { manifest } from './manifest.js';
import { getPlatform, listPlatformLoadFailures, listPlatforms } from './registry.js';
import { registerReverseDrivers } from './driver.js';
import { getImportSource } from './core/import/index.js';
import { defaultLogger, describeFailure } from '../gateway/logger.js';
import { REVERSE_ROUTE_PREFIX, createReverseRouteHandler } from './routes/http-adapter.js';

// 把 '<相对路径>#<导出名>' 解析成真正的 handler
async function resolveRouteHandler(routeDeclaration) {
  const [modulePath, exportName] = String(routeDeclaration.handler).split('#');
  if (!modulePath || !exportName) {
    throw new TypeError(`路由声明格式应为 '<路径>#<导出名>'：${routeDeclaration.handler}`);
  }
  const routeModule = await import(new URL(modulePath, import.meta.url).href);
  const handler = routeModule[exportName];
  if (typeof handler !== 'function') {
    throw new TypeError(`路由处理器不存在：${routeDeclaration.handler}`);
  }
  return { method: routeDeclaration.method, pattern: routeDeclaration.path, handler };
}

/**
 * 挂载反代域。返回 { dispose, routes, drivers, importSources, failed }。
 * 插件入口把它包在 ctx.effect 里；dispose 只撤销路由贡献（驱动与导入源是进程级注册）。
 */
// 幂等：进程内只真正挂载一次（插件 apply 与网关首次请求都会调，重复调用返回同一份结果）
let registrationPromise = null;

// 测试用：清掉"已注册"缓存（用例之间互不污染）
export function resetReverseRegistrationForTest() {
  registrationPromise = null;
}

export function registerReverse(options = {}) {
  if (registrationPromise === null) {
    registrationPromise = doRegisterReverse(options).catch((registrationError) => {
      registrationPromise = null;   // 失败不缓存：下次调用可重试
      throw registrationError;
    });
  }
  return registrationPromise;
}

async function doRegisterReverse({ ctx, dataRoot, logger = defaultLogger, credentials = null } = {}) {
  const failures = [];
  const summary = { routes: 0, drivers: 0, importSources: 0 };
  const disposeTasks = [];

  // ① 路由：**自己注册到宿主 webServer**（不经任何其它插件）
  //   宿主只支持 kind=exact|prefix 的路径匹配、没有 :参数、也没有 method 维度，
  //   所以整个域只占一个 prefix 路由，域内再做"方法 + :参数"匹配（见 http-adapter.js）。
  try {
    const webServer = (() => { try { return ctx?.get?.('webServer') ?? null; } catch { return null; } })();
    if (!webServer || typeof webServer.register !== 'function') {
      failures.push('routes');
      logger.warn('宿主未提供 webServer：反代路由未挂载（其它能力不受影响）');
    } else {
      const routes = [];
      for (const routeDeclaration of manifest.routes) {
        routes.push(await resolveRouteHandler(routeDeclaration));
      }
      const disposeRoute = webServer.register({
        kind: 'prefix',
        path: REVERSE_ROUTE_PREFIX,
        handler: createReverseRouteHandler({ routes, dataRoot, logger, credentials }),
      });
      if (typeof disposeRoute === 'function') disposeTasks.push(disposeRoute);
      summary.routes = routes.length;
    }
  } catch (routeError) {
    failures.push('routes');
    logger.warn(`反代路由挂载失败（继续）：${describeFailure(routeError)}`);
  }

  // ② 驱动：一个平台一个驱动
  try {
    summary.drivers = registerReverseDrivers({ platforms: listPlatforms(), logger }).length;
  } catch (driverError) {
    failures.push('drivers');
    logger.warn(`反代驱动挂载失败（继续）：${describeFailure(driverError)}`);
  }

  // ③ 导入源：清单里声明的 id 必须真的存在（实现自带 id 注册）
  try {
    const missingSources = manifest.importSources.filter((sourceId) => getImportSource(sourceId) === null);
    if (missingSources.length > 0) throw new Error(`导入源未注册：${missingSources.join('、')}`);
    summary.importSources = manifest.importSources.length;
  } catch (importError) {
    failures.push('importSources');
    logger.warn(`反代导入源挂载失败（继续）：${describeFailure(importError)}`);
  }

  if (typeof dataRoot === 'string' && dataRoot.length === 0) {
    logger.warn('registerReverse 收到空 dataRoot（沿用请求级 dataRoot）');
  }

  return {
    ...summary,
    failed: failures,
    dispose() {
      for (const disposeTask of disposeTasks.reverse()) {
        try {
          disposeTask();
        } catch (disposeError) {
          logger.warn(`反代清理失败（继续）：${describeFailure(disposeError)}`);
        }
      }
    },
  };
}

/** 供 /_team/meta 的 reverse 段使用：平台清单 + 可用性 + 导入源 */
export function describeReverse() {
  const loadFailures = listPlatformLoadFailures();
  return {
    platforms: manifest.platforms.map((entry) => {
      const platform = getPlatform(entry.id);
      const failure = loadFailures.find((item) => item.platformId === entry.id) ?? null;
      return {
        id: entry.id,
        driverId: entry.driverId,
        displayName: entry.displayName ?? entry.id,
        capabilities: platform?.capabilities ?? entry.capabilities,
        available: platform !== null && failure === null,
        ...(failure ? { reason: failure.reason } : {}),
      };
    }),
    importSources: [...manifest.importSources],
  };
}

export default registerReverse;
