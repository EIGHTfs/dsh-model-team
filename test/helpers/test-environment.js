// 测试公共环境：每个用例独立的临时数据根 + 可断言的记录型 logger。
// 目的：用例之间不共享配置与驱动文件；测试只写系统临时目录，绝不碰真实数据根。

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 临时目录前缀：跑完可用 /tmp/dsh-model-team-test-* 一眼认出残留
const TEMP_DIRECTORY_PREFIX = 'dsh-model-team-test-';

// 建临时目录并登记清理：用例断言失败也会执行，不留垃圾
export async function createTempDirectory(t) {
  const directoryPath = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_DIRECTORY_PREFIX));
  t.after(async () => {
    await fs.rm(directoryPath, { recursive: true, force: true });
  });
  return directoryPath;
}

// 记录型 logger：既能断言级别与文案，也不把日志刷进测试输出
export function createRecordingLogger() {
  const lines = [];
  const recordLine = (level) => (message) => {
    lines.push({ level, message });
  };
  return {
    lines,
    info: recordLine('info'),
    warn: recordLine('warn'),
    error: recordLine('error'),
    // 断言辅助：是否存在指定级别且包含关键词的日志行
    hasLine(level, keyword) {
      return lines.some((line) => line.level === level && line.message.includes(keyword));
    },
  };
}

// 临时改环境变量并自动还原：用例之间不会互相污染
export function setEnvironmentVariableForTest(t, variableName, variableValue) {
  const originalValue = process.env[variableName];
  if (variableValue === undefined) {
    delete process.env[variableName];
  } else {
    process.env[variableName] = variableValue;
  }
  t.after(() => {
    if (originalValue === undefined) {
      delete process.env[variableName];
      return;
    }
    process.env[variableName] = originalValue;
  });
}
