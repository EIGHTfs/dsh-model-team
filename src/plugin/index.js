// dsh 插件入口：注册 ModelTimAdapter（docs/10）。
// 需求意图：装进 dsh 后模型选择器里只多出一个虚拟模型，真实模型按会话映射转发；宿主重启 fiber 时
//          重复注册不能把插件树打成 failed（参考实现踩过 "already declared" 的坑）。
// 思路：基类/错误类由运行时加载器注入（本项目零依赖，不静态 import 宿主包）；
//      加载顺序 options.llmModule → env DSH_MODEL_TEAM_LLM_SPECIFIER → 兜底 import('@deepseek-ai/dsh-llm')；
//      三种都失败只打 error 不注册（插件加载失败不该拖垮宿主），其余注册错误照常抛出。
// ⚠️ cordis 读的是**模块导出面**：`inject` 漏了就会在真机抛
//    cannot get property "llm" without inject（单测用假 ctx 永远测不出来）。

import { API_PREFIX } from '../gateway/constants.js';
import { getDataRoot } from '../gateway/paths.js';
import { readConfig } from '../gateway/config.js';
import { defaultLogger, describeFailure } from '../gateway/logger.js';
import { DEFAULT_PROVIDER_ID, createModelTimAdapter } from './adapter.js';
import { TEAM_ROUTE_PREFIX, disposeGatewayRoutes, registerGatewayRoutes } from './web-routes.js';
import { createHostSessionLookup, createHostSessionSource } from '../gateway/session-current.js';

// 插件模块名（cordis 用它做诊断标签；与 package.json 的 name 保持一致）
export const name = 'dsh-model-team';

// 服务注入声明：本插件只访问 ctx.llm，就必须显式声明——否则 cordis 的访问器直接抛错。
// 必须是模块级命名导出，写成 apply 里的局部变量不会被读取。
export const inject = ['llm'];

// 允许部署侧指定 dsh-llm 的解析目标（包名或 file:// 绝对 URL）：不把宿主路径写死进代码
export const LLM_MODULE_SPECIFIER_ENV = 'DSH_MODEL_TEAM_LLM_SPECIFIER';

// 缺省解析目标：由宿主 profile 的 node_modules 提供（package.json 里声明为 peerDependency）
export const DEFAULT_LLM_MODULE_SPECIFIER = '@deepseek-ai/dsh-llm';

// "已注册"类错误文案特征：命中即视为等价跳过（重启幂等的唯一判据）
const ALREADY_DECLARED_PATTERN = /already declared|already registered|is already declared/i;

// 加载 dsh-llm：优先级 显式注入 → env → 缺省包名
export async function loadLlmModule({ llmModule, environment = process.env, importer = (specifier) => import(specifier) } = {}) {
  if (llmModule) {
    return { module: llmModule, specifier: 'injected' };
  }
  const configuredSpecifier = environment[LLM_MODULE_SPECIFIER_ENV];
  const specifier = typeof configuredSpecifier === 'string' && configuredSpecifier.trim().length > 0
    ? configuredSpecifier.trim()
    : DEFAULT_LLM_MODULE_SPECIFIER;
  const loadedModule = await importer(specifier);
  return { module: loadedModule, specifier };
}

// 幂等注册：宿主重启 fiber 时同名注册会撞 already declared，那一轮的注册语义等价，跳过即可；
// 其它错误必须抛出去（配置错、接口不匹配这类不能被吞）
export function registerAdapterIdempotent(llmService, providerIds, adapter, { logger = defaultLogger } = {}) {
  if (!llmService || typeof llmService.registerAdapter !== 'function') {
    throw new TypeError('ctx.llm.registerAdapter 不可用：宿主版本不匹配或 llm 服务未加载');
  }
  try {
    llmService.registerAdapter(providerIds, adapter);
    return { registered: true, skipped: false };
  } catch (registerError) {
    if (ALREADY_DECLARED_PATTERN.test(String(registerError?.message ?? ''))) {
      logger.warn(`适配器已存在（宿主重启的重复注册），视为等价跳过：${providerIds.join(', ')}`);
      return { registered: false, skipped: true };
    }
    throw registerError;
  }
}

// 面板数据源路由：挂到宿主自己的 webServer（同源，不开独立端口）。
// 为什么不开端口：插件生命周期里没人会去启动独立 HTTP 服务，前端只会看到"网关未连接"；
// 挂到宿主 webServer 后同源可访问、不新增监听面、路由随插件 fiber 一起注销。
// apply 运行时刻 webServer 的 fiber 可能尚未创建，必须走 ctx.inject（不能用 ctx.get）。
// 失败只 warn 一次并跳过：绝不让插件 activation 失败（adapter 注册是另一条独立路径）。
async function registerPanelRoutes({ ctx, dataRoot, logger, options }) {
  try {
    if (typeof ctx?.inject !== 'function') {
      logger.warn(`ctx.inject 不可用，${API_PREFIX} 路由未注册（面板数据将不可用）`);
      return;
    }
    // /v1 是否挂载在注册时决定，所以配置在这里先读一次
    const pluginConfig = await readConfig({ dataRoot, logger });
    ctx.inject(['webServer'], (webContext) => {
      try {
        const webServer = webContext?.get?.('webServer');
        if (!webServer) {
          logger.warn(`webServer 不可用，${API_PREFIX} 路由未注册（面板数据将不可用）`);
          return;
        }
        // 当前会话来源：惰性取宿主 sessions 服务（apply 时刻它可能还没创建），取不到就返回 404
        const getSessionService = () => {
          try {
            return webContext.get('sessions');
          } catch {
            return undefined;
          }
        };
        // sessionTitle 是另一个宿主服务：get(session) 只认 live Session，缺失时由适配层回退事件流
        const getTitleService = () => {
          try {
            return webContext.get('sessionTitle');
          } catch {
            return undefined;
          }
        };
        const sessionSource = createHostSessionSource({ getSessionService, getTitleService, logger });
        const sessionLookup = createHostSessionLookup({ getSessionService, getTitleService, logger });
        webContext.effect(() => {
          const { disposers, externalOpenAiCompat } = registerGatewayRoutes({
            webServer,
            config: pluginConfig,
            dataRoot,
            logger,
            clock: options.clock,
            fetchImpl: options.fetchImpl,
            jsonlResolver: options.jsonlResolver,
            sessionSource,
            sessionLookup,
            getSessionService,
          });
          logger.info(`已挂载网关路由：${TEAM_ROUTE_PREFIX}（外部 /v1 ${externalOpenAiCompat ? '已开启' : '未开启'}）`);
          return () => disposeGatewayRoutes(disposers, { logger });
        });
      } catch (routeError) {
        logger.warn(`网关路由注册失败，/_team 不可用：${describeFailure(routeError)}`);
      }
    });
  } catch (injectError) {
    logger.warn(`无法注入 webServer，/_team 路由未注册：${describeFailure(injectError)}`);
  }
}

// 插件入口：DSH 会调用 apply(ctx)；返回 undefined（返回对象字面量会变成 Invalid effect）
export async function apply(ctx, options = {}) {
  const logger = options.logger ?? defaultLogger;
  const dataRoot = options.dataRoot ?? getDataRoot();
  let llmModule;

  // 先挂面板路由：即使后面 llm 模块加载失败，前端仍能读到 /_team 数据（数据源与模型转发是两条路径）
  await registerPanelRoutes({ ctx, dataRoot, logger, options });

  try {
    const loaded = await loadLlmModule({ llmModule: options.llmModule, environment: options.environment }).catch((loadError) => {
      throw loadError;
    });
    llmModule = loaded.module;
  } catch (loadError) {
    // 加载失败只告警不抛：插件不激活，但宿主与其它插件照常工作
    logger.error(
      `无法加载 ${DEFAULT_LLM_MODULE_SPECIFIER}，本插件未注册任何模型：${describeFailure(loadError)}`
      + `（把它作为 peerDependency 安装，或设置 ${LLM_MODULE_SPECIFIER_ENV} 指向可解析的模块）`,
    );
    return undefined;
  }

  const BaseAdapter = llmModule?.LlmAdapter;
  const LlmErrorClass = llmModule?.LlmError;
  if (typeof BaseAdapter !== 'function' || typeof LlmErrorClass !== 'function') {
    logger.error(
      `模块 ${DEFAULT_LLM_MODULE_SPECIFIER} 里没有导出 LlmAdapter/LlmError，本插件未注册任何模型`,
    );
    return undefined;
  }

  const ModelTimAdapter = createModelTimAdapter({
    BaseAdapter,
    LlmErrorClass,
    // 适配器与 HTTP 路径共用同一个 sessions getter：目标回落的父链要靠它
    deps: {
      dataRoot,
      logger,
      getSessionService: () => {
        try {
          return ctx.get('sessions');
        } catch {
          return undefined;
        }
      },
      ...(options.deps ?? {}),
    },
  });
  const providerIds = options.providerIds ?? [DEFAULT_PROVIDER_ID];
  const adapterInstance = new ModelTimAdapter();

  registerAdapterIdempotent(ctx?.llm, providerIds, adapterInstance, { logger });
  logger.info(`已注册模型路由适配器：${providerIds.join(', ')}（数据根 ${dataRoot}）`);

  return undefined;
}

// ⚠️ 刻意不导出 default：DSH boot 取模块用的是 `module.default || module`
// （packages/boot/app-boot/lib/index.js:162）——一旦有 default，模块命名空间的
// inject / name 会被这层 `||` 整个吃掉，cordis 拿不到 inject ⇒ 真机报
// cannot get property "llm" without inject。这里只保留命名导出。
