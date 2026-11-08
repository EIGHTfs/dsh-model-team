// 速率公式的**声明式加载器**：本文件不认识任何具体公式实现，只按声明的模块标识动态加载。
//
// 为什么要这样：速率公式是「可替换的通用单元」，不属于本插件任何一侧的私有代码。
// 写死相对路径（如 ../../../lib/shared/xxx）会让网关层与某个目录结构绑定——换实现、换位置、
// 把公式模块单独发布，都得改代码。改为：**标识来自声明（配置/调用方），加载失败就降级**。
//
// 约定（实现方只需满足这个形状，不需要知道调用方是谁）：
//   export function aggregateGenerationRate(rows) → { tps, exact } | null
// **只认「值」出口**：显示（单位、"≈"、措辞）属于界面，公式模块不承担，服务端也不透传。

// 缺省模块标识：只写"相对项目根的路径"，不写绝对路径、不写死到某个具体文件版本
export const DEFAULT_RATE_FORMULA_MODULE = 'lib/shared/rate.mjs';

// 失败只 warn 一次：公式缺失是降级场景，不能让每次统计请求都刷日志
let warnedFailure = null;

// 允许注入 import（测试用），缺省走动态 import
export function createRateFormulaLoader({
  specifier = DEFAULT_RATE_FORMULA_MODULE,
  baseUrl = new URL('../../../', import.meta.url),
  logger = null,
  importer = (url) => import(url),
} = {}) {
  let cached = null;

  return {
    specifier,
    async load() {
      if (cached) return cached;
      try {
        const moduleUrl = new URL(specifier, baseUrl);
        const loaded = await importer(moduleUrl.href);
        // 只认「值」出口：没有 aggregateGenerationRate 就等于没有可用公式
        if (typeof loaded?.aggregateGenerationRate !== 'function') {
          throw new TypeError(`速率公式模块缺少 aggregateGenerationRate 导出：${specifier}`);
        }
        cached = loaded;
        return cached;
      } catch (loadError) {
        if (warnedFailure !== specifier) {
          warnedFailure = specifier;
          logger?.warn?.(`速率公式模块不可用（已降级为不显示速率）：${specifier}（${loadError?.message ?? loadError}）`);
        }
        return null;
      }
    },
  };
}

// 便捷入口：按标识算一次会话速率。
// **返回值只有值，没有显示**：{ tps, exact } —— 不带单位、不带「≈」、不带任何措辞。
// 单位与近似标记属于界面口径（契约：值与显示分离），服务端不替界面做决定。
export async function computeSessionRate(rows, options = {}) {
  const loader = options.loader ?? createRateFormulaLoader(options);
  const formula = await loader.load();
  if (!formula) return null;
  if (typeof formula.aggregateGenerationRate !== 'function') return null;

  const aggregate = formula.aggregateGenerationRate(rows);
  if (!aggregate || typeof aggregate.tps !== 'number' || !Number.isFinite(aggregate.tps)) return null;
  return { tps: aggregate.tps, exact: aggregate.exact === true };
}
