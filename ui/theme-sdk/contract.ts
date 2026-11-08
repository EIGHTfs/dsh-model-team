// contract.ts —— 主题契约：主题是什么、允许什么、缺什么算构建失败。
//
// 为什么把契约单独成文件、并且只有类型 + 一个校验函数：
// 主题是「别人写的代码」，它只能依赖这一层。契约一旦散落到 SDK 各处，
// 主题作者就得靠读实现来猜哪些能用——那等于没有契约。
// 校验发生在**构建期**（scripts/build-theme.mjs 会调 defineTheme），
// 运行期不再重复校验：坏主题应该在打包时就被挡住，而不是等宿主里报错。

/** 契约版本：SDK 的破坏性改动就 +1，构建期用它拒掉按旧契约写的主题 */
export const THEME_CONTRACT_VERSION = 1 as const;

/** meta.id 的合法形状：只允许小写字母开头的 [a-z0-9-]，用做样式命名空间与切换校验 */
const THEME_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/** 三个底边 tab 的稳定 key（与 store 的 view 名分开：chat/add/db 也算「消息」语境） */
export type TabKey = 'messages' | 'contacts' | 'profile';

export interface ThemeMeta {
  /** 稳定标识：写进 [data-theme-root] 与 <style data-theme>，所以必须能当 CSS 属性值用 */
  id: string;
  /** 展示名。构建期写进产物；运行期是否本地化由宿主 locale 决定 */
  name: string;
  /** 写死的契约版本，不允许主题自己定 */
  contractVersion: typeof THEME_CONTRACT_VERSION;
}

/** 主题根组件的挂载意图：overlay = 自己画整棵浮层树；dock = 只画常驻件 */
export interface ThemeRootProps {
  readonly mount: 'overlay' | 'dock';
}

/** setup 拿到的上下文：只读。主题要改状态必须走 actions */
export interface ThemeSetupContext {
  readonly meta: ThemeMeta;
  readonly getState: () => unknown;
}

export interface ThemeDefinition {
  meta: ThemeMeta;
  /** 根组件：所有 UI 从这里长出来 */
  Root: (props: ThemeRootProps) => unknown;
  /** 可选：主题自带 CSS 文本，构建期原样收进产物，运行期注入 <style data-theme="id"> */
  styles?: string;
  /** 可选：卸载时的额外清理，返回值即清理函数 */
  setup?: (context: ThemeSetupContext) => void | (() => void);
}

function assertMetaShape(meta: ThemeMeta | undefined): void {
  if (!meta || typeof meta !== 'object') {
    throw new Error('[theme] 缺少 meta');
  }
  if (typeof meta.id !== 'string' || !THEME_ID_PATTERN.test(meta.id)) {
    throw new Error(`[theme] meta.id 非法：${JSON.stringify(meta.id)}（要求 /^[a-z][a-z0-9-]{1,31}$/）`);
  }
  if (typeof meta.name !== 'string' || meta.name.trim() === '') {
    throw new Error('[theme] meta.name 必须是非空字符串');
  }
  if (meta.contractVersion !== THEME_CONTRACT_VERSION) {
    throw new Error(
      `[theme] meta.contractVersion 不匹配：主题写的是 ${JSON.stringify(meta.contractVersion)}，`
      + `当前 SDK 是 ${THEME_CONTRACT_VERSION}（按旧契约写的主题要跟着改）`,
    );
  }
}

function assertRequiredParts(definition: Partial<ThemeDefinition>): void {
  if (typeof definition.Root !== 'function') {
    throw new Error('[theme] Root 必须是函数组件');
  }
}

function assertOptionalParts(definition: Partial<ThemeDefinition>): void {
  if (definition.styles !== undefined && typeof definition.styles !== 'string') {
    throw new Error('[theme] styles 若存在必须是字符串（不要引外部 CSS 文件）');
  }
  if (definition.setup !== undefined && typeof definition.setup !== 'function') {
    throw new Error('[theme] setup 若存在必须是函数');
  }
}

/**
 * 声明并校验一个主题。
 * 校验项刻意只覆盖「构建期一定能判」的部分（形状与版本），不猜作者意图：
 * 猜意图的校验会在真实主题上误报，最后逼人关掉校验。
 * 拆成三个小校验器而不是一个大 if 串：每一项单独看得懂，报错也各自带字段名。
 */
export function defineTheme(definition: ThemeDefinition): ThemeDefinition {
  if (!definition || typeof definition !== 'object') {
    throw new Error('[theme] defineTheme 需要一个对象参数');
  }
  assertMetaShape(definition.meta);
  assertRequiredParts(definition);
  assertOptionalParts(definition);
  // 冻结：运行期有人往主题对象上挂字段会静默生效，冻结后是显式报错
  return Object.freeze({
    meta: Object.freeze({ ...definition.meta }),
    Root: definition.Root,
    styles: definition.styles,
    setup: definition.setup,
  });
}
