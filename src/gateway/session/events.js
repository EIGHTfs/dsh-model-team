// 会话切换事件：每次切换成功都落两条（@目标 + 系统提示），两条共用同一个时间戳。
// 需求意图：刷新后仍能看到「你 @ 了 X 并切换了当前会话模型 / 已切换路由至：某分组」这类系统提示，
//          且事件必须带可排序的 at（跨天不会乱序），time 仅用于展示。

import { formatIsoWithOffset } from '../clock.js';
import { FRIEND_GROUP_STRATEGY_LABELS } from '../group/friend-groups.js';
import { SYSTEM_EVENT_TYPE } from './store.js';

export const SELF_MESSAGE_EVENT_TYPE = 'self-message';
// 分组策略缺失时的兜底文案（配置损坏也给出可读策略）
const DEFAULT_STRATEGY_LABEL = '未知策略';

// 单模型切换的系统提示：用 docs/00 原文措辞，保证刷新前后（实时 vs 持久化）文案一致
export function buildModelSwitchText(modelId) {
  return `你 @ 了 ${modelId} 并切换了当前会话模型`;
}

// 分组切换的系统提示：分组名 + 人类可读策略
export function buildGroupSwitchText(friendGroup, fallbackGroupId) {
  const groupName = typeof friendGroup?.name === 'string' && friendGroup.name.length > 0
    ? friendGroup.name
    : fallbackGroupId;
  const strategyLabel = FRIEND_GROUP_STRATEGY_LABELS[friendGroup?.strategy] ?? DEFAULT_STRATEGY_LABEL;
  return `已切换路由至：${groupName}（策略：${strategyLabel}）`;
}

// 生成两条待写入事件：self-message(@目标) + system(提示)；at 用同一个时间点，保证两条可比较
export function buildSwitchEvents({ target, friendGroup = null, clock }) {
  const nowMs = clock.nowMs();
  const eventTime = {
    time: clock.formatTime(nowMs),
    // 与 updatedAt 保持同一种形态（带本地偏移），避免同一份数据里 Z 与 +08:00 混用
    at: formatIsoWithOffset(nowMs),
  };

  if (target.type === 'group') {
    return [
      {
        ...eventTime,
        type: SELF_MESSAGE_EVENT_TYPE,
        text: `@${friendGroup?.name ?? target.id}`,
        model: null,
        groupId: target.id,
        // 分组跨平台，不归属任何单个群
        platformId: null,
      },
      {
        ...eventTime,
        type: SYSTEM_EVENT_TYPE,
        text: buildGroupSwitchText(friendGroup, target.id),
        platformId: null,
      },
    ];
  }

  // 单模型：两条事件都归属目标模型所在的群（platformId 由路由解析好后传进来）
  return [
    {
      ...eventTime,
      type: SELF_MESSAGE_EVENT_TYPE,
      text: `@${target.id}`,
      model: target.id,
      platformId: target.platformId ?? null,
    },
    {
      ...eventTime,
      type: SYSTEM_EVENT_TYPE,
      text: buildModelSwitchText(target.id),
      platformId: target.platformId ?? null,
    },
  ];
}
