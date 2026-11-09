// 进程内事件总线：把「网关侧发生的事实」变成前端能订阅的事件（docs/09 端点契约的 SSE 一节）。
//
// 为什么需要它：请求是否完成只有网关自己知道，宿主的 UI 挂载点并不保证收到通知。
// 与其猜宿主 hook，不如让后端把「请求完成」升级成一等事件，前端只订阅这一条通道。
// 约束：纯进程内、零依赖；任一订阅者抛错不得影响其它订阅者（逐个 try）；订阅数异常要 warn（防泄漏）。

// 同类型订阅超过这个数量就告警：正常部署下每类事件只有个位数订阅者
const SUBSCRIBER_WARN_THRESHOLD = 32;

/**
 * 创建独立的事件总线实例（测试用；生产用 getEventHub 的单例）。
 * @param {{logger?: {warn: Function}}} options
 */
export function createEventHub({ logger } = {}) {
  // type → Set<listener>
  const listenersByType = new Map();

  function listenersOf(type) {
    let listeners = listenersByType.get(type);
    if (!listeners) {
      listeners = new Set();
      listenersByType.set(type, listeners);
    }
    return listeners;
  }

  function publish(type, payload) {
    const listeners = listenersByType.get(type);
    if (!listeners || listeners.size === 0) return 0;
    let delivered = 0;
    for (const listener of Array.from(listeners)) {
      try {
        listener(payload);
        delivered += 1;
      } catch (listenerError) {
        // 单个订阅者崩了不能拖垮其它订阅者，更不能拖垮请求本身
        logger?.warn?.(`事件订阅者抛错（${type}）：${listenerError?.message ?? listenerError}`);
      }
    }
    return delivered;
  }

  function subscribe(type, listener) {
    if (typeof listener !== 'function') return () => {};
    const listeners = listenersOf(type);
    listeners.add(listener);
    if (listeners.size > SUBSCRIBER_WARN_THRESHOLD) {
      logger?.warn?.(`事件订阅数异常（${type}：${listeners.size} 个），检查是否有连接未清理`);
    }
    return function unsubscribe() {
      listeners.delete(listener);
      if (listeners.size === 0) listenersByType.delete(type);
    };
  }

  /** 当前某类事件的订阅数（测试断言"断开后回到 0"用） */
  function subscriberCount(type) {
    return listenersByType.get(type)?.size ?? 0;
  }

  function reset() {
    listenersByType.clear();
  }

  return { publish, subscribe, subscriberCount, reset };
}

// 生产用单例：路由与统计写入两侧共享同一个 hub
let sharedHub = null;

export function getEventHub({ logger } = {}) {
  if (!sharedHub) sharedHub = createEventHub({ logger });
  return sharedHub;
}

/** 测试用：丢掉单例，避免用例之间互相污染 */
export function resetEventHubForTest() {
  sharedHub = null;
}

// 事件名常量：写错字符串是最常见的静默失败
export const EVENT_REQUEST_COMPLETED = 'request:completed';
