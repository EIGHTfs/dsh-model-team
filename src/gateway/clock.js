// 时钟与标识生成：时间、耗时、req-id 全部从这里出，测试可注入固定实现。
// 需求意图：请求行里的时间与 req-id 必须可复现——直接调 Date.now/Math.random 会让用例结果随机跳动。
// 思路：所有取用点通过 createClock() 拿到"当前毫秒 + 格式化 + 生成 id"三件套；默认实现用系统时间与
//      crypto.randomUUID，测试用 createFixedClock 固定时刻与自增序列。

import { randomUUID } from 'node:crypto';

// 时间显示固定到本地时区 HH:mm:ss（docs/09 §5 的 time 字段）
const TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

// 耗时固定两位小数 + s 后缀（docs/09 §5 的 latency 字段，如 12.34s）
const LATENCY_DECIMAL_PLACES = 2;
const MILLISECONDS_PER_SECOND = 1000;
// 时间换算与显示宽度：60 分钟/小时、60_000 毫秒/分钟、两位补零、ISO 秒级长度 19
const MINUTES_PER_HOUR = 60;
const MILLISECONDS_PER_MINUTE = 60_000;
const TWO_DIGIT_WIDTH = 2;
const ISO_SECONDS_LENGTH = 19;

// req-id：上游没给 id 时网关自造，前缀固定、随机段 12 位（docs/09 §5）
export const REQUEST_ID_PREFIX = 'req-';
export const REQUEST_ID_RANDOM_LENGTH = 12;

// 把毫秒格式化为本地 HH:mm:ss
export function formatClockTime(epochMilliseconds) {
  return TIME_FORMATTER.format(new Date(epochMilliseconds));
}

// 把毫秒耗时格式化为 12.34s
export function formatLatency(elapsedMilliseconds) {
  const elapsedSeconds = Math.max(0, elapsedMilliseconds) / MILLISECONDS_PER_SECOND;
  return `${elapsedSeconds.toFixed(LATENCY_DECIMAL_PLACES)}s`;
}

// 本地时区带偏移的 ISO 串（stats/global 的 since 用）
// 要求带偏移而不是 Z：前端展示的是"本机时间"，UTC 串会让用户误判自己在哪个时段
export function formatIsoWithOffset(epochMilliseconds) {
  const date = new Date(epochMilliseconds);
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteOffsetMinutes / MINUTES_PER_HOUR)).padStart(TWO_DIGIT_WIDTH, '0');
  const offsetRestMinutes = String(absoluteOffsetMinutes % MINUTES_PER_HOUR).padStart(TWO_DIGIT_WIDTH, '0');
  const localIso = new Date(date.getTime() - date.getTimezoneOffset() * MILLISECONDS_PER_MINUTE).toISOString().slice(0, ISO_SECONDS_LENGTH);
  return `${localIso}${offsetSign}${offsetHours}:${offsetRestMinutes}`;
}

// 造一个 req-<12位>：randomToken 传入即可完全复现
export function createRequestId(randomToken) {
  const randomSegment = String(randomToken ?? randomUUID()).replace(/[^a-zA-Z0-9]/g, '');
  const paddedSegment = `${randomSegment}${'0'.repeat(REQUEST_ID_RANDOM_LENGTH)}`.slice(0, REQUEST_ID_RANDOM_LENGTH);
  return `${REQUEST_ID_PREFIX}${paddedSegment.toLowerCase()}`;
}

// 默认时钟：系统时间 + uuid 随机源
export function createClock() {
  return {
    nowMs: () => Date.now(),
    formatTime: formatClockTime,
    formatLatency,
    createRequestId: () => createRequestId(randomUUID()),
  };
}

// 固定时钟：测试用，时刻固定、req-id 按自增序号生成（结果完全可断言）
export function createFixedClock({ nowMs = Date.UTC(2026, 10, 2, 5, 30, 0), stepMs = 0 } = {}) {
  let currentMs = nowMs;
  let sequence = 0;
  return {
    nowMs: () => {
      const reading = currentMs;
      currentMs += stepMs;
      return reading;
    },
    formatTime: formatClockTime,
    formatLatency,
    createRequestId: () => {
      sequence += 1;
      return createRequestId(`seq${sequence}`);
    },
  };
}
