// actions.ts —— 主题能触发的动作：全部转成 store.dispatch，绝不新开写入口。
//
// 为什么把动作收在这里而不是让主题直接 store.dispatch：
// dispatch 的动作名是客户端与服务端共享的契约面（ui/js/store/dispatch.js 的动作表）。
// 主题作者不该记住那些字符串；SDK 也不该允许出现「主题自己拼一个新动作」——
// 那会绕过 dispatch 表里的校验与副作用（比如切目标要落两条事件）。
//
// 新增动作的流程（docs/22 §5.3）：先加进 ui/js/store/dispatch.js 的动作表，再来这里加一行。

import { getStore } from './store-bridge';

export type ViewName = 'list' | 'chat' | 'add' | 'contacts' | 'profile' | 'db';

export interface TargetLike {
  readonly type: 'model' | 'group';
  readonly id: string;
}

function dispatch(action: { type: string } & Record<string, unknown>): unknown {
  return getStore().dispatch(action);
}

export const actions = {
  /** 切视图；进群聊时带 groupId */
  openView(view: ViewName, groupId?: string): unknown {
    return dispatch(groupId ? { type: 'open-view', view, groupId } : { type: 'open-view', view });
  },
  /** 拉群列表（刷新一条流） */
  loadGroups(): unknown {
    return dispatch({ type: 'load-groups' });
  },
  /** 拉单群消息与群友 */
  loadChat(groupId: string): unknown {
    return dispatch({ type: 'load-chat', groupId });
  },
  /** 切换当前会话目标（模型或分组） */
  switchTarget(target: TargetLike): unknown {
    return dispatch({ type: 'switch-target', target });
  },
  /** 发送一条 @ 消息 */
  sendMessage(text: string): unknown {
    return dispatch({ type: 'send-message', text });
  },
  /** 展开/收起某条请求记录 */
  toggleRow(rowIndex: number): unknown {
    return dispatch({ type: 'toggle-row', rowIndex });
  },
  /** 拖拽后落锚点（悬浮件位置） */
  setDockAnchor(anchor: { left: number; top: number }): unknown {
    return dispatch({ type: 'set-anchor', anchor });
  },
} as const;

export type ThemeActions = typeof actions;
