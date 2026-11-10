// hooks.ts —— 主题作者唯一该用的读取入口：把 store 的切片变成 React 可订阅的 hook。
//
// 约定：hook 只读。要改状态一律走 actions（写路径只有 dispatch 一条，见 actions.ts）。
// 为什么每个 hook 都要 useMemo + useRef 缓存：store 是原地修改，若每次渲染都重算 selector，
// 对象切片会每次都是新引用，下游 memo/依赖数组全失效。缓存的纯逻辑在 store-bridge 的
// createSelectionCache 里（可单测），这里只做 React 侧的接线。

import { useMemo, useRef, useSyncExternalStore } from 'react';
import {
  createSelectionCache,
  getRawState,
  getStoreVersion,
  subscribeThemeStore,
  type EqualityCheck,
  type StateSelector,
} from './store-bridge';

/** 通用订阅：给一个 selector，拿一个切片。isEqual 相等时保持旧引用 */
export function useTeamState<Selected>(
  selector: StateSelector<Selected>,
  isEqual?: EqualityCheck<Selected>,
): Selected {
  const storeVersion = useSyncExternalStore(subscribeThemeStore, getStoreVersion, getStoreVersion);
  const cacheRef = useRef<ReturnType<typeof createSelectionCache<Selected>> | null>(null);
  if (cacheRef.current === null) cacheRef.current = createSelectionCache<Selected>(isEqual);
  // 用版本号做依赖：版本变了才重算，与 useSyncExternalStore 的语义保持一致
  return useMemo(() => (cacheRef.current as ReturnType<typeof createSelectionCache<Selected>>)(selector, storeVersion), [selector, storeVersion]);
}

// 下面这些是「具名切片」：主题不该自己拼字段路径，否则契约一变全崩。
// 每个 selector 都是纯读，缺字段一律返回空值而不是抛错——渲染期抛错会整块白屏。

type AnyState = Record<string, unknown>;

const readState = (): AnyState => getRawState() as AnyState;

/** 群列表（= 平台账号） */
export function useGroups(): unknown[] {
  return useTeamState((state) => ((state as AnyState).groups as unknown[]) || []);
}

/**
 * 群列表最近一次加载失败的原因（null/空 = 没失败）。
 * 为什么要单独一个 hook：界面必须能区分「真的没有群」与「加载失败」——
 * 把失败渲染成「0 个群」会让用户以为该加群，而不是该重试（docs/03 条款 14 的教训）。
 */
export function useGroupsError(): string {
  return useTeamState((state) => {
    const value = (state as AnyState).lastGroupsError;
    return typeof value === 'string' ? value : '';
  });
}

/** 驱动元数据（主题要用平台名与头像时取这里，不要拿群里的冗余字段） */
export function useDrivers(): unknown[] {
  return useTeamState((state) => ((state as AnyState).drivers as unknown[]) || []);
}

/** 加群下拉的选项（纯投影：只有 id 与 label，不含任何数据值） */
export function useGroupOptions(): Array<{ id: string; label: string }> {
  const drivers = useDrivers();
  const platforms = useTeamState((state) => ((state as AnyState).platforms as unknown[]) || []);
  const host = (globalThis as { dshHostDriverView?: { listGroupOptions?: Function } }).dshHostDriverView;
  return useMemo(
    () => (host && typeof host.listGroupOptions === 'function' ? host.listGroupOptions(drivers, platforms) : []),
    [drivers, platforms, host],
  );
}

/** 加群表单的状态投影：值由宿主持有，主题只读（含 advancedField 是否显示） */
export function useAddForm(): {
  optionId: string;
  driverKey: string;
  values: Record<string, string>;
  advancedField: { key: string; label: string; placeholder: string; initialValue?: string } | null;
} {
  return useTeamState((state) => {
    const form = (state as AnyState).addForm as Record<string, unknown> | undefined;
    return {
      optionId: typeof form?.optionId === 'string' ? form.optionId : '',
      driverKey: typeof form?.driverKey === 'string' ? form.driverKey : '',
      values: (form?.values as Record<string, string>) || {},
      advancedField: (form?.advancedField as ReturnType<typeof useAddForm>['advancedField']) ?? null,
    };
  });
}

/** 好友分组 */
export function useFriendGroups(): unknown[] {
  return useTeamState((state) => ((state as AnyState).friendGroups as unknown[]) || []);
}

/** 当前会话目标（显式绑定 + 后端回落后的生效值 + 来源） */
export function useTarget(): { target: unknown; effectiveTarget: unknown; targetSource: string } {
  return useTeamState((state) => {
    const current = state as AnyState;
    return {
      target: current.target ?? null,
      effectiveTarget: current.effectiveTarget ?? null,
      targetSource: typeof current.targetSource === 'string' ? current.targetSource : 'none',
    };
  }, shallowEqualTarget);
}

function shallowEqualTarget(
  previous: { target: unknown; effectiveTarget: unknown; targetSource: string },
  next: { target: unknown; effectiveTarget: unknown; targetSource: string },
): boolean {
  return previous.target === next.target
    && previous.effectiveTarget === next.effectiveTarget
    && previous.targetSource === next.targetSource;
}

/** 单群的消息与群友。groupId 为空时返回空结构，调用方不必先判空 */
export function useChat(groupId: string | null | undefined): { messages: unknown[]; models: unknown[]; modelsStatus: string } {
  return useTeamState((state) => {
    const current = state as AnyState;
    // 字段名对齐 ui/js/store/state.js 的 createInitialState：messages / models / modelsStatus 都是「群 id → 值」的映射
    const chatByGroup = (current.messages as Record<string, unknown[]>) || {};
    const modelsByGroup = (current.models as Record<string, unknown[]>) || {};
    const statusByGroup = (current.modelsStatus as Record<string, string>) || {};
    const key = String(groupId || '');
    return {
      messages: (key && chatByGroup[key]) || [],
      models: (key && modelsByGroup[key]) || [],
      modelsStatus: (key && statusByGroup[key]) || '',
    };
  }, shallowEqualChat);
}

function shallowEqualChat(
  previous: { messages: unknown[]; models: unknown[]; modelsStatus: string },
  next: { messages: unknown[]; models: unknown[]; modelsStatus: string },
): boolean {
  return previous.messages === next.messages
    && previous.models === next.models
    && previous.modelsStatus === next.modelsStatus;
}

/** 会话标识与标题 */
export function useSession(): { sessionId: string; sessionTitle: string; lastSessionId: string } {
  return useTeamState((state) => {
    const current = state as AnyState;
    return {
      sessionId: typeof current.sessionId === 'string' ? current.sessionId : '',
      sessionTitle: typeof current.sessionTitle === 'string' ? current.sessionTitle : '',
      lastSessionId: typeof current.lastSessionId === 'string' ? current.lastSessionId : '',
    };
  }, shallowEqualSession);
}

function shallowEqualSession(
  previous: { sessionId: string; sessionTitle: string; lastSessionId: string },
  next: { sessionId: string; sessionTitle: string; lastSessionId: string },
): boolean {
  return previous.sessionId === next.sessionId
    && previous.sessionTitle === next.sessionTitle
    && previous.lastSessionId === next.lastSessionId;
}

/** 速率与全局请求量（数值由服务端算好，主题只显示） */
export function useStats(): { rate: unknown; global: unknown } {
  return useTeamState((state) => {
    const current = state as AnyState;
    return { rate: current.rate ?? null, global: current.global ?? null };
  }, shallowEqualPair);
}

function shallowEqualPair(previous: { rate: unknown; global: unknown }, next: { rate: unknown; global: unknown }): boolean {
  return previous.rate === next.rate && previous.global === next.global;
}

/** 当前视图与当前群 */
export function useView(): { view: string; currentGroupId: string } {
  return useTeamState((state) => {
    const current = state as AnyState;
    return {
      view: typeof current.view === 'string' ? current.view : 'list',
      currentGroupId: typeof current.currentGroupId === 'string' ? current.currentGroupId : '',
    };
  }, shallowEqualView);
}

function shallowEqualView(previous: { view: string; currentGroupId: string }, next: { view: string; currentGroupId: string }): boolean {
  return previous.view === next.view && previous.currentGroupId === next.currentGroupId;
}

/**
 * 悬浮件锚点。显隐与展开方向不在 store 里（由 dock-state 工厂与 INV-14 决定），
 * 主题只负责把球画在 anchor 上，不要自己判「该不该显示」。
 */
export function useDock(): { anchor: unknown } {
  return useTeamState((state) => ({ anchor: (state as AnyState).anchor ?? null }), shallowEqualAnchor);
}

function shallowEqualAnchor(previous: { anchor: unknown }, next: { anchor: unknown }): boolean {
  return previous.anchor === next.anchor;
}

/** 错误出口（渲染顶部告警条用）。这是数组，默认按引用比较即可 */
export function useErrors(): unknown[] {
  return useTeamState((state) => ((state as AnyState).errors as unknown[]) || []);
}

export { readState as readThemeState };
