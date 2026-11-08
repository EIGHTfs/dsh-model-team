# 22 TSX 主题架构设计

> 定位：把「界面长什么样」从构建脚本里拿出来，变成一个**可独立编写、可切换、可校验**的单文件主题源码（TSX）。
> 状态：**设计稿，未实现**。本文只定义契约、边界与验收，不表示代码已按此运行。
> 关系：`03-UI规范.md` 管现有 DOM 钩子与界面条款；本文定义**下一代主题形态**，两者在过渡期并存（见 §十三）。
> 依赖口径：**运行期零第三方依赖；构建期允许 devDependency**（2026-11-23 决议，见 §16.3）。

---

## 一、问题与结论

### 1.1 现状的三个硬限制

| 限制 | 代码事实 | 后果 |
|---|---|---|
| **界面结构写死在渲染函数里** | `ui/js/app.js:135` 的 `renderApp()` 用 `innerHTML` 全量重绘；视图分支硬编码 `list / chat / add / contacts / profile` 五种 | 想换布局（侧边栏、顶部导航、气泡形态）必须改 `render.js`，不是「换主题」 |
| **主题只覆盖 HTML 骨架 + CSS** | `scripts/lib/theme-config.cjs:76` 只接受 `{ html, styles }`；`build.cjs:99` 从 HTML 里抽 `<body>` 到第一个 `<script>` 之间的骨架 | 主题能改配色与静态块，改不了「消息流怎么排、输入区放哪」 |
| **换主题要重新构建** | `docs/03-UI规范.md` §七：构建期读 `config.theme`，产物内联 | 切换主题 = 改配置 + 重跑 `node build.cjs` + 刷新页面 |

同时，现有实现有两个**必须保留的优点**：

- `ui/js/store/` 已经是单一真相源，`dispatch` 是唯一写入口（`ui/js/store/index.js:88`）；
- `lib/client-parts/foundation/api.js` 已经把全部接口收敛到一处。

所以问题不是「要不要重写」，而是**在不动业务层的前提下，把视图层换成可替换的主题**。

### 1.2 设计结论（五条，先给结论再解释）

1. **主题源码 = 单个 TSX 文件**，`export default defineTheme({...})`，可以写完整的组件树、条件、循环、事件。
2. **功能实现不进主题**：store、api、动作、基础组件由 **Theme SDK** 提供，主题只做「组合与呈现」。
3. **构建期编译**：TSX 被转译并打包，**包进现有的 `window.__ModuleLoader__.load({ id, factory })` 工厂**，产物仍是单文件 `lib/client.js`，不改变宿主加载契约。
4. **切换主题不重建业务状态**：只卸载/挂载视图层，`store` 实例与已加载数据保持不变。
5. **主题是可信源码，不是沙箱**：不做运行期隔离承诺；信任边界与插件一致（见 §十二）。

### 1.3 明确不做

| 不做 | 原因 |
|---|---|
| 自造 JSON/YAML 低代码布局语言 | TSX 本身就能表达条件、循环、组件组合；再造一套描述语言等于重造 JSX 且更弱 |
| 运行期 `import()` 裸 `.mjs` 主题 | DSH 客户端契约是 `ModuleLoader` 工厂 + `require` 平台模块（`lib/client-parts/foundation/loader.js:3`），裸 ESM 进不去；见 §七 |
| 引入 Vue / Svelte 运行时 | 宿主只提供 React（`packages/client/web/src/platform.ts:8`），再打包一份框架等于体积翻倍且要自管调度 |
| iframe / Shadow DOM 做隔离 | 宿主 token、locale、`ctx` 都拿不到；`references/practices.md` 已明确禁止 iframe 承载插件页 |
| 让主题直接调 `fetch` | 绕过 `api.js` 的统一错误分类与超时；主题只能通过 SDK 动作 |
| 运行期多主题（本期） | 需要多 bundle 加载机制；列为阶段 P3 可选（见 §八.4） |

---

## 二、现状核对（代码事实）

设计必须建立在真实代码上。以下每一条都可在仓库里直接核对。

### 2.1 构建链路

```
config.theme.html + config.theme.styles
        │  theme-config.cjs:resolveThemeConfig()   ← 三级优先级：--config → $DSH_MODEL_TEAM_HOME/config.json → 仓库 config/config.json
        ▼
build.cjs:readUiSkeleton()   剥掉 design-only 段，抽 <body>…<script> 之间
        ▼
UI_SKELETON_HTML 常量 + UI_CSS 常量
        ▼
拼接 CLIENT_PARTS + UI_PARTS + TAIL_PARTS
        ▼
lib/client.js（单文件，classic script，无 import/export）
```

关键约束：**拼接后的代码共享同一个函数作用域**，片段之间没有 `import`，顺序即依赖（`build.cjs:22-51` 的三张数组 + `assertPartOrder()`）。

### 2.2 客户端加载契约

```js
// lib/client-parts/foundation/loader.js:3
window.__ModuleLoader__.load({
  id: "dsh-model-team",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    // …全部片段在这里…
  }
});
```

`require` 只能解析**平台模块表**里的 specifier（`packages/client/web/src/platform.ts:8`）：

```
react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis,
zod, @tanstack/react-virtual,
@deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots,
@deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit
```

**这是本设计最重要的一条约束**：主题里 `import` 任何不在上表的包，都必须在构建期打进去；打不进去就是运行期 `require` 失败。

### 2.3 状态层

```js
// ui/js/store/index.js:88
return {
  getState: () => state,
  getErrors: () => state.errors.slice(),
  subscribe: hub.subscribe,
  dispatch: dispatcher.dispatch,
  start, stop, render, flush, reportError
};
```

**状态是原地修改的**（mutable）：

- `ui/js/store/chat.js:39` → `state.messages[groupId] = existing.concat([...])`
- `ui/js/store/groups.js:165` → `state.groups = value || []`
- `ui/js/store/session.js:92-96` → `state.models = {}` 等整体替换

顶层对象 `state` 引用**永远不变**。这对 React 是致命的：`useSyncExternalStore` 的 `getSnapshot` 必须返回**引用变化**的值，否则 React 认为没更新（见 §五.1）。

### 2.4 渲染层

```js
// ui/js/app.js:135
function renderApp(nextState, options) {
  ...
  viewRoot.innerHTML = renderGroupList(...);   // 或 renderChat / renderAddGroup / renderAddressBook / renderProfile
  renderFloat(current, activePlatformInfo(current));
  renderTabs(current);
}
```

特点：
- **全量重绘**，靠 `document.querySelector('#viewRoot')` 定位；
- 事件用**委托**挂在 `#viewRoot` / `.team-tabbar`（`app.js:273-451`），因为节点会被重建；
- 焦点恢复、滚动位置靠手写补偿（`app.js:161-180`、`app.js:216-217`）。

这些手法在 React 里都不需要，但**它们承载了真实的交互正确性**（F-01、F-02、F-05、F-06 等历史缺陷的修复）。迁移时必须逐条对齐，不能默认「React 会自动处理」。

### 2.5 主题配置现状

```js
// scripts/lib/theme-config.cjs:76
resolveThemeFromConfig(theme, { repoRoot, configPath })
// theme = { html: "ui/index.html", styles: ["ui/app.css"] }
```

校验口径（**配了就必须有效**）：路径不存在、HTML 缺 `<body` / `<script`、styles 任一项缺失 → 构建直接失败并带出路径。

`build.cjs:102` 还要求骨架里必须有 `id="floatDock"`、`id="floatPanel"`、`class="team-app"`，且不得含 `design-only` 残留。

### 2.6 宿主可用的插槽与能力

| 插槽 | 作用域 | 用途 | 依据 |
|---|---|---|---|
| `conversation.input.dock` | session | 输入框上方整行区域；**唯一能拿到 `sessionId` 的位置** | `lib/client-parts/apply.js:34`；`cordis_inspect_query Slots` |
| `shell.overlay` | root | 全帧浮层，点击穿透，条目自行开启 pointer-events | 同上 |

`conversation.input.dock` 的 props 含 `session`、`input`、`useProjection`、`useSessions` 等标准能力——现有 `ui/js/interaction/session-bridge.js:229` 正是用它拿 `sessionId` 与 `modelSelection`。

**新主题不能放弃这条通道**：它决定了「UI 跟随会话切换」与 INV-14（悬浮球只在选中虚拟模型时显示）。

---

## 三、总体架构

### 3.1 分层

```
┌──────────────────────────────────────────────────────────┐
│ 主题层（可替换）                                          │
│   ui/themes/<id>.tsx   ← 单文件：结构 + 组件组合 + 样式     │
└───────────────────────┬──────────────────────────────────┘
                        │ 只能 import Theme SDK 的公开面
┌───────────────────────▼──────────────────────────────────┐
│ Theme SDK（稳定契约）                                     │
│   contract.ts     类型与 defineTheme 校验                 │
│   store-bridge    可变 store → 可订阅快照                  │
│   hooks/          useTeamState / useTarget / useChat …    │
│   actions/        switchTarget / sendMessage / openView … │
│   components/     Avatar / Bubble / EmptyState / ErrorView │
└───────────────────────┬──────────────────────────────────┘
                        │ 复用，不复制
┌───────────────────────▼──────────────────────────────────┐
│ 业务层（不随主题变化）                                     │
│   ui/js/store/**    状态与动作                             │
│   foundation/api.js 全部 HTTP 接口                         │
│   foundation/session.js  会话 id 解析                      │
└───────────────────────┬──────────────────────────────────┘
                        │ 宿主注入
┌───────────────────────▼──────────────────────────────────┐
│ 宿主                                                      │
│   ModuleLoader / slots / theme tokens / locale            │
└──────────────────────────────────────────────────────────┘
```

**判据**：主题文件里出现 `fetch(`、`document.querySelector(`、`localStorage`、`import ... from '<第三方包>'` —— 都是越界。

### 3.2 数据流

```
宿主 slot props（sessionId / modelSelection）
        │
        ▼
session-bridge ──dispatch──▶ store（可变 state）
                                │ 广播
                                ▼
                        store-bridge（版本号递增）
                                │ useSyncExternalStore
                                ▼
                          主题组件树（React）
                                │ 用户交互
                                ▼
                          SDK actions ──dispatch──▶ store
```

单向、无回写。主题**不能**直接改 `state`。

### 3.3 目录结构（新增部分）

```
ui/
├── theme-sdk/                  主题开发契约（稳定面）
│   ├── contract.ts             ThemeDefinition 类型 + defineTheme
│   ├── store-bridge.ts         useSyncExternalStore 适配
│   ├── hooks.ts                useTeamState / useTarget / useChat / useGroups / useDock
│   ├── actions.ts              动作封装（只暴露 dispatch）
│   ├── components/
│   │   ├── Avatar.tsx
│   │   ├── Bubble.tsx
│   │   ├── RequestRow.tsx
│   │   ├── EmptyState.tsx
│   │   └── ErrorView.tsx
│   └── index.ts                唯一导出入口
├── themes/
│   ├── default.tsx             与现有界面等价的基线主题（迁移锚点）
│   └── tim.tsx                 TIM 风格示例
└── js/                         （过渡期保留）

scripts/
└── build-theme.mjs             主题编译：TSX → CJS bundle → ModuleLoader factory

test/
└── theme-contract.test.js      契约与产物断言
```

---

## 四、主题契约（ThemeDefinition）

### 4.1 类型定义

```ts
// ui/theme-sdk/contract.ts

/** 主题元信息：构建期与运行期共用 */
export interface ThemeMeta {
  /** 稳定标识，用于样式命名空间与切换校验；只允许 [a-z0-9-] */
  id: string;
  /** 展示名，构建期写入产物，运行期由宿主 locale 决定是否本地化 */
  name: string;
  /** 契约版本；SDK 变更时用来拒绝旧主题 */
  contractVersion: 1;
}

/** 主题必须提供的根组件 */
export interface ThemeRootProps {
  /** 挂载点：主题自己决定渲染到哪里（通常返回一棵完整的浮层树） */
  readonly mount: 'overlay' | 'dock';
}

export interface ThemeDefinition {
  meta: ThemeMeta;
  /** 根组件。所有 UI 从这里长出来 */
  Root: (props: ThemeRootProps) => JSX.Element;
  /**
   * 可选：主题自带 CSS 文本。
   * 构建期原样收进产物，运行期注入 <style data-theme="<id>">。
   * 不接受外部 CSS 文件引用（避免主题变成第二个构建入口）。
   */
  styles?: string;
  /** 可选：主题在卸载时需要额外清理的资源工厂 */
  setup?: (ctx: ThemeSetupContext) => void | (() => void);
}

export interface ThemeSetupContext {
  readonly meta: ThemeMeta;
  /** 只读：主题不应在这里改状态 */
  readonly getState: () => TeamState;
}
```

### 4.2 `defineTheme` 校验

```ts
export function defineTheme(definition: ThemeDefinition): ThemeDefinition {
  // 1. meta.id 必须匹配 /^[a-z][a-z0-9-]{1,31}$/
  // 2. meta.contractVersion 必须等于 SDK 的 THEME_CONTRACT_VERSION
  // 3. Root 必须是函数
  // 4. styles 若存在必须是字符串
  // 5. 返回冻结对象，防止运行期被改写
}
```

校验在**构建期**执行一次（`build-theme.mjs` 引入主题模块并调用），失败即构建失败，报错带主题路径与具体字段。

### 4.3 必需与可选

| 项 | 必需 | 缺了会怎样 |
|---|---|---|
| `meta.id` / `meta.name` / `meta.contractVersion` | 是 | 构建失败 |
| `Root` | 是 | 构建失败 |
| `styles` | 否 | 主题无自定义样式，只能用 SDK 组件的默认样式 |
| `setup` | 否 | 无额外清理 |

### 4.4 主题能做什么 / 不能做什么

| 能做 | 不能做 |
|---|---|
| 任意 JSX 结构、条件、`map`、事件处理 | 直接 `fetch` / `XMLHttpRequest` |
| 组合 SDK 组件，或自己写展示组件 | 直接读写 `store.getState()` 的字段并赋值 |
| 用 `style` 对象与 `styles` 文本做样式 | 引入平台模块表之外的 `import`（必须打进 bundle） |
| 用 `useTeamState` 订阅任意切片 | 注册新的 slot、改宿主 DOM |
| 定义主题内局部 state（`useState`） | 持久化到 `localStorage`（应走 SDK） |

---

## 五、共享能力层（Theme SDK）

### 5.1 状态桥：可变 store → 可订阅快照

这是整个设计里**最容易出错**的一环，必须显式解决。

问题：`store.getState()` 永远返回同一个对象引用（原地修改），`useSyncExternalStore` 会认为「没变化」，导致界面不更新；若强行每次返回新对象，又会无限重渲染。

方案：**版本号 + 选择器**，不做深拷贝。

```ts
// ui/theme-sdk/store-bridge.ts
type Listener = () => void;

let version = 0;
const listeners = new Set<Listener>();
let detach: (() => void) | null = null;

/** 由 client 入口在 store 创建后调用一次 */
export function attachStore(store: TeamStore): () => void {
  detach?.();
  const offs: Array<() => void> = [];
  // store 的每个广播事件都让版本号 +1
  for (const eventName of STORE_EVENTS) {
    offs.push(store.subscribe(eventName, bump));
  }
  detach = () => { offs.forEach((off) => off()); detach = null; };
  return detach;
}

function bump(): void {
  version += 1;
  listeners.forEach((listener) => listener());
}

export function subscribeThemeStore(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getStoreVersion(): number {
  return version;
}

export function getRawState(): TeamState {
  return activeStore.getState();
}
```

hook：

```ts
// ui/theme-sdk/hooks.ts
import { useSyncExternalStore, useMemo } from 'react';
import { subscribeThemeStore, getStoreVersion, getRawState } from './store-bridge';

export function useTeamState<Selected>(
  selector: (state: TeamState) => Selected,
  isEqual: (a: Selected, b: Selected) => boolean = Object.is,
): Selected {
  // 用版本号作为外部快照：引用会变，React 才会重渲染
  const snapshotVersion = useSyncExternalStore(subscribeThemeStore, getStoreVersion, getStoreVersion);
  const selected = useMemo(() => selector(getRawState()), [snapshotVersion, selector]);
  // 缓存上一次结果，isEqual 相等时返回旧引用，避免下游 memo 失效
  return useStable(selected, isEqual);
}
```

**为什么不用 `useSyncExternalStore` 直接返回 state**：`getSnapshot` 必须幂等且返回稳定引用，而 state 是可变对象，语义对不上。用版本号做快照，语义清晰且零拷贝成本。

**代价**：任一事件触发都会让所有订阅者重算 selector。当前 `STORE_EVENTS` 只有 7 个（`ui/js/store/state.js:6`），状态规模小，实测风险低；若将来状态膨胀，再引入按事件分组的订阅（见 §十六 未决项 U-2）。

### 5.2 hooks 清单

| hook | 返回 | 说明 |
|---|---|---|
| `useTeamState(selector, isEqual?)` | 任意切片 | 通用订阅 |
| `useGroups()` | `Group[]` | 群列表（= 平台账号） |
| `useDrivers()` | `DriverMeta[]` | 驱动元数据（取平台名与头像） |
| `useFriendGroups()` | `FriendGroup[]` | 好友分组 |
| `useTarget()` | `{ target, effectiveTarget, targetSource }` | 当前会话目标 |
| `useChat(groupId)` | `{ messages, models, modelsStatus }` | 单群消息与群友 |
| `useSession()` | `{ sessionId, sessionTitle }` | 会话标识 |
| `useStats()` | `{ rate, global }` | 速率与全局请求量 |
| `useView()` | `{ view, currentGroupId }` | 当前视图 |
| `useErrors()` | `{ tag, message }[]` | 错误出口（渲染告警条用） |
| `useDock()` | `DockState` | 悬浮件状态（显隐/锚点/方向） |
| `useThemeMeta()` | `ThemeMeta` | 当前主题元信息 |

**约定**：hook 只读。要改状态一律用 `actions`。

### 5.3 actions 清单

```ts
// ui/theme-sdk/actions.ts —— 全部转成 store.dispatch，不新增写入口
export const actions = {
  openView: (view: ViewName, groupId?: string) => store.dispatch({ type: 'open-view', view, groupId }),
  loadChat: (groupId: string) => store.dispatch({ type: 'load-chat', groupId }),
  loadGroups: () => store.dispatch({ type: 'load-groups' }),
  switchTarget: (target: Target) => store.dispatch({ type: 'switch-target', target }),
  sendMessage: (text: string) => store.dispatch({ type: 'send-message', text }),
  toggleRow: (rowIndex: number) => store.dispatch({ type: 'toggle-row', rowIndex }),
  setDockAnchor: (anchor: { left: number; top: number }) => store.dispatch({ type: 'set-anchor', anchor }),
  setDockVisible: (visible: boolean) => setDockVisible(visible),   // 走 dock-state 工厂
};
```

**禁止**在 SDK 里新增 `dispatch` 未覆盖的写路径。若主题需要新动作，先加进 `ui/js/store/dispatch.js` 的表（一行一个），再暴露到 SDK。

### 5.4 基础组件

只提供**展示与无障碍**，不含业务判断：

| 组件 | 职责 | 不负责 |
|---|---|---|
| `<Avatar>` | 文本/URL 头像，加载失败降级为首字母 | 决定用谁的头像 |
| `<Bubble side="left\|right">` | 气泡外观（圆角、尾巴、宽度约束） | 内容语义 |
| `<RequestRow>` | 请求记录的折叠/展开外观 | 计算速率、判定状态色（由 SDK 传入已算好的字段） |
| `<EmptyState>` | 空列表占位 | 区分「空」与「加载失败」（由调用方传文案） |
| `<ErrorView>` | 错误展示 + 重试按钮 | 决定是否重试 |

**关键**：`<RequestRow>` 接收的是**已经归一化好的字段**（`status`、`statusText`、`latency`、`tokens`、`credit`、`cacheHit`、`title`），与 `docs/02-契约.md` §3.2 的 `RequestRow` 完全一致。主题不重新计算这些值——`docs/02` §5.1 的速率口径（`completionTokens / decodeMs`）必须只有一处实现。

### 5.5 样式注入

```ts
// ui/theme-sdk/styles-runtime.ts
export function mountThemeStyles(meta: ThemeMeta, css: string): () => void {
  const tag = document.createElement('style');
  tag.dataset.theme = meta.id;
  tag.textContent = css;
  document.head.appendChild(tag);
  return () => tag.remove();
}
```

- 每个主题一个 `<style data-theme="<id>">`；
- 切换时先卸旧、再挂新；
- 主题 CSS 必须**全部限定在 `[data-theme-root="<id>"]` 之下**（构建期断言，见 §十四.1）。

---

## 六、单文件主题规格

### 6.1 最小主题

```tsx
// ui/themes/minimal.tsx
import { defineTheme, useGroups, useTarget, actions, Avatar } from '../theme-sdk';

export default defineTheme({
  meta: { id: 'minimal', name: '极简', contractVersion: 1 },
  Root: function MinimalRoot() {
    const groups = useGroups();
    const { effectiveTarget } = useTarget();
    return (
      <div data-theme-root="minimal">
        <header>当前目标：{labelOf(effectiveTarget)}</header>
        <ul>
          {groups.map((group) => (
            <li key={group.id} onClick={() => actions.openView('chat', group.id)}>
              <Avatar text={group.avatar} fallback={group.name} />
              {group.name}
            </li>
          ))}
        </ul>
      </div>
    );
  },
});
```

### 6.2 完整主题（TIM 风格，节选）

```tsx
// ui/themes/tim.tsx
import {
  defineTheme, useGroups, useChat, useTarget, useSession, useStats, useView,
  actions, Avatar, Bubble, RequestRow, EmptyState,
} from '../theme-sdk';

export default defineTheme({
  meta: { id: 'tim', name: 'TIM 经典', contractVersion: 1 },

  styles: `
    [data-theme-root="tim"] { --tim-primary: #12b7f5; }
    [data-theme-root="tim"] .tim-tab { color: var(--team-text-2); }
    [data-theme-root="tim"] .tim-tab[aria-selected="true"] { color: var(--tim-primary); }
  `,

  Root: function TimRoot() {
    const { view, currentGroupId } = useView();
    const groups = useGroups();
    const session = useSession();

    return (
      <div data-theme-root="tim" className="tim-app">
        {view === 'chat' && currentGroupId
          ? <TimChat groupId={currentGroupId} />
          : <TimList groups={groups} />}
        <TimTabBar view={view} />
        <TimDock session={session} />
      </div>
    );
  },
});

function TimChat({ groupId }: { groupId: string }) {
  const { messages, modelsStatus } = useChat(groupId);
  const [draft, setDraft] = useState('');
  return (
    <>
      <header>[群友: {modelsStatus === 'loading' ? '—' : modelsStatus === 'loaded' ? '' : '?'}]</header>
      <ol className="tim-stream">
        {messages.map((message, index) =>
          message.type === 'row'
            ? <RequestRow key={index} row={message.row} expanded={message.expanded}
                          onToggle={() => actions.toggleRow(message.rowIndex)} />
            : <Bubble key={index} side={message.type === 'mine' ? 'right' : 'center'}>{message.text}</Bubble>
        )}
      </ol>
      <form onSubmit={(event) => { event.preventDefault(); actions.sendMessage(draft); setDraft(''); }}>
        <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="@ 选择群友或分组…" />
        <button type="submit">发送</button>
      </form>
    </>
  );
}
```

### 6.3 主题内允许的写法

| 允许 | 说明 |
|---|---|
| 任意 JSX 结构 | 这就是「窗口组件配置化」的实现方式——不是选组件名，而是直接写结构 |
| 局部 `useState` | 输入草稿、展开态、弹层开关等纯 UI 状态 |
| `useEffect` + 返回清理 | 定时器、事件监听、`ResizeObserver` |
| `useMemo` / `useCallback` | 大列表派生数据 |
| `React.lazy` + 动态 `import` | **仅当目标模块也被打进 bundle**；跨 bundle 的动态加载本期不支持 |

### 6.4 禁止项（构建期可断言的部分见 §十四.1）

| 禁止 | 理由 |
|---|---|
| `fetch` / `XMLHttpRequest` / `navigator.sendBeacon` | 绕过 `api.js` 的超时、错误分类与鉴权 |
| `document.querySelector` / `innerHTML` | 主题不该操作自己的 DOM，React 已经管了；也避免退回旧模式 |
| `localStorage` / `sessionStorage` / `indexedDB` | 持久化口径应集中在 store（`ui/js/store/persist.js`） |
| `import` 平台模块表之外的包且未内联 | 运行期 `require` 会失败 |
| 直接给 `state.xxx` 赋值 | 绕过 `dispatch`，破坏 INV-12 单一写入口 |
| 注册 slot / 改宿主 DOM | 越权；slot 注册只在 `lib/client-parts/apply.js` |

---

## 七、构建流水线

### 7.1 输入

```jsonc
// config/config.json（或 $DSH_MODEL_TEAM_HOME/config.json）
{
  "theme": {
    "source": "ui/themes/tim.tsx",     // 新增：TSX 主题源码
    "html": "ui/index.html",            // 保留：legacy 主题
    "styles": ["ui/app.css"]            // 保留：legacy 样式
  }
}
```

**优先级规则**：

| 配置 | 走哪条路径 |
|---|---|
| 只有 `source` | TSX 路径（新） |
| 只有 `html` + `styles` | legacy 路径（现有） |
| 两者都有 | **构建失败**，报「主题配置冲突」——不允许两条路径同时生效 |
| 都没有 | legacy 默认路径（`ui/index.html` + `ui/app.css`），行为与现在逐字节一致 |

### 7.2 转译与打包

用 **esbuild**（零配置、单文件、毫秒级）：

```js
// scripts/build-theme.mjs（核心片段）
import { build } from 'esbuild';

const result = await build({
  entryPoints: [themeSourcePath],
  bundle: true,
  write: false,
  format: 'cjs',                  // ← 关键：输出 require(...)，与 ModuleLoader factory 的签名对齐
  platform: 'browser',
  target: ['es2020'],
  jsx: 'automatic',
  jsxImportSource: 'react',
  external: PLATFORM_MODULES,     // 平台模块表原样外置
  loader: { '.css': 'text' },     // 主题若引用 CSS 文本，内联成字符串
  minify: false,                  // 保留可读性，产物由 client.js 统一压缩策略决定
  metafile: true,
});
```

**为什么 `format: 'cjs'`**：

- 输出里是 `require("react")` / `require("react/jsx-runtime")`；
- `ModuleLoader` 的 factory 签名恰好是 `function (require) { ... }`；
- 把 bundle 代码原样放进 factory 函数体，`require` 由宿主提供 —— **零适配层**。

对照：若用 `format: 'esm'`，产物是 `import ... from "react"`，无法塞进 classic script 的函数体，必须再做一次 AST 改写，成本高且易错。

### 7.3 包进 ModuleLoader factory

```js
// 生成的 lib/client.js 结构（示意）
window.__ModuleLoader__.load({
  id: "dsh-model-team",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    /* ===== CLIENT_PARTS：foundation（loader/constants/utils/session/api/z-layers/styles） ===== */
    /* ===== THEME_BUNDLE：esbuild 产物原样插入 ===== */
    /*  "use strict";
        var import_jsx_runtime = require("react/jsx-runtime");
        var import_react = require("react");
        var theme = { meta: {...}, Root: ... };
        ... */
    /* ===== TAIL_PARTS：挂载与 apply ===== */
    exports.apply = apply;
    return module.exports;
  }
});
```

**顺序要求**：`THEME_BUNDLE` 必须在 `foundation/*` 之后（它要用 `api` / `store` 的工厂）、在 `apply.js` 之前（`apply` 要挂载它）。这与现有 `PART_ORDER` 的断言机制一致，新增一条顺序断言即可。

### 7.4 产物断言（缺一即构建失败）

| 断言 | 判据 |
|---|---|
| 主题已内联 | 产物含 `data-theme-root="<meta.id>"` |
| 必需导出存在 | 产物含 `Root:` 与 `contractVersion` |
| 平台模块未被打包 | 产物**不得**含 `node_modules/react/` 的实现代码；只允许 `require("react")` 字面量 |
| 无裸 import | 产物不含 `^import .* from` 行 |
| 样式已内联 | 若主题声明了 `styles`，产物含该 CSS 的首 40 字符 |
| legacy 不受影响 | 未配 `theme.source` 时，`lib/client.js` 与改动前**逐字节相同**（现有 `build.cjs` 已保证，新增路径不得破坏） |

### 7.5 幂等与缓存

- 同输入 → 逐字节相同产物（现有 `build.cjs` 的既有性质，必须延续）；
- esbuild 的 `metafile` 不写进产物，只用于断言与体积报告；
- 构建耗时目标：主题编译 ≤ 500ms（单文件、无 node_modules 打包）。

---

## 八、运行时加载与主题切换

### 8.1 首次加载

```
apply(ctx)
  ├─ ctx.effect → mountDock()            ← 现有：挂骨架 + 注入 CSS
  ├─ ctx.effect → attachStore(store)      ← 新增：把 store 接进 SDK 桥
  ├─ ctx.effect → mountThemeStyles(meta, css)   ← 新增
  └─ ctx.effect → createRoot(container).render(<ThemeBoundary><Theme.Root mount="overlay"/></ThemeBoundary>)
```

**容器**：主题渲染到 `document.body` 下由插件创建并持有的 `<div data-dmt-theme-host>`。不接管 `#root`，不追加第二个应用（`references/ui-plugin.md` 明确禁止替换 app root）。

### 8.2 切换时序

```
switchTheme(nextId)
  1. 若 nextId === activeId → 直接返回（幂等）
  2. 若 nextId 不在已注册主题表 → 抛错并保持当前主题（不进入半切换状态）
  3. 调用当前主题 setup 返回的 cleanup()
  4. 卸载当前 style 标签
  5. root.render(<ThemeBoundary key={nextId}><Next.Root/></ThemeBoundary>)
       └─ key 变化强制整棵子树重建，避免旧主题组件残留
  6. 注入新 style 标签
  7. 触发一次 store.render()，让派生值按新主题重算
```

**关键约束**：

| 约束 | 理由 |
|---|---|
| **不调用 `store.stop()` / `store.start()`** | 业务状态与已加载数据必须保留；重启会重拉全部接口并闪烁 |
| **不重建 `store` 实例** | 重建 = 丢目标映射、丢会话绑定 |
| **不重跑 `boot()`** | `boot()` 有 `window.__dshModelTeamBooted` 守卫（`app.js:455`），重跑是 no-op，会造成「切了但没变」的假象 |
| **`key` 必须变化** | React 复用同位置组件时不会重置 `useState`，旧主题的草稿会漏到新主题 |

### 8.3 状态不重建的验证方式

切换前后各读一次 `store.getState()` 的下列字段，必须完全相同：

```
sessionId, target, effectiveTarget, groups.length, friendGroups.length, models（各群键集合）
```

这条要写成自动化断言（§十四.2 之 R-3）。

### 8.4 多主题（阶段 P3，本期不做）

若将来需要「运行期从 N 个已构建主题中选一个」：

- 每个主题单独构建成一个 `ModuleLoader` 模块（不同 `id`）；
- 宿主侧维护主题清单（JSON，符合 `config-json-main-env-override` 的「结构进 JSON」）；
- 切换 = 加载目标模块 → 挂载 → 卸旧。

**代价**：每个主题都要过一遍 `ModuleLoader` 加载与平台模块解析；总体积 = N 个 bundle。**本期不做的理由**：单主题构建已经满足「换主题」的核心诉求，多主题带来的分发与版本一致性问题远大于收益。

---

## 九、状态与并发

### 9.1 快照语义

| 层 | 语义 |
|---|---|
| `store.getState()` | 可变对象，引用恒定，**仅供 SDK 内部读取** |
| `getStoreVersion()` | 单调递增整数，每次广播 +1 |
| `useTeamState(selector)` | 在版本变化时重算 selector；`isEqual` 相等则返回旧引用 |

**禁止**主题把 `getState()` 的返回值存进 `useState` 长期持有——那是可变对象的引用，内容会「偷偷变」，React 无从感知。

### 9.2 订阅粒度

当前是**全量广播**（任一事件 → 所有订阅者重算）。可接受的理由：

- 状态规模小（群列表、单群消息、目标、统计）；
- 事件只有 7 类；
- 重算 selector 是纯函数，成本低。

**升级路径**（U-2）：`attachStore` 里按事件名分组维护版本号，`useTeamState` 接受 `channels` 参数只订阅相关事件。届时 selector 重算次数可下降一个量级。

### 9.3 与现有事件总线共存

现有 `createEventHub` 的每个事件都已内置一个「渲染器订阅者」（`ui/js/store/events.js:40-42`），它调用 `onRender(state)` → `renderApp`。

过渡期处理：

- **legacy 主题**：保留 `onRender → renderApp`；
- **TSX 主题**：`onRender` 改为 no-op（或只做 `assertThemeContract` 级别的轻量检查），渲染完全由 React 驱动。

判据：同一时刻**只有一个渲染驱动**，不允许 React 与 `innerHTML` 同时改同一棵 DOM。

### 9.4 渲染竞态

`dispatch` 返回 Promise（`ui/js/store/dispatch.js:42`）。主题里常见的错误写法：

```tsx
// ✗ 错误：await 之后组件可能已卸载
const onSubmit = async () => { await actions.switchTarget(t); setDone(true); };
```

正确做法：`useEffect` 的清理函数里置 `cancelled` 标志，或把结果写回 store 由订阅驱动。**这条要写进主题开发文档，并作为 review 检查项。**

---

## 十、样式与隔离

### 10.1 注入方式

| 来源 | 注入点 | 生命周期 |
|---|---|---|
| SDK 基础组件样式 | 构建期内联进 `UI_CSS` 常量（现有 `lib/client-parts/foundation/styles.js:15`） | 插件卸载时随 `mountStyle` 的清理移除 |
| 主题自有样式 | `<style data-theme="<id>">` | 切换/卸载时移除 |

### 10.2 命名空间

构建期断言：主题 `styles` 里的**每一条顶层选择器**都必须以 `[data-theme-root="<id>"]` 开头（允许 `:root` 变量声明与 `@media` 包裹）。

理由：宿主页面与其它插件共存，裸 `*`、`body`、`.btn` 会污染全局。这是 `dsh-frontend-glass-jank` 类问题的直接来源。

### 10.3 与宿主主题 token

优先使用宿主 token（`--dsw-alias-*`），由 `cordis_inspect_query Theme.listTokens` 列出。主题可定义自己的 `--tim-primary` 等，但**容器背景、文字色、边框**应继承宿主 token，否则宿主切换深色模式时主题会瞎。

### 10.4 为什么不用 Shadow DOM

| 维度 | Shadow DOM | 本方案 |
|---|---|---|
| 样式隔离 | 强 | 靠命名空间 + 构建断言 |
| 宿主 token 继承 | 需手动 `adoptedStyleSheets` 转发 CSS 变量 | 天然继承 |
| React 事件委托 | 需要额外处理（事件冒泡跨 shadow boundary 有差异） | 无影响 |
| 调试 | DevTools 里多一层 | 与页面同级 |
| 体积 | 无差别 | 无差别 |

结论：**样式隔离的收益不足以抵消 token 继承与调试成本**，用命名空间 + 断言解决。

---

## 十一、失败模式

### 11.1 构建期

| 失败 | 行为 |
|---|---|
| `theme.source` 文件不存在 | 构建失败，报绝对路径 |
| TSX 语法错误 / 类型错误 | 构建失败，报文件:行:列 |
| `defineTheme` 校验不通过 | 构建失败，报具体字段 |
| 主题 `import` 了平台表外的包且 esbuild 打不进去 | 构建失败，报包名与来源 |
| `theme.source` 与 `theme.html` 同时配置 | 构建失败，报配置冲突 |
| 产物断言不通过（§7.4） | 构建失败，报缺哪一条 |

**口径沿用现有「配了就必须有效」**（`scripts/lib/theme-config.cjs:8-11`）：绝不静默回落到默认主题。

### 11.2 运行期

| 失败 | 行为 |
|---|---|
| 主题组件渲染抛错 | `ThemeBoundary`（ErrorBoundary）捕获 → 渲染降级 UI（错误摘要 + 「切回默认主题」按钮）→ 错误进 `store.reportError('theme', …)` |
| 主题 `setup` 抛错 | 记录错误，**继续挂载**（setup 是增强，不是前提） |
| `styles` 注入失败（CSP 等） | 记录错误，界面无样式但仍可用 |
| 主题 `id` 与已注册主题冲突 | 构建期即失败，运行期不会遇到 |

**降级 UI 必须由 SDK 提供**（`<ThemeCrashFallback>`），不依赖主题自己实现——主题崩了就没有主题代码可用。

### 11.3 降级链

```
当前主题 → （崩）→ SDK 内置最小 UI（可切回默认主题）→ （再崩）→ 只显示错误文本 + 重试
```

不允许出现白屏。这条对应 `references/practices.md` 的「slot entry crashed」教训。

---

## 十二、安全边界

### 12.1 TSX 主题是可执行源码

必须明确：**主题不是数据配置，是代码**。它能访问 `window`、能发请求、能读写 DOM。因此：

| 信任假设 | 说明 |
|---|---|
| 主题由插件作者或受信任方提供 | 与插件本身同等信任级别 |
| 不做运行期沙箱 | 沙箱（iframe/Worker）会切断 React 与宿主 slot 的联系，代价不可接受 |
| 主题清单可校验完整性 | 分发场景下用哈希校验（阶段 P3） |

### 12.2 主题能碰到的边界

即使主题是可信代码，SDK 仍只暴露最小面：

- 不导出 `store` 实例，只导出 `actions` 与只读 hooks；
- 不导出 `api`（防止绕过超时与错误分类）；
- 不导出 `ctx`（防止主题抢注 slot）。

**这是「防误用」而非「防恶意」**——恶意主题仍可直接 `require('react')` 后操作 DOM。文档必须写清这一点，不能给人「SDK 有安全隔离」的错觉。

### 12.3 供应链

- 主题内联第三方库会进产物，体积与许可证都随之上浮；
- 建议：主题优先只用 SDK 组件与原生 API；确需图表等能力时，单独评估（`echarts` 这类体积大，需按需打包）；
- 产物需附许可证说明（`build.license` 类似机制，阶段 P2）。

---

## 十三、兼容与迁移

### 13.1 双轨并行

| 维度 | legacy（HTML 主题） | TSX 主题 |
|---|---|---|
| 配置 | `theme.html` + `theme.styles` | `theme.source` |
| 渲染 | `innerHTML` 全量重绘 | React 组件树 |
| DOM 钩子契约 | `docs/03` §二 的 23 个 id 必需 | **不需要**（组件自持） |
| 样式来源 | `theme.styles` 文件 | 主题内 `styles` 字符串 |
| 门禁 | `check-contract` 校验钩子 | 新增 `check-theme` 校验契约与产物 |
| 状态 | 现有 store | 同一 store（经桥） |

**同一构建只能启用一条路径**（§7.1 配置冲突即失败），避免两套渲染同时改 DOM。

### 13.2 DOM 钩子契约的变化

这是本次设计影响面最大的一处，必须写清：

`docs/03-UI规范.md` §二 列的 `#floatDock`、`#floatBall`、`#floatPanel`、`#fpSession`、`#viewRoot`、`.team-tabbar` 等，是**legacy 渲染层与主题之间的接口**。TSX 主题下：

- 这些 id 不再是契约的一部分；
- `check-contract.mjs` 的钩子校验只对 legacy 路径生效；
- 新增 `check-theme.mjs` 校验 TSX 路径的契约（§十四.1）。

**不能在文档里同时宣称两套都是「唯一契约」**——那正是 `docs/06` DOC-05/DOC-06 记录过的错误类型。过渡期内，`docs/03` 需要明确标注「本节适用于 legacy 主题路径」。

### 13.3 门禁调整

| 门禁 | 现状 | TSX 路径下 |
|---|---|---|
| `check-contract`（端点 + DOM 钩子） | 端点 26 条 + 钩子 23 个 | 端点照旧；钩子校验仅 legacy |
| `check-render` | 用 `render.js` 渲染真实数据断言 DOM | legacy 专用；TSX 需新断言（见下） |
| `check-css` | 层级、显隐、魔数的静态判定 | 照旧（SDK 组件样式仍走这套） |
| `check-layout` | 文档路径 ↔ 文件树 | 需登记 `ui/theme-sdk/`、`ui/themes/` |
| **新增 `check-theme`** | — | 契约校验 + 产物断言 + 主题 CSS 命名空间 |

### 13.4 分阶段迁移

| 阶段 | 内容 | 退出判据 |
|---|---|---|
| **P0 契约冻结** | 本文定稿；`ThemeDefinition` 类型与 `defineTheme` 校验落地；SDK 目录骨架 | 类型可编译；`check-theme` 能对空主题报错 |
| **P1 等价主题** | `ui/themes/default.tsx` 复刻现有界面（三 tab、群列表、群聊、请求行、加购、通讯录、我的、悬浮件） | 与 legacy 主题并排渲染，**视觉与交互逐项对齐**（人工核对清单见 §十四.4） |
| **P2 切换生效** | `theme.source` 成为默认；`switchTheme` 实现；降级链可用 | 切换后业务状态不变（R-3）；崩溃可恢复（R-4） |
| **P3 可选增强** | 多主题分发、完整性校验、许可证清单 | 按需启动 |

**P1 是最重的一步**：它不是「写个新皮肤」，而是把现有 488 行 `app.js` + 494 行 `render.js` + 476 行 `float.js` 的交互语义**逐条搬进组件**。任何一条漏掉就是回归（F-01~F-06、G-dock、G-dock2 都在这一层）。

---

## 十四、验收标准

### 14.1 构建期断言（`scripts/check-theme.mjs`）

| # | 断言 | 反例自证方式 |
|---|---|---|
| B-1 | `defineTheme` 必需字段齐全 | 删掉 `meta.id` → 必须红 |
| B-2 | `contractVersion` 匹配 | 改成 `2` → 必须红 |
| B-3 | 产物含 `data-theme-root="<id>"` | 删掉该属性 → 必须红 |
| B-4 | 产物不含 `node_modules/react` 实现 | 去掉 `external` → 必须红 |
| B-5 | 产物不含裸 `import` 语句 | 强制 `format: 'esm'` → 必须红 |
| B-6 | 主题 CSS 选择器均已命名空间化 | 加一条 `body { color: red }` → 必须红 |
| B-7 | `theme.source` 与 `theme.html` 不同时存在 | 同时配置 → 必须红 |
| B-8 | 未配 `theme.source` 时产物与基线逐字节相同 | 对基线跑 sha256 比对 |

**每条都必须先跑红再跑绿**（沿用 `docs/05` R4 的门禁自证纪律）。

### 14.2 运行期断言（`test/theme-runtime.test.js`）

| # | 断言 |
|---|---|
| R-1 | `attachStore` 后，任一 store 广播使 `getStoreVersion()` +1 |
| R-2 | `useTeamState(selector)` 在版本变化时重算；`isEqual` 相等时返回旧引用 |
| R-3 | `switchTheme` 前后，`sessionId / target / groups.length / models 键集合` 完全相同 |
| R-4 | 主题组件抛错时渲染 `<ThemeCrashFallback>`，且错误进 `store.errors` |
| R-5 | `switchTheme` 到未注册 id 时抛错且当前主题不变 |
| R-6 | 切换后旧 `<style data-theme>` 已被移除，DOM 中只剩一个 |

### 14.3 等价性验收（P1 退出条件）

把 legacy 主题与 `default.tsx` 并排打开，逐项核对：

| # | 项目 | 判据 |
|---|---|---|
| E-1 | 三 tab 切换 | `aria-selected` 跟随；内容区不重建输入框 |
| E-2 | 群列表 | 条目数 = 接口返回数；驱动列非空；搜索可过滤 |
| E-3 | 群聊 | 请求行折叠/展开；`title` 含完整日志；群友数 = 接口长度 |
| E-4 | 发送消息 | 右侧气泡出现；系统提示来自后端；刷新后条数不变 |
| E-5 | 悬浮球 | 开合往返；拖动后落位不跳回；`scrollWidth ≤ clientWidth` |
| E-6 | 焦点 | 进群聊不把焦点塞进搜索框；展开请求行后滚动位置保持 |
| E-7 | 加群表单 | 切平台清空旧值；提交失败不插入幽灵群 |

### 14.4 人工验收（不可自动化）

- 视觉观感、动效手感、深色模式可读性 → 人工确认；
- **AI 不得自评「好看」「符合预期」**（`docs/05` §五）。

---

## 十五、里程碑

| 里程碑 | 交付物 | 验收 | 预计改动面 |
|---|---|---|---|
| **M1** 契约与 SDK 骨架 | `ui/theme-sdk/contract.ts`、`store-bridge.ts`、`hooks.ts`、`actions.ts`；`check-theme.mjs` 骨架 | B-1/B-2 红绿自证；R-1/R-2 通过 | 新增约 6 文件 |
| **M2** 构建流水线 | `scripts/build-theme.mjs`；`build.cjs` 接入；产物断言 | B-3~B-8 全绿；legacy 产物逐字节不变 | 改 `build.cjs`，新增 1 脚本 |
| **M3** 等价主题 | `ui/themes/default.tsx` + SDK 组件 | E-1~E-7 全过 | 新增约 10 文件 |
| **M4** 切换与降级 | `switchTheme`、`ThemeBoundary`、`ThemeCrashFallback` | R-3~R-6 全绿 | 改 `apply.js`、`dock.js` |
| **M5** 示例主题 | `ui/themes/tim.tsx` | 可与 default 互相切换 | 新增 1 文件 |
| **M6** 文档与门禁收口 | `docs/03` 标注 legacy 范围；`docs/14` 登记新目录；`docs/00` 加索引 | `check-layout` 绿 | 改 3 份文档 |

---

## 十六、风险与未决项

### 16.1 风险

| # | 风险 | 可能性 | 影响 | 缓解 |
|---|---|---|---|---|
| K-1 | P1 等价主题遗漏交互语义（焦点、滚动、拖动） | 高 | 高：历史缺陷复发 | E-1~E-7 逐条核对；对照 `docs/06` 已修表反查 |
| K-2 | 全量广播导致大列表卡顿 | 中 | 中 | 先量后优；预留按事件分组（U-2） |
| K-3 | 主题误用第三方库导致产物膨胀 | 中 | 中 | 构建期体积报告 + review |
| K-4 | legacy 与 TSX 双轨期两套渲染同时生效 | 中 | 高：DOM 打架 | 配置冲突即构建失败；`onRender` 只能有一个驱动 |
| K-5 | 宿主 slot props 形状变化（`useProjection` 等） | 低 | 中 | 现有 `session-bridge.js` 已有兼容分支，迁移时保留 |
| K-6 | ~~esbuild 引入新的构建依赖~~ **已决议允许**（2026-11-23） | — | 已解除 | 见 §16.3 依赖口径 |

### 16.2 未决项

| # | 未决 | 选项 | 结论 |
|---|---|---|---|
| **U-1** | ~~是否允许引入 esbuild 作为构建期依赖~~ | ~~① 引入 ② 自写转译~~ | ✅ **已决议：允许引入**（2026-11-23）。口径见 §16.3 |
| **U-2** | 订阅粒度是否本期就按事件分组 | ① 本期全量广播 ② 直接做分组 | 待定；建议 ①，先测量再优化 |
| **U-3** | TSX 主题是否也走 `design-only` 剥离机制 | ① 需要 ② 不需要（TSX 无静态骨架） | 待定；建议 ② |
| **U-4** | 主题样式是否允许引用外部 CSS 文件 | ① 不允许（只接受字符串）② 允许并内联 | 待定；建议 ①，保持「单文件」语义 |
| **U-5** | 多主题（P3）是否值得做 | ① 不做 ② 做 | 待定；建议 ①，除非有明确的多皮肤分发需求 |

### 16.3 依赖口径（2026-11-23 决议）

项目原有的「零第三方依赖」表述**仅适用于运行期**。据此明确三层边界：

| 层 | 允许依赖 | 约束 |
|---|---|---|
| **运行期（进 `lib/client.js` 产物的代码）** | 只允许宿主平台模块表（`packages/client/web/src/platform.ts:8`）里的 specifier，且必须 `external` 外置 | 产物内**不得**出现第三方实现的函数体；B-4 断言钉死 |
| **构建期（`scripts/`、`build*.mjs`、`ui/theme-sdk/` 的类型检查）** | 允许第三方 devDependency（首批：`esbuild`；TSX 类型检查如需可加 `typescript`） | 只进 `devDependencies`，`dependencies` 保持为空；`prepack` 不依赖它们产出的运行期代码 |
| **插件分发（`files` 字段）** | 只含运行期必需物 | `node_modules/` 不入库、不入包 |

落地要求：

1. `package.json` 的 `dependencies` 保持为空；新增项一律放 `devDependencies`，且只服务构建。README 不再声明「零依赖」，口径由本节与 `05` §八点一承担。
2. 安装依赖遵守 `05` §八：装在项目内、`.gitignore` 忽略、`.npmrc` 保持 `bin-links=false` 与 `ignore-scripts=true`。
3. 门禁新增一条断言：**`lib/client.js` 产物里不得出现 `devDependencies` 的包名**（防止把 esbuild 之类的代码误打进产物）。
4. `files` 字段只列运行期必需物；`node_modules/` 不入库、不入包。


---

## 十七、与现有文档的关系

| 文档 | 关系 |
|---|---|
| `01-需求与不变量.md` | INV-12（单一写入口）、INV-13（唯一入口）继续适用；主题不得引入第二条写路径 |
| `02-契约.md` | 字段与端点完全不变；主题消费的是同一份 `RequestRow` / `Group` / `FriendGroup` |
| `03-UI规范.md` | §二 的 DOM 钩子**仅适用于 legacy 路径**；§七 主题配置需扩写 `theme.source` |
| `04-里程碑与验收.md` | 新增本文 §十五 的 M1~M6，与现有 S0~S4 并列 |
| `05-工程执行约定.md` | R4 门禁自证、R5 数字可核对、§三点五「禁止调预算」全部适用 |
| `06-差异与已知问题.md` | 迁移期新发现的缺口记在这里，不写进本文 |
| `13-对齐表.md` | 需新增「TSX 主题契约 ↔ 实现 ↔ 产物」三列 |
| `14-目录结构.md` | 需登记 `ui/theme-sdk/`、`ui/themes/`、`scripts/build-theme.mjs` |

---

## 十八、附：为什么是 TSX 而不是别的

| 方案 | 结构可配 | 工程化 | 单文件 | 宿主契合 | 结论 |
|---|---|---|---|---|---|
| 单 HTML 文件 | 中（靠手写 DOM） | 无 | 是 | 需大量 `querySelector` | 作视觉稿可以，作产品架构不行 |
| JSON 低代码布局 | 低（只能表达组件库已有形态） | 中 | 是 | 需自造渲染器 | 重造 JSX 且更弱 |
| **TSX 单文件** | **高** | **高（TS/类型/生态）** | **是（编译后）** | **宿主已提供 React** | **选它** |
| ESM 微应用 + Web Component | 高 | 高 | 否（多 bundle） | 需额外适配层 | 自由度换维护成本，本场景不需要 |
| iframe 隔离主题 | 高 | 中 | 是 | **断**（拿不到 token/slot/ctx） | 否决 |

**一句话**：宿主已经给了 React，主题就该用 React 写；把「结构」写成代码，而不是写成配置。
