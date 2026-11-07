// 平台注册表：按 manifest 动态加载平台实现（清单只放元数据，实现由路径加载）。
//
// 为什么用 top-level await：平台对象要同步可查（listPlatforms/getPlatform 被 UI 接口与测试同步调用），
// 而实现必须"按清单加载"。模块初始化时一次性加载完，导出面保持同步。
// 单个平台加载失败只记下来（describeReverse 会报 available:false），不影响其它平台。

import { manifest } from './manifest.js';
import { REVERSE_DRIVER_PREFIX, assertPlatformShape } from './core/types.js';

const loadedPlatforms = [];
const loadFailures = [];

for (const entry of manifest.platforms) {
  try {
    const module = await import(entry.module);
    const platform = module.platform ?? module.default;
    assertPlatformShape(platform);
    loadedPlatforms.push(platform);
  } catch (loadError) {
    // 平台坏了不能拖垮整个域，更不能拖垮主流程；原因留给 describeReverse 展示
    loadFailures.push({ platformId: entry.id, reason: loadError?.message ?? String(loadError) });
  }
}

const platformById = new Map(loadedPlatforms.map((platform) => [platform.id, platform]));

export function getPlatform(platformId) {
  return platformById.get(platformId) ?? null;
}

export function listPlatforms() {
  return [...loadedPlatforms];
}

export function listPlatformLoadFailures() {
  return [...loadFailures];
}

// 平台 id → 对外驱动 id（唯一换算点）
export function toDriverId(platformId) {
  return `${REVERSE_DRIVER_PREFIX}${platformId}`;
}

// 对外驱动 id → 平台 id；不是反代命名空间或未注册都返回 null（不猜）
export function fromDriverId(driverId) {
  if (typeof driverId !== 'string' || !driverId.startsWith(REVERSE_DRIVER_PREFIX)) return null;
  const platformId = driverId.slice(REVERSE_DRIVER_PREFIX.length);
  return platformById.has(platformId) ? platformId : null;
}
