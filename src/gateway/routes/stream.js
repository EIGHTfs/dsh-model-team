// GET /_team/stream：把「请求完成」事件以 SSE 推给前端（docs/09 端点契约）。
//
// 为什么走 SSE 而不是轮询：请求完成是网关侧的一次性事实，事件驱动最省也最准；
// 前端只在这条通道上订阅，界面（legacy 主题 / tim 主题 / 未来任何界面）照旧读 store。
//
// 关键约束：
//   · 心跳每 20s 一行注释 `: ping`，防中间代理因空闲断连；
//   · 带 sessionId 只推该会话，不带则推全部；
//   · 客户端断开必须退订（否则 listener 泄漏，订阅数会一直涨）；
//   · 鉴权沿用宿主的统一鉴权，这里不做额外判断。

import { EVENT_REQUEST_COMPLETED, getEventHub } from '../events/hub.js';

// 心跳间隔：代理通常在 30~60s 无数据时断连，20s 留出余量
export const STREAM_HEARTBEAT_MS = 20000;

export async function handleStreamRoute({ incomingRequest, outgoingResponse, query, logger }) {
  const sessionId = typeof query?.sessionId === 'string' && query.sessionId.length > 0 ? query.sessionId : null;

  outgoingResponse.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // nginx 一类反代要显式关缓冲，否则事件会被攒着不发
    'x-accel-buffering': 'no',
  });
  // 就绪信号：能订阅到这条流，就说明插件路由已挂载、数据接口可用。
  // 前端据此拉首屏数据，**不再靠超时重试猜"插件准备好没有"**（skill: event-driven-no-timeout-fallback）。
  outgoingResponse.write(': connected\n\n');
  outgoingResponse.write('event: ready\ndata: {"ready":true}\n\n');

  const hub = getEventHub({ logger });
  const unsubscribe = hub.subscribe(EVENT_REQUEST_COMPLETED, (payload) => {
    if (sessionId !== null && payload?.sessionId !== sessionId) return;
    try {
      outgoingResponse.write(`event: ${EVENT_REQUEST_COMPLETED}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch (writeError) {
      logger?.warn?.(`SSE 写入失败（将等待客户端断开）：${writeError?.message ?? writeError}`);
    }
  });

  const heartbeatTimer = setInterval(() => {
    try {
      outgoingResponse.write(': ping\n\n');
    } catch {
      // 写失败说明连接已经废了，close 事件随后会清理
    }
  }, STREAM_HEARTBEAT_MS);
  // 心跳不该把进程钉住（宿主里有很多长连接）
  heartbeatTimer.unref?.();

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeatTimer);
    unsubscribe();
    try { outgoingResponse.end(); } catch { /* 已断开 */ }
  };
  incomingRequest.on('close', cleanup);
  incomingRequest.on('aborted', cleanup);
  outgoingResponse.on('close', cleanup);

  return { streamed: true };
}
