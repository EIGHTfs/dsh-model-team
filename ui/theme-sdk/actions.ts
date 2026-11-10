// actions.ts —— 主题能触发的动作：全部转成 store.dispatch，绝不新开写入口。
//
// 为什么把动作收在这里而不是让主题直接 store.dispatch：
// dispatch 的动作名是客户端与服务端共享的契约面（ui/js/store/dispatch.js 的动作表）。
// 主题作者不该记住那些字符串；SDK 也不该允许出现「主题自己拼一个新动作」——
// 那会绕过 dispatch 表里的校验与副作用（比如切目标要落两条事件）。
//
// 新增动作的流程（docs/03 §八）：先加进 ui/js/store/dispatch.js 的动作表，再来这里加一行。

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
  /** 选中加群下拉里的一项（宿主负责展开初值；主题只传 option id） */
  selectGroupOption(optionId: string): unknown {
    return dispatch({ type: 'select-group-option', optionId });
  },
  /** 在加群表单某个字段上输入（字段名来自 schema / advancedField） */
  setAddFormValue(fieldKey: string, value: string): unknown {
    return dispatch({ type: 'set-add-form-value', fieldKey, value });
  },
  /** 探测当前表单对应平台的可用模型（请求体由宿主组） */
  probeAddForm(input?: { accountId?: string }): unknown {
    return dispatch({ type: 'probe-add-form', accountId: input?.accountId });
  },
  /** 提交加群（payload 由宿主组；主题只给名称与已探测的模型清单） */
  submitAddGroup(input: { name: string; models?: unknown[]; accountId?: string }): unknown {
    return dispatch({ type: 'submit-add-group', name: input.name, models: input.models, accountId: input.accountId });
  },
  /** 加群：payload 原样交给服务端，成功回 { group }，失败 reject（message 为服务端原文） */
  addGroup(payload: Record<string, unknown>): unknown {
    return dispatch({ type: 'add-group', payload });
  },
  /**
   * 探测可用模型：只给结构化输入，线格式由宿主组装。
   * accountRef 给账号引用（账号型驱动）；否则用 baseURL + apiKey（配置型驱动）。
   */
  probeModels(input: { driver: string; accountRef?: string; baseURL?: string; apiKey?: string; modelsEndpoint?: string }): unknown {
    return dispatch({ type: 'probe-models', input });
  },
  /** 导出备份（回完整备份对象，下载由主题触发） */
  exportConfig(): unknown {
    return dispatch({ type: 'export-config' });
  },
  /** 导入备份：回 { imported, updated, rejected } 回执 */
  importConfig(payload: Record<string, unknown>): unknown {
    return dispatch({ type: 'import-config', payload });
  },
  /** 反代账号列表（已脱敏） */
  loadReverseAccounts(platformId: string): unknown {
    return dispatch({ type: 'reverse-accounts', platformId });
  },
  /** 发起设备码登录：回 { loginUrl } */
  startReverseLogin(platformId: string): unknown {
    return dispatch({ type: 'reverse-login-start', platformId });
  },
  /** 按平台轮询登录状态：回 { ok, status, body } */
  pollReverseLogin(platformId: string): unknown {
    return dispatch({ type: 'reverse-login-poll', platformId });
  },
  /** 保存好友分组（同 id 覆盖）：成功回 { group }，失败 reject（message 为服务端原文） */
  saveFriendGroup(payload: Record<string, unknown>): unknown {
    return dispatch({ type: 'save-friend-group', payload });
  },
  /** 删除好友分组：被会话引用时后端回 409，message 原样带出 */
  deleteFriendGroup(groupId: string): unknown {
    return dispatch({ type: 'delete-friend-group', groupId });
  },
  /** 某个群（平台账号）的模型清单：分组编辑的两级选择用 */
  loadGroupModels(groupId: string): unknown {
    return dispatch({ type: 'group-models', groupId });
  },
  /** 拖拽后落锚点（悬浮件位置） */
  setDockAnchor(anchor: { left: number; top: number }): unknown {
    return dispatch({ type: 'set-anchor', anchor });
  },
} as const;

export type ThemeActions = typeof actions;
