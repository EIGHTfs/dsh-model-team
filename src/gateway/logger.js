// 统一日志：所有输出带 [dsh-model-team][级别] 前缀，便于在宿主日志流里过滤本插件。
// 需求约束：凭证永不落日志——这里只接收调用方已脱敏的文案，不提供对象转储，从入口堵住误打。
// 思路：三个级别收敛成同一个工厂，调用方以参数注入 logger，测试里换成记录器即可断言级别与文案。

// 固定前缀：日志检索与升级后 grep 都依赖它，不要改成动态值
export const LOG_PREFIX = '[dsh-model-team]';

// 三个级别名同时用于日志行与测试断言，避免调用点手写字符串
export const LOG_LEVELS = Object.freeze({
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
});

// 把 unknown 类型的错误转成一行可读文案：日志里只放 message，不放堆栈以免刷屏
export function describeFailure(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// 创建 logger：sink 默认 console，测试可注入收集器
export function createLogger({ sink = console } = {}) {
  const writeLine = (level, message) => {
    const line = `${LOG_PREFIX}[${level}] ${message}`;
    if (level === LOG_LEVELS.ERROR) {
      sink.error(line);
      return;
    }
    if (level === LOG_LEVELS.WARN) {
      sink.warn(line);
      return;
    }
    sink.info(line);
  };

  return {
    info: (message) => writeLine(LOG_LEVELS.INFO, message),
    warn: (message) => writeLine(LOG_LEVELS.WARN, message),
    error: (message) => writeLine(LOG_LEVELS.ERROR, message),
  };
}

// 默认 logger：业务代码不传 logger 时用它，输出到进程 stdout/stderr
export const defaultLogger = createLogger();
