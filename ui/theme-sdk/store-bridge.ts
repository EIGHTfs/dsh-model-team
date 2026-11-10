// store-bridge.ts —— 把「原地修改 + 事件广播」的可变 store 桥接成 React 能订阅的快照。
//
// 这是整个 SDK 最容易出错的一环（docs/03 §7.3.5）：
//   · store.getState() 永远返回同一个对象引用（原地改字段），useSyncExternalStore 会认为「没变化」→ 界面不动；
//   · 若每次调用都返新对象，又会无限重渲染。
// 所以这里不用 state 本身做快照，而用**版本号**：每次广播 +1，引用变、语义清、零深拷贝。
//
// 事件名不在这里写死：谁来接 store 谁就把事件清单传进来（attachStore 的第二个参数）。
// 理由：事件清单的真源在 ui/js/store/state.js，本文件再抄一份就是「同一事实两处表达」，
// 以后加事件必漏一处；传参让真源只有一份，也让单测能用一个假事件表。

/** store 广播的最小形状（与 ui/js/store/index.js 暴露的三个方法对齐） */
export type StoreListener = () => void;

export interface TeamStoreLike {
  getState: () => unknown;
  subscribe: (eventName: string, listener: StoreListener) => () => void;
  dispatch: (action: { type: string } & Record<string, unknown>) => unknown;
}

/** 选择器：从整棵 state 里取一个切片 */
export type StateSelector<Selected> = (state: unknown) => Selected;

/** 相等判定：默认 Object.is（引用相等）。切片是对象时由调用方给浅比较 */
export type EqualityCheck<Selected> = (previous: Selected, next: Selected) => boolean;

let activeStore: TeamStoreLike | null = null;
let detachAttached: (() => void) | null = null;
let version = 0;
const listeners = new Set<StoreListener>();

/**
 * 接上 store，返回解绑函数。
 * 幂等：重复调用会先把上一次的订阅退掉，避免同一事件被订阅两次导致版本号 +2。
 */
export function attachStore(store: TeamStoreLike, eventNames: readonly string[]): () => void {
  detachStore();
  const offhandles: Array<() => void> = [];
  for (const eventName of eventNames) {
    offhandles.push(store.subscribe(eventName, bumpVersion));
  }
  detachAttached = () => {
    offhandles.forEach((off) => off());
    activeStore = null;
    detachAttached = null;
  };
  activeStore = store;
  // 接上 store 也要推一次版本号：首帧渲染可能早于 attach（宿主装配是异步的），
  // 不推这一下，界面就停在「空态」直到下一次广播——表现为「球和面板永远是空的」。
  bumpVersion();
  return detachAttached;
}

/** 解绑（宿主卸载时调）。没接上时是空操作，不抛错——卸载路径不该因为「本来就没挂」而失败 */
export function detachStore(): void {
  if (detachAttached) detachAttached();
  activeStore = null;
}

/**
 * 版本号 +1 并通知订阅方。
 * 导出它不是为了给主题用，而是：宿主可以在「不经过 store 事件」的非常规更新后手动戳一次，
 * 以及单测需要在不引入 React 的前提下验证「广播 → 版本号 +1 → 订阅者被调用」。
 */
export function bumpVersion(): void {
  version += 1;
  listeners.forEach((listener) => listener());
}

export function subscribeThemeStore(listener: StoreListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** useSyncExternalStore 的 getSnapshot：必须幂等且返回稳定值，所以这里给数字 */
export function getStoreVersion(): number {
  return version;
}

/**
 * 渲染期用的读状态：没接上时返回空对象而不是抛错。
 * 为什么和 getRawState 分开：渲染期抛错会让整棵组件树卸载（界面白块），
 * 而「宿主还没装配完」是正常时序；显式读取（actions、主题 setup）仍应该拿到可执行的报错。
 */
const EMPTY_STATE: Record<string, never> = Object.freeze({});

export function getStateOrEmpty(): unknown {
  return activeStore ? activeStore.getState() : EMPTY_STATE;
}

export function getRawState(): unknown {
  if (!activeStore) {
    throw new Error('[theme-sdk] store 还没接上：请在 apply 里先调用 attachStore(store, events)');
  }
  return activeStore.getState();
}

export function getStore(): TeamStoreLike {
  if (!activeStore) {
    throw new Error('[theme-sdk] store 还没接上：请在 apply 里先调用 attachStore(store, events)');
  }
  return activeStore;
}

/**
 * 每个 hook 一份的选择缓存（hooks.ts 用 useRef 持有）。
 *
 * 为什么做成工厂而不是一个全局缓存：一个渲染里会有多个 hook 各自取切片，
 * 共用一个缓存会互相覆盖（A 的切片被 B 顶掉）。工厂让每处独立，且逻辑是纯函数，单测可直接打。
 *
 * 语义（三条都要被单测钉住）：
 *   1. 版本号变了 → selector 重算；
 *   2. 版本号没变 → 直接用上次结果，不重算（避免每次渲染造新对象）；
 *   3. 重算后 isEqual 判定相等 → 返回**上一个引用**，下游 memo 不会失效。
 */
export function createSelectionCache<Selected>(isEqual: EqualityCheck<Selected> = Object.is) {
  let cachedVersion = -1;
  let cachedValue: Selected | undefined;
  let hasCachedValue = false;

  return function select(selector: StateSelector<Selected>, currentVersion: number = version): Selected {
    if (hasCachedValue && cachedVersion === currentVersion) return cachedValue as Selected;
    const nextValue = selector(getStateOrEmpty());
    const stabilized = hasCachedValue && isEqual(cachedValue as Selected, nextValue) ? (cachedValue as Selected) : nextValue;
    cachedVersion = currentVersion;
    cachedValue = stabilized;
    hasCachedValue = true;
    return stabilized;
  };
}
