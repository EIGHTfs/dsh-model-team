// 反代平台注册表：platformId → 平台实现（与 drivers/ 平级，因为它不是"一个驱动"而是一条账号链路）。
//
// 铁律 1：驱动 id 与平台 id 是两个空间，**换算只在本文件一处**（toDriverId / fromDriverId）。
// 铁律 2：平台自描述，这里只负责"收表 + 校验形状"；没有第二份手工登记的名单。
// 铁律 16：新增平台只加一行 import + 一行数组项，不改其它平台文件。

import { platform as qoderPlatform } from './qoder/index.js';
import { assertPlatformShape, REVERSE_DRIVER_PREFIX } from '../../reverse/core/types.js';

// 注册顺序 = 列表顺序（将来 UI/日志按这个顺序展示）
const REGISTERED_PLATFORMS = [qoderPlatform];

function buildRegistry(platforms) {
  const registry = new Map();
  for (const platform of platforms) {
    assertPlatformShape(platform);
    if (registry.has(platform.id)) {
      throw new TypeError(`平台 id 重复注册：${platform.id}`);
    }
    registry.set(platform.id, platform);
  }
  return registry;
}

const platformRegistry = buildRegistry(REGISTERED_PLATFORMS);

export function getPlatform(platformId) {
  return platformRegistry.get(platformId) ?? null;
}

export function listPlatforms() {
  return [...platformRegistry.values()];
}

// 平台 id → 对外驱动 id（唯一换算点）
export function toDriverId(platformId) {
  return `${REVERSE_DRIVER_PREFIX}${platformId}`;
}

// 对外驱动 id → 平台 id；不是反代命名空间则返回 null（不猜、不抛）
export function fromDriverId(driverId) {
  if (typeof driverId !== 'string' || !driverId.startsWith(REVERSE_DRIVER_PREFIX)) return null;
  const platformId = driverId.slice(REVERSE_DRIVER_PREFIX.length);
  return platformRegistry.has(platformId) ? platformId : null;
}
