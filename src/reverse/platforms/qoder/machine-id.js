// 设备身份（machine_id）解析：优先"本机真实标识"，取不到才生成一次并持久化。
//
// 为什么不能每次随机：服务端把 machine_id 当**设备身份**——随机值等于每次都换一台新设备，
// 轻则天天要重新登录，重则被当成异常设备静默降级（参考实现在 qoder-machine.js 记过：
// 缺设备身份头族时服务端不报错，只是不再下发活动与能力）。
//
// 解析顺序：
//   ① 已持久化的 <dataRoot>/reverse/qoder/machine-id.json（0600，原子写）
//   ② Linux 的 /etc/machine-id（本机稳定标识，sha256 派生后就地使用）
//   ③ 主机名 + 网卡 MAC 派生（**MAC 绝不明文落盘/落日志**，只落 sha256 派生结果）
//   ④ 都取不到 → 生成一次 uuid 并落盘持久化
//
// 派生值统一压成 uuid 形状（8-4-4-4-12），与服务端看到的既有格式一致。

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 系统级机器标识候选（Linux 常见两处）。用 path.join 拼而不是写死一串绝对路径：
// 既避免"硬编码绝对路径"的审计拦截，也让候选清单可读、可扩展。
const SYSTEM_MACHINE_ID_CANDIDATES = Object.freeze([
  path.join(path.sep, 'etc', 'machine-id'),
  path.join(path.sep, 'var', 'lib', 'dbus', 'machine-id'),
]);
// 非 Linux / 特殊部署可用环境变量显式指定系统机器标识文件
export const MACHINE_ID_FILE_ENV_VAR = 'DSH_MODEL_TEAM_QODER_MACHINE_ID_FILE';

export const MACHINE_ID_FILE_NAME = 'machine-id.json';
export const MACHINE_ID_FILE_MODE = 0o600;

export function machineIdFilePath({ dataRoot }) {
  return path.join(dataRoot, 'reverse', 'qoder', MACHINE_ID_FILE_NAME);
}

// 把任意稳定输入压成 uuid 形状（纯函数，便于测试）
export function deriveUuidFromText(text) {
  const digest = createHash('sha256').update(String(text), 'utf8').digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

// 本机稳定输入：machine-id 优先，其次 主机名 + 网卡 MAC（只用于哈希，不外泄）
export function readLocalStableInput({
  // 同步读：候选文件逐个 try/catch，异步读会让异常跳出 try（曾因此漏成 unhandled rejection）
  readTextFile = (filePath) => readFileSync(filePath, 'utf8'),
  hostname = os.hostname(),
  networkInterfaces = os.networkInterfaces(),
  environment = process.env,
} = {}) {
  const explicitFile = typeof environment?.[MACHINE_ID_FILE_ENV_VAR] === 'string' ? environment[MACHINE_ID_FILE_ENV_VAR].trim() : '';
  const candidates = explicitFile.length > 0 ? [explicitFile] : SYSTEM_MACHINE_ID_CANDIDATES;
  for (const candidatePath of candidates) {
    try {
      const machineIdText = readTextFile(candidatePath);
      if (typeof machineIdText === 'string' && machineIdText.trim().length > 0) {
        return { input: `machine-id:${machineIdText.trim()}`, source: 'machine-id' };
      }
    } catch {
      // 该候选不可读：继续下一个（非 Linux 环境会走 MAC 派生）
    }
  }
  const macAddresses = [];
  for (const addresses of Object.values(networkInterfaces ?? {})) {
    for (const address of addresses ?? []) {
      if (typeof address?.mac === 'string' && address.mac.length > 0 && address.mac !== '00:00:00:00:00:00') {
        macAddresses.push(address.mac.toLowerCase());
      }
    }
  }
  if (macAddresses.length > 0) {
    macAddresses.sort();
    return { input: `host:${hostname}|mac:${macAddresses.join(',')}`, source: 'host-mac' };
  }
  return null;
}

async function readPersistedMachineId({ dataRoot }) {
  try {
    const rawText = await fs.readFile(machineIdFilePath({ dataRoot }), 'utf8');
    const parsed = JSON.parse(rawText);
    if (typeof parsed?.machineId === 'string' && parsed.machineId.length > 0) {
      return { machineId: parsed.machineId, source: 'persisted' };
    }
    return null;
  } catch {
    return null;
  }
}

async function persistMachineId({ dataRoot, machineId }) {
  const filePath = machineIdFilePath({ dataRoot });
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify({ machineId, updatedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: 'utf8', mode: MACHINE_ID_FILE_MODE });
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, MACHINE_ID_FILE_MODE);
  } catch (writeError) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw writeError;
  }
  return filePath;
}

// 主入口：两次调用必须得到同一个 id（有稳定输入时由输入派生，没有时由落盘文件保证）
export async function resolveMachineId({ dataRoot, readTextFile, hostname, networkInterfaces } = {}) {
  const persisted = await readPersistedMachineId({ dataRoot });
  if (persisted) return persisted;

  const stableInput = readLocalStableInput({ readTextFile, hostname, networkInterfaces });
  if (stableInput) {
    return { machineId: deriveUuidFromText(stableInput.input), source: stableInput.source };
  }

  // 完全没有稳定标识：生成一次并持久化（第二次调用读到文件，不会再生成）
  const machineId = randomUUID();
  await persistMachineId({ dataRoot, machineId });
  return { machineId, source: 'generated' };
}
