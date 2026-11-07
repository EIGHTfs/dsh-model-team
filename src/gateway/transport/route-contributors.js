// 路由贡献者：让「域」把自己的路由挂进来，而不用改动网关的静态路由表。
//
// 为什么需要：反代是独立域，它的路由不该写在 src/gateway/routes/index.js 里（那会让主流程
// 直接 import 域实现，破坏边界）。这里只提供两个动作：注册一个"返回路由数组"的函数、
// 收集当前所有贡献。收集失败只 warn——某个域挂载失败不能影响主流程的 29 条路由。

const contributors = [];

/**
 * 注册一个路由贡献者。返回注销函数（dispose 用）。
 * @param {(context: object) => Array<{method: string, pattern: string, handler: Function}>} contributor
 */
export function registerRouteContributor(contributor) {
  if (typeof contributor !== 'function') throw new TypeError('路由贡献者必须是函数');
  contributors.push(contributor);
  return () => {
    const index = contributors.indexOf(contributor);
    if (index >= 0) contributors.splice(index, 1);
  };
}

/** 收集所有贡献的路由；单个贡献者抛错只 warn 并跳过（错误隔离） */
export function collectContributedRoutes({ logger, ...context } = {}) {
  const routes = [];
  for (const contributor of [...contributors]) {
    try {
      const contributed = contributor({ logger, ...context });
      if (Array.isArray(contributed)) routes.push(...contributed);
    } catch (contributorError) {
      logger?.warn?.(`路由贡献者执行失败（跳过）：${contributorError?.message ?? contributorError}`);
    }
  }
  return routes;
}

/** 测试用：清空贡献者（避免用例之间互相污染） */
export function resetRouteContributorsForTest() {
  contributors.length = 0;
}
