// dock-state.ts —— 悬浮件状态桥：把 dock-state 工厂（显隐/锚点/方向）接进主题。
//
// 为什么这层在 SDK：显隐（INV-14 的落点）与锚点是**行为真相**，两套主题必须看同一份。
// 主题只订阅，不自己存一份（存了就会出现「判定说隐藏、界面还亮着」这类历史问题）。
// 真相源仍是 ui/js/float/dock-state.js —— 本文件只是它的 React 侧适配，不复制状态。

import { useEffect, useState } from 'react';

import type { OpenDirection, Point } from './dock-geometry';

export interface DockStateSnapshot {
  visible: boolean;
  anchor: Point | null;
  openDir: OpenDirection;
}

export interface DockBridge {
  getDockState: () => DockStateSnapshot;
  subscribeDockState: (listener: (snapshot: DockStateSnapshot) => void) => () => void;
  setDockAnchor: (anchor: Point) => void;
  setDockOpenDir: (openDir: OpenDirection) => void;
  setDockShape: (shape: 'ball' | 'panel') => void;
}

/**
 * 取 dock-state 桥。拿不到（单测、无宿主）返回 null —— 调用方应退化为「不渲染」，
 * 而不是造一个假球：假球会让「本插件不该出现」的场景也看到入口（INV-14 的原始缺陷）。
 */
export function readDockBridge(source: unknown = typeof window === 'undefined' ? undefined : window): DockBridge | null {
  const candidate = (source as { __DMT_DOCK__?: DockBridge } | undefined)?.__DMT_DOCK__;
  return candidate && typeof candidate.getDockState === 'function' ? candidate : null;
}

export interface UseDockStateResult {
  snapshot: DockStateSnapshot | null;
  bridge: DockBridge | null;
}

/** 订阅 dock-state：首帧取当前值，之后随工厂广播更新 */
export function useDockState(): UseDockStateResult {
  const [bridge] = useState<DockBridge | null>(() => readDockBridge());
  const [snapshot, setSnapshot] = useState<DockStateSnapshot | null>(() => (bridge ? bridge.getDockState() : null));

  useEffect(() => {
    if (!bridge) return undefined;
    return bridge.subscribeDockState((next) => setSnapshot(next));
  }, [bridge]);

  return { snapshot, bridge };
}
